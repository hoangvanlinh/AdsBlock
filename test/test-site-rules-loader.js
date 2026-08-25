// Smoke test: load the real content/site-rules-loader.js in a vm sandbox and
// verify its _fetchAndMergeDirect() fallback path (used when
// chrome.runtime.sendMessage to background.js fails/times out — plausible
// on a fresh navigation racing a cold-starting MV3 service worker) respects
// the same Rule Source enable/disable flags the primary GET_SITE_CONFIG
// path does. 2026-08-22: found live — this fallback unconditionally
// included the default remote source regardless of defaultRuleSourceEnabled,
// and ignored per-source `enabled: false` entirely, both silently, because
// it's a separate, hand-duplicated copy of background.js's
// fetchRemoteRuleText() that never got the same fixes applied to it.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'content/site-rules-loader.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, ok, extra) {
  if (ok) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// ── stubs ───────────────────────────────────────────────────────────
const storageData = {};
const messageListeners = [];
let sendMessageBehavior = 'fail'; // 'fail' = simulate background unreachable (exercises the fallback)
let fetchBehavior = {}; // url -> text, or url -> null for a 404/failure

const chromeStub = {
  runtime: {
    lastError: null,
    getManifest: () => ({ version: '1.0.35' }),
    getURL: p => 'chrome-extension://test/' + p,
    sendMessage(msg, cb) {
      if (sendMessageBehavior === 'fail') {
        chromeStub.runtime.lastError = { message: 'simulated: could not establish connection' };
        cb(undefined);
        chromeStub.runtime.lastError = null;
        return;
      }
      cb({ siteKey: '', global: {}, site: {} });
    },
    onMessage: { addListener(fn) { messageListeners.push(fn); } },
  },
  storage: {
    local: {
      // Callbacks fire via queueMicrotask, not synchronously — a real
      // chrome.storage.local.get()/set() always round-trips (genuine IPC),
      // so any OTHER unrelated chrome.runtime.lastError set moments earlier
      // (e.g. by sendMessage's own synchronous callback, still nested in the
      // same call stack) is guaranteed cleared by the time these fire in a
      // real browser. A synchronous callback here let a stale lastError
      // leak into getCachedRules()'s own check, making it always see a
      // "failed" storage read even on a genuinely successful one — caught
      // by section 6 (2026-08-24) when it needed a cache read to actually
      // succeed after a simulated sendMessage failure, unlike sections 1-5
      // which never exercised that specific ordering.
      get(keys, cb) {
        const arr = typeof keys === 'string' ? [keys] : keys;
        const out = {};
        for (const k of arr) if (k in storageData) out[k] = storageData[k];
        queueMicrotask(() => cb(out));
      },
      set(obj, cb) { Object.assign(storageData, obj); if (cb) queueMicrotask(cb); },
    },
  },
};

// Records every URL fetchStub is called with — used by the DEBUG_LOCAL
// tests below to prove the bundled default entry's URL was never fetched
// over the network (replaced by the local file instead).
let fetchCallLog = [];
async function fetchStub(url) {
  fetchCallLog.push(url);
  const text = fetchBehavior[url];
  if (text == null) return { ok: false, text: async () => '' };
  return { ok: true, text: async () => text };
}

const sandbox = {
  console, chrome: chromeStub, EXT: chromeStub, fetch: fetchStub,
  Promise, Set, Array, Object, RegExp, JSON, Date,
  CompressionStream, DecompressionStream, Response, TextEncoder, TextDecoder, btoa, atob, Uint8Array,
  location: { hostname: 'example.com' },
};
sandbox.self = sandbox;
sandbox.window = sandbox;
sandbox.self.ADBLOCK_CONFIG = {
  DEBUG_LOCAL: false,
  // A second entry (off by default, like a real region list) lets the
  // DEBUG_LOCAL tests below prove that OTHER enabled default sources still
  // get fetched even while the first (bundled) entry is replaced by the
  // local file — off here means the existing non-debug tests above (which
  // never override it) are unaffected by its presence.
  RULES_REMOTE_URL: [
    { name: 'Default', url: 'https://remote.test/site-rules.txt', enable: true },
    { name: 'Region', url: 'https://remote.test/region-list.txt', enable: false },
  ],
  RULES_LOCAL_PATH: 'rule/site-rules.txt',
  RULES_CACHE_TEXT_KEY: 'siteRulesCacheText',
  RULES_CACHE_TIME_KEY: 'siteRulesCacheTime',
  RULES_CACHE_TTL_MS: 6 * 60 * 60 * 1000,
};
const ctx = vm.createContext(sandbox);
vm.runInContext(src, ctx, { filename: 'site-rules-loader.js' });
const loader = sandbox.window.__qkv1Loader;

function loadSite() {
  return new Promise(resolve => loader.loadSite(resolve));
}

// Separate context with DEBUG_LOCAL: true — the loader reads that flag once
// at script-load time (var DEBUG_LOCAL=!!_CFG.DEBUG_LOCAL at the top of the
// IIFE), so exercising it needs its own instance rather than mutating the
// config after the fact. Shares storageData/chromeStub/fetchStub with the
// main context — those are read fresh on every call, not captured at load.
const sandboxDebug = {
  console, chrome: chromeStub, EXT: chromeStub, fetch: fetchStub,
  Promise, Set, Array, Object, RegExp, JSON, Date,
  CompressionStream, DecompressionStream, Response, TextEncoder, TextDecoder, btoa, atob, Uint8Array,
  location: { hostname: 'example.com' },
};
sandboxDebug.self = sandboxDebug;
sandboxDebug.window = sandboxDebug;
sandboxDebug.self.ADBLOCK_CONFIG = { ...sandbox.self.ADBLOCK_CONFIG, DEBUG_LOCAL: true };
const ctxDebug = vm.createContext(sandboxDebug);
vm.runInContext(src, ctxDebug, { filename: 'site-rules-loader.js (DEBUG_LOCAL)' });
const debugLoader = sandboxDebug.window.__qkv1Loader;

function loadSiteDebug() {
  return new Promise(resolve => debugLoader.loadSite(resolve));
}

(async () => {
  console.log('\n== 1. Fallback path respects defaultRuleSourceEnabled: false ==');
  Object.keys(storageData).forEach(k => delete storageData[k]);
  storageData.defaultRuleSourceEnabled = false;
  storageData.ruleSources = [];
  fetchBehavior = { 'https://remote.test/site-rules.txt': '[global]\ndirect_hide_selectors = .should-not-appear' };
  loader.reset();
  const site1 = await loadSite();
  check('default disabled: fallback does not fetch/include the default remote source',
    !(site1.global.direct_hide_selectors || []).includes('.should-not-appear'),
    site1.global);
  check('default disabled + nothing else configured: resolves to empty global, not local-file fallback',
    Object.keys(site1.global).length === 0, site1.global);

  console.log('\n== 2. Fallback path respects per-source enabled: false ==');
  Object.keys(storageData).forEach(k => delete storageData[k]);
  storageData.defaultRuleSourceEnabled = false;
  storageData.ruleSources = [
    { id: 'a', type: 'url', url: 'https://enabled.test/x.txt', enabled: true },
    { id: 'b', type: 'url', url: 'https://disabled.test/y.txt', enabled: false },
  ];
  fetchBehavior = {
    'https://enabled.test/x.txt': '[global]\ndirect_hide_selectors = .from-enabled-source',
    'https://disabled.test/y.txt': '[global]\ndirect_hide_selectors = .from-DISABLED-source-should-not-appear',
  };
  loader.reset();
  const site2 = await loadSite();
  check('enabled source contributes its rules',
    (site2.global.direct_hide_selectors || []).includes('.from-enabled-source'), site2.global);
  check('disabled source is skipped entirely, even in the fallback path',
    !(site2.global.direct_hide_selectors || []).includes('.from-DISABLED-source-should-not-appear'),
    site2.global);

  console.log('\n== 3. A genuine fetch failure still falls back to cached/local, unlike a deliberate empty config ==');
  Object.keys(storageData).forEach(k => delete storageData[k]);
  storageData.defaultRuleSourceEnabled = true; // enabled, but...
  storageData.ruleSources = [];
  fetchBehavior = {}; // ...the fetch itself fails (not in fetchBehavior -> ok:false)
  loader.reset();
  const site3 = await loadSite();
  // With no cache and a failed remote fetch, this falls through to
  // fetchLocalRules() (chrome.runtime.getURL(LOCAL_RULES_PATH)) — not
  // stubbed here, so it resolves ok:false too; the key assertion is just
  // that this path does NOT throw and resolves to *some* well-formed shape.
  check('a real fetch failure resolves without throwing', site3 && typeof site3 === 'object', site3);

  console.log('\n== 4. DEBUG_LOCAL: true layers bundled local rules + OTHER enabled sources + customRulesText (2026-08-22) ==');
  // "tôi muốn load nhiều rule cùng lúc để test" — DEBUG_LOCAL used to mean
  // local file + customRulesText ONLY, silently dropping every other
  // enabled Rule Source (region lists, user-added ruleSources). The bundled
  // default entry (RULES_REMOTE_URL[0]) is swapped for the local file, but
  // every OTHER enabled source — the 'Region' entry here, plus ruleSources —
  // still gets fetched/merged normally, matching background.js.
  Object.keys(storageData).forEach(k => delete storageData[k]);
  fetchBehavior = {
    'chrome-extension://test/rule/site-rules.txt': '[global]\ndirect_hide_selectors = .from-bundled-local',
    'https://remote.test/region-list.txt': '[global]\ndirect_hide_selectors = .from-region-list',
    'https://ruleSource.test/x.txt': '[global]\ndirect_hide_selectors = .from-rulesource',
  };
  storageData.defaultRuleSourceOverrides = { 'https://remote.test/region-list.txt': true };
  storageData.ruleSources = [{ id: 'a', type: 'url', url: 'https://ruleSource.test/x.txt', enabled: true }];
  storageData.customRulesText = '[global]\ndirect_hide_selectors = .from-custom-rules-text';
  fetchCallLog = [];
  debugLoader.reset();
  const debugSite = await loadSiteDebug();
  check('DEBUG_LOCAL: bundled local rules are included',
    (debugSite.global.direct_hide_selectors || []).includes('.from-bundled-local'), debugSite.global);
  check('DEBUG_LOCAL: another currently-enabled default source (region list) is ALSO fetched and merged in',
    (debugSite.global.direct_hide_selectors || []).includes('.from-region-list'), debugSite.global);
  check('DEBUG_LOCAL: a user-added ruleSources URL is ALSO fetched and merged in',
    (debugSite.global.direct_hide_selectors || []).includes('.from-rulesource'), debugSite.global);
  check('DEBUG_LOCAL: customRulesText is ALSO merged in',
    (debugSite.global.direct_hide_selectors || []).includes('.from-custom-rules-text'), debugSite.global);
  check('DEBUG_LOCAL: the bundled default entry\'s URL is NEVER fetched over the network — replaced by the local file',
    !fetchCallLog.includes('https://remote.test/site-rules.txt'), fetchCallLog);

  console.log('\n== 5. DEBUG_LOCAL: true with nothing else enabled still resolves cleanly to just the local file ==');
  Object.keys(storageData).forEach(k => delete storageData[k]);
  fetchCallLog = [];
  debugLoader.reset();
  const debugSiteNoCustom = await loadSiteDebug();
  check('DEBUG_LOCAL: bundled local rules alone still resolve without throwing',
    (debugSiteNoCustom.global.direct_hide_selectors || []).includes('.from-bundled-local'), debugSiteNoCustom.global);
  check('DEBUG_LOCAL: with the region entry disabled again (no override), it is not fetched',
    !fetchCallLog.includes('https://remote.test/region-list.txt'), fetchCallLog);

  console.log('\n== 6. Compressed rule-cache storage (2026-08-24) — mirrors background.js\'s wrapper format ==');
  Object.keys(storageData).forEach(k => delete storageData[k]);
  storageData.defaultRuleSourceEnabled = false;
  storageData.ruleSources = [];
  const repetitiveText = '[global]\ndirect_hide_selectors = ' + Array.from({ length: 300 }, (_, i) => '.ad-slot-marker-' + i).join(' | ');
  fetchBehavior = { 'https://remote.test/site-rules.txt': '' }; // irrelevant here, default source disabled anyway
  loader.reset();
  await loadSite(); // primes an initial (empty) cache write via _fetchAndMergeDirect
  // Directly exercise setCachedRules/getCachedRules via the SAME storage key
  // background.js uses — this fallback module doesn't export them (keeps
  // its public surface to loadSite/load/reset only, matching production),
  // so drive it through the module's own cache-write path instead: seed a
  // fresh ruleSources entry serving repetitiveText, force a reload, then
  // inspect the resulting storageData entry directly.
  storageData.ruleSources = [{ id: 'c', type: 'url', url: 'https://cache-test.example/x.txt', enabled: true }];
  fetchBehavior = { 'https://remote.test/site-rules.txt': '', 'https://cache-test.example/x.txt': repetitiveText };
  loader.reset();
  await loadSite();
  const storedRaw = storageData['siteRulesCacheText'];
  check('cache write produces the {format,data} wrapper, not a bare string',
    storedRaw && typeof storedRaw === 'object' && typeof storedRaw.data === 'string',
    JSON.stringify(storedRaw).slice(0, 200));
  check('format is deflate-raw-b64 (CompressionStream available in this Node runtime)',
    storedRaw && storedRaw.format === 'deflate-raw-b64', storedRaw && storedRaw.format);
  check('compressed+base64 data is meaningfully smaller than the merged text it was built from',
    storedRaw && storedRaw.data.length < repetitiveText.length * 0.5,
    storedRaw && `stored=${storedRaw.data.length}`);
  // Second load (fresh reset, no network stub needed) must serve from the
  // now-fresh cache and still resolve the SAME selector — proving the
  // compressed value round-trips correctly through this module's own
  // getCachedRules()/isFreshCache() path, not just background.js's.
  fetchCallLog = [];
  loader.reset();
  const cachedSite = await loadSite();
  check('a subsequent load serves from the compressed cache (no re-fetch) and resolves correctly',
    !fetchCallLog.includes('https://cache-test.example/x.txt')
      && (cachedSite.global.direct_hide_selectors || []).includes('.ad-slot-marker-0'),
    { fetchCallLog, global: cachedSite.global });

  console.log('\n== 7. entry.url as an ARRAY in the fallback path too (2026-08-25) — mirrors background.js\'s _entryUrls ==');
  Object.keys(storageData).forEach(k => delete storageData[k]);
  storageData.defaultRuleSourceEnabled = false;
  storageData.ruleSources = [];
  sandbox.self.ADBLOCK_CONFIG.RULES_REMOTE_URL.push({
    name: 'Multi-URL Test Group', url: ['https://remote.test/multi-a.txt', 'https://remote.test/multi-b.txt'], enable: false,
  });
  try {
    storageData.defaultRuleSourceOverrides = { 'https://remote.test/multi-a.txt': true }; // enable keyed by the PRIMARY (first) url
    fetchBehavior = {
      'https://remote.test/multi-a.txt': '[global]\ndirect_hide_selectors = .fallback-multi-a',
      'https://remote.test/multi-b.txt': '[global]\ndirect_hide_selectors = .fallback-multi-b',
    };
    loader.reset();
    const multiSite = await loadSite();
    check('fallback path: BOTH urls in the array are fetched and merged (first url\'s content present)',
      (multiSite.global.direct_hide_selectors || []).includes('.fallback-multi-a'), multiSite.global);
    check('fallback path: BOTH urls in the array are fetched and merged (second url\'s content ALSO present)',
      (multiSite.global.direct_hide_selectors || []).includes('.fallback-multi-b'), multiSite.global);

    delete storageData.siteRulesCacheText; delete storageData.siteRulesCacheTime; // else the previous (enabled) fetch's cache would still be "fresh"
    storageData.defaultRuleSourceOverrides = { 'https://remote.test/multi-a.txt': false }; // disable via the SAME primary-url key
    loader.reset();
    const multiSiteDisabled = await loadSite();
    check('fallback path: disabling via the primary url\'s override stops BOTH urls in the group',
      !(multiSiteDisabled.global.direct_hide_selectors || []).includes('.fallback-multi-a')
        && !(multiSiteDisabled.global.direct_hide_selectors || []).includes('.fallback-multi-b'),
      multiSiteDisabled.global);
  } finally {
    sandbox.self.ADBLOCK_CONFIG.RULES_REMOTE_URL.pop();
  }

  console.log(`\n== RESULT: ${passed} passed, ${failed} failed ==`);
  process.exit(failed ? 1 : 0);
})();
