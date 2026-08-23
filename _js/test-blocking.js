// Harness: run the real background.js in Node with stubbed chrome APIs,
// build DNR rules from the real rule/site-rules.txt, then verify
// tracker/malware blocking + stats counting behavior.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = require("path").join(__dirname, "..");
const rulesText = fs.readFileSync(path.join(ROOT, 'rule/site-rules.txt'), 'utf8');
const configSrc = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
const scriptletAliasMapSrc = fs.readFileSync(path.join(ROOT, 'scriptlet-alias-map.js'), 'utf8');
const bgSrc = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');

// ── chrome stub ───────────────────────────────────────────────────
const storageData = {};
let dynamicRules = [];
let updateDynamicRulesCallCount = 0;
const messageListeners = [];
const noopEvent = { addListener() {} };
const tabsData = new Map();
const removedTabIds = new Set();
const tabsCreatedListeners = [];
const tabsUpdatedListeners = [];
const storageChangeListeners = [];
let lastBadgeText;
const badgeTextByTab = new Map(); // tabId -> last text set FOR that tabId specifically

function _ipcDelay() { return new Promise(r => setTimeout(r, 2)); }

function validateDomain(d) {
  // Chrome requires canonicalized lowercase ASCII domains in requestDomains
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(d);
}

const sessionStorageData = {};
const chromeStub = {
  storage: {
    local: {
      async get(keys) {
        if (keys == null) return { ...storageData };
        const arr = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const out = {};
        for (const k of arr) if (k in storageData) out[k] = storageData[k];
        return out;
      },
      async set(obj) {
        const changes = {};
        for (const k of Object.keys(obj)) changes[k] = { oldValue: storageData[k], newValue: obj[k] };
        Object.assign(storageData, obj);
        for (const fn of storageChangeListeners) fn(changes, 'local');
      },
      async clear() { for (const k of Object.keys(storageData)) delete storageData[k]; },
    },
    // Separate backing object from `local` — chrome.storage.session is a
    // genuinely distinct store (in-memory, cleared on browser restart), used
    // by the "Proceed" button's non-permanent bypass (buildActiveRulesFromStorage's
    // sessionAllowedDomains / the PROCEED_BLOCKED_HOST handler in background.js).
    session: {
      async get(keys) {
        if (keys == null) return { ...sessionStorageData };
        const arr = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const out = {};
        for (const k of arr) if (k in sessionStorageData) out[k] = sessionStorageData[k];
        return out;
      },
      async set(obj) {
        // Real chrome.storage.session fires chrome.storage.onChanged with
        // areaName 'session' too (since Chrome 102) — background.js's
        // _sessionAllowedDomainsHash listener (Phase 1a fingerprint) relies
        // on that to invalidate the pauseAllowRules memo (Phase 2c), so the
        // stub must fire it here just like `local`'s set() does above.
        const changes = {};
        for (const k of Object.keys(obj)) changes[k] = { oldValue: sessionStorageData[k], newValue: obj[k] };
        Object.assign(sessionStorageData, obj);
        for (const fn of storageChangeListeners) fn(changes, 'session');
      },
      async clear() { for (const k of Object.keys(sessionStorageData)) delete sessionStorageData[k]; },
    },
    onChanged: { addListener(fn) { storageChangeListeners.push(fn); } },
  },
  declarativeNetRequest: {
    // Real chrome.declarativeNetRequest.* calls are cross-process IPC round
    // trips with genuine (variable) latency — a same-process microtask stub
    // with no delay at all happens to serialize concurrent calls "for free"
    // in Node's scheduler, which would hide the applyNetworkRules() race
    // (see test 2b below). This tiny setTimeout makes the stub behave like
    // the real IPC boundary closely enough for that race to actually
    // reproduce here when it's not properly serialized.
    async getDynamicRules() { await _ipcDelay(); return dynamicRules.slice(); },
    async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
      updateDynamicRulesCallCount++;
      await _ipcDelay();
      const removeSet = new Set(removeRuleIds);
      dynamicRules = dynamicRules.filter(r => !removeSet.has(r.id));
      // Validate like Chrome would (whole call rejects on any invalid rule)
      const seen = new Set(dynamicRules.map(r => r.id));
      for (const r of addRules) {
        if (!Number.isInteger(r.id) || r.id < 1) throw new Error(`Rule id invalid: ${r.id}`);
        if (seen.has(r.id)) throw new Error(`Duplicate rule id: ${r.id}`);
        seen.add(r.id);
        const c = r.condition || {};
        if (c.requestDomains) {
          for (const d of c.requestDomains) {
            if (!validateDomain(d)) throw new Error(`Rule ${r.id}: invalid requestDomain "${d}"`);
          }
        }
        if (c.urlFilter && /[^\x00-\x7F]/.test(c.urlFilter)) {
          throw new Error(`Rule ${r.id}: non-ascii urlFilter "${c.urlFilter}"`);
        }
        if (c.regexFilter) { new RegExp(c.regexFilter); }
        if (r.action?.redirect?.regexSubstitution && !c.regexFilter) {
          throw new Error(`Rule ${r.id}: regexSubstitution requires regexFilter`);
        }
      }
      if (seen.size > 30000) throw new Error(`Dynamic rule limit exceeded: ${seen.size}`);
      dynamicRules.push(...addRules.map(r => JSON.parse(JSON.stringify(r))));
    },
  },
  i18n: {
    // Mutable so tests can simulate different browser UI languages for
    // _autoEnableLangDefaultSources()'s language-match check.
    getUILanguage: () => stubUILanguage,
  },
  runtime: {
    getURL: p => 'chrome-extension://test/' + p,
    getManifest: () => ({ version: '1.0.35' }),
    onInstalled: noopEvent,
    onStartup: noopEvent,
    onMessage: { addListener(fn) { messageListeners.push(fn); } },
  },
  alarms: { create() {}, clear() {}, onAlarm: noopEvent },
  tabs: {
    async query() { return []; },
    async get(tabId) {
      if (!tabsData.has(tabId)) throw new Error('No tab with id: ' + tabId);
      return { id: tabId, ...tabsData.get(tabId) };
    },
    async remove(tabId) { removedTabIds.add(tabId); },
    sendMessage: async () => {},
    onActivated: noopEvent,
    onUpdated: { addListener(fn) { tabsUpdatedListeners.push(fn); } },
    onRemoved: noopEvent,
    onCreated: { addListener(fn) { tabsCreatedListeners.push(fn); } },
  },
  scripting: {
    insertCSS: async () => {},
    removeCSS: async () => {},
  },
  action: {
    setIcon() {},
    setBadgeText(o) {
      if (o && o.tabId !== undefined) badgeTextByTab.set(o.tabId, o.text);
      else lastBadgeText = o && o.text;
      return Promise.resolve();
    },
    setBadgeBackgroundColor() { return Promise.resolve(); },
  },
};

// fetch stub: serve the real local rules file for both remote + local URLs
// Mutable so tests can simulate "update available" / "offline" / "no
// update" scenarios against checkForExtensionUpdate() without needing a
// real network call.
let stubRemoteManifestVersion = '1.0.0'; // default: below any real local version
let stubRemoteManifestVersionFirefox = '1.0.0'; // independent — the two manifests CAN diverge
let stubRemoteManifestUnreachable = false;
// Only the REMOTE site-rules.txt fetch (RULES_REMOTE_URL) — the local
// bundled copy fetched via chrome.runtime.getURL() shares the same
// "site-rules.txt" suffix but a different origin, so it's unaffected.
let stubRulesRemoteUnreachable = false;
// Raw ABP/uBO-format text served for a fetchRemoteRuleText() end-to-end test —
// mutable so a test can set it right before triggering a fetch.
let stubAbpSourceText = '';
// Simulated browser UI language for _autoEnableLangDefaultSources() tests.
let stubUILanguage = 'en-US';
// _isFirefoxInstall() (background.js) checks navigator.userAgent — same
// technique popup.js/dashboard.js already use for this kind of "pick a URL
// for the current browser" decision. Simulated here by swapping
// sandbox.navigator.userAgent directly (see section 24a below), not via a
// separate flag.
async function fetchStub(url) {
  const u = String(url);
  if (u.includes('site-rules.txt')) {
    if (stubRulesRemoteUnreachable && u.startsWith('https://raw.githubusercontent.com')) {
      throw new Error('network error (simulated)');
    }
    return { ok: true, status: 200, headers: { get: () => '' }, text: async () => rulesText };
  }
  if (u.includes('manifest.firefox.json')) {
    if (stubRemoteManifestUnreachable) throw new Error('network error (simulated)');
    return { ok: true, status: 200, headers: { get: () => '' }, json: async () => ({ version: stubRemoteManifestVersionFirefox }) };
  }
  if (u.includes('manifest.json')) {
    if (stubRemoteManifestUnreachable) throw new Error('network error (simulated)');
    return { ok: true, status: 200, headers: { get: () => '' }, json: async () => ({ version: stubRemoteManifestVersion }) };
  }
  if (u.includes('abp-test-source.txt')) {
    return { ok: true, status: 200, headers: { get: () => '' }, text: async () => stubAbpSourceText };
  }
  // Second built-in default source (config.js's RULES_REMOTE_URL, region
  // list) — always succeeds with empty text so it stays a no-op bystander
  // in every section below, unless a test overrides it deliberately.
  if (u.includes('abpvn')) {
    return { ok: true, status: 200, headers: { get: () => '' }, text: async () => '' };
  }
  return { ok: false, status: 404, headers: { get: () => '' }, text: async () => '' };
}

// ── load background.js in sandbox ─────────────────────────────────
const sandbox = {
  console, chrome: chromeStub, fetch: fetchStub,
  setTimeout, clearTimeout, setInterval, clearInterval,
  URL, Date, Math, JSON, Promise, RegExp, Set, Map, Number, String, Object, Array, Error,
  // Compressed rule-cache storage (2026-08-24) needs these Web APIs — all
  // available as real Node globals (v18+), same semantics as in a browser.
  CompressionStream, DecompressionStream, Response, TextEncoder, TextDecoder, btoa, atob, Uint8Array,
  navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' },
  importScripts(name) {
    if (name && name.includes('scriptlet-alias-map')) {
      vm.runInContext(scriptletAliasMapSrc, ctx, { filename: 'scriptlet-alias-map.js' });
    } else {
      vm.runInContext(configSrc, ctx, { filename: 'config.js' });
    }
  },
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);

const exportSnippet = `
self.__test = {
  ensureRuleDefinitionsLoaded, buildActiveRulesFromStorage, applyNetworkRules, reloadRules,
  _dedupeMalwarePriority,
  parseRuleText, buildRemoteMalwareRules, updateIcon, _incrementTabBlocked, _setTabBadge,
  getParsedRules, resolveSiteKey,
  getCachedRuleText, setCachedRuleText, _compressForStorage, _decompressFromStorage,
  _looksLikeAbpFormat, _maybeConvertAbpText, fetchRemoteRuleText,
  _abpEmptySkipStats, _fetchAndConvertUrls, RULE_SOURCE_STATS_KEY,
  _uiLanguageMatches, _autoEnableLangDefaultSources,
  buildNetworkRedirectRules, _resolveRedirectResourceName, NETWORK_REDIRECT_RULE_ID_START,
  _isValidUrlFilter, buildQueryStripRules,
  RULE_SOURCE_ERRORS_KEY,
  _buildElementRulesBlock, _applyElementRules,
  _buildNoWindowOpenRulesBlock, _applyNoWindowOpenRules,
  _buildGlobalRulesBlock, _applyGlobalRules,
  _buildSiteRuleTextBlock, _applySiteRuleText,
  _isNewerVersion, checkForExtensionUpdate, maybeCheckForExtensionUpdate,
  get DEFAULT_RULES() { return DEFAULT_RULES; },
  get MALWARE_RULES() { return MALWARE_RULES; },
  get AD_MAINFRAME_RULES() { return AD_MAINFRAME_RULES; },
  get TRACKER_RULE_IDS() { return TRACKER_RULE_IDS; },
  get MALWARE_RULE_IDS() { return MALWARE_RULE_IDS; },
  get statsChain() { return _statsWriteChain; },
  get tabBlockedCounts() { return _tabBlockedCounts; },
};`;
vm.runInContext(bgSrc + '\n' + exportSnippet, ctx, { filename: 'background.js' });
const T = sandbox.__test;

// ── DNR match simulator ───────────────────────────────────────────
function hostMatchesDomain(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}
function ruleMatches(rule, url, type) {
  const c = rule.condition;
  if (c.resourceTypes && !c.resourceTypes.includes(type)) return false;
  const host = new URL(url).hostname.toLowerCase();
  if (c.requestDomains && !c.requestDomains.some(d => hostMatchesDomain(host, d))) return false;
  if (c.urlFilter) {
    // plain substring filters only (no ||, ^, * used in this codebase)
    return url.toLowerCase().includes(c.urlFilter.toLowerCase());
  }
  if (c.regexFilter) return new RegExp(c.regexFilter).test(url);
  return !!c.requestDomains;
}
function wouldBlock(rules, url, type) {
  const matches = rules.filter(r => ruleMatches(r, url, type));
  if (!matches.length) return { blocked: false };
  matches.sort((a, b) => (b.priority || 1) - (a.priority || 1));
  const top = matches[0];
  let redirectTo = null;
  if (top.action.type === 'redirect' && top.action.redirect?.regexSubstitution) {
    const m = url.match(new RegExp(top.condition.regexFilter));
    redirectTo = top.action.redirect.regexSubstitution
      .replace(/\\(\d)/g, (_, n) => (n === '0' ? m[0] : m[Number(n)] || ''));
  }
  // A main_frame redirect to the extension warning page = navigation intercepted
  const intercepted = top.action.type === 'block' ||
    (redirectTo && redirectTo.startsWith('chrome-extension://'));
  return { blocked: !!intercepted, by: top.id, action: top.action.type, redirectTo };
}

// ── content.js classifyUrl replica (mirrors new hostname-anchored logic) ──
function makeClassifier(globalCfg) {
  const norm = l => (l || []).map(p => String(p).toLowerCase().trim()).filter(Boolean);
  const ad = norm(globalCfg.ad_network_patterns);
  const tr = norm(globalCfg.tracker_network_patterns);
  const mw = norm(globalCfg.malware_network_domains);
  const matches = (p, full, host) => {
    if (p.includes('/')) return full.includes(p);
    if (p.includes('.')) return host === p || host.endsWith('.' + p);
    return full.includes(p);
  };
  return url => {
    let host, full;
    try { const u = new URL(url); host = u.hostname.toLowerCase(); full = u.href.toLowerCase(); }
    catch { return null; }
    if (mw.some(p => matches(p, full, host))) return 'malware';
    if (tr.some(p => matches(p, full, host))) return 'tracker';
    if (ad.some(p => matches(p, full, host))) return 'ad';
    return null;
  };
}

// ── tests ─────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
  // Simulate installed state: enabled, all toggles default (true), some remote domains
  Object.assign(storageData, {
    enabled: true,
    remoteMalwareDomains: ['evil-remote-domain.com', 'phish-remote.net'],
  });

  console.log('\n== 0. Concurrent applyNetworkRules() calls at fresh-install time don\'t race ==');
  // Regression test for "Rule with id N does not have a unique ID." — real
  // trigger: onInstalled/onStartup fires applyNetworkRules(),
  // maybeUpdateMalwareLists() (which can itself call applyNetworkRules()
  // via fetchMalwareBlocklists()), and revalidateRemoteRules() (ditto, via
  // reloadRules()) without awaiting each other. Each call does
  // getDynamicRules() then updateDynamicRules() as two separate IPC round
  // trips; unserialized, when dynamic rules are transitioning from empty to
  // the full set (e.g. first run), a second call's getDynamicRules()
  // snapshot can be taken before the first call's updateDynamicRules()
  // commits, so its removeRuleIds misses ids the first call just added and
  // its addRules tries to add those same ids again -> the collision. (Once
  // the rule set has stabilized, concurrent calls happen to cancel out
  // safely, which is why this must run against the fresh/empty state, not
  // after rules are already applied — see applyNetworkRules()'s serializing
  // queue in background.js for the fix.)
  let raceErr = null;
  try {
    await Promise.all([T.applyNetworkRules(), T.applyNetworkRules(), T.applyNetworkRules()]);
  } catch (e) { raceErr = e; }
  check('3 concurrent applyNetworkRules() calls from a fresh state do not throw', !raceErr, raceErr && raceErr.message);
  const idsAfterRace = dynamicRules.map(r => r.id);
  check('no duplicate rule ids after concurrent calls', new Set(idsAfterRace).size === idsAfterRace.length);

  console.log('\n== 1. Rule building from real rule/site-rules.txt ==');
  await T.ensureRuleDefinitionsLoaded();
  const parsed = T.parseRuleText(rulesText);
  const g = parsed.global || {};
  console.log(`  DEFAULT_RULES: ${T.DEFAULT_RULES.length} rules ` +
    `(tracker rule ids: ${[...T.TRACKER_RULE_IDS].join(',')})`);
  console.log(`  MALWARE_RULES: ${T.MALWARE_RULES.length} rule(s), ` +
    `${T.MALWARE_RULES.reduce((n, r) => n + r.condition.requestDomains.length, 0)} domains`);
  check('tracker rules built from config', T.TRACKER_RULE_IDS.size > 0);
  check('malware rules built from config', T.MALWARE_RULES.length > 0);
  check('config tracker list used (not fallback)',
    (g.tracker_network_patterns || []).length > 10);

  console.log('\n== 2. applyNetworkRules passes Chrome-like validation ==');
  let applyErr = null;
  try { await T.applyNetworkRules(); } catch (e) { applyErr = e; }
  check('updateDynamicRules accepted all rules', !applyErr, applyErr && applyErr.message);
  const ids = dynamicRules.map(r => r.id);
  check('no duplicate rule ids', new Set(ids).size === ids.length);
  console.log(`  active dynamic rules: ${dynamicRules.length}`);

  console.log('\n== 3. Tracker blocking (simulated requests) ==');
  const trackerCases = [
    ['https://www.google-analytics.com/analytics.js', 'script'],
    ['https://region1.google-analytics.com/g/collect?v=2', 'ping'],
    ['https://www.facebook.com/tr?id=123&ev=PageView', 'image'],
    ['https://static.hotjar.com/c/hotjar-123.js', 'script'],
    ['https://api.mixpanel.com/track/', 'xmlhttprequest'],
    ['https://cdn.mouseflow.com/projects/x.js', 'script'],
    ['https://www.clarity.ms/tag/abc', 'script'],
  ];
  for (const [url, type] of trackerCases) {
    const r = wouldBlock(dynamicRules, url, type);
    check(`blocks ${url} [${type}]`, r.blocked, JSON.stringify(r));
  }

  console.log('\n== 4. Malware blocking (simulated requests) ==');
  const malwareCases = [
    ['https://coinhive.com/lib/coinhive.min.js', 'script'],
    ['https://login-microsoft-office.com/', 'main_frame'],
    ['https://your-pc-is-infected.com/alert', 'main_frame'],
    ['https://cdn.jsecoin.com/miner.js', 'script'],
    ['https://evil-remote-domain.com/payload.js', 'script'],   // remote blocklist
    ['https://phish-remote.net/', 'main_frame'],               // remote blocklist
  ];
  for (const [url, type] of malwareCases) {
    const r = wouldBlock(dynamicRules, url, type);
    check(`blocks ${url} [${type}]`, r.blocked, JSON.stringify(r));
  }

  console.log('\n== 5. Legit traffic NOT blocked ==');
  const negativeCases = [
    ['https://example.com/app.js', 'script'],
    ['https://www.google.com/search?q=x', 'main_frame'],
    ['https://fonts.googleapis.com/css2?family=Inter', 'stylesheet'],
    ['https://www.youtube.com/watch?v=abc', 'main_frame'],
    ['https://analytics-docs.example.org/guide', 'main_frame'], // main_frame not a tracker type
  ];
  for (const [url, type] of negativeCases) {
    const r = wouldBlock(dynamicRules, url, type);
    check(`allows ${url} [${type}]`, !r.blocked, JSON.stringify(r));
  }

  console.log('\n== 6. Toggles: blockTrackers / blockMalware off removes rules ==');
  storageData.blockTrackers = false;
  storageData.blockMalware = false;
  await T.applyNetworkRules();
  const rOffT = wouldBlock(dynamicRules, 'https://www.google-analytics.com/analytics.js', 'script');
  const rOffM = wouldBlock(dynamicRules, 'https://coinhive.com/lib/coinhive.min.js', 'script');
  check('tracker not blocked when blockTrackers=false', !rOffT.blocked);
  check('malware not blocked when blockMalware=false', !rOffM.blocked);
  storageData.blockTrackers = true;
  storageData.blockMalware = true;
  await T.applyNetworkRules();
  check('re-enabled: tracker blocked again',
    wouldBlock(dynamicRules, 'https://www.google-analytics.com/x.js', 'script').blocked);

  console.log('\n== 7. Pause/allowlist override ==');
  // Uses chrome.storage.local.set() (not a direct storageData mutation) so
  // onChanged fires — background.js's pauseAllowRules build is memoized
  // (Phase 2c) keyed off the pausedDomains fingerprint, which only updates
  // via a real storage write, exactly like production.
  await chromeStub.storage.local.set({ pausedDomains: ['news.example.com'] });
  await T.applyNetworkRules();
  const allowRule = dynamicRules.find(r => r.action.type === 'allowAllRequests');
  check('allowAllRequests rule created for paused domain', !!allowRule);
  check('allow rule outranks block rules (priority 10 > 2)',
    allowRule && allowRule.priority > Math.max(...dynamicRules.filter(r => r.action.type === 'block').map(r => r.priority || 1)));
  await chromeStub.storage.local.set({ pausedDomains: [] });
  await T.applyNetworkRules();

  console.log('\n== 7a. "Proceed anyway" (blocked.html) — PROCEED_BLOCKED_HOST message handler (2026-08-23) ==');
  const send = (msg) => new Promise(res => messageListeners[0](msg, {}, res));

  // Non-permanent ("Don't warn me again" left unchecked): a session-only
  // bypass — chrome.storage.session, NOT the dashboard's permanent
  // Allowlist (chrome.storage.local's allowedDomains).
  const proceedTemp = await send({ type: 'PROCEED_BLOCKED_HOST', host: 'temp-bypass.example', permanent: false });
  check('PROCEED_BLOCKED_HOST (non-permanent): acks ok', proceedTemp && proceedTemp.ok === true, proceedTemp);
  const { sessionAllowedDomains: sadAfterTemp } = await chromeStub.storage.session.get('sessionAllowedDomains');
  check('PROCEED_BLOCKED_HOST (non-permanent): host added to chrome.storage.session',
    Array.isArray(sadAfterTemp) && sadAfterTemp.includes('temp-bypass.example'), sadAfterTemp);
  const { allowedDomains: adAfterTemp = [] } = await chromeStub.storage.local.get('allowedDomains');
  check('PROCEED_BLOCKED_HOST (non-permanent): does NOT touch the permanent allowedDomains list',
    !adAfterTemp.includes('temp-bypass.example'), adAfterTemp);
  await T.applyNetworkRules();
  const tempAllowRule = dynamicRules.find(r => r.action.type === 'allowAllRequests' && r.condition.requestDomains.includes('temp-bypass.example'));
  check('PROCEED_BLOCKED_HOST (non-permanent): applyNetworkRules() still builds an allowAllRequests rule for it (via sessionAllowedDomains)',
    !!tempAllowRule, tempAllowRule);

  // Permanent (checkbox checked): the SAME list/UI the dashboard's Allowlist
  // page already manages — no separate storage key or dashboard section needed.
  const proceedPermanent = await send({ type: 'PROCEED_BLOCKED_HOST', host: 'permanent-bypass.example', permanent: true });
  check('PROCEED_BLOCKED_HOST (permanent): acks ok', proceedPermanent && proceedPermanent.ok === true, proceedPermanent);
  const { allowedDomains: adAfterPermanent = [] } = await chromeStub.storage.local.get('allowedDomains');
  check('PROCEED_BLOCKED_HOST (permanent): host added to the permanent allowedDomains list',
    adAfterPermanent.includes('permanent-bypass.example'), adAfterPermanent);
  await T.applyNetworkRules();
  const permAllowRule = dynamicRules.find(r => r.action.type === 'allowAllRequests' && r.condition.requestDomains.includes('permanent-bypass.example'));
  check('PROCEED_BLOCKED_HOST (permanent): applyNetworkRules() builds an allowAllRequests rule for it',
    !!permAllowRule, permAllowRule);

  await send({ type: 'PROCEED_BLOCKED_HOST', host: 'permanent-bypass.example', permanent: true });
  const { allowedDomains: adAfterDup = [] } = await chromeStub.storage.local.get('allowedDomains');
  check('PROCEED_BLOCKED_HOST: proceeding twice for the same host does not duplicate the allowlist entry',
    adAfterDup.filter(d => d === 'permanent-bypass.example').length === 1, adAfterDup);

  const proceedNoHost = await send({ type: 'PROCEED_BLOCKED_HOST', host: '', permanent: true });
  check('PROCEED_BLOCKED_HOST: empty host is rejected (ok:false), not silently accepted',
    proceedNoHost && proceedNoHost.ok === false, proceedNoHost);

  await chromeStub.storage.local.set({ allowedDomains: [] });
  await chromeStub.storage.session.clear();
  await T.applyNetworkRules();

  console.log('\n== 8. Stats counting via RESOURCE_SEEN (popup/dashboard numbers) ==');
  const listener = messageListeners[0];
  await send({ type: 'RESOURCE_SEEN', domain: 'vnexpress.net',
    delta: { seen: 10, ads: 3, trackers: 4, malware: 1 } });
  await T.statsChain;
  const { stats } = await chromeStub.storage.local.get('stats');
  const s = stats && stats['vnexpress.net'];
  check('trackersBlocked counted', s && s.trackersBlocked === 4, JSON.stringify(s));
  check('malwareBlocked counted', s && s.malwareBlocked === 1);
  check('blocked = ads+trackers+malware', s && s.blocked === 8);
  const { dailyStats } = await chromeStub.storage.local.get('dailyStats');
  const today = dailyStats && Object.values(dailyStats)[0];
  check('dailyStats trackers/malware updated', today && today.trackers === 4 && today.malware === 1);

  console.log('\n== 8a. totalBlockedAllTime accumulates (review-prompt milestone counter) ==');
  const { totalBlockedAllTime: totalBefore = 0 } = await chromeStub.storage.local.get('totalBlockedAllTime');
  await send({ type: 'RESOURCE_SEEN', domain: 'vnexpress.net',
    delta: { seen: 5, ads: 2, trackers: 0, malware: 0 } });
  await T.statsChain;
  const { totalBlockedAllTime: totalAfter } = await chromeStub.storage.local.get('totalBlockedAllTime');
  check('totalBlockedAllTime increments by the new blocked delta', totalAfter === totalBefore + 2, `${totalBefore} -> ${totalAfter}`);

  console.log('\n== 9. Classifier (content.js) vs DNR consistency ==');
  const classify = makeClassifier(g);
  const consistencyCases = [
    'https://www.google-analytics.com/analytics.js',
    'https://static.hotjar.com/c/x.js',
    'https://coinhive.com/lib/coinhive.min.js',
    'https://www.facebook.com/tr?id=1',
  ];
  for (const url of consistencyCases) {
    const kind = classify(url);
    const dnr = wouldBlock(dynamicRules, url, 'script').blocked ||
                wouldBlock(dynamicRules, url, 'image').blocked;
    check(`classifier sees "${kind}" & DNR blocks: ${url}`, kind !== null && dnr);
  }
  // False-positive probes: hostname-anchored classifier must now ignore these
  const fpProbes = [
    'https://mesh.study.com/page.js',          // used to hit 'sh.st'
    'https://cdn.badf.ly.example.com/x.js',    // used to hit 'adf.ly'
    'https://usersegment.company.com/lib.js',  // used to hit 'segment.com'
    'https://mysegment.com.evil.example/x.js', // used to hit 'segment.com'
  ];
  for (const url of fpProbes) {
    const kind = classify(url);
    check(`no false positive: ${url}`, kind === null, `classified as ${kind}`);
  }
  // Subdomain of a real malware domain must still classify
  check('subdomain of malware domain still classified',
    classify('https://cdn.jsecoin.com/miner.js') === 'malware');

  console.log('\n== 10. main_frame malware → redirect to warning page (countable) ==');
  const nav = wouldBlock(dynamicRules, 'https://login-microsoft-office.com/login?a=1&b=2', 'main_frame');
  check('main_frame nav intercepted', nav.blocked, JSON.stringify(nav));
  check('redirects to blocked.html with host param',
    nav.redirectTo === 'chrome-extension://test/blocked/blocked.html?h=login-microsoft-office.com',
    nav.redirectTo);
  const navRemote = wouldBlock(dynamicRules, 'https://phish-remote.net/x', 'main_frame');
  check('remote-blocklist main_frame also redirected',
    navRemote.blocked && String(navRemote.redirectTo).includes('blocked.html?h=phish-remote.net'),
    JSON.stringify(navRemote));
  const subres = wouldBlock(dynamicRules, 'https://coinhive.com/lib/coinhive.min.js', 'script');
  check('malware subresource still plain-blocked', subres.blocked && subres.action === 'block');

  console.log('\n== 11. MALWARE_PAGE_BLOCKED message counts the block ==');
  const listener2 = messageListeners[0];
  const send2 = (msg) => new Promise(res => listener2(msg, {}, res));
  await send2({ type: 'MALWARE_PAGE_BLOCKED', host: 'login-microsoft-office.com' });
  await T.statsChain;
  const { stats: stats2 } = await chromeStub.storage.local.get('stats');
  const mb = stats2 && stats2['login-microsoft-office.com'];
  check('malwareBlocked counted for blocked navigation', mb && mb.malwareBlocked === 1, JSON.stringify(mb));
  const bad = await send2({ type: 'MALWARE_PAGE_BLOCKED', host: 'not a domain!!' });
  check('invalid host rejected', bad && bad.ok === false);

  console.log('\n== 12. RESOURCE_SEEN respects blocking toggles ==');
  // Uses the real chrome.storage.local.set() path (not a direct storageData
  // mutation) so the stub's onChanged listeners fire — background.js's
  // RESOURCE_SEEN handler reads these toggles from _settingsCache, which is
  // kept in sync via onChanged, exactly like a real chrome.storage write.
  await chromeStub.storage.local.set({ blockTrackers: false, blockMalware: false });
  await send2({ type: 'RESOURCE_SEEN', domain: 'toggletest.com',
    delta: { seen: 6, ads: 2, trackers: 3, malware: 1 } });
  await T.statsChain;
  const { stats: stats3 } = await chromeStub.storage.local.get('stats');
  const tt = stats3 && stats3['toggletest.com'];
  check('trackers NOT counted when blockTrackers=false', tt && tt.trackersBlocked === 0, JSON.stringify(tt));
  check('malware NOT counted when blockMalware=false', tt && tt.malwareBlocked === 0);
  check('ads still counted (blockAds=true)', tt && tt.adsBlocked === 2);
  check('totalSeen still recorded', tt && tt.totalSeen === 6);
  await chromeStub.storage.local.set({ blockTrackers: true, blockMalware: true, pausedDomains: ['paused.example.com'] });
  await send2({ type: 'RESOURCE_SEEN', domain: 'paused.example.com',
    delta: { seen: 5, ads: 5, trackers: 0, malware: 0 } });
  await T.statsChain;
  const { stats: stats4 } = await chromeStub.storage.local.get('stats');
  check('paused domain not counted at all', !stats4['paused.example.com']);
  await chromeStub.storage.local.set({ pausedDomains: [] });

  console.log('\n== 13. Cosmetic hides counted but excluded from bandwidth ==');
  await send2({ type: 'COSMETIC_HIDDEN', count: 5, url: 'https://bwtest.com/page' });
  await send2({ type: 'RESOURCE_SEEN', domain: 'bwtest.com',
    delta: { seen: 20, ads: 2, trackers: 3, malware: 0 } });
  await T.statsChain;
  const { stats: stats5 } = await chromeStub.storage.local.get('stats');
  const bw = stats5 && stats5['bwtest.com'];
  check('adsBlocked includes cosmetic hides (5+2)', bw && bw.adsBlocked === 7, JSON.stringify(bw));
  check('cosmeticHidden tracked separately', bw && bw.cosmeticHidden === 5);
  check('bandwidth counts network blocks only (2 ads + 3 trackers)',
    bw && bw.bandwidth === 2 * 50000 + 3 * 15000, bw && String(bw.bandwidth));
  check('speedGain sane: blocked/seen <= 100',
    bw && bw.speedGain <= 100 && bw.speedGain === Math.round((bw.blocked / bw.totalSeen) * 100));

  console.log('\n== 14. Dead AD_BLOCKED/AD_SKIPPED handlers removed ==');
  const deadResp = await send2({ type: 'AD_BLOCKED', domain: 'dead.com', count: 3 });
  check('AD_BLOCKED now unknown message', deadResp && deadResp.ok === false, JSON.stringify(deadResp));
  await T.statsChain;
  const { stats: stats6 } = await chromeStub.storage.local.get('stats');
  check('nothing counted for dead.com', !stats6['dead.com']);

  console.log('\n== 15. Ad-network main_frame auto-detect (popunder/click-hijack) ==');
  console.log(`  AD_MAINFRAME_RULES: ${T.AD_MAINFRAME_RULES.length} rule(s), ` +
    `${T.AD_MAINFRAME_RULES.reduce((n, r) => n + r.condition.requestDomains.length, 0)} domains`);
  check('ad main_frame rules built from config', T.AD_MAINFRAME_RULES.length > 0);
  // mgid.com is a known ad/redirect network in ad_network_patterns and NOT
  // duplicated in malware_network_domains — isolates this new rule set.
  const adNav = wouldBlock(dynamicRules, 'https://mgid.com/some/redirect?x=1', 'main_frame');
  check('main_frame nav to ad network intercepted', adNav.blocked, JSON.stringify(adNav));
  check('redirects to blocked.html with t=ad&h= params',
    adNav.redirectTo === 'chrome-extension://test/blocked/blocked.html?t=ad&h=mgid.com',
    adNav.redirectTo);
  // Static (non-regexSubstitution) resource redirects aren't recognized as
  // "blocked" by this simulator's wouldBlock() — check the rule fired at all.
  const adSubres = wouldBlock(dynamicRules, 'https://mgid.com/script.js', 'script');
  check('ad network subresource still handled by unrelated (pre-existing) rule',
    adSubres.action === 'block' || adSubres.action === 'redirect', JSON.stringify(adSubres));

  console.log('\n== 16. AD_POPUP_PAGE_BLOCKED message counts as ads ==');
  const send3 = (msg) => new Promise(res => listener2(msg, {}, res));
  await send3({ type: 'AD_POPUP_PAGE_BLOCKED', host: 'mgid.com' });
  await T.statsChain;
  const { stats: stats7 } = await chromeStub.storage.local.get('stats');
  const ap = stats7 && stats7['mgid.com'];
  check('adsBlocked counted for blocked ad-popup navigation', ap && ap.adsBlocked === 1, JSON.stringify(ap));
  const bad2 = await send3({ type: 'AD_POPUP_PAGE_BLOCKED', host: 'not a domain!!' });
  check('invalid host rejected', bad2 && bad2.ok === false);

  console.log('\n== 17. blockAds=false also removes ad main_frame rule ==');
  storageData.blockAds = false;
  await T.applyNetworkRules();
  const adNavOff = wouldBlock(dynamicRules, 'https://mgid.com/some/redirect?x=1', 'main_frame');
  check('ad main_frame nav NOT blocked when blockAds=false', !adNavOff.blocked, JSON.stringify(adNavOff));
  storageData.blockAds = true;
  await T.applyNetworkRules();
  check('re-enabled: ad main_frame nav blocked again',
    wouldBlock(dynamicRules, 'https://mgid.com/some/redirect?x=1', 'main_frame').blocked);

  console.log('\n== 18. close_popunder_tabs: opener-hostname-keyed tab auto-close (uBO-style) ==');
  check('tabs.onCreated listener registered', tabsCreatedListeners.length > 0);
  const onTabCreated = tabsCreatedListeners[0];
  // [fibwatch] (real rule/site-rules.txt) has close_popunder_tabs = 1.
  tabsData.set(9001, { url: 'https://fibwatch.art/watch/awarapan-2-2026_x.html' });
  await onTabCreated({ id: 9101, openerTabId: 9001 });
  await T.statsChain;
  check('popup spawned from a flagged site gets closed', removedTabIds.has(9101));
  const { stats: stats8 } = await chromeStub.storage.local.get('stats');
  check('adsBlocked counted against the OPENER domain (fibwatch.art)',
    stats8 && stats8['fibwatch.art'] && stats8['fibwatch.art'].adsBlocked === 1,
    JSON.stringify(stats8 && stats8['fibwatch.art']));

  // A site with no close_popunder_tabs flag must NOT have its popups closed.
  tabsData.set(9002, { url: 'https://www.youtube.com/watch?v=abc' });
  await onTabCreated({ id: 9102, openerTabId: 9002 });
  check('popup from an unflagged site is left alone', !removedTabIds.has(9102));

  // No openerTabId (e.g. typed URL / bookmark / omnibox) must be ignored.
  await onTabCreated({ id: 9103 });
  check('tab with no opener is ignored', !removedTabIds.has(9103));

  // Paused domain override applies here too, same as network rules. Goes
  // through storage.local.set() (not a direct storageData mutation) so the
  // onChanged listener actually fires and updates the in-memory cache the
  // hot path reads — this is exercising that sync path, not just the flag.
  await chromeStub.storage.local.set({ pausedDomains: ['fibwatch.art'] });
  tabsData.set(9003, { url: 'https://fibwatch.art/watch/another.html' });
  await onTabCreated({ id: 9104, openerTabId: 9003 });
  check('paused domain opener is NOT auto-closed', !removedTabIds.has(9104));
  await chromeStub.storage.local.set({ pausedDomains: [] });

  console.log('\n== 19. Extension\'s own pages are never auto-closed ==');
  // The extension's own pages (dashboard/popup/blocked.html) must never be
  // closed, even if openerTabId happens to point at a flagged/active tab —
  // e.g. chrome.runtime.openOptionsPage() opening the dashboard while the
  // active tab is on a close_popunder_tabs site.
  tabsData.set(9203, { url: 'https://fibwatch.art/watch/x.html' }); // flagged opener
  await onTabCreated({ id: 9311, openerTabId: 9203, url: chromeStub.runtime.getURL('dashboard/dashboard.html') });
  check('own extension page (url) is never auto-closed', !removedTabIds.has(9311));
  await onTabCreated({ id: 9312, openerTabId: 9203, pendingUrl: chromeStub.runtime.getURL('dashboard/dashboard.html') });
  check('own extension page (pendingUrl) is never auto-closed', !removedTabIds.has(9312));

  console.log('\n== 20. "Hide element" picker persistence (SAVE_ELEMENT_RULE) ==');
  const elHost = 'element-example.test';
  const send5 = (msg) => new Promise(res => listener2(msg, {}, res));
  await send5({ type: 'SAVE_ELEMENT_RULE', host: elHost, selector: '.ad-box' });
  const { customRulesText: crt1, elementRules: er1 } = await chromeStub.storage.local.get(['customRulesText', 'elementRules']);
  check('elementRules map updated', er1 && er1[elHost] && er1[elHost].includes('.ad-box'), JSON.stringify(er1));
  check('customRulesText contains the marker block', crt1.includes('Auto-generated by "Hide element"'));
  const parsedCrt1 = T.parseRuleText(crt1);
  const elSiteKey1 = Object.keys(parsedCrt1).find(k => k !== 'host_patterns' && k.startsWith('qkv1_'));
  check('generated section has direct_hide_selectors with the selector',
    elSiteKey1 && parsedCrt1[elSiteKey1].direct_hide_selectors &&
    parsedCrt1[elSiteKey1].direct_hide_selectors.includes('.ad-box'),
    JSON.stringify(elSiteKey1 && parsedCrt1[elSiteKey1]));

  // A selector containing a literal '|' must round-trip as ONE string, not
  // get split by the parser — this is the exact bug found/fixed 8 times
  // earlier this session on hand-authored regex; the picker escapes '|' in
  // BOTH element-picker.js and here before it ever reaches rule text.
  await send5({ type: 'SAVE_ELEMENT_RULE', host: elHost, selector: 'div[data-x|y="1"]' });
  const { customRulesText: crt2 } = await chromeStub.storage.local.get('customRulesText');
  const parsedCrt2 = T.parseRuleText(crt2);
  const elSiteKey2 = Object.keys(parsedCrt2).find(k => k !== 'host_patterns' && k.startsWith('qkv1_'));
  check('selector containing "|" round-trips as one unescaped string, not split',
    parsedCrt2[elSiteKey2].direct_hide_selectors.includes('div[data-x|y="1"]'),
    JSON.stringify(parsedCrt2[elSiteKey2].direct_hide_selectors));

  // Multiple selectors for the same host accumulate (deduped), don't clobber.
  await send5({ type: 'SAVE_ELEMENT_RULE', host: elHost, selector: '#banner-123' });
  await send5({ type: 'SAVE_ELEMENT_RULE', host: elHost, selector: '.ad-box' }); // dup, no-op
  const { elementRules: er2 } = await chromeStub.storage.local.get('elementRules');
  check('selectors accumulate without duplicating', er2[elHost].length === 3, JSON.stringify(er2[elHost]));

  // Removing one selector keeps the others; removing the last drops the host.
  await send5({ type: 'REMOVE_ELEMENT_RULE', host: elHost, selector: '#banner-123' });
  const { elementRules: er3 } = await chromeStub.storage.local.get('elementRules');
  check('single-selector removal keeps the rest', er3[elHost].length === 2, JSON.stringify(er3[elHost]));
  await send5({ type: 'REMOVE_ELEMENT_RULE', host: elHost });
  const { elementRules: er4, customRulesText: crt3 } = await chromeStub.storage.local.get(['elementRules', 'customRulesText']);
  check('removing the whole host drops it from the map', !er4[elHost], JSON.stringify(er4));
  check('marker block is gone once no hosts remain', !crt3.includes('Auto-generated by "Hide element"'), crt3);

  // Regression test: picking an element on a host that ALREADY has a
  // [sitekey] section in the base rule/site-rules.txt (e.g. tuoitre.vn ->
  // [tuoitre]) must merge the selector into that EXISTING section, not mint
  // a second, colliding [host_patterns] entry — resolveSiteKey always takes
  // the first match, so a second entry for the same host is silently
  // unreachable (hides instantly via the live-DOM edit, then reappears on
  // reload since GET_SITE_CONFIG never resolves to it).
  console.log('\n== 20c. Picking an element on an already-mapped host reuses its sitekey ==');
  await send5({ type: 'SAVE_ELEMENT_RULE', host: 'tuoitre.vn', selector: '.my-picked-ad' });
  const { customRulesText: crtExisting } = await chromeStub.storage.local.get('customRulesText');
  check('no duplicate [host_patterns] line minted for an already-mapped host',
    !crtExisting.includes('tuoitre.vn ='), crtExisting);
  check('selector merged into the EXISTING [tuoitre] section',
    crtExisting.includes('[tuoitre]') && crtExisting.includes('.my-picked-ad'), crtExisting);
  const rTuoitre = await send5({ type: 'GET_SITE_CONFIG', host: 'tuoitre.vn' });
  check('GET_SITE_CONFIG resolves tuoitre.vn to the pre-existing "tuoitre" siteKey',
    rTuoitre.siteKey === 'tuoitre', JSON.stringify(rTuoitre.siteKey));
  check('picked selector is actually reachable through site config (would reapply on reload)',
    (rTuoitre.site.direct_hide_selectors || []).includes('.my-picked-ad'),
    JSON.stringify(rTuoitre.site.direct_hide_selectors));
  await send5({ type: 'REMOVE_ELEMENT_RULE', host: 'tuoitre.vn' });

  // 20d. "Decline ad popup" -> no_window_open_if (2026-08-23) — sent by
  // blocked/blocked.js when the user ticks "Don't warn me again" and
  // clicks Go back/Close on an ad-popup warning, with the opener site
  // resolved. Same marker-block/siteKey-reuse machinery as SAVE_ELEMENT_RULE
  // above, just a different rule shape (no_window_open_if instead of
  // direct_hide_selectors).
  console.log('\n== 20d. "Decline ad popup" persistence (SAVE_NO_WINDOW_OPEN_RULE) ==');
  const nwoOpener = 'nwo-opener.test';
  const rNwoBadHost = await send5({ type: 'SAVE_NO_WINDOW_OPEN_RULE', openerHost: 'not a host', adHost: 'ads.example.com' });
  check('SAVE_NO_WINDOW_OPEN_RULE: rejects an invalid openerHost', rNwoBadHost.ok === false);
  const rNwoBadAd = await send5({ type: 'SAVE_NO_WINDOW_OPEN_RULE', openerHost: nwoOpener, adHost: 'not a host' });
  check('SAVE_NO_WINDOW_OPEN_RULE: rejects an invalid adHost', rNwoBadAd.ok === false);

  await send5({ type: 'SAVE_NO_WINDOW_OPEN_RULE', openerHost: nwoOpener, adHost: 'ads-one.example' });
  const { customRulesText: nwoCrt1, noWindowOpenRules: nwo1 } = await chromeStub.storage.local.get(['customRulesText', 'noWindowOpenRules']);
  check('noWindowOpenRules map updated', nwo1 && nwo1[nwoOpener] && nwo1[nwoOpener].includes('ads-one.example'), JSON.stringify(nwo1));
  check('customRulesText contains the marker block', nwoCrt1.includes('Auto-generated by "Decline ad popup"'));
  const nwoParsed1 = T.parseRuleText(nwoCrt1);
  const nwoSiteKey1 = Object.keys(nwoParsed1).find(k => k !== 'host_patterns' && k.startsWith('qkv1_'));
  check('generated section has no_window_open_if with "domain, 0, blank"',
    nwoSiteKey1 && nwoParsed1[nwoSiteKey1].no_window_open_if &&
    nwoParsed1[nwoSiteKey1].no_window_open_if.includes('ads-one.example, 0, blank'),
    JSON.stringify(nwoSiteKey1 && nwoParsed1[nwoSiteKey1]));

  // A second declined ad domain from the SAME opener site accumulates into
  // the SAME section's no_window_open_if value (one rule per domain), not
  // a second [host_patterns] entry or a clobbered value.
  await send5({ type: 'SAVE_NO_WINDOW_OPEN_RULE', openerHost: nwoOpener, adHost: 'ads-two.example' });
  await send5({ type: 'SAVE_NO_WINDOW_OPEN_RULE', openerHost: nwoOpener, adHost: 'ads-one.example' }); // dup, no-op
  const { customRulesText: nwoCrt2, noWindowOpenRules: nwo2 } = await chromeStub.storage.local.get(['customRulesText', 'noWindowOpenRules']);
  check('a second declined domain accumulates without duplicating the first', nwo2[nwoOpener].length === 2, JSON.stringify(nwo2[nwoOpener]));
  const nwoOpenerPatternLines = (nwoCrt2.match(new RegExp(`^${nwoOpener} = .+$`, 'm')) || []);
  check('still only ONE [host_patterns] line for the opener (not one per declined domain)',
    nwoOpenerPatternLines.length === 1, nwoCrt2);
  const nwoParsed2 = T.parseRuleText(nwoCrt2);
  check('both declined domains present in the same no_window_open_if value',
    nwoParsed2[nwoSiteKey1].no_window_open_if.includes('ads-one.example, 0, blank') &&
    nwoParsed2[nwoSiteKey1].no_window_open_if.includes('ads-two.example, 0, blank'),
    JSON.stringify(nwoParsed2[nwoSiteKey1].no_window_open_if));

  // Regression parity with SAVE_ELEMENT_RULE's own 20c test: declining a
  // popup from a site that's ALREADY curated (youtube.com -> [youtube] in
  // the base rule/site-rules.txt) must reuse that existing sitekey, not
  // mint a second colliding entry.
  await send5({ type: 'SAVE_NO_WINDOW_OPEN_RULE', openerHost: 'youtube.com', adHost: 'some-ad-network.example' });
  const { customRulesText: nwoCrtYoutube } = await chromeStub.storage.local.get('customRulesText');
  check('declining from an already-mapped opener host reuses its existing sitekey, no duplicate [host_patterns] line',
    !nwoCrtYoutube.includes('youtube.com =') && nwoCrtYoutube.includes('[youtube]') &&
    nwoCrtYoutube.includes('some-ad-network.example, 0, blank'),
    nwoCrtYoutube);

  // Regression test (2026-08-23): the SAME host getting a rule saved by TWO
  // DIFFERENT marker-block features (Hide element + Decline ad popup) must
  // mint exactly ONE [host_patterns] entry for it across the whole merged
  // customRulesText, not one per block. _elementRuleSiteKey() is a pure
  // function of the hostname, so both features independently compute the
  // identical sitekey for it — each feature's own "already exists?" check
  // has to see the OTHER feature's block (not just its own) to avoid
  // re-minting a duplicate line.
  console.log('\n== 20e. Same host across two different marker-block features shares one [host_patterns] line ==');
  const nwoSharedHost = 'shared-host.example';
  await send5({ type: 'SAVE_ELEMENT_RULE', host: nwoSharedHost, selector: '.shared-ad-el' });
  await send5({ type: 'SAVE_NO_WINDOW_OPEN_RULE', openerHost: nwoSharedHost, adHost: 'ads.example' });
  const { customRulesText: nwoSharedCrt } = await chromeStub.storage.local.get('customRulesText');
  const nwoSharedHostLines = (nwoSharedCrt.match(new RegExp(`^${nwoSharedHost.replace('.', '\\.')} = .+$`, 'm')) || []);
  check('exactly one [host_patterns] line for a host shared across two features',
    nwoSharedHostLines.length === 1, nwoSharedCrt);
  check('both blocks are present and reference the SAME sitekey',
    (() => {
      const parsedShared = T.parseRuleText(nwoSharedCrt);
      const sharedKey = T.resolveSiteKey(parsedShared.host_patterns, nwoSharedHost);
      return sharedKey && parsedShared[sharedKey] && parsedShared[sharedKey].direct_hide_selectors &&
        parsedShared[sharedKey].direct_hide_selectors.includes('.shared-ad-el') &&
        parsedShared[sharedKey].no_window_open_if &&
        parsedShared[sharedKey].no_window_open_if.includes('ads.example, 0, blank');
    })(), nwoSharedCrt);
  await send5({ type: 'REMOVE_ELEMENT_RULE', host: nwoSharedHost });

  await T._applyNoWindowOpenRules({}); // leave customRulesText clean for later sections

  // Hand-written rules the user typed in the dashboard's Rules tab, on
  // either side of the auto-generated block, must survive a picker
  // save/remove instead of being silently truncated away.
  console.log('\n== 20b. Hand-written custom rules survive picker save/remove ==');
  const elHostA = 'hand-a.test', elHostB = 'hand-b.test';
  await send5({ type: 'SAVE_ELEMENT_RULE', host: elHostA, selector: '.sel-a' });
  await send5({ type: 'SAVE_ELEMENT_RULE', host: elHostB, selector: '.sel-b' });
  let { customRulesText: crtHand } = await chromeStub.storage.local.get('customRulesText');
  crtHand = '[myprefix]\ndirect_hide_selectors = .before-rule\n\n' + crtHand +
    '\n\n[myhandwritten]\ndirect_hide_selectors = .my-manual-rule\n';
  await chromeStub.storage.local.set({ customRulesText: crtHand });
  await send5({ type: 'REMOVE_ELEMENT_RULE', host: elHostA });
  const { customRulesText: crtHandAfter } = await chromeStub.storage.local.get('customRulesText');
  check('hand-written rule BEFORE the block survives a picker remove',
    crtHandAfter.includes('myprefix') && crtHandAfter.includes('.before-rule'), crtHandAfter);
  check('hand-written rule AFTER the block survives a picker remove',
    crtHandAfter.includes('myhandwritten') && crtHandAfter.includes('.my-manual-rule'), crtHandAfter);
  check('sibling host (hostB) rule survives the removal of hostA',
    crtHandAfter.includes(elHostB) && crtHandAfter.includes('.sel-b'), crtHandAfter);
  check('removed host is actually gone', !crtHandAfter.includes(elHostA), crtHandAfter);
  // Clean up so later sections don't see these leftover hosts.
  await send5({ type: 'REMOVE_ELEMENT_RULE', host: elHostB });

  console.log('\n== 21. Icon badge shows the ACTIVE TAB\'s own blocked count (per-tab, uBO-style) ==');
  await T.updateIcon(true); // re-enable — test 21c below disables at the end
  const sendFromTab = (msg, tabId) => new Promise(res => listener2(msg, { tab: { id: tabId } }, res));
  const TAB_A = 501, TAB_B = 502;
  await sendFromTab({ type: 'AD_POPUP_PAGE_BLOCKED', host: 'badge-test.example' }, TAB_A);
  await T.statsChain;
  check('tab A badge shows the count after a block event', badgeTextByTab.get(TAB_A) === '1', `got ${JSON.stringify(badgeTextByTab.get(TAB_A))}`);
  for (let i = 0; i < 5; i++) {
    await sendFromTab({ type: 'AD_POPUP_PAGE_BLOCKED', host: 'badge-test.example' }, TAB_A);
  }
  await T.statsChain;
  check('tab A badge count accumulates', badgeTextByTab.get(TAB_A) === '6', `got ${JSON.stringify(badgeTextByTab.get(TAB_A))}`);

  console.log('\n== 21a. Per-tab counts are isolated from each other ==');
  await sendFromTab({ type: 'RESOURCE_SEEN', domain: 'other-tab.example', delta: { seen: 3, ads: 3, trackers: 0, malware: 0 } }, TAB_B);
  await T.statsChain;
  check('tab B has its own count, unaffected by tab A', badgeTextByTab.get(TAB_B) === '3', `got ${JSON.stringify(badgeTextByTab.get(TAB_B))}`);
  check('tab A is untouched by tab B\'s block event', badgeTextByTab.get(TAB_A) === '6', `got ${JSON.stringify(badgeTextByTab.get(TAB_A))}`);

  console.log('\n== 21b. Navigating a tab resets its count (new page, new count) ==');
  check('onUpdated listener registered', tabsUpdatedListeners.length > 0);
  for (const fn of tabsUpdatedListeners) {
    await fn(TAB_A, { url: 'https://fresh-page.example/' }, { url: 'https://fresh-page.example/' });
  }
  check('tab A\'s in-memory counter cleared on navigation', !T.tabBlockedCounts.has(TAB_A));
  check('tab A badge goes blank on navigation', badgeTextByTab.get(TAB_A) === '', `got ${JSON.stringify(badgeTextByTab.get(TAB_A))}`);
  check('tab B is untouched by tab A\'s navigation', badgeTextByTab.get(TAB_B) === '3');

  console.log('\n== 21c. Large counts abbreviated, disabled shows OFF (not a stale count) ==');
  T._incrementTabBlocked(TAB_A, 12345);
  check('large counts are abbreviated (e.g. "12k")', badgeTextByTab.get(TAB_A) === '12k', `got ${JSON.stringify(badgeTextByTab.get(TAB_A))}`);
  await T.updateIcon(false);
  check('disabled shows OFF globally, not any tab\'s count', lastBadgeText === 'OFF', `got ${JSON.stringify(lastBadgeText)}`);

  console.log('\n== 22. "Scan page globals" picker persistence (SAVE_GLOBAL_RULE) ==');
  const gHost = 'global-example.test';
  await send5({ type: 'SAVE_GLOBAL_RULE', host: gHost, chain: 'evilAdSdk.detect', action: 'block' });
  const { customRulesText: gcrt1, globalScopeRules: gr1 } = await chromeStub.storage.local.get(['customRulesText', 'globalScopeRules']);
  check('globalScopeRules map updated', gr1 && gr1[gHost] && gr1[gHost].some(r => r.chain === 'evilAdSdk.detect' && r.action === 'block'), JSON.stringify(gr1));
  check('customRulesText contains the marker block', gcrt1.includes('Auto-generated by "Global scope rules"'));
  const gParsed1 = T.parseRuleText(gcrt1);
  const gSiteKey1 = Object.keys(gParsed1).find(k => k !== 'host_patterns' && k.startsWith('qkv1_'));
  check('generated section uses abort_on_property_read for a block action (NOT also abort_on_property_write — see background.js comment on why they don\'t compose)',
    gSiteKey1 && gParsed1[gSiteKey1].abort_on_property_read &&
    gParsed1[gSiteKey1].abort_on_property_read.includes('evilAdSdk.detect') &&
    !gParsed1[gSiteKey1].abort_on_property_write,
    JSON.stringify(gSiteKey1 && gParsed1[gSiteKey1]));

  await send5({ type: 'SAVE_GLOBAL_RULE', host: gHost, chain: 'trackerCfg.enabled', action: 'edit', value: 'false' });
  const { customRulesText: gcrt2 } = await chromeStub.storage.local.get('customRulesText');
  const gParsed2 = T.parseRuleText(gcrt2);
  check('edit action generates set_constant with the chosen value',
    gParsed2[gSiteKey1].set_constant && gParsed2[gSiteKey1].set_constant.includes('trackerCfg.enabled false'),
    JSON.stringify(gParsed2[gSiteKey1].set_constant));

  await send5({ type: 'SAVE_GLOBAL_RULE', host: gHost, chain: 'paywallGate', action: 'delete' });
  const { customRulesText: gcrt3 } = await chromeStub.storage.local.get('customRulesText');
  const gParsed3 = T.parseRuleText(gcrt3);
  check('delete action persists as set_constant chain undefined',
    gParsed3[gSiteKey1].set_constant.includes('paywallGate undefined'),
    JSON.stringify(gParsed3[gSiteKey1].set_constant));

  // Re-picking the SAME chain with a different action replaces, not stacks
  // (unlike element-rules' selectors, which dedupe-and-append) — a user
  // switching Edit -> Block for the same global shouldn't leave two
  // conflicting entries.
  await send5({ type: 'SAVE_GLOBAL_RULE', host: gHost, chain: 'trackerCfg.enabled', action: 'block' });
  const { globalScopeRules: gr2 } = await chromeStub.storage.local.get('globalScopeRules');
  const trackerEntries = gr2[gHost].filter(r => r.chain === 'trackerCfg.enabled');
  check('re-saving the same chain overwrites, not duplicates', trackerEntries.length === 1 && trackerEntries[0].action === 'block', JSON.stringify(gr2[gHost]));

  console.log('\n== 22a. SAVE_GLOBAL_RULE validation rejects bad input ==');
  const rBadHost = await send5({ type: 'SAVE_GLOBAL_RULE', host: 'not a host!!', chain: 'x', action: 'block' });
  check('rejects invalid host', rBadHost.ok === false);
  const rBadChain = await send5({ type: 'SAVE_GLOBAL_RULE', host: gHost, chain: 'not-a-valid-chain!', action: 'block' });
  check('rejects chain with invalid characters', rBadChain.ok === false);
  const rBadAction = await send5({ type: 'SAVE_GLOBAL_RULE', host: gHost, chain: 'x', action: 'delete_forever' });
  check('rejects unknown action', rBadAction.ok === false);
  const rBadValue = await send5({ type: 'SAVE_GLOBAL_RULE', host: gHost, chain: 'x', action: 'edit', value: 'has spaces' });
  check('rejects an edit value containing whitespace (would truncate at the scriptlet parser)', rBadValue.ok === false);
  const rEmptyValue = await send5({ type: 'SAVE_GLOBAL_RULE', host: gHost, chain: 'x', action: 'edit', value: '' });
  check('rejects an empty edit value', rEmptyValue.ok === false);

  console.log('\n== 22b. REMOVE_GLOBAL_RULE ==');
  await send5({ type: 'REMOVE_GLOBAL_RULE', host: gHost, chain: 'paywallGate' });
  const { globalScopeRules: gr3 } = await chromeStub.storage.local.get('globalScopeRules');
  check('single-chain removal keeps the rest', gr3[gHost].length === 2 && !gr3[gHost].some(r => r.chain === 'paywallGate'), JSON.stringify(gr3[gHost]));
  await send5({ type: 'REMOVE_GLOBAL_RULE', host: gHost });
  const { globalScopeRules: gr4, customRulesText: gcrt4 } = await chromeStub.storage.local.get(['globalScopeRules', 'customRulesText']);
  check('removing the whole host drops it from the map', !gr4[gHost], JSON.stringify(gr4));
  check('marker block is gone once no hosts remain', !gcrt4.includes('Auto-generated by "Global scope rules"'), gcrt4);

  console.log('\n== 22c. Element rule + global rule for the SAME host share one site-key/section ==');
  const sharedHost = 'shared-example.test';
  await send5({ type: 'SAVE_ELEMENT_RULE', host: sharedHost, selector: '.shared-ad' });
  await send5({ type: 'SAVE_GLOBAL_RULE', host: sharedHost, chain: 'sharedGlobal', action: 'block' });
  const { customRulesText: sharedCrt } = await chromeStub.storage.local.get('customRulesText');
  const sharedParsed = T.parseRuleText(sharedCrt);
  const sharedHostPatternLines = (sharedCrt.match(new RegExp(`^${sharedHost} = .+$`, 'm')) || []);
  check('only ONE [host_patterns] line minted for the shared host (not two colliding entries)',
    sharedHostPatternLines.length === 1, sharedCrt);
  const sharedSiteKey = T.resolveSiteKey(sharedParsed.host_patterns, sharedHost);
  check('both the element rule and the global rule resolve to the SAME site-key section',
    sharedParsed[sharedSiteKey] &&
    (sharedParsed[sharedSiteKey].direct_hide_selectors || []).includes('.shared-ad') &&
    (sharedParsed[sharedSiteKey].abort_on_property_read || []).includes('sharedGlobal'),
    JSON.stringify(sharedParsed[sharedSiteKey]));
  await send5({ type: 'REMOVE_ELEMENT_RULE', host: sharedHost });
  await send5({ type: 'REMOVE_GLOBAL_RULE', host: sharedHost });

  console.log('\n== 22d. Hand-written custom rules survive global-rule save/remove ==');
  const gHostA = 'ghand-a.test', gHostB = 'ghand-b.test';
  await send5({ type: 'SAVE_GLOBAL_RULE', host: gHostA, chain: 'aGlobal', action: 'block' });
  await send5({ type: 'SAVE_GLOBAL_RULE', host: gHostB, chain: 'bGlobal', action: 'block' });
  let { customRulesText: gcrtHand } = await chromeStub.storage.local.get('customRulesText');
  gcrtHand = '[myprefix2]\ndirect_hide_selectors = .before-rule2\n\n' + gcrtHand +
    '\n\n[myhandwritten2]\ndirect_hide_selectors = .my-manual-rule2\n';
  await chromeStub.storage.local.set({ customRulesText: gcrtHand });
  await send5({ type: 'REMOVE_GLOBAL_RULE', host: gHostA });
  const { customRulesText: gcrtHandAfter } = await chromeStub.storage.local.get('customRulesText');
  check('hand-written rule BEFORE the block survives a global-rule remove',
    gcrtHandAfter.includes('myprefix2') && gcrtHandAfter.includes('.before-rule2'), gcrtHandAfter);
  check('hand-written rule AFTER the block survives a global-rule remove',
    gcrtHandAfter.includes('myhandwritten2') && gcrtHandAfter.includes('.my-manual-rule2'), gcrtHandAfter);
  check('sibling host (hostB) rule survives the removal of hostA',
    gcrtHandAfter.includes(gHostB) && gcrtHandAfter.includes('bGlobal'), gcrtHandAfter);
  check('removed host is actually gone', !gcrtHandAfter.includes('aGlobal'), gcrtHandAfter);
  await send5({ type: 'REMOVE_GLOBAL_RULE', host: gHostB });

  console.log('\n== 23. "Edit rules for this site" picker persistence (SAVE_SITE_RULE_TEXT) ==');
  const eHost = 'editor-example.test';
  const rGetEmpty = await send5({ type: 'GET_SITE_RULE_TEXT', host: eHost });
  check('GET_SITE_RULE_TEXT returns empty string for a host with nothing saved', rGetEmpty.ok && rGetEmpty.text === '', JSON.stringify(rGetEmpty));
  check('GET_SITE_RULE_TEXT also returns empty existingText when the site has no built-in rules either', rGetEmpty.existingText === '', JSON.stringify(rGetEmpty));

  console.log('\n== 23f. GET_SITE_RULE_TEXT.existingText shows what\'s ALREADY active (built-in + other pickers), not just this feature\'s own saves ==');
  const rExistingBefore = await send5({ type: 'GET_SITE_RULE_TEXT', host: 'tuoitre.vn' });
  check('a real site with built-in rules (tuoitre.vn) shows them in existingText even with nothing saved via this picker',
    rExistingBefore.ok && rExistingBefore.text === '' && /direct_hide_selectors/.test(rExistingBefore.existingText) && /LeaderBoardTop/.test(rExistingBefore.existingText),
    rExistingBefore.existingText);
  await send5({ type: 'SAVE_GLOBAL_RULE', host: 'tuoitre.vn', chain: 'tuoitreProbe', action: 'block' });
  const rExistingAfter = await send5({ type: 'GET_SITE_RULE_TEXT', host: 'tuoitre.vn' });
  check('existingText also picks up a rule added via a DIFFERENT picker (global-scope) for the same host',
    /abort_on_property_read/.test(rExistingAfter.existingText) && /tuoitreProbe/.test(rExistingAfter.existingText),
    rExistingAfter.existingText);
  check('the built-in rule is STILL shown too — existingText is the full merged view, not just the newest addition',
    /LeaderBoardTop/.test(rExistingAfter.existingText), rExistingAfter.existingText);
  await send5({ type: 'REMOVE_GLOBAL_RULE', host: 'tuoitre.vn' });

  await send5({ type: 'SAVE_SITE_RULE_TEXT', host: eHost, text: 'direct_hide_selectors = .my-ad | .another-ad\nlabels = sponsored' });
  const { customRulesText: ecrt1, siteRuleText: esr1 } = await chromeStub.storage.local.get(['customRulesText', 'siteRuleText']);
  check('siteRuleText map updated', esr1 && esr1[eHost] && esr1[eHost].includes('direct_hide_selectors'), JSON.stringify(esr1));
  check('customRulesText contains the marker block', ecrt1.includes('Auto-generated by "Rule editor"'));
  const eParsed1 = T.parseRuleText(ecrt1);
  const eSiteKey1 = Object.keys(eParsed1).find(k => k !== 'host_patterns' && k.startsWith('qkv1_'));
  check('both typed lines land in the generated section, verbatim key names',
    eParsed1[eSiteKey1] && eParsed1[eSiteKey1].direct_hide_selectors && eParsed1[eSiteKey1].direct_hide_selectors.includes('.my-ad') &&
    eParsed1[eSiteKey1].labels && eParsed1[eSiteKey1].labels.includes('sponsored'),
    JSON.stringify(eParsed1[eSiteKey1]));

  const rGetSaved = await send5({ type: 'GET_SITE_RULE_TEXT', host: eHost });
  check('GET_SITE_RULE_TEXT reads back exactly what was saved', rGetSaved.text.includes('direct_hide_selectors') && rGetSaved.text.includes('labels'), rGetSaved.text);

  console.log('\n== 23a. A typed [section] header line is stripped, not saved verbatim (scope containment) ==');
  await send5({ type: 'SAVE_SITE_RULE_TEXT', host: eHost, text: '[global]\nad_network_patterns = evil.example\ndirect_hide_selectors = .still-here' });
  const { customRulesText: ecrt2 } = await chromeStub.storage.local.get('customRulesText');
  check('the typed [global] header line does not appear literally in the saved text', !/^\[global\]$/m.test(ecrt2.split('Auto-generated by "Rule editor"')[1] || ''), ecrt2);
  const eParsed2 = T.parseRuleText(ecrt2);
  check('the real rule line right after the stripped header still saved correctly',
    eParsed2[eSiteKey1].direct_hide_selectors.includes('.still-here'), JSON.stringify(eParsed2[eSiteKey1]));

  console.log('\n== 23b. Validation rejects an oversized paste ==');
  const rTooBig = await send5({ type: 'SAVE_SITE_RULE_TEXT', host: eHost, text: 'x'.repeat(5000) });
  check('rejects text over the length cap', rTooBig.ok === false);
  const rBadHost2 = await send5({ type: 'SAVE_SITE_RULE_TEXT', host: 'not a host', text: 'direct_hide_selectors = .x' });
  check('rejects an invalid host', rBadHost2.ok === false);

  console.log('\n== 23c. Saving an empty textarea clears the site\'s rules ==');
  await send5({ type: 'SAVE_SITE_RULE_TEXT', host: eHost, text: '' });
  const { siteRuleText: esr2, customRulesText: ecrt3 } = await chromeStub.storage.local.get(['siteRuleText', 'customRulesText']);
  check('empty save removes the host from the map', !esr2[eHost], JSON.stringify(esr2));
  check('marker block is gone once no hosts remain', !ecrt3.includes('Auto-generated by "Rule editor"'), ecrt3);

  console.log('\n== 23d. Element rule + global rule + site-rule-text for the SAME host all share one section ==');
  const tripleHost = 'triple-example.test';
  await send5({ type: 'SAVE_ELEMENT_RULE', host: tripleHost, selector: '.triple-ad' });
  await send5({ type: 'SAVE_GLOBAL_RULE', host: tripleHost, chain: 'tripleGlobal', action: 'block' });
  await send5({ type: 'SAVE_SITE_RULE_TEXT', host: tripleHost, text: 'labels = sponsored' });
  const { customRulesText: tripleCrt } = await chromeStub.storage.local.get('customRulesText');
  const tripleParsed = T.parseRuleText(tripleCrt);
  const tripleHostPatternLines = (tripleCrt.match(new RegExp(`^${tripleHost} = .+$`, 'm')) || []);
  check('only ONE [host_patterns] line minted across all three picker features', tripleHostPatternLines.length === 1, tripleCrt);
  const tripleSiteKey = T.resolveSiteKey(tripleParsed.host_patterns, tripleHost);
  check('all three features\' rules resolve to the SAME merged section',
    tripleParsed[tripleSiteKey] &&
    (tripleParsed[tripleSiteKey].direct_hide_selectors || []).includes('.triple-ad') &&
    (tripleParsed[tripleSiteKey].abort_on_property_read || []).includes('tripleGlobal') &&
    (tripleParsed[tripleSiteKey].labels || []).includes('sponsored'),
    JSON.stringify(tripleParsed[tripleSiteKey]));
  await send5({ type: 'REMOVE_ELEMENT_RULE', host: tripleHost });
  await send5({ type: 'REMOVE_GLOBAL_RULE', host: tripleHost });
  await send5({ type: 'SAVE_SITE_RULE_TEXT', host: tripleHost, text: '' });

  console.log('\n== 23e. Hand-written custom rules survive rule-editor save/clear ==');
  const eHostA = 'ehand-a.test', eHostB = 'ehand-b.test';
  await send5({ type: 'SAVE_SITE_RULE_TEXT', host: eHostA, text: 'labels = a-label' });
  await send5({ type: 'SAVE_SITE_RULE_TEXT', host: eHostB, text: 'labels = b-label' });
  let { customRulesText: ecrtHand } = await chromeStub.storage.local.get('customRulesText');
  ecrtHand = '[myprefix3]\ndirect_hide_selectors = .before-rule3\n\n' + ecrtHand +
    '\n\n[myhandwritten3]\ndirect_hide_selectors = .my-manual-rule3\n';
  await chromeStub.storage.local.set({ customRulesText: ecrtHand });
  await send5({ type: 'SAVE_SITE_RULE_TEXT', host: eHostA, text: '' });
  const { customRulesText: ecrtHandAfter } = await chromeStub.storage.local.get('customRulesText');
  check('hand-written rule BEFORE the block survives a rule-editor clear',
    ecrtHandAfter.includes('myprefix3') && ecrtHandAfter.includes('.before-rule3'), ecrtHandAfter);
  check('hand-written rule AFTER the block survives a rule-editor clear',
    ecrtHandAfter.includes('myhandwritten3') && ecrtHandAfter.includes('.my-manual-rule3'), ecrtHandAfter);
  check('sibling host (hostB) rule survives clearing hostA',
    ecrtHandAfter.includes('b-label'), ecrtHandAfter);
  check('cleared host is actually gone', !ecrtHandAfter.includes('a-label'), ecrtHandAfter);
  await send5({ type: 'SAVE_SITE_RULE_TEXT', host: eHostB, text: '' });

  console.log('\n== 24. Extension update check ==');
  check('_isNewerVersion: patch bump detected', T._isNewerVersion('1.0.36', '1.0.35') === true);
  check('_isNewerVersion: same version is not "newer"', T._isNewerVersion('1.0.35', '1.0.35') === false);
  check('_isNewerVersion: older remote is not "newer"', T._isNewerVersion('1.0.34', '1.0.35') === false);
  check('_isNewerVersion: minor/major bump detected', T._isNewerVersion('1.1.0', '1.0.35') === true);
  check('_isNewerVersion: different segment counts handled (2.0 vs 1.9.9)', T._isNewerVersion('2.0', '1.9.9') === true);

  stubRemoteManifestVersion = '1.0.0'; // below the stubbed local 1.0.35
  const noUpdateInfo = await T.checkForExtensionUpdate();
  check('no update reported when remote version is older/equal', noUpdateInfo.available === false, JSON.stringify(noUpdateInfo));
  check('latestVersion still recorded even when not newer', noUpdateInfo.latestVersion === '1.0.0');
  check('lastCheckOk true on a successful fetch', noUpdateInfo.lastCheckOk === true);

  stubRemoteManifestVersion = '9.9.9';
  const rCheckNow = await send5({ type: 'CHECK_FOR_UPDATE_NOW' });
  check('CHECK_FOR_UPDATE_NOW reports an update when the remote version is newer', rCheckNow.ok && rCheckNow.available === true, JSON.stringify(rCheckNow));
  check('CHECK_FOR_UPDATE_NOW returns the current AND latest version', rCheckNow.currentVersion === '1.0.35' && rCheckNow.latestVersion === '9.9.9', JSON.stringify(rCheckNow));

  const rStatus = await send5({ type: 'GET_UPDATE_STATUS' });
  check('GET_UPDATE_STATUS reflects the same cached result without a fresh fetch', rStatus.ok && rStatus.available === true && rStatus.latestVersion === '9.9.9', JSON.stringify(rStatus));

  stubRemoteManifestUnreachable = true;
  const rOffline = await send5({ type: 'CHECK_FOR_UPDATE_NOW' });
  check('a failed fetch is reported (lastCheckOk:false), not silently treated as success', rOffline.ok && rOffline.lastCheckOk === false, JSON.stringify(rOffline));
  check('a failed fetch keeps the last KNOWN available/latestVersion instead of resetting it', rOffline.available === true && rOffline.latestVersion === '9.9.9', JSON.stringify(rOffline));
  stubRemoteManifestUnreachable = false;
  stubRemoteManifestVersion = '1.0.0'; // reset for maybeCheckForExtensionUpdate's own TTL test below

  await chromeStub.storage.local.set({ updateInfo: { lastChecked: Date.now() - 1, available: true, latestVersion: '9.9.9', lastCheckOk: true } });
  await T.maybeCheckForExtensionUpdate();
  const { updateInfo: notRecheckedYet } = await chromeStub.storage.local.get('updateInfo');
  check('maybeCheckForExtensionUpdate skips a fresh re-check within the TTL window', notRecheckedYet.latestVersion === '9.9.9', JSON.stringify(notRecheckedYet));

  await chromeStub.storage.local.set({ updateInfo: { lastChecked: Date.now() - (25 * 60 * 60 * 1000), available: true, latestVersion: '9.9.9', lastCheckOk: true } });
  await T.maybeCheckForExtensionUpdate();
  const { updateInfo: rechecked } = await chromeStub.storage.local.get('updateInfo');
  check('maybeCheckForExtensionUpdate re-checks once the TTL has expired', rechecked.latestVersion === '1.0.0' && rechecked.available === false, JSON.stringify(rechecked));

  console.log('\n== 24a. Update check picks the RIGHT manifest for the install (manifest.json vs manifest.firefox.json can diverge) ==');
  // Chrome/Edge install (default stub state): only manifest.json's stubbed
  // version should ever be consulted, even if manifest.firefox.json's is
  // wildly different — a regression here would silently compare against
  // the wrong browser's release cadence.
  stubRemoteManifestVersion = '2.0.0';
  stubRemoteManifestVersionFirefox = '1.0.0'; // deliberately stale/irrelevant for this check
  const chromeUpdate = await T.checkForExtensionUpdate();
  check('non-Firefox install compares against manifest.json, not manifest.firefox.json',
    chromeUpdate.latestVersion === '2.0.0' && chromeUpdate.available === true, JSON.stringify(chromeUpdate));

  sandbox.navigator.userAgent = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
  stubRemoteManifestVersion = '2.0.0';       // deliberately irrelevant for this check
  stubRemoteManifestVersionFirefox = '1.0.20'; // still lower than the stubbed local 1.0.35
  const firefoxUpdateNone = await T.checkForExtensionUpdate();
  check('Firefox install compares against manifest.firefox.json, not manifest.json',
    firefoxUpdateNone.latestVersion === '1.0.20' && firefoxUpdateNone.available === false, JSON.stringify(firefoxUpdateNone));

  stubRemoteManifestVersionFirefox = '1.5.0'; // now genuinely newer than local 1.0.35
  const firefoxUpdateYes = await T.checkForExtensionUpdate();
  check('Firefox install correctly reports an update from ITS OWN manifest, independent of manifest.json',
    firefoxUpdateYes.latestVersion === '1.5.0' && firefoxUpdateYes.available === true, JSON.stringify(firefoxUpdateYes));
  sandbox.navigator.userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'; // reset for any later section

  console.log('\n== 25. ABP/uBO format auto-detect + convert (Rule Source "Add URL") (2026-08-22) ==');

  // 25a. Format detection.
  check('_looksLikeAbpFormat: native site-rules.txt text -> false',
    T._looksLikeAbpFormat('# comment\n[host_patterns]\nexample.com = ex') === false);
  check('_looksLikeAbpFormat: ABP text (! comment, no bracket section) -> true',
    T._looksLikeAbpFormat('! Title: Test List\n||tracker.com^') === true);
  check('_looksLikeAbpFormat: cosmetic-only ABP text (no ! comment either) -> true',
    T._looksLikeAbpFormat('example.com##.ad-banner') === true);
  check('_looksLikeAbpFormat: empty text -> false (nothing to convert either way)',
    T._looksLikeAbpFormat('') === false);

  // 25b. Conversion — cosmetic rule + mapped scriptlet call + bare network rule
  // kept; path-scoped network rule + unmapped scriptlet call dropped, not guessed at.
  const abpSnippet = [
    '! Title: Test List',
    '! comment',
    'abptestdomain.com##.ad-banner',
    'abptestdomain.com##+js(nowebrtc)',
    'abptestdomain.com##+js(some-unmapped-scriptlet-xyz, arg1)',
    '||abptracker.com^',
    '||abptracker.com/path/ads.js^$script',
  ].join('\n');
  const converted = await T._maybeConvertAbpText(abpSnippet);
  check('_maybeConvertAbpText: cosmetic selector -> direct_hide_selectors',
    converted.includes('direct_hide_selectors') && converted.includes('.ad-banner'), converted);
  check('_maybeConvertAbpText: mapped scriptlet call (nowebrtc) -> its gitAdblock key (no_webrtc)',
    converted.includes('no_webrtc'), converted);
  check('_maybeConvertAbpText: unmapped scriptlet call dropped entirely (not guessed at)',
    !converted.includes('some-unmapped-scriptlet-xyz'), converted);
  check('_maybeConvertAbpText: bare ||domain^ network rule -> ad_network_patterns',
    converted.includes('ad_network_patterns') && converted.includes('abptracker.com'), converted);
  check('_maybeConvertAbpText: path-scoped network rule dropped, not folded in as bare abptracker.com',
    !converted.includes('path/ads.js'), converted);
  check('_maybeConvertAbpText: [host_patterns] section present, maps the domain to a generated key',
    converted.includes('[host_patterns]') && converted.includes('abptestdomain.com'), converted);

  // 25c. Native site-rules.txt text passes through completely unchanged (no re-render).
  const nativeText = '[global]\nad_network_patterns = a.com | b.com\n';
  const passthrough = await T._maybeConvertAbpText(nativeText);
  check('_maybeConvertAbpText: native site-rules.txt text passes through byte-for-byte unchanged',
    passthrough === nativeText, passthrough);

  // 25d. Dedup — a domain already covered by the live parsed rules'
  // [host_patterns] is excluded from the converted output rather than
  // re-emitted as a duplicate/conflicting section.
  const { host_patterns: liveHostPatterns = {} } = await T.getParsedRules();
  const curatedDomain = Object.keys(liveHostPatterns)[0];
  if (curatedDomain) {
    const dedupSnippet = `${curatedDomain}##.some-selector-that-should-be-skipped`;
    const dedupResult = await T._maybeConvertAbpText(dedupSnippet);
    check('_maybeConvertAbpText: a domain already in the live [host_patterns] is skipped, not duplicated',
      !dedupResult.includes('some-selector-that-should-be-skipped'), dedupResult);
  }

  // 25dd. Regression (2026-08-23): dedup must NOT read the merged CACHE —
  // only the bundled local site-rules.txt. Otherwise enabling one ABP Rule
  // Source (e.g. EasyList) first, whose conversion happens to touch some
  // domain, silently drops a LATER-enabled Rule Source's (e.g. Vietnam —
  // ABPVN List) OWN rules for that same domain instead of merging them —
  // live-reported as ABPVN "not executing", a .banner-ads selector never
  // getting injected.
  {
    const crossSourceDomain = 'cross-source-dedup-test.example';
    // Simulate a stale merged cache that already has a host_patterns entry
    // for this domain (as if some OTHER Rule Source — e.g. EasyList —
    // converted and cached it on a prior fetch cycle).
    await chromeStub.storage.local.set({
      [T.RULES_CACHE_TEXT_KEY || 'siteRulesCacheText']:
        `[host_patterns]\n${crossSourceDomain} = ua_cross_source_dedup_test\n\n[ua_cross_source_dedup_test]\ndirect_hide_selectors = .from-easylist-stale-cache\n`,
    });
    const laterSourceSnippet = `${crossSourceDomain}##.banner-ads`;
    const laterSourceResult = await T._maybeConvertAbpText(laterSourceSnippet);
    check('_maybeConvertAbpText: a domain only present in the STALE MERGED CACHE (not the bundled local file) is NOT treated as curated — a later Rule Source\'s own rule for it still converts',
      laterSourceResult.includes('banner-ads'), laterSourceResult);
    await chromeStub.storage.local.set({ siteRulesCacheText: '', siteRulesCacheTime: 0 }); // leave state clean
  }

  // 25de. Skip-stats tracking (2026-08-23) — "liệu tôi có thể kiểm tra các
  // rule filter bị bỏ qua hay parse lỗi không" (can I check which filter
  // rules got skipped or parse-errored?). _maybeConvertAbpText()'s optional
  // statsOut param tallies why each rule LINE did or didn't end up
  // contributing to the converted output, so a Rule Source's silent
  // partial data loss is finally visible instead of invisible-by-default.
  {
    const skipTestSnippet = [
      'convertible.example##.real-ad',           // converted
      '||convertible.example^',                  // converted (bare network domain)
      '@@||convertible.example^',                 // exception
      'convertible.example#@#.something',         // exception (plain cosmetic exception)
      'convertible.example##:has-text(buy now)',  // procedural
      '[$path=/ads]convertible.example##.x',      // adguard extended
      'convertible.example#$#totallyUnknownScriptletXyz()', // unmapped-ish (not a real +js() call, falls to unrecognized)
      'convertible.example##+js(totally-unmapped-scriptlet-xyz)', // unmapped scriptlet
      '||convertible.example/path/to/ads.js$redirect=some-resource-nobody-ships', // complex network, unresolvable redirect
    ].join('\n');
    const statsOut = {};
    const skipResult = await T._maybeConvertAbpText(skipTestSnippet, statsOut);
    check('_maybeConvertAbpText: statsOut is populated for an ABP-format source',
      Object.keys(statsOut).length > 0, statsOut);
    check('_maybeConvertAbpText: converted count includes both the cosmetic AND the bare network rule',
      statsOut.converted === 2, statsOut);
    check('_maybeConvertAbpText: exception count includes BOTH the @@ and the plain #@# cosmetic exception',
      statsOut.exception === 2, statsOut);
    check('_maybeConvertAbpText: procedural selector counted', statsOut.procedural === 1, statsOut);
    check('_maybeConvertAbpText: AdGuard extended modifier counted', statsOut.adguardExtended === 1, statsOut);
    check('_maybeConvertAbpText: unmapped scriptlet counted', statsOut.unmappedScriptlet >= 1, statsOut);
    check('_maybeConvertAbpText: unresolvable-redirect complex network rule counted', statsOut.complexNetwork === 1, statsOut);
    check('_maybeConvertAbpText: total roughly matches the sum of all buckets (nothing double-counted or lost)',
      statsOut.total === statsOut.converted + statsOut.exception + statsOut.procedural + statsOut.adguardExtended +
      statsOut.unmappedScriptlet + statsOut.complexNetwork + statsOut.dedupSkipped + statsOut.unrecognized,
      statsOut);

    // dedupSkipped is its OWN bucket, separate from "unsupported syntax" —
    // a domain already curated by this repo's own site-rules.txt is the
    // dedup mechanism working as intended, not a parsing failure.
    const { host_patterns: liveHP2 = {} } = await T.getParsedRules();
    const curated2 = Object.keys(liveHP2)[0];
    if (curated2) {
      const dedupStats = {};
      await T._maybeConvertAbpText(`${curated2}##.skip-me-dedup`, dedupStats);
      check('_maybeConvertAbpText: a dedup-skipped domain is counted in its OWN bucket, not lumped in with real parse failures',
        dedupStats.dedupSkipped === 1 && dedupStats.unrecognized === 0, dedupStats);
    }

    // Native (non-ABP) text — no stats object at all, since there's
    // nothing to report (the whole point is "how much of the ABP
    // conversion got dropped", meaningless for text that was never ABP).
    const nativeStats = {};
    await T._maybeConvertAbpText('[global]\nad_network_patterns = a.com\n', nativeStats);
    check('_maybeConvertAbpText: native (non-ABP) text leaves statsOut untouched — nothing to report',
      Object.keys(nativeStats).length === 0, nativeStats);

    // Backward compatibility: every existing call site/test omits statsOut
    // entirely — must keep working exactly as before (plain string return).
    const noStatsResult = await T._maybeConvertAbpText(skipTestSnippet);
    check('_maybeConvertAbpText: omitting statsOut still returns the plain converted string as before',
      typeof noStatsResult === 'string' && noStatsResult.includes('real-ad'), typeof noStatsResult);
  }

  console.log('\n== 25df. RULE_SOURCE_STATS_KEY — per-URL skip-stats persisted for the dashboard to read (2026-08-23) ==');
  {
    stubAbpSourceText = 'skipstatstest.example##.kept-selector\nskipstatstest.example##:has-text(unsupported)';
    await chromeStub.storage.local.set({ [T.RULE_SOURCE_STATS_KEY]: {} });
    await T._fetchAndConvertUrls(['https://example.com/abp-test-source.txt']);
    const { [T.RULE_SOURCE_STATS_KEY]: statsAfter } = await chromeStub.storage.local.get(T.RULE_SOURCE_STATS_KEY);
    check('_fetchAndConvertUrls: an ABP-format URL source gets an entry in RULE_SOURCE_STATS_KEY',
      statsAfter && statsAfter['https://example.com/abp-test-source.txt'], statsAfter);
    check('_fetchAndConvertUrls: that entry correctly shows 1 converted + 1 procedural-skipped',
      statsAfter['https://example.com/abp-test-source.txt'].converted === 1 &&
      statsAfter['https://example.com/abp-test-source.txt'].procedural === 1,
      statsAfter);

    // A source that's native (not ABP) format must NOT get a stats entry —
    // and a STALE entry from a PREVIOUS fetch (e.g. the source used to be
    // ABP-format, or the URL used to point somewhere else) must be cleared,
    // not left behind to misrepresent the current fetch.
    await chromeStub.storage.local.set({
      [T.RULE_SOURCE_STATS_KEY]: { 'https://remote.test/site-rules.txt': { total: 5, converted: 5 } },
    });
    await T._fetchAndConvertUrls(['https://remote.test/site-rules.txt']); // native format — see fetchStub's site-rules.txt branch
    const { [T.RULE_SOURCE_STATS_KEY]: statsAfterNative } = await chromeStub.storage.local.get(T.RULE_SOURCE_STATS_KEY);
    check('_fetchAndConvertUrls: a native-format source has no stats entry, and a stale prior one is cleared',
      !statsAfterNative['https://remote.test/site-rules.txt'], statsAfterNative);

    await chromeStub.storage.local.set({ [T.RULE_SOURCE_STATS_KEY]: {} }); // leave state clean
  }

  // 25e. End-to-end through fetchRemoteRuleText(): a Rule Source URL serving
  // raw ABP text gets converted before merging, instead of silently
  // contributing nothing (the pre-existing behavior parseRuleText() has for
  // unconverted ABP text — it recognizes neither `!` comments nor bracketless
  // key=value lines, so the whole source used to parse to nothing).
  stubAbpSourceText = [
    '! Title: E2E Test List',
    'e2eabptest.com##.popup-ad',
    '||e2eabpnetwork.com^',
  ].join('\n');
  await chromeStub.storage.local.set({
    ruleSources: [{ id: 'abp-e2e', type: 'url', url: 'https://example.com/abp-test-source.txt', enabled: true }],
    defaultRuleSourceEnabled: false, // isolate to just this one source's output
  });
  const e2eMerged = await T.fetchRemoteRuleText();
  check('fetchRemoteRuleText: ABP-format Rule Source URL converted and merged in (cosmetic selector present)',
    e2eMerged.includes('.popup-ad'), e2eMerged);
  check('fetchRemoteRuleText: ABP-format Rule Source URL converted and merged in (network domain present)',
    e2eMerged.includes('e2eabpnetwork.com') && e2eMerged.includes('ad_network_patterns'), e2eMerged);
  await chromeStub.storage.local.set({ ruleSources: [], defaultRuleSourceEnabled: true }); // reset for any later section

  // 25h. Disabling the default Rule Source must mean ZERO default rules —
  // not a silent fallback to the bundled local site-rules.txt (which is
  // effectively the same content, so the toggle used to have no visible
  // effect: "tôi tắt Rule Source nhưng không có tác dụng", 2026-08-22).
  await chromeStub.storage.local.set({ ruleSources: [], customRulesText: '', defaultRuleSourceEnabled: false });
  const allDisabledMerged = await T.fetchRemoteRuleText();
  check('fetchRemoteRuleText: default disabled + no other source -> empty (no local-file fallback), not thrown',
    allDisabledMerged === '', allDisabledMerged);

  // But a genuine fetch failure (default enabled, remote unreachable) must
  // still throw so getRulesText()'s catch branch can fall back to
  // cached/local rules for resilience — that behavior is untouched.
  await chromeStub.storage.local.set({ ruleSources: [], customRulesText: '', defaultRuleSourceEnabled: true });
  stubRulesRemoteUnreachable = true;
  let threwOnRealFailure = false;
  try { await T.fetchRemoteRuleText(); } catch { threwOnRealFailure = true; }
  stubRulesRemoteUnreachable = false;
  check('fetchRemoteRuleText: a genuine fetch failure (default enabled) still throws, unlike a deliberately-empty config',
    threwOnRealFailure);
  await chromeStub.storage.local.set({ ruleSources: [], defaultRuleSourceEnabled: true }); // reset for any later section

  console.log('\n== 25i. ABP header detection + reentrancy deadlock regression (2026-08-22) ==');

  // Every standard ABP filter list (EasyList, EasyPrivacy, ...) is REQUIRED
  // to start with "[Adblock Plus 2.0]" — a format-version marker, not a
  // section header — but it starts with '[' just like this repo's own
  // [section] syntax, so _looksLikeAbpFormat used to misdetect it as
  // "already native" and skip conversion of the entire file, silently.
  check('_looksLikeAbpFormat: standard "[Adblock Plus 2.0]" version header line -> still true (real-world EasyList/EasyPrivacy always start with this)',
    T._looksLikeAbpFormat('[Adblock Plus 2.0]\n! Title: Test\n||realtracker.com^') === true);
  const easylistStyleSnippet = ['[Adblock Plus 2.0]', '! Title: Test List', '||abpheadertest.com^'].join('\n');
  const headerConverted = await T._maybeConvertAbpText(easylistStyleSnippet);
  check('_maybeConvertAbpText: a file starting with the "[Adblock Plus 2.0]" header still gets converted (previously silently skipped as "already native")',
    headerConverted.includes('ad_network_patterns') && headerConverted.includes('abpheadertest.com'), headerConverted);

  // Reentrancy deadlock: _maybeConvertAbpText()'s dedup lookup used to call
  // getParsedRules(), which — on a cold cache — re-enters
  // fetchRemoteRuleText(), which calls _maybeConvertAbpText() again for the
  // SAME in-flight source, awaiting a promise that can only resolve once
  // this very call returns. reloadRules() resets the in-memory parsed-rules
  // cache the same way a real "toggle a Rule Source" does, reproducing a
  // genuinely cold start. Guarded with a timeout so a regression fails
  // loudly instead of hanging the whole test run forever — this is the
  // real-world "tôi tắt rồi bật lại default source, youtube không load
  // rule" report, root-caused to this deadlock (2026-08-22).
  function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TIMEOUT: ' + label)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
  stubAbpSourceText = '! t\n||deadlocktest.com^';
  await chromeStub.storage.local.set({
    ruleSources: [{ id: 'deadlock-e2e', type: 'url', url: 'https://example.com/abp-test-source.txt', enabled: true }],
    defaultRuleSourceEnabled: false,
  });
  await T.reloadRules(); // cold-starts the in-memory parsed-rules cache, like a real toggle does
  let deadlockText = null, deadlockError = null;
  try {
    deadlockText = await withTimeout(T.fetchRemoteRuleText(), 5000, 'fetchRemoteRuleText() with a cold parsed-rules cache + an ABP-format Rule Source');
  } catch (e) { deadlockError = e; }
  check('fetchRemoteRuleText: does not deadlock on a cold parsed-rules cache with an ABP-format Rule Source (previously hung forever)',
    deadlockError === null, deadlockError && deadlockError.message);
  check('fetchRemoteRuleText: the ABP source actually converted while cold',
    !!deadlockText && deadlockText.includes('deadlocktest.com'), deadlockText);
  await chromeStub.storage.local.set({ ruleSources: [], defaultRuleSourceEnabled: true });
  await T.reloadRules(); // leave state clean for any later section

  console.log('\n== 25j. Rule Source fetch errors recorded unconditionally (2026-08-22) ==');

  // A source that 404s must show up in RULE_SOURCE_ERRORS_KEY — this is what
  // the dashboard's Rule Source page reads to show an inline "⚠ HTTP 404"
  // next to the row, instead of the silent nothing this used to be.
  await chromeStub.storage.local.set({
    ruleSources: [{ id: 'err-e2e', type: 'url', url: 'https://example.com/broken-source.txt', enabled: true }],
    defaultRuleSourceEnabled: false,
  });
  // A source that 404s with nothing else enabled IS a genuine fetch
  // failure (see 25h above) — fetchRemoteRuleText() correctly throws so
  // getRulesText()'s caller can fall back; the error-recording happens
  // before that throw, so it's still there to check afterward.
  try { await T.fetchRemoteRuleText(); } catch {}
  let { [T.RULE_SOURCE_ERRORS_KEY]: errAfterFail } = await chromeStub.storage.local.get(T.RULE_SOURCE_ERRORS_KEY);
  check('fetchRemoteRuleText: a 404 source is recorded into RULE_SOURCE_ERRORS_KEY',
    !!(errAfterFail && errAfterFail['https://example.com/broken-source.txt']), errAfterFail);

  // Once that same URL succeeds, its stale error entry must be cleared —
  // otherwise a fixed source would keep showing a warning forever.
  stubAbpSourceText = '! t\n||clearedafterfix.com^';
  await chromeStub.storage.local.set({
    ruleSources: [{ id: 'err-e2e', type: 'url', url: 'https://example.com/abp-test-source.txt', enabled: true }],
  });
  // Prime the "was broken" entry under the URL this test now reuses, so the
  // clear-on-success behavior actually has something to clear.
  await chromeStub.storage.local.set({ [T.RULE_SOURCE_ERRORS_KEY]: { 'https://example.com/abp-test-source.txt': 'HTTP 404' } });
  await T.fetchRemoteRuleText();
  let { [T.RULE_SOURCE_ERRORS_KEY]: errAfterFix } = await chromeStub.storage.local.get(T.RULE_SOURCE_ERRORS_KEY);
  check('fetchRemoteRuleText: a previously-failing source that now succeeds has its error cleared',
    !errAfterFix || !errAfterFix['https://example.com/abp-test-source.txt'], errAfterFix);
  await chromeStub.storage.local.set({ ruleSources: [], defaultRuleSourceEnabled: true, [T.RULE_SOURCE_ERRORS_KEY]: {} });
  await T.reloadRules(); // leave state clean for any later section

  console.log('\n== 25k. rpnt/trusted-rpnt now map to trusted_replace_script_text, not replace_node_text (2026-08-22) ==');

  // rpnt/trusted-rpnt/replace-node-text are "requires trust" in real uBO
  // (aliases of trusted-replace-node-text.js) — they need the pre-execution
  // insertion hook (trusted_replace_script_text), not the post-insertion
  // MutationObserver (replace_node_text), which is too late for a
  // synchronous inline <script>. Real uBO rules trail "sedCount, N" /
  // "excludes, X" as bare pairs AFTER the replacement — reordered here into
  // "nodeName, pattern, sedCount=N, excludes=X, replacement" (extras BEFORE
  // the unbounded replacement) so the content-script side can peel them off
  // the front safely regardless of how many commas the replacement itself
  // contains. Uses \, escaping here; the quoted-string convention (the
  // OTHER real uAssets shape) is covered separately below.
  const rpntSnippet = [
    '! t',
    'example.com##+js(rpnt, script, (function serverContract(), (()=>{const e=1\\,t=2;console.log(e\\,t)})();(function serverContract(), sedCount, 1, excludes, MutationObserver)',
  ].join('\n');
  const rpntConverted = await T._maybeConvertAbpText(rpntSnippet);
  check('rpnt converts to trusted_replace_script_text, not replace_node_text',
    rpntConverted.includes('trusted_replace_script_text') && !rpntConverted.includes('replace_node_text ='),
    rpntConverted);
  check('rpnt: sedCount/excludes reordered to prefixed extras BEFORE the replacement',
    rpntConverted.includes('sedCount=1, excludes=MutationObserver,'), rpntConverted);
  check('rpnt: replacement itself keeps its internal (unescaped) commas intact',
    rpntConverted.includes('console.log(e,t)'), rpntConverted);

  // Same rule, real uAssets alternative convention: replacement wrapped in
  // a leading quote with UNESCAPED internal commas, instead of \, escaping
  // — both conventions appear across real uAssets filter revisions.
  const rpntQuotedSnippet = [
    '! t',
    "example.com##+js(rpnt, script, (function serverContract(), '(()=>{const e=1,t=2;console.log(e,t)})();(function serverContract()', sedCount, 1, excludes, MutationObserver)",
  ].join('\n');
  const rpntQuotedConverted = await T._maybeConvertAbpText(rpntQuotedSnippet);
  check('rpnt (quoted-string replacement): converts to trusted_replace_script_text with extras in place',
    rpntQuotedConverted.includes('sedCount=1, excludes=MutationObserver,'), rpntQuotedConverted);
  check('rpnt (quoted-string replacement): internal commas preserved, quotes stripped',
    rpntQuotedConverted.includes('console.log(e,t)') && !rpntQuotedConverted.includes("'(()=>"), rpntQuotedConverted);

  // '#@#+js(...)' (exception-syntax scriptlet injection, real uBO
  // convention for a scriptlet other exception rules can't cancel) is
  // handled the same as '##+js(...)' — this repo's dispatch has no
  // cancellation model either way, so the distinction is moot. A PLAIN
  // '#@#selector' cosmetic exception (no +js) is still dropped — there's
  // no equivalent for cancelling a hide rule here.
  const excJsSnippet = [
    '! t',
    'example.com#@#+js(rpnt, script, needle(), sedCount, 1)',
    'example.com#@#.some-selector-that-should-still-be-dropped',
  ].join('\n');
  const excJsConverted = await T._maybeConvertAbpText(excJsSnippet);
  check('#@#+js(rpnt, ...): scriptlet injection via exception syntax still converts',
    excJsConverted.includes('trusted_replace_script_text') && excJsConverted.includes('needle()'), excJsConverted);
  check('#@#.selector (plain cosmetic exception, no +js): still dropped, no cancellation model',
    !excJsConverted.includes('some-selector-that-should-still-be-dropped'), excJsConverted);

  console.log('\n== 25l. Skip updateDynamicRules() when the rule set is unchanged (2026-08-22) ==');

  // applyNetworkRules() ran unconditionally on every SW cold start
  // (onStartup) even when nothing changed — updateDynamicRules() forces
  // Chrome's own DNR engine to re-index the whole rule set from scratch,
  // the most expensive part of the pipeline. A second call with an
  // IDENTICAL config must not repeat that IPC round trip.
  await chromeStub.storage.local.set({ blockAds: true, blockTrackers: true, blockMalware: true, paused: false });
  await T.applyNetworkRules();
  const callsAfterFirst = updateDynamicRulesCallCount;
  await T.applyNetworkRules();
  check('applyNetworkRules: second call with an unchanged rule set skips updateDynamicRules entirely',
    updateDynamicRulesCallCount === callsAfterFirst,
    `calls after 1st: ${callsAfterFirst}, after 2nd: ${updateDynamicRulesCallCount}`);

  // A REAL config change (blockTrackers off) must still register — the
  // skip is content-derived, not a blanket "only once ever" latch.
  await chromeStub.storage.local.set({ blockTrackers: false });
  await T.applyNetworkRules();
  check('applyNetworkRules: a genuine config change still calls updateDynamicRules',
    updateDynamicRulesCallCount > callsAfterFirst,
    `calls after change: ${updateDynamicRulesCallCount}`);
  await chromeStub.storage.local.set({ blockTrackers: true }); // restore for any later section
  await T.applyNetworkRules();

  console.log('\n== 25f. network_redirect_rules — path-scoped $redirect=/$redirect-rule= rules the plain ad_network_patterns parser used to drop entirely (2026-08-22) ==');

  // Resolver: canonical name, known alias, ":priority" suffix stripped,
  // unrecognized name -> undefined (drops the rule, doesn't guess).
  check('_resolveRedirectResourceName: canonical filename resolves to itself', T._resolveRedirectResourceName('noop.js') === 'noop.js');
  check('_resolveRedirectResourceName: known alias resolves to the real shipped file', T._resolveRedirectResourceName('noopjs') === 'noop.js');
  check('_resolveRedirectResourceName: ":priority" suffix stripped before lookup', T._resolveRedirectResourceName('noopjs:5') === 'noop.js');
  check('_resolveRedirectResourceName: unrecognized name -> undefined (not guessed at)', T._resolveRedirectResourceName('some-resource-nobody-ships') === undefined);

  console.log('\n== 25g. REDIRECT_RESOURCE_FILES — new stub files added 2026-08-22 (one alias sampled per tier) ==');
  check('_resolveRedirectResourceName: noop.css (static placeholder tier)', T._resolveRedirectResourceName('noop.css') === 'noop.css');
  check('_resolveRedirectResourceName: 2x2-transparent.png alias -> 2x2.png', T._resolveRedirectResourceName('2x2-transparent.png') === '2x2.png');
  check('_resolveRedirectResourceName: noopvast-2.0 alias -> noop-vast2.xml', T._resolveRedirectResourceName('noopvast-2.0') === 'noop-vast2.xml');
  check('_resolveRedirectResourceName: google-analytics.com/ga.js alias -> google-analytics_ga.js (API-mimic tier)', T._resolveRedirectResourceName('google-analytics.com/ga.js') === 'google-analytics_ga.js');
  check('_resolveRedirectResourceName: fuckadblock-3.2.0.js alias -> nofab.js (fake-API tier)', T._resolveRedirectResourceName('fuckadblock-3.2.0.js') === 'nofab.js');
  check('_resolveRedirectResourceName: popads.net alias -> popads.js', T._resolveRedirectResourceName('popads.net') === 'popads.js');
  check('_resolveRedirectResourceName: prebid alias -> prebid-ads.js', T._resolveRedirectResourceName('prebid') === 'prebid-ads.js');
  check('_resolveRedirectResourceName: hd-main.js (niche no-op tier, no aliases)', T._resolveRedirectResourceName('hd-main.js') === 'hd-main.js');

  // Parser: the exact real-world rule shapes from a BBC filter list —
  // bare-domain exception (@@) dropped, path-scoped $redirect= now converted
  // instead of dropped, a scriptlet call on the same domains still converts too.
  const bbcSnippet = [
    '@@||imasdk.googleapis.com/js/sdkloader/ima3_dai.js$script,domain=kcra.com|wcvb.com',
    '||imasdk.googleapis.com/js/sdkloader/ima3.js$script,redirect=google-ima.js,domain=kcra.com|wcvb.com',
    'kcra.com,wcvb.com##+js(set, google.ima.settings.setDisableFlashAds, noopFunc)',
  ].join('\n');
  const bbcConverted = await T._maybeConvertAbpText(bbcSnippet);
  check('_maybeConvertAbpText: path-scoped $redirect= now converted to network_redirect_rules (previously dropped entirely)',
    bbcConverted.includes('network_redirect_rules') && bbcConverted.includes('imasdk.googleapis.com/js/sdkloader/ima3.js') && bbcConverted.includes('google-ima.js'),
    bbcConverted);
  check('_maybeConvertAbpText: the @@ exception line still contributes nothing (no equivalent here)',
    !bbcConverted.includes('ima3_dai'), bbcConverted);
  check('_maybeConvertAbpText: the scriptlet call on the same domains still converts (set_constant)',
    bbcConverted.includes('set_constant') && bbcConverted.includes('setDisableFlashAds'), bbcConverted);

  // A redirect= modifier pointing at a resource name this extension has no
  // matching file for is dropped, same as any other unsupported modifier.
  const unresolvableRedirect = await T._maybeConvertAbpText('||example.com/ads/x.js$script,redirect=some-resource-nobody-ships');
  check('_maybeConvertAbpText: redirect= to an unresolvable resource name is dropped, not guessed at',
    !unresolvableRedirect.includes('network_redirect_rules'), unresolvableRedirect);

  // Builder: path pattern -> urlFilter condition; bare domain pattern ->
  // requestDomains condition; unresolvable resource name drops the entry.
  const redirectEntries = [
    'imasdk.googleapis.com/js/sdkloader/ima3.js google-ima.js',
    'tracker.example.com noopjs', // bare domain — still valid, just uses requestDomains instead
    'example.com/bad.js some-resource-nobody-ships', // unresolvable — dropped
  ];
  const builtRedirectRules = T.buildNetworkRedirectRules(redirectEntries, T.NETWORK_REDIRECT_RULE_ID_START);
  check('buildNetworkRedirectRules: unresolvable resource name drops the entry entirely', builtRedirectRules.length === 2, JSON.stringify(builtRedirectRules));
  const pathRule = builtRedirectRules.find(r => r.condition.urlFilter);
  check('buildNetworkRedirectRules: path pattern -> urlFilter condition + redirect action to the real file',
    !!pathRule && pathRule.condition.urlFilter === '||imasdk.googleapis.com/js/sdkloader/ima3.js' &&
    pathRule.action.type === 'redirect' && pathRule.action.redirect.url.includes('google-ima.js'),
    JSON.stringify(pathRule));
  const domainRule = builtRedirectRules.find(r => r.condition.requestDomains);
  check('buildNetworkRedirectRules: bare domain pattern -> requestDomains condition',
    !!domainRule && domainRule.condition.requestDomains[0] === 'tracker.example.com', JSON.stringify(domainRule));
  check('buildNetworkRedirectRules: IDs start at NETWORK_REDIRECT_RULE_ID_START, dense',
    builtRedirectRules[0].id === T.NETWORK_REDIRECT_RULE_ID_START && builtRedirectRules[1].id === T.NETWORK_REDIRECT_RULE_ID_START + 1,
    JSON.stringify(builtRedirectRules.map(r => r.id)));

  console.log('\n== 25w. _isValidUrlFilter() matches Chrome DNR\'s documented urlFilter constraints (2026-08-24) ==');
  // Live-reported: adding a third-party ABP list (uAssets annoyances-others.txt)
  // threw "Rule with id 500009 specifies an incorrect value for the urlFilter
  // key" — updateDynamicRules() is atomic, so one bad rule from ANY enabled
  // source used to reject the WHOLE call, breaking every rule this extension
  // has, default site-rules.txt included. buildNetworkRedirectRules()/
  // buildQueryStripRules() now validate before ever handing Chrome a
  // urlFilter/requestDomains built from arbitrary third-party ABP text.
  check('valid: plain domain+path with single || anchor', T._isValidUrlFilter('||example.com/path/to/file.js') === true);
  check('valid: single leading | (start-of-url anchor)', T._isValidUrlFilter('|https://example.com/x') === true);
  check('valid: single trailing | (end-of-url anchor)', T._isValidUrlFilter('example.com/x|') === true);
  check('valid: wildcard + separator chars', T._isValidUrlFilter('||example.com^*/ads/*') === true);
  check('invalid: empty string', T._isValidUrlFilter('') === false);
  check('invalid: null/undefined', T._isValidUrlFilter(null) === false && T._isValidUrlFilter(undefined) === false);
  check('invalid: "||*" prefix is explicitly disallowed by Chrome', T._isValidUrlFilter('||*/ads/') === false);
  check('invalid: a stray "|" in the middle of the pattern', T._isValidUrlFilter('example.com/a|b/c') === false);
  check('invalid: non-ASCII characters', T._isValidUrlFilter('||exämple.com/path') === false);

  console.log('\n== 25x. buildNetworkRedirectRules/buildQueryStripRules drop entries that would reject the WHOLE updateDynamicRules() call ==');
  const malformedRedirectEntries = [
    'imasdk.googleapis.com/js/sdkloader/ima3.js google-ima.js', // valid — kept
    '*|bad/x.js noopjs', // stray '|' mid-pattern — must be dropped, not passed to Chrome
    'tracker.example.com noopjs', // valid bare domain — kept
  ];
  const builtWithMalformed = T.buildNetworkRedirectRules(malformedRedirectEntries, T.NETWORK_REDIRECT_RULE_ID_START);
  check('buildNetworkRedirectRules: malformed urlFilter entry is dropped, valid ones survive',
    builtWithMalformed.length === 2 && builtWithMalformed.every(r => T._isValidUrlFilter(r.condition.urlFilter || '||x')),
    JSON.stringify(builtWithMalformed));

  const malformedStripEntries = [
    'youtube.com/watch si,is', // valid path pattern — kept
    '*|bad/x.js si', // stray '|' — must be dropped
    'example.com si', // valid bare domain — kept
  ];
  const builtStripWithMalformed = T.buildQueryStripRules(malformedStripEntries, 3000);
  check('buildQueryStripRules: malformed urlFilter entry is dropped, valid ones survive',
    builtStripWithMalformed.length === 2 && builtStripWithMalformed.every(r => !r.condition.urlFilter || T._isValidUrlFilter(r.condition.urlFilter)),
    JSON.stringify(builtStripWithMalformed));

  console.log('\n== 25m. Language-matched default Rule Source auto-enable on fresh install (2026-08-22) ==');

  stubUILanguage = 'vi';
  check('_uiLanguageMatches: browser "vi" matches entry lang "vi"', T._uiLanguageMatches('vi') === true);
  stubUILanguage = 'vi-VN';
  check('_uiLanguageMatches: browser "vi-VN" (region variant) matches entry lang "vi"', T._uiLanguageMatches('vi') === true);
  stubUILanguage = 'en-US';
  check('_uiLanguageMatches: browser "en-US" does NOT match entry lang "vi"', T._uiLanguageMatches('vi') === false);
  stubUILanguage = 'vie'; // not a real Chrome locale, but must not false-positive on a naive substring check
  check('_uiLanguageMatches: "vie" does not falsely match "vi" (no dash boundary)', T._uiLanguageMatches('vi') === false);

  // Real-world case that motivated this fallback: Chrome's own menu/UI
  // display language (getUILanguage()) set to English while the user's
  // actual preferred/content language (navigator.language,
  // chrome://settings/languages — a separate setting) is Vietnamese. uBO's
  // own detection only checks getUILanguage() and would miss this too; this
  // repo intentionally goes further.
  stubUILanguage = 'en-US';
  sandbox.navigator.language = 'vi-VN';
  check('_uiLanguageMatches: getUILanguage="en-US" but navigator.language="vi-VN" -> still matches "vi"',
    T._uiLanguageMatches('vi') === true);
  delete sandbox.navigator.language;
  sandbox.navigator.languages = ['fr-FR', 'vi'];
  check('_uiLanguageMatches: a match anywhere in navigator.languages[] (not just index 0) counts',
    T._uiLanguageMatches('vi') === true);
  delete sandbox.navigator.languages;
  check('_uiLanguageMatches: back to getUILanguage-only ("en-US") -> no match, no leftover fallback state',
    T._uiLanguageMatches('vi') === false);

  stubUILanguage = 'vi-VN';
  // Simulate a pre-existing fresh cache (the exact scenario that was
  // silently broken: an already-running install whose cache stays fresh for
  // up to 6h would never pick up the newly-enabled source without this).
  await chromeStub.storage.local.set({
    defaultRuleSourceOverrides: {},
    siteRulesCacheText: '[global]\nad_network_patterns = stale-cached.example\n',
    siteRulesCacheTime: Date.now(),
  });
  await T._autoEnableLangDefaultSources();
  let { defaultRuleSourceOverrides: afterVi, siteRulesCacheText: cacheAfterVi, siteRulesCacheTime: cacheTimeAfterVi } =
    await chromeStub.storage.local.get(['defaultRuleSourceOverrides', 'siteRulesCacheText', 'siteRulesCacheTime']);
  check('_autoEnableLangDefaultSources: vi-VN browser auto-enables the "vi"-tagged default source',
    afterVi && afterVi['https://raw.githubusercontent.com/abpvn/abpvn/master/filter/abpvn_ublock.txt'] === true,
    afterVi);
  check('_autoEnableLangDefaultSources: a real match busts the stale rules cache so it takes effect immediately',
    cacheAfterVi === '' && cacheTimeAfterVi === 0,
    { cacheAfterVi, cacheTimeAfterVi });

  stubUILanguage = 'en-US';
  await chromeStub.storage.local.set({ defaultRuleSourceOverrides: {} });
  await T._autoEnableLangDefaultSources();
  let { defaultRuleSourceOverrides: afterEn } = await chromeStub.storage.local.get('defaultRuleSourceOverrides');
  check('_autoEnableLangDefaultSources: en-US browser leaves the "vi"-tagged default source untouched',
    !afterEn || afterEn['https://raw.githubusercontent.com/abpvn/abpvn/master/filter/abpvn_ublock.txt'] === undefined,
    afterEn);

  // A user who already explicitly turned the matched source OFF must not
  // have that choice silently overwritten by a later call — this now runs
  // on EVERY onInstalled fire (every extension update, every dev reload),
  // not just a one-time fresh install, so idempotency here is load-bearing.
  stubUILanguage = 'vi-VN';
  await chromeStub.storage.local.set({
    defaultRuleSourceOverrides: { 'https://raw.githubusercontent.com/abpvn/abpvn/master/filter/abpvn_ublock.txt': false },
  });
  await T._autoEnableLangDefaultSources();
  let { defaultRuleSourceOverrides: afterExplicitOff } = await chromeStub.storage.local.get('defaultRuleSourceOverrides');
  check('_autoEnableLangDefaultSources: an existing explicit override is never overwritten',
    afterExplicitOff['https://raw.githubusercontent.com/abpvn/abpvn/master/filter/abpvn_ublock.txt'] === false,
    afterExplicitOff);

  await chromeStub.storage.local.set({ defaultRuleSourceOverrides: {} }); // leave state clean for any later section
  stubUILanguage = 'en-US';

  console.log('\n== 25o. _dedupeMalwarePriority: malware wins DNR same-priority redirect tie-break (2026-08-23) ==');
  // A domain in BOTH malwareNetworkDomains and adNetworkPatterns/
  // trackerNetworkPatterns would otherwise produce two main_frame redirect
  // rules at the same DNR priority (2) with different targets
  // (blocked.html?h= vs ?t=ad&h=) — Chrome's tie-break there is
  // unspecified. Malware must always win, resolved before it ever reaches
  // Chrome's own rule set.
  const dedupInput = {
    adNetworkPatterns: ['ads.example.com', 'evil-overlap.com', 'clean-ad.com'],
    trackerNetworkPatterns: ['tracker.example.com', 'EVIL-OVERLAP.COM', 'clean-tracker.com'],
    malwareNetworkDomains: ['evil-overlap.com', 'other-malware.com'],
    adPatterns: ['adpattern'],
    trackerPatterns: ['trackerpattern'],
    malwarePatterns: ['malwarepattern'],
  };
  const deduped = T._dedupeMalwarePriority(dedupInput);
  check('_dedupeMalwarePriority: a domain also flagged as malware is removed from adNetworkPatterns',
    !deduped.adNetworkPatterns.includes('evil-overlap.com'), deduped.adNetworkPatterns);
  check('_dedupeMalwarePriority: case-insensitive — trackerNetworkPatterns\' differently-cased duplicate is also removed',
    !deduped.trackerNetworkPatterns.some(d => d.toLowerCase() === 'evil-overlap.com'), deduped.trackerNetworkPatterns);
  check('_dedupeMalwarePriority: non-overlapping ad domains are untouched',
    deduped.adNetworkPatterns.includes('ads.example.com') && deduped.adNetworkPatterns.includes('clean-ad.com'), deduped.adNetworkPatterns);
  check('_dedupeMalwarePriority: non-overlapping tracker domains are untouched',
    deduped.trackerNetworkPatterns.includes('tracker.example.com') && deduped.trackerNetworkPatterns.includes('clean-tracker.com'), deduped.trackerNetworkPatterns);
  check('_dedupeMalwarePriority: malwareNetworkDomains itself is never touched',
    deduped.malwareNetworkDomains.length === 2 && deduped.malwareNetworkDomains.includes('evil-overlap.com') && deduped.malwareNetworkDomains.includes('other-malware.com'),
    deduped.malwareNetworkDomains);
  check('_dedupeMalwarePriority: unrelated keyword-pattern fields pass through unchanged',
    deduped.adPatterns[0] === 'adpattern' && deduped.trackerPatterns[0] === 'trackerpattern' && deduped.malwarePatterns[0] === 'malwarepattern',
    deduped);

  const noOverlapInput = {
    adNetworkPatterns: ['ads.example.com'],
    trackerNetworkPatterns: ['tracker.example.com'],
    malwareNetworkDomains: ['malware.example.com'],
    adPatterns: [], trackerPatterns: [], malwarePatterns: [],
  };
  const noOverlapResult = T._dedupeMalwarePriority(noOverlapInput);
  check('_dedupeMalwarePriority: no overlap -> ad/tracker lists pass through unchanged',
    noOverlapResult.adNetworkPatterns.length === 1 && noOverlapResult.trackerNetworkPatterns.length === 1,
    noOverlapResult);

  console.log('\n== 25p. resolveSiteKey(): indexed rewrite preserves exact matching semantics (2026-08-23) ==');
  // Was a linear scan testing every pattern against the host; now an
  // exact-match index + a small complex-pattern fallback list. These tests
  // cover every LHS shape the old regex-based scan supported, plus the
  // first-insertion-order-wins tie-break the old early-return loop gave for
  // free and the index has to reconstruct explicitly.
  const rskPatterns = {
    'plainsite.example': ['plain_key'],
    'sub.exactmatch.example': ['exact_sub_key'],
    'amazon.*': ['wildcard_key'],
    '/(^|\\.)fmovies[a-z0-9-]*\\./': ['regex_key'],
    'multi-a.example|multi-b.example': ['multi_key'],
  };
  check('resolveSiteKey: exact domain match', T.resolveSiteKey(rskPatterns, 'plainsite.example') === 'plain_key');
  check('resolveSiteKey: subdomain of a plain domain pattern matches (walks the suffix chain)',
    T.resolveSiteKey(rskPatterns, 'www.plainsite.example') === 'plain_key');
  check('resolveSiteKey: a pattern that IS itself a subdomain only matches that subdomain, not the bare parent',
    T.resolveSiteKey(rskPatterns, 'exactmatch.example') === '');
  check('resolveSiteKey: ...but does match a deeper subdomain of it',
    T.resolveSiteKey(rskPatterns, 'a.sub.exactmatch.example') === 'exact_sub_key');
  check('resolveSiteKey: wildcard-TLD pattern matches any TLD (complex-list fallback)',
    T.resolveSiteKey(rskPatterns, 'amazon.co.uk') === 'wildcard_key');
  check('resolveSiteKey: raw regex pattern matches (complex-list fallback)',
    T.resolveSiteKey(rskPatterns, 'ww4.fmovies-mirror.co') === 'regex_key');
  check('resolveSiteKey: multi-domain "a|b" pattern matches EITHER side',
    T.resolveSiteKey(rskPatterns, 'multi-a.example') === 'multi_key' &&
    T.resolveSiteKey(rskPatterns, 'multi-b.example') === 'multi_key');
  check('resolveSiteKey: no pattern matches -> empty string, not throwing', T.resolveSiteKey(rskPatterns, 'totally-unrelated.example') === '');

  // First-insertion-order-wins: object key order IS the tie-break — a
  // later-inserted pattern that also matches must never win over an
  // earlier one, across exact AND complex patterns, in both directions.
  const rskOrderA = { 'ordertest.example': ['first'], 'sub.ordertest.example': ['second'] };
  check('resolveSiteKey: earlier plain pattern wins over a later, more-specific one that also matches',
    T.resolveSiteKey(rskOrderA, 'sub.ordertest.example') === 'first');
  const rskOrderB = { '/ordertest2/': ['regex_first'], 'ordertest2.example': ['plain_second'] };
  check('resolveSiteKey: an earlier COMPLEX pattern still beats a later plain/exact one',
    T.resolveSiteKey(rskOrderB, 'ordertest2.example') === 'regex_first');
  const rskOrderC = { 'ordertest3.example': ['plain_first'], '/ordertest3/': ['regex_second'] };
  check('resolveSiteKey: an earlier plain pattern still beats a later complex one that also matches',
    T.resolveSiteKey(rskOrderC, 'ordertest3.example') === 'plain_first');

  // Regression (2026-08-23), live-reported: a real-world EasyList "bucket"
  // line hides a common generic selector across ~150 unrelated sites on
  // ONE '|'-joined LHS — one of those sites (vnexpress.net) ALSO had its
  // own dedicated, more specific entry from a LATER-enabled source
  // (Vietnam — ABPVN List). Because the bucket was parsed FIRST (source
  // enabled/merged earlier), naive first-insertion-order-wins let the
  // generic bucket permanently shadow ABPVN's specific rules for that one
  // domain — ABPVN converted and loaded correctly, but was never reachable.
  // A dedicated single-domain entry must win regardless of source order.
  const rskBucket = {
    // The bucket comes FIRST in insertion order (earlier source).
    'unrelated-a.example|unrelated-b.example|target-site.example|unrelated-c.example': ['generic_bucket_key'],
    // The dedicated entry comes SECOND (later-enabled source) but must win.
    'target-site.example': ['specific_key'],
  };
  check('resolveSiteKey: a dedicated single-domain entry wins over an earlier multi-domain bucket that also lists it',
    T.resolveSiteKey(rskBucket, 'target-site.example') === 'specific_key');
  check('resolveSiteKey: the bucket entry still resolves normally for its OTHER (non-shadowed) domains',
    T.resolveSiteKey(rskBucket, 'unrelated-a.example') === 'generic_bucket_key');
  // Reverse order — the fix must be order-independent, not just "second
  // entry wins": specificity decides, not merely being the SPECIFIC entry
  // itself parsed later.
  const rskBucketReversed = {
    'target-site2.example': ['specific_key2'],
    'unrelated-x.example|target-site2.example|unrelated-y.example': ['generic_bucket_key2'],
  };
  check('resolveSiteKey: order-independent — the dedicated entry still wins even when the bucket comes SECOND',
    T.resolveSiteKey(rskBucketReversed, 'target-site2.example') === 'specific_key2');
  // Two buckets, no dedicated entry at all — falls back to normal
  // first-insertion-order-wins between them (no specific entry to prefer).
  const rskTwoBuckets = {
    'a.example|shared.example': ['bucket_one'],
    'shared.example|b.example': ['bucket_two'],
  };
  check('resolveSiteKey: with no dedicated entry, ties between two buckets still resolve by insertion order',
    T.resolveSiteKey(rskTwoBuckets, 'shared.example') === 'bucket_one');

  // Cache correctness: the SAME `patterns` object reused across calls (as
  // getParsedRules()'s cached parse result is) must resolve consistently,
  // and a DIFFERENT object with the same shape must not share/leak the
  // first object's cached index.
  const rskShared = { 'cachetest.example': ['cached_key'] };
  check('resolveSiteKey: repeated calls on the same patterns object stay consistent (index cache correctness)',
    T.resolveSiteKey(rskShared, 'cachetest.example') === 'cached_key' &&
    T.resolveSiteKey(rskShared, 'cachetest.example') === 'cached_key');
  const rskFresh = { 'cachetest.example': ['different_key_different_object'] };
  check('resolveSiteKey: a DIFFERENT patterns object with the same key is resolved independently, not from a stale cache',
    T.resolveSiteKey(rskFresh, 'cachetest.example') === 'different_key_different_object');

  console.log('\n== 25q. Shared usedKeys across sources prevents cross-source [host_patterns] key collisions (2026-08-23) ==');
  // Two SEPARATE Rule Sources (converted via two separate _maybeConvertAbpText
  // calls, exactly like _fetchAndConvertUrls does per-URL) that both happen
  // to lead with the same domain — one specific to it, one a generic bucket
  // sharing it with a totally unrelated domain. _abpSanitizeKey derives its
  // key purely from the leading domain name, so without a SHARED usedKeys
  // Set both calls independently mint the identical key and parseRuleText's
  // same-section merge collapses them into one, leaking the bucket's
  // unrelated-domain selectors onto the specific source's domain and vice
  // versa (confirmed against real EasyList+EasyPrivacy+ABPVN text: 10 such
  // collisions before this fix, 0 after).
  const collideSourceA = 'collidekey.example##.a-only-selector';
  const collideSourceB = 'collidekey.example,unrelated-domain.example##.b-bucket-selector';
  const sharedKeys25q = new Set();
  const convA = await T._maybeConvertAbpText(collideSourceA, undefined, sharedKeys25q);
  const convB = await T._maybeConvertAbpText(collideSourceB, undefined, sharedKeys25q);
  const parsedA = T.parseRuleText(convA);
  const parsedB = T.parseRuleText(convB);
  const keyA = T.resolveSiteKey(parsedA.host_patterns, 'collidekey.example');
  const keyB = T.resolveSiteKey(parsedB.host_patterns, 'collidekey.example');
  check('two sources sharing a leading domain get DIFFERENT generated keys when converted with a shared usedKeys Set',
    keyA && keyB && keyA !== keyB, JSON.stringify({ keyA, keyB }));
  const mergedAB = T.parseRuleText(convA + '\n' + convB);
  const mergedKeyForUnrelated = T.resolveSiteKey(mergedAB.host_patterns, 'unrelated-domain.example');
  check('merging both converted outputs: unrelated-domain.example does NOT resolve to source A\'s section',
    mergedKeyForUnrelated !== keyA,
    JSON.stringify({ mergedKeyForUnrelated, keyA }));
  check('merging both converted outputs: unrelated-domain.example does NOT pick up source A\'s selector',
    !(mergedAB[mergedKeyForUnrelated] && (mergedAB[mergedKeyForUnrelated].direct_hide_selectors || []).includes('.a-only-selector')),
    JSON.stringify(mergedAB[mergedKeyForUnrelated]));
  check('collidekey.example itself still keeps its OWN specific selector',
    (mergedAB[keyA].direct_hide_selectors || []).includes('.a-only-selector'),
    JSON.stringify(mergedAB[keyA]));

  console.log('\n== 25s. Shared dedicatedKeyMap merges two DIFFERENT sources\' rules for the SAME domain (2026-08-23) ==');
  // Opposite scenario from 25q: two SEPARATE sources each have their OWN
  // DEDICATED (single-domain, non-bucket) rule for the exact same domain.
  // resolveSiteKey()/_buildHostPatternIndex() only ever keep ONE key per
  // domain (patterns[pat][0] — first-wins), so without sharing a
  // dedicatedKeyMap the second source's own selector for that domain
  // silently never resolves at all (confirmed live: only source A's
  // selector was ever reachable). Passing the SAME Map across both calls
  // (mirroring how sharedUsedKeys is already threaded in production via
  // _fetchAndConvertUrls/fetchRemoteRuleText) makes the second source reuse
  // the first one's key, so parseRuleText's normal same-section merge
  // unions both selectors into one section instead.
  const dedupSourceA = 'news-site.example##.ad-slot-from-source-A';
  const dedupSourceB = 'news-site.example##.ad-slot-from-source-B';
  const sharedKeys25s = new Set();
  const sharedDedicated25s = new Map();
  const dedupConvA = await T._maybeConvertAbpText(dedupSourceA, undefined, sharedKeys25s, sharedDedicated25s);
  const dedupConvB = await T._maybeConvertAbpText(dedupSourceB, undefined, sharedKeys25s, sharedDedicated25s);
  const dedupMerged = T.parseRuleText(dedupConvA + '\n' + dedupConvB);
  const dedupKey = T.resolveSiteKey(dedupMerged.host_patterns, 'news-site.example');
  const dedupSelectors = (dedupMerged[dedupKey] && dedupMerged[dedupKey].direct_hide_selectors) || [];
  check('both sources\' selectors for the same domain end up in the SAME resolved section',
    dedupSelectors.includes('.ad-slot-from-source-A') && dedupSelectors.includes('.ad-slot-from-source-B'),
    JSON.stringify({ dedupKey, dedupSelectors }));
  check('only ONE [host_patterns] entry was minted for the domain, not two competing ones',
    dedupMerged.host_patterns['news-site.example'].length === 1,
    JSON.stringify(dedupMerged.host_patterns['news-site.example']));

  console.log('\n== 25t. ...but a dedicated rule must NOT merge into an unrelated BUCKET\'s key (regression guard) ==');
  // Without sharing sharedDedicatedKeyMap across a dedicated call and a
  // LATER bucket call for a domain the bucket also happens to list, the
  // dedicated key must still be minted fresh (never matched against a
  // bucket group) — otherwise the bucket's other, unrelated domains would
  // inherit the dedicated source's selector, reintroducing the exact leak
  // 25q/25s exist to prevent.
  const sk25t = new Set(); const sd25t = new Map();
  const dedicatedFirst = await T._maybeConvertAbpText('shared-target.example##.dedicated-only', undefined, sk25t, sd25t);
  const bucketSecond = await T._maybeConvertAbpText('shared-target.example,other-unrelated.example##.bucket-shared', undefined, sk25t, sd25t);
  const merged25t = T.parseRuleText(dedicatedFirst + '\n' + bucketSecond);
  const keyTarget = T.resolveSiteKey(merged25t.host_patterns, 'shared-target.example');
  const keyOther = T.resolveSiteKey(merged25t.host_patterns, 'other-unrelated.example');
  check('the dedicated source\'s own key still wins for shared-target.example (higher specificity)',
    (merged25t[keyTarget].direct_hide_selectors || []).includes('.dedicated-only'),
    JSON.stringify(merged25t[keyTarget]));
  check('other-unrelated.example (only in the bucket) does NOT inherit the dedicated selector',
    !((merged25t[keyOther] && merged25t[keyOther].direct_hide_selectors) || []).includes('.dedicated-only'),
    JSON.stringify(merged25t[keyOther]));

  console.log('\n== 25u. Compressed rule-cache storage (2026-08-24) ==');
  // A real user's merged siteRulesCacheText measured 6.97MB/119k lines —
  // ~70%+ of chrome.storage.local's ~10MB default quota on this ONE key.
  // Rule text is highly repetitive, so it's stored deflate-raw-compressed
  // (+base64, since chrome.storage JSON-serializes values) instead of plain.
  const repetitiveSample = Array(500).fill('[abp_site_x]\ndirect_hide_selectors = .ad-slot-marker-abcdefgh\n').join('');
  await T.setCachedRuleText(repetitiveSample);
  const storedRaw = storageData['siteRulesCacheText'];
  check('stored value is the {format,data} wrapper, not a bare string',
    storedRaw && typeof storedRaw === 'object' && typeof storedRaw.data === 'string',
    JSON.stringify(storedRaw).slice(0, 200));
  check('format is deflate-raw-b64 (CompressionStream available in this Node runtime)',
    storedRaw.format === 'deflate-raw-b64', storedRaw.format);
  check('compressed+base64 data is meaningfully smaller than the original text',
    storedRaw.data.length < repetitiveSample.length * 0.5,
    `original=${repetitiveSample.length} stored=${storedRaw.data.length}`);
  const roundTripped = await T.getCachedRuleText();
  check('getCachedRuleText() decompresses back to the EXACT original text',
    roundTripped && roundTripped.text === repetitiveSample,
    roundTripped && roundTripped.text.length);

  console.log('\n== 25v. Compressed cache: backward compat + corruption safety ==');
  storageData['siteRulesCacheText'] = 'a plain pre-existing string, written before 2026-08-24';
  const legacyRead = await T.getCachedRuleText();
  check('a pre-existing PLAIN STRING value (written before this change) still reads back correctly',
    legacyRead && legacyRead.text === 'a plain pre-existing string, written before 2026-08-24',
    legacyRead);
  storageData['siteRulesCacheText'] = { format: 'some-unknown-future-format', data: 'xyz' };
  const unknownFormatRead = await T.getCachedRuleText();
  check('an unrecognized format is treated as a cache miss (null), not a throw',
    unknownFormatRead === null, unknownFormatRead);
  storageData['siteRulesCacheText'] = { format: 'deflate-raw-b64', data: 'not-valid-base64-deflate-data!!!' };
  const corruptRead = await T.getCachedRuleText();
  check('corrupted compressed data is treated as a cache miss (null), not a throw',
    corruptRead === null, corruptRead);

  console.log('\n== 25r. EXPORT_CONVERTED_RULE_SOURCE — dashboard\'s per-URL "Export" button (2026-08-23) ==');
  const sendExport = (msg) => new Promise(res => messageListeners[0](msg, {}, res));
  const rBadUrl = await sendExport({ type: 'EXPORT_CONVERTED_RULE_SOURCE', url: 'not-a-url' });
  check('rejects a non-http(s) url', rBadUrl.ok === false);
  stubAbpSourceText = 'exporttest.example##.export-me\nexporttest.example##+js(nowebrtc)';
  const rExport = await sendExport({ type: 'EXPORT_CONVERTED_RULE_SOURCE', url: 'https://example.com/abp-test-source.txt' });
  check('ok:true with the converted text for an ABP-format source', rExport.ok === true && rExport.wasAbp === true, JSON.stringify(rExport));
  check('converted text uses this repo\'s own grammar, not raw ABP syntax',
    rExport.text.includes('direct_hide_selectors') && rExport.text.includes('.export-me') && rExport.text.includes('no_webrtc'),
    rExport.text);
  check('generated key carries the "abp_" prefix', /\[abp_exporttest\]/.test(rExport.text), rExport.text);
  const rExportUnreachable = await sendExport({ type: 'EXPORT_CONVERTED_RULE_SOURCE', url: 'https://example.com/does-not-exist-source.txt' });
  check('a 404/unreachable url reports ok:false with an error, not a throw', rExportUnreachable.ok === false && !!rExportUnreachable.error, JSON.stringify(rExportUnreachable));

  console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
