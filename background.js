// background.js — AdBlock Service Worker (Manifest V3)
// Handles: network blocking (declarativeNetRequest) + message routing

// ── Default rules (EasyList-style keyword patterns) ───────────────
const DEFAULT_RULES = [
  // Ad networks
  { id: 1,  priority: 1, action: { type: 'block' }, condition: { urlFilter: 'doubleclick.net',      resourceTypes: ['script','image','xmlhttprequest','sub_frame'] } },
  { id: 2,  priority: 1, action: { type: 'block' }, condition: { urlFilter: 'googlesyndication.com', resourceTypes: ['script','image','xmlhttprequest','sub_frame'] } },
  { id: 3,  priority: 1, action: { type: 'block' }, condition: { urlFilter: 'googleadservices.com',  resourceTypes: ['script','image','xmlhttprequest'] } },
  { id: 4,  priority: 1, action: { type: 'block' }, condition: { urlFilter: 'adnxs.com',             resourceTypes: ['script','image','xmlhttprequest'] } },
  { id: 5,  priority: 1, action: { type: 'block' }, condition: { urlFilter: 'outbrain.com',          resourceTypes: ['script','image','xmlhttprequest'] } },
  { id: 6,  priority: 1, action: { type: 'block' }, condition: { urlFilter: 'taboola.com',           resourceTypes: ['script','image','xmlhttprequest','sub_frame'] } },
  { id: 7,  priority: 1, action: { type: 'block' }, condition: { urlFilter: 'ads.yahoo.com',         resourceTypes: ['script','image','xmlhttprequest'] } },
  { id: 8,  priority: 1, action: { type: 'block' }, condition: { urlFilter: 'amazon-adsystem.com',   resourceTypes: ['script','image','xmlhttprequest'] } },
  { id: 9,  priority: 1, action: { type: 'block' }, condition: { urlFilter: 'media.net',             resourceTypes: ['script','image','xmlhttprequest'] } },
  { id: 10, priority: 1, action: { type: 'block' }, condition: { urlFilter: 'criteo.com',            resourceTypes: ['script','image','xmlhttprequest'] } },

  // Trackers
  { id: 11, priority: 1, action: { type: 'block' }, condition: { urlFilter: 'google-analytics.com', resourceTypes: ['script','xmlhttprequest','ping'] } },
  { id: 12, priority: 1, action: { type: 'block' }, condition: { urlFilter: 'analytics.google.com', resourceTypes: ['script','xmlhttprequest','ping'] } },
  { id: 13, priority: 1, action: { type: 'block' }, condition: { urlFilter: 'facebook.com/tr',      resourceTypes: ['xmlhttprequest','image','ping'] } },
  { id: 14, priority: 1, action: { type: 'block' }, condition: { urlFilter: 'hotjar.com',           resourceTypes: ['script','xmlhttprequest'] } },
  { id: 15, priority: 1, action: { type: 'block' }, condition: { urlFilter: 'mixpanel.com',         resourceTypes: ['script','xmlhttprequest'] } },
  { id: 16, priority: 1, action: { type: 'block' }, condition: { urlFilter: 'segment.com',          resourceTypes: ['script','xmlhttprequest'] } },
  { id: 17, priority: 1, action: { type: 'block' }, condition: { urlFilter: 'amplitude.com',        resourceTypes: ['script','xmlhttprequest'] } },
  { id: 18, priority: 1, action: { type: 'block' }, condition: { urlFilter: 'fullstory.com',        resourceTypes: ['script','xmlhttprequest'] } },
  { id: 19, priority: 1, action: { type: 'block' }, condition: { urlFilter: 'clarity.ms',           resourceTypes: ['script','xmlhttprequest'] } },
  { id: 20, priority: 1, action: { type: 'block' }, condition: { urlFilter: 'quantserve.com',       resourceTypes: ['script','image','xmlhttprequest'] } },

  // YouTube ad serving endpoints
  // NOTE: ALL youtube.com-specific network blocks are intentionally removed.
  // Blocking youtube.com/* endpoints (pagead, get_midroll_info, ptracking, etc.)
  // is exactly how YouTube detects ad blockers. Ad stripping is handled entirely
  // client-side by content/yt-adblock.js (MAIN world) + ytcfg enforcement bypass.
];

// ── Malware / phishing domain rules (static built-in) ─────────
// Sources: URLhaus (abuse.ch), Phishing Army, Steven Black, SANS ISC
const MALWARE_RULES = [
  { id: 101, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['malware-check.disconnect.me'], resourceTypes: ['main_frame','sub_frame','script','xmlhttprequest','image'] } },
  { id: 102, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['phishing.example.net'],       resourceTypes: ['main_frame','sub_frame','script','xmlhttprequest','image'] } },
  // Known malware distribution domains (from URLhaus/abuse.ch)
  { id: 103, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['dl.free-counter.co.uk'],     resourceTypes: ['main_frame','sub_frame','script','xmlhttprequest','image'] } },
  { id: 104, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['naifrede.com'],              resourceTypes: ['main_frame','sub_frame','script','xmlhttprequest','image'] } },
  { id: 105, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['clafrfrede.com'],            resourceTypes: ['main_frame','sub_frame','script','xmlhttprequest','image'] } },
  // Crypto mining
  { id: 106, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['coinhive.com'],              resourceTypes: ['main_frame','sub_frame','script','xmlhttprequest'] } },
  { id: 107, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['coin-hive.com'],             resourceTypes: ['main_frame','sub_frame','script','xmlhttprequest'] } },
  { id: 108, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['jsecoin.com'],               resourceTypes: ['main_frame','sub_frame','script','xmlhttprequest'] } },
  { id: 109, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['crypto-loot.com'],           resourceTypes: ['main_frame','sub_frame','script','xmlhttprequest'] } },
  { id: 110, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['authedmine.com'],            resourceTypes: ['main_frame','sub_frame','script','xmlhttprequest'] } },
  // Phishing / scam
  { id: 111, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['0-internal.paypal.com.de'],  resourceTypes: ['main_frame','sub_frame'] } },
  { id: 112, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['apple-icloud.org.uk'],       resourceTypes: ['main_frame','sub_frame'] } },
  { id: 113, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['login-microsoft-office.com'],resourceTypes: ['main_frame','sub_frame'] } },
  { id: 114, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['secure-login-bank.com'],     resourceTypes: ['main_frame','sub_frame'] } },
  { id: 115, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['netflix-account.com'],       resourceTypes: ['main_frame','sub_frame'] } },
  // Adware / PUP distribution
  { id: 116, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['installcore.net'],           resourceTypes: ['main_frame','sub_frame','script','xmlhttprequest'] } },
  { id: 117, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['softonic-analytics.net'],    resourceTypes: ['main_frame','sub_frame','script','xmlhttprequest'] } },
  { id: 118, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['bonzi.software'],            resourceTypes: ['main_frame','sub_frame','script','xmlhttprequest'] } },
  // Malvertising redirect chains
  { id: 119, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['adf.ly'],                    resourceTypes: ['main_frame','sub_frame','script'] } },
  { id: 120, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['sh.st'],                     resourceTypes: ['main_frame','sub_frame','script'] } },
  { id: 121, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['ad-maven.com'],              resourceTypes: ['main_frame','sub_frame','script'] } },
  { id: 122, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['propellerads.com'],          resourceTypes: ['main_frame','sub_frame','script'] } },
  // Exploit kits
  { id: 123, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['rig-exploit.com'],           resourceTypes: ['main_frame','sub_frame','script','xmlhttprequest'] } },
  { id: 124, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['exploit-kit-check.net'],     resourceTypes: ['main_frame','sub_frame','script','xmlhttprequest'] } },
  // Spyware / keylogger domains
  { id: 125, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['mspy.com'],                  resourceTypes: ['main_frame','sub_frame','script','xmlhttprequest'] } },
  { id: 126, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['flexispy.com'],              resourceTypes: ['main_frame','sub_frame','script','xmlhttprequest'] } },
  // Tech-support scam
  { id: 127, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['virus-alert-windows.com'],   resourceTypes: ['main_frame','sub_frame'] } },
  { id: 128, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['your-pc-is-infected.com'],   resourceTypes: ['main_frame','sub_frame'] } },
  // Browser locker / notification spam
  { id: 129, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['push-notification.tools'],   resourceTypes: ['main_frame','sub_frame','script'] } },
  { id: 130, priority: 2, action: { type: 'block' }, condition: { requestDomains: ['notification-service.club'], resourceTypes: ['main_frame','sub_frame','script'] } },
];

const MALWARE_RULE_ID_START = 100;
const MALWARE_RULE_ID_END   = 199;
const FOCUS_RULE_ID_START   = 2000;
const REMOTE_MALWARE_RULE_ID_START = 3000; // for fetched blocklists
const CUSTOM_RULE_ID_START = 4000;        // for user-created rules
const PAUSE_ALLOW_RULE_ID_START = 6000;   // for pause/allowlist allow-all rules

// Rule IDs 11-20 are trackers; 1-10 are ads; 100-199 are malware (static)
const TRACKER_RULE_IDS = new Set([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
const MALWARE_RULE_IDS = new Set(MALWARE_RULES.map(r => r.id));

// ── Privacy score calculation ─────────────────────────────────────
// Pure function — duplicated in popup.js and dashboard.js too.
// domainStats: { adsBlocked, trackersBlocked, totalSeen }
// settings:    { enabled, paused, referrerAnonymization }
function calculatePrivacyScore(domainStats = {}, settings = {}) {
  const total = domainStats.totalSeen || 0;
  const protectionActive = settings.enabled !== false && !settings.paused;

  // Component 1 — Ads blocked (0–100)
  // Heuristic: expect ~15% of requests to be ads on a typical page.
  // Score = (adsBlocked / expectedAds) * 100, capped at 100.
  let adsScore = protectionActive ? 50 : 0; // 50 = no data yet but protection on
  if (total > 0) {
    const expected = Math.max(total * 0.15, 1);
    adsScore = protectionActive
      ? Math.min(100, Math.round(((domainStats.adsBlocked || 0) / expected) * 100))
      : 0;
  }

  // Component 2 — Trackers blocked (0–100)
  // Heuristic: expect ~10% of requests to be trackers.
  let trackersScore = protectionActive ? 50 : 0;
  if (total > 0) {
    const expected = Math.max(total * 0.10, 1);
    trackersScore = protectionActive
      ? Math.min(100, Math.round(((domainStats.trackersBlocked || 0) / expected) * 100))
      : 0;
  }

  // Component 3 — Referrer anonymization (setting-based)
  const referrerScore = settings.referrerAnonymization !== false ? 85 : 20;

  // Component 4 — Malware blocked (0–100)
  // Any malware blocked = excellent; having protection active = good baseline
  let malwareScore = protectionActive ? 70 : 0;
  if ((domainStats.malwareBlocked || 0) > 0) malwareScore = 100;

  // Weighted average: ads 30%, trackers 25%, malware 20%, referrer 25%
  const score = Math.round(
    adsScore       * 0.30 +
    trackersScore  * 0.25 +
    malwareScore   * 0.20 +
    referrerScore  * 0.25
  );

  return {
    score: Math.max(0, Math.min(100, score)),
    components: {
      ads:         Math.min(100, Math.round(adsScore)),
      trackers:    Math.min(100, Math.round(trackersScore)),
      malware:     Math.min(100, Math.round(malwareScore)),
      referrer:    referrerScore,
    },
  };
}

// ── Install / startup ─────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  // Seed default settings
  const existing = await chrome.storage.local.get([
    'enabled', 'pausedDomains', 'allowedDomains', 'focusMode', 'stats', 'rules',
    'referrerAnonymization', 'collectStats',
    'blockAds', 'blockTrackers', 'cosmeticFiltering', 'blockMalware',
  ]);
  await chrome.storage.local.set({
    enabled:                existing.enabled                ?? true,
    pausedDomains:          existing.pausedDomains          ?? [],
    allowedDomains:         existing.allowedDomains         ?? [],
    focusMode:              existing.focusMode              ?? false,
    stats:                  existing.stats                  ?? {},
    rules:                  existing.rules                  ?? [],
    referrerAnonymization:  existing.referrerAnonymization  ?? true,
    collectStats:           existing.collectStats           ?? true,
    blockAds:               existing.blockAds               ?? true,
    blockTrackers:          existing.blockTrackers           ?? true,
    cosmeticFiltering:      existing.cosmeticFiltering      ?? true,
    blockMalware:           existing.blockMalware           ?? true,
  });

  await applyNetworkRules();
  await applyPrivacySettings();
  maybeUpdateMalwareLists();
});

chrome.runtime.onStartup.addListener(() => {
  applyNetworkRules();
  applyPrivacySettings();
  maybeUpdateMalwareLists();
});

let activeStatsRules = [];
let statsRulesInitialized = false;

async function buildActiveRulesFromStorage() {
  const {
    enabled, pausedDomains = [], allowedDomains = [], focusMode = false,
    blockAds = true, blockTrackers = true, blockMalware = true,
  } = await chrome.storage.local.get(
    ['enabled', 'pausedDomains', 'allowedDomains', 'focusMode', 'blockAds', 'blockTrackers', 'blockMalware']
  );

  if (!enabled) return { enabled: false, allRules: [] };

  const AD_RULE_IDS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const filteredDefaultRules = DEFAULT_RULES.filter(r => {
    if (AD_RULE_IDS.has(r.id) && !blockAds) return false;
    if (TRACKER_RULE_IDS.has(r.id) && !blockTrackers) return false;
    return true;
  });

  const activeRules = [...filteredDefaultRules];
  const malwareActive = blockMalware ? [...MALWARE_RULES] : [];
  const { remoteMalwareRules = [] } = await chrome.storage.local.get('remoteMalwareRules');
  const remoteActive = blockMalware ? [...remoteMalwareRules] : [];
  const customBlockRules = await buildCustomBlockRules();
  const focusRules = await buildFocusRules(focusMode);

  // Build allowAllRequests rules for paused + allowlisted domains.
  // These have higher priority and override ALL blocking rules for
  // requests originating from these domains. This is the only
  // reliable way to fully pause blocking per-domain.
  const excludedDomains = [...new Set([...pausedDomains, ...allowedDomains])];
  const pauseAllowRules = excludedDomains.map((domain, i) => ({
    id: PAUSE_ALLOW_RULE_ID_START + i,
    priority: 10, // higher than all block rules (priority 1-2)
    action: { type: 'allowAllRequests' },
    condition: {
      requestDomains: [domain],
      resourceTypes: ['main_frame', 'sub_frame'],
    },
  }));

  return {
    enabled: true,
    allRules: [
      ...activeRules, ...malwareActive, ...remoteActive,
      ...customBlockRules, ...focusRules, ...pauseAllowRules,
    ],
  };
}

// ── Apply declarativeNetRequest rules ────────────────────────────
async function applyNetworkRules() {
  const { enabled, allRules } = await buildActiveRulesFromStorage();

  // Remove all existing dynamic rules
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeIds = existing.map(r => r.id);

  if (!enabled) {
    // Protection OFF — remove all rules
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds, addRules: [] });
    activeStatsRules = [];
    statsRulesInitialized = true;
    updateIcon(false);
    return;
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: removeIds,
    addRules: allRules,
  });

  activeStatsRules = allRules.filter(rule => rule.action?.type === 'block');
  statsRulesInitialized = true;
  updateIcon(true);
}

// ── User custom blocking rules ────────────────────────────────────
async function buildCustomBlockRules() {
  const { rules = [] } = await chrome.storage.local.get('rules');
  const blockRules = rules.filter(r => r.active && r.action === 'block');
  return blockRules.map((r, i) => {
    const ruleId = CUSTOM_RULE_ID_START + i;
    const condition = { resourceTypes: ['script', 'image', 'xmlhttprequest', 'sub_frame', 'stylesheet', 'font', 'media', 'main_frame'] };

    if (r.type === 'domain') {
      condition.requestDomains = [r.pattern];
    } else if (r.type === 'keyword') {
      condition.urlFilter = r.pattern;
    } else if (r.type === 'regex') {
      condition.regexFilter = r.pattern;
    } else {
      // css type → hide only, handled by content script
      return null;
    }
    return { id: ruleId, priority: 1, action: { type: 'block' }, condition };
  }).filter(Boolean);
}

// ── Focus mode blocking rules ─────────────────────────────────────
const DISTRACTION_DEFAULTS = ['twitter.com', 'youtube.com', 'reddit.com', 'instagram.com', 'tiktok.com'];

async function buildFocusRules(focusMode) {
  if (!focusMode) return [];
  const { distractionDomains = DISTRACTION_DEFAULTS } = await chrome.storage.local.get('distractionDomains');
  return distractionDomains.map((domain, i) => ({
    id:       FOCUS_RULE_ID_START + i,
    priority: 2,
    action:   { type: 'block' },
    condition: {
      requestDomains: [domain],
      resourceTypes:  ['main_frame', 'sub_frame', 'script', 'image', 'xmlhttprequest'],
    },
  }));
}

// ── Icon badge ────────────────────────────────────────────────────
function updateIcon(enabled) {
  chrome.action.setIcon({
    path: {
      16:  enabled ? 'icons/icon16.png'     : 'icons/icon16_off.png',
      48:  enabled ? 'icons/icon48.png'     : 'icons/icon48_off.png',
      128: enabled ? 'icons/icon128.png'    : 'icons/icon128_off.png',
    },
  });
  chrome.action.setBadgeText({ text: enabled ? '' : 'OFF' });
  chrome.action.setBadgeBackgroundColor({ color: enabled ? [0, 0, 0, 0] : '#f87171' });
}

// ── Stats tracking ────────────────────────────────────────────────
function initDomainStats() {
  return { blocked: 0, adsBlocked: 0, trackersBlocked: 0, malwareBlocked: 0, totalSeen: 0, bandwidth: 0, timeSaved: 0, speedGain: 0, https: false };
}

// Average bytes saved per blocked request (heuristic)
const AVG_AD_BYTES      = 50000;  // ~50 KB per ad script/image
const AVG_TRACKER_BYTES = 15000;  // ~15 KB per tracker request

// ── Daily stats accumulator ────────────────────────────────────────
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function updateDailyStats(delta) {
  const key = todayKey();
  const { dailyStats = {} } = await chrome.storage.local.get('dailyStats');
  if (!dailyStats[key]) dailyStats[key] = { blocked: 0, ads: 0, trackers: 0, malware: 0 };
  dailyStats[key].blocked  += delta.blocked  || 0;
  dailyStats[key].ads      += delta.ads      || 0;
  dailyStats[key].trackers += delta.trackers || 0;
  dailyStats[key].malware  += delta.malware  || 0;

  // Keep only last 30 days
  const keys = Object.keys(dailyStats).sort();
  while (keys.length > 30) { delete dailyStats[keys.shift()]; }

  await chrome.storage.local.set({ dailyStats });
}

function recalcDerived(s) {
  s.timeSaved  = Math.round(s.blocked * 0.3);
  s.bandwidth  = (s.adsBlocked * AVG_AD_BYTES) + (s.trackersBlocked * AVG_TRACKER_BYTES);
  s.speedGain  = s.totalSeen > 0 ? Math.round((s.blocked / s.totalSeen) * 100) : 0;
}

const AD_KEYWORDS = [
  'doubleclick', 'googlesyndication', 'adnxs', 'outbrain', 'taboola',
  'amazon-adsystem', 'media.net', 'criteo', 'advertising.com',
  'pubmatic', 'openx.net', 'rubiconproject', '/ads/', '/ad/',
];

const TRACKER_KEYWORDS = [
  'google-analytics', 'analytics.google.com', 'facebook.com/tr',
  'hotjar', 'mixpanel', 'segment.io', 'amplitude', 'fullstory',
  'clarity.ms', 'quantserve',
];

const MALWARE_KEYWORDS = [
  'coinhive', 'coin-hive', 'jsecoin', 'crypto-loot', 'authedmine',
  'cryptonight', 'minero.cc', 'miner.bundledload',
  'exploit-kit', '.exe.download',
];

// ── Remote malware blocklist updater ──────────────────────────────
// Fetches community blocklists every 24 hours (or on install)
const BLOCKLIST_SOURCES = [
  // URLhaus: live malware URL/domain feed (abuse.ch research project)
  { url: 'https://urlhaus.abuse.ch/downloads/hostfile/', name: 'URLhaus' },
  // Phishing Army: aggregated phishing domains
  { url: 'https://phishing.army/download/phishing_army_blocklist.txt', name: 'Phishing Army' },
];

const REMOTE_MAX_DOMAINS = 500; // cap to stay within declarativeNetRequest limits

async function fetchMalwareBlocklists() {
  const allDomains = new Set();
  for (const source of BLOCKLIST_SOURCES) {
    try {
      const resp = await fetch(source.url, { cache: 'no-cache' });
      if (!resp.ok) continue;
      const text = await resp.text();
      const lines = text.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
        // Hosts file format: "127.0.0.1 domain" or "0.0.0.0 domain" or just "domain"
        let domain = trimmed;
        if (domain.startsWith('127.0.0.1') || domain.startsWith('0.0.0.0')) {
          domain = domain.split(/\s+/)[1];
        }
        if (!domain || domain === 'localhost' || domain.includes('/') || !domain.includes('.')) continue;
        allDomains.add(domain.toLowerCase());
        if (allDomains.size >= REMOTE_MAX_DOMAINS) break;
      }
    } catch (e) {
      console.warn(`[AdBlock] Failed to fetch ${source.name}:`, e.message);
    }
    if (allDomains.size >= REMOTE_MAX_DOMAINS) break;
  }

  // Convert to declarativeNetRequest rules
  const rules = [];
  let id = REMOTE_MALWARE_RULE_ID_START;
  for (const domain of allDomains) {
    rules.push({
      id: id++,
      priority: 2,
      action: { type: 'block' },
      condition: {
        requestDomains: [domain],
        // Exclude sub_frame to avoid blocking embedded video players (iframes)
        resourceTypes: ['main_frame', 'script', 'xmlhttprequest', 'image'],
      },
    });
  }

  // Store rules and update timestamp
  await chrome.storage.local.set({
    remoteMalwareRules: rules,
    malwareListLastUpdate: Date.now(),
    malwareListCount: rules.length,
  });

  // Re-apply all network rules
  await applyNetworkRules();

  console.log(`[AdBlock] Malware blocklist updated: ${rules.length} domains from remote sources`);
  return rules.length;
}

// Check if blocklist needs update (every 24 hours)
async function maybeUpdateMalwareLists() {
  const { malwareListLastUpdate = 0 } = await chrome.storage.local.get('malwareListLastUpdate');
  const ONE_DAY = 24 * 60 * 60 * 1000;
  if (Date.now() - malwareListLastUpdate > ONE_DAY) {
    await fetchMalwareBlocklists();
  }
}

// Schedule periodic updates via alarm
chrome.alarms?.create('malware-list-update', { periodInMinutes: 60 * 24 });
chrome.alarms?.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'malware-list-update') {
    await fetchMalwareBlocklists();
  }
  if (alarm.name === 'focus-end') {
    // Auto-disable focus mode when timer expires
    await chrome.storage.local.set({ focusMode: false, focusEndTime: null });
    await applyNetworkRules();
  }
});

// ── Privacy: Referrer anonymization ───────────────────────────────
// Uses declarativeNetRequest to strip cross-origin Referer to origin only.
const REFERRER_RULE_ID = 5000;

async function applyReferrerAnonymization(enabled) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const hasRule = existing.some(r => r.id === REFERRER_RULE_ID);

  if (enabled && !hasRule) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [{
        id: REFERRER_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{
            header: 'Referer',
            operation: 'set',
            value: '',
          }],
        },
        condition: {
          domainType: 'thirdParty',
          resourceTypes: ['sub_frame', 'script', 'xmlhttprequest', 'image', 'stylesheet', 'font', 'media', 'ping', 'other'],
        },
      }],
    });
  } else if (!enabled && hasRule) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [REFERRER_RULE_ID],
    });
  }
}

// Apply saved privacy settings on startup
async function applyPrivacySettings() {
  const { referrerAnonymization = true } = await chrome.storage.local.get(['referrerAnonymization']);
  await applyReferrerAnonymization(referrerAnonymization);
}

// ── Message handler ───────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {

      case 'TOGGLE': {
        await chrome.storage.local.set({ enabled: msg.enabled });
        await applyNetworkRules();
        sendResponse({ ok: true });
        break;
      }

      case 'PAUSE_DOMAIN': {
        const { pausedDomains = [] } = await chrome.storage.local.get('pausedDomains');
        if (msg.paused && !pausedDomains.includes(msg.domain)) {
          pausedDomains.push(msg.domain);
        } else if (!msg.paused) {
          const idx = pausedDomains.indexOf(msg.domain);
          if (idx !== -1) pausedDomains.splice(idx, 1);
        }
        await chrome.storage.local.set({ pausedDomains });
        await applyNetworkRules();
        // Update badge on the active tab immediately
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.id) {
          if (msg.paused) {
            chrome.action.setBadgeText({ text: '⏸', tabId: activeTab.id });
            chrome.action.setBadgeBackgroundColor({ color: '#f59e0b', tabId: activeTab.id });
          } else {
            chrome.action.setBadgeText({ text: '', tabId: activeTab.id });
            chrome.action.setBadgeBackgroundColor({ color: [0, 0, 0, 0], tabId: activeTab.id });
          }
        }
        sendResponse({ ok: true });
        break;
      }

      case 'FOCUS_MODE': {
        await chrome.storage.local.set({ focusMode: msg.enabled });
        if (msg.enabled) {
          // Set alarm to auto-disable focus when timer expires (even if dashboard is closed)
          const { focusEndTime } = await chrome.storage.local.get('focusEndTime');
          if (focusEndTime) {
            const delayMs = focusEndTime - Date.now();
            if (delayMs > 0) {
              chrome.alarms.create('focus-end', { when: focusEndTime });
            }
          }
        } else {
          chrome.alarms.clear('focus-end');
        }
        await applyNetworkRules();
        sendResponse({ ok: true });
        break;
      }

      case 'ALLOWLIST_CHANGED': {
        await applyNetworkRules();
        sendResponse({ ok: true });
        break;
      }

      case 'RULES_CHANGED': {
        // Reapply network rules (picks up new custom block rules)
        await applyNetworkRules();
        // Notify all tabs to refresh custom CSS hide rules
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, { type: 'RULES_CHANGED' }).catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }

      case 'SET_PRIVACY': {
        // msg: { setting: 'referrerAnonymization', value: bool }
        const allowed = ['referrerAnonymization'];
        if (!allowed.includes(msg.setting)) { sendResponse({ ok: false }); break; }
        await chrome.storage.local.set({ [msg.setting]: msg.value });
        if (msg.setting === 'referrerAnonymization') await applyReferrerAnonymization(msg.value);
        sendResponse({ ok: true });
        break;
      }

      case 'SET_BLOCKING': {
        // msg: { setting: 'blockAds' | 'blockTrackers' | 'cosmeticFiltering' | 'blockMalware', value: bool }
        const allowedKeys = ['blockAds', 'blockTrackers', 'cosmeticFiltering', 'blockMalware'];
        if (!allowedKeys.includes(msg.setting)) { sendResponse({ ok: false }); break; }
        await chrome.storage.local.set({ [msg.setting]: msg.value });
        if (msg.setting === 'cosmeticFiltering') {
          // Notify all tabs to enable/disable cosmetic CSS
          const tabs = await chrome.tabs.query({});
          for (const tab of tabs) {
            chrome.tabs.sendMessage(tab.id, { type: 'COSMETIC_TOGGLE', enabled: msg.value }).catch(() => {});
          }
        } else {
          await applyNetworkRules();
        }
        sendResponse({ ok: true });
        break;
      }

      case 'RESOURCE_SEEN': {
        // Sent by content.js MutationObserver with classification counts.
        // delta: { seen, ads, trackers, malware }
        const { collectStats = true } = await chrome.storage.local.get('collectStats');
        if (!collectStats) { sendResponse({ ok: true }); break; }

        const { stats = {} } = await chrome.storage.local.get('stats');
        const domain = msg.domain || '_global';
        if (!stats[domain]) {
          stats[domain] = { blocked: 0, adsBlocked: 0, trackersBlocked: 0, malwareBlocked: 0, totalSeen: 0, bandwidth: 0, timeSaved: 0, speedGain: 0 };
        }
        const s = stats[domain];
        const d = msg.delta || {};
        s.totalSeen      += d.seen     || 0;
        s.adsBlocked     += d.ads      || 0;
        s.trackersBlocked += d.trackers || 0;
        s.malwareBlocked  += d.malware  || 0;
        s.blocked = s.adsBlocked + s.trackersBlocked + s.malwareBlocked;
        recalcDerived(s);

        // Cap per-domain stats to 200 domains to prevent unbounded storage growth
        const domainKeys = Object.keys(stats).filter(k => k !== '_global');
        if (domainKeys.length > 200) {
          // Remove oldest/lowest-traffic domains
          domainKeys.sort((a, b) => (stats[a].totalSeen || 0) - (stats[b].totalSeen || 0));
          const toRemove = domainKeys.slice(0, domainKeys.length - 200);
          for (const k of toRemove) delete stats[k];
        }

        await chrome.storage.local.set({ stats });

        // Also update daily chart data
        await updateDailyStats({
          blocked:  (d.ads || 0) + (d.trackers || 0) + (d.malware || 0),
          ads:      d.ads      || 0,
          trackers: d.trackers || 0,
          malware:  d.malware  || 0,
        });

        sendResponse({ ok: true });
        break;
      }

      case 'COSMETIC_HIDDEN': {
        // Sent by content.js when cosmetic filtering hides ad elements.
        const { collectStats: collectCH = true } = await chrome.storage.local.get('collectStats');
        if (!collectCH) { sendResponse({ ok: true }); break; }

        const { stats: chStats = {} } = await chrome.storage.local.get('stats');
        const chDomain = (msg.url ? new URL(msg.url).hostname : null) || '_global';
        if (!chStats[chDomain]) {
          chStats[chDomain] = { blocked: 0, adsBlocked: 0, trackersBlocked: 0, malwareBlocked: 0, totalSeen: 0, bandwidth: 0, timeSaved: 0, speedGain: 0 };
        }
        const chS = chStats[chDomain];
        const hiddenCount = msg.count || 0;
        chS.adsBlocked += hiddenCount;
        chS.totalSeen  += hiddenCount;
        chS.blocked     = chS.adsBlocked + chS.trackersBlocked + chS.malwareBlocked;
        recalcDerived(chS);
        await chrome.storage.local.set({ stats: chStats });

        await updateDailyStats({ blocked: hiddenCount, ads: hiddenCount, trackers: 0, malware: 0 });
        sendResponse({ ok: true });
        break;
      }

      case 'AD_SKIPPED': {
        // Sent by content.js YouTube ad skipper when a video ad is skipped.
        const { collectStats: collectAS = true } = await chrome.storage.local.get('collectStats');
        if (!collectAS) { sendResponse({ ok: true }); break; }

        const { stats: asStats = {} } = await chrome.storage.local.get('stats');
        const asDomain = msg.domain || '_global';
        if (!asStats[asDomain]) {
          asStats[asDomain] = { blocked: 0, adsBlocked: 0, trackersBlocked: 0, malwareBlocked: 0, totalSeen: 0, bandwidth: 0, timeSaved: 0, speedGain: 0 };
        }
        const asS = asStats[asDomain];
        asS.adsBlocked += 1;
        asS.totalSeen  += 1;
        asS.blocked     = asS.adsBlocked + asS.trackersBlocked + asS.malwareBlocked;
        recalcDerived(asS);
        await chrome.storage.local.set({ stats: asStats });

        await updateDailyStats({ blocked: 1, ads: 1, trackers: 0, malware: 0 });
        sendResponse({ ok: true });
        break;
      }

      case 'GET_CLASSIFIER_LISTS': {
        // Derive classifier patterns directly from actual DNR rule definitions.
        // content.js uses these to classify observed DOM resources for stats.
        const AD_IDS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        const adPatterns = DEFAULT_RULES
          .filter(r => AD_IDS.has(r.id) && r.condition.urlFilter)
          .map(r => r.condition.urlFilter);

        const trackerPatterns = DEFAULT_RULES
          .filter(r => TRACKER_RULE_IDS.has(r.id) && r.condition.urlFilter)
          .map(r => r.condition.urlFilter);

        const malwarePatterns = MALWARE_RULES
          .flatMap(r => r.condition.requestDomains || []);

        // Also include user custom block rules (domain + keyword types)
        const { rules = [] } = await chrome.storage.local.get('rules');
        for (const r of rules) {
          if (!r.active || r.action !== 'block') continue;
          if (r.type === 'domain' && r.pattern)  adPatterns.push(r.pattern);
          if (r.type === 'keyword' && r.pattern) adPatterns.push(r.pattern);
        }

        sendResponse({ adPatterns, trackerPatterns, malwarePatterns });
        break;
      }

      case 'GET_STATS': {
        const { stats = {} } = await chrome.storage.local.get('stats');
        sendResponse({ stats });
        break;
      }

      case 'GET_RULE_COUNT': {
        const rules = await chrome.declarativeNetRequest.getDynamicRules();
        sendResponse({ count: rules.length, rules: rules.map(r => r.id) });
        break;
      }

      case 'UPDATE_MALWARE_LISTS': {
        const count = await fetchMalwareBlocklists();
        sendResponse({ ok: true, count });
        break;
      }

      case 'GET_MALWARE_STATUS': {
        const { malwareListLastUpdate = 0, malwareListCount = 0 } = await chrome.storage.local.get(['malwareListLastUpdate', 'malwareListCount']);
        sendResponse({ lastUpdate: malwareListLastUpdate, count: malwareListCount + MALWARE_RULES.length });
        break;
      }

      case 'RESET': {
        await chrome.storage.local.clear();
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: (await chrome.declarativeNetRequest.getDynamicRules()).map(r => r.id),
          addRules: [],
        });
        activeStatsRules = [];
        statsRulesInitialized = true;
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ ok: false, error: 'Unknown message type' });
    }
  })();
  return true; // keep channel open for async response
});

// ── Tab tracking (pause-per-domain badge) ─────────────────────────
async function updateBadgeForTab(tabId, url) {
  if (!url) return;
  let domain = '';
  try { domain = new URL(url).hostname; } catch { return; }
  const { pausedDomains = [] } = await chrome.storage.local.get('pausedDomains');
  if (pausedDomains.includes(domain)) {
    chrome.action.setBadgeText({ text: '⏸', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b', tabId });
  } else {
    chrome.action.setBadgeText({ text: '', tabId });
    chrome.action.setBadgeBackgroundColor({ color: [0, 0, 0, 0], tabId });
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url) return;
  updateBadgeForTab(tabId, tab.url);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    updateBadgeForTab(tabId, tab.url);
  }
});

// ── Helpers ───────────────────────────────────────────────────────
function extractDomain(url) {
  try { return new URL(url).hostname; }
  catch { return null; }
}
