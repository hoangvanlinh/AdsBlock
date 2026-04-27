// content/anti-detect.js — Ad Network Anti-Detection (MAIN world)
// Injected by content.js into the page's MAIN world at document_start.
// Techniques applied:
//  1.  XHR fake             — synthetic 200 OK, no real TCP connection
//  2.  fetch() fake         — Promise.resolve(200 OK)
//  3.  sendBeacon fake      — returns true without sending
//  4.  Image pixel fake     — suppress tracking pixel requests
//  5.  window.open fake     — block ad popup windows
//  6.  getComputedStyle     — return visible styles for bait ad elements
//  7.  getBoundingClientRect— return 1×1 for hidden bait elements
//  8.  Performance timing   — filter ad-network resource entries
//  9.  PerformanceObserver  — wrap callback to remove ad entries
// 10.  Error capture        — intercept onerror on blocked ad scripts/imgs
// 11.  Global stubs         — populate SDK globals so checks don't fail
// 12.  MutationObserver     — patch bait elements inserted after load
(function () {
  'use strict';

  // Guard — run only once per MAIN world context
  var _G = Symbol.for('_adblock_antidetect');
  if (window[_G]) return;
  window[_G] = true;

  // ── Ad network host regex ────────────────────────────────────────
  // Static fallback — active immediately before site-rules.txt loads.
  // Covers all hosts in rule/site-rules.txt [global] ad_script_hosts +
  // extra sub-domain aliases used by the same networks.
  var _AD_RE = /doubleclick\.net|googlesyndication\.com|googleadservices\.com|adnxs\.com|outbrain\.com|taboola\.com|amazon-adsystem\.com|media\.net|criteo\.com|advertising\.com|pubmatic\.com|openx\.net|rubiconproject\.com|xandr\.com|adsrvr\.org|smartadserver\.com|adform\.net|sharethrough\.com|mgid\.com|teads\.tv|improvedigital\.com|smartclip\.net|snigel\.com|seedtag\.com|casalemedia\.com|sovrn\.com|33across\.com|undertone\.com|yieldmo\.com|admicro\.vn|adx\.admicro\.vn|vccorp\.vn|adplay\.vn|adtima\.vn|mfast\.vn|adskeeper\.com|skimlinks\.com|viglink\.com|admitad\.com|impact\.com|partnerize\.com|awin1\.com|shareasale\.com|tradedoubler\.com|pagead2\.googlesyndication\.com|tpc\.googlesyndication\.com|securepubads\.g\.doubleclick\.net|adservice\.google\.com/;

  // ── Dynamic host list from site-rules.txt ───────────────────────
  // content.js (isolated world) dispatches __adblock_ad_hosts__ with
  // ad_script_hosts + ad_network_patterns merged from site-rules.txt.
  // We rebuild _AD_RE from that list so adding a host to the rules file
  // automatically updates anti-detect behaviour — no code change needed.
  document.addEventListener('__adblock_ad_hosts__', function (ev) {
    var hosts = ev.detail;
    if (!Array.isArray(hosts) || !hosts.length) return;
    try {
      var parts = hosts.map(function (h) {
        // Escape regex special chars, then replace escaped \. with \. (already fine)
        return h.trim().replace(/[+?^${}()|[\]\\]/g, '\\$&').replace(/\./g, '\\.');
      });
      _AD_RE = new RegExp(parts.join('|'));
    } catch (e) { /* keep existing _AD_RE on parse error */ }
  });

  // ── Bait class/id names used by ad-block detectors ──────────────
  // FuckAdBlock, BlockAdBlock, AdBlocker Ultimate detector, etc. all
  // create probe <div> elements with these names to test if they're hidden.
  var _BAIT_RE = /\b(ad[s]?[-_]?(banner|slot|unit|container|wrapper|block|frame|box|leaderboard|rectangle|sidebar|popup|overlay|interstitial|bait|check)|adsbygoogle|adsbox|adsense|dfp|gpt[-_]?ad|doubleclick[-_]?ad|taboola[-_]?widget|outbrain[-_]?widget|sponsored[-_]?ad|promoted[-_]?(content|link))\b/i;

  function _isAdUrl(v) { return _AD_RE.test(typeof v === 'string' ? v : String(v || '')); }
  function _isBaitEl(el) {
    if (!el || !el.className && !el.id) return false;
    try {
      var cls = (typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '');
      return _BAIT_RE.test(cls);
    } catch (e) { return false; }
  }

  // ── 1. XHR fake ──────────────────────────────────────────────────
  var _xO = XMLHttpRequest.prototype.open;
  var _xS = XMLHttpRequest.prototype.send;
  var _fakeXhr = new WeakSet();
  XMLHttpRequest.prototype.open = function (method, url) {
    if (_isAdUrl(url)) { _fakeXhr.add(this); return; }
    return _xO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (_fakeXhr.has(this)) {
      var xhr = this;
      setTimeout(function () {
        try {
          Object.defineProperty(xhr, 'readyState',   { value: 4,    configurable: true });
          Object.defineProperty(xhr, 'status',       { value: 200,  configurable: true });
          Object.defineProperty(xhr, 'statusText',   { value: 'OK', configurable: true });
          Object.defineProperty(xhr, 'responseText', { value: '',   configurable: true });
          Object.defineProperty(xhr, 'response',     { value: '',   configurable: true });
          Object.defineProperty(xhr, 'responseURL',  { value: '',   configurable: true });
          xhr.dispatchEvent(new ProgressEvent('readystatechange'));
          xhr.dispatchEvent(new ProgressEvent('load'));
          xhr.dispatchEvent(new ProgressEvent('loadend'));
        } catch (e) {}
      }, 0);
      return;
    }
    return _xS.apply(this, arguments);
  };

  // ── 2. fetch() fake ──────────────────────────────────────────────
  var _oFetch = window.fetch;
  window.fetch = function (input, init) {
    var u = (input instanceof Request) ? input.url : String(input || '');
    if (_isAdUrl(u)) {
      return Promise.resolve(new Response('', {
        status: 200, statusText: 'OK',
        headers: { 'Content-Type': 'text/plain' }
      }));
    }
    return _oFetch.apply(this, arguments);
  };

  // ── 3. sendBeacon fake ───────────────────────────────────────────
  var _oBeacon = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = function (url) {
    if (_isAdUrl(url)) return true;
    return _oBeacon.apply(navigator, arguments);
  };

  // ── 4. Image pixel tracking fake ────────────────────────────────
  // Ad SDKs fire impression/conversion pixels via new Image().src = url.
  try {
    var _iDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src') ||
                 Object.getOwnPropertyDescriptor(Element.prototype, 'src');
    if (_iDesc && _iDesc.set) {
      var _iSet = _iDesc.set;
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        get: _iDesc.get,
        set: function (val) {
          if (_isAdUrl(val)) {
            var img = this;
            setTimeout(function () { try { img.dispatchEvent(new Event('load')); } catch (e) {} }, 0);
            return;
          }
          return _iSet.call(this, val);
        },
        configurable: true
      });
    }
  } catch (e) {}

  // ── 5. window.open fake ──────────────────────────────────────────
  var _oOpen = window.open;
  window.open = function (url) {
    if (url && _isAdUrl(url)) return null;
    return _oOpen.apply(this, arguments);
  };

  // ── 6. getComputedStyle spoof ────────────────────────────────────
  // Detectors inject a probe element (class="adsbox", "ads-banner", etc.)
  // and call getComputedStyle() to check if display is "none".
  // Return visible styles for those bait elements via Proxy.
  try {
    var _oGCS = window.getComputedStyle;
    window.getComputedStyle = function (el, pseudo) {
      var style = _oGCS.call(window, el, pseudo);
      if (!_isBaitEl(el)) return style;
      return new Proxy(style, {
        get: function (target, prop) {
          if (prop === 'display')    return 'block';
          if (prop === 'visibility') return 'visible';
          if (prop === 'opacity')    return '1';
          if (prop === 'height' || prop === 'width') return '1px';
          if (prop === 'getPropertyValue') {
            return function (name) {
              if (name === 'display')    return 'block';
              if (name === 'visibility') return 'visible';
              if (name === 'opacity')    return '1';
              return target.getPropertyValue(name);
            };
          }
          var v = target[prop];
          return typeof v === 'function' ? v.bind(target) : v;
        }
      });
    };
  } catch (e) {}

  // ── 7. getBoundingClientRect spoof ──────────────────────────────
  // Hidden bait elements return 0×0. Detectors check width/height === 0.
  try {
    var _oGBCR = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      var r = _oGBCR.call(this);
      if (r.width === 0 && r.height === 0 && _isBaitEl(this)) {
        return DOMRect.fromRect({ x: r.x, y: r.y, width: 1, height: 1 });
      }
      return r;
    };
  } catch (e) {}

  // ── 8. Performance resource timing filter ────────────────────────
  // Detectors enumerate resource entries looking for ad-network URLs
  // that have transferSize=0 (blocked) or are entirely absent.
  try {
    var _oGET = performance.getEntriesByType.bind(performance);
    performance.getEntriesByType = function (type) {
      var entries = _oGET(type);
      if (type !== 'resource') return entries;
      return entries.filter(function (e) { return !_isAdUrl(e.name); });
    };
    var _oGEN = performance.getEntriesByName.bind(performance);
    performance.getEntriesByName = function (name, type) {
      if (_isAdUrl(name)) return [];
      return _oGEN(name, type);
    };
    var _oGE = performance.getEntries.bind(performance);
    performance.getEntries = function () {
      return _oGE().filter(function (e) { return !_isAdUrl(e.name || ''); });
    };
  } catch (e) {}

  // ── 9. PerformanceObserver filter ────────────────────────────────
  // Wrap the callback so ad-network resource entries never reach the page.
  try {
    var _OrigPO = window.PerformanceObserver;
    function _PO(cb) {
      return new _OrigPO(function (list, obs) {
        var wrap = {
          getEntries: function () {
            return list.getEntries().filter(function (e) { return !_isAdUrl(e.name || ''); });
          },
          getEntriesByType: function (t) {
            return list.getEntriesByType(t).filter(function (e) { return !_isAdUrl(e.name || ''); });
          },
          getEntriesByName: function (n) {
            return _isAdUrl(n) ? [] : list.getEntriesByName(n);
          }
        };
        cb(wrap, obs);
      });
    }
    _PO.prototype = _OrigPO.prototype;
    _PO.supportedEntryTypes = _OrigPO.supportedEntryTypes;
    window.PerformanceObserver = _PO;
  } catch (e) {}

  // ── 10. Error capture — blocked ad scripts/images ───────────────
  // When DNR blocks a <script src="ad-cdn.com/..."> the browser fires
  // 'error' on it. Ad detectors (FuckAdBlock et al.) listen for this.
  // We intercept in capture phase (before page handlers) and fire 'load'
  // instead, making the SDK think its resource loaded successfully.
  window.addEventListener('error', function (ev) {
    var t = ev.target;
    if (!t || t === window) return;
    var src = t.src || t.getAttribute && t.getAttribute('src') || '';
    if (!_isAdUrl(src)) return;
    ev.stopImmediatePropagation();
    ev.preventDefault();
    if (t.tagName === 'SCRIPT') {
      setTimeout(function () { try { t.dispatchEvent(new Event('load')); } catch (ex) {} }, 0);
    }
  }, true /* capture */);

  // ── 11. Global stubs ─────────────────────────────────────────────
  // Ad SDKs check their own globals exist before declaring "we loaded fine".
  // Provide minimal stubs so those checks don't throw or fall into
  // "blocked" code paths.
  var _stub = Object.freeze({
    push: function () { return 0; },
    cmd: [], queue: [],
    display: function () {},
    enableServices: function () {},
    pubads: function () { return { enableSingleRequest: function () {}, collapseEmptyDivs: function () {}, disableInitialLoad: function () {} }; },
    defineSlot: function () { return { addService: function () { return this; }, setTargeting: function () { return this; } }; },
    destroySlots: function () {}
  });
  function _defStub(name) {
    try {
      if (window[name]) return;
      Object.defineProperty(window, name, {
        get: function () { return _stub; },
        set: function () {},
        configurable: true, enumerable: true
      });
    } catch (e) {}
  }
  _defStub('googletag');   // Google Publisher Tag
  _defStub('adsbygoogle'); // AdSense push queue
  _defStub('_taboola');    // Taboola
  _defStub('_obq');        // Outbrain queue
  _defStub('apntag');      // Xandr/AppNexus
  _defStub('pbjs');        // Prebid.js header bidder
  _defStub('_gaq');        // Google Analytics (legacy UA)
  _defStub('ga');          // Google Analytics
  _defStub('fbq');         // Meta/Facebook Pixel
  _defStub('ttq');         // TikTok Pixel
  _defStub('twq');         // Twitter/X Pixel
  _defStub('snaptr');      // Snapchat Pixel
  _defStub('pintrk');      // Pinterest Tag
  _defStub('_pxam');       // DoubleVerify
  try {
    if (!window.OBR) {
      Object.defineProperty(window, 'OBR', {
        get: function () { return { extern: { callWidget: function () {}, load: function () {} } }; },
        set: function () {},
        configurable: true
      });
    }
  } catch (e) {}

  // ── 12. MutationObserver — bait element dimension reset ──────────
  // Some detectors add bait elements, wait a frame, then read dimensions.
  // Ensure bait elements always report non-zero offsetHeight/Width.
  var _oBOH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  var _oBOW = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  if (_oBOH && _oBOH.get && _oBOW && _oBOW.get) {
    var _gOH = _oBOH.get;
    var _gOW = _oBOW.get;
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      get: function () {
        var v = _gOH.call(this);
        return (v === 0 && _isBaitEl(this)) ? 1 : v;
      },
      configurable: true
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      get: function () {
        var v = _gOW.call(this);
        return (v === 0 && _isBaitEl(this)) ? 1 : v;
      },
      configurable: true
    });
  }

}());
