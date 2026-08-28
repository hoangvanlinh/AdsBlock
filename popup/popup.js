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
async function loadState() {
  const domain = await getCurrentDomain();
  domainLabel.textContent = domain || EXT.i18n.getMessage('popup_domain_unknown');

  EXT.storage.local.get(
    ['enabled', 'pausedDomains', 'allowedDomains', 'focusMode', 'stats', 'referrerAnonymization'],
    ({ enabled = true, pausedDomains = [], allowedDomains = [], focusMode = false, stats = {}, referrerAnonymization = true }) => {

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
  );
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
mainToggle.addEventListener('change', async () => {
  const on = mainToggle.checked;

  if (on) {
    // If site was paused, clear the pause first
    const [tab] = await EXT.tabs.query({ active: true, currentWindow: true });
    const domain = tab?.url ? (() => { try { return new URL(tab.url).hostname; } catch { return ''; } })() : '';

    EXT.storage.local.get(['pausedDomains'], ({ pausedDomains = [] }) => {
      const wasPaused = domain && pausedDomains.includes(domain);
      const updatedPaused = wasPaused ? pausedDomains.filter(d => d !== domain) : pausedDomains;

      EXT.storage.local.set({ enabled: true, pausedDomains: updatedPaused });
      updateToggleUI(true, false);
      // Wait for background to finish rebuilding declarativeNetRequest rules
      // before refreshing the rule-count chip — otherwise it re-reads the
      // stale (pre-toggle) count while applyNetworkRules() is still running.
      EXT.runtime.sendMessage({ type: 'TOGGLE', enabled: true }, refreshRuleCount);

      if (wasPaused) {
        pauseSiteBtn.classList.remove('active');
        pauseSiteLabel.textContent = EXT.i18n.getMessage('popup_action_pause_emoji');
        EXT.runtime.sendMessage({ type: 'PAUSE_DOMAIN', domain, paused: false });
      }

      if (tab?.id) EXT.tabs.sendMessage(tab.id, { type: 'TOGGLE', enabled: true }).catch(() => {});
    });
  } else {
    EXT.storage.local.set({ enabled: false });
    updateToggleUI(false);
    EXT.runtime.sendMessage({ type: 'TOGGLE', enabled: false }, refreshRuleCount);
    const [tab] = await EXT.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) EXT.tabs.sendMessage(tab.id, { type: 'TOGGLE', enabled: false }).catch(() => {});
  }
});

// ── Pause on site ──────────────────────────────
pauseSiteBtn.addEventListener('click', async () => {
  const [tab] = await EXT.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return;
  let domain = '';
  try { domain = new URL(tab.url).hostname; } catch { return; }
  if (!domain) return;

  EXT.storage.local.get(['pausedDomains'], ({ pausedDomains = [] }) => {
    const idx = pausedDomains.indexOf(domain);
    const pausing = idx === -1; // true = we're pausing, false = we're resuming
    if (pausing) {
      pausedDomains.push(domain);
      pauseSiteBtn.classList.add('active');
      pauseSiteLabel.textContent = EXT.i18n.getMessage('popup_action_resume_emoji');
    } else {
      pausedDomains.splice(idx, 1);
      pauseSiteBtn.classList.remove('active');
      pauseSiteLabel.textContent = EXT.i18n.getMessage('popup_action_pause_emoji');
    }
    EXT.storage.local.set({ pausedDomains });
    // Tell background to update declarativeNetRequest rules — WAIT for it
    // to finish before reloading, otherwise the old rules still block.
    EXT.runtime.sendMessage({ type: 'PAUSE_DOMAIN', domain, paused: pausing }, () => {
      // Update hero UI to reflect paused/active state
      mainToggle.checked = !pausing;
      EXT.storage.local.get('enabled', ({ enabled = true }) => {
        updateToggleUI(enabled, pausing);
      });
      // Reload the tab AFTER rules are updated
      EXT.tabs.reload(tab.id);
    });
  });
});

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
document.getElementById('openDashboard').addEventListener('click', () => {
  EXT.runtime.openOptionsPage();
});
document.getElementById('openSettings').addEventListener('click', () => {
  EXT.runtime.openOptionsPage();
});

// ── Donate ─────────────────────────────────────
// Replace with your actual PayPal.me or donate link
const PAYPAL_DONATE_URL = 'https://www.paypal.me/linhhvtt/5';
document.getElementById('donateBtnPopup')?.addEventListener('click', () => {
  EXT.tabs.create({ url: PAYPAL_DONATE_URL });
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
// Shared with dashboard.js via config.js's ADBLOCK_CONFIG.STORE_URLS (single
// source, see that file's own comment) — both the review prompt and the
// update-available chip below point here, so there's only ever one link to
// keep correct.
function _detectStoreUrl() {
  const urls = self.ADBLOCK_CONFIG.STORE_URLS;
  const ua = navigator.userAgent;
  if (ua.includes('Firefox/')) return urls.firefox;
  if (ua.includes('Edg/'))     return urls.edge;
  return urls.chrome;
}
function _detectReviewStoreUrl() {
  const ua = navigator.userAgent;
  const urls = self.ADBLOCK_CONFIG.STORE_URLS;
  if (ua.includes('Firefox/')) return urls.firefox + '/reviews';
  if (ua.includes('Edg/'))     return urls.edge;
  return urls.chrome + '/reviews';
}
function maybeShowReviewPrompt() {
  const banner = document.getElementById('reviewBanner');
  if (!banner) return;
  EXT.storage.local.get(
    ['reviewPromptState', 'totalBlockedAllTime', 'installDate'],
    ({ reviewPromptState = 'unseen', totalBlockedAllTime = 0, installDate }) => {
      if (reviewPromptState !== 'unseen') return;
      const daysInstalled = installDate ? (Date.now() - installDate) / 86400000 : 0;
      const eligible = totalBlockedAllTime >= REVIEW_BLOCKED_MILESTONE || daysInstalled >= REVIEW_MIN_DAYS_INSTALLED;
      if (eligible) banner.classList.remove('hidden');
    }
  );
}
document.getElementById('reviewRateBtn')?.addEventListener('click', () => {
  EXT.storage.local.set({ reviewPromptState: 'reviewed' });
  EXT.tabs.create({ url: _detectReviewStoreUrl() });
  document.getElementById('reviewBanner')?.classList.add('hidden');
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
// static HTML placeholder encodes) SYNCHRONOUSLY, before loadState()'s
// async EXT.tabs.query()/storage.get() round-trip resolves — otherwise the
// raw hardcoded-English HTML placeholder stays visible for that entire
// round-trip and only THEN gets replaced, which reads as a visible
// English-then-localized flash whenever the real language is non-English
// (live-reported 2026-08-28). EXT.i18n.getMessage() here already resolves
// through shared/i18n.js's synchronous localStorage cache (populated
// before this script even runs, per that file's script-tag load order) on
// any repeat popup open, so this paints already-correct on every open but
// the very first one. loadState() still corrects the state (not just the
// language) moments later if the real status differs from this guess.
statusLabel.innerHTML = _statusHtml('popup_status_protection', 'popup_status_on');
loadState();
maybeShowReviewPrompt();

// Show how many network blocking rules are actually loaded — re-called after
// the Protection toggle so the chip doesn't keep showing a stale count from
// before the background finished adding/removing declarativeNetRequest rules.
function refreshRuleCount() {
  void EXT.runtime.lastError; // ack TOGGLE's own response, if any
  EXT.runtime.sendMessage({ type: 'GET_RULE_COUNT' }, (res) => {
    const chip = document.getElementById('ruleChip');
    if (!chip) return;
    if (EXT.runtime.lastError || !res) {
      chip.textContent = EXT.i18n.getMessage('popup_ruleChip_unknown');
      chip.classList.add('zero');
      return;
    }
    const n = res.count ?? 0;
    chip.textContent = EXT.i18n.getMessage('popup_ruleChip_loaded', [String(n)]);
    chip.classList.toggle('zero', n === 0);
  });
}
refreshRuleCount();

// ── Version / update check ──────────────────────────────────────
// GET_UPDATE_STATUS reads cached state only (background.js checks against
// this repo's own manifest.json on its own daily schedule) — the popup
// never triggers a network fetch itself just from being opened.
EXT.runtime.sendMessage({ type: 'GET_UPDATE_STATUS' }, (res) => {
  const chip = document.getElementById('versionChip');
  if (!chip) return;
  if (EXT.runtime.lastError || !res || !res.available || !res.latestVersion) return; // stays hidden
  chip.textContent = EXT.i18n.getMessage('popup_version_updateAvailable', [String(res.currentVersion), String(res.latestVersion)]);
  chip.title = EXT.i18n.getMessage('popup_version_updateTitle');
  chip.classList.remove('hidden');
  chip.addEventListener('click', () => {
    EXT.tabs.create({ url: _detectStoreUrl() });
  });
});
