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
const bgSrc = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');

// ── chrome stub ───────────────────────────────────────────────────
const storageData = {};
let dynamicRules = [];
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
// _isFirefoxInstall() (background.js) checks navigator.userAgent — same
// technique popup.js/dashboard.js already use for this kind of "pick a URL
// for the current browser" decision. Simulated here by swapping
// sandbox.navigator.userAgent directly (see section 24a below), not via a
// separate flag.
async function fetchStub(url) {
  const u = String(url);
  if (u.includes('site-rules.txt')) {
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
  return { ok: false, status: 404, headers: { get: () => '' }, text: async () => '' };
}

// ── load background.js in sandbox ─────────────────────────────────
const sandbox = {
  console, chrome: chromeStub, fetch: fetchStub,
  setTimeout, clearTimeout, setInterval, clearInterval,
  URL, Date, Math, JSON, Promise, RegExp, Set, Map, Number, String, Object, Array, Error,
  navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' },
  importScripts() { vm.runInContext(configSrc, ctx, { filename: 'config.js' }); },
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);

const exportSnippet = `
self.__test = {
  ensureRuleDefinitionsLoaded, buildActiveRulesFromStorage, applyNetworkRules,
  parseRuleText, buildRemoteMalwareRules, updateIcon, _incrementTabBlocked, _setTabBadge,
  getParsedRules, resolveSiteKey,
  _buildElementRulesBlock, _applyElementRules,
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
  storageData.pausedDomains = ['news.example.com'];
  await T.applyNetworkRules();
  const allowRule = dynamicRules.find(r => r.action.type === 'allowAllRequests');
  check('allowAllRequests rule created for paused domain', !!allowRule);
  check('allow rule outranks block rules (priority 10 > 2)',
    allowRule && allowRule.priority > Math.max(...dynamicRules.filter(r => r.action.type === 'block').map(r => r.priority || 1)));
  storageData.pausedDomains = [];
  await T.applyNetworkRules();

  console.log('\n== 8. Stats counting via RESOURCE_SEEN (popup/dashboard numbers) ==');
  const listener = messageListeners[0];
  const send = (msg) => new Promise(res => listener(msg, {}, res));
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
  storageData.blockTrackers = false;
  storageData.blockMalware = false;
  await send2({ type: 'RESOURCE_SEEN', domain: 'toggletest.com',
    delta: { seen: 6, ads: 2, trackers: 3, malware: 1 } });
  await T.statsChain;
  const { stats: stats3 } = await chromeStub.storage.local.get('stats');
  const tt = stats3 && stats3['toggletest.com'];
  check('trackers NOT counted when blockTrackers=false', tt && tt.trackersBlocked === 0, JSON.stringify(tt));
  check('malware NOT counted when blockMalware=false', tt && tt.malwareBlocked === 0);
  check('ads still counted (blockAds=true)', tt && tt.adsBlocked === 2);
  check('totalSeen still recorded', tt && tt.totalSeen === 6);
  storageData.blockTrackers = true;
  storageData.blockMalware = true;
  storageData.pausedDomains = ['paused.example.com'];
  await send2({ type: 'RESOURCE_SEEN', domain: 'paused.example.com',
    delta: { seen: 5, ads: 5, trackers: 0, malware: 0 } });
  await T.statsChain;
  const { stats: stats4 } = await chromeStub.storage.local.get('stats');
  check('paused domain not counted at all', !stats4['paused.example.com']);
  storageData.pausedDomains = [];

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

  console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
