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
const localStorageSrc = fs.readFileSync(path.join(ROOT, 'shared/local-storage.js'), 'utf8');
const diagLoggerSrc = fs.readFileSync(path.join(ROOT, 'shared/diag-logger.js'), 'utf8');
const sessionStorageSrc = fs.readFileSync(path.join(ROOT, 'shared/session-storage.js'), 'utf8');
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
// Overridable by tests exercising _saveMatcherCacheToLocal()'s quota guard —
// default 0 (plenty of headroom) so every other section's cache writes just
// work.
let bytesInUseOverride = 0;
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
      async getBytesInUse() { return bytesInUseOverride; },
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
  alarms: { get() { return Promise.resolve(undefined); }, create() {}, clear() {}, onAlarm: { addListener() {} } },
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

// _saveMatcherCacheToLocal() is called fire-and-forget (not awaited) by its
// two real callers (ensureRuleDefinitionsLoaded(), buildActiveRulesFromStorage())
// — a deliberate 2026-09-11 change so a cache-miss rebuild's caller doesn't
// wait on the (best-effort, already try/catch-wrapped) persist finishing.
// Tests asserting on that write's side effect must let its promise chain
// (getBytesInUse() -> compress -> LocalStorage.set(), each a real await)
// settle first — a couple of macrotask ticks is enough since the stub's own
// async fns all resolve on their own microtask/next tick.
async function flushMicrotasks() {
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
}

// Polls instead of a fixed tick count for checks on the fire-and-forget
// cache write specifically — background.js now also fires an unconditional
// top-level applyNetworkRules() call at module load (see its own comment),
// which is a SECOND concurrent fire-and-forget write chain competing for
// the same event loop right as a section's own build+write happens. Two
// fixed setTimeout(0) ticks occasionally isn't enough for both chains
// (getBytesInUse -> compress via a real CompressionStream -> LocalStorage.
// set) to settle under load — poll up to 2s instead of guessing a tick count.
async function waitUntil(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise(r => setTimeout(r, 10));
  }
  return true;
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
    else if (name && name.includes('local-storage')) vm.runInContext(localStorageSrc, ctx, { filename: 'local-storage.js' });
    else if (name && name.includes('diag-logger')) vm.runInContext(diagLoggerSrc, ctx, { filename: 'diag-logger.js' });
    else if (name && name.includes('session-storage')) vm.runInContext(sessionStorageSrc, ctx, { filename: 'session-storage.js' });
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
  _loadMatcherCacheFromLocal, _saveMatcherCacheToLocal,
  _serializeMatcherMap, _rehydrateMatcherMap,
  _serializeRegexMatcherMap, _rehydrateRegexMatcherMap,
  NETWORK_BLOCK_MATCHER_CACHE_KEY, MALWARE_PATH_MATCHER_CACHE_KEY,
  LOCAL_STORAGE_SAFE_LIMIT_BYTES,
  get NETWORK_BLOCK_MATCHER() { return NETWORK_BLOCK_MATCHER; },
  set NETWORK_BLOCK_MATCHER(v) { NETWORK_BLOCK_MATCHER = v; },
  get MALWARE_PATH_MATCHER() { return MALWARE_PATH_MATCHER; },
  set MALWARE_PATH_MATCHER(v) { MALWARE_PATH_MATCHER = v; },
  get HTML_FILTER_MATCHER() { return HTML_FILTER_MATCHER; },
  set HTML_FILTER_MATCHER(v) { HTML_FILTER_MATCHER = v; },
  get DEFAULT_RULES() { return DEFAULT_RULES; },
  get NETWORK_BLOCK_RULES() { return NETWORK_BLOCK_RULES; },
  get REMOTE_MAX_PATH_PATTERNS() { return REMOTE_MAX_PATH_PATTERNS; },
  _compressDomainsForStorage,
  get tabBlockedCounts() { return _tabBlockedCounts; },
  // Test-only: undoes ensureRuleDefinitionsLoaded()'s "already built" guard
  // (DEFAULT_RULES/MALWARE_RULES/AD_MAINFRAME_RULES all non-empty) so a
  // section that seeds its OWN fixture storageData and calls
  // buildActiveRulesFromStorage() gets a REAL rebuild from that fixture,
  // instead of silently reusing whatever the module-top-level unconditional
  // applyNetworkRules() call (background.js, see its own comment) already
  // built from this stub's fetchStub()-always-404 fixture at module load.
  _resetBuiltRuleState() {
    DEFAULT_RULES = []; MALWARE_RULES = []; AD_MAINFRAME_RULES = [];
    _ruleConfigPromise = null; _parsedRules = null; _parsedRulesTextHash = null;
    _curatedDedupPromise = null;
  },
  get _remoteMalwareRulesMemo() { return _remoteMalwareRulesMemo; },
  _resetRemoteMalwareRulesMemo() { _remoteMalwareRulesMemo = { key: undefined, rules: null }; },
};`;
vm.runInContext(bgSrc + '\n' + exportSnippet, ctx, { filename: 'background.js' });
const T = sandbox.__test;

(async () => {
  // background.js now fires an unconditional top-level applyNetworkRules()
  // call at module load (see its own comment — Firefox idle-kills/respawns
  // this event page and Chrome's SW restarts routinely, neither firing
  // onInstalled/onStartup, so nothing else would rebuild after that). That
  // call's build+fire-and-forget matcher-cache write is still in flight
  // when this IIFE starts. Join it here (applyNetworkRules() chains off
  // the SAME in-flight promise, see _applyNetworkRulesChain) so later
  // sections don't race its cache write with their own.
  await T.applyNetworkRules();

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
    T._resetBuiltRuleState();
    const { allRules } = await T.buildActiveRulesFromStorage();
    check('NETWORK_BLOCK_RULES (DNR array) is empty on this webRequestBlocking-capable stub',
      T.NETWORK_BLOCK_RULES.length === 0, T.NETWORK_BLOCK_RULES.length);
    check('network_block_rules entries never leak into the DNR allRules array either',
      !allRules.some(r => r.id >= 700000 && r.id < 800000), allRules.filter(r => r.id >= 700000 && r.id < 800000));
    check('NETWORK_BLOCK_MATCHER was populated instead', T.NETWORK_BLOCK_MATCHER.size > 0, T.NETWORK_BLOCK_MATCHER.size);
    await waitUntil(() => !!(storageData[T.NETWORK_BLOCK_MATCHER_CACHE_KEY] && storageData[T.NETWORK_BLOCK_MATCHER_CACHE_KEY].compressed));
    check('a real end-to-end build also persisted NETWORK_BLOCK_MATCHER to its chrome.storage.local cache',
      !!(storageData[T.NETWORK_BLOCK_MATCHER_CACHE_KEY] && storageData[T.NETWORK_BLOCK_MATCHER_CACHE_KEY].compressed),
      storageData[T.NETWORK_BLOCK_MATCHER_CACHE_KEY]);
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
    await waitUntil(() => !!(storageData[T.MALWARE_PATH_MATCHER_CACHE_KEY] && storageData[T.MALWARE_PATH_MATCHER_CACHE_KEY].compressed));
    check('a real end-to-end build also persisted MALWARE_PATH_MATCHER to its chrome.storage.local cache',
      !!(storageData[T.MALWARE_PATH_MATCHER_CACHE_KEY] && storageData[T.MALWARE_PATH_MATCHER_CACHE_KEY].compressed),
      storageData[T.MALWARE_PATH_MATCHER_CACHE_KEY]);
  }

  console.log('\n== 6c. Regression (2026-09-14): a throw PARTWAY through ensureRuleDefinitionsLoaded() must not leave HTML_FILTER_MATCHER stuck empty forever ==');
  {
    // Live-reported: HTML_FILTER_MATCHER stayed empty (size 0) for the rest
    // of a background lifetime even though GET_SITE_CONFIG (a separate code
    // path reading the same parsed rules) kept returning correct selectors
    // the whole time. Root cause: DEFAULT_RULES/MALWARE_RULES/
    // AD_MAINFRAME_RULES (the guard this function checks) used to be
    // committed BEFORE buildNetworkBlockMatcher()/buildHtmlFilterMatcher()
    // ran — if either threw (one malformed entry among thousands merged
    // from real Rule Sources is enough), the guard was already satisfied,
    // so the function would never retry again this lifetime, leaving
    // HTML_FILTER_MATCHER at its initial empty Map permanently. Simulated
    // here by making buildNetworkBlockMatcher() itself throw once.
    T._resetBuiltRuleState();
    T.HTML_FILTER_MATCHER = new Map(); // start from a known-empty state
    T.NETWORK_BLOCK_MATCHER = new Map();
    // Fixture WITH a direct_hide_selectors entry (nativeText above has
    // none — section 6 only needs network_block_rules) so this section can
    // actually prove HTML_FILTER_MATCHER recovers, not just stays
    // legitimately empty because the fixture never had anything for it.
    // Raw (uncompressed) string is fine here — same as section 6's own
    // seeding — _decompressFromStorage() passes a bare string through as-is.
    const hostPatternsPatched = nativeText.replace('[host_patterns]', '[host_patterns]\nhtmlfilter-target.example = site3');
    storageData.siteRulesCacheText = hostPatternsPatched + '\n[site3]\ndirect_hide_selectors = .ad-banner\n';
    storageData.siteRulesCacheTime = Date.now();
    // Must also drop the on-disk matcher cache section 6 already wrote for
    // the OLD rule text — otherwise _loadMatcherCacheFromLocal() could
    // still serve a stale cache HIT and buildNetworkBlockMatcher() (the
    // thing being overridden below) never even gets called.
    delete storageData[T.NETWORK_BLOCK_MATCHER_CACHE_KEY];
    const realBuildNetworkBlockMatcher = sandbox.buildNetworkBlockMatcher;
    sandbox.buildNetworkBlockMatcher = () => { throw new Error('simulated malformed network_block_rules entry'); };
    let threwAsExpected = false;
    try { await T.ensureRuleDefinitionsLoaded(); } catch { threwAsExpected = true; }
    check('the simulated throw actually propagated (sanity check on the test setup itself)', threwAsExpected);
    check('nothing was committed on the failed attempt — the guard (DEFAULT_RULES) is still empty, not silently "already built"',
      T.DEFAULT_RULES.length === 0, T.DEFAULT_RULES.length);
    check('HTML_FILTER_MATCHER is still empty too (never reached, but NOT permanently stuck as a side effect either)',
      T.HTML_FILTER_MATCHER.size === 0, T.HTML_FILTER_MATCHER.size);

    sandbox.buildNetworkBlockMatcher = realBuildNetworkBlockMatcher; // "fix" the transient failure
    await T.ensureRuleDefinitionsLoaded();
    check('the NEXT call retries the whole build from scratch and succeeds — DEFAULT_RULES populated',
      T.DEFAULT_RULES.length > 0, T.DEFAULT_RULES.length);
    check('...and HTML_FILTER_MATCHER is populated too this time — the real bug this section guards against',
      T.HTML_FILTER_MATCHER.size > 0, T.HTML_FILTER_MATCHER.size);
  }

  console.log('\n== 6d. Regression (2026-09-14): the SAME bug class in buildActiveRulesFromStorage()\'s MALWARE_PATH_MATCHER/_remoteMalwareRulesMemo, plus defense-in-depth (one malformed entry skipped, not fatal) ==');
  {
    // Part 1 (Fix B): a single malformed remoteMalwarePathPatterns entry —
    // a real URLhaus-style external feed is exactly the kind of data
    // likely to have one occasionally — must be SKIPPED, not abort the
    // whole matcher build.
    await T._resetRemoteMalwareRulesMemo();
    T.MALWARE_PATH_MATCHER = new Map();
    const paths = [
      '||good-malware-host.example/exact/payload.exe^',
      '||throw-me.example/bad^',
      '||another-good-host.example/x^',
    ];
    await chromeStub.storage.local.set({
      remoteMalwarePathPatterns: await T._compressDomainsForStorage(paths),
      remoteMalwareDomains: await T._compressDomainsForStorage([]),
    });
    const realUrlFilterToRegExp = sandbox._urlFilterToRegExp;
    sandbox._urlFilterToRegExp = (urlFilter) => {
      if (urlFilter.includes('throw-me')) throw new Error('simulated malformed pattern');
      return realUrlFilterToRegExp(urlFilter);
    };
    await T.buildActiveRulesFromStorage();
    sandbox._urlFilterToRegExp = realUrlFilterToRegExp; // restore immediately, whatever happens above
    check('the two GOOD entries still made it into MALWARE_PATH_MATCHER despite the third one throwing',
      T.MALWARE_PATH_MATCHER.has('good-malware-host.example') && T.MALWARE_PATH_MATCHER.has('another-good-host.example'),
      [...T.MALWARE_PATH_MATCHER.keys()]);
    check('the malformed entry itself contributed NO domain key at all (skipped before matcher.set, not a broken/partial one)',
      !T.MALWARE_PATH_MATCHER.has('throw-me.example'), [...T.MALWARE_PATH_MATCHER.keys()]);

    // Part 2 (Fix A): if buildMalwarePathMatcher() fails in some OTHER way
    // Fix B doesn't catch (simulated here by making the whole function
    // throw), _remoteMalwareRulesMemo must NOT get committed — otherwise
    // the memo-hit branch on the next call with the same remoteKey would
    // skip rebuilding forever, leaving MALWARE_PATH_MATCHER stuck (this is
    // the exact bug already fixed for HTML_FILTER_MATCHER in
    // ensureRuleDefinitionsLoaded(), section 6c above).
    await T._resetRemoteMalwareRulesMemo();
    T.MALWARE_PATH_MATCHER = new Map();
    const paths2 = ['||yet-another-good-host.example/y^'];
    await chromeStub.storage.local.set({
      remoteMalwarePathPatterns: await T._compressDomainsForStorage(paths2),
      remoteMalwareDomains: await T._compressDomainsForStorage([]),
    });
    delete storageData[T.MALWARE_PATH_MATCHER_CACHE_KEY]; // force the real build path, not a cache hit
    const realBuildMalwarePathMatcher = sandbox.buildMalwarePathMatcher;
    sandbox.buildMalwarePathMatcher = () => { throw new Error('simulated total build failure'); };
    let threwAsExpected2 = false;
    try { await T.buildActiveRulesFromStorage(); } catch { threwAsExpected2 = true; }
    check('the simulated throw actually propagated (sanity check on the test setup itself)', threwAsExpected2);
    check('_remoteMalwareRulesMemo was NOT committed on the failed attempt',
      T._remoteMalwareRulesMemo.rules === null, T._remoteMalwareRulesMemo);
    check('MALWARE_PATH_MATCHER is still empty too (never reached, but not permanently stuck as a side effect)',
      T.MALWARE_PATH_MATCHER.size === 0, T.MALWARE_PATH_MATCHER.size);

    sandbox.buildMalwarePathMatcher = realBuildMalwarePathMatcher; // "fix" the transient failure
    await T.buildActiveRulesFromStorage();
    check('the NEXT call retries and succeeds — MALWARE_PATH_MATCHER populated this time',
      T.MALWARE_PATH_MATCHER.has('yet-another-good-host.example'), [...T.MALWARE_PATH_MATCHER.keys()]);
    check('...and _remoteMalwareRulesMemo is now correctly committed too',
      T._remoteMalwareRulesMemo.rules !== null, T._remoteMalwareRulesMemo);
  }

  console.log('\n== 7. _matcherEntryCount(): powers GET_RULE_COUNT so the popup shows the SAME meaning on every browser (2026-08-31 — live-reported: Chrome popup showed 17526, Firefox showed only 155 for equivalent protection, because getDynamicRules() alone cannot see either matcher) ==');
  {
    const m1 = new Map([['a.example', [1, 2, 3]], ['b.example', [1]]]);
    check('sums entry counts across every domain bucket', T._matcherEntryCount(m1) === 4, T._matcherEntryCount(m1));
    check('an empty Map (Chrome/Edge — matchers always unused there) counts as 0', T._matcherEntryCount(new Map()) === 0);
  }

  console.log('\n== 8. NETWORK_BLOCK_MATCHER chrome.storage.local cache round-trip (2026-09-08) ==');
  {
    await T._saveMatcherCacheToLocal(T.NETWORK_BLOCK_MATCHER_CACHE_KEY, 'key-1', T._serializeMatcherMap(matcher));
    check('save writes the {key, compressed} wrapper to chrome.storage.local',
      storageData[T.NETWORK_BLOCK_MATCHER_CACHE_KEY] && storageData[T.NETWORK_BLOCK_MATCHER_CACHE_KEY].key === 'key-1',
      storageData[T.NETWORK_BLOCK_MATCHER_CACHE_KEY]);
    const loaded = await T._loadMatcherCacheFromLocal(T.NETWORK_BLOCK_MATCHER_CACHE_KEY, 'key-1', T._rehydrateMatcherMap);
    check('load with the SAME key round-trips the matcher (same domains)',
      loaded instanceof Map && [...loaded.keys()].sort().join(',') === [...matcher.keys()].sort().join(','), loaded && [...loaded.keys()]);
    check('a rehydrated entry\'s regex SOURCE matches the original (RegExp itself can\'t survive JSON, only .source)',
      loaded.get('ads-target.example')[0].regex.source === matcher.get('ads-target.example')[0].regex.source);
    const missOnDifferentKey = await T._loadMatcherCacheFromLocal(T.NETWORK_BLOCK_MATCHER_CACHE_KEY, 'key-2', T._rehydrateMatcherMap);
    check('load with a DIFFERENT key is treated as a miss (content hash changed -> self-invalidates)', missOnDifferentKey === null, missOnDifferentKey);
  }

  console.log('\n== 8b. MALWARE_PATH_MATCHER chrome.storage.local cache round-trip — simpler Map<domain, RegExp[]> shape ==');
  {
    const malwareMatcher = T.buildMalwarePathMatcher(['||bad.example/x.exe^', '||bad.example/y.exe^']);
    await T._saveMatcherCacheToLocal(T.MALWARE_PATH_MATCHER_CACHE_KEY, 'mkey-1', T._serializeRegexMatcherMap(malwareMatcher));
    const loaded = await T._loadMatcherCacheFromLocal(T.MALWARE_PATH_MATCHER_CACHE_KEY, 'mkey-1', T._rehydrateRegexMatcherMap);
    check('MALWARE_PATH_MATCHER round-trips through its own (simpler, no-options) serialize/rehydrate pair',
      loaded instanceof Map && loaded.get('bad.example').length === 2 &&
      loaded.get('bad.example')[0].source === malwareMatcher.get('bad.example')[0].source, loaded && loaded.get('bad.example'));
  }

  console.log('\n== 8c. _saveMatcherCacheToLocal(): quota guard never risks pushing storage.local over budget ==');
  {
    delete storageData[T.NETWORK_BLOCK_MATCHER_CACHE_KEY];
    bytesInUseOverride = T.LOCAL_STORAGE_SAFE_LIMIT_BYTES + 1; // already over budget before this write's own bytes are even added
    await T._saveMatcherCacheToLocal(T.NETWORK_BLOCK_MATCHER_CACHE_KEY, 'key-1', T._serializeMatcherMap(matcher));
    check('write is skipped entirely when storage.local is already at/near quota — no throw, no partial write',
      storageData[T.NETWORK_BLOCK_MATCHER_CACHE_KEY] === undefined, storageData[T.NETWORK_BLOCK_MATCHER_CACHE_KEY]);
    bytesInUseOverride = null; // getBytesInUse() itself failing/unavailable
    await T._saveMatcherCacheToLocal(T.NETWORK_BLOCK_MATCHER_CACHE_KEY, 'key-1', T._serializeMatcherMap(matcher));
    check('a null (unknown) bytesInUse reading is treated as "assume worst case", not as "assume empty" — write still skipped',
      storageData[T.NETWORK_BLOCK_MATCHER_CACHE_KEY] === undefined, storageData[T.NETWORK_BLOCK_MATCHER_CACHE_KEY]);
    bytesInUseOverride = 0; // restore for any later test relying on normal cache writes
    await T._saveMatcherCacheToLocal(T.NETWORK_BLOCK_MATCHER_CACHE_KEY, 'key-1', T._serializeMatcherMap(matcher));
    check('back under budget, the write goes through normally',
      !!storageData[T.NETWORK_BLOCK_MATCHER_CACHE_KEY], storageData[T.NETWORK_BLOCK_MATCHER_CACHE_KEY]);
  }

  console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
