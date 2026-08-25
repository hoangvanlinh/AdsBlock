// Harness: loads background.js in TWO SEPARATE VM contexts sharing the same
// backing chrome.storage.local/session data — simulates a real MV3 service
// worker restart (fresh module-level state: _parsedRules=null etc.) rather
// than test-blocking.js's single shared context, which can't exercise this
// specific cross-restart behavior. Verifies getParsedRules()'s
// chrome.storage.session-backed parse cache (2026-08-23): a second "cold
// start" reuses the already-parsed object instead of re-running
// parseRuleText() on the raw text, is byte-identical to a real parse, and
// correctly detects staleness when the rules text changes.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const configSrc = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
const browserCompatSrc = fs.readFileSync(path.join(ROOT, 'browser-compat.js'), 'utf8');
const scriptletAliasMapSrc = fs.readFileSync(path.join(ROOT, 'scriptlet-alias-map.js'), 'utf8');
const bgSrc = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const localRules = fs.readFileSync(path.join(ROOT, 'rule/site-rules.txt'), 'utf8');

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra !== undefined ? ' — ' + extra : ''}`); }
}

// Shared backing store across both "cold starts" — real chrome.storage.local
// persists across an actual SW restart, and so does chrome.storage.session
// (cleared only on browser restart, not SW restart) — exactly what's being
// tested here.
const storageData = {};
const sessionStorageData = {};

function makeSandbox() {
  const noopEvent = { addListener() {} };
  const messageListeners = [];
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
        async remove(k) { for (const key of (Array.isArray(k) ? k : [k])) delete storageData[key]; },
      },
      session: {
        async get(keys) {
          if (keys == null) return { ...sessionStorageData };
          const arr = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
          const out = {};
          for (const k of arr) if (k in sessionStorageData) out[k] = sessionStorageData[k];
          return out;
        },
        async set(obj) { Object.assign(sessionStorageData, obj); },
      },
      onChanged: { addListener() {} },
    },
    declarativeNetRequest: { getDynamicRules: async () => [], updateDynamicRules: async () => {} },
    runtime: {
      getURL: p => 'chrome-extension://test/' + p, getManifest: () => ({ version: '1.0.0' }),
      onMessage: { addListener(fn) { messageListeners.push(fn); } }, onInstalled: noopEvent, onStartup: noopEvent,
    },
    // Real dashboard-triggered reloads query every open tab to notify them —
    // no tabs open in this harness, just needs to resolve to an empty list.
    tabs: { query: async () => [], sendMessage: async () => {}, onCreated: noopEvent, onRemoved: noopEvent, onActivated: noopEvent, onUpdated: noopEvent },
    action: { setIcon() {}, setBadgeText() {}, setBadgeBackgroundColor() {} },
    alarms: { create() {}, onAlarm: noopEvent },
    scripting: { insertCSS: async () => {}, removeCSS: async () => {} },
    webNavigation: { onCommitted: noopEvent },
    contextMenus: { create() {}, onClicked: noopEvent, removeAll(cb) { cb && cb(); } },
  };
  async function fetchStub(url) {
    if (url.includes('site-rules.txt')) return { ok: true, status: 200, headers: { get: () => '' }, text: async () => localRules };
    return { ok: false, status: 404, headers: { get: () => '' }, text: async () => '' };
  }
  const sandbox = {
    console, chrome: chromeStub, fetch: fetchStub,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, Date, Math, JSON, Promise, RegExp, Set, Map, Number, String, Object, Array, Error,
    navigator: { userAgent: 'x' },
    importScripts(name) {
      if (name && name.includes('scriptlet-alias-map')) vm.runInContext(scriptletAliasMapSrc, ctx, { filename: 's.js' });
      else if (name && name.includes('browser-compat')) vm.runInContext(browserCompatSrc, ctx, { filename: 'b.js' });
      else vm.runInContext(configSrc, ctx, { filename: 'c.js' });
    },
  };
  sandbox.self = sandbox; sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(bgSrc + '\nself.__test = { getParsedRules, resolveSiteKey, PARSED_RULES_SESSION_KEY };', ctx, { filename: 'background.js' });
  const t = sandbox.__test;
  // Dispatches a message through the REAL chrome.runtime.onMessage listener
  // this SW instance registered (background.js's own top-level listener) —
  // used below to trigger the exact same 'RULES_CHANGED' path the dashboard
  // sends, not a direct call to an internal function.
  t.dispatchMessage = (msg) => new Promise((resolve) => {
    messageListeners[0](msg, {}, resolve);
  });
  return t;
}

(async () => {
  console.log('== Cross-SW-restart parsed-rules session cache (2026-08-23) ==');

  const T1 = makeSandbox(); // "cold start" #1 — session cache starts empty
  const parsed1 = await T1.getParsedRules();
  check('cold start #1 (empty session cache) parses successfully', !!parsed1.host_patterns);
  check('cold start #1 writes the session cache for the next restart', !!sessionStorageData[T1.PARSED_RULES_SESSION_KEY]);

  const T2 = makeSandbox(); // "cold start" #2 — FRESH VM, but SAME sessionStorageData (simulates real SW restart)
  const parsed2 = await T2.getParsedRules();
  check('cold start #2 (warm session cache) resolves youtube.com correctly',
    T2.resolveSiteKey(parsed2.host_patterns, 'youtube.com') === 'youtube');
  check('cold start #2 (warm session cache) resolves facebook.com correctly',
    T2.resolveSiteKey(parsed2.host_patterns, 'facebook.com') === 'facebook');
  check('cache-restored parsed object is byte-identical to a real fresh parse',
    JSON.stringify(parsed1) === JSON.stringify(parsed2));

  // Staleness: once the underlying rules text actually changes, the stored
  // hash no longer matches — a THIRD "cold start" must re-parse, not keep
  // silently serving the now-stale cached object.
  storageData.siteRulesCacheText = localRules + '\n[newsection]\ndirect_hide_selectors = .totally-new-marker';
  storageData.siteRulesCacheTime = Date.now();
  const T3 = makeSandbox();
  const parsed3 = await T3.getParsedRules();
  check('after rules text changes, a new cold start re-parses instead of serving the stale cache',
    !!(parsed3.newsection && (parsed3.newsection.direct_hide_selectors || []).includes('.totally-new-marker')),
    JSON.stringify(parsed3.newsection));

  console.log('\n== Real dashboard-triggered path: RULES_CHANGED message -> debouncedReloadRules() -> reloadRules() -> applyNetworkRules() -> getParsedRules() (2026-08-25) ==');
  // Reset to a clean slate — T1-T3 above left storageData.siteRulesCacheText
  // set to a hand-crafted string, not what a real fetch would produce.
  for (const k of Object.keys(storageData)) delete storageData[k];
  for (const k of Object.keys(sessionStorageData)) delete sessionStorageData[k];

  const T4 = makeSandbox(); // fresh "SW" — establishes the baseline (bundled local rules only)
  const parsedBaseline = await T4.getParsedRules();
  const baselineHash = sessionStorageData[T4.PARSED_RULES_SESSION_KEY] && sessionStorageData[T4.PARSED_RULES_SESSION_KEY].hash;
  check('baseline load (no custom rules yet) resolves youtube.com correctly',
    T4.resolveSiteKey(parsedBaseline.host_patterns, 'youtube.com') === 'youtube');
  check('baseline load wrote a session cache entry', !!baselineHash);

  // Simulate a real dashboard edit: user adds a custom rule and clicks Save
  // (dashboard.js writes customRulesText via chrome.storage.local.set, THEN
  // sends RULES_CHANGED — mirrored here in the same order).
  storageData.customRulesText = '[global]\ndirect_hide_selectors = .rule-B-marker';
  const t0 = Date.now();
  const reply1 = await T4.dispatchMessage({ type: 'RULES_CHANGED' });
  const reloadMs = Date.now() - t0;
  check('RULES_CHANGED message is acknowledged (ok:true) after the real reload completes', reply1 && reply1.ok === true, reply1);
  console.log(`  (real reloadRules() round-trip, incl. the 400ms debounce window: ${reloadMs}ms)`);

  const parsedAfterEdit = await T4.getParsedRules(); // same SW instance, _parsedRules already updated in-memory
  check('after RULES_CHANGED, the SAME SW instance sees the new custom rule immediately',
    (parsedAfterEdit.global && parsedAfterEdit.global.direct_hide_selectors || []).includes('.rule-B-marker'),
    parsedAfterEdit.global);
  const hashAfterEdit = sessionStorageData[T4.PARSED_RULES_SESSION_KEY] && sessionStorageData[T4.PARSED_RULES_SESSION_KEY].hash;
  check('the session cache entry was actually REPLACED (new hash), not left stale from before the edit',
    !!hashAfterEdit && hashAfterEdit !== baselineHash, { baselineHash, hashAfterEdit });

  // A SEPARATE SW instance ("restart" #2, e.g. the idle-timeout kind that
  // has nothing to do with this edit) must see rule B too — proving the
  // real dashboard-triggered edit is visible across a genuine restart, not
  // just to the SW instance that happened to process the RULES_CHANGED
  // message.
  const T5 = makeSandbox();
  const t1 = Date.now();
  const parsedT5 = await T5.getParsedRules();
  const t5Ms = Date.now() - t1;
  check('a FRESH SW instance after the edit sees rule B too (via the warm session cache, not a stale copy)',
    (parsedT5.global && parsedT5.global.direct_hide_selectors || []).includes('.rule-B-marker'), parsedT5.global);
  console.log(`  (cross-restart getParsedRules() served from the warm session cache: ${t5Ms}ms)`);

  // Now the "dashboard Save clicked but nothing actually changed" case: send
  // RULES_CHANGED again with customRulesText untouched. reloadRules() always
  // busts+refetches the raw text regardless (it can't know in advance
  // whether content changed), but since the refetched text is BYTE-IDENTICAL
  // to what's already cached, the session-cache hash comes out the same —
  // so a LATER restart still gets to reuse the warm cache instead of paying
  // for a real re-parse it doesn't need.
  const reply2 = await T4.dispatchMessage({ type: 'RULES_CHANGED' }); // same instance, no real change
  check('a second RULES_CHANGED with no real content change still acks ok', reply2 && reply2.ok === true, reply2);
  const hashAfterNoopEdit = sessionStorageData[T4.PARSED_RULES_SESSION_KEY] && sessionStorageData[T4.PARSED_RULES_SESSION_KEY].hash;
  check('a no-op RULES_CHANGED (content unchanged) leaves the session-cache hash IDENTICAL',
    hashAfterNoopEdit === hashAfterEdit, { hashAfterEdit, hashAfterNoopEdit });

  const T6 = makeSandbox();
  const t2 = Date.now();
  const parsedT6 = await T6.getParsedRules();
  const t6Ms = Date.now() - t2;
  check('a restart AFTER the no-op edit still gets served from the (still-valid) warm session cache',
    (parsedT6.global && parsedT6.global.direct_hide_selectors || []).includes('.rule-B-marker'), parsedT6.global);
  console.log(`  (restart after a no-op edit, still warm-cache-served: ${t6Ms}ms)`);

  console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
