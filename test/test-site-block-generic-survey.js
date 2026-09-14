// Harness: runs the real content/site-block.js in Node (same vm-sandbox
// technique as test-site-block-path-scope.js) to verify the generic
// ("low-generic") cosmetic selector survey (2026-09-14) — the content-script
// half of the [global] direct_hide_selectors optimization (see
// background.js's _classifyGenericSelectors' own comment: real
// EasyList+EasyPrivacy content measured ~96% of that list as a bare class/id
// selector, previously sent to insertCSS on every single page regardless of
// relevance). This file hashes the id/class tokens actually present in ITS
// OWN page's DOM and asks background (GET_GENERIC_SELECTORS) for just the
// matching subset.
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

// A minimal fake element supporting exactly what site-block.js's survey code
// (and the pre-existing code it runs alongside) touches: id/class attribute
// reads, a '[id],[class]' querySelectorAll over its own subtree, plus the
// classList/style/addEventListener shape test-site-block-path-scope.js's own
// fakeEl() already established for the rest of the file to interact with.
class FakeElement {
  constructor(opts) {
    opts = opts || {};
    this.nodeType = 1;
    this.id = opts.id || '';
    this._class = opts.class || '';
    this.children = opts.children || [];
    this.classList = { contains: () => false, remove() {} };
    this.style = { getPropertyValue: () => '', removeProperty() {} };
  }
  addEventListener() {}
  removeEventListener() {}
  getAttribute(name) {
    if (name === 'class') return this._class || null;
    if (name === 'id') return this.id || null;
    return null;
  }
  querySelectorAll() {
    // Only '[id],[class]' is ever requested by this file's survey code —
    // a flat, order-independent list of every descendant carrying either
    // attribute is sufficient here, no real CSS selector parsing needed.
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (c.id || c._class) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

// url -> response object (or a function(msg) -> response) a test can seed
// before calling into site-block.js — keyed by msg.type since that's all
// GET_GENERIC_SELECTORS/CSS_SET dispatch on here.
function makeSandbox(pathname, opts) {
  opts = opts || {};
  const listeners = { window: {}, document: {} };
  const fakeEl = () => new FakeElement();
  const documentElement = opts.documentElement || fakeEl();
  const body = fakeEl();
  const documentStub = {
    documentElement, body, readyState: 'complete',
    addEventListener(type, fn) { (listeners.document[type] = listeners.document[type] || []).push(fn); },
    removeEventListener() {},
    createElement: () => ({ setAttribute() {}, style: {}, appendChild() {} }),
    querySelectorAll: () => [],
    dispatchEvent() { return true; },
  };
  const sentMessages = [];
  const genericSelectorsByHash = opts.genericSelectorsByHash || {}; // hash -> selector string(s)
  const windowStub = {
    addEventListener(type, fn) { (listeners.window[type] = listeners.window[type] || []).push(fn); },
    removeEventListener() {},
    __qkv1Loader: {
      loadSite(cb) { cb(opts.siteConfigResponse || { siteKey: '', global: {}, site: {} }); },
      reset() {},
    },
    __qkv1FastpathStorage: undefined,
    __qkv1UnhideAll: undefined,
    requestIdleCallback: undefined,
  };
  const chromeStub = {
    storage: { local: { get(keys, cb) { cb({}); }, onChanged: { addListener() {} } } },
    runtime: {
      sendMessage: (msg) => {
        sentMessages.push(msg);
        if (msg.type === 'GET_GENERIC_SELECTORS') {
          const out = new Set();
          for (const h of (msg.hashes || [])) {
            const sel = genericSelectorsByHash[h];
            if (Array.isArray(sel)) sel.forEach(s => out.add(s));
            else if (sel) out.add(sel);
          }
          return Promise.resolve({ selectors: Array.from(out) });
        }
        return Promise.resolve({ ok: true });
      },
      onMessage: { addListener() {} },
      getURL: (p) => 'chrome-extension://test/' + p,
      getManifest: () => ({ version: '1.0.0' }),
    },
  };
  class MutationObserverStub { observe() {} disconnect() {} }
  class CustomEventStub {
    constructor(type, o) { this.type = type; this.detail = o && o.detail; }
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
  const closeIdx = siteBlockSrc.lastIndexOf('})();');
  if (closeIdx === -1) throw new Error('could not find site-block.js\'s closing IIFE to inject the test export into');
  const patched = siteBlockSrc.slice(0, closeIdx) +
    `\nself.__test = {
      _hashGenericToken, _collectNewGenericHashes, _surveyGenericSelectors, _buildDirectRules,
      _injectDirectStyle, _rebuildSelectorCache, boot,
      setConfig: function(c){ _config = c; },
      getCachedDirect: function(){ return _cachedDirect; },
      getMatchedGeneric: function(){ return _matchedGenericSelectors; },
      getQueriedHashCount: function(){ return _queriedGenericHashes.size; },
      getSurveyEligible: function(){ return _genericSurveyEligible; },
      setEnabled: function(v){ _enabled = v; },
    };\n` +
    siteBlockSrc.slice(closeIdx);
  vm.runInContext(patched, ctx, { filename: 'site-block.js' });
  const T = sandbox.window.__test;
  T._sentMessages = sentMessages;
  return T;
}

(async () => {
  console.log('== 1. _hashGenericToken — mirrors background.js\'s formula exactly ==');
  {
    const T = makeSandbox('/x');
    check('same type+token always hashes the same', T._hashGenericToken(0x2E, 'ad-banner') === T._hashGenericToken(0x2E, 'ad-banner'));
    check('a class and an id with identical spelling hash differently (type-prefixed)',
      T._hashGenericToken(0x2E, 'foo') !== T._hashGenericToken(0x23, 'foo'));
    // Cross-checked directly against background.js's own copy of the formula
    // via test-blocking.js's own _hashGenericToken tests — both must agree
    // on the SAME numeric value for the survey to ever resolve anything.
    check('#ad container -> matches the documented djb2 formula (0x23 type prefix)',
      typeof T._hashGenericToken(0x23, 'ad') === 'number' && T._hashGenericToken(0x23, 'ad') >= 0 && T._hashGenericToken(0x23, 'ad') <= 0xFFFFFF);
  }

  console.log('\n== 2. _collectNewGenericHashes — DOM survey, only NEW tokens ==');
  {
    const tree = new FakeElement({ children: [
      new FakeElement({ class: 'ad-banner sponsored' }),
      new FakeElement({ id: 'sidebar-ad', children: [
        new FakeElement({ class: 'inner-widget' }),
      ] }),
      new FakeElement({}), // no id/class at all — contributes nothing
    ] });
    const T = makeSandbox('/x');
    const out1 = [];
    T._collectNewGenericHashes(tree, out1);
    check('first survey of a 4-token tree (2 classes + 1 id + 1 multi-class-splitting into 2) finds all new hashes',
      out1.length === 4, out1); // ad-banner, sponsored, #sidebar-ad, inner-widget
    check('re-surveying the SAME tree finds nothing new (already-queried tokens are never re-emitted)',
      (() => { const out2 = []; T._collectNewGenericHashes(tree, out2); return out2.length === 0; })());
    check('after two surveys, the queried-hash set has exactly 4 entries, not double-counted',
      T.getQueriedHashCount() === 4, T.getQueriedHashCount());
  }

  console.log('\n== 3. _surveyGenericSelectors — end-to-end: DOM tokens -> hash -> message -> matched selectors -> re-injection ==');
  {
    const adBannerHash = 0; // placeholder, computed below via the real function
    const T0 = makeSandbox('/x');
    const realAdBannerHash = T0._hashGenericToken(0x2E, 'ad-banner');
    const realSidebarIdHash = T0._hashGenericToken(0x23, 'sidebar-ad');

    const tree = new FakeElement({ children: [
      new FakeElement({ class: 'ad-banner' }),
      new FakeElement({ id: 'sidebar-ad' }),
      new FakeElement({ class: 'totally-unmatched-class' }),
    ] });
    const T = makeSandbox('/x', {
      genericSelectorsByHash: {
        [realAdBannerHash]: '.ad-banner',
        [realSidebarIdHash]: '#sidebar-ad',
      },
    });
    T.setConfig({ direct_hide_selectors: ['.site-specific-selector'] });
    T._rebuildSelectorCache();
    T._surveyGenericSelectors(tree);
    // sendMessage resolves asynchronously (a real Promise) — let it settle.
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    check('GET_GENERIC_SELECTORS was actually sent with the survey\'s hashes',
      T._sentMessages.some(m => m.type === 'GET_GENERIC_SELECTORS' && m.hashes.includes(realAdBannerHash) && m.hashes.includes(realSidebarIdHash)),
      T._sentMessages);
    check('both matched selectors ended up in _matchedGenericSelectors',
      T.getMatchedGeneric().includes('.ad-banner') && T.getMatchedGeneric().includes('#sidebar-ad'),
      T.getMatchedGeneric());
    check('the unmatched class contributed nothing extra (background found no bucket for it)',
      T.getMatchedGeneric().length === 2, T.getMatchedGeneric());

    const cssMsg = T._sentMessages.filter(m => m.type === 'CSS_SET' && m.slot === 'direct').pop();
    check('a NEW match triggers re-injection: the CSS actually sent includes the survey-discovered selectors',
      !!cssMsg && cssMsg.css.includes('.ad-banner{display:none!important}') && cssMsg.css.includes('#sidebar-ad{display:none!important}'),
      cssMsg && cssMsg.css);
    check('...alongside the pre-existing site-specific selector (appended, not replaced)',
      !!cssMsg && cssMsg.css.includes('.site-specific-selector{display:none!important}'), cssMsg && cssMsg.css);
  }

  console.log('\n== 4. _genericSurveyEligible — a host with its OWN direct_hide_selectors override skips the survey entirely ==');
  // background.js's _mergeConfigs REPLACES (not merges) direct_hide_selectors
  // when the site section defines its own — [global]'s generic selectors
  // never apply to such a host at all, so surveying would be pure waste.
  {
    const T = makeSandbox('/x', {
      siteConfigResponse: {
        siteKey: 'somesite', global: { direct_hide_selectors: ['.global-generic'] },
        site: { direct_hide_selectors: ['.site-own-selector'] },
      },
    });
    T.boot();
    check('a host with its own direct_hide_selectors override: survey eligibility is turned OFF',
      T.getSurveyEligible() === false);
    const genericMsgs = T._sentMessages.filter(m => m.type === 'GET_GENERIC_SELECTORS');
    check('...and no GET_GENERIC_SELECTORS message was ever sent for it',
      genericMsgs.length === 0, genericMsgs);
  }
  {
    const T = makeSandbox('/x', {
      siteConfigResponse: {
        siteKey: '', global: { direct_hide_selectors: [] }, site: {},
      },
    });
    T.boot();
    check('a host with NO site-specific override: survey eligibility stays ON',
      T.getSurveyEligible() === true);
  }

  console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
})();
