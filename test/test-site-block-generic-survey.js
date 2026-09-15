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
        // GENERIC_SELECTORS_SURVEY (2026-09-15) is what _surveyGenericSelectors
        // actually sends now — GET_GENERIC_SELECTORS itself is untouched
        // (still used by boot()'s post-reset reconciliation survey), so this
        // stub answers both identically: real background.js resolves both
        // from the exact same hash->selector lookup.
        if (msg.type === 'GET_GENERIC_SELECTORS' || msg.type === 'GENERIC_SELECTORS_SURVEY') {
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
  // Captures the callback passed to `new MutationObserver(cb)` so a test can
  // synthesize a mutation record and invoke it directly — real
  // MutationObserver batches change notifications onto a microtask, but the
  // CALLBACK itself (once invoked) runs synchronously, same as here.
  class MutationObserverStub {
    constructor(cb) { this.cb = cb; MutationObserverStub.instances.push(this); }
    observe() {}
    disconnect() {}
  }
  MutationObserverStub.instances = [];
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
  T._observerInstances = MutationObserverStub.instances;
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

    check('GENERIC_SELECTORS_SURVEY was actually sent with the survey\'s hashes (2026-09-15 — was GET_GENERIC_SELECTORS)',
      T._sentMessages.some(m => m.type === 'GENERIC_SELECTORS_SURVEY' && m.hashes.includes(realAdBannerHash) && m.hashes.includes(realSidebarIdHash)),
      T._sentMessages);
    check('both matched selectors ended up in _matchedGenericSelectors',
      T.getMatchedGeneric().includes('.ad-banner') && T.getMatchedGeneric().includes('#sidebar-ad'),
      T.getMatchedGeneric());
    check('the unmatched class contributed nothing extra (background found no bucket for it)',
      T.getMatchedGeneric().length === 2, T.getMatchedGeneric());

    // 2026-09-15: a matched survey no longer triggers a SEPARATE CSS_SET
    // re-injection from the content script — background.js now applies the
    // matched selectors itself, in the SAME round trip as
    // GENERIC_SELECTORS_SURVEY (a new `direct-generic-N` slot — see that
    // handler's own comment in background.js), collapsing what used to be
    // 2 sequential round trips into 1. This is genuinely tested in
    // test/test-blocking.js instead (background actually owns the apply
    // now), not here (this harness only runs the content-script half).
    const cssMsg = T._sentMessages.filter(m => m.type === 'CSS_SET' && m.slot === 'direct').pop();
    check('no separate CSS_SET reinject is sent from content script for a generic match anymore — background applies it directly',
      !cssMsg || !(cssMsg.css.includes('.ad-banner{display:none!important}') || cssMsg.css.includes('#sidebar-ad{display:none!important}')),
      cssMsg && cssMsg.css);
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
    const genericMsgs = T._sentMessages.filter(m => m.type === 'GET_GENERIC_SELECTORS' || m.type === 'GENERIC_SELECTORS_SURVEY');
    check('...and no generic-selector survey message was ever sent for it',
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

  console.log('\n== 5. Regression (2026-09-15): the generic survey runs SYNCHRONOUSLY from the MutationObserver callback, not deferred behind schedule()/requestIdleCallback — cuts the exposure window for newly-appearing content on a continuously-mutating page (live-reported repeatedly on vnexpress.net) ==');
  {
    const probe = makeSandbox('/x');
    const newSlotHash = probe._hashGenericToken(0x2E, 'new-ad-slot');
    const T = makeSandbox('/x', {
      genericSelectorsByHash: { [newSlotHash]: '.new-ad-slot' },
    });
    T.boot();
    // watchPageClasses() (also called from sync(), same as startObserver())
    // early-returns with no strip_page_classes/strip_inline_styles
    // configured (the default here) — so the ONE MutationObserver created is
    // unambiguously startObserver()'s own.
    check('startObserver() registered exactly one MutationObserver', T._observerInstances.length === 1, T._observerInstances.length);
    T._sentMessages.length = 0; // isolate: only care about what the mutation itself triggers
    const addedNode = new FakeElement({ class: 'new-ad-slot' });
    T._observerInstances[0].cb([{ type: 'childList', addedNodes: [addedNode] }]);
    // Checked SYNCHRONOUSLY, right here, before any setTimeout/
    // requestIdleCallback tick — window.requestIdleCallback is undefined in
    // this sandbox, so schedule()'s own deferred scan() falls back to
    // setTimeout(fn,50), which has NOT fired yet at this point in the test.
    check('GENERIC_SELECTORS_SURVEY for the new node\'s class was sent SYNCHRONOUSLY from the observer callback, before any deferred scan() tick',
      T._sentMessages.some(m => m.type === 'GENERIC_SELECTORS_SURVEY' && m.hashes.includes(newSlotHash)),
      T._sentMessages);
  }

  console.log('\n== 6. Regression (2026-09-15): RULES_CHANGED/PRIVACY_TOGGLE never shrinks the generic-matched CSS before a replacement is ready ==');
  {
    const T = makeSandbox('/x');
    T.boot(); // a real, first page load — this is boot() call #1
    check('_matchedGenericSelectors starts empty on a fresh page load', T.getMatchedGeneric().length === 0, T.getMatchedGeneric());
    // Seed it as if an earlier survey THIS SAME page load already found a
    // match (mirrors real usage: the generic survey appends to this array
    // as new content streams in over the page's life).
    T.getMatchedGeneric().push('.old-generic-match');
    T.boot(); // boot() call #2 — mirrors RULES_CHANGED/PRIVACY_TOGGLE re-running it on the ALREADY-loaded page
    check('_matchedGenericSelectors is NOT wiped by boot() re-running — carries over instead of resetting to []',
      T.getMatchedGeneric().includes('.old-generic-match'), T.getMatchedGeneric());
    const built = T._buildDirectRules();
    check('_buildDirectRules() still includes the carried-over match — the very first post-reset CSS send is never smaller than before',
      built.all.includes('.old-generic-match'), built.all);
  }

  console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
})();
