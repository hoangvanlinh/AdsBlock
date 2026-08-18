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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return '';
  try { return new URL(tab.url).hostname; }
  catch { return ''; }
}

// ── Load data from storage ─────────────────────
async function loadState() {
  const domain = await getCurrentDomain();
  domainLabel.textContent = domain || 'Unknown site';

  chrome.storage.local.get(
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
      pauseSiteBtn.textContent = paused ? '▶ Resume site' : '⏸ Pause on site';
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

function updateToggleUI(active, paused = false, allowlisted = false) {
  if (allowlisted) {
    document.body.classList.add('off');
    toggleRing.classList.add('off');
    statusLabel.innerHTML = 'Site <strong>Allowlisted</strong>';
  } else if (active && !paused) {
    document.body.classList.remove('off');
    toggleRing.classList.remove('off');
    statusLabel.innerHTML = 'Protection <strong>ON</strong>';
  } else if (paused) {
    document.body.classList.add('off');
    toggleRing.classList.add('off');
    statusLabel.innerHTML = 'Protection <strong>Paused</strong>';
  } else {
    document.body.classList.add('off');
    toggleRing.classList.add('off');
    statusLabel.innerHTML = 'Protection <strong>OFF</strong>';
  }
}

// ── Main toggle ────────────────────────────────
mainToggle.addEventListener('change', async () => {
  const on = mainToggle.checked;

  if (on) {
    // If site was paused, clear the pause first
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const domain = tab?.url ? (() => { try { return new URL(tab.url).hostname; } catch { return ''; } })() : '';

    chrome.storage.local.get(['pausedDomains'], ({ pausedDomains = [] }) => {
      const wasPaused = domain && pausedDomains.includes(domain);
      const updatedPaused = wasPaused ? pausedDomains.filter(d => d !== domain) : pausedDomains;

      chrome.storage.local.set({ enabled: true, pausedDomains: updatedPaused });
      updateToggleUI(true, false);
      chrome.runtime.sendMessage({ type: 'TOGGLE', enabled: true });

      if (wasPaused) {
        pauseSiteBtn.classList.remove('active');
        pauseSiteBtn.textContent = '⏸ Pause on site';
        chrome.runtime.sendMessage({ type: 'PAUSE_DOMAIN', domain, paused: false });
      }

      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE', enabled: true }).catch(() => {});
    });
  } else {
    chrome.storage.local.set({ enabled: false });
    updateToggleUI(false);
    chrome.runtime.sendMessage({ type: 'TOGGLE', enabled: false });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE', enabled: false }).catch(() => {});
  }
});

// ── Pause on site ──────────────────────────────
pauseSiteBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return;
  let domain = '';
  try { domain = new URL(tab.url).hostname; } catch { return; }
  if (!domain) return;

  chrome.storage.local.get(['pausedDomains'], ({ pausedDomains = [] }) => {
    const idx = pausedDomains.indexOf(domain);
    const pausing = idx === -1; // true = we're pausing, false = we're resuming
    if (pausing) {
      pausedDomains.push(domain);
      pauseSiteBtn.classList.add('active');
      pauseSiteBtn.textContent = '▶ Resume site';
    } else {
      pausedDomains.splice(idx, 1);
      pauseSiteBtn.classList.remove('active');
      pauseSiteBtn.textContent = '⏸ Pause on site';
    }
    chrome.storage.local.set({ pausedDomains });
    // Tell background to update declarativeNetRequest rules — WAIT for it
    // to finish before reloading, otherwise the old rules still block.
    chrome.runtime.sendMessage({ type: 'PAUSE_DOMAIN', domain, paused: pausing }, () => {
      // Update hero UI to reflect paused/active state
      mainToggle.checked = !pausing;
      chrome.storage.local.get('enabled', ({ enabled = true }) => {
        updateToggleUI(enabled, pausing);
      });
      // Reload the tab AFTER rules are updated
      chrome.tabs.reload(tab.id);
    });
  });
});

// ── Remove from allowlist ───────────────────────
document.getElementById('removeAllowlist')?.addEventListener('click', async () => {
  const domain = await getCurrentDomain();
  if (!domain) return;
  chrome.storage.local.get('allowedDomains', ({ allowedDomains = [] }) => {
    const updated = allowedDomains.filter(d => d !== domain);
    chrome.storage.local.set({ allowedDomains: updated });
    chrome.runtime.sendMessage({ type: 'ALLOWLIST_CHANGED' });
    // Reload popup state
    loadState();
  });
});

// ── Focus mode ─────────────────────────────────
focusModeBtn.addEventListener('click', () => {
  chrome.storage.local.get(['focusMode', 'focusDuration'], ({ focusMode = false, focusDuration = 25 }) => {
    const next = !focusMode;
    const updates = { focusMode: next };
    if (next) {
      updates.focusEndTime = Date.now() + focusDuration * 60 * 1000;
    } else {
      updates.focusEndTime = null;
    }
    chrome.storage.local.set(updates);
    focusModeBtn.classList.toggle('active', next);
    focusModeBtn.classList.toggle('accent', !next);
    chrome.runtime.sendMessage({ type: 'FOCUS_MODE', enabled: next });
  });
});

// ── Dashboard ──────────────────────────────────
document.getElementById('openDashboard').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
document.getElementById('openSettings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// ── Donate ─────────────────────────────────────
// Replace with your actual PayPal.me or donate link
const PAYPAL_DONATE_URL = 'https://www.paypal.me/linhhvtt/5';
document.getElementById('donateBtnPopup')?.addEventListener('click', () => {
  chrome.tabs.create({ url: PAYPAL_DONATE_URL });
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
const REVIEW_STORE_URLS = {
  firefox: 'https://addons.mozilla.org/addon/adblock-ads-trackers/reviews/',
  edge:    'https://microsoftedge.microsoft.com/addons/detail/pbhhhdiineoaofllgkipegloafcpiaml',
  chrome:  'https://chromewebstore.google.com/detail/adblock-%E2%80%94-ads-trackers/emdofgiggmkkncojffpebiaegdmdkgio/reviews',
};
function _detectReviewStoreUrl() {
  const ua = navigator.userAgent;
  if (ua.includes('Firefox/')) return REVIEW_STORE_URLS.firefox;
  if (ua.includes('Edg/'))     return REVIEW_STORE_URLS.edge;
  return REVIEW_STORE_URLS.chrome;
}
function maybeShowReviewPrompt() {
  const banner = document.getElementById('reviewBanner');
  if (!banner) return;
  chrome.storage.local.get(
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
  chrome.storage.local.set({ reviewPromptState: 'reviewed' });
  chrome.tabs.create({ url: _detectReviewStoreUrl() });
  document.getElementById('reviewBanner')?.classList.add('hidden');
});
document.getElementById('reviewDismissBtn')?.addEventListener('click', () => {
  chrome.storage.local.set({ reviewPromptState: 'dismissed' });
  document.getElementById('reviewBanner')?.classList.add('hidden');
});

// ── "Hide element" picker ───────────────────────
// Arms content/element-picker.js directly on the active tab — same message
// the right-click context menu item sends, just a second entry point for
// discoverability without needing to right-click the exact element first.
document.getElementById('pickElement')?.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'QKV1_ENTER_PICKER_MODE' }, () => {
    void chrome.runtime.lastError;
    window.close();
  });
});

// ── Init ───────────────────────────────────────
loadState();
maybeShowReviewPrompt();

// Show how many network blocking rules are actually loaded
chrome.runtime.sendMessage({ type: 'GET_RULE_COUNT' }, (res) => {
  const chip = document.getElementById('ruleChip');
  if (!chip) return;
  if (chrome.runtime.lastError || !res) {
    chip.textContent = 'network rules: ?';
    chip.classList.add('zero');
    return;
  }
  const n = res.count ?? 0;
  chip.textContent = `${n} network rules loaded`;
  chip.classList.toggle('zero', n === 0);
});
