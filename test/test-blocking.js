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
      async set(obj) { Object.assign(storageData, obj); },
      async clear() { for (const k of Object.keys(storageData)) delete storageData[k]; },
    },
  },
  declarativeNetRequest: {
    async getDynamicRules() { return dynamicRules.slice(); },
    async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
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
    onInstalled: noopEvent,
    onStartup: noopEvent,
    onMessage: { addListener(fn) { messageListeners.push(fn); } },
  },
  alarms: { create() {}, clear() {}, onAlarm: noopEvent },
  tabs: {
    async query() { return []; },
    async get() { return null; },
    sendMessage: async () => {},
    onActivated: noopEvent,
    onUpdated: noopEvent,
  },
  action: {
    setIcon() {},
    setBadgeText() { return Promise.resolve(); },
    setBadgeBackgroundColor() { return Promise.resolve(); },
  },
};

// fetch stub: serve the real local rules file for both remote + local URLs
async function fetchStub(url) {
  const u = String(url);
  if (u.includes('site-rules.txt')) {
    return { ok: true, status: 200, headers: { get: () => '' }, text: async () => rulesText };
  }
  return { ok: false, status: 404, headers: { get: () => '' }, text: async () => '' };
}

// ── load background.js in sandbox ─────────────────────────────────
const sandbox = {
  console, chrome: chromeStub, fetch: fetchStub,
  setTimeout, clearTimeout, setInterval, clearInterval,
  URL, Date, Math, JSON, Promise, RegExp, Set, Map, Number, String, Object, Array, Error,
  importScripts() { vm.runInContext(configSrc, ctx, { filename: 'config.js' }); },
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);

const exportSnippet = `
self.__test = {
  ensureRuleDefinitionsLoaded, buildActiveRulesFromStorage, applyNetworkRules,
  parseRuleText, buildRemoteMalwareRules,
  get DEFAULT_RULES() { return DEFAULT_RULES; },
  get MALWARE_RULES() { return MALWARE_RULES; },
  get TRACKER_RULE_IDS() { return TRACKER_RULE_IDS; },
  get MALWARE_RULE_IDS() { return MALWARE_RULE_IDS; },
  get statsChain() { return _statsWriteChain; },
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

  console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
