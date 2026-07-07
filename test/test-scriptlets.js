// Smoke test: load the real content/scriptlets.js in a vm sandbox and verify
// __adblock_blocked__ dispatch behavior for window.open blocking and
// json_prune_xhr (only real prunes count).
'use strict';
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(require('path').join(__dirname, '..', 'content/scriptlets.js'), 'utf8');

// ── minimal window/DOM stubs ──────────────────────────────────────
const listeners = {};
let blockedEvents = [];

class CustomEventStub {
  constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; }
}

const documentStub = {
  readyState: 'loading',
  addEventListener() {},
  createElement(tag) {
    return { tagName: tag.toUpperCase(), style: { cssText: '' }, remove() {}, contentWindow: { closed: false } };
  },
  body: { appendChild() {} },
  documentElement: {},
};

class FakeXHR {
  open(method, url) { this._url = url; }
  send() {}
  get response() { return this._fakeResponse; }
  get responseText() { return typeof this._fakeResponse === 'string' ? this._fakeResponse : ''; }
}

class NodeStub {}
Object.defineProperty(NodeStub.prototype, 'textContent', {
  get() { return this._text || ''; }, set(v) { this._text = v; }, configurable: true,
});
class ElementStub extends NodeStub {}
class HTMLElementStub extends ElementStub {}
class EventTargetStub {}
class MutationObserverStub { observe() {} disconnect() {} }
class HistoryStub { pushState() {} replaceState() {} }

const sandbox = {
  Node: NodeStub, Element: ElementStub, HTMLElement: HTMLElementStub,
  EventTarget: EventTargetStub, MutationObserver: MutationObserverStub,
  History: HistoryStub, history: new HistoryStub(),
  console, JSON, Math, Object, Array, String, Number, RegExp, Promise, Set, Map,
  WeakMap, WeakSet, Proxy, Reflect, Symbol, Error, TypeError, Date, parseFloat, parseInt,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  CustomEvent: CustomEventStub,
  XMLHttpRequest: FakeXHR,
  Location: class Location {},
  Request: class Request { clone() { return this; } },
  document: documentStub,
  location: { href: 'https://test.example.com/', hostname: 'test.example.com' },
  navigator: { userAgent: 'test' },
  open: () => ({ close() {}, closed: false }), // window.open
};
// Fake fetch/Response pair — enough surface for jsonPruneFetchResponse
// (clone / json / Response.json static / status metadata).
class FakeResponse {
  constructor(obj) {
    this._obj = obj;
    this.status = 200; this.statusText = 'OK'; this.headers = {};
    this.ok = true; this.redirected = false; this.type = 'basic'; this.url = '';
  }
  clone() { return new FakeResponse(this._obj); }
  async json() { return this._obj; }
  static json(obj) { return new FakeResponse(obj); }
}
let fetchPayload = {};
sandbox.Response = FakeResponse;
sandbox.fetch = async () => new FakeResponse(fetchPayload);

sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.addEventListener = (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); };
sandbox.removeEventListener = () => {};
sandbox.dispatchEvent = (ev) => {
  if (ev.type === '__adblock_blocked__') blockedEvents.push(ev.detail);
  (listeners[ev.type] || []).forEach(fn => fn(ev));
  return true;
};

vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'scriptlets.js' });

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

function sendRules(rules) {
  sandbox.dispatchEvent(new CustomEventStub('__adblock_scriptlet_rules__', { detail: rules }));
}

(async () => {
  console.log('== 1. window.open blocking dispatches on ALL block paths ==');
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

  console.log('\n== 2. json_prune_xhr counts ONLY real prunes ==');
  sendRules({ json_prune_xhr: ['adPlacements adSlots'] });
  const XHR = sandbox.XMLHttpRequest;
  check('XMLHttpRequest was wrapped by scriptlet', XHR !== FakeXHR);

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

  // Clean response → nothing pruned → 0 events (the bug this fix addresses)
  blockedEvents = [];
  const xhrClean = new XHR();
  xhrClean.open('GET', 'https://www.youtube.com/youtubei/v1/browse');
  xhrClean._fakeResponse = JSON.stringify({ videoDetails: { title: 'clean' } });
  const cleanResp = xhrClean.response;
  check('clean response passes through unchanged', cleanResp === xhrClean._fakeResponse);
  check('clean response NOT counted (was +1 before fix)', blockedEvents.length === 0,
    String(blockedEvents.length));

  console.log('\n== 3. disable event stops blocking & counting ==');
  sandbox.dispatchEvent(new CustomEventStub('__adblock_scriptlet_disable__', {}));
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

  console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
