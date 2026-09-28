// popup.js — AdBlock extension popup logic

const mainToggle   = document.getElementById('mainToggle');
const toggleRing   = document.getElementById('toggleRing');
const statusLabel  = document.getElementById('statusLabel');
const blockedCount  = document.getElementById('blockedCount');
const malwareCount  = document.getElementById('malwareCount');
const speedGain     = document.getElementById('speedGain');
const timeSaved    = document.getElementById('timeSaved');
const domainLabel  = document.getElementById('domainLabel');
const privacyBar   = document.getElementById('privacyBar');
const privacyScore = document.getElementById('privacyScore');
const pauseSiteBtn = document.getElementById('pauseSite');
const pauseSiteLabel = document.getElementById('pauseSiteLabel');
const focusModeBtn = document.getElementById('focusMode');

// ── Privacy score (mirrors background.js calculatePrivacyScore) ──
function calculatePrivacyScore(domainStats = {}, settings = {}) {
  const total = domainStats.totalSeen || 0;
  const protectionActive = settings.enabled !== false && !settings.paused;

  let adsScore = protectionActive ? 50 : 0;
  if (total > 0) {
    const expected = Math.max(total * 0.15, 1);
    adsScore = protectionActive
      ? Math.min(100, Math.round(((domainStats.adsBlocked || 0) / expected) * 100))
      : 0;
  }

  let trackersScore = protectionActive ? 50 : 0;
  if (total > 0) {
    const expected = Math.max(total * 0.10, 1);
    trackersScore = protectionActive
      ? Math.min(100, Math.round(((domainStats.trackersBlocked || 0) / expected) * 100))
      : 0;
  }

  const referrerScore = settings.referrerAnonymization !== false ? 85 : 20;
  let malwareScore    = protectionActive ? 70 : 0;
  if ((domainStats.malwareBlocked || 0) > 0) malwareScore = 100;

  const score = Math.round(
    adsScore * 0.30 + trackersScore * 0.25 + malwareScore * 0.20 + referrerScore * 0.25
  );
  return Math.max(0, Math.min(100, score));
}

// ── Get current tab domain ──────────────────────
async function getCurrentDomain() {
  const [tab] = await EXT.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return '';
  try { return new URL(tab.url).hostname; }
  catch { return ''; }
}

// ── Load data from storage ─────────────────────
// Split into fetch (async, no DOM writes) + apply (sync, DOM writes only) —
// see the "Init" section's own comment further down for why: batching every
// fetch together and applying them all in ONE pass is what actually fixes
// the popup-open flash on Firefox. loadState() below still does fetch+apply
// combined, for its OTHER (non-init) call site (removeAllowlist), where
// batching doesn't matter — initial layout has already long settled by then.
function _fetchLoadState() {
  return new Promise(resolve => {
    EXT.storage.local.get(
      ['enabled', 'pausedDomains', 'allowedDomains', 'focusMode', 'stats', 'referrerAnonymization'],
      resolve
    );
  });
}
function _applyLoadState(domain, { enabled = true, pausedDomains = [], allowedDomains = [], focusMode = false, stats = {}, referrerAnonymization = true }) {
  const paused     = pausedDomains.includes(domain);
  const allowlisted = allowedDomains.includes(domain);
  const active     = enabled && !paused && !allowlisted;

  // toggle state — distinguish paused vs allowlisted vs fully off
  mainToggle.checked = active;
  updateToggleUI(enabled, paused, allowlisted);

  // pause button — hide when allowlisted (managed from dashboard)
  pauseSiteBtn.classList.toggle('active', paused);
  pauseSiteLabel.textContent = paused ? EXT.i18n.getMessage('popup_action_resume_emoji') : EXT.i18n.getMessage('popup_action_pause_emoji');
  pauseSiteBtn.style.display = allowlisted ? 'none' : '';

  // allowlist banner
  const banner = document.getElementById('allowlistBanner');
  if (banner) {
    banner.classList.toggle('hidden', !allowlisted);
  }

  // focus mode
  focusModeBtn.classList.toggle('active', focusMode);
  focusModeBtn.classList.toggle('accent', !focusMode);

  // stats
  const siteStats = stats[domain] || {};
  blockedCount.textContent = (siteStats.blocked ?? 0).toLocaleString();

  // Malware is cross-domain — show global total
  let totalMalware = 0;
  for (const s of Object.values(stats)) totalMalware += s.malwareBlocked ?? 0;
  malwareCount.textContent = totalMalware.toLocaleString();
  const spd = siteStats.speedGain ?? 0;
  speedGain.textContent  = spd > 0 ? `+${spd}%` : '—';
  timeSaved.textContent  = formatTime(siteStats.timeSaved ?? 0);

  // privacy score — computed from real data
  const score = calculatePrivacyScore(siteStats, { enabled, paused, referrerAnonymization });
  privacyScore.textContent = score;
  privacyBar.style.width   = `${score}%`;
  privacyScore.style.color = score >= 70
    ? 'var(--green)'
    : score >= 40 ? 'var(--blue)' : 'var(--red)';
}
async function loadState() {
  const domain = await getCurrentDomain();
  domainLabel.textContent = domain || EXT.i18n.getMessage('popup_domain_unknown');
  _applyLoadState(domain, await _fetchLoadState());
}

function formatTime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

// Markup always comes from this JS literal, never from a messages.json
// value — <strong> wraps whichever getMessage() piece is the "state" word,
// concatenated with the (also translatable) leading label word.
function _statusHtml(labelKey, stateKey) {
  return EXT.i18n.getMessage(labelKey) + ' <strong>' + EXT.i18n.getMessage(stateKey) + '</strong>';
}
function updateToggleUI(active, paused = false, allowlisted = false) {
  if (allowlisted) {
    document.body.classList.add('off');
    toggleRing.classList.add('off');
    statusLabel.innerHTML = _statusHtml('popup_status_site', 'popup_status_allowlisted');
  } else if (active && !paused) {
    document.body.classList.remove('off');
    toggleRing.classList.remove('off');
    statusLabel.innerHTML = _statusHtml('popup_status_protection', 'popup_status_on');
  } else if (paused) {
    document.body.classList.add('off');
    toggleRing.classList.add('off');
    statusLabel.innerHTML = _statusHtml('popup_status_protection', 'popup_status_paused');
  } else {
    document.body.classList.add('off');
    toggleRing.classList.add('off');
    statusLabel.innerHTML = _statusHtml('popup_status_protection', 'popup_status_off');
  }
}

// ── Main toggle ────────────────────────────────
mainToggle.addEventListener('change', () => {
  const on = mainToggle.checked;
  return SettingsUI.run(mainToggle, async () => {
    // Folding the current domain's unpause into the same TOGGLE message
    // (one storage write + one applyNetworkRules() pass) instead of two
    // sequential messages — see settings-controller.js's own comment.
    const domain = on ? await getCurrentDomain() : '';
    await SettingsUI.send(domain ? { type: 'TOGGLE', enabled: on, domain } : { type: 'TOGGLE', enabled: on });
    refreshRuleCount();
  }, loadState);
});

// ── Pause on site ──────────────────────────────
pauseSiteBtn.addEventListener('click', () => SettingsUI.run(pauseSiteBtn, async () => {
  const [tab] = await EXT.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return;
  const domain = new URL(tab.url).hostname;
  if (!domain) return;
  const { pausedDomains = [] } = await EXT.storage.local.get('pausedDomains');
  await SettingsUI.send({ type: 'PAUSE_DOMAIN', domain, paused: !pausedDomains.includes(domain) });
  await EXT.tabs.reload(tab.id);
}, loadState));

// ── Remove from allowlist ───────────────────────
document.getElementById('removeAllowlist')?.addEventListener('click', async () => {
  const domain = await getCurrentDomain();
  if (!domain) return;
  EXT.storage.local.get('allowedDomains', ({ allowedDomains = [] }) => {
    const updated = allowedDomains.filter(d => d !== domain);
    EXT.storage.local.set({ allowedDomains: updated });
    EXT.runtime.sendMessage({ type: 'ALLOWLIST_CHANGED' });
    // Reload popup state
    loadState();
  });
});

// ── Focus mode ─────────────────────────────────
focusModeBtn.addEventListener('click', () => {
  EXT.storage.local.get(['focusMode', 'focusDuration'], ({ focusMode = false, focusDuration = 25 }) => {
    const next = !focusMode;
    const updates = { focusMode: next };
    if (next) {
      updates.focusEndTime = Date.now() + focusDuration * 60 * 1000;
    } else {
      updates.focusEndTime = null;
    }
    EXT.storage.local.set(updates);
    focusModeBtn.classList.toggle('active', next);
    focusModeBtn.classList.toggle('accent', !next);
    EXT.runtime.sendMessage({ type: 'FOCUS_MODE', enabled: next });
  });
});

// ── Dashboard ──────────────────────────────────
// Explicit window.close() after opening: on desktop the popup auto-closes
// once the new options tab takes focus anyway, but on mobile (Firefox for
// Android) the popup renders as its own overlay that does NOT auto-dismiss
// just because a background tab opened — it was live-reported to sit on
// top of the dashboard until the user pressed the phone's back button.
// Closing explicitly matches the existing pattern already used below for
// the "pick element" flow (see window.close() after QKV1_ENTER_PICKER_MODE).
document.getElementById('openDashboard').addEventListener('click', () => {
  EXT.runtime.openOptionsPage();
  window.close();
});
document.getElementById('openSettings').addEventListener('click', () => {
  EXT.runtime.openOptionsPage();
  window.close();
});

// ── Donate ─────────────────────────────────────
// URL now lives in shared/config.js's ADBLOCK_CONFIG.PAYPAL_DONATE_URL
// (was a duplicated literal here and in dashboard.js).
document.getElementById('donateBtnPopup')?.addEventListener('click', () => {
  EXT.tabs.create({ url: self.ADBLOCK_CONFIG.PAYPAL_DONATE_URL });
  window.close();
});

// ── Review prompt ────────────────────────────────
// Shown once (ever — governed by reviewPromptState in storage), triggered
// by whichever usage signal comes first: a real block-count milestone (the
// user has concretely benefited) OR enough elapsed days (a habitual user
// worth asking, even on a low-traffic browsing pattern that rarely blocks
// anything). totalBlockedAllTime is background.js's own counter (see
// _writeDailyStatDelta) — unlike dailyStats it's never pruned, so it's safe
// to compare against a lifetime threshold here.
const REVIEW_BLOCKED_MILESTONE = 500;
const REVIEW_MIN_DAYS_INSTALLED = 7;
// detectStoreUrl(variant) now lives in shared/utils.js (loaded before this
// file per popup.html's own <script> order) — was 2 near-identical copies
// here (this file's own review-prompt variant, plus a 3rd in dashboard.js).
function _fetchReviewPromptState() {
  return new Promise(resolve => {
    EXT.storage.local.get(['reviewPromptState', 'totalBlockedAllTime', 'installDate'], resolve);
  });
}
function _applyReviewPrompt({ reviewPromptState = 'unseen', totalBlockedAllTime = 0, installDate } = {}) {
  const banner = document.getElementById('reviewBanner');
  if (!banner) return;
  if (reviewPromptState !== 'unseen') return;
  const daysInstalled = installDate ? (Date.now() - installDate) / 86400000 : 0;
  const eligible = totalBlockedAllTime >= REVIEW_BLOCKED_MILESTONE || daysInstalled >= REVIEW_MIN_DAYS_INSTALLED;
  if (eligible) banner.classList.remove('hidden');
}
function maybeShowReviewPrompt() {
  _fetchReviewPromptState().then(_applyReviewPrompt);
}
document.getElementById('reviewRateBtn')?.addEventListener('click', () => {
  EXT.storage.local.set({ reviewPromptState: 'reviewed' });
  EXT.tabs.create({ url: detectStoreUrl('reviews') });
  document.getElementById('reviewBanner')?.classList.add('hidden');
  window.close();
});
document.getElementById('reviewDismissBtn')?.addEventListener('click', () => {
  EXT.storage.local.set({ reviewPromptState: 'dismissed' });
  document.getElementById('reviewBanner')?.classList.add('hidden');
});

// ── "Hide element" picker ───────────────────────
// Arms content/element-picker.js directly on the active tab — same message
// the right-click context menu item sends, just a second entry point for
// discoverability without needing to right-click the exact element first.
document.getElementById('pickElement')?.addEventListener('click', async () => {
  const [tab] = await EXT.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  EXT.tabs.sendMessage(tab.id, { type: 'QKV1_ENTER_PICKER_MODE' }, () => {
    void EXT.runtime.lastError;
    window.close();
  });
});

// ── Init ───────────────────────────────────────
// Paint the optimistic default ("Protection ON" — same assumption the
// static HTML placeholder encodes) SYNCHRONOUSLY, before the batched init
// below's async round-trips resolve — otherwise the raw hardcoded-English
// HTML placeholder stays visible for that entire round-trip and only THEN
// gets replaced, which reads as a visible English-then-localized flash
// whenever the real language is non-English (live-reported 2026-08-28).
// EXT.i18n.getMessage() here already resolves through shared/i18n.js's
// synchronous localStorage cache (populated before this script even runs,
// per that file's script-tag load order) on any repeat popup open, so this
// paints already-correct on every open but the very first one. The batched
// init below still corrects the state (not just the language) moments
// later if the real status differs from this guess.
statusLabel.innerHTML = _statusHtml('popup_status_protection', 'popup_status_on');

// Show how many network blocking rules are actually loaded — re-called after
// the Protection toggle so the chip doesn't keep showing a stale count from
// before the background finished adding/removing declarativeNetRequest rules.
// Split fetch/apply — see the "Init" batching block's own comment below for
// why. refreshRuleCount() (fetch+apply combined) stays the entry point for
// its OTHER call site (the TOGGLE handler), where batching doesn't matter —
// layout has long settled by then.
function _fetchRuleCount() {
  return new Promise(resolve => {
    EXT.runtime.sendMessage({ type: 'GET_RULE_COUNT' }, (res) => {
      const hadError = !!EXT.runtime.lastError;
      void EXT.runtime.lastError;
      resolve({ res, hadError });
    });
  });
}
function _applyRuleCount({ res, hadError } = {}) {
  const chip = document.getElementById('ruleChip');
  if (!chip) return;
  if (hadError || !res) {
    chip.textContent = EXT.i18n.getMessage('popup_ruleChip_unknown');
    chip.classList.add('zero');
    return;
  }
  const n = res.count ?? 0;
  chip.textContent = EXT.i18n.getMessage('popup_ruleChip_loaded', [String(n)]);
  chip.classList.toggle('zero', n === 0);
}
function refreshRuleCount() {
  void EXT.runtime.lastError; // ack TOGGLE's own response, if any
  _fetchRuleCount().then(_applyRuleCount);
}

// ── Version / update check ──────────────────────────────────────
// GET_UPDATE_STATUS reads cached state only (background.js checks against
// this repo's own manifest.json on its own daily schedule) — the popup
// never triggers a network fetch itself just from being opened.
function _fetchUpdateStatus() {
  return new Promise(resolve => {
    EXT.runtime.sendMessage({ type: 'GET_UPDATE_STATUS' }, (res) => {
      const hadError = !!EXT.runtime.lastError;
      void EXT.runtime.lastError;
      resolve(hadError ? null : res);
    });
  });
}
function _applyUpdateStatus(res) {
  const chip = document.getElementById('versionChip');
  if (!chip) return;
  if (!res || !res.available || !res.latestVersion) return; // stays hidden
  chip.textContent = EXT.i18n.getMessage('popup_version_updateAvailable', [String(res.currentVersion), String(res.latestVersion)]);
  chip.title = EXT.i18n.getMessage('popup_version_updateTitle');
  chip.classList.remove('hidden');
  chip.addEventListener('click', () => {
    EXT.tabs.create({ url: detectStoreUrl() });
    window.close();
  });
}

// Live-reported 2026-09-14 (Firefox, every popup open): the popup would
// briefly render TALLER than its settled size, then snap back down — a
// visible flash. Root cause: loadState()/maybeShowReviewPrompt()/
// refreshRuleCount()/the update-status check each did their OWN independent
// storage.local.get()/runtime.sendMessage() round-trip and wrote to the DOM
// the MOMENT their own response landed — 4 separate, staggered DOM writes
// within the first few dozen/hundred ms after open. Firefox's WebExtension
// popup panel auto-resizes to match body content height on every change it
// observes, so several staggered writes meant several resize passes; if any
// intermediate state was momentarily taller than the FINAL settled state
// (e.g. the review banner appearing before a later write removed/shrank
// something else), Firefox visibly resized the panel down again right after
// resizing it up — read as one flash. Fix: run every fetch in parallel
// first (no DOM writes yet), then apply all the resulting DOM writes
// together in ONE synchronous pass — Firefox only ever sees a single
// post-initial-paint layout change instead of several staggered ones.
(async () => {
  const [domain, loadStateRes, reviewRes, ruleCountRes, updateStatusRes] = await Promise.all([
    getCurrentDomain(),
    _fetchLoadState(),
    _fetchReviewPromptState(),
    _fetchRuleCount(),
    _fetchUpdateStatus(),
  ]);
  domainLabel.textContent = domain || EXT.i18n.getMessage('popup_domain_unknown');
  _applyLoadState(domain, loadStateRes);
  _applyReviewPrompt(reviewRes);
  _applyRuleCount(ruleCountRes);
  _applyUpdateStatus(updateStatusRes);
})();
