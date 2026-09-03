// Harness: runs the real shared/background.js in Node (same technique as
// test-webrequest-block-engine.js) with webRequest.onHeadersReceived +
// filterResponseData stubs added, to verify the Firefox-only HTML stream
// filter (browser.webRequest.filterResponseData()) that injects a <style>
// hide-rule into the raw HTML response body BEFORE the browser ever
// parses/paints it — for sites where the ad is server-rendered directly
// into the initial HTML response, no amount of cosmetic-CSS injection
// speed can prevent the flash, since the browser paints from raw bytes
// before any extension code runs at all.
//
// 2026-09-03: this used to actually REMOVE the matched DOM node (real
// uBlock Origin's own src/js/html-filtering.js does exactly that, via its
// separate ##^ syntax — confirmed by reading their source), via a
// DOMParser().parseFromString()+querySelectorAll()+reserialize round trip.
// Switched to string-level <style> injection instead: a CSS rule is
// harmless even where it matches nothing, so there's no need to parse the
// document at all to know whether something matched — just splice one
// <style> block in right after the opening <head> tag. This is also
// exactly what real uBlock Origin's own maintainers settled on for
// tinhte.vn specifically (live-verified: no ##^ rule exists for that site
// in their filter lists, only regular ## CSS-hide selectors) — and it
// drops the DOMParser dependency entirely, along with the risk of this
// MV3 background context's DOMParser/Gecko :has()/serializer semantics
// never having been independently verified against the real thing. This
// file is now pure string-operation testing — no DOM stub needed.
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
const sessionStorageSrc = fs.readFileSync(path.join(ROOT, 'shared/session-storage.js'), 'utf8');
const bgSrc = fs.readFileSync(path.join(ROOT, 'shared/background.js'), 'utf8');

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); }
}

// ── FakeStreamFilter — simulates browser.webRequest.filterResponseData()'s
// returned StreamFilter object closely enough to drive ondata/onstop/
// onerror and observe write()/close()/disconnect() calls ────────────────
class FakeStreamFilter {
  constructor() {
    this.writes = [];
    this.closed = false;
    this.disconnected = false;
    this.ondata = null;
    this.onstop = null;
    this.onerror = null;
  }
  write(data) { this.writes.push(data); }
  close() { this.closed = true; }
  disconnect() { this.disconnected = true; }
}
function decodeWrites(filter) {
  const dec = new TextDecoder('utf-8');
  return filter.writes.map(w => dec.decode(w instanceof Uint8Array ? w : new Uint8Array(w))).join('');
}

// ── chrome stub ───────────────────────────────────────────────────────
const storageData = {};
const sessionStorageData = {};
let dynamicRules = [];
const onBeforeRequestListeners = [];
const onHeadersReceivedListeners = [];
const storageChangeListeners = [];
let filterResponseDataAvailable = true;
let lastFilter = null;
let lastFilterRequestId = null;

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
  webRequest: {
    onBeforeRequest: {
      addListener(fn) { if (!onBeforeRequestListeners.includes(fn)) onBeforeRequestListeners.push(fn); },
      removeListener(fn) {
        const i = onBeforeRequestListeners.indexOf(fn);
        if (i !== -1) onBeforeRequestListeners.splice(i, 1);
      },
    },
    onHeadersReceived: {
      addListener(fn) { if (!onHeadersReceivedListeners.includes(fn)) onHeadersReceivedListeners.push(fn); },
      removeListener(fn) {
        const i = onHeadersReceivedListeners.indexOf(fn);
        if (i !== -1) onHeadersReceivedListeners.splice(i, 1);
      },
    },
    // Present/absent toggled per-test via filterResponseDataAvailable to
    // exercise _hasHtmlStreamFilter()'s feature-detect both ways.
    get filterResponseData() {
      if (!filterResponseDataAvailable) return undefined;
      return (requestId) => {
        lastFilter = new FakeStreamFilter();
        lastFilterRequestId = requestId;
        return lastFilter;
      };
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
    setBadgeText() { return Promise.resolve(); },
  },
};

async function fetchStub() {
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
    else if (name && name.includes('local-storage')) vm.runInContext(localStorageSrc, ctx, { filename: 'local-storage.js' });
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
  parseRuleText, buildHtmlFilterMatcher, _htmlFilterSelectorsForHost,
  _applyHtmlFilterSelectors, _attachHtmlFilter, _htmlFilterRequestHandler,
  _hasHtmlStreamFilter,
  ensureRuleDefinitionsLoaded, buildActiveRulesFromStorage,
  _saveBuiltRulesToCache, _loadBuiltRulesFromCache,
  get HTML_FILTER_MATCHER() { return HTML_FILTER_MATCHER; },
  set HTML_FILTER_MATCHER(v) { HTML_FILTER_MATCHER = v; },
  get settingsCache() { return _settingsCache; },
  get DEFAULT_RULES() { return DEFAULT_RULES; },
};`;
vm.runInContext(bgSrc + '\n' + exportSnippet, ctx, { filename: 'background.js' });
const T = sandbox.__test;

function fakeHeadersDetails(overrides) {
  return {
    requestId: '1', tabId: 1, type: 'main_frame', method: 'GET',
    responseHeaders: [],
    ...overrides,
  };
}

(async () => {
  console.log('== 1. _hasHtmlStreamFilter() feature detection ==');
  check('true when chrome.webRequest.filterResponseData exists (stub simulates Firefox)', T._hasHtmlStreamFilter() === true);
  filterResponseDataAvailable = false;
  check('false when chrome.webRequest.filterResponseData is absent (simulates Chrome)', T._hasHtmlStreamFilter() === false);
  filterResponseDataAvailable = true;

  console.log('\n== 2. buildHtmlFilterMatcher(): resolves [host_patterns] -> siteKey -> direct_hide_selectors (reused, no separate key) ==');
  const nativeText = [
    '[host_patterns]',
    'tinhte.vn = tinhte',
    'shared-a.example|shared-b.example = sharedsite',
    'wildcard.* = wcsite',
    '/(^|\\.)regexsite\\./ = regexsite',
    'nofilter.example = nofilter',
    '',
    '[tinhte]',
    'direct_hide_selectors = .pro-container',
    '',
    '[sharedsite]',
    'direct_hide_selectors = .ad-block',
    '',
    '[wcsite]',
    'direct_hide_selectors = .wc-ad',
    '',
    '[regexsite]',
    'direct_hide_selectors = .re-ad',
    '',
    '[nofilter]',
    'network_block_rules = /pixel.gif * * * * *',
    '',
  ].join('\n');
  const parsed = T.parseRuleText(nativeText);
  const matcher = T.buildHtmlFilterMatcher(parsed);
  check('matcher is a Map', matcher instanceof Map);
  check('tinhte.vn resolves to its direct_hide_selectors array',
    JSON.stringify(matcher.get('tinhte.vn')) === JSON.stringify(['.pro-container']), matcher.get('tinhte.vn'));
  check('a domain|domain BUCKET key is excluded entirely (2026-09-03: dedicated single-domain entries only — a bucket applying to hundreds of ABP-converted sites would otherwise pay this cost everywhere)',
    !matcher.has('shared-a.example') && !matcher.has('shared-b.example'), [...matcher.keys()]);
  check('wildcard-TLD ("domain.*") host_patterns form is skipped (not supported for this key)',
    !matcher.has('wildcard.*') && !matcher.has('wildcard.com'));
  check('raw-regex ("/.../ ") host_patterns form is skipped (not supported for this key)',
    ![...matcher.keys()].some(k => k.startsWith('/')));
  check('a site with NO direct_hide_selectors at all is absent from the matcher',
    !matcher.has('nofilter.example'));

  console.log('\n== 3. _htmlFilterSelectorsForHost(): domain-suffix walk ==');
  T.HTML_FILTER_MATCHER = matcher;
  check('exact domain match', JSON.stringify(T._htmlFilterSelectorsForHost('tinhte.vn')) === JSON.stringify(['.pro-container']));
  check('subdomain of a registered domain still resolves', JSON.stringify(T._htmlFilterSelectorsForHost('m.tinhte.vn')) === JSON.stringify(['.pro-container']));
  check('an unrelated host resolves to null', T._htmlFilterSelectorsForHost('example.com') === null);

  console.log('\n== 4. _applyHtmlFilterSelectors(): splices a <style> block right after <head>, pure string ops ==');
  {
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div class="pro-container" id="banner-1">AD HERE</div></body></html>';
    const out = T._applyHtmlFilterSelectors(html, ['.pro-container']);
    check('a <style> block is injected', out !== null && out.includes('<style>.pro-container{display:none!important}</style>'), out);
    check('injected immediately after the opening <head> tag, before its own existing children', out !== null && out.indexOf('<style>') === out.indexOf('<head>') + '<head>'.length, out);
    check('the matched element itself is left completely intact — not removed', out !== null && out.includes('<div class="pro-container" id="banner-1">AD HERE</div>'), out);
    check('everything else in the document is untouched', out !== null && out.includes('<meta charset="utf-8">') && out.endsWith('</html>'), out);
  }
  {
    // CSS injection doesn't need to know whether anything on the page
    // actually matches — a rule that matches nothing is harmless, so this
    // still injects (unlike the old removal-based design, which returned
    // null for "nothing matched" as a real signal).
    const html = '<html><head></head><body><div class="unrelated">nothing to match</div></body></html>';
    const out = T._applyHtmlFilterSelectors(html, ['.pro-container']);
    check('still injects the <style> block even when nothing on the page happens to match',
      out !== null && out.includes('.pro-container{display:none!important}'), out);
  }
  {
    const html = '<html><head attr="x" class="y"><title>t</title></head><body></body></html>';
    const out = T._applyHtmlFilterSelectors(html, ['.a', '.b']);
    check('multiple selectors all land in ONE <style> block, each its own rule',
      out !== null && out.includes('<style>.a{display:none!important}.b{display:none!important}</style>'), out);
    check('a <head> tag carrying its own attributes is still matched correctly', out !== null && out.includes('<head attr="x" class="y">'), out);
  }
  {
    const html = '<html><body>no head tag at all in this document</body></html>';
    const out = T._applyHtmlFilterSelectors(html, ['.pro-container']);
    check('no <head> tag to anchor on -> returns null (signals "use original bytes")', out === null);
  }
  {
    const out = T._applyHtmlFilterSelectors('', ['.pro-container']);
    check('empty input never throws, just returns null (no <head> found)', out === null);
  }

  console.log('\n== 5. _attachHtmlFilter(): StreamFilter buffering + write/close contract ==');
  {
    lastFilter = null;
    T._attachHtmlFilter('req-1', ['.pro-container']);
    const filter = lastFilter;
    check('filterResponseData was called with the request id', lastFilterRequestId === 'req-1');
    const enc = new TextEncoder();
    filter.ondata({ data: enc.encode('<html><head></head><body><div class="pro-container">AD</div>') });
    filter.ondata({ data: enc.encode('<div class="content">Real content</div></body></html>') });
    filter.onstop();
    check('onstop() writes the modified response and closes the filter',
      filter.closed === true && !filter.disconnected, { closed: filter.closed, disconnected: filter.disconnected });
    const written = decodeWrites(filter);
    check('the <style> hide-rule for the matched selector is present in what was written',
      written.includes('.pro-container{display:none!important}'), written);
    check('the ad element itself is STILL in the markup (hidden via CSS, not removed)', written.includes('<div class="pro-container">AD</div>'), written);
    check('unrelated content survives the round trip', written.includes('Real content'), written);
  }
  {
    lastFilter = null;
    T._attachHtmlFilter('req-2', ['.pro-container']);
    const filter = lastFilter;
    const enc = new TextEncoder();
    filter.ondata({ data: enc.encode('<html><body>no head tag here</body></html>') });
    filter.onstop();
    const written = decodeWrites(filter);
    check('no <head> to anchor on -> writes the ORIGINAL bytes back unchanged', written === '<html><body>no head tag here</body></html>', written);
    check('close() called, disconnect() never called (per the safety contract)', filter.closed === true && !filter.disconnected);
  }
  {
    // Size-guard: once the running byte count exceeds HTML_FILTER_MAX_BYTES,
    // every subsequent chunk (including the one that tripped it) must be
    // written straight through immediately — never dropped/truncated. The
    // oversized chunk deliberately carries a real <head> tag so this test
    // can tell "abort correctly bypassed injection" apart from "abort
    // never triggered but byte counts happened to match anyway" (a real
    // prior bug — HTML_FILTER_MAX_BYTES accidentally set to 50MB instead
    // of 5MB — passed a byte-count-only version of this check right
    // through undetected).
    lastFilter = null;
    T._attachHtmlFilter('req-3', ['.pro-container']);
    const filter = lastFilter;
    const headHtml = '<html><head></head><body>';
    const padding = 'x'.repeat(6 * 1024 * 1024 - headHtml.length); // total > the 5MB guard
    const big = new TextEncoder().encode(headHtml + padding);
    filter.ondata({ data: big });
    const tail = new TextEncoder().encode('TAIL-MARKER');
    filter.ondata({ data: tail });
    filter.onstop();
    check('oversized stream: total bytes written back equals total bytes received (nothing dropped)',
      filter.writes.reduce((n, w) => n + w.byteLength, 0) === big.byteLength + tail.byteLength,
      filter.writes.map(w => w.byteLength));
    check('the tail chunk after the size trip is still present in what was written', decodeWrites(filter).includes('TAIL-MARKER'));
    check('NO <style> block got injected — proves the size guard genuinely bypassed filtering rather than the normal pipeline just happening to run anyway',
      !decodeWrites(filter).includes('<style>'));
    check('closed normally, never disconnected (would truncate)', filter.closed === true && !filter.disconnected);
  }

  console.log('\n== 6. _htmlFilterRequestHandler(): gating ==');
  T.settingsCache.enabled = true;
  T.settingsCache.blockAds = true;
  T.settingsCache.pausedDomains = new Set();
  T.settingsCache.allowedDomains = new Set();
  {
    lastFilter = null;
    T._htmlFilterRequestHandler(fakeHeadersDetails({ requestId: 'g1', url: 'https://tinhte.vn/', type: 'main_frame' }));
    check('matching host + enabled + blockAds + not paused -> stream filter IS attached', lastFilter !== null);
  }
  {
    lastFilter = null;
    T.settingsCache.enabled = false;
    T._htmlFilterRequestHandler(fakeHeadersDetails({ requestId: 'g2', url: 'https://tinhte.vn/', type: 'main_frame' }));
    check('extension disabled -> stream filter NOT attached', lastFilter === null);
    T.settingsCache.enabled = true;
  }
  {
    lastFilter = null;
    T.settingsCache.blockAds = false;
    T._htmlFilterRequestHandler(fakeHeadersDetails({ requestId: 'g2b', url: 'https://tinhte.vn/', type: 'main_frame' }));
    check('blockAds:false -> stream filter NOT attached (checked directly in the handler, not via registration)', lastFilter === null);
    T.settingsCache.blockAds = true;
  }
  {
    lastFilter = null;
    T.settingsCache.pausedDomains = new Set(['tinhte.vn']);
    T._htmlFilterRequestHandler(fakeHeadersDetails({ requestId: 'g3', url: 'https://tinhte.vn/', type: 'main_frame' }));
    check('domain paused -> stream filter NOT attached (original page restored on next reload)', lastFilter === null);
    T.settingsCache.pausedDomains = new Set();
  }
  {
    lastFilter = null;
    T.settingsCache.allowedDomains = new Set(['tinhte.vn']);
    T._htmlFilterRequestHandler(fakeHeadersDetails({ requestId: 'g4', url: 'https://tinhte.vn/', type: 'main_frame' }));
    check('domain user-allowed -> stream filter NOT attached', lastFilter === null);
    T.settingsCache.allowedDomains = new Set();
  }
  {
    lastFilter = null;
    T._htmlFilterRequestHandler(fakeHeadersDetails({ requestId: 'g5', url: 'https://example.com/', type: 'main_frame' }));
    check('host with no direct_hide_selectors registered -> stream filter NOT attached', lastFilter === null);
  }
  {
    lastFilter = null;
    T._htmlFilterRequestHandler(fakeHeadersDetails({ requestId: 'g6', url: 'https://tinhte.vn/pixel.gif', type: 'image' }));
    check('non-document resource type (image) -> stream filter NOT attached', lastFilter === null);
  }
  {
    lastFilter = null;
    T._htmlFilterRequestHandler(fakeHeadersDetails({
      requestId: 'g7', url: 'https://tinhte.vn/', type: 'main_frame',
      responseHeaders: [{ name: 'Content-Length', value: String(6 * 1024 * 1024) }],
    }));
    check('Content-Length header over the size guard -> stream filter NOT attached (cheap pre-check)', lastFilter === null);
  }
  {
    lastFilter = null;
    T._htmlFilterRequestHandler(fakeHeadersDetails({
      requestId: 'g8', url: 'https://tinhte.vn/', type: 'sub_frame',
      responseHeaders: [{ name: 'content-length', value: '1024' }],
    }));
    check('sub_frame IS a real document too -> stream filter attached (header name matched case-insensitively)', lastFilter !== null);
  }

  console.log('\n== 7. Registration timing: listener attached exactly once, synchronously at module load ==');
  check('the listener was ALREADY registered by the time this test runs (no buildActiveRulesFromStorage()/ensureRuleDefinitionsLoaded() call has happened yet in this test file) — proves registration happens synchronously while background.js\'s top-level code runs, not gated behind the async rule-build chain',
    onHeadersReceivedListeners.includes(T._htmlFilterRequestHandler));
  check('registered exactly once (no accidental double add from anything that ran during module load)',
    onHeadersReceivedListeners.filter(f => f === T._htmlFilterRequestHandler).length === 1);
  {
    // A genuinely SEPARATE background.js load (fresh sandbox/context) with
    // filterResponseData already absent BEFORE that load runs — proves the
    // capability gate at the actual registration site, not just that
    // _hasHtmlStreamFilter() itself returns the right boolean (section 1).
    // Toggling filterResponseDataAvailable on the ALREADY-LOADED main `T`
    // instance can't retroactively un-register anything — the one-time
    // top-level `if` already ran — so this needs its own fresh load.
    const noCapListeners = [];
    const noCapChromeStub = Object.assign({}, chromeStub, {
      webRequest: Object.assign({}, chromeStub.webRequest, {
        onHeadersReceived: {
          addListener(fn) { noCapListeners.push(fn); },
          removeListener(fn) { const i = noCapListeners.indexOf(fn); if (i !== -1) noCapListeners.splice(i, 1); },
        },
        filterResponseData: undefined,
      }),
    });
    // A genuinely FRESH sandbox object, not Object.assign({}, sandbox, ...)
    // over the original — that would shallow-copy EVERY own property
    // browser-compat.js already wrote directly onto the contextified
    // `sandbox` during the very first vm.runInContext() call at file load
    // (EXT, EXT_SESSION_STORAGE), AND the original `importScripts` closure,
    // which is hard-bound to the ORIGINAL `ctx` variable — so copying it
    // would run browser-compat.js against the WRONG context, leaving this
    // one's own EXT permanently unset. Both bugs were caught live: the
    // first made this test silently check against a stale, fully-capable
    // EXT (logged hasHtmlStreamFilter:true) and only "passed" because the
    // orphaned listener it registered under that stale EXT happened to be
    // a different function reference than T._htmlFilterRequestHandler —
    // not because the capability gate actually engaged.
    let noCapCtx;
    const noCapSandbox = {
      console, chrome: noCapChromeStub, fetch: fetchStub,
      setTimeout, clearTimeout, setInterval, clearInterval,
      URL, Date, Math, JSON, Promise, RegExp, Set, Map, Number, String, Object, Array, Error,
      CompressionStream, DecompressionStream, Response, TextEncoder, TextDecoder, btoa, atob, Uint8Array,
      navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0' },
      importScripts(name) {
        if (name && name.includes('scriptlet-alias-map')) vm.runInContext(scriptletAliasMapSrc, noCapCtx, { filename: 'scriptlet-alias-map.js' });
        else if (name && name.includes('browser-compat')) vm.runInContext(browserCompatSrc, noCapCtx, { filename: 'browser-compat.js' });
        else if (name && name.includes('local-storage')) vm.runInContext(localStorageSrc, noCapCtx, { filename: 'local-storage.js' });
        else if (name && name.includes('session-storage')) vm.runInContext(sessionStorageSrc, noCapCtx, { filename: 'session-storage.js' });
        else if (name && name.includes('utils')) vm.runInContext(utilsSrc, noCapCtx, { filename: 'utils.js' });
        else vm.runInContext(configSrc, noCapCtx, { filename: 'config.js' });
      },
    };
    noCapSandbox.self = noCapSandbox;
    noCapSandbox.globalThis = noCapSandbox;
    noCapCtx = vm.createContext(noCapSandbox);
    vm.runInContext(bgSrc, noCapCtx, { filename: 'background.js' });
    check('capability check itself reports false in this fresh context (not a stale cached true)',
      !(noCapSandbox.EXT && noCapSandbox.EXT.webRequest && typeof noCapSandbox.EXT.webRequest.filterResponseData === 'function'));
    check('no capability at load time -> registration is skipped entirely, not just deferred', noCapListeners.length === 0);
  }

  console.log('\n== 8. Cache round-trip: HTML_FILTER_MATCHER survives _saveBuiltRulesToCache/_loadBuiltRulesFromCache ==');
  {
    T.HTML_FILTER_MATCHER = new Map([['tinhte.vn', ['.pro-container']]]);
    await T._saveBuiltRulesToCache('cache-key-1');
    T.HTML_FILTER_MATCHER = new Map(); // clobber before reload to prove the load actually restores it
    const loaded = await T._loadBuiltRulesFromCache('cache-key-1');
    check('cache load reports success', loaded === true);
    check('HTML_FILTER_MATCHER round-trips through plain JSON with its selector arrays intact',
      JSON.stringify(T.HTML_FILTER_MATCHER.get('tinhte.vn')) === JSON.stringify(['.pro-container']),
      T.HTML_FILTER_MATCHER.get('tinhte.vn'));
  }

  console.log('\n== 9. Integration: buildActiveRulesFromStorage() (re)builds HTML_FILTER_MATCHER via ensureRuleDefinitionsLoaded ==');
  {
    // The listener's registration is no longer wired through this function
    // at all (see section 7) — buildActiveRulesFromStorage()'s job here is
    // purely to make sure a real end-to-end build populates
    // HTML_FILTER_MATCHER from the actual parsed rule/site-rules.txt, and
    // that the listener already sitting in onHeadersReceivedListeners
    // (from module load) is left untouched by it either way.
    storageData.enabled = true;
    storageData.blockAds = true;
    const before = onHeadersReceivedListeners.filter(f => f === T._htmlFilterRequestHandler).length;
    await T.buildActiveRulesFromStorage();
    check('HTML_FILTER_MATCHER got (re)built from the real parsed rules (non-empty DEFAULT_RULES proves a real build ran)',
      T.DEFAULT_RULES.length > 0);
    check('buildActiveRulesFromStorage() does not touch the listener registration at all',
      onHeadersReceivedListeners.filter(f => f === T._htmlFilterRequestHandler).length === before);
  }
  {
    storageData.enabled = false;
    const before = onHeadersReceivedListeners.filter(f => f === T._htmlFilterRequestHandler).length;
    await T.buildActiveRulesFromStorage();
    check('enabled:false early-return path also leaves the listener registration untouched',
      onHeadersReceivedListeners.filter(f => f === T._htmlFilterRequestHandler).length === before);
    storageData.enabled = true;
  }

  console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
  process.exitCode = fail ? 1 : 0;
})();
