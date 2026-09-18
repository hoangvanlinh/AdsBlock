// content/focus-block-overlay.js — draws a full-viewport overlay ON TOP OF
// the real page when the current site is on the Focus Mode distraction
// list (and a session is running) or has hit its per-site daily time
// limit today.
//
// Explicit, confirmed user choice (2026-09-18): NOT a network-level block/
// redirect — shared/background.js builds NO DNR rule for Focus Mode at
// all anymore (see its own "Focus mode / per-site daily limits" comment).
// The real page still fully loads and its scripts still run underneath;
// this is a purely visual + interaction block layered on top, closer to
// what a real "Focus Mode" app does than a browser error page. New logic
// lives in its own file, same as shared/focus-mode.js, never grown into
// content.js/site-block.js.
//
// Note: an earlier companion file, content/focus-input-guard.js, also
// disabled every text input/textarea/contenteditable on EVERY site (not
// just distraction-list ones) while a session was running — removed by
// explicit user request (2026-09-19): it couldn't tell a distraction from
// a legitimate need to type (filling in a form, an online class, chatting
// with a coworker), so it was blocking real work, not just distraction.
// This overlay only ever covers a site that's ACTUALLY on the distraction
// list or over its daily limit — every other site is completely untouched.
(function () {
  if (self.__focusBlockOverlayInstalled) return;
  self.__focusBlockOverlayInstalled = true;

  // Mirrors shared/focus-mode.js's own FocusMode.DISTRACTION_DEFAULTS —
  // duplicated rather than imported because that file is deliberately NOT
  // loaded in the content-script world (it calls EXT.alarms/EXT.tabs APIs
  // that don't exist there); same cross-context duplication precedent as
  // every other small helper repeated across this boundary in this
  // codebase. Only ever used as a fallback before onInstalled's own
  // storage seeding has had a chance to run.
  const DISTRACTION_DEFAULTS = [
    'x.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'youtube.com', 'reddit.com',
    'twitch.tv', 'netflix.com', 'pinterest.com', 'snapchat.com', 'tumblr.com', '9gag.com', 'threads.net',
  ];

  const OVERLAY_ID = 'qkv1-focus-block-overlay-host';
  let overlayHost = null;
  let shadow = null;
  let tickTimer = null;
  let currentKind = null; // null | 'focus' | 'limit'
  let countedForThisLoad = false;
  let pendingEvaluate = null;

  function pad2(n) { return String(n).padStart(2, '0'); }

  // Walks host's own registrable-domain suffixes — same technique/shape as
  // shared/focus-mode.js's own _walkLimitMatch()/background.js's
  // _walkDomainMatches(), reimplemented here for the same load-order-
  // boundary reason as everywhere else in this codebase.
  function hostMatchesAnyDomain(host, domains) {
    let h = host;
    while (h) {
      if (domains.indexOf(h) !== -1) return true;
      const dot = h.indexOf('.');
      if (dot === -1) break;
      h = h.slice(dot + 1);
    }
    return false;
  }

  function buildOverlayShell() {
    overlayHost = document.createElement('div');
    overlayHost.id = OVERLAY_ID;
    Object.assign(overlayHost.style, { position: 'fixed', inset: '0', zIndex: '2147483647' });
    shadow = overlayHost.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .qkv1-backdrop {
        position: fixed; inset: 0;
        background: rgba(10, 12, 20, .82);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        display: flex; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      }
      .qkv1-card {
        background: #14161f; color: #f1f5f9;
        border-radius: 20px; padding: 40px 44px; max-width: 420px; width: calc(100% - 48px);
        text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,.5);
        border: 1px solid rgba(255,255,255,.08);
      }
      .qkv1-icon { font-size: 40px; margin-bottom: 14px; line-height: 1; }
      .qkv1-title { font-size: 20px; margin: 0 0 8px; font-weight: 650; }
      .qkv1-host { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; color: #94a3b8; margin-bottom: 16px; word-break: break-all; }
      .qkv1-phase { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: #818cf8; margin-bottom: 2px; }
      .qkv1-timer { font-size: 32px; font-weight: 700; font-variant-numeric: tabular-nums; margin: 8px 0 10px; letter-spacing: .5px; }
      .qkv1-status { font-size: 14px; color: #cbd5e1; line-height: 1.6; }
    `;
    shadow.appendChild(style);

    const backdrop = document.createElement('div');
    backdrop.className = 'qkv1-backdrop';
    const card = document.createElement('div');
    card.className = 'qkv1-card';
    backdrop.appendChild(card);
    shadow.appendChild(backdrop);
    return card;
  }

  function removeOverlay() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (overlayHost && overlayHost.parentNode) overlayHost.parentNode.removeChild(overlayHost);
    overlayHost = null;
    shadow = null;
    currentKind = null;
  }

  function renderFocusCard(card, state) {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    const phaseLabel = state.focusPhase === 'shortBreak' ? EXT.i18n.getMessage('overlay_phase_shortBreak')
      : state.focusPhase === 'longBreak' ? EXT.i18n.getMessage('overlay_phase_longBreak')
      : EXT.i18n.getMessage('overlay_phase_work');
    card.replaceChildren();
    const icon = document.createElement('div'); icon.className = 'qkv1-icon'; icon.textContent = '🎯';
    const title = document.createElement('div'); title.className = 'qkv1-title'; title.textContent = EXT.i18n.getMessage('overlay_focus_title');
    const hostEl = document.createElement('div'); hostEl.className = 'qkv1-host'; hostEl.textContent = location.hostname;
    const phase = document.createElement('div'); phase.className = 'qkv1-phase'; phase.textContent = phaseLabel;
    const timer = document.createElement('div'); timer.className = 'qkv1-timer';
    const status = document.createElement('div'); status.className = 'qkv1-status'; status.textContent = EXT.i18n.getMessage('overlay_focus_hint');
    card.append(icon, title, hostEl, phase, timer, status);

    function tick() {
      const msLeft = (state.focusEndTime || 0) - Date.now();
      if (msLeft <= 0) { timer.textContent = '--:--'; return; }
      const totalSec = Math.ceil(msLeft / 1000);
      timer.textContent = pad2(Math.floor(totalSec / 60)) + ':' + pad2(totalSec % 60);
    }
    tick();
    tickTimer = setInterval(tick, 1000);
  }

  function renderLimitCard(card) {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    card.replaceChildren();
    const icon = document.createElement('div'); icon.className = 'qkv1-icon'; icon.textContent = '⏱️';
    const title = document.createElement('div'); title.className = 'qkv1-title'; title.textContent = EXT.i18n.getMessage('overlay_limit_title');
    const hostEl = document.createElement('div'); hostEl.className = 'qkv1-host'; hostEl.textContent = location.hostname;
    const status = document.createElement('div'); status.className = 'qkv1-status'; status.textContent = EXT.i18n.getMessage('overlay_limit_hint');
    card.append(icon, title, hostEl, status);
  }

  // Counted once per page load (this script's own lifetime, which is one
  // real navigation — SPA route changes within the same host don't re-run
  // it) — mirrors blocked.js's old per-host dedup guard, just without
  // needing sessionStorage since there's no reload-of-a-dedicated-page case
  // here to guard against.
  function reportBlocked() {
    if (countedForThisLoad) return;
    countedForThisLoad = true;
    try {
      EXT.runtime.sendMessage({ type: 'FOCUS_PAGE_BLOCKED', host: location.hostname }, () => { void EXT.runtime.lastError; });
    } catch (e) { /* extension context gone */ }
  }

  function readStorage(keys) {
    return new Promise((resolve) => {
      try { EXT.storage.local.get(keys, (res) => resolve(res || {})); }
      catch (e) { resolve({}); }
    });
  }

  async function evaluate() {
    // shared/i18n.js installs a manual-language-override wrapper around
    // EXT.i18n.getMessage() (Settings' language dropdown / auto-detected
    // content-language, for when the browser's own MENU language —
    // chrome.i18n's native getUILanguage() resolution — differs from what
    // the user actually reads, e.g. Chrome menus in English but Settings
    // set to Vietnamese). That override loads ASYNCHRONOUSLY (a storage
    // read, sometimes a fetch of the target locale's messages.json) and,
    // unlike the 3 extension-owned HTML pages, a content script has no
    // synchronous localStorage cache to paint correctly on the very first
    // render — see that file's own header comment. Left unawaited here,
    // this overlay would render once in native/English (whatever
    // getUILanguage() resolves to) and never get a second pass, since
    // nothing re-applies text buried inside its closed Shadow DOM the way
    // i18n.js's own applyI18n() does for plain data-i18n page elements —
    // live-reported 2026-09-19. Awaiting it here, before the first
    // getMessage() call anywhere in this file, means every render already
    // reflects the FINAL resolved language.
    await (self.EXT_I18N_READY || Promise.resolve());

    const s = await readStorage([
      'focusMode', 'distractionDomains', 'focusPhase', 'focusEndTime',
      'siteLimitsExceededToday', 'pausedDomains', 'allowedDomains',
    ]);

    const host = location.hostname.toLowerCase();
    if (!host) { removeOverlay(); return; }

    // Same override this used to get for free from DNR's priority-10
    // allowAllRequests rules (pauseAllowRules) — a paused or allowlisted
    // domain must bypass Focus Mode blocking too, not just ad/tracker
    // blocking, consistent with that pre-existing interaction.
    const pausedDomains = s.pausedDomains || [];
    const allowedDomains = s.allowedDomains || [];
    if (hostMatchesAnyDomain(host, pausedDomains) || hostMatchesAnyDomain(host, allowedDomains)) {
      removeOverlay();
      return;
    }

    const distractionDomains = s.distractionDomains || DISTRACTION_DEFAULTS;
    const isDistraction = !!s.focusMode && hostMatchesAnyDomain(host, distractionDomains);

    const today = new Date();
    const todayKey = today.getFullYear() + '-' + pad2(today.getMonth() + 1) + '-' + pad2(today.getDate());
    const exceededEntry = s.siteLimitsExceededToday;
    const exceededDomains = (exceededEntry && exceededEntry.date === todayKey) ? (exceededEntry.domains || []) : [];
    const isLimitExceeded = hostMatchesAnyDomain(host, exceededDomains);

    // Focus takes precedence when BOTH are true (same site, same moment) —
    // it's the more informative message (live countdown vs. a static
    // "resets tomorrow"), and a site landing on both lists is already
    // being blocked either way.
    const kind = isDistraction ? 'focus' : (isLimitExceeded ? 'limit' : null);

    if (!kind) { removeOverlay(); return; }

    reportBlocked();

    if (kind !== currentKind) {
      removeOverlay();
      currentKind = kind;
      const card = buildOverlayShell();
      (document.documentElement || document.body).appendChild(overlayHost);
      if (kind === 'focus') renderFocusCard(card, s); else renderLimitCard(card);
      return;
    }

    // Same kind as last render — for 'focus', a Pomodoro phase transition
    // or a fresh focusEndTime needs the countdown/phase label refreshed in
    // place, without tearing down and rebuilding the whole card.
    if (kind === 'focus' && shadow) {
      renderFocusCard(shadow.querySelector('.qkv1-card'), s);
    }
  }

  // storage.onChanged can fire several of the watched keys in the same
  // microtask (a single LocalStorage.set({...}) call writes multiple keys
  // at once) — coalesce into one evaluate() per tick instead of one per key.
  function scheduleEvaluate() {
    if (pendingEvaluate) return;
    pendingEvaluate = setTimeout(() => { pendingEvaluate = null; evaluate(); }, 0);
  }

  if (document.documentElement) evaluate();
  else document.addEventListener('DOMContentLoaded', evaluate, { once: true });

  try {
    EXT.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const watched = ['focusMode', 'distractionDomains', 'focusPhase', 'focusEndTime', 'siteLimitsExceededToday', 'pausedDomains', 'allowedDomains'];
      if (watched.some((k) => k in changes)) scheduleEvaluate();
    });
  } catch (e) { /* extension context gone */ }
})();
