// background.js — AdBlock Service Worker (Manifest V3)
// Handles: network blocking (declarativeNetRequest) + message routing

// Shared constants live in config.js (single source of truth).
// Chrome MV3 service worker: importScripts. Firefox background page:
// importScripts does not exist there — config.js is listed before this
// file in background.scripts instead, so ADBLOCK_CONFIG is already set.
if (typeof importScripts === 'function' && !self.ADBLOCK_CONFIG) {
  importScripts('config.js');
}
const {
  RULES_REMOTE_URL,
  RULES_LOCAL_PATH,
  RULES_CACHE_TEXT_KEY,
  RULES_CACHE_TIME_KEY,
  RULES_CACHE_TTL_MS,
} = self.ADBLOCK_CONFIG;

const FALLBACK_RULE_CONFIG = {
  adNetworkPatterns: ['doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adnxs.com', 'outbrain.com', 'taboola.com', 'ads.yahoo.com', 'amazon-adsystem.com', 'media.net', 'criteo.com'],
  trackerNetworkPatterns: ['google-analytics.com', 'analytics.google.com', 'facebook.com/tr', 'hotjar.com', 'mixpanel.com', 'segment.com', 'amplitude.com', 'fullstory.com', 'clarity.ms', 'quantserve.com'],
  malwareNetworkDomains: ['malware-check.disconnect.me', 'phishing.example.net', 'dl.free-counter.co.uk', 'naifrede.com', 'clafrfrede.com', 'coinhive.com', 'coin-hive.com', 'jsecoin.com', 'crypto-loot.com', 'authedmine.com', '0-internal.paypal.com.de', 'apple-icloud.org.uk', 'login-microsoft-office.com', 'secure-login-bank.com', 'netflix-account.com', 'installcore.net', 'softonic-analytics.net', 'bonzi.software', 'adf.ly', 'sh.st', 'ad-maven.com', 'propellerads.com', 'rig-exploit.com', 'exploit-kit-check.net', 'mspy.com', 'flexispy.com', 'virus-alert-windows.com', 'your-pc-is-infected.com', 'push-notification.tools', 'notification-service.club'],
  adPatterns: ['doubleclick', 'googlesyndication', 'googleadservices', 'adnxs', 'outbrain', 'taboola', 'amazon-adsystem', 'media.net', 'criteo', 'advertising.com', 'pubmatic', 'openx.net', 'rubiconproject'],
  trackerPatterns: ['google-analytics.com', 'analytics.google.com', 'facebook.com/tr', 'hotjar.com', 'mixpanel.com', 'segment.com', 'amplitude.com', 'fullstory.com', 'clarity.ms', 'quantserve.com'],
  malwarePatterns: ['coinhive', 'coin-hive', 'jsecoin', 'crypto-loot', 'authedmine', 'cryptonight', 'minero.cc'],
};

let DEFAULT_RULES = [];
let MALWARE_RULES = [];
let TRACKER_RULE_IDS = new Set();
let MALWARE_RULE_IDS = new Set();
let _ruleConfigPromise = null;

function parseRuleText(text) {
  const out = {};
  let section = '';
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line[0] === '#' || line[0] === ';') continue;
    if (line[0] === '[' && line[line.length - 1] === ']') {
      section = line.slice(1, -1).trim().toLowerCase();
      if (section && !out[section]) out[section] = {};
      continue;
    }
    if (!section) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (!key) continue;
    const newVals = value ? value.split('|').map(part => part.trim()).filter(Boolean) : [];
    // Merge duplicate keys across multiple source files (same semantics as the
    // content-side parser): append values not already present.
    if (out[section][key] && out[section][key].length) {
      const seen = new Set(out[section][key]);
      for (const v of newVals) {
        if (!seen.has(v)) { seen.add(v); out[section][key].push(v); }
      }
    } else {
      out[section][key] = newVals;
    }
  }
  return out;
}

async function getCachedRuleText() {
  try {
    const cached = await chrome.storage.local.get([RULES_CACHE_TEXT_KEY, RULES_CACHE_TIME_KEY]);
    if (!cached[RULES_CACHE_TEXT_KEY]) return null;
    return {
      text: cached[RULES_CACHE_TEXT_KEY],
      time: Number(cached[RULES_CACHE_TIME_KEY] || 0),
    };
  } catch {
    return null;
  }
}

async function setCachedRuleText(text) {
  if (!text) return;
  try {
    await chrome.storage.local.set({
      [RULES_CACHE_TEXT_KEY]: text,
      [RULES_CACHE_TIME_KEY]: Date.now(),
    });
  } catch {}
}

function isFreshRuleCache(entry) {
  return !!(entry && entry.text && entry.time && (Date.now() - entry.time) < RULES_CACHE_TTL_MS);
}

async function fetchRemoteRuleText() {
  const stored = await chrome.storage.local.get(['ruleSources', 'customRulesUrl', 'customRulesText']);
  const sources = stored.ruleSources;
  const urls = [];
  const fileParts = [];

  // Always load the default remote as base first
  urls.push(RULES_REMOTE_URL);

  if (sources && sources.length) {
    for (const s of sources) {
      if (s.type === 'url' && s.url && s.url !== RULES_REMOTE_URL) urls.push(s.url);
      else if (s.type === 'file' && s.text) fileParts.push(s.text);
    }
  } else if (stored.customRulesUrl && stored.customRulesUrl !== RULES_REMOTE_URL) {
    urls.push(stored.customRulesUrl);
  }

  // Append user's custom rules text (merged with built-in rules via parseRuleText merge logic)
  if (stored.customRulesText) fileParts.push(stored.customRulesText);

  const texts = await Promise.all(urls.map(async url => {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      return res.ok ? res.text() : '';
    } catch { return ''; }
  }));

  const merged = [...texts, ...fileParts].filter(Boolean).join('\n');
  if (!merged) throw new Error('no rules available');
  await setCachedRuleText(merged);
  return merged;
}

async function fetchLocalRuleText() {
  const res = await fetch(chrome.runtime.getURL(RULES_LOCAL_PATH), { cache: 'no-store' });
  return res.ok ? res.text() : '';
}

// ── Remote rules revalidation (ETag) ──────────────────────────────
// The 6h TTL alone means an urgent rules fix can take up to 6h to reach
// users. Instead, a 30-minute alarm revalidates the default remote with
// If-None-Match: a 304 response costs a few hundred bytes and just extends
// the cache; only a real content change triggers the full reload pipeline.
const RULES_REVALIDATE_ALARM = 'rules-revalidate';
const RULES_REVALIDATE_PERIOD_MIN = 30;
const RULES_REMOTE_ETAG_KEY = 'siteRulesRemoteEtag';
const RULES_REMOTE_HASH_KEY = 'siteRulesRemoteHash';

// djb2 — cheap content fingerprint, fallback when the server rotates ETags
// (CDN) or omits them, so a 200 with identical content doesn't force a reload.
function _hashText(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// Full reload pipeline — shared by the dashboard's RULES_CHANGED message and
// the revalidation alarm: drop caches, rebuild DNR rules, notify all tabs.
async function reloadRules() {
  await chrome.storage.local.set({
    [RULES_CACHE_TEXT_KEY]: '',
    [RULES_CACHE_TIME_KEY]: 0,
  });
  DEFAULT_RULES = [];
  MALWARE_RULES = [];
  _ruleConfigPromise = null;
  _parsedRules = null;
  await applyNetworkRules();
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'RULES_CHANGED' }).catch(() => {});
  }
}

async function revalidateRemoteRules() {
  try {
    const stored = await chrome.storage.local.get([RULES_REMOTE_ETAG_KEY, RULES_REMOTE_HASH_KEY]);
    const etag = stored[RULES_REMOTE_ETAG_KEY] || '';
    const res = await fetch(RULES_REMOTE_URL, {
      cache: 'no-store',
      headers: etag ? { 'If-None-Match': etag } : {},
    });
    if (res.status === 304) {
      // Unchanged — keep serving the cache and push its expiry out.
      await chrome.storage.local.set({ [RULES_CACHE_TIME_KEY]: Date.now() });
      return false;
    }
    if (!res.ok) return false;
    const text = await res.text();
    const newHash = _hashText(text);
    await chrome.storage.local.set({
      [RULES_REMOTE_ETAG_KEY]: res.headers.get('etag') || '',
      [RULES_REMOTE_HASH_KEY]: newHash,
    });
    if (newHash === (stored[RULES_REMOTE_HASH_KEY] || '')) {
      await chrome.storage.local.set({ [RULES_CACHE_TIME_KEY]: Date.now() });
      return false;
    }
    // Content actually changed — run the full pipeline (re-fetches ALL
    // sources incl. user ruleSources, rebuilds DNR, notifies tabs).
    await reloadRules();
    console.log('[AdBlock] Remote rules changed — reloaded');
    return true;
  } catch {
    return false; // offline etc. — cache TTL remains the safety net
  }
}

// A pattern that is a bare hostname can be matched via requestDomains, which is
// domain-indexed by the browser (much faster than urlFilter substring scan) and
// lets many domains share a single rule. Anything else (paths like
// "facebook.com/tr") stays as an individual urlFilter rule.
const DOMAIN_PATTERN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

// One invalid domain in requestDomains rejects the whole updateDynamicRules
// call, so every grouped domain must be validated first.
function buildPatternRules(patterns, startId, resourceTypes, priority) {
  const domains = [];
  const urlFilters = [];
  for (const p of patterns) {
    if (DOMAIN_PATTERN_RE.test(p)) domains.push(p.toLowerCase());
    else urlFilters.push(p);
  }
  const rules = [];
  let id = startId;
  if (domains.length) {
    rules.push({
      id: id++,
      priority,
      action: { type: 'block' },
      condition: { requestDomains: domains, resourceTypes },
    });
  }
  for (const f of urlFilters) {
    rules.push({
      id: id++,
      priority,
      action: { type: 'block' },
      condition: { urlFilter: f, resourceTypes },
    });
  }
  return rules;
}

function buildDefaultRulesFromConfig(config) {
  const adTypes = ['script', 'image', 'xmlhttprequest', 'sub_frame'];
  const trackerTypes = ['script', 'image', 'xmlhttprequest', 'ping'];
  const adRules = buildPatternRules(config.adNetworkPatterns, 1, adTypes, 1);
  const trackerRules = buildPatternRules(config.trackerNetworkPatterns, adRules.length + 1, trackerTypes, 1);
  return { adRules, trackerRules };
}

function buildMalwareRulesFromConfig(config, startId) {
  const malwareTypes = ['main_frame', 'sub_frame', 'script', 'xmlhttprequest', 'image'];
  const domains = config.malwareNetworkDomains.filter(d => DOMAIN_PATTERN_RE.test(d));
  if (!domains.length) return [];
  return [{
    id: startId,
    priority: 2,
    action: { type: 'block' },
    condition: { requestDomains: domains.map(d => d.toLowerCase()), resourceTypes: malwareTypes },
  }];
}

// Single source for the merged rules text (fresh cache → remote → cached/local
// fallback). Used by rule-definition loading, GET_RULES_TEXT, and GET_SITE_CONFIG.
async function getRulesText() {
  const cached = await getCachedRuleText();
  if (isFreshRuleCache(cached)) return cached.text;
  try {
    return await fetchRemoteRuleText();
  } catch {
    // Fallback: use cached/local rules, but still append customRulesText
    const baseText = (cached && cached.text) || await fetchLocalRuleText();
    const { customRulesText: customText = '' } = await chrome.storage.local.get('customRulesText');
    const text = customText ? baseText + '\n' + customText : baseText;
    if (text) await setCachedRuleText(text);
    return text;
  }
}

// Parsed rules cached in the service worker so the text is parsed ONCE here
// instead of by every content-script frame. Reset on RULES_CHANGED.
let _parsedRules = null;
let _parsedRulesPromise = null;

async function getParsedRules() {
  if (_parsedRules) return _parsedRules;
  if (!_parsedRulesPromise) {
    _parsedRulesPromise = getRulesText()
      .then(text => {
        _parsedRules = parseRuleText(text);
        return _parsedRules;
      })
      .finally(() => { _parsedRulesPromise = null; });
  }
  return _parsedRulesPromise;
}

// Resolve hostname against the dynamic [host_patterns] section.
// "vnexpress.net" also matches *.vnexpress.net; "amazon.*" matches any TLD.
// _hostPatternMatches — one [host_patterns] left-hand side vs a hostname.
// Supported forms:
//   vnexpress.net                  — host + subdomains
//   amazon.*                       — wildcard TLD (amazon.com, amazon.co.uk, ...)
//   a.com | b.net | c.*            — several patterns sharing one key
//   /(^|\.)fmovies[a-z0-9-]*\./    — raw regex tested against the hostname;
//                                    '|' inside is regex alternation. Do not
//                                    use '=' inside (the line parser splits on
//                                    the first '='). Keys are lowercased.
function _hostPatternMatches(pat, host) {
  pat = pat.trim();
  // Raw regex form: /body/flags — the whole LHS, never split on '|'
  if (pat.charAt(0) === '/') {
    const last = pat.lastIndexOf('/');
    if (last > 0) {
      try { return new RegExp(pat.slice(1, last), pat.slice(last + 1)).test(host); }
      catch { /* bad regex — no match */ }
    }
    return false;
  }
  for (let sub of pat.split('|')) {
    sub = sub.trim();
    if (!sub) continue;
    try {
      let re;
      if (sub.slice(-2) === '.*') {
        const base = sub.slice(0, -2).replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        re = new RegExp('(^|\\.)' + base + '\\.');
      } else {
        const escaped = sub.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        re = new RegExp('(^|\\.)' + escaped + '$');
      }
      if (re.test(host)) return true;
    } catch { /* bad pattern — skip */ }
  }
  return false;
}

function resolveSiteKey(patterns, host) {
  for (const pat in patterns) {
    if (!Object.prototype.hasOwnProperty.call(patterns, pat)) continue;
    const targetKey = (patterns[pat] && patterns[pat][0]) || '';
    if (!targetKey) continue;
    if (_hostPatternMatches(pat, host)) return targetKey;
  }
  return '';
}

async function ensureRuleDefinitionsLoaded() {
  if (DEFAULT_RULES.length && MALWARE_RULES.length) return;
  if (!_ruleConfigPromise) {
    _ruleConfigPromise = (async () => {
      const parsed = await getParsedRules();
      const global = parsed.global || {};
      const config = {
        adNetworkPatterns: global.ad_network_patterns?.length ? global.ad_network_patterns : FALLBACK_RULE_CONFIG.adNetworkPatterns,
        trackerNetworkPatterns: global.tracker_network_patterns?.length ? global.tracker_network_patterns : FALLBACK_RULE_CONFIG.trackerNetworkPatterns,
        malwareNetworkDomains: global.malware_network_domains?.length ? global.malware_network_domains : FALLBACK_RULE_CONFIG.malwareNetworkDomains,
        adPatterns: global.ad_patterns?.length ? global.ad_patterns : FALLBACK_RULE_CONFIG.adPatterns,
        trackerPatterns: global.tracker_patterns?.length ? global.tracker_patterns : FALLBACK_RULE_CONFIG.trackerPatterns,
        malwarePatterns: global.malware_patterns?.length ? global.malware_patterns : FALLBACK_RULE_CONFIG.malwarePatterns,
      };
      const { adRules, trackerRules } = buildDefaultRulesFromConfig(config);
      DEFAULT_RULES = [...adRules, ...trackerRules];
      MALWARE_RULES = buildMalwareRulesFromConfig(config, DEFAULT_RULES.length +1);
      TRACKER_RULE_IDS = new Set(trackerRules.map(rule => rule.id));
      MALWARE_RULE_IDS = new Set(MALWARE_RULES.map(rule => rule.id));
      AD_KEYWORDS.splice(0, AD_KEYWORDS.length, ...config.adPatterns);
      TRACKER_KEYWORDS.splice(0, TRACKER_KEYWORDS.length, ...config.trackerPatterns);
      MALWARE_KEYWORDS.splice(0, MALWARE_KEYWORDS.length, ...config.malwarePatterns);
    })().finally(() => {
      _ruleConfigPromise = null;
    });
  }
  await _ruleConfigPromise;
}

const MALWARE_RULE_ID_START = 100;
const MALWARE_RULE_ID_END   = 199;
const FOCUS_RULE_ID_START   = 2000;
const REMOTE_MALWARE_RULE_ID_START = 100000; // for fetched blocklists
const CUSTOM_RULE_ID_START = 200000;         // for user-created rules
const PAUSE_ALLOW_RULE_ID_START = 300000;    // for pause/allowlist allow-all rules

// Remote blocklist domains are grouped into a few requestDomains rules instead
// of one rule per domain, so the dynamic-rule quota is no longer the constraint.
const REMOTE_MAX_DOMAINS = 25000;
const REMOTE_DOMAINS_PER_RULE = 1000;

function buildRemoteMalwareRules(domains) {
  const rules = [];
  for (let i = 0; i < domains.length; i += REMOTE_DOMAINS_PER_RULE) {
    rules.push({
      id: REMOTE_MALWARE_RULE_ID_START + rules.length,
      priority: 2,
      action: { type: 'block' },
      condition: {
        requestDomains: domains.slice(i, i + REMOTE_DOMAINS_PER_RULE),
        // Exclude sub_frame to avoid blocking embedded video players (iframes)
        resourceTypes: ['main_frame', 'script', 'xmlhttprequest', 'image'],
      },
    });
  }
  return rules;
}

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
  await maybeUpdateMalwareLists();
});

chrome.runtime.onStartup.addListener(() => {
  applyNetworkRules();
  applyPrivacySettings();
  maybeUpdateMalwareLists();
  // Cheap ETag check (304 when unchanged) — picks up urgent rules fixes
  // published while the browser was closed, instead of waiting out the TTL.
  revalidateRemoteRules();
});

let activeStatsRules = [];
let statsRulesInitialized = false;

async function buildActiveRulesFromStorage() {
  await ensureRuleDefinitionsLoaded();
  const {
    enabled, pausedDomains = [], allowedDomains = [], focusMode = false,
    blockAds = true, blockTrackers = true, blockMalware = true,
  } = await chrome.storage.local.get(
    ['enabled', 'pausedDomains', 'allowedDomains', 'focusMode', 'blockAds', 'blockTrackers', 'blockMalware']
  );

  if (!enabled) return { enabled: false, allRules: [] };

  const AD_RULE_IDS = new Set(DEFAULT_RULES.filter(r => !TRACKER_RULE_IDS.has(r.id)).map(r => r.id));
  const filteredDefaultRules = DEFAULT_RULES.filter(r => {
    if (AD_RULE_IDS.has(r.id) && !blockAds) return false;
    if (TRACKER_RULE_IDS.has(r.id) && !blockTrackers) return false;
    return true;
  });

  const activeRules = [...filteredDefaultRules];
  const malwareActive = blockMalware ? [...MALWARE_RULES] : [];
  const { remoteMalwareDomains, remoteMalwareRules = [] } = await chrome.storage.local.get(
    ['remoteMalwareDomains', 'remoteMalwareRules']
  );
  // Migration: older versions stored full rule objects (one per domain).
  // Flatten them back to a domain list until the next blocklist refresh
  // rewrites storage in the new format.
  const remoteDomains = remoteMalwareDomains
    || remoteMalwareRules.flatMap(r => r.condition?.requestDomains || []);
  const remoteActive = blockMalware ? buildRemoteMalwareRules(remoteDomains) : [];
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

// ── Serialized stats writer ─────────────────────────────────────
// All reads-then-writes on 'stats'/'dailyStats' go through this chain
// to prevent concurrent reads returning stale data and overwriting each other.
let _statsWriteChain = Promise.resolve();

function _enqueueStatWrite(fn) {
  _statsWriteChain = _statsWriteChain
    .then(fn)
    .catch(e => console.warn('[AdBlock] stat write error:', e));
}

async function _writeDomainStatDelta(domain, delta) {
  const { stats = {} } = await chrome.storage.local.get('stats');
  if (!stats[domain]) {
    stats[domain] = { blocked: 0, adsBlocked: 0, trackersBlocked: 0, malwareBlocked: 0, totalSeen: 0, bandwidth: 0, timeSaved: 0, speedGain: 0 };
  }
  const s = stats[domain];
  s.totalSeen       += delta.totalSeen       || 0;
  s.adsBlocked      += delta.adsBlocked      || 0;
  s.trackersBlocked += delta.trackersBlocked || 0;
  s.malwareBlocked  += delta.malwareBlocked  || 0;
  s.blocked = s.adsBlocked + s.trackersBlocked + s.malwareBlocked;
  recalcDerived(s);
  // Cap per-domain stats to 200 domains
  const domainKeys = Object.keys(stats).filter(k => k !== '_global');
  if (domainKeys.length > 200) {
    domainKeys.sort((a, b) => (stats[a].totalSeen || 0) - (stats[b].totalSeen || 0));
    for (const k of domainKeys.slice(0, domainKeys.length - 200)) delete stats[k];
  }
  await chrome.storage.local.set({ stats });
}

async function _writeDailyStatDelta(delta) {
  const key = todayKey();
  const { dailyStats = {} } = await chrome.storage.local.get('dailyStats');
  if (!dailyStats[key]) dailyStats[key] = { blocked: 0, ads: 0, trackers: 0, malware: 0 };
  dailyStats[key].blocked  += delta.blocked  || 0;
  dailyStats[key].ads      += delta.ads      || 0;
  dailyStats[key].trackers += delta.trackers || 0;
  dailyStats[key].malware  += delta.malware  || 0;
  const keys = Object.keys(dailyStats).sort();
  while (keys.length > 30) { delete dailyStats[keys.shift()]; }
  await chrome.storage.local.set({ dailyStats });
}

function updateDailyStats(delta) {
  _enqueueStatWrite(() => _writeDailyStatDelta(delta));
}

function recalcDerived(s) {
  s.timeSaved  = Math.round(s.blocked * 0.3);
  s.bandwidth  = (s.adsBlocked * AVG_AD_BYTES) + (s.trackersBlocked * AVG_TRACKER_BYTES);
  s.speedGain  = s.totalSeen > 0 ? Math.round((s.blocked / s.totalSeen) * 100) : 0;
}

const AD_KEYWORDS = FALLBACK_RULE_CONFIG.adPatterns.slice();

const TRACKER_KEYWORDS = FALLBACK_RULE_CONFIG.trackerPatterns.slice();

const MALWARE_KEYWORDS = FALLBACK_RULE_CONFIG.malwarePatterns.slice();

// ── Remote malware blocklist updater ──────────────────────────────
// Fetches community blocklists every 24 hours (or on install)
const BLOCKLIST_SOURCES = [
  // URLhaus: live malware URL/domain feed (abuse.ch research project)
  { url: 'https://urlhaus.abuse.ch/downloads/hostfile/', name: 'URLhaus' },
  // Phishing Army: aggregated phishing domains
  { url: 'https://phishing.army/download/phishing_army_blocklist.txt', name: 'Phishing Army' },
];

async function fetchMalwareBlocklists() {
  const allDomains = new Set();
  for (const source of BLOCKLIST_SOURCES) {
    try {
      const resp = await fetch(source.url, { cache: 'no-cache' });
      if (!resp.ok) continue;
      const text = await resp.text();
      const lines = text.split('\n');
      for (const line of lines) {
        if (allDomains.size >= REMOTE_MAX_DOMAINS) break;
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
        // Hosts file format: "127.0.0.1 domain" or "0.0.0.0 domain" or just "domain"
        let domain = trimmed;
        if (domain.startsWith('127.0.0.1') || domain.startsWith('0.0.0.0')) {
          domain = domain.split(/\s+/)[1];
        }
        if (!domain || domain === 'localhost') continue;
        domain = domain.toLowerCase();
        if (!DOMAIN_PATTERN_RE.test(domain)) continue;
        allDomains.add(domain);
      }
    } catch (e) {
      console.warn(`[AdBlock] Failed to fetch ${source.name}:`, e.message);
    }
  }

  const domains = Array.from(allDomains);

  // Store only the domain list — rules are rebuilt on apply. Storing rule
  // objects (~150 bytes each as JSON) wasted storage; the old per-rule key
  // is removed on first update after migration.
  await chrome.storage.local.set({
    remoteMalwareDomains: domains,
    malwareListLastUpdate: Date.now(),
    malwareListCount: domains.length,
  });
  await chrome.storage.local.remove('remoteMalwareRules');

  // Re-apply all network rules
  await applyNetworkRules();

  console.log(`[AdBlock] Malware blocklist updated: ${domains.length} domains from remote sources`);
  return domains.length;
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
chrome.alarms?.create(RULES_REVALIDATE_ALARM, { periodInMinutes: RULES_REVALIDATE_PERIOD_MIN });
chrome.alarms?.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'malware-list-update') {
    await fetchMalwareBlocklists();
  }
  if (alarm.name === RULES_REVALIDATE_ALARM) {
    await revalidateRemoteRules();
  }
  if (alarm.name === 'focus-end') {
    // Auto-disable focus mode when timer expires
    await chrome.storage.local.set({ focusMode: false, focusEndTime: null });
    await applyNetworkRules();
  }
});

// ── Privacy: Referrer anonymization ───────────────────────────────
// Uses declarativeNetRequest to strip cross-origin Referer to origin only.
const REFERRER_RULE_ID = 400000;

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
        // Invalidate caches, re-fetch all sources, rebuild DNR rules and
        // notify every tab — shared with the revalidation alarm.
        await reloadRules();
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

        const domain = msg.domain || '_global';
        const d = msg.delta || {};
        _enqueueStatWrite(() => _writeDomainStatDelta(domain, {
          totalSeen:       d.seen     || 0,
          adsBlocked:      d.ads      || 0,
          trackersBlocked: d.trackers || 0,
          malwareBlocked:  d.malware  || 0,
        }));
        updateDailyStats({
          blocked:  (d.ads || 0) + (d.trackers || 0) + (d.malware || 0),
          ads:      d.ads      || 0,
          trackers: d.trackers || 0,
          malware:  d.malware  || 0,
        });
        sendResponse({ ok: true });
        break;
      }

      case 'COSMETIC_HIDDEN': {
        // Sent by content.js / site-block.js when cosmetic filtering hides ad elements.
        const { collectStats: collectCH = true } = await chrome.storage.local.get('collectStats');
        if (!collectCH) { sendResponse({ ok: true }); break; }

        const chDomain = (msg.url ? new URL(msg.url).hostname : null) || '_global';
        const hiddenCount = msg.count || 0;
        _enqueueStatWrite(() => _writeDomainStatDelta(chDomain, { adsBlocked: hiddenCount, totalSeen: hiddenCount }));
        updateDailyStats({ blocked: hiddenCount, ads: hiddenCount, trackers: 0, malware: 0 });
        sendResponse({ ok: true });
        break;
      }

      case 'AD_BLOCKED':
      case 'AD_SKIPPED': {
        // Sent by content.js as a bridge for MAIN-world yt-adblock.js when an ad
        // is stripped before render or when a visible video ad is skipped.
        const { collectStats: collectAS = true } = await chrome.storage.local.get('collectStats');
        if (!collectAS) { sendResponse({ ok: true }); break; }

        const asDomain = msg.domain || '_global';
        const asDelta = Math.max(1, Number(msg.count || 1));
        _enqueueStatWrite(() => _writeDomainStatDelta(asDomain, { adsBlocked: asDelta, totalSeen: asDelta }));
        updateDailyStats({ blocked: asDelta, ads: asDelta, trackers: 0, malware: 0 });
        sendResponse({ ok: true });
        break;
      }

      case 'GET_CLASSIFIER_LISTS': {
        await ensureRuleDefinitionsLoaded();
        // Derive classifier patterns directly from actual DNR rule definitions.
        // content.js uses these to classify observed DOM resources for stats.
        // Patterns live either in a grouped requestDomains rule or in
        // individual urlFilter rules.
        const adPatterns = [];
        const trackerPatterns = [];
        for (const r of DEFAULT_RULES) {
          const bucket = TRACKER_RULE_IDS.has(r.id) ? trackerPatterns : adPatterns;
          if (r.condition.urlFilter) bucket.push(r.condition.urlFilter);
          if (r.condition.requestDomains) bucket.push(...r.condition.requestDomains);
        }

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

      case 'GET_RULES_TEXT': {
        // Legacy/fallback: full merged rules text. Content scripts normally use
        // GET_SITE_CONFIG which sends only the relevant parsed sections.
        try {
          sendResponse({ text: await getRulesText() });
        } catch {
          sendResponse({ text: '' });
        }
        break;
      }

      case 'GET_SITE_CONFIG': {
        // Sends a frame only what it needs: [global] + its resolved site section
        // (a few KB), instead of the full rules text that every frame previously
        // fetched and re-parsed independently.
        try {
          const parsed = await getParsedRules();
          const host = String(msg.host || '').toLowerCase();
          const siteKey = resolveSiteKey(parsed.host_patterns || {}, host);
          sendResponse({
            siteKey,
            global: parsed.global || {},
            site: (siteKey && parsed[siteKey]) || {},
          });
        } catch {
          sendResponse(null);
        }
        break;
      }

      case 'GET_MALWARE_STATUS': {
        await ensureRuleDefinitionsLoaded();
        const { malwareListLastUpdate = 0, malwareListCount = 0 } = await chrome.storage.local.get(['malwareListLastUpdate', 'malwareListCount']);
        // MALWARE_RULES is now a single grouped rule — count its domains, not rules.
        const builtinMalwareCount = MALWARE_RULES.reduce(
          (n, r) => n + (r.condition.requestDomains?.length || 0), 0
        );
        sendResponse({ lastUpdate: malwareListLastUpdate, count: malwareListCount + builtinMalwareCount });
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
    chrome.action.setBadgeText({ text: '⏸', tabId }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b', tabId }).catch(() => {});
  } else {
    chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: [0, 0, 0, 0], tabId }).catch(() => {});
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
