// Smoke test: load the real content/scriptlets.js in a vm sandbox and verify
// blk-event dispatch behavior for window.open blocking and json_prune_xhr
// (only real prunes count). scriptlets.js auto-invokes at document_start
// (static content_scripts) with the literal '__QKV1_BUILD_TOKEN__'
// placeholder — a real build substitutes a random value (_build-lib.sh),
// but this harness runs the checked-in source as-is, so event names are
// built from that same literal placeholder.
'use strict';
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(require('path').join(__dirname, '..', 'content/scriptlets.js'), 'utf8');

const TEST_TOKEN = '__QKV1_BUILD_TOKEN__';

// ── minimal window/DOM stubs ──────────────────────────────────────
const listeners = {};
let blockedEvents = [];

class CustomEventStub {
  constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; }
}

const docClickHandlers = [];
const documentStub = {
  readyState: 'loading',
  addEventListener(type, fn) { if (type === 'click') docClickHandlers.push(fn); },
  createElement(tag) {
    const el = {
      tagName: tag.toUpperCase(), style: { cssText: '' }, remove() {}, contentWindow: { closed: false },
      _attrs: {}, setAttribute(name, value) { this._attrs[name] = value; },
    };
    documentStub.lastCreatedElement = el;
    return el;
  },
  body: { appendChild() {} },
  documentElement: {},
  getElementById() { return null; }, // overridden per-test where movie_player is needed
  // Always defined (not just "overridden per-test") — ssapUnplayableRetry's
  // retry-driver calls this from a REAL setInterval(1000ms), which can fire
  // during ANY later test's own setTimeout wait, not just its own section.
  // Returning null unconditionally is a safe default: every call site
  // already null-guards its result, so this just makes shouldRetry() always
  // false (no DOM-driven retry in this harness — that codepath isn't
  // covered by these tests, see the ssapUnplayableRetry test section).
  querySelector() { return null; },
};

class FakeXHR {
  constructor() { this.readyState = 4; this._fakeHeaders = {}; }
  open(method, url) { this._url = url; }
  send(body) { this._sentBody = body; }
  get response() { return this._fakeResponse; }
  get responseText() { return typeof this._fakeResponse === 'string' ? this._fakeResponse : ''; }
  getResponseHeader(name) {
    const key = Object.keys(this._fakeHeaders).find(k => k.toLowerCase() === String(name).toLowerCase());
    return key ? this._fakeHeaders[key] : null;
  }
  getAllResponseHeaders() {
    return Object.entries(this._fakeHeaders).map(([k, v]) => `${k}: ${v}`).join('\r\n') + (Object.keys(this._fakeHeaders).length ? '\r\n' : '');
  }
}

class NodeStub {}
Object.defineProperty(NodeStub.prototype, 'textContent', {
  get() { return this._text || ''; }, set(v) { this._text = v; }, configurable: true,
});
// Insertion methods trusted_replace_script_text hooks via proxyApplyFn —
// plain no-op-ish stubs, just enough surface for the proxy to wrap.
NodeStub.prototype.appendChild = function (node) { (this._children = this._children || []).push(node); return node; };
NodeStub.prototype.insertBefore = function (node) { (this._children = this._children || []).push(node); return node; };
class ElementStub extends NodeStub {}
ElementStub.prototype.insertAdjacentElement = function (position, el) { (this._children = this._children || []).push(el); return el; };
ElementStub.prototype.append = function (...nodes) { (this._children = this._children || []).push(...nodes); };
// setAttribute/getAttribute surface for prevent_element_src_loading's
// proxyApplyFn(TagName.prototype.setAttribute) wrap.
ElementStub.prototype.setAttribute = function (name, value) { (this._attrs = this._attrs || {})[name] = value; };
ElementStub.prototype.getAttribute = function (name) { return (this._attrs || {})[name]; };
class HTMLElementStub extends ElementStub {}
// One stub class per tag prevent_element_src_loading supports — each just
// needs its own .prototype.setAttribute for proxyApplyFn to wrap in isolation.
class HTMLScriptElementStub extends ElementStub {}
class HTMLImageElementStub extends ElementStub {}
class HTMLIFrameElementStub extends ElementStub {}
class HTMLLinkElementStub extends ElementStub {}
class EventTargetStub {}
// Records every instance so tests can fire a specific observer's callback
// manually (ssapUnplayableRetry drives its whole retry loop off one).
class MutationObserverStub {
  constructor(cb) { this.cb = cb; MutationObserverStub.instances.push(this); }
  observe() {}
  disconnect() {}
}
MutationObserverStub.instances = [];
class HistoryStub { pushState() {} replaceState() {} }
// Document.prototype.visibilityState — real default 'hidden' so the
// ssapUnplayableRetry spoof-to-'visible' test has something to prove.
class DocumentClass {}
Object.defineProperty(DocumentClass.prototype, 'visibilityState', {
  get() { return 'hidden'; }, configurable: true, enumerable: true,
});
Object.setPrototypeOf(documentStub, DocumentClass.prototype);
// Location stub with a real href accessor so blockAdNavigations can patch it.
class LocationStub {}
Object.defineProperty(LocationStub.prototype, 'href', {
  get() { return this._href; }, set(v) { this._href = v; }, configurable: true, enumerable: true,
});
const locationStub = new LocationStub();
locationStub._href = 'https://test.example.com/';
locationStub.hostname = 'test.example.com';
locationStub.origin = 'https://test.example.com';

const sandbox = {
  Node: NodeStub, Element: ElementStub, HTMLElement: HTMLElementStub,
  EventTarget: EventTargetStub, MutationObserver: MutationObserverStub,
  History: HistoryStub, history: new HistoryStub(),
  console, JSON, Math, Object, Array, String, Number, RegExp, Promise, Set, Map,
  WeakMap, WeakSet, Proxy, Reflect, Symbol, Error, TypeError, Date, parseFloat, parseInt, Uint8Array,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  CustomEvent: CustomEventStub,
  Window: class Window {},
  Document: DocumentClass,
  XMLHttpRequest: FakeXHR,
  Location: LocationStub,
  URL,
  // Stores constructor args (unlike a bare clone()-only stub) — needed to
  // observe what body the TextEncoder/Request edit-path hook (proxyApplyFn's
  // `construct` trap) actually passed through to the real constructor.
  Request: class Request {
    constructor(url, init) { this.url = url; this.body = init && init.body; }
    clone() { return this; }
  },
  document: documentStub,
  location: locationStub,
  navigator: { userAgent: 'test', sendBeacon(url, data) { sendBeaconCalls.push([url, data]); return true; } },
  open: () => ({ close() {}, closed: false }), // window.open
  HTMLScriptElement: HTMLScriptElementStub,
  HTMLImageElement: HTMLImageElementStub,
  HTMLIFrameElement: HTMLIFrameElementStub,
  HTMLLinkElement: HTMLLinkElementStub,
  // trusted_prune_inbound_object test target — a benign function taking a
  // single object argument, standing in for e.g. a telemetry reporter.
  reportPayload: (obj) => obj,
};
const sendBeaconCalls = [];
// Minimal Headers stand-in — enough for the content-length-fixup code path
// (has/get/set, constructible from a plain object or another FakeHeaders).
class FakeHeaders {
  constructor(init) {
    this._map = {};
    if (init instanceof FakeHeaders) {
      for (const k in init._map) this._map[k] = init._map[k];
    } else if (init && typeof init === 'object') {
      for (const k in init) this._map[k.toLowerCase()] = String(init[k]);
    }
  }
  has(name) { return Object.prototype.hasOwnProperty.call(this._map, String(name).toLowerCase()); }
  get(name) { return this.has(name) ? this._map[String(name).toLowerCase()] : null; }
  set(name, value) { this._map[String(name).toLowerCase()] = String(value); }
}

// Fake fetch/Response pair — enough surface for jsonPruneFetchResponse
// (clone / json / Response.json static / status metadata, and — for the
// content-length fixup — the `new Response(stringBody, init)` constructor
// form alongside the pre-existing object form).
class FakeResponse {
  constructor(objOrText, init) {
    if (typeof objOrText === 'string') { this._obj = undefined; this._text = objOrText; }
    else { this._obj = objOrText; this._text = undefined; }
    this.status = (init && init.status) || 200;
    this.statusText = (init && init.statusText) || 'OK';
    this.headers = (init && init.headers) || new FakeHeaders();
    this.ok = true; this.redirected = false; this.type = 'basic'; this.url = '';
  }
  clone() { return new FakeResponse(this._obj !== undefined ? this._obj : this._text, { status: this.status, statusText: this.statusText, headers: this.headers }); }
  async json() { return this._obj !== undefined ? this._obj : JSON.parse(this._text); }
  async text() { return this._text !== undefined ? this._text : JSON.stringify(this._obj); }
  static json(obj) { return new FakeResponse(obj); }
}
let fetchPayload = {};
let fetchResponseHeaders = new FakeHeaders();
let lastFetchArgs = null; // [url, init] as actually seen by the transport — proves a
                           // trusted_edit_request rewrite happened before Reflect.apply.
sandbox.Response = FakeResponse;
sandbox.Headers = FakeHeaders;
sandbox.Blob = Blob; // Node 18+ global — real byte-length semantics, no stub needed
sandbox.TextEncoder = TextEncoder; // Node global — real byte semantics for the TextEncoder/Request edit-path tests
sandbox.TextDecoder = TextDecoder;
sandbox.fetch = async (url, init) => {
  lastFetchArgs = [url, init];
  return new FakeResponse(fetchPayload, { headers: fetchResponseHeaders });
};

// localStorage stub — the boot gate reads the rules cache saved on a
// previous visit (key derived from TEST_TOKEN, same as the real
// _RULES_CACHE_KEY). Preset = "returning visit to a site whose rules use
// response filters": wrappers install AND these rules apply at boot.
const _TEST_RULES_CACHE_KEY = `__${TEST_TOKEN}_rules_cache__`;
const localStorageStore = new Map([
  [_TEST_RULES_CACHE_KEY, JSON.stringify({ json_prune_xhr: ['adPlacements adSlots'] })],
]);
sandbox.localStorage = {
  getItem: k => (localStorageStore.has(k) ? localStorageStore.get(k) : null),
  setItem: (k, v) => { localStorageStore.set(k, String(v)); },
  removeItem: k => { localStorageStore.delete(k); },
};

sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.addEventListener = (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); };
sandbox.removeEventListener = () => {};
sandbox.dispatchEvent = (ev) => {
  if (ev.type === `__${TEST_TOKEN}_blk__`) blockedEvents.push(ev.detail);
  (listeners[ev.type] || []).forEach(fn => fn(ev));
  return true;
};

// FakeXHR's original getter, captured BEFORE the scriptlet installs — used to
// confirm the scriptlet overrode the getter (fix #1 overrides directly on the
// prototype, so window.XMLHttpRequest keeps its identity; can't check with !==).
const _origResponseGetter = Object.getOwnPropertyDescriptor(FakeXHR.prototype, 'response').get;
const xhrWrapped = () =>
  Object.getOwnPropertyDescriptor(sandbox.XMLHttpRequest.prototype, 'response').get !== _origResponseGetter;

vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'scriptlets.js' });

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

function sendRules(rules) {
  sandbox.dispatchEvent(new CustomEventStub(`__${TEST_TOKEN}_rules__`, { detail: rules }));
}

(async () => {
  console.log('== 0. cached rules apply synchronously at boot (before any dispatch) ==');
  blockedEvents = [];
  const BootXHR = sandbox.XMLHttpRequest;
  check('wrappers installed at boot from cache', xhrWrapped());
  const xhrBoot = new BootXHR();
  xhrBoot.open('GET', 'https://www.youtube.com/youtubei/v1/player');
  xhrBoot._fakeResponse = JSON.stringify({ adPlacements: [{ ad: 1 }], videoDetails: { title: 'boot' } });
  const bootObj = JSON.parse(xhrBoot.response);
  check('cached rules prune with NO rules dispatch at all', !bootObj.adPlacements,
    String(xhrBoot.response));
  check('non-ad fields kept', bootObj.videoDetails.title === 'boot');

  console.log('\n== 1. window.open blocking dispatches on ALL block paths ==');
  sendRules({ no_window_open_if: ['/adsite\\.com/ 0 blank'] });
  blockedEvents = [];
  const r1 = sandbox.open('https://adsite.com/popup');
  check('blank decoy: popup intercepted (not real window)', r1 !== undefined);
  check('blank decoy: 1 block event with URL',
    blockedEvents.length === 1 && blockedEvents[0].url === 'https://adsite.com/popup',
    JSON.stringify(blockedEvents));

  blockedEvents = [];
  sandbox.open('https://normal-site.com/page');
  check('non-matching popup NOT counted', blockedEvents.length === 0);

  // plain block form (no delay/decoy) — used to block silently without counting
  sendRules({ no_window_open_if: ['/plainblock\\.com/'] });
  blockedEvents = [];
  const r2 = sandbox.open('https://plainblock.com/x');
  check('plain block: returns null', r2 === null);
  check('plain block: NOW counted (was uncounted before fix)', blockedEvents.length === 1,
    String(blockedEvents.length));

  // iframe decoy form — also used to be uncounted
  sendRules({ no_window_open_if: ['/decoyframe\\.com/ 2 iframe'] });
  blockedEvents = [];
  const r3 = sandbox.open('https://decoyframe.com/x');
  check('iframe decoy: returns decoy popup object', r3 !== null && r3 !== undefined);
  check('iframe decoy: NOW counted (was uncounted before fix)', blockedEvents.length === 1,
    String(blockedEvents.length));
  check('iframe decoy: sandboxed with no allow-scripts (blocks script exec in the loaded popup target)',
    documentStub.lastCreatedElement && documentStub.lastCreatedElement._attrs.sandbox === '',
    JSON.stringify(documentStub.lastCreatedElement && documentStub.lastCreatedElement._attrs));

  // object decoy form — <object> has no sandbox attribute, must be unaffected
  sendRules({ no_window_open_if: ['/decoyobj\\.com/ 2 obj'] });
  sandbox.open('https://decoyobj.com/x');
  check('object decoy: setAttribute never called (no sandbox attr on <object>)',
    Object.keys(documentStub.lastCreatedElement._attrs).length === 0,
    JSON.stringify(documentStub.lastCreatedElement._attrs));

  console.log('\n== 2. json_prune_xhr counts ONLY real prunes ==');
  sendRules({ json_prune_xhr: ['adPlacements adSlots'] });
  const XHR = sandbox.XMLHttpRequest;
  check('XMLHttpRequest was wrapped by scriptlet', xhrWrapped());

  // Response WITH ads → prune happens → 1 event
  blockedEvents = [];
  const xhrAd = new XHR();
  xhrAd.open('GET', 'https://www.youtube.com/youtubei/v1/player');
  xhrAd._fakeResponse = JSON.stringify({ adPlacements: [{ ad: 1 }], videoDetails: { title: 't' } });
  const prunedResp = xhrAd.response;
  check('ad field pruned from response', !JSON.parse(prunedResp).adPlacements,
    String(prunedResp));
  check('kept non-ad fields', JSON.parse(prunedResp).videoDetails.title === 't');
  check('pruned response counted once', blockedEvents.length === 1, String(blockedEvents.length));
  // re-reading the cached response must not count again
  void xhrAd.response;
  check('re-read does not double count', blockedEvents.length === 1, String(blockedEvents.length));

  // content-length must track the PRUNED body — set BEFORE reading .response
  // to prove getResponseHeader forces its own computeResponse() pass rather
  // than depending on .response having been read first (a page checking
  // headers before the body is a realistic, earlier-timed detection order).
  const xhrHdr = new XHR();
  xhrHdr.open('GET', 'https://www.youtube.com/youtubei/v1/player');
  xhrHdr._fakeResponse = JSON.stringify({ adPlacements: [{ ad: 1 }], videoDetails: { title: 'hdr' } });
  xhrHdr._fakeHeaders['content-length'] = String(Buffer.byteLength(xhrHdr._fakeResponse));
  const xhrHdrLen = Number(xhrHdr.getResponseHeader('content-length'));
  const xhrHdrActual = Buffer.byteLength(xhrHdr.response);
  check('json_prune_xhr: getResponseHeader content-length shrinks to match the pruned body',
    xhrHdrLen === xhrHdrActual && xhrHdrLen < Buffer.byteLength(xhrHdr._fakeResponse),
    `header=${xhrHdrLen} actual=${xhrHdrActual} original=${Buffer.byteLength(xhrHdr._fakeResponse)}`);
  check('json_prune_xhr: getAllResponseHeaders content-length line also corrected',
    xhrHdr.getAllResponseHeaders().includes(`content-length: ${xhrHdrActual}`),
    xhrHdr.getAllResponseHeaders());

  // Clean response → nothing pruned → 0 events (the bug this fix addresses)
  blockedEvents = [];
  const xhrClean = new XHR();
  xhrClean.open('GET', 'https://www.youtube.com/youtubei/v1/browse');
  xhrClean._fakeResponse = JSON.stringify({ videoDetails: { title: 'clean' } });
  const cleanResp = xhrClean.response;
  check('clean response passes through unchanged', cleanResp === xhrClean._fakeResponse);
  check('clean response NOT counted (was +1 before fix)', blockedEvents.length === 0,
    String(blockedEvents.length));
  check('json_prune_xhr: content-length NOT added when the original response never had one',
    xhrClean.getResponseHeader('content-length') === null, String(xhrClean.getResponseHeader('content-length')));

  console.log('\n== 3. disable event stops blocking & counting ==');
  sandbox.dispatchEvent(new CustomEventStub(`__${TEST_TOKEN}_dis__`, {}));
  blockedEvents = [];
  const r4 = sandbox.open('https://adsite.com/popup2');
  check('window.open passes through when disabled', r4 && typeof r4.close === 'function');
  check('no block event when disabled', blockedEvents.length === 0);

  console.log('\n== 4. boot race: requests fired BEFORE rules arrive are still filtered ==');
  // XHR opened + response ready before the rules land — the wrapper installed
  // at document_start must still prune when the page reads .response later.
  blockedEvents = [];
  const XHR2 = sandbox.XMLHttpRequest;
  const xhrEarly = new XHR2();
  xhrEarly.open('GET', 'https://www.youtube.com/youtubei/v1/player');
  xhrEarly._fakeResponse = JSON.stringify({ adPlacements: [{ ad: 1 }], videoDetails: { title: 'race' } });
  // fetch fired before rules too — payload carries an ad field
  fetchPayload = { adPlacements: [{ ad: 1 }], videoDetails: { title: 'race' } };
  const earlyFetchPromise = sandbox.fetch('https://www.youtube.com/youtubei/v1/player');
  // rules arrive only NOW (re-enables scriptlets after section 3's disable)
  sendRules({ json_prune_xhr: ['adPlacements adSlots'], json_prune_fetch: ['adPlacements adSlots'] });
  const earlyXhrObj = JSON.parse(xhrEarly.response);
  check('XHR opened before rules: ad field pruned', !earlyXhrObj.adPlacements,
    String(xhrEarly.response));
  check('XHR opened before rules: non-ad fields kept', earlyXhrObj.videoDetails.title === 'race');
  const earlyFetchResp = await earlyFetchPromise;
  const earlyFetchObj = await earlyFetchResp.json();
  check('fetch fired before rules: ad field pruned', !earlyFetchObj.adPlacements,
    JSON.stringify(earlyFetchObj));
  check('fetch fired before rules: non-ad fields kept', earlyFetchObj.videoDetails.title === 'race');

  console.log('\n== 5. re-dispatching rules does not stack proxy layers ==');
  // Same full rule set dispatched again (unpause / RULES_CHANGED path):
  // registries are replaced, so one prune still counts exactly once.
  sendRules({ json_prune_xhr: ['adPlacements adSlots'] });
  sendRules({ json_prune_xhr: ['adPlacements adSlots'] });
  blockedEvents = [];
  const xhrTwice = new XHR2();
  xhrTwice.open('GET', 'https://www.youtube.com/youtubei/v1/player');
  xhrTwice._fakeResponse = JSON.stringify({ adPlacements: [{ ad: 1 }] });
  void xhrTwice.response;
  check('double dispatch: pruned response counted exactly once', blockedEvents.length === 1,
    String(blockedEvents.length));
  check('XMLHttpRequest not re-subclassed on re-dispatch', sandbox.XMLHttpRequest === XHR2);

  console.log('\n== 6. rules cache follows dispatched rules ==');
  // Rules WITH response-filter keys → full rule set cached for the next load
  sendRules({ json_prune_xhr: ['adPlacements adSlots'], no_window_open_if: ['/y\\.com/'] });
  const cached = JSON.parse(localStorageStore.get(_TEST_RULES_CACHE_KEY) || 'null');
  check('full rule set cached when rules contain response-filter keys',
    !!cached && Array.isArray(cached.json_prune_xhr) && Array.isArray(cached.no_window_open_if),
    JSON.stringify(cached));
  // Rules WITHOUT response-filter keys → cache cleared (site no longer needs
  // boot wrappers, e.g. after a rules update removed them). no_window_open_if
  // now counts as a boot-cached key, so use a cosmetic-only rule set here.
  sendRules({ direct_hide_selectors: ['.ad'] });
  check('cache cleared when rules have no response-filter keys',
    !localStorageStore.has(_TEST_RULES_CACHE_KEY));
  sendRules({ json_prune_fetch: ['adPlacements'] });
  const recached = JSON.parse(localStorageStore.get(_TEST_RULES_CACHE_KEY) || 'null');
  check('cache re-saved on next dispatch with response-filter keys',
    !!recached && Array.isArray(recached.json_prune_fetch));

  // Regression test (2026-08-18, live-reproduced via the "Scan page globals"
  // picker on tuoitre.vn — a Delete rule took effect instantly via the
  // ad-hoc apply-now path but silently had NO effect after a reload,
  // because set_constant/abort_on_property_read/abort_on_property_write
  // were never in _RESPONSE_FILTER_RULE_KEYS despite that list's own
  // comment already claiming "set_constant ... run before the page's
  // inline scripts" as the intent — only the async _EVT_RULES dispatch
  // ever applied them, well after document_start, giving the page's own
  // script time to read/bind the original unlocked reference first).
  sendRules({ set_constant: ['someGlobal 1'] });
  const cachedSetConstant = JSON.parse(localStorageStore.get(_TEST_RULES_CACHE_KEY) || 'null');
  check('set_constant alone now triggers the boot cache (closes the reload race)',
    !!cachedSetConstant && Array.isArray(cachedSetConstant.set_constant), JSON.stringify(cachedSetConstant));
  sendRules({ abort_on_property_read: ['someGlobal'] });
  const cachedAbortRead = JSON.parse(localStorageStore.get(_TEST_RULES_CACHE_KEY) || 'null');
  check('abort_on_property_read alone now triggers the boot cache',
    !!cachedAbortRead && Array.isArray(cachedAbortRead.abort_on_property_read), JSON.stringify(cachedAbortRead));
  sendRules({ abort_on_property_write: ['someGlobal'] });
  const cachedAbortWrite = JSON.parse(localStorageStore.get(_TEST_RULES_CACHE_KEY) || 'null');
  check('abort_on_property_write alone now triggers the boot cache',
    !!cachedAbortWrite && Array.isArray(cachedAbortWrite.abort_on_property_write), JSON.stringify(cachedAbortWrite));
  // Leave the cache holding no boot-relevant keys again so later sections
  // (which assume a clean slate) aren't affected by this regression test.
  sendRules({ direct_hide_selectors: ['.ad'] });

  console.log('\n== 7. blockAdNavigations — back-button hijack vectors ==');
  // Protocol-relative cross-origin URL via the patched location.href setter.
  sandbox.location.href = '//ads.evil.example/land';
  check('protocol-relative cross-origin href blocked',
    sandbox.location._href === 'https://test.example.com/', sandbox.location._href);
  // Same-origin absolute URL passes through.
  sandbox.location.href = 'https://test.example.com/next';
  check('same-origin href allowed', sandbox.location._href === 'https://test.example.com/next');
  sandbox.location._href = 'https://test.example.com/'; // reset for URL resolution

  // window.open with a same-tab target must obey the same origin policy.
  check('window.open _self to ad origin blocked',
    sandbox.open('https://ads.evil.example/p', '_self') === null);
  check('window.open _top protocol-relative blocked',
    sandbox.open('//ads.evil.example/p', '_top') === null);
  check('window.open _self same-origin allowed',
    sandbox.open('https://test.example.com/page', '_self') !== null);
  check('window.open _blank not intercepted here',
    sandbox.open('https://ads.evil.example/p', '_blank') !== null);

  // Synthetic (isTrusted=false) clicks on cross-origin anchors are cancelled.
  function fireClick(ev) { docClickHandlers.forEach(h => h(ev)); return ev; }
  let prevented = false;
  fireClick({
    isTrusted: false,
    target: { localName: 'a', href: 'https://ads.evil.example/land', parentNode: null },
    preventDefault() { prevented = true; }, stopPropagation() {},
  });
  check('synthetic click on cross-origin anchor cancelled', prevented);
  prevented = false;
  fireClick({
    isTrusted: false,
    target: { localName: 'a', href: 'https://test.example.com/ok', parentNode: null },
    preventDefault() { prevented = true; }, stopPropagation() {},
  });
  check('synthetic click on same-origin anchor untouched', !prevented);
  // A real user click toward an origin then permits that origin briefly.
  fireClick({
    isTrusted: true,
    target: { localName: 'a', href: 'https://partner.example/out', parentNode: null },
    preventDefault() {}, stopPropagation() {},
  });
  sandbox.location.href = 'https://partner.example/out';
  check('user-clicked origin allowed through href',
    sandbox.location._href === 'https://partner.example/out', sandbox.location._href);
  sandbox.location._href = 'https://test.example.com/';

  console.log('\n== 8. new primitives (2026-07-31): json_prune_on_set, trusted_edit_request/response, trusted_replace_script_text ==');

  // -- set_constant: multiple rules sharing a parent chain must ALL lock --
  // Found via live YouTube testing: 3 rules for ytInitialPlayerResponse.{
  // playerAds,adPlacements,adSlots} each called walk() on the same
  // not-yet-existing "ytInitialPlayerResponse" key; each Object.defineProperty
  // call replaced the previous one's pending trap, so only the LAST rule
  // (adSlots) ever actually locked when the page's real assignment landed —
  // playerAds/adPlacements silently leaked through with real ad data.
  sendRules({ set_constant: [
    'testChainA.leaf1 undefined',
    'testChainA.leaf2 undefined',
    'testChainA.leaf3 undefined',
  ] });
  sandbox.testChainA = { leaf1: 'real1', leaf2: 'real2', leaf3: 'real3', keep: 'yes' };
  check('set_constant: first-registered leaf on a shared parent chain locks',
    sandbox.testChainA.leaf1 === undefined, JSON.stringify(sandbox.testChainA));
  check('set_constant: middle-registered leaf on a shared parent chain locks',
    sandbox.testChainA.leaf2 === undefined, JSON.stringify(sandbox.testChainA));
  check('set_constant: last-registered leaf on a shared parent chain locks',
    sandbox.testChainA.leaf3 === undefined, JSON.stringify(sandbox.testChainA));
  check('set_constant: unrelated field on the shared parent kept',
    sandbox.testChainA.keep === 'yes', JSON.stringify(sandbox.testChainA));

  // -- json_prune_on_set: prune fields the page ASSIGNS directly (not JSON.parsed) --
  sendRules({ json_prune_on_set: ['someAdConfig, ads meta'] });
  sandbox.someAdConfig = { ads: [1, 2], meta: { tracking: true }, keep: 'yes' };
  check('json_prune_on_set: ads pruned', sandbox.someAdConfig.ads === undefined,
    JSON.stringify(sandbox.someAdConfig));
  check('json_prune_on_set: meta pruned', sandbox.someAdConfig.meta === undefined,
    JSON.stringify(sandbox.someAdConfig));
  check('json_prune_on_set: unrelated field kept', sandbox.someAdConfig.keep === 'yes');

  // Real shape used by the [youtube] adunit/instream/eafg request rules —
  // *= "contains" filter on a marker embedded in userAgent, then descend to
  // a sibling client object filtered by clientName, merge-assign into it.
  sendRules({ trusted_edit_request: ['[?..userAgent*="adunit"]..client[?.clientName=="WEB"]+={"clientScreen":"ADUNIT"}, url:youtubei/v1/player'] });
  const XHR8b = sandbox.XMLHttpRequest;
  const xhrMarker = new XHR8b();
  xhrMarker.open('POST', 'https://www.youtube.com/youtubei/v1/player');
  xhrMarker.send(JSON.stringify({ context: { client: { clientName: 'WEB', userAgent: 'Mozilla/5.0 test; adunit' } } }));
  const markerBody = JSON.parse(xhrMarker._sentBody);
  check('trusted_edit_request: *= contains-filter + nested descendant assign applies',
    markerBody.context?.client?.clientScreen === 'ADUNIT' && markerBody.context?.client?.clientName === 'WEB',
    xhrMarker._sentBody);

  // -- channel/lactmilli marker rules + ${now} substitution + =/regex/ filter with =repl() --
  sendRules({ trusted_edit_request: [
    '[?..userAgent*="channel"]..client[?.clientName=="WEB"]+={"clientScreen":"CHANNEL"}, /player?',
    '[?..userAgent*="lactmilli"]+={"params":"8AUB"}, /player?',
    '[?..userAgent*="lactmilli"]..playbackContext.contentPlaybackContext.lactMilliseconds="${now}", /player?',
    '[?..userAgent=/adunit|channel|lactmilli|instream|eafg/]..referer=repl({"regex":"(?:#reloadxhr)?$","replacement":"#reloadxhr"}), /player?',
  ] });
  const XHR8c = sandbox.XMLHttpRequest;
  const xhrChannel = new XHR8c();
  xhrChannel.open('POST', 'https://www.youtube.com/youtubei/v1/player?x=1');
  xhrChannel.send(JSON.stringify({
    context: { client: { clientName: 'WEB', userAgent: 'Mozilla/5.0 test; channel' } },
    referer: 'https://www.youtube.com/watch',
  }));
  const channelBody = JSON.parse(xhrChannel._sentBody);
  check('trusted_edit_request: channel marker sets clientScreen=CHANNEL',
    channelBody.context?.client?.clientScreen === 'CHANNEL', xhrChannel._sentBody);
  check('trusted_edit_request: =/regex/ filter + =repl() appends #reloadxhr to referer',
    channelBody.referer === 'https://www.youtube.com/watch#reloadxhr', xhrChannel._sentBody);

  const xhrLact = new XHR8c();
  xhrLact.open('POST', 'https://www.youtube.com/youtubei/v1/player?x=1');
  const beforeNow = Date.now();
  xhrLact.send(JSON.stringify({
    context: { client: { clientName: 'WEB', userAgent: 'Mozilla/5.0 test; lactmilli' } },
    playbackContext: { contentPlaybackContext: { lactMilliseconds: 0 } },
    referer: 'https://www.youtube.com/watch#reloadxhr',
  }));
  const lactBody = JSON.parse(xhrLact._sentBody);
  check('trusted_edit_request: lactmilli marker merge-assigns params=8AUB at root',
    lactBody.params === '8AUB', xhrLact._sentBody);
  check('trusted_edit_request: ${now} substitutes a fresh timestamp into an existing path',
    Number(lactBody.playbackContext?.contentPlaybackContext?.lactMilliseconds) >= beforeNow,
    xhrLact._sentBody);
  check('trusted_edit_request: =repl() is idempotent when #reloadxhr already present',
    lactBody.referer === 'https://www.youtube.com/watch#reloadxhr', xhrLact._sentBody);

  // -- adunit/instream/eafg: the 3 remaining adblock_wall_retry ladder rungs
  // that used to be no-op spoofs (userAgent marker set, but no matching
  // trusted_edit_request clause) — real uBO source (uAssets experimental.txt)
  // confirms these 3 must actually mutate the /player request body the same
  // way channel/lactmilli already did, or those rungs never had a chance of
  // clearing the wall. Uses the FULL production rule set (site-rules.txt's
  // real trusted_edit_request line) — not an isolated clause — so clause
  // ordering/collisions with channel/lactmilli/referer are also covered.
  sendRules({ trusted_edit_request: [
    '[?..userAgent*="channel"]..client[?.clientName=="WEB"]+={"clientScreen":"CHANNEL"}, /player?',
    '[?..userAgent*="lactmilli"]+={"params":"8AUB"}, /player?',
    '[?..userAgent*="lactmilli"]..playbackContext.contentPlaybackContext.lactMilliseconds="${now}", /player?',
    '[?..userAgent*="adunit"]..client[?.clientName=="WEB"]+={"clientScreen":"ADUNIT"}, /player?',
    '[?..userAgent*="instream"]..playbackContext[?.contentPlaybackContext]+={"adPlaybackContext":{"adType":"AD_TYPE_INSTREAM"}}, /player?',
    '[?..userAgent*="eafg"]+={"params":"eAFgAQ"}, /player?',
    '[?..userAgent=/adunit|channel|lactmilli|instream|eafg/]..referer=repl({"regex":"(?:#reloadxhr)?$","replacement":"#reloadxhr"}), /player?',
  ] });

  const xhrAdunit = new XHR8c();
  xhrAdunit.open('POST', 'https://www.youtube.com/youtubei/v1/player?x=1');
  xhrAdunit.send(JSON.stringify({ context: { client: { clientName: 'WEB', userAgent: 'Mozilla/5.0 test; adunit' } } }));
  const adunitBody = JSON.parse(xhrAdunit._sentBody);
  check('trusted_edit_request: adunit marker sets clientScreen=ADUNIT (production rule set)',
    adunitBody.context?.client?.clientScreen === 'ADUNIT', xhrAdunit._sentBody);

  const xhrInstream = new XHR8c();
  xhrInstream.open('POST', 'https://www.youtube.com/youtubei/v1/player?x=1');
  xhrInstream.send(JSON.stringify({
    context: { client: { clientName: 'WEB', userAgent: 'Mozilla/5.0 test; instream' } },
    playbackContext: { contentPlaybackContext: {} },
  }));
  const instreamBody = JSON.parse(xhrInstream._sentBody);
  check('trusted_edit_request: instream marker sets adPlaybackContext.adType=AD_TYPE_INSTREAM',
    instreamBody.playbackContext?.adPlaybackContext?.adType === 'AD_TYPE_INSTREAM',
    xhrInstream._sentBody);

  const xhrEafg = new XHR8c();
  xhrEafg.open('POST', 'https://www.youtube.com/youtubei/v1/player?x=1');
  xhrEafg.send(JSON.stringify({ context: { client: { clientName: 'WEB', userAgent: 'Mozilla/5.0 test; eafg' } } }));
  const eafgBody = JSON.parse(xhrEafg._sentBody);
  check('trusted_edit_request: eafg marker merge-assigns params=eAFgAQ at root',
    eafgBody.params === 'eAFgAQ', xhrEafg._sentBody);

  // -- json_prune_fetch: playerAds must be pruned from the LIVE /player fetch
  // response, not just via set_constant on the initial ytInitialPlayerResponse
  // global (found via live YouTube testing: set_constant only locks the SSR
  // var, the video player re-fetches its own copy via fetch()/XHR, which
  // json_prune_fetch/json_prune_xhr must ALSO strip playerAds from). --
  sendRules({ json_prune_fetch: ['adPlacements adSlots playerAds playerResponse.adPlacements playerResponse.adSlots playerResponse.playerAds'] });
  fetchPayload = {
    playabilityStatus: { status: 'OK' },
    playerAds: [{ playerLegacyDesktopWatchAdsRenderer: { showCompanion: true, showInstream: true } }],
    adPlacements: [{ foo: 1 }],
    videoDetails: { title: 'real video' },
  };
  const playerAdsResp = await sandbox.fetch('https://www.youtube.com/youtubei/v1/player');
  const playerAdsObj = await playerAdsResp.json();
  check('json_prune_fetch: playerAds pruned from live /player fetch response',
    playerAdsObj.playerAds === undefined, JSON.stringify(playerAdsObj));
  check('json_prune_fetch: adPlacements also pruned', playerAdsObj.adPlacements === undefined);
  check('json_prune_fetch: unrelated fields kept', playerAdsObj.videoDetails.title === 'real video');

  // -- content-length must track the PRUNED body, not the original — a page
  // comparing headers.get('content-length') against what it actually reads
  // is a free, high-confidence tamper signal otherwise. Fresh payload object
  // (objectPruneFn mutates in place — reusing the earlier test's fetchPayload
  // would already be pruned from that prior call, making before/after equal). --
  fetchPayload = {
    playerAds: [{ playerLegacyDesktopWatchAdsRenderer: { showCompanion: true } }],
    adPlacements: [{ foo: 1 }],
    videoDetails: { title: 'real video' },
  };
  const unprunedText = JSON.stringify(fetchPayload);
  fetchResponseHeaders = new FakeHeaders({ 'content-length': String(new Blob([unprunedText]).size) });
  const prunedFetchResp = await sandbox.fetch('https://www.youtube.com/youtubei/v1/player');
  const prunedObj = await prunedFetchResp.json();
  const declaredLen = Number(prunedFetchResp.headers.get('content-length'));
  const actualLen = new Blob([JSON.stringify(prunedObj)]).size;
  check('json_prune_fetch: content-length header shrinks to match the pruned body',
    declaredLen === actualLen && declaredLen < new Blob([unprunedText]).size,
    `declared=${declaredLen} actual=${actualLen} original=${new Blob([unprunedText]).size}`);
  // Response NOT touched (no prune paths match) must NOT gain a content-length
  // header it never had — adding one that wasn't there is its own tell.
  fetchResponseHeaders = new FakeHeaders();
  fetchPayload = { videoDetails: { title: 'clean, no ad fields' } };
  const cleanFetchResp = await sandbox.fetch('https://www.youtube.com/youtubei/v1/player');
  await cleanFetchResp.json();
  check('json_prune_fetch: content-length NOT added when the original response never had one',
    !cleanFetchResp.headers.has('content-length'), String(cleanFetchResp.headers.get('content-length')));

  // -- trusted_replace_fetch_response: a FULLY SEPARATE proxy layer from
  // json_prune_fetch above (_installFetchReplaceProxy, not
  // _installFetchResponseProxy) — the content-length/type/url/ok/redirected
  // fix had to be ported there independently, same leak, different code path. --
  sendRules({ trusted_replace_fetch_response: ['foo, ADXreplacementlonger'] });
  fetchPayload = { marker: 'foo', title: 'clean' };
  const replaceUnpruned = JSON.stringify(fetchPayload);
  fetchResponseHeaders = new FakeHeaders({ 'content-length': String(new Blob([replaceUnpruned]).size) });
  const replaceResp = await sandbox.fetch('https://www.youtube.com/youtubei/v1/player');
  const replaceText = await replaceResp.text();
  check('trusted_replace_fetch_response: replacement actually applied',
    replaceText.includes('ADXreplacementlonger') && !replaceText.includes('"foo"'), replaceText);
  const replaceDeclaredLen = Number(replaceResp.headers.get('content-length'));
  check('trusted_replace_fetch_response: content-length grows to match the (longer) replaced body',
    replaceDeclaredLen === new Blob([replaceText]).size && replaceDeclaredLen > new Blob([replaceUnpruned]).size,
    `declared=${replaceDeclaredLen} actual=${new Blob([replaceText]).size} original=${new Blob([replaceUnpruned]).size}`);

  fetchResponseHeaders = new FakeHeaders();
  fetchPayload = { marker: 'foo', title: 'no header case' };
  const replaceNoHdrResp = await sandbox.fetch('https://www.youtube.com/youtubei/v1/player');
  await replaceNoHdrResp.text();
  check('trusted_replace_fetch_response: content-length NOT added when the original response never had one',
    !replaceNoHdrResp.headers.has('content-length'), String(replaceNoHdrResp.headers.get('content-length')));

  // -- json_prune_fetch: sendSsdaiMissingAdBreakReasons (found via live
  // YouTube testing at body.playerConfig.daiConfig.sendSsdaiMissingAdBreakReasons
  // on /player). Not ad content itself — an SSAI telemetry flag that tells
  // the player to report back to Google when an expected ad break didn't
  // fill, i.e. a "did the user block this ad?" signal. Pruned on an opt-in
  // trial basis alongside the real ad-payload fields above. --
  sendRules({ json_prune_fetch: ['playerAds playerConfig.daiConfig.sendSsdaiMissingAdBreakReasons'] });
  fetchPayload = {
    playerAds: [{ foo: 1 }],
    playerConfig: { daiConfig: { sendSsdaiMissingAdBreakReasons: true }, otherConfig: { keep: 1 } },
    videoDetails: { title: 'real video' },
  };
  const ssdaiResp = await sandbox.fetch('https://www.youtube.com/youtubei/v1/player');
  const ssdaiObj = await ssdaiResp.json();
  check('json_prune_fetch: sendSsdaiMissingAdBreakReasons pruned',
    ssdaiObj.playerConfig.daiConfig.sendSsdaiMissingAdBreakReasons === undefined, JSON.stringify(ssdaiObj));
  check('json_prune_fetch: sibling playerConfig fields kept',
    ssdaiObj.playerConfig.otherConfig.keep === 1);

  // -- json_prune_fetch: adsEngagementPanelContentRenderer must be pruned
  // from the LIVE /get_watch fetch response (found via live YouTube testing:
  // get_watch returns an ARRAY of RPC results — [0] holds playerResponse,
  // [1] holds watchNextResponse — and the "Sponsored" tab lives inside one
  // of watchNextResponse.engagementPanels[N].engagementPanelSectionListRenderer.content,
  // at an unpredictable array index, hence the "[]" wildcard on both arrays). --
  sendRules({ json_prune_fetch: ['[].watchNextResponse.engagementPanels.[].engagementPanelSectionListRenderer.content.adsEngagementPanelContentRenderer'] });
  fetchPayload = [
    { playerResponse: { videoDetails: { title: 'real video' } } },
    { watchNextResponse: { engagementPanels: [
        { engagementPanelSectionListRenderer: { content: { structuredDescriptionContentRenderer: { foo: 1 } } } },
        { engagementPanelSectionListRenderer: { content: { adsEngagementPanelContentRenderer: { hack: 1 } } } },
      ] } },
  ];
  const getWatchResp = await sandbox.fetch('https://www.youtube.com/youtubei/v1/get_watch');
  const getWatchObj = await getWatchResp.json();
  check('json_prune_fetch: adsEngagementPanelContentRenderer pruned from get_watch engagement panel',
    getWatchObj[1].watchNextResponse.engagementPanels[1].engagementPanelSectionListRenderer.content.adsEngagementPanelContentRenderer === undefined,
    JSON.stringify(getWatchObj));
  check('json_prune_fetch: sibling engagement panel content kept',
    getWatchObj[1].watchNextResponse.engagementPanels[0].engagementPanelSectionListRenderer.content.structuredDescriptionContentRenderer.foo === 1);

  // -- json_prune_fetch: adsControlFlowOpportunityReceivedCommand must be pruned
  // from /get_watch (found via live YouTube ad-signal logging: newer ad-slot
  // delivery arrives via watchNextResponse.onResponseReceivedEndpoints[N],
  // not the engagementPanels path above — same "[]" double-wildcard shape). --
  sendRules({ json_prune_fetch: ['[].watchNextResponse.onResponseReceivedEndpoints.[].adsControlFlowOpportunityReceivedCommand'] });
  fetchPayload = [
    { playerResponse: { videoDetails: { title: 'real video' } } },
    { watchNextResponse: { onResponseReceivedEndpoints: [
        { appendContinuationItemsAction: { keep: 1 } },
        { adsControlFlowOpportunityReceivedCommand: { adSlotAndLayoutMetadata: [{ hack: 1 }] } },
      ] } },
  ];
  const getWatchResp2 = await sandbox.fetch('https://www.youtube.com/youtubei/v1/get_watch');
  const getWatchObj2 = await getWatchResp2.json();
  check('json_prune_fetch: adsControlFlowOpportunityReceivedCommand pruned from get_watch response endpoints',
    getWatchObj2[1].watchNextResponse.onResponseReceivedEndpoints[1].adsControlFlowOpportunityReceivedCommand === undefined,
    JSON.stringify(getWatchObj2));
  check('json_prune_fetch: sibling onResponseReceivedEndpoints entry kept',
    getWatchObj2[1].watchNextResponse.onResponseReceivedEndpoints[0].appendContinuationItemsAction.keep === 1);

  // -- json_prune_fetch: same adsControlFlowOpportunityReceivedCommand key also
  // leaks from /youtubei/v1/browse (home/related-feed pagination) — different
  // shape from get_watch: body.onResponseReceivedActions[N], no watchNextResponse
  // wrapper and no array-wrapped body (found via live logging). --
  sendRules({ json_prune_fetch: ['onResponseReceivedActions.[].adsControlFlowOpportunityReceivedCommand'] });
  fetchPayload = { onResponseReceivedActions: [
    { appendContinuationItemsAction: { keep: 1 } },
    { adsControlFlowOpportunityReceivedCommand: { adSlotAndLayoutMetadata: [{ hack: 1 }] } },
  ] };
  const browseResp = await sandbox.fetch('https://www.youtube.com/youtubei/v1/browse');
  const browseObj = await browseResp.json();
  check('json_prune_fetch: adsControlFlowOpportunityReceivedCommand pruned from browse response actions',
    browseObj.onResponseReceivedActions[1].adsControlFlowOpportunityReceivedCommand === undefined,
    JSON.stringify(browseObj));
  check('json_prune_fetch: sibling onResponseReceivedActions entry kept',
    browseObj.onResponseReceivedActions[0].appendContinuationItemsAction.keep === 1);

  // -- trusted_edit_request (delete) + trusted_edit_response (assign, TRUSTED-only) --
  // JSONPath assign/delete only operates on paths that already exist in the
  // object (it walks/selects, it doesn't fabricate new keys) — so the
  // response fixtures below pre-declare the field the rule assigns into.
  sendRules({ trusted_edit_request: ['$.trackingId'], trusted_edit_response: ['$.blocked=true'] });
  const XHR8 = sandbox.XMLHttpRequest;
  const xhrEdit = new XHR8();
  xhrEdit.open('POST', 'https://api.example.com/log');
  xhrEdit._fakeResponse = JSON.stringify({ ok: true, blocked: false });
  xhrEdit.send(JSON.stringify({ trackingId: 'abc123', payload: { x: 1 } }));
  check('trusted_edit_request (XHR): field deleted from sent body',
    JSON.parse(xhrEdit._sentBody).trackingId === undefined, String(xhrEdit._sentBody));
  check('trusted_edit_request (XHR): other fields kept',
    JSON.parse(xhrEdit._sentBody).payload.x === 1, String(xhrEdit._sentBody));
  check('trusted_edit_response (XHR): value assigned into response (TRUSTED allows assign)',
    JSON.parse(xhrEdit.response).blocked === true, String(xhrEdit.response));

  // Same rule pair, via fetch — proves one rule wires into BOTH transports.
  fetchPayload = { ok: true, blocked: false };
  lastFetchArgs = null;
  const editFetchResp = await sandbox.fetch('https://api.example.com/log', {
    method: 'POST', body: JSON.stringify({ trackingId: 'zzz', payload: { y: 2 } }),
  });
  check('trusted_edit_request (fetch): field deleted from body actually sent',
    JSON.parse(lastFetchArgs[1].body).trackingId === undefined, JSON.stringify(lastFetchArgs));
  check('trusted_edit_request (fetch): other fields kept',
    JSON.parse(lastFetchArgs[1].body).payload.y === 2, JSON.stringify(lastFetchArgs));
  const editFetchObj = await editFetchResp.json();
  check('trusted_edit_response (fetch): value assigned into response',
    editFetchObj.blocked === true, JSON.stringify(editFetchObj));

  // Query itself full of commas (assigning a JSON object/array literal),
  // plus an explicit propsToMatch — only _splitLast's LAST comma may split.
  sendRules({ trusted_edit_response: ['$.opts={"a":1,"b":[2,3],"c":true}, url:api.example.com'] });
  fetchPayload = { opts: { a: 0 } };
  const complexResp = await sandbox.fetch('https://api.example.com/complex');
  const complexObj = await complexResp.json();
  check('trusted_edit_response: comma-laden JSONPath value applied intact',
    complexObj.opts && complexObj.opts.a === 1 && JSON.stringify(complexObj.opts.b) === '[2,3]' && complexObj.opts.c === true,
    JSON.stringify(complexObj));

  // Real shape used by the [youtube] granularVariableSpeedConfig rule —
  // descendant filter + merge-assign of a multi-field object.
  sendRules({ trusted_edit_response: ['[?..minimumPlaybackRate==100]..playerConfig.granularVariableSpeedConfig+={"minimumPlaybackRate":25,"maximumPlaybackRate":200}, url:youtubei/v1/player'] });
  fetchPayload = { playerConfig: { granularVariableSpeedConfig: { minimumPlaybackRate: 100 } } };
  const speedResp = await sandbox.fetch('https://www.youtube.com/youtubei/v1/player');
  const speedObj = await speedResp.json();
  check('trusted_edit_response: youtube granularVariableSpeedConfig query applies',
    speedObj.playerConfig?.granularVariableSpeedConfig?.minimumPlaybackRate === 25
      && speedObj.playerConfig?.granularVariableSpeedConfig?.maximumPlaybackRate === 200,
    JSON.stringify(speedObj));

  // -- trusted_replace_script_text: rewrite BEFORE insertion --
  // Bare (non-/regex/) values are treated as literal text and escaped
  // internally by _toRegex — do NOT pre-escape regex metachars here.
  sendRules({ trusted_replace_script_text: ['SCRIPT, evilAdInit(), /* neutralized */'] });
  const scriptNode = new ElementStub();
  scriptNode.nodeType = 1;
  scriptNode.nodeName = 'SCRIPT';
  scriptNode.textContent = 'evilAdInit()';
  const parentEl = new ElementStub();
  parentEl.appendChild(scriptNode);
  check('trusted_replace_script_text: matching script text rewritten before insertion',
    scriptNode.textContent === '/* neutralized */', scriptNode.textContent);

  const otherScript = new ElementStub();
  otherScript.nodeType = 1;
  otherScript.nodeName = 'SCRIPT';
  otherScript.textContent = 'harmlessInit()';
  parentEl.appendChild(otherScript);
  check('trusted_replace_script_text: non-matching script left untouched',
    otherScript.textContent === 'harmlessInit()', otherScript.textContent);

  const divNode = new ElementStub();
  divNode.nodeType = 1;
  divNode.nodeName = 'DIV';
  divNode.textContent = 'evilAdInit()';
  parentEl.appendChild(divNode);
  check('trusted_replace_script_text: non-matching nodeName left untouched',
    divNode.textContent === 'evilAdInit()', divNode.textContent);

  // Replacement itself is arbitrary code full of commas — only the first 2
  // top-level commas (nodeName, pattern) may be split on, or this shreds.
  const complexReplacement = 'const o=["a","b","c"],x={p:1,q:2};fn(1,2,3);';
  sendRules({ trusted_replace_script_text: [`SCRIPT, marker(), ${complexReplacement}`] });
  const complexScript = new ElementStub();
  complexScript.nodeType = 1;
  complexScript.nodeName = 'SCRIPT';
  complexScript.textContent = 'marker()';
  parentEl.appendChild(complexScript);
  check('trusted_replace_script_text: replacement with internal commas stays intact',
    complexScript.textContent === complexReplacement, complexScript.textContent);

  console.log('\n== 9. jspb_response_prune: protobuf/jspb player-response path (never touches fetch/XHR/JSON.parse) ==');
  sendRules({ json_prune_fetch: ['adPlacements adSlots playerAds'], jspb_response_prune: ['1'] });

  // jspbResponseCtor shape: resolve callback receives the already-decoded
  // object directly — matched purely by the callback's OWN function name
  // showing up in its toString() source, ad fields deleted in place.
  function jspbResponseCtor(value) { return value; }
  const jspbResult = await Promise.resolve({
    responseContext: {}, adSlots: [{ ad: 1 }], playerAds: [{ ad: 2 }], videoDetails: { title: 'jspb' },
  }).then(jspbResponseCtor);
  check('jspb_response_prune: adSlots deleted from jspbResponseCtor result',
    jspbResult.adSlots === undefined, JSON.stringify(jspbResult));
  check('jspb_response_prune: playerAds deleted from jspbResponseCtor result',
    jspbResult.playerAds === undefined, JSON.stringify(jspbResult));
  check('jspb_response_prune: non-ad fields kept', jspbResult.videoDetails.title === 'jspb');

  // '.next(' shape: resolve callback receives {value: <JSON text>, done} —
  // the ad fields live inside the JSON TEXT, not the object itself. Matched
  // by a literal ".next(" substring anywhere in the callback's toString()
  // source (a comment here — real callers are TS/Babel __awaiter "fulfilled"
  // steps whose body genuinely calls generator.next(value)).
  function fulfilled(result) {
    // marks this as a generator .next( continuation for the matcher
    return result;
  }
  // "playerResponse" must appear literally in the JSON text — it's the
  // hook's own gate (mirrors the reference's n.value.includes("playerResponse")),
  // separate from the marker match on the callback's source above.
  const nextPayload = JSON.stringify({ playerResponse: {}, adPlacements: [{ ad: 1 }], videoDetails: { title: 'next' } });
  const nextResult = await Promise.resolve({ value: nextPayload, done: false }).then(fulfilled);
  check('jspb_response_prune: adPlacements pruned from .next() value JSON text',
    JSON.parse(nextResult.value).adPlacements === undefined, nextResult.value);
  check('jspb_response_prune: non-ad fields kept in .next() value JSON text',
    JSON.parse(nextResult.value).videoDetails.title === 'next', nextResult.value);

  console.log('\n== 10. ssapUnplayableRetry: self-contained escalation ladder (2026-08-16, clean-room rewrite from a live-verified-working reference — see memory for the A/B test) ==');
  check('document.visibilityState starts at the real (unspoofed) value',
    documentStub.visibilityState === 'hidden', documentStub.visibilityState);

  locationStub._href = 'https://www.youtube.com/watch?v=abc123';
  locationStub.hostname = 'www.youtube.com'; // no site-rules.txt flag anymore — auto-enable is hostname-gated
  const ssapMovieStub = { getPlayerResponse: () => ({ playabilityStatus: { status: 'OK' } }) };
  documentStub.getElementById = (id) => (id === 'movie_player' ? ssapMovieStub : null);

  // Any dispatch on a youtube.com hostname triggers the auto-enable now —
  // no 'adblock_wall_retry' key to send.
  sendRules({});

  function makePlayerBody(videoId) {
    return { videoId, context: { client: { clientName: 'WEB' } }, playbackContext: { contentPlaybackContext: {} } };
  }
  // Request-editing is exercised via TextEncoder.encode — the CONFIRMED
  // real path a youtube.com /player request body takes (live-verified
  // 2026-08-16: the page JSON.stringify()s the body, TextEncoder.encode()s
  // it into a Uint8Array, bakes that into a Request, then calls
  // fetch(request) with no 2nd argument at all).
  function sendPlayerBody(videoId) {
    const bytes = new sandbox.TextEncoder().encode(JSON.stringify(makePlayerBody(videoId)));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  const sent1 = sendPlayerBody('abc123');
  check('ssapUnplayableRetry: fresh video starts at param_first (params=eAFgAQ)',
    sent1.params === 'eAFgAQ', JSON.stringify(sent1));
  check('ssapUnplayableRetry: visibilityState spoofed to "visible" while a spoof is active',
    documentStub.visibilityState === 'visible', documentStub.visibilityState);

  // Feed an "UNPLAYABLE" /player RESPONSE through the (already-hooked)
  // JSON.parse — this is what advances the ladder, independent of any
  // request being sent.
  sandbox.JSON.parse('{"playabilityStatus":{"status":"ERROR","errorScreen":{"playerErrorMessageRenderer":{}}}}');

  const sent2 = sendPlayerBody('abc123');
  check('ssapUnplayableRetry: state advances to param_second after a rejected response',
    sent2.params === '8AUB', JSON.stringify(sent2));

  const sent3 = sendPlayerBody('xyz999');
  check('ssapUnplayableRetry: a different videoId resets the ladder back to param_first',
    sent3.params === 'eAFgAQ', JSON.stringify(sent3));

  // Regression test (2026-08-16): a live report of Shorts autoplaying
  // muted traced to editRequest() having no /shorts/ exclusion — only
  // onPlayerResponseParsed (the response-detection side) had it ported,
  // not the request-editing side all 4 hooks funnel through. The
  // reference implementation excludes shorts/tv/embed at EVERY hook.
  const hrefBefore = locationStub._href;
  locationStub._href = 'https://www.youtube.com/shorts/abc123';
  const sentShorts = sendPlayerBody('abc123');
  check('ssapUnplayableRetry: /shorts/ pages are never touched by request editing',
    sentShorts.params === undefined, JSON.stringify(sentShorts));
  locationStub._href = hrefBefore;

  // NOTE: the DOM-driven retry trigger (onTick/shouldRetry/loadVideoById,
  // matching the reference's MutationObserver + videoId-tracked debounce)
  // isn't covered here — this harness's document.querySelector stub always
  // returns null (see its own comment), so shouldRetry() is always false
  // and onTick() no-ops. The request-editing and response-detection halves
  // above (which is what changed vs. the old userAgent-relay version) are
  // what's under test.

  console.log('\n== 11. trusted_replace_outbound_text: unconditional JSON.stringify substring swap (2026-08-15, ported from Adblock for YouTube) ==');
  sendRules({ trusted_replace_outbound_text: [
    'JSON.stringify, "clientScreen":"WATCH", "clientScreen":"ADUNIT"',
    'JSON.stringify, isWebNativeShareAvailable":true}}, isWebNativeShareAvailable":true},"clientScreen":"ADUNIT"}',
  ] });
  check('trusted_replace_outbound_text: existing clientScreen:WATCH swapped to ADUNIT',
    sandbox.JSON.stringify({ clientScreen: 'WATCH', other: 1 }) === '{"clientScreen":"ADUNIT","other":1}',
    sandbox.JSON.stringify({ clientScreen: 'WATCH', other: 1 }));
  // Pattern needs 2 consecutive closing braces (nested object) — matches
  // the real request shape (isWebNativeShareAvailable sits inside "client",
  // itself inside the request root), not a flat one.
  check('trusted_replace_outbound_text: fallback anchor inserts clientScreen when absent',
    sandbox.JSON.stringify({ client: { isWebNativeShareAvailable: true } }) === '{"client":{"isWebNativeShareAvailable":true},"clientScreen":"ADUNIT"}',
    sandbox.JSON.stringify({ client: { isWebNativeShareAvailable: true } }));
  check('trusted_replace_outbound_text: unrelated JSON.stringify output left untouched',
    sandbox.JSON.stringify({ unrelated: 'value' }) === '{"unrelated":"value"}',
    sandbox.JSON.stringify({ unrelated: 'value' }));

  console.log('\n== 12. prevent_settimeout: pattern + delay-range matching (2026-08-15, ported from Adblock for YouTube) ==');
  sendRules({ prevent_settimeout: ['(),a,b), 5000'] });
  // Third combination (matching delay, non-matching pattern) is skipped —
  // it would need a real 5000ms wait to observe the callback firing; the
  // block condition is a plain `&&` of the two independently-tested halves
  // below, so this permutation isn't at real risk of a distinct bug.
  let ranMatching = false, ranNonMatchingDelay = false;
  sandbox.setTimeout(function matched() { /* (),a,b) */ ranMatching = true; }, 5000);
  sandbox.setTimeout(function () { /* (),a,b) */ ranNonMatchingDelay = true; }, 10);
  await new Promise(r => setTimeout(r, 50));
  check('prevent_settimeout: pattern+delay both matching is blocked', ranMatching === false);
  check('prevent_settimeout: matching pattern but non-matching delay still runs', ranNonMatchingDelay === true);

  console.log('\n== 13. trusted_prune_inbound_object / trusted_suppress_native_method / m3u_prune / prevent_element_src_loading (2026-08-16, ported from ABY/AdGuard Scriptlets, clean-room) ==');

  // 13a. trusted_prune_inbound_object — object is pruned BEFORE reaching
  // the target function, in place, so the function still sees its own
  // (now-pruned) argument.
  sendRules({ trusted_prune_inbound_object: ['reportPayload, adPlacements adSlots'] });
  const prunedInbound = sandbox.reportPayload({ adPlacements: [1], adSlots: [2], videoDetails: { title: 't' } });
  check('trusted_prune_inbound_object: ad fields stripped before the call',
    !prunedInbound.adPlacements && !prunedInbound.adSlots, JSON.stringify(prunedInbound));
  check('trusted_prune_inbound_object: non-ad fields kept', prunedInbound.videoDetails.title === 't');
  const cleanInbound = sandbox.reportPayload({ videoDetails: { title: 'clean' } });
  check('trusted_prune_inbound_object: object with nothing to prune passed through unchanged',
    cleanInbound.videoDetails.title === 'clean');

  // 13b. trusted_suppress_native_method — positional-arg signature match,
  // 'noop' behavior (silently swallow, don't reach the real implementation).
  sendRules({ trusted_suppress_native_method: ['navigator.sendBeacon, 0:/ad_break/, noop'] });
  sendBeaconCalls.length = 0;
  sandbox.navigator.sendBeacon('https://example.com/ad_break?x=1', '');
  check('trusted_suppress_native_method: matching call suppressed (never reaches real impl)',
    sendBeaconCalls.length === 0, JSON.stringify(sendBeaconCalls));
  sandbox.navigator.sendBeacon('https://example.com/telemetry', '');
  check('trusted_suppress_native_method: non-matching call passes through',
    sendBeaconCalls.length === 1 && sendBeaconCalls[0][0] === 'https://example.com/telemetry',
    JSON.stringify(sendBeaconCalls));

  // 13c. m3u_prune — drops a matching #EXTINF+URI ad-segment pair from an
  // HLS playlist, leaves everything else (including non-matching segments)
  // untouched, and never touches a response that isn't actually a playlist.
  sendRules({ m3u_prune: ['ADMARKER'] });
  const m3uBefore = ['#EXTM3U', '#EXTINF:6,', 'seg1.ts', '#EXTINF:6,ADMARKER', 'adseg.ts', '#EXTINF:6,', 'seg2.ts'].join('\n');
  const m3uExpected = ['#EXTM3U', '#EXTINF:6,', 'seg1.ts', '#EXTINF:6,', 'seg2.ts'].join('\n');
  fetchPayload = m3uBefore;
  const m3uResp = await sandbox.fetch('https://x.example.com/live.m3u8');
  const m3uAfter = await m3uResp.text();
  check('m3u_prune: ad EXTINF+URI pair dropped, real segments kept', m3uAfter === m3uExpected, m3uAfter);

  fetchPayload = 'not a playlist but mentions ADMARKER anyway';
  const nonM3uResp = await sandbox.fetch('https://x.example.com/live.m3u8');
  const nonM3uAfter = await nonM3uResp.text();
  check('m3u_prune: non-#EXTM3U response left untouched (guard against false-positive URL matches)',
    nonM3uAfter === fetchPayload, nonM3uAfter);

  // 13d. prevent_element_src_loading — setAttribute interception path: a
  // matching src is swapped for the inert same-type mock; a non-matching
  // src passes through unchanged.
  sendRules({ prevent_element_src_loading: ['img, doubleclick.net'] });
  const adImg = new HTMLImageElementStub();
  adImg.setAttribute('src', 'https://doubleclick.net/ad.gif');
  check('prevent_element_src_loading: matching src swapped for inert mock',
    typeof adImg._attrs.src === 'string' && adImg._attrs.src.startsWith('data:image/gif'),
    adImg._attrs.src);
  const realImg = new HTMLImageElementStub();
  realImg.setAttribute('src', 'https://example.com/real.png');
  check('prevent_element_src_loading: non-matching src passed through unchanged',
    realImg._attrs.src === 'https://example.com/real.png', realImg._attrs.src);

  console.log('\n== 14. json_prune: optional stackNeedle scoping (2026-08-16, matches uBO real json-prune.js 3rd arg) ==');
  // Two rules pruning DIFFERENT fields, each gated to a call stack that
  // does/doesn't match a function name present in the test's own call
  // stack at the point JSON.parse() runs below.
  sendRules({ json_prune: [
    'adPlacements, , /callFromMatchingFn/',
    'adSlots, , /callFromNoSuchFn/',
  ] });
  function callFromMatchingFn() {
    return sandbox.JSON.parse(JSON.stringify({ adPlacements: [1], adSlots: [2], keep: 'yes' }));
  }
  const stackPruned = callFromMatchingFn();
  check('json_prune: stackNeedle matching the real call stack still prunes',
    stackPruned.adPlacements === undefined, JSON.stringify(stackPruned));
  check('json_prune: stackNeedle NOT matching the call stack leaves that field alone',
    Array.isArray(stackPruned.adSlots) && stackPruned.adSlots.length === 1, JSON.stringify(stackPruned));
  check('json_prune: unrelated field kept regardless', stackPruned.keep === 'yes');

  console.log('\n== 15. trusted_edit_request: TextEncoder.encode / Request-constructor edit path (2026-08-16, live-verified interception blind spot) ==');
  // Live capture via Claude-in-Chrome on a real youtube.com watch page proved
  // youtubei/v1/player requests never carry a string init.body at all: the
  // page runs the JSON string through TextEncoder.encode() into a Uint8Array,
  // bakes THAT into `new Request(url, {body: uint8Array})`, then calls
  // fetch(thatRequest) with no 2nd argument — so the existing fetch/XHR
  // init.body-string edit path never sees it, no matter how correct the
  // JSONPath rule is. This section proves the new TextEncoder/Request hooks
  // actually intercept and edit that exact shape.
  sendRules({ trusted_edit_request: ['$.trackingId, url:youtubei/v1/player'] });
  const playerBodyObj = {
    trackingId: 'abc123',
    context: { client: {} },
    playbackContext: { contentPlaybackContext: {} }, // sniff marker: "contentPlaybackContext"
  };
  const playerBodyStr = JSON.stringify(playerBodyObj);

  // 15a. TextEncoder.encode — the ACTUAL path YouTube uses.
  const encodedBytes = new sandbox.TextEncoder().encode(playerBodyStr);
  const decodedAfter = new TextDecoder().decode(encodedBytes);
  const editedObj = JSON.parse(decodedAfter);
  check('TextEncoder.encode: content-sniffed /player body gets the JSONPath edit applied',
    editedObj.trackingId === undefined, decodedAfter);
  check('TextEncoder.encode: other fields kept', editedObj.context && typeof editedObj.context === 'object');

  // 15b. A string NOT matching the content-sniff markers must pass through
  // completely untouched — this hook has no URL to scope by, only content.
  const unrelatedStr = JSON.stringify({ trackingId: 'shouldSurvive', somethingElse: 1 });
  const unrelatedBytes = new sandbox.TextEncoder().encode(unrelatedStr);
  check('TextEncoder.encode: string without sniff markers left untouched',
    new TextDecoder().decode(unrelatedBytes) === unrelatedStr);

  // 15c. Request constructor — the redundant 2nd interception point, for
  // whichever code path bakes a Uint8Array body in directly (matches the
  // ACTUAL live-captured shape: youtube.com's own code does exactly this
  // with the TextEncoder.encode() output).
  const reqBodyBytes = new TextEncoder().encode(playerBodyStr);
  const req = new sandbox.Request('https://www.youtube.com/youtubei/v1/player', { body: reqBodyBytes });
  const reqBodyAfter = JSON.parse(new TextDecoder().decode(req.body));
  check('Request constructor: sniffed Uint8Array body gets the JSONPath edit applied',
    reqBodyAfter.trackingId === undefined, new TextDecoder().decode(req.body));
  check('Request constructor: other fields kept', reqBodyAfter.context && typeof reqBodyAfter.context === 'object');

  const unrelatedReqBytes = new TextEncoder().encode(unrelatedStr);
  const unrelatedReq = new sandbox.Request('https://www.youtube.com/youtubei/v1/player', { body: unrelatedReqBytes });
  check('Request constructor: body without sniff markers left untouched',
    new TextDecoder().decode(unrelatedReq.body) === unrelatedStr);

  console.log('\n== 16. "Scan page globals" picker — MAIN-world scan/apply bridge (2026-08-18) ==');
  sendRules({}); // ensure _scriptletsEnabled = true regardless of section 14's _dis__ dispatch above

  // ── _EVT_APPLYREQ: ad-hoc block/edit/delete, same functions the persisted
  // set_constant/abort_on_property_read rule-application path already uses —
  // no new scriptlet logic, just a direct single-chain call. ──────────────
  function applyAdHoc(chain, action, value) {
    sandbox.dispatchEvent(new CustomEventStub(`__${TEST_TOKEN}_applyreq__`, {
      detail: JSON.stringify({ chain, action, value }),
    }));
  }

  sandbox.qkv1AdHocBlock = 'original';
  applyAdHoc('qkv1AdHocBlock', 'block');
  let blockThrew = false;
  try { void sandbox.qkv1AdHocBlock; } catch (e) { blockThrew = true; }
  check('block: reading the chain now throws (abortOnPropertyRead applied directly, no rule dispatch)', blockThrew);

  applyAdHoc('qkv1AdHocEdit', 'edit', '42');
  check('edit: chain locked to the parsed literal value (setConstant applied directly)', sandbox.qkv1AdHocEdit === 42, String(sandbox.qkv1AdHocEdit));

  sandbox.qkv1AdHocDelete = 'x';
  applyAdHoc('qkv1AdHocDelete', 'delete');
  check('delete: chain reads back as undefined (setConstant chain undefined, delete is a redundant no-op once locked)', sandbox.qkv1AdHocDelete === undefined, String(sandbox.qkv1AdHocDelete));

  // ── _EVT_SCANREQ / _EVT_SCANRES: the scan itself. ──────────────────────
  function runScan() {
    let captured = null;
    const handler = (ev) => { captured = JSON.parse(ev.detail); };
    sandbox.addEventListener(`__${TEST_TOKEN}_scanres__`, handler);
    sandbox.dispatchEvent(new CustomEventStub(`__${TEST_TOKEN}_scanreq__`, { detail: 'test-request-1' }));
    return captured;
  }

  sandbox.qkv1ScanFn = function probeFn(a, b) { return a + b; };
  sandbox.qkv1ScanObj = { a: 1, b: 2 };
  sandbox.qkv1ScanArr = [1, 2, 3];
  sandbox.qkv1ScanNum = 123;
  sandbox.qkv1ScanStr = 'hello';
  let getterInvoked = false;
  Object.defineProperty(sandbox, 'qkv1ScanAccessor', {
    get() { getterInvoked = true; return 'leaked-if-invoked'; },
    configurable: true, enumerable: true,
  });
  Object.defineProperty(sandbox, 'qkv1ScanPoison', {
    value: { toJSON() { throw new Error('boom — poisoned toJSON'); } },
    configurable: true, enumerable: true,
  });

  const scanResult = runScan();
  check('scan responds with the matching requestId', scanResult && scanResult.requestId === 'test-request-1', JSON.stringify(scanResult && scanResult.requestId));
  const byName = {};
  (scanResult && scanResult.results || []).forEach(e => { byName[e.name] = e; });

  check('scan finds the probe function, typed correctly', byName.qkv1ScanFn && byName.qkv1ScanFn.type === 'function', JSON.stringify(byName.qkv1ScanFn));
  check('function preview is a source-text snippet, not "[object Function]" or similar', byName.qkv1ScanFn && byName.qkv1ScanFn.preview.indexOf('probeFn') !== -1, JSON.stringify(byName.qkv1ScanFn));
  check('scan finds the probe object, typed correctly', byName.qkv1ScanObj && byName.qkv1ScanObj.type === 'object', JSON.stringify(byName.qkv1ScanObj));
  check('object preview includes a key count', byName.qkv1ScanObj && byName.qkv1ScanObj.preview.indexOf('2 keys') !== -1, JSON.stringify(byName.qkv1ScanObj));
  check('scan finds the probe array, typed as array (not object)', byName.qkv1ScanArr && byName.qkv1ScanArr.type === 'array', JSON.stringify(byName.qkv1ScanArr));
  check('scan finds the probe number, typed correctly', byName.qkv1ScanNum && byName.qkv1ScanNum.type === 'number' && byName.qkv1ScanNum.preview === '123', JSON.stringify(byName.qkv1ScanNum));
  check('scan finds the probe string, typed correctly', byName.qkv1ScanStr && byName.qkv1ScanStr.type === 'string', JSON.stringify(byName.qkv1ScanStr));

  check('accessor property reported as type "accessor"', byName.qkv1ScanAccessor && byName.qkv1ScanAccessor.type === 'accessor', JSON.stringify(byName.qkv1ScanAccessor));
  check('accessor getter is NEVER invoked during a scan (passive introspection only)', getterInvoked === false);

  check('a property whose JSON.stringify throws does not crash the whole scan — still reported', !!byName.qkv1ScanPoison, JSON.stringify(byName.qkv1ScanPoison));
  check('poisoned property falls back to a safe placeholder preview instead of propagating the throw', byName.qkv1ScanPoison && byName.qkv1ScanPoison.preview === '[object]', JSON.stringify(byName.qkv1ScanPoison));
  check('scan continues past the poisoned property to still find later probes', !!byName.qkv1ScanStr);

  console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
