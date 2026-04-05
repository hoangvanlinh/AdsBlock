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
  chrome.storage.local.set({ enabled: on });
  updateToggleUI(on);
  // Tell background to update declarativeNetRequest rules
  chrome.runtime.sendMessage({ type: 'TOGGLE', enabled: on });
  // Tell content script on active tab to toggle cosmetic filtering
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE', enabled: on }).catch(() => {});
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

// ── Init ───────────────────────────────────────
loadState();

// Show how many blocking rules are actually loaded
chrome.runtime.sendMessage({ type: 'GET_RULE_COUNT' }, (res) => {
  const chip = document.getElementById('ruleChip');
  if (!chip) return;
  if (chrome.runtime.lastError || !res) {
    chip.textContent = 'rules: ?';
    chip.classList.add('zero');
    return;
  }
  const n = res.count ?? 0;
  chip.textContent = `${n} rules active`;
  chip.classList.toggle('zero', n === 0);
});
