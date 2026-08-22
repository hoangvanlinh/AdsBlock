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
      get(keys, cb) {
        const arr = typeof keys === 'string' ? [keys] : keys;
        const out = {};
        for (const k of arr) if (k in storageData) out[k] = storageData[k];
        cb(out);
      },
      set(obj, cb) { Object.assign(storageData, obj); if (cb) cb(); },
    },
  },
};

async function fetchStub(url) {
  const text = fetchBehavior[url];
  if (text == null) return { ok: false, text: async () => '' };
  return { ok: true, text: async () => text };
}

const sandbox = {
  console, chrome: chromeStub, fetch: fetchStub,
  Promise, Set, Array, Object, RegExp, JSON, Date,
  location: { hostname: 'example.com' },
};
sandbox.self = sandbox;
sandbox.window = sandbox;
sandbox.self.ADBLOCK_CONFIG = {
  DEBUG_LOCAL: false,
  RULES_REMOTE_URL: 'https://remote.test/site-rules.txt',
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

  console.log(`\n== RESULT: ${passed} passed, ${failed} failed ==`);
  process.exit(failed ? 1 : 0);
})();
