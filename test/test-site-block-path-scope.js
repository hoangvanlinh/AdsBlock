// Harness: runs the real content/site-block.js in Node (same vm-sandbox
// technique as the other test/*.js files) to verify the AdGuard '[$path=...]'
// path-scoping decode side (2026-09-07) — background.js's converter encodes
// a '\x01<regex>\x01' prefix onto a direct_hide_selectors entry or scriptlet
// value (see that file's _abpEncodePathScope/_abpPathModifierToRegexSource);
// this file's _stripPathScope() is the ONLY place that peels it back off,
// since it's the one context (content script) that actually knows the
// current page's real location.pathname. Focused on _stripPathScope itself
// plus _rebuildSelectorCache's use of it — the highest-risk, least-obvious
// part of this feature (a wrong regex/boundary here silently mis-hides or
// under-hides real pages) — not a full DOM/event integration test of the
// whole file, which needs a much bigger stub surface for comparatively
// little extra confidence given _stripPathScope is pure and easy to reason
// about directly.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const siteBlockSrc = fs.readFileSync(path.join(ROOT, 'content/site-block.js'), 'utf8');

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); }
}

// ── Minimal DOM/browser stub — just enough for site-block.js's top-level
// boot() to run to completion without throwing. No real cosmetic-hide
// behavior is exercised here (that's content/scriptlets.js and content.js's
// own, already-separately-tested territory) — this harness only cares about
// _stripPathScope and _rebuildSelectorCache, both pure/synchronous once
// _config is set.
function makeSandbox(pathname) {
  const listeners = { window: {}, document: {} };
  const fakeEl = () => ({
    classList: { contains: () => false, remove() {} },
    style: { getPropertyValue: () => '', removeProperty() {} },
    addEventListener() {}, removeEventListener() {},
  });
  const documentElement = fakeEl();
  const body = fakeEl();
  const documentStub = {
    documentElement, body, readyState: 'complete',
    addEventListener(type, fn) { (listeners.document[type] = listeners.document[type] || []).push(fn); },
    removeEventListener() {},
    createElement: () => ({ setAttribute() {}, style: {}, appendChild() {} }),
    querySelectorAll: () => [],
    dispatchEvent() { return true; },
  };
  const windowStub = {
    addEventListener(type, fn) { (listeners.window[type] = listeners.window[type] || []).push(fn); },
    removeEventListener() {},
    __qkv1Loader: {
      // loadSite's real signature is (cb) — resolve synchronously with an
      // empty config; _config gets overwritten directly by the test via
      // T._setConfig() below, this is just enough to let boot() finish.
      loadSite(cb) { cb({ siteKey: '', global: {}, site: {} }); },
      reset() {},
    },
    __qkv1FastpathStorage: undefined, // forces the inert no-op stub path (see site-block.js's own comment)
    __qkv1UnhideAll: undefined,
    requestIdleCallback: undefined, // forces the setTimeout(fn,50) fallback path
  };
  const sentMessages = [];
  const chromeStub = {
    storage: { local: { get(keys, cb) { cb({}); }, onChanged: { addListener() {} } } },
    runtime: {
      sendMessage: (msg) => { sentMessages.push(msg); return { catch() {} }; },
      onMessage: { addListener() {} },
      getURL: (p) => 'chrome-extension://test/' + p,
      getManifest: () => ({ version: '1.0.0' }), // extValid() checks this exists
    },
  };
  class MutationObserverStub {
    observe() {} disconnect() {}
  }
  class CustomEventStub {
    constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; }
  }
  const sandbox = {
    console,
    document: documentStub,
    location: { pathname, href: 'https://example.com' + pathname, hostname: 'example.com' },
    MutationObserver: MutationObserverStub,
    CustomEvent: CustomEventStub,
    Set, Map, WeakSet, WeakMap, Promise, RegExp, JSON, Object, Array, String, Number, Error,
    TextDecoder, TextEncoder, URL,
    setTimeout, clearTimeout, requestIdleCallback: undefined,
    chrome: chromeStub, EXT: chromeStub,
  };
  sandbox.window = windowStub;
  sandbox.self = sandbox.window;
  const ctx = vm.createContext(sandbox);
  // Insert an export snippet INSIDE the file's own top-level IIFE (site-block.js
  // is wrapped in `(function(){ ... })();`) — appending AFTER it, like the
  // background.js test harnesses do, wouldn't see any of its internal names,
  // since the IIFE already closed its own scope by then.
  const closeIdx = siteBlockSrc.lastIndexOf('})();');
  if (closeIdx === -1) throw new Error('could not find site-block.js\'s closing IIFE to inject the test export into');
  const patched = siteBlockSrc.slice(0, closeIdx) +
    `\nself.__test = { _stripPathScope, _rebuildSelectorCache, flattenSelectors, _injectDirectStyle,
      setConfig: function(c){ _config = c; }, getCachedDirect: function(){ return _cachedDirect; },
      getCachedDirectStyle: function(){ return _cachedDirectStyle; } };\n` +
    siteBlockSrc.slice(closeIdx);
  vm.runInContext(patched, ctx, { filename: 'site-block.js' });
  const T = sandbox.window.__test;
  T._sentMessages = sentMessages;
  return T;
}

(async () => {
  console.log('== 1. _stripPathScope — decode side of the [$path=...] encoding ==');
  {
    const T = makeSandbox('/images/foo.jpg');
    check('no marker at all: value returned completely unchanged',
      T._stripPathScope('.plain-selector') === '.plain-selector');
    check('empty string: returned as-is, no throw',
      T._stripPathScope('') === '');
    check("marker present, path MATCHES ('^/images' vs '/images/foo.jpg'): marker stripped, real value returned",
      T._stripPathScope('\x01^/images\x01.ad-in-images') === '.ad-in-images');
    check("marker present, path does NOT match ('^/video' vs '/images/foo.jpg'): returns null",
      T._stripPathScope('\x01^/video\x01.ad-on-video') === null);
    check('regex-form marker (alternation, no escaping) matches correctly',
      T._stripPathScope('\x01\\/(maps|navi)\\/\x01.selector') === null, 'should NOT match /images/foo.jpg');
  }
  {
    const T = makeSandbox('/maps/somewhere');
    check('regex-form marker matches when the real path contains /maps/',
      T._stripPathScope('\x01\\/(maps|navi)\\/\x01.selector') === '.selector');
  }
  {
    const T = makeSandbox('/anything');
    check('malformed marker (no closing \\x01): whole string returned as a literal, not thrown/crashed',
      T._stripPathScope('\x01unterminated-no-second-delimiter') === '\x01unterminated-no-second-delimiter');
    check('an uncompilable regex source: never matches (returns null), does not throw',
      T._stripPathScope('\x01(unclosed\x01.selector') === null);
  }

  console.log('\n== 2. _rebuildSelectorCache — filters _cachedDirect through _stripPathScope ==');
  {
    const T = makeSandbox('/images/x');
    T.setConfig({
      direct_hide_selectors: [
        '.always-hidden',
        '\x01^/images\x01.hidden-on-images',
        '\x01^/video\x01.hidden-on-video',
      ],
    });
    T._rebuildSelectorCache();
    const direct = T.getCachedDirect();
    check('unconditional selector always present', direct.includes('.always-hidden'), direct);
    check('path-matching selector present (marker stripped)', direct.includes('.hidden-on-images'), direct);
    check('non-matching path-scoped selector excluded entirely (not left in with its marker attached)',
      !direct.includes('.hidden-on-video') && !direct.some(s => s.indexOf('\x01') !== -1), direct);
    check('exactly 2 of the 3 configured entries survive for this pathname', direct.length === 2, direct);
  }
  {
    // A DIFFERENT pathname on the same config — proves this isn't cached
    // once and reused stale; the SAME _config re-filters correctly against
    // whatever location.pathname is current at _rebuildSelectorCache() time.
    const T = makeSandbox('/video/y');
    T.setConfig({
      direct_hide_selectors: [
        '.always-hidden',
        '\x01^/images\x01.hidden-on-images',
        '\x01^/video\x01.hidden-on-video',
      ],
    });
    T._rebuildSelectorCache();
    const direct = T.getCachedDirect();
    check('same config, DIFFERENT pathname (/video/y): the /video-scoped selector applies instead',
      direct.includes('.hidden-on-video') && !direct.includes('.hidden-on-images'), direct);
  }
  {
    const T = makeSandbox('/x');
    T.setConfig(null);
    T._rebuildSelectorCache();
    check('no _config at all: _cachedDirect is an empty array, not a throw',
      Array.isArray(T.getCachedDirect()) && T.getCachedDirect().length === 0, T.getCachedDirect());
  }

  console.log('\n== 3. direct_style_rules — verbatim CSS-injection rules ("force", 2026-09-07) ==');
  {
    const T = makeSandbox('/x');
    T.setConfig({
      direct_hide_selectors: ['.hidden-one'],
      direct_style_rules: ['.forced-visible{display: block !important;}'],
    });
    T._rebuildSelectorCache();
    const styleRules = T.getCachedDirectStyle();
    check('_rebuildSelectorCache populates _cachedDirectStyle from direct_style_rules',
      styleRules.length === 1 && styleRules[0] === '.forced-visible{display: block !important;}', styleRules);

    T._injectDirectStyle();
    const cssMsg = T._sentMessages.filter(m => m.type === 'CSS_SET' && m.slot === 'direct').pop();
    check('_injectDirectStyle sends a CSS_SET message for the \'direct\' slot',
      !!cssMsg, T._sentMessages);
    check('...containing BOTH the auto-wrapped hide rule AND the verbatim style rule, in the same stylesheet text',
      cssMsg && cssMsg.css.indexOf('.hidden-one{display:none!important}') !== -1 &&
      cssMsg.css.indexOf('.forced-visible{display: block !important;}') !== -1,
      cssMsg && cssMsg.css);
  }
  {
    // direct_style_rules alone (no direct_hide_selectors at all) must still
    // trigger a real CSS_SET send — the early-return-on-empty guard checks
    // BOTH caches now, not just _cachedDirect.
    const T = makeSandbox('/x');
    T.setConfig({ direct_style_rules: ['.only-style{width: 10px !important;}'] });
    T._rebuildSelectorCache();
    T._injectDirectStyle();
    const cssMsg = T._sentMessages.filter(m => m.type === 'CSS_SET' && m.slot === 'direct').pop();
    check('direct_style_rules ALONE (no direct_hide_selectors) still sends real, non-empty CSS — not skipped by the empty-_cachedDirect early return',
      !!cssMsg && cssMsg.css.indexOf('.only-style{width: 10px !important;}') !== -1, cssMsg);
  }
  {
    // Path-scoped direct_style_rules entry — same \x01 marker convention as
    // direct_hide_selectors, decoded the same way.
    const T = makeSandbox('/other-page');
    T.setConfig({ direct_style_rules: ['\x01^/images\x01.only-on-images{display: block !important;}'] });
    T._rebuildSelectorCache();
    check('a path-scoped direct_style_rules entry is excluded when the current path does not match',
      T.getCachedDirectStyle().length === 0, T.getCachedDirectStyle());
  }
  {
    const T = makeSandbox('/images/x');
    T.setConfig({ direct_style_rules: ['\x01^/images\x01.only-on-images{display: block !important;}'] });
    T._rebuildSelectorCache();
    const styleRules = T.getCachedDirectStyle();
    check('...and included, with the marker stripped, when the current path DOES match',
      styleRules.length === 1 && styleRules[0] === '.only-on-images{display: block !important;}', styleRules);
  }

  console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
})();
