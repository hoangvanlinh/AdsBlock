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
      onMessage: noopEvent, onInstalled: noopEvent, onStartup: noopEvent,
    },
    tabs: { query: async () => [], onCreated: noopEvent, onRemoved: noopEvent, onActivated: noopEvent, onUpdated: noopEvent },
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
      else vm.runInContext(configSrc, ctx, { filename: 'c.js' });
    },
  };
  sandbox.self = sandbox; sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(bgSrc + '\nself.__test = { getParsedRules, resolveSiteKey, PARSED_RULES_SESSION_KEY };', ctx, { filename: 'background.js' });
  return sandbox.__test;
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

  console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
