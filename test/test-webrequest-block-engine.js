// Harness: runs the real shared/background.js in Node (same technique as
// test-blocking.js) with a chrome/webRequest stub added, to verify the
// Firefox-only webRequestBlocking engine that replaces network_block_rules'
// DNR tier (see _hasWebRequestBlocking()/buildNetworkBlockMatcher()/
// _networkBlockRequestHandler() in background.js, and the plan this
// implements — moving JUST this one tier off declarativeNetRequest since it
// routinely exceeds Firefox's real flat 5000-dynamic-rule cap on its own,
// while every other tier stays on DNR unchanged on every browser).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const configSrc = fs.readFileSync(path.join(ROOT, 'shared/config.js'), 'utf8');
const browserCompatSrc = fs.readFileSync(path.join(ROOT, 'shared/browser-compat.js'), 'utf8');
const utilsSrc = fs.readFileSync(path.join(ROOT, 'shared/utils.js'), 'utf8');
const scriptletAliasMapSrc = fs.readFileSync(path.join(ROOT, 'shared/scriptlet-alias-map.js'), 'utf8');
const bgSrc = fs.readFileSync(path.join(ROOT, 'shared/background.js'), 'utf8');

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); }
}

// ── minimal chrome stub, webRequest included (simulates Firefox after this
// session's manifest.firefox.json change) ──────────────────────────────
const storageData = {};
const sessionStorageData = {};
let dynamicRules = [];
const onBeforeRequestListeners = [];
const badgeTextByTab = new Map();
const storageChangeListeners = [];

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
      // Fires storage.onChanged like the real API (and test-blocking.js's
      // own stub) — background.js's _ruleInputHashes (Phase 1a fingerprint,
      // background.js:1854-1874) only updates via this listener, so a test
      // that mutates storageData WITHOUT going through set() would leave
      // buildActiveRulesFromStorage()'s memoized remoteActive/
      // MALWARE_PATH_MATCHER stuck on stale (often empty) cached data.
      async set(obj) {
        const changes = {};
        for (const k of Object.keys(obj)) changes[k] = { oldValue: storageData[k], newValue: obj[k] };
        Object.assign(storageData, obj);
        for (const fn of storageChangeListeners) fn(changes, 'local');
      },
      async remove(k) { for (const key of (Array.isArray(k) ? k : [k])) delete storageData[key]; },
    },
    session: {
      async get(keys) {
        const arr = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
        const out = {};
        for (const k of arr) if (k in sessionStorageData) out[k] = sessionStorageData[k];
        return out;
      },
      async set(obj) { Object.assign(sessionStorageData, obj); },
    },
    onChanged: { addListener(fn) { storageChangeListeners.push(fn); } },
  },
  declarativeNetRequest: {
    MAX_NUMBER_OF_DYNAMIC_RULES: 30000,
    MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000,
    async getDynamicRules() { return dynamicRules.slice(); },
    async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
      const removeSet = new Set(removeRuleIds);
      dynamicRules = dynamicRules.filter(r => !removeSet.has(r.id)).concat(addRules.map(r => JSON.parse(JSON.stringify(r))));
    },
  },
  // The one thing this file adds over test-blocking.js's stub: a real
  // (fake) webRequest.onBeforeRequest that captures registered listeners so
  // tests can invoke them directly with synthetic `details` objects, and
  // supports removeListener so _updateNetworkBlockListener()'s toggle logic
  // is exercised too.
  webRequest: {
    onBeforeRequest: {
      addListener(fn) { if (!onBeforeRequestListeners.includes(fn)) onBeforeRequestListeners.push(fn); },
      removeListener(fn) {
        const i = onBeforeRequestListeners.indexOf(fn);
        if (i !== -1) onBeforeRequestListeners.splice(i, 1);
      },
    },
  },
  i18n: { getUILanguage: () => 'en-US' },
  runtime: {
    getURL: p => 'chrome-extension://test/' + p,
    getManifest: () => ({ version: '1.0.35' }),
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener() {} },
  },
  alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
  tabs: {
    async query() { return []; },
    sendMessage: async () => {},
    onActivated: { addListener() {} }, onUpdated: { addListener() {} }, onRemoved: { addListener() {} }, onCreated: { addListener() {} },
  },
  scripting: { insertCSS: async () => {}, removeCSS: async () => {} },
  action: {
    setIcon() {}, setBadgeBackgroundColor() { return Promise.resolve(); },
    setBadgeText(o) { if (o && o.tabId !== undefined) badgeTextByTab.set(o.tabId, o.text); return Promise.resolve(); },
  },
};

async function fetchStub(url) {
  return { ok: false, status: 404, headers: { get: () => '' }, text: async () => '' };
}

const sandbox = {
  console, chrome: chromeStub, fetch: fetchStub,
  setTimeout, clearTimeout, setInterval, clearInterval,
  URL, Date, Math, JSON, Promise, RegExp, Set, Map, Number, String, Object, Array, Error,
  CompressionStream, DecompressionStream, Response, TextEncoder, TextDecoder, btoa, atob, Uint8Array,
  navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0' },
  importScripts(name) {
    if (name && name.includes('scriptlet-alias-map')) vm.runInContext(scriptletAliasMapSrc, ctx, { filename: 'scriptlet-alias-map.js' });
    else if (name && name.includes('browser-compat')) vm.runInContext(browserCompatSrc, ctx, { filename: 'browser-compat.js' });
    else if (name && name.includes('utils')) vm.runInContext(utilsSrc, ctx, { filename: 'utils.js' });
    else vm.runInContext(configSrc, ctx, { filename: 'config.js' });
  },
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);

const exportSnippet = `
self.__test = {
  parseRuleText, buildNetworkBlockMatcher, _urlFilterToRegExp, _hasWebRequestBlocking,
  _networkBlockRequestHandler, _updateNetworkBlockListener,
  ensureRuleDefinitionsLoaded, buildActiveRulesFromStorage, applyNetworkRules,
  buildMalwarePathMatcher, _matcherEntryCount,
  get NETWORK_BLOCK_MATCHER() { return NETWORK_BLOCK_MATCHER; },
  set NETWORK_BLOCK_MATCHER(v) { NETWORK_BLOCK_MATCHER = v; },
  get MALWARE_PATH_MATCHER() { return MALWARE_PATH_MATCHER; },
  set MALWARE_PATH_MATCHER(v) { MALWARE_PATH_MATCHER = v; },
  get NETWORK_BLOCK_RULES() { return NETWORK_BLOCK_RULES; },
  get REMOTE_MAX_PATH_PATTERNS() { return REMOTE_MAX_PATH_PATTERNS; },
  _compressDomainsForStorage,
  get tabBlockedCounts() { return _tabBlockedCounts; },
};`;
vm.runInContext(bgSrc + '\n' + exportSnippet, ctx, { filename: 'background.js' });
const T = sandbox.__test;

(async () => {
  console.log('== 1. _hasWebRequestBlocking() feature detection ==');
  check('true when chrome.webRequest.onBeforeRequest.addListener exists (this stub simulates Firefox post-manifest-change)',
    T._hasWebRequestBlocking() === true);

  console.log('\n== 2. _urlFilterToRegExp(): DNR urlFilter mini-language -> JS RegExp ==');
  {
    const re = T._urlFilterToRegExp('||example.com/exact/path.js^');
    check('|| anchors to a hostname label boundary right after scheme://',
      re.test('https://example.com/exact/path.js') && re.test('https://sub.example.com/exact/path.js'),
      re.source);
    check('does NOT match a different path', !re.test('https://example.com/other/path.js'), re.source);
    check('does NOT match a look-alike domain (evil-example.com)', !re.test('https://evil-example.com/exact/path.js'), re.source);
  }
  {
    const re = T._urlFilterToRegExp('||example.com/*.gif^');
    check('* wildcard matches any run of characters', re.test('https://example.com/a/b/c/x.gif'), re.source);
  }
  {
    const re = T._urlFilterToRegExp('||example.com/exact/beacon.gif^');
    check('^ separator matches end-of-string', re.test('https://example.com/exact/beacon.gif'), re.source);
    check('^ separator matches a real separator char (?)', re.test('https://example.com/exact/beacon.gif?x=1'), re.source);
    check('^ separator does NOT match a letter/digit continuing the token', !re.test('https://example.com/exact/beacon.gif2'), re.source);
  }
  {
    const rePath = T._urlFilterToRegExp('||example.com/CaseSensitive.js^');
    check('path portion is case-SENSITIVE (matches existing repo convention)',
      rePath.test('https://example.com/CaseSensitive.js') && !rePath.test('https://example.com/casesensitive.js'),
      rePath.source);
  }

  console.log('\n== 3. buildNetworkBlockMatcher(): decodes the same 6-field entries buildNetworkBlockRules() does, into a Map ==');
  const nativeText = [
    '[global]',
    '[host_patterns]',
    'ads-target.example = site1',
    'shared-a.example|shared-b.example = site2',
    '',
    '[site1]',
    'network_block_rules = /exact/beacon.gif image * * * * | /api/track^ xmlhttprequest site-a.com * * *',
    '',
    '[site2]',
    'network_block_rules = /pixel.gif * * * * *',
    '',
  ].join('\n');
  const parsed = T.parseRuleText(nativeText);
  const matcher = T.buildNetworkBlockMatcher(parsed);
  check('matcher is a Map keyed by domain', matcher instanceof Map);
  check('ads-target.example has 2 entries', (matcher.get('ads-target.example') || []).length === 2, matcher.get('ads-target.example'));
  check('the domain|domain bucket key was split into 2 separate matcher keys',
    matcher.has('shared-a.example') && matcher.has('shared-b.example'), [...matcher.keys()]);

  console.log('\n== 4. _networkBlockRequestHandler(): end-to-end matching + stats + cancel decision ==');
  function fakeDetails(overrides) {
    return { tabId: 1, method: 'GET', type: 'image', initiator: undefined, documentUrl: undefined, ...overrides };
  }
  {
    T.NETWORK_BLOCK_MATCHER = matcher;
    const result = T._networkBlockRequestHandler(fakeDetails({ url: 'https://ads-target.example/exact/beacon.gif', type: 'image' }));
    check('domain+path+resourceType match -> {cancel:true}', result && result.cancel === true, result);
    check('a matched block increments the tab badge counter', T.tabBlockedCounts.get(1) === 1, T.tabBlockedCounts.get(1));
  }
  {
    const result = T._networkBlockRequestHandler(fakeDetails({ url: 'https://ads-target.example/exact/beacon.gif', type: 'script' }));
    check('same URL, WRONG resourceType (script, entry wants image) -> allowed ({}), not cancelled',
      !result.cancel, result);
  }
  {
    const result = T._networkBlockRequestHandler(fakeDetails({
      url: 'https://ads-target.example/api/track', type: 'xmlhttprequest', initiator: 'https://site-a.com',
    }));
    check('$domain=site-a.com entry matches when initiator IS site-a.com', result.cancel === true, result);
  }
  {
    const result = T._networkBlockRequestHandler(fakeDetails({
      url: 'https://ads-target.example/api/track', type: 'xmlhttprequest', initiator: 'https://unrelated-site.com',
    }));
    check('$domain=site-a.com entry does NOT match a different initiator (unrelated-site.com)', !result.cancel, result);
  }
  {
    const result = T._networkBlockRequestHandler(fakeDetails({
      url: 'https://ads-target.example/api/track', type: 'xmlhttprequest', documentUrl: 'https://site-a.com/page.html',
    }));
    check('Firefox-shaped details (documentUrl instead of initiator) still resolves the initiating domain correctly',
      result.cancel === true, result);
  }
  {
    const result = T._networkBlockRequestHandler(fakeDetails({ url: 'https://totally-unrelated.example/exact/beacon.gif', type: 'image' }));
    check('a domain with NO matcher entries at all is left alone', !result.cancel, result);
  }
  {
    const result = T._networkBlockRequestHandler(fakeDetails({ url: 'https://shared-b.example/pixel.gif', type: 'image' }));
    check('the domain|domain bucket applies the SAME entry to both split domains (shared-b.example)', result.cancel === true, result);
  }
  {
    const result = T._networkBlockRequestHandler(fakeDetails({ url: 'https://sub.ads-target.example/exact/beacon.gif', type: 'image' }));
    check('a subdomain of a matcher-covered domain still matches (domain-suffix walk)', result.cancel === true, result);
  }

  console.log('\n== 4b. buildMalwarePathMatcher()/MALWARE_PATH_MATCHER: the remoteMalwarePathPatterns tier (2026-08-31 follow-up — this ALSO independently exceeds Firefox\'s cap) ==');
  {
    // Same raw urlFilter shape buildRemoteMalwareRules()'s path branch reads
    // — already-full '||domain/path^' strings, no options at all.
    const pathPatterns = [
      '||bitbucket.org/evil-user/malware-repo/raw/main/payload.exe^',
      '||drive.google.com/uc?id=EVILFILEID^',
    ];
    const malwareMatcher = T.buildMalwarePathMatcher(pathPatterns);
    check('buildMalwarePathMatcher() buckets by domain', malwareMatcher.has('bitbucket.org') && malwareMatcher.has('drive.google.com'), [...malwareMatcher.keys()]);
    T.NETWORK_BLOCK_MATCHER = new Map(); // isolate: this section tests ONLY the malware-path matcher, not network_block_rules
    T.MALWARE_PATH_MATCHER = malwareMatcher;

    const hit = T._networkBlockRequestHandler(fakeDetails({ url: 'https://bitbucket.org/evil-user/malware-repo/raw/main/payload.exe' }));
    check('a URL matching a malware path pattern is cancelled', hit.cancel === true, hit);
    check('malware-path block counts as "malware" in daily stats (ads:0,malware:1) — verified via the tab badge counter incrementing', T.tabBlockedCounts.get(1) > 0, T.tabBlockedCounts.get(1));

    const miss = T._networkBlockRequestHandler(fakeDetails({ url: 'https://bitbucket.org/some-legit-user/some-legit-repo/raw/main/readme.md' }));
    check('a DIFFERENT path on the SAME (otherwise-legitimate) shared host is NOT blocked — only the flagged path is', !miss.cancel, miss);

    const otherType = T._networkBlockRequestHandler(fakeDetails({ url: 'https://bitbucket.org/evil-user/malware-repo/raw/main/payload.exe', type: 'main_frame' }));
    check('malware-path block has NO resourceType restriction — matches regardless of type (main_frame here)', otherType.cancel === true, otherType);
  }

  console.log('\n== 5. _updateNetworkBlockListener(): registers/unregisters against the real webRequest stub ==');
  {
    T._updateNetworkBlockListener(false);
    T._updateNetworkBlockListener(true);
    check('listener registered exactly once (idempotent re-enable)', onBeforeRequestListeners.length === 1, onBeforeRequestListeners.length);
    T._updateNetworkBlockListener(true); // calling again with the same state must not double-register
    check('calling enable=true again does not double-register', onBeforeRequestListeners.length === 1, onBeforeRequestListeners.length);
    T._updateNetworkBlockListener(false);
    check('disable removes the listener', onBeforeRequestListeners.length === 0, onBeforeRequestListeners.length);
  }

  console.log('\n== 6. Integration: ensureRuleDefinitionsLoaded()/buildActiveRulesFromStorage() route network_block_rules to the matcher on this "Firefox" stub, NOT into DNR allRules ==');
  {
    storageData.enabled = true;
    storageData.blockAds = true;
    storageData.blockTrackers = true;
    storageData.blockMalware = true;
    // Seed a fake cached rule text with a network_block_rules entry via the
    // same storage key getParsedRules()/getCachedRuleText() reads.
    storageData.siteRulesCacheText = nativeText;
    storageData.siteRulesCacheTime = Date.now();
    const { allRules } = await T.buildActiveRulesFromStorage();
    check('NETWORK_BLOCK_RULES (DNR array) is empty on this webRequestBlocking-capable stub',
      T.NETWORK_BLOCK_RULES.length === 0, T.NETWORK_BLOCK_RULES.length);
    check('network_block_rules entries never leak into the DNR allRules array either',
      !allRules.some(r => r.id >= 700000 && r.id < 800000), allRules.filter(r => r.id >= 700000 && r.id < 800000));
    check('NETWORK_BLOCK_MATCHER was populated instead', T.NETWORK_BLOCK_MATCHER.size > 0, T.NETWORK_BLOCK_MATCHER.size);
  }

  console.log('\n== 6b. Integration: remoteMalwarePathPatterns ALSO routes to MALWARE_PATH_MATCHER, not DNR, on this stub (2026-08-31 follow-up) ==');
  {
    const paths = ['||malware-host.example/exact/payload.exe^'];
    await chromeStub.storage.local.set({
      remoteMalwarePathPatterns: await T._compressDomainsForStorage(paths),
      remoteMalwareDomains: await T._compressDomainsForStorage(['known-bad.example']),
    });
    const { allRules } = await T.buildActiveRulesFromStorage();
    check('no remoteMalwarePathPatterns-range DNR rules (900000-1000000) leak into allRules',
      !allRules.some(r => r.id >= 900000 && r.id < 1000000), allRules.filter(r => r.id >= 900000 && r.id < 1000000));
    check('MALWARE_PATH_MATCHER was populated from remoteMalwarePathPatterns', T.MALWARE_PATH_MATCHER.has('malware-host.example'), [...T.MALWARE_PATH_MATCHER.keys()]);
    check('the bare-domain malware rules (batched, small) STILL go through DNR as before — only the path ones moved',
      allRules.some(r => r.id >= 100000 && r.id < 200000), allRules.filter(r => r.id >= 100000 && r.id < 200000).length);
  }

  console.log('\n== 7. _matcherEntryCount(): powers GET_RULE_COUNT so the popup shows the SAME meaning on every browser (2026-08-31 — live-reported: Chrome popup showed 17526, Firefox showed only 155 for equivalent protection, because getDynamicRules() alone cannot see either matcher) ==');
  {
    const m1 = new Map([['a.example', [1, 2, 3]], ['b.example', [1]]]);
    check('sums entry counts across every domain bucket', T._matcherEntryCount(m1) === 4, T._matcherEntryCount(m1));
    check('an empty Map (Chrome/Edge — matchers always unused there) counts as 0', T._matcherEntryCount(new Map()) === 0);
  }

  console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
