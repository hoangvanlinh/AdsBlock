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
class HTMLElementStub extends ElementStub {}
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
// adblock_wall_retry spoof-to-'visible' test has something to prove.
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
  WeakMap, WeakSet, Proxy, Reflect, Symbol, Error, TypeError, Date, parseFloat, parseInt,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  CustomEvent: CustomEventStub,
  Window: class Window {},
  Document: DocumentClass,
  XMLHttpRequest: FakeXHR,
  Location: LocationStub,
  URL,
  Request: class Request { clone() { return this; } },
  document: documentStub,
  location: locationStub,
  navigator: { userAgent: 'test' },
  open: () => ({ close() {}, closed: false }), // window.open
};
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

  console.log('\n== 10. adblock_wall_retry: visibilityState spoofed while a retry token is active, restored once real ==');
  check('document.visibilityState starts at the real (unspoofed) value',
    documentStub.visibilityState === 'hidden', documentStub.visibilityState);

  sandbox.ytcfg = { data_: { INNERTUBE_CONTEXT: { client: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } } } };
  locationStub._href = 'https://www.youtube.com/watch?v=abc123';
  const movieState = { hasWall: true, status: 'ERROR', duration: 100, loaded: 0, current: 0 };
  const movieStub = {
    getPlayerResponse: () => ({
      videoDetails: { videoId: 'abc123' },
      playabilityStatus: {
        status: movieState.status,
        errorScreen: movieState.hasWall ? { openAdAllowlistInstructionCommand: {} } : undefined,
      },
      playerConfig: { playbackStartConfig: { startSeconds: 0 } },
    }),
    getProgressState: () => ({ duration: movieState.duration, loaded: movieState.loaded, current: movieState.current }),
    getStatsForNerds: () => ({}),
    getPlayerStateObject: () => ({ isBuffering: false }),
    loadVideoById: () => {},
  };
  documentStub.getElementById = (id) => (id === 'movie_player' ? movieStub : null);

  sendRules({ adblock_wall_retry: ['tokenA'] });
  check('adblock_wall_retry: visibilityState spoofed to "visible" once the wall triggers a retry token',
    documentStub.visibilityState === 'visible', documentStub.visibilityState);

  // Wall clears and the (single-token) retry pool is exhausted — the next
  // check() pass, driven by the MutationObserver ssapUnplayableRetry
  // installed on itself, must fall through to setToken('') and restore.
  const wallRetryObserver = MutationObserverStub.instances[MutationObserverStub.instances.length - 1];
  movieState.hasWall = false;
  movieState.status = 'OK';
  movieState.loaded = 100; movieState.current = 50; // duration(100) - current(50) > 1 → stillPlaying
  wallRetryObserver.cb();
  check('adblock_wall_retry: visibilityState restored to real once retry tokens are exhausted and playback is healthy',
    documentStub.visibilityState === 'hidden', documentStub.visibilityState);

  console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
