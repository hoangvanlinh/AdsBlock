// content/scriptlets.js — Core ad-blocking scriptlets (MAIN world)
// Functions: setConstant, abortCurrentScript, abortOnPropertyRead,
//            abortOnStackTrace, preventFetch, preventXhr,
//            jsonPruneFetchResponse, jsonPruneXhrResponse,
//            noWindowOpenIf, preventAddEventListener, disableNewtabLinks,
//            stripDynamicTargets, rateLimitHistory, blockAdNavigations

// Static document_start/MAIN-world injection (manifest.json) — needed for
// the document_start timing guarantee (prerendering frames block
// chrome.scripting.executeScript outright; declarative content_scripts
// don't have that restriction). '__QKV1_BUILD_TOKEN__' below is substituted
// with a random string at build time (_build-lib.sh) — checked-in source
// only ever has the placeholder, not the value any shipped build uses.
(function () {
  'use strict';

  var _qkv1Token = '__QKV1_BUILD_TOKEN__';
  var _G = Symbol.for(_qkv1Token);
  if (window[_G]) return;
  window[_G] = 1;
  var _EVT_RULES = '__' + _qkv1Token + '_rules__';
  var _EVT_BLK   = '__' + _qkv1Token + '_blk__';
  var _EVT_DIS   = '__' + _qkv1Token + '_dis__';
  var _EVT_CLR   = '__' + _qkv1Token + '_clr__';

  // ── Helpers ──────────────────────────────────────────────────────
  var _strSplit = String.prototype.split;
  var _textGet  = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent').get;

  function _toRegex(p) {
    if (!p) return /^/;
    if (p.charAt(0) === '/' && p.length > 1) {
      var last = p.lastIndexOf('/');
      if (last > 0) {
        try { return new RegExp(p.slice(1, last), p.slice(last + 1)); } catch (e) {}
      }
    }
    return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }

  function _mkToken() {
    var t = String.fromCharCode(Date.now() % 26 + 97) +
      Math.floor(Math.random() * 982451653 + 982451653).toString(36);
    var oe = self.onerror;
    self.onerror = function (m) {
      if (typeof m === 'string' && m.includes(t)) return true;
      return oe instanceof Function ? oe.apply(this, arguments) : false;
    };
    return t;
  }

  function _onHtmlEl(fn) {
    if (document.documentElement) { fn(); return; }
    var o = new MutationObserver(function () { o.disconnect(); fn(); });
    o.observe(document, { childList: true });
  }

  // ── setConstant ──────────────────────────────────────────────────
  // Locks a property chain to a fixed value; silently ignores writes.
  var _noop   = function () {};
  var _trueF  = function () { return true; };
  var _falseF = function () { return false; };

  function _parseVal(raw) {
    switch (raw) {
      case 'undefined':  return undefined;
      case 'false':      return false;
      case 'true':       return true;
      case 'null':       return null;
      case '0':          return 0;
      case '1':          return 1;
      case '""': case "'": return '';
      case '[]':         return [];
      case '{}':         return {};
      case 'noopFunc':   return _noop;
      case 'trueFunc':   return _trueF;
      case 'falseFunc':  return _falseF;
    }
    var n = +raw;
    return isNaN(n) ? raw : n;
  }

  // Two or more set_constant rules sharing a parent chain segment (e.g.
  // "ytInitialPlayerResponse.playerAds" and "ytInitialPlayerResponse.adSlots")
  // each used to call walk() on the SAME not-yet-existing parent key, and
  // each call's Object.defineProperty(obj, k, ...) fully REPLACED the
  // previous call's pending trap — only the last-registered rule ever
  // actually locked its leaf when the real assignment landed. This registry
  // lets a later walk() on an already-pending key ATTACH to the existing
  // trap instead of clobbering it, so every rule sharing a prefix fires.
  var _constantPending = new WeakMap(); // obj -> Map<key, Array<(assignedVal) => void>>

  function setConstant(chain, raw) {
    if (!chain || !_scriptletsEnabled) return;
    var value = _parseVal(raw);
    var parts = _strSplit.call(chain, '.');
    var leaf  = parts.pop();

    // Matches uBlock Origin's real set-constant.js trapProp (verified
    // against gorhill/uBlock master, 2026-08-10): a permanent,
    // configurable:false get/set accessor on the leaf — NOT the
    // downgrade-to-plain-after-set variant this used to have. That variant
    // was added on a theory that the accessor itself was a YouTube-wall
    // tampering fingerprint; disproved same-day (uBO ships the exact
    // pattern below and isn't detected — see
    // youtube-adblock-wall-defineproperty-detection memory). Two
    // uBO-derived robustness touches kept: chain to any pre-existing
    // getter/setter instead of clobbering it, and a type-mismatch escape
    // hatch (mustAbort) — if the page ever assigns a value of a
    // fundamentally different type than what we're locking to, that's a
    // sign our assumption about this field was wrong, so stop overriding
    // rather than risk breaking the page.
    var aborted = false;
    function mustAbort(v) {
      if (aborted) return true;
      aborted = (v !== undefined && v !== null) &&
        (value !== undefined && value !== null) &&
        (typeof v !== typeof value);
      return aborted;
    }

    function lock(obj, key) {
      var current = value;
      var odesc, prevGetter, prevSetter, origVal;
      try { odesc = Object.getOwnPropertyDescriptor(obj, key); } catch (e) {}
      if (odesc) {
        if (typeof odesc.get === 'function') prevGetter = odesc.get;
        if (typeof odesc.set === 'function') prevSetter = odesc.set;
        // Capture the real value BEFORE priming/redefining below — reading
        // obj[key] from inside the getter we're about to install would
        // just call that same getter again (infinite recursion, actually
        // hit live: "Maximum call stack size exceeded"). origVal is a
        // plain snapshot var instead, never re-reads the property itself.
        try { origVal = obj[key]; } catch (e) {}
        try { obj[key] = current; } catch (e) {}
      }
      try {
        Object.defineProperty(obj, key, {
          get: function () {
            if (prevGetter) { try { prevGetter(); } catch (e) {} }
            return _scriptletsEnabled ? current : origVal;
          },
          set: function (v) {
            if (prevSetter) { try { prevSetter(v); } catch (e) {} }
            if (!_scriptletsEnabled) { origVal = v; return; }
            if (mustAbort(v)) current = v;
          },
          configurable: false, enumerable: true
        });
      } catch (e) { try { obj[key] = value; } catch (ee) {} }
    }

    function walk(obj, keys) {
      if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return;
      if (!keys.length) { lock(obj, leaf); return; }
      var k = keys[0], rest = keys.slice(1), v = obj[k];
      if (v != null) { walk(v, rest); return; }
      var objPending = _constantPending.get(obj);
      var continuation = function (a) { walk(a, rest); };
      if (objPending && objPending.has(k)) { objPending.get(k).push(continuation); return; }
      if (!objPending) { objPending = new Map(); _constantPending.set(obj, objPending); }
      var pending = [continuation];
      objPending.set(k, pending);
      var held;
      try {
        Object.defineProperty(obj, k, {
          get: function () { return held; },
          set: function (a) {
            held = a;
            if (a instanceof Object) { for (var i = 0; i < pending.length; i++) pending[i](a); }
          },
          configurable: true
        });
      } catch (e) {}
    }

    walk(window, parts);
  }

  // ── jsonPruneOnSet ───────────────────────────────────────────────
  // Same defineProperty-walk trick as setConstant, but for globals a page
  // ASSIGNS directly (var x = {...}) rather than obtaining via JSON.parse —
  // json_prune/json_edit only see JSON.parse traffic, so a page building the
  // object itself in JS needs this instead. The leaf setter prunes the
  // incoming value with objectPruneFn before storing it.
  function jsonPruneOnSet(chain, prunePaths, needlePaths) {
    if (!chain || typeof prunePaths !== 'string' || !prunePaths) return;
    var parts = chain.split('.');
    var leaf  = parts.pop();

    // Permanent configurable:false accessor, same as setConstant's lock()
    // — see that function's comment for why (matches uBlock Origin's own
    // set-constant.js; an earlier "downgrade to plain after first set"
    // variant here was dropped since it only pruned the FIRST assignment,
    // and the accessor-as-fingerprint theory it was defending against
    // didn't hold up anyway.
    function lock(obj, key) {
      var held = obj[key];
      Object.defineProperty(obj, key, {
        get: function () { return held; },
        set: function (v) {
          if (!_scriptletsEnabled) { held = v; return; }
          var r = objectPruneFn(v, prunePaths, needlePaths || '');
          held = (typeof r === 'object' && r !== null) ? r : v;
        },
        configurable: false, enumerable: true
      });
    }

    function walk(obj, keys) {
      if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return;
      if (!keys.length) { lock(obj, leaf); return; }
      var k = keys[0], rest = keys.slice(1), v = obj[k];
      if (v != null) { walk(v, rest); return; }
      var held;
      try {
        Object.defineProperty(obj, k, {
          get: function () { return held; },
          set: function (a) { held = a; if (a instanceof Object) walk(a, rest.slice()); },
          configurable: true
        });
      } catch (e) {}
    }

    try { walk(window, parts); } catch (e) { /* already defined — skip */ }
  }

  // ── abortCurrentScript ───────────────────────────────────────────
  // Throws ReferenceError when an inline/external script whose content
  // matches `needle` reads `target` property — kills detection scripts
  // before they can run their ad-blocker checks.
  function abortCurrentScript(target, needle, ctx) {
    _onHtmlEl(function () { _acsImpl(target, needle, ctx); });
  }

  function _acsImpl(target, needle, ctx) {
    if (typeof target !== 'string' || !target) return;
    var reN = _toRegex(needle || '');
    var reC = _toRegex(ctx    || '');
    var tok = _mkToken();
    var chain = _strSplit.call(target, '.');
    var owner = window, prop;
    for (;;) {
      prop = chain.shift();
      if (!chain.length) break;
      if (!(prop in owner)) break;
      owner = owner[prop];
      if (typeof owner !== 'object' && typeof owner !== 'function') return;
    }
    var d  = Object.getOwnPropertyDescriptor(owner, prop);
    var v  = (d && d.get) ? undefined : owner[prop];
    var me = document.currentScript;

    function chk() {
      if (!_scriptletsEnabled) return;
      var e = document.currentScript;
      if (!(e instanceof HTMLScriptElement) || e === me) return;
      if (ctx && !reC.test(e.src)) return;
      var text = _textGet.call(e).trim();
      if (!reN.test(text) && !reN.test(e.src || '')) return;
      throw new ReferenceError(tok);
    }

    try {
      Object.defineProperty(owner, prop, {
        get: function () { chk(); return d && d.get ? d.get.call(owner) : v; },
        set: function (a) { chk(); if (d && d.set) d.set.call(owner, a); else v = a; }
      });
    } catch (e) {}
  }

  // ── abortOnPropertyRead ──────────────────────────────────────────
  // Throws when any script reads target property chain — catches
  // ad-detection libraries that probe for their own globals.
  function abortOnPropertyRead(chain) {
    if (typeof chain !== 'string' || !chain) return;
    var tok = _mkToken();
    function abort() { if (_scriptletsEnabled) throw new ReferenceError(tok); }
    function proxy(obj, ch) {
      var dot = ch.indexOf('.');
      if (dot === -1) {
        var v = obj[ch];
        try {
          Object.defineProperty(obj, ch, {
            get: function () { abort(); return v; },
            set: function (a) { v = a; }
          });
        } catch (e) {}
        return;
      }
      var k = ch.slice(0, dot), rest = ch.slice(dot + 1), v = obj[k];
      if (v) { proxy(v, rest); return; }
      try {
        Object.defineProperty(obj, k, {
          get: function () { return v; },
          set: function (a) { v = a; if (a instanceof Object) proxy(a, rest); }
        });
      } catch (e) {}
    }
    proxy(window, chain);
  }

  // ── abortOnStackTrace ────────────────────────────────────────────
  // Throws when any script matching `needle` in the call stack reads
  // `chain` property — targets ad-recovery scripts by stack pattern.
  function abortOnStackTrace(chain, needle) {
    if (typeof chain !== 'string') return;
    var tok = _mkToken();
    function abort() { if (_scriptletsEnabled) throw new ReferenceError(tok); }
    function matchesStack(n) {
      if (!n) return true;
      var re = _toRegex(n);
      try {
        var err = new Error(tok);
        var stack = err.stack || '';
        return re.test(stack);
      } catch (e) { return false; }
    }
    function mkProxy(obj, ch) {
      var dot = ch.indexOf('.');
      if (dot === -1) {
        var v = obj[ch];
        try {
          Object.defineProperty(obj, ch, {
            get: function () { if (matchesStack(needle)) abort(); return v; },
            set: function (a) { if (matchesStack(needle)) abort(); v = a; }
          });
        } catch (e) {}
        return;
      }
      var k = ch.slice(0, dot), rest = ch.slice(dot + 1), val = obj[k];
      if (val) { mkProxy(val, rest); return; }
      var desc = Object.getOwnPropertyDescriptor(obj, k);
      if (desc && desc.set !== undefined) return;
      try {
        Object.defineProperty(obj, k, {
          get: function () { return val; },
          set: function (a) {
            val = a;
            if (a instanceof Object) mkProxy(a, rest);
          }
        });
      } catch (e) {}
    }
    mkProxy(window, chain);
  }

  // ── Full fetch/XHR prevention

  var scriptletGlobals = {};

  function safeSelf() {
    if (scriptletGlobals.safeSelf) return scriptletGlobals.safeSelf;
    var safe = {
      'Error': self.Error,
      'Math_floor': Math.floor,
      'Math_max': Math.max,
      'Math_min': Math.min,
      'Math_random': Math.random,
      'Object': Object,
      'Object_defineProperty': Object.defineProperty.bind(Object),
      'Object_defineProperties': Object.defineProperties.bind(Object),
      'Object_fromEntries': Object.fromEntries.bind(Object),
      'Object_getOwnPropertyDescriptor': Object.getOwnPropertyDescriptor.bind(Object),
      'Object_toString': Object.prototype.toString,
      'Object_hasOwn': Function.prototype.call.bind(Object.prototype.hasOwnProperty),
      'RegExp': self.RegExp,
      'RegExp_test': self.RegExp.prototype.test,
      'RegExp_exec': self.RegExp.prototype.exec,
      'Request_clone': self.Request.prototype.clone,
      'String_fromCharCode': String.fromCharCode,
      'String_split': String.prototype.split,
      'XMLHttpRequest': self.XMLHttpRequest,
      'fetch': self.fetch,
      'JSON': self.JSON,
      'JSON_parseFn': self.JSON.parse,
      'JSON_stringifyFn': self.JSON.stringify,
      'JSON_parse': function () { return safe.JSON_parseFn.apply(safe.JSON, arguments); },
      'JSON_stringify': function () { return safe.JSON_stringifyFn.apply(safe.JSON, arguments); },
      logLevel: 0,
      makeLogPrefix: function () { return ''; },
      aboLog: function () {},
      aboErr: function () {},
      escapeRegexChars: function (s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      },
      initPattern: function (pattern, options) {
        options = options || {};
        if (pattern === '') return { matchAll: true, expect: true };
        var expect = (options.canNegate !== true || pattern.charAt(0) !== '!');
        if (!expect) pattern = pattern.slice(1);
        var m = /^\/(.+)\/([gimsu]*)$/.exec(pattern);
        if (m !== null) return { re: new safe.RegExp(m[1], m[2] || options.flags), expect: expect };
        if (options.flags !== undefined) return { re: new safe.RegExp(safe.escapeRegexChars(pattern), options.flags), expect: expect };
        return { pattern: pattern, expect: expect };
      },
      testPattern: function (details, haystack) {
        if (details.matchAll) return true;
        if (details.re) return safe.RegExp_test.call(details.re, haystack) === details.expect;
        return haystack.includes(details.pattern) === details.expect;
      },
      getExtraArgs: function (args, offset) {
        offset = offset || 0;
        var entries = args.slice(offset).reduce(function (out, v, i, a) {
          if ((i & 1) === 0) {
            var rawValue = a[i + 1];
            var value = /^\d+$/.test(rawValue) ? parseInt(rawValue, 10) : rawValue;
            out.push([a[i], value]);
          }
          return out;
        }, []);
        return safe.Object_fromEntries(entries);
      }
    };
    scriptletGlobals.safeSelf = safe;
    return safe;
  }

  // Lazily builds the shared toString-spoofing WeakMap so ANY proxy
  // registered in proxyApplyFn.proxies — not just ones installed through
  // proxyApplyFn itself — reports the wrapped native's real toString output.
  // Must be idempotent and callable before proxyApplyFn ever runs, since
  // fetch proxies can install earlier (document_start) than the first
  // XHR-based proxyApplyFn call.
  function _ensureProxyApplyFnState() {
    if (proxyApplyFn.CtorContext !== undefined) return;
    proxyApplyFn.ctorContexts = [];
    proxyApplyFn.CtorContext = class {
      constructor(...args) { this.init(...args); }
      init(callFn, callArgs) { this.callFn = callFn; this.callArgs = callArgs; return this; }
      reflect() {
        const r = Reflect.construct(this.callFn, this.callArgs);
        this.callFn = this.callArgs = this.private = undefined;
        proxyApplyFn.ctorContexts.push(this);
        return r;
      }
      static factory(...args) {
        return proxyApplyFn.ctorContexts.length !== 0
          ? proxyApplyFn.ctorContexts.pop().init(...args)
          : new proxyApplyFn.CtorContext(...args);
      }
    };
    proxyApplyFn.applyContexts = [];
    proxyApplyFn.ApplyContext = class {
      constructor(...args) { this.init(...args); }
      init(callFn, thisArg, callArgs) { this.callFn = callFn; this.thisArg = thisArg; this.callArgs = callArgs; return this; }
      reflect() {
        const r = Reflect.apply(this.callFn, this.thisArg, this.callArgs);
        this.callFn = this.thisArg = this.callArgs = this.private = undefined;
        proxyApplyFn.applyContexts.push(this);
        return r;
      }
      static factory(...args) {
        return proxyApplyFn.applyContexts.length !== 0
          ? proxyApplyFn.applyContexts.pop().init(...args)
          : new proxyApplyFn.ApplyContext(...args);
      }
    };
    proxyApplyFn.isCtor = new Map();
    proxyApplyFn.proxies = new WeakMap();
    proxyApplyFn.nativeToString = Function.prototype.toString;
    const proxiedToString = new Proxy(Function.prototype.toString, {
      apply(target, thisArg) {
        let proxied = thisArg;
        for (;;) {
          const f = proxyApplyFn.proxies.get(proxied);
          if (f === undefined) break;
          proxied = f;
        }
        return proxyApplyFn.nativeToString.call(proxied);
      }
    });
    proxyApplyFn.proxies.set(proxiedToString, proxyApplyFn.nativeToString);
    Function.prototype.toString = proxiedToString;
  }

  // Registers `wrapperFn` in the same toString-spoofing map proxyApplyFn
  // uses, so Function.prototype.toString.call(wrapperFn) reports realFn's
  // true native source — for call sites that can't go through proxyApplyFn's
  // path-based Proxy install (e.g. replacing an accessor's setter function,
  // where `context[prop] = proxiedTarget` would invoke the setter instead
  // of replacing it).
  function _spoofToString(realFn, wrapperFn) {
    _ensureProxyApplyFnState();
    proxyApplyFn.proxies.set(wrapperFn, realFn);
    return wrapperFn;
  }

  function proxyApplyFn(target, handler) {
    var context = globalThis;
    var prop = target;
    for (;;) {
      var pos = prop.indexOf('.');
      if (pos === -1) break;
      context = context[prop.slice(0, pos)];
      if (context instanceof Object === false) return;
      prop = prop.slice(pos + 1);
    }
    var fn = context[prop];
    if (typeof fn !== 'function') return;
    _ensureProxyApplyFnState();
    if (proxyApplyFn.isCtor.has(target) === false) {
      proxyApplyFn.isCtor.set(target, fn.prototype?.constructor === fn);
    }
    const proxyDetails = {
      apply(target, thisArg, args) {
        return handler(proxyApplyFn.ApplyContext.factory(target, thisArg, args));
      }
    };
    if (proxyApplyFn.isCtor.get(target)) {
      proxyDetails.construct = function (target, args) {
        return handler(proxyApplyFn.CtorContext.factory(target, args));
      };
    }
    const proxiedTarget = new Proxy(fn, proxyDetails);
    proxyApplyFn.proxies.set(proxiedTarget, fn);
    context[prop] = proxiedTarget;
  }

  function collateFetchArgumentsFn(resource, options) {
    const safe = safeSelf();
    const props = [
      'body', 'cache', 'credentials', 'duplex', 'headers',
      'integrity', 'keepalive', 'method', 'mode', 'priority',
      'redirect', 'referrer', 'referrerPolicy', 'url'
    ];
    const out = {};
    if (collateFetchArgumentsFn.collateKnownProps === undefined) {
      collateFetchArgumentsFn.collateKnownProps = (src, out) => {
        for (const prop of props) {
          if (src[prop] === undefined) continue;
          out[prop] = src[prop];
        }
      };
    }
    if (typeof resource !== 'object' || safe.Object_toString.call(resource) !== '[object Request]') {
      out.url = `${resource}`;
    } else {
      let clone;
      try { clone = safe.Request_clone.call(resource); } catch(e) {}
      collateFetchArgumentsFn.collateKnownProps(clone || resource, out);
    }
    if (typeof options === 'object' && options !== null) {
      collateFetchArgumentsFn.collateKnownProps(options, out);
    }
    return out;
  }

  function generateContentFn(trusted, directive) {
    const safe = safeSelf();
    const randomize = len => {
      const chunks = [];
      let textSize = 0;
      do {
        const s = safe.Math_random().toString(36).slice(2);
        chunks.push(s);
        textSize += s.length;
      } while (textSize < len);
      return chunks.join(' ').slice(0, len);
    };
    if (directive === 'true') return randomize(10);
    if (directive === 'emptyObj') return '{}';
    if (directive === 'emptyArr') return '[]';
    if (directive === 'emptyStr') return '';
    if (directive.startsWith('length:')) {
      const match = /^length:(\d+)(?:-(\d+))?$/.exec(directive);
      if (match === null) return '';
      const min = parseInt(match[1], 10);
      const extent = safe.Math_max(parseInt(match[2], 10) || 0, min) - min;
      const len = safe.Math_min(min + extent * safe.Math_random(), 500000);
      return randomize(len | 0);
    }
    if (directive.startsWith('war:')) {
      if (scriptletGlobals.warOrigin === undefined) return '';
      return new Promise(resolve => {
        const warOrigin = scriptletGlobals.warOrigin;
        const warName = directive.slice(4);
        const fullpath = [warOrigin, '/', warName];
        const warSecret = scriptletGlobals.warSecret;
        if (warSecret !== undefined) fullpath.push('?secret=', warSecret);
        const warXHR = new safe.XMLHttpRequest();
        warXHR.responseType = 'text';
        warXHR.onloadend = ev => { resolve(ev.target.responseText || ''); };
        warXHR.open('GET', fullpath.join(''));
        warXHR.send();
      }).catch(() => '');
    }
    if (directive.startsWith('join:')) {
      const parts = directive.slice(7)
        .split(directive.slice(5, 7))
        .map(a => generateContentFn(trusted, a));
      return parts.some(a => a instanceof Promise)
        ? Promise.all(parts).then(parts => parts.join(''))
        : parts.join('');
    }
    if (trusted) return directive;
    return '';
  }

  function matchObjectPropertiesFn(propNeedles, ...objs) {
    const safe = safeSelf();
    const matched = [];
    for (const obj of objs) {
      if (obj instanceof Object === false) continue;
      for (const [prop, details] of propNeedles) {
        let value = obj[prop];
        if (value === undefined) continue;
        if (typeof value !== 'string') {
          try { value = safe.JSON_stringify(value); } catch(e) {}
          if (typeof value !== 'string') continue;
        }
        if (safe.testPattern(details, value) === false) return;
        matched.push(`${prop}: ${value}`);
      }
    }
    return matched;
  }

  function parsePropertiesToMatchFn(propsToMatch, implicit = '') {
    const safe = safeSelf();
    const needles = new Map();
    if (propsToMatch === undefined || propsToMatch === '') return needles;
    const options = { canNegate: true };
    for (const needle of safe.String_split.call(propsToMatch, /\s+/)) {
      let [prop, pattern] = safe.String_split.call(needle, ':');
      if (prop === '') continue;
      if (pattern !== undefined && /[^$\w -]/.test(prop)) {
        prop = `${prop}:${pattern}`;
        pattern = undefined;
      }
      if (pattern !== undefined) {
        needles.set(prop, safe.initPattern(pattern, options));
      } else if (implicit !== '') {
        needles.set(implicit, safe.initPattern(prop, options));
      }
    }
    return needles;
  }

  function preventFetch(...args) {
    preventFetchFn(false, ...args);
  }

  function preventFetchFn(
    trusted = false,
    propsToMatch = '',
    responseBody = '',
    responseType = ''
  ) {
    const safe = safeSelf();
    const setTimeout = self.setTimeout;
    const extraArgs = safe.getExtraArgs(Array.from(arguments), 4);
    const propNeedles = parsePropertiesToMatchFn(propsToMatch, 'url');
    const validResponseProps = {
      ok: [false, true],
      status: [403],
      statusText: ['', 'Not Found'],
      type: ['basic', 'cors', 'default', 'error', 'opaque'],
    };
    const responseProps = { statusText: { value: 'OK' } };
    const responseHeaders = {};
    if (/^\{.*\}$/.test(responseType)) {
      try {
        Object.entries(JSON.parse(responseType)).forEach(([p, v]) => {
          if (p === 'headers' && trusted) { Object.assign(responseHeaders, v); return; }
          if (validResponseProps[p] === undefined) return;
          if (validResponseProps[p].includes(v) === false) return;
          responseProps[p] = { value: v };
        });
      } catch(e) {}
    } else if (responseType !== '') {
      if (validResponseProps.type.includes(responseType)) {
        responseProps.type = { value: responseType };
      }
    }
    proxyApplyFn('fetch', function fetch(context) {
      if (!_scriptletsEnabled) return context.reflect();
      const { callArgs } = context;
      const details = collateFetchArgumentsFn(...callArgs);
      if (propsToMatch === '' && responseBody === '') return context.reflect();
      const matched = matchObjectPropertiesFn(propNeedles, details);
      if (matched === undefined || matched.length === 0) return context.reflect();
      return Promise.resolve(generateContentFn(trusted, responseBody)).then(text => {
        const headers = Object.assign({}, responseHeaders);
        if (headers['content-length'] === undefined) headers['content-length'] = text.length;
        const response = new Response(text, { headers });
        const props = Object.assign({ url: { value: details.url } }, responseProps);
        safe.Object_defineProperties(response, props);
        if (extraArgs.throttle) {
          return new Promise(resolve => { setTimeout(() => { resolve(response); }, extraArgs.throttle); });
        }
        return response;
      });
    });
  }

  function preventXhr(...args) {
    return preventXhrFn(false, ...args);
  }

  function preventXhrFn(
    trusted = false,
    propsToMatch = '',
    directive = ''
  ) {
    if (typeof propsToMatch !== 'string') return;
    const safe = safeSelf();
    const xhrInstances = new WeakMap();
    const propNeedles = parsePropertiesToMatchFn(propsToMatch, 'url');
    const warOrigin = scriptletGlobals.warOrigin;
    const safeDispatchEvent = (xhr, type) => {
      try { xhr.dispatchEvent(new Event(type)); } catch(e) {}
    };
    proxyApplyFn('XMLHttpRequest.prototype.open', function(context) {
      if (!_scriptletsEnabled) return context.reflect();
      const { thisArg, callArgs } = context;
      xhrInstances.delete(thisArg);
      const [method, url, ...args] = callArgs;
      if (warOrigin !== undefined && url.startsWith(warOrigin)) return context.reflect();
      const haystack = { method, url };
      if (propsToMatch === '' && directive === '') return context.reflect();
      if (matchObjectPropertiesFn(propNeedles, haystack)) {
        const xhrDetails = Object.assign(haystack, {
          xhr: thisArg,
          defer: args.length === 0 || !!args[0],
          directive,
          headers: { 'date': '', 'content-type': '', 'content-length': '' },
          url: haystack.url,
          props: {
            response: { value: '' },
            responseText: { value: '' },
            responseXML: { value: null },
          },
        });
        xhrInstances.set(thisArg, xhrDetails);
      }
      return context.reflect();
    });
    proxyApplyFn('XMLHttpRequest.prototype.send', function(context) {
      if (!_scriptletsEnabled) return context.reflect();
      const { thisArg } = context;
      const xhrDetails = xhrInstances.get(thisArg);
      if (xhrDetails === undefined) return context.reflect();
      xhrDetails.headers['date'] = (new Date()).toUTCString();
      let xhrText = '';
      switch (thisArg.responseType) {
        case 'arraybuffer':
          xhrDetails.props.response.value = new ArrayBuffer(0);
          xhrDetails.headers['content-type'] = 'application/octet-stream';
          break;
        case 'blob':
          xhrDetails.props.response.value = new Blob([]);
          xhrDetails.headers['content-type'] = 'application/octet-stream';
          break;
        case 'document': {
          const parser = new DOMParser();
          const doc = parser.parseFromString('', 'text/html');
          xhrDetails.props.response.value = doc;
          xhrDetails.props.responseXML.value = doc;
          xhrDetails.headers['content-type'] = 'text/html';
          break;
        }
        case 'json':
          xhrDetails.props.response.value = {};
          xhrDetails.props.responseText.value = '{}';
          xhrDetails.headers['content-type'] = 'application/json';
          break;
        default: {
          if (directive === '') break;
          xhrText = generateContentFn(trusted, xhrDetails.directive);
          if (xhrText instanceof Promise) {
            xhrText = xhrText.then(text => {
              xhrDetails.props.response.value = text;
              xhrDetails.props.responseText.value = text;
            });
          } else {
            xhrDetails.props.response.value = xhrText;
            xhrDetails.props.responseText.value = xhrText;
          }
          xhrDetails.headers['content-type'] = 'text/plain';
          break;
        }
      }
      if (xhrDetails.defer === false) {
        xhrDetails.headers['content-length'] = `${xhrDetails.props.response.value}`.length;
        Object.defineProperties(xhrDetails.xhr, {
          readyState: { value: 4 },
          responseURL: { value: xhrDetails.url },
          status: { value: 200 },
          statusText: { value: 'OK' },
        });
        Object.defineProperties(xhrDetails.xhr, xhrDetails.props);
        return;
      }
      Promise.resolve(xhrText).then(() => xhrDetails).then(details => {
        Object.defineProperties(details.xhr, {
          readyState: { value: 1, configurable: true },
          responseURL: { value: xhrDetails.url },
        });
        safeDispatchEvent(details.xhr, 'readystatechange');
        return details;
      }).then(details => {
        xhrDetails.headers['content-length'] = `${details.props.response.value}`.length;
        Object.defineProperties(details.xhr, {
          readyState: { value: 2, configurable: true },
          status: { value: 200 },
          statusText: { value: 'OK' },
        });
        safeDispatchEvent(details.xhr, 'readystatechange');
        return details;
      }).then(details => {
        Object.defineProperties(details.xhr, { readyState: { value: 3, configurable: true } });
        Object.defineProperties(details.xhr, details.props);
        safeDispatchEvent(details.xhr, 'readystatechange');
        return details;
      }).then(details => {
        Object.defineProperties(details.xhr, { readyState: { value: 4 } });
        safeDispatchEvent(details.xhr, 'readystatechange');
        safeDispatchEvent(details.xhr, 'load');
        safeDispatchEvent(details.xhr, 'loadend');
      });
    });
    proxyApplyFn('XMLHttpRequest.prototype.getResponseHeader', function(context) {
      if (!_scriptletsEnabled) return context.reflect();
      const { thisArg } = context;
      const xhrDetails = xhrInstances.get(thisArg);
      if (xhrDetails === undefined || thisArg.readyState < thisArg.HEADERS_RECEIVED) return context.reflect();
      const headerName = `${context.callArgs[0]}`;
      const value = xhrDetails.headers[headerName.toLowerCase()];
      if (value !== undefined && value !== '') return value;
      return null;
    });
    proxyApplyFn('XMLHttpRequest.prototype.getAllResponseHeaders', function(context) {
      if (!_scriptletsEnabled) return context.reflect();
      const { thisArg } = context;
      const xhrDetails = xhrInstances.get(thisArg);
      if (xhrDetails === undefined || thisArg.readyState < thisArg.HEADERS_RECEIVED) return context.reflect();
      const out = [];
      for (const [name, value] of Object.entries(xhrDetails.headers)) {
        if (!value) continue;
        out.push(`${name}: ${value}`);
      }
      if (out.length !== 0) out.push('');
      return out.join('\r\n');
    });
  }

  // ── JSON response pruning helpers ────────────────────────────────

  function objectFindOwnerFn(root, path, prune) {
    const safe = safeSelf();
    prune = prune === true;
    let owner = root;
    let chain = path;
    for (;;) {
      if (typeof owner !== 'object' || owner === null) return false;
      const pos = chain.indexOf('.');
      if (pos === -1) {
        if (!prune) return safe.Object_hasOwn(owner, chain);
        let modified = false;
        if (chain === '*') {
          for (const key in owner) {
            if (!safe.Object_hasOwn(owner, key)) continue;
            delete owner[key];
            modified = true;
          }
        } else if (safe.Object_hasOwn(owner, chain)) {
          delete owner[chain];
          modified = true;
        }
        return modified;
      }
      const prop = chain.slice(0, pos);
      const next = chain.slice(pos + 1);
      let found = false;
      if (prop === '[-]' && Array.isArray(owner)) {
        let i = owner.length;
        while (i--) {
          if (!objectFindOwnerFn(owner[i], next)) continue;
          owner.splice(i, 1);
          found = true;
        }
        return found;
      }
      if (prop === '{-}' && owner instanceof Object) {
        for (const key of Object.keys(owner)) {
          if (!objectFindOwnerFn(owner[key], next)) continue;
          delete owner[key];
          found = true;
        }
        return found;
      }
      if (
        (prop === '[]' && Array.isArray(owner)) ||
        (prop === '{}' && owner instanceof Object) ||
        (prop === '*' && owner instanceof Object)
      ) {
        for (const key of Object.keys(owner)) {
          if (!objectFindOwnerFn(owner[key], next, prune)) continue;
          found = true;
        }
        return found;
      }
      if (!safe.Object_hasOwn(owner, prop)) return false;
      owner = owner[prop];
      chain = chain.slice(pos + 1);
    }
  }

  function objectPruneFn(obj, rawPrunePaths, rawNeedlePaths) {
    if (typeof rawPrunePaths !== 'string') return;
    const safe = safeSelf();
    const prunePaths = rawPrunePaths !== ''
      ? safe.String_split.call(rawPrunePaths, / +/)
      : [];
    const needlePaths = prunePaths.length !== 0 && rawNeedlePaths !== ''
      ? safe.String_split.call(rawNeedlePaths, / +/)
      : [];
    if (objectPruneFn.mustProcess === undefined) {
      objectPruneFn.mustProcess = function (root, needlePaths) {
        for (const needlePath of needlePaths) {
          if (!objectFindOwnerFn(root, needlePath)) return false;
        }
        return true;
      };
    }
    if (prunePaths.length === 0) return;
    let outcome = 'nomatch';
    if (objectPruneFn.mustProcess(obj, needlePaths)) {
      for (const path of prunePaths) {
        if (objectFindOwnerFn(obj, path, true)) outcome = 'match';
      }
    }
    if (outcome === 'match') return obj;
  }

  // ── jsonPruneFetchResponse ────────────────────────────────────────
  // Intercepts fetch() responses and surgically removes ad-related
  // JSON fields before the page script reads them.
  // The fetch proxy is installed ONCE at document_start (install block at
  // the bottom of this file); rules land in _fetchPruneRules later, when
  // the async config load completes. Rules are looked up when the RESPONSE
  // resolves — not when fetch() is called — so requests fired during the
  // config round-trip are still pruned.
  var _fetchPruneRules = [];
  var _fetchProxyInstalled = false;

  // ── trusted-edit-request / trusted-edit-response shared registries ──
  // Whole-body JSONPath assign-or-delete applied to outgoing (request) or
  // incoming (response) JSON bodies. ONE rule wires into BOTH transports
  // (fetch + XHR) — unlike json_prune_fetch/json_prune_xhr, which are
  // separate keys per transport, these register once here and are consulted
  // by every installer below.
  var _editRequestRules = [];  // { jsonp, propNeedles } — trusted_edit_request
  var _editResponseRules = []; // { jsonp, propNeedles } — trusted_edit_response

  // Applies whole-body JSONPath edit rules to an outgoing request body
  // string. Returns the original string unchanged if nothing matched/changed.
  function _applyEditRequestFn(bodyStr, matchDetails) {
    if (_editRequestRules.length === 0 || typeof bodyStr !== 'string') return bodyStr;
    const safe = safeSelf();
    let objBefore;
    try { objBefore = safe.JSON_parse(bodyStr); } catch (e) { return bodyStr; }
    if (typeof objBefore !== 'object' || objBefore === null) return bodyStr;
    let objAfter = objBefore, changed = false;
    for (const rule of _editRequestRules) {
      if (rule.propNeedles.size !== 0 &&
          matchObjectPropertiesFn(rule.propNeedles, matchDetails || {}) === undefined) continue;
      const r = rule.jsonp.apply(objAfter);
      if (r === undefined) continue;
      objAfter = r;
      changed = true;
    }
    if (!changed) return bodyStr;
    try { return safe.JSON_stringify(objAfter); } catch (e) { return bodyStr; }
  }

  function _installFetchResponseProxy() {
    if (_fetchProxyInstalled) return;
    _fetchProxyInstalled = true;
    const safe = safeSelf();
    const applyHandler = function (target, thisArg, args) {
      if (_editRequestRules.length !== 0) {
        try {
          const input = args[0], init = args[1];
          let url, method = 'GET';
          if (typeof input === 'string') url = input;
          else if (input && typeof input === 'object') { url = input.url; if (input.method) method = input.method; }
          if (init && init.method) method = init.method;
          const body = init && init.body;
          if (typeof body === 'string') {
            const after = _applyEditRequestFn(body, { url: url || '', method });
            if (after !== body) args = [args[0], Object.assign({}, init, { body: after })];
          }
        } catch (e) {}
      }
      const fetchPromise = Reflect.apply(target, thisArg, args);
      return fetchPromise.then(responseBefore => {
        if (!_scriptletsEnabled ||
            (_fetchPruneRules.length === 0 && _editResponseRules.length === 0)) return responseBefore;
        let props;
        const applicablePrune = [], applicableEdit = [];
        for (const rule of _fetchPruneRules) {
          if (rule.propNeedles.size !== 0) {
            if (props === undefined) props = collateFetchArgumentsFn(...args);
            if (matchObjectPropertiesFn(rule.propNeedles, props) === undefined) continue;
          }
          applicablePrune.push(rule);
        }
        for (const rule of _editResponseRules) {
          if (rule.propNeedles.size !== 0) {
            if (props === undefined) props = collateFetchArgumentsFn(...args);
            if (matchObjectPropertiesFn(rule.propNeedles, props) === undefined) continue;
          }
          applicableEdit.push(rule);
        }
        if (applicablePrune.length === 0 && applicableEdit.length === 0) return responseBefore;
        const response = responseBefore.clone();
        return response.json().then(objBefore => {
          if (typeof objBefore !== 'object' || objBefore === null) return responseBefore;
          let objAfter = objBefore, changed = false;
          for (const rule of applicablePrune) {
            const r = objectPruneFn(objAfter, rule.prunePaths, rule.needlePaths);
            if (typeof r !== 'object' || r === null) continue;
            objAfter = r;
            changed = true;
            try { window.dispatchEvent(new CustomEvent(_EVT_BLK, { detail: { url: "" } })); } catch (_e) {}
          }
          for (const rule of applicableEdit) {
            const r = rule.jsonp.apply(objAfter);
            if (r === undefined) continue;
            objAfter = r;
            changed = true;
            try { window.dispatchEvent(new CustomEvent(_EVT_BLK, { detail: { url: "" } })); } catch (_e) {}
          }
          if (!changed) return responseBefore;
          // Body length changed (pruned shorter) — content-length must follow it,
          // or a page comparing headers.get('content-length') against the actual
          // body it received gets a tamper-evident mismatch for free. Only touch
          // the header if the original response actually sent one (chunked
          // responses often don't) — adding one that wasn't there is its own tell.
          const textAfter = safe.JSON_stringify(objAfter);
          const fixedHeaders = new Headers(responseBefore.headers);
          if (fixedHeaders.has('content-length')) {
            fixedHeaders.set('content-length', String(new Blob([textAfter]).size));
          }
          const responseAfter = new Response(textAfter, {
            status: responseBefore.status,
            statusText: responseBefore.statusText,
            headers: fixedHeaders,
          });
          safe.Object_defineProperties(responseAfter, {
            ok: { value: responseBefore.ok },
            redirected: { value: responseBefore.redirected },
            type: { value: responseBefore.type },
            url: { value: responseBefore.url },
          });
          return responseAfter;
        }).catch(() => responseBefore);
      }).catch(() => fetchPromise);
    };
    _ensureProxyApplyFnState();
    const nativeFetch = self.fetch;
    const proxiedFetch = new Proxy(nativeFetch, { apply: applyHandler });
    proxyApplyFn.proxies.set(proxiedFetch, nativeFetch);
    self.fetch = proxiedFetch;
  }

  function jsonPruneFetchResponse(rawPrunePaths, rawNeedlePaths) {
    const safe = safeSelf();
    const extraArgs = safe.getExtraArgs(Array.from(arguments), 2);
    _fetchPruneRules.push({
      prunePaths: rawPrunePaths || '',
      needlePaths: rawNeedlePaths || '',
      propNeedles: parsePropertiesToMatchFn(extraArgs.propsToMatch, 'url'),
    });
    // Lazy install — covers sites whose response-filter rules only became
    // known after boot (first visit / rules update). No-op when installed.
    _installFetchResponseProxy();
  }

  // ── XHR response filtering (json_prune_xhr / jsonl_edit_xhr) ─────
  // One XMLHttpRequest subclass installed at document_start; rules are
  // consulted lazily in the response getter, which the page only reads
  // after the request completes — by then the async-loaded rules have
  // normally arrived, so requests opened before rule delivery are still
  // filtered.
  var _xhrPruneRules = []; // { prunePaths, needlePaths, propNeedles }
  var _xhrJsonlRules = []; // { jsonp, propNeedles }
  var _xhrReplaceRules = []; // { re, replacement, propNeedles } — trusted_replace_xhr_response
  var _xhrProxyInstalled = false;
  function _installXhrResponseProxy() {
    if (_xhrProxyInstalled) return;
    const safe = safeSelf();
    const XHR = self.XMLHttpRequest;
    if (!XHR || !XHR.prototype) return;
    const xhrInstances = new WeakMap();
    const applicableRules = function (rules, xhrDetails) {
      const out = [];
      for (const rule of rules) {
        if (rule.propNeedles.size !== 0 &&
            matchObjectPropertiesFn(rule.propNeedles, xhrDetails) === undefined) continue;
        out.push(rule);
      }
      return out;
    };
    // Prune core shared by both install strategies (prototype getter / subclass).
    // `innerResponse` = the ORIGINAL response value already read from the native getter.
    const computeResponse = function (xhr, innerResponse) {
      if (!_scriptletsEnabled) return innerResponse;
      if (_xhrPruneRules.length === 0 && _xhrJsonlRules.length === 0 &&
          _xhrReplaceRules.length === 0 && _editResponseRules.length === 0) return innerResponse;
      const xhrDetails = xhrInstances.get(xhr);
      if (xhrDetails === undefined) return innerResponse;
      const responseLength = typeof innerResponse === 'string'
        ? innerResponse.length
        : undefined;
      if (xhrDetails.lastResponseLength !== responseLength) {
        xhrDetails.response = undefined;
        xhrDetails.lastResponseLength = responseLength;
      }
      if (xhrDetails.response !== undefined) return xhrDetails.response;
      let result = innerResponse;
      // Whole-body JSON pruning
      const pruneRules = applicableRules(_xhrPruneRules, xhrDetails);
      if (pruneRules.length !== 0) {
        let objBefore;
        if (typeof result === 'object' && result !== null) {
          objBefore = result;
        } else if (typeof result === 'string') {
          try { objBefore = safe.JSON_parse(result); } catch (e) {}
        }
        if (typeof objBefore === 'object' && objBefore !== null) {
          let pruned = false;
          for (const rule of pruneRules) {
            // objectPruneFn returns the object only when it actually pruned
            // something — only that counts as a block for stats.
            const objAfter = objectPruneFn(objBefore, rule.prunePaths, rule.needlePaths);
            if (typeof objAfter !== 'object' || objAfter === null) continue;
            objBefore = objAfter;
            pruned = true;
            try { window.dispatchEvent(new CustomEvent(_EVT_BLK, { detail: { url: "" } })); } catch (_e) {}
          }
          if (pruned) {
            result = typeof result === 'string' ? safe.JSON_stringify(objBefore) : objBefore;
          }
        }
      }
      // Whole-body JSONPath edit (assign or delete) — trusted_edit_response.
      // Runs on the already-pruned object/string from the pass above.
      if (_editResponseRules.length !== 0) {
        const editRules = applicableRules(_editResponseRules, xhrDetails);
        if (editRules.length !== 0) {
          let objBefore;
          if (typeof result === 'object' && result !== null) {
            objBefore = result;
          } else if (typeof result === 'string') {
            try { objBefore = safe.JSON_parse(result); } catch (e) {}
          }
          if (typeof objBefore === 'object' && objBefore !== null) {
            let objAfter = objBefore, edited = false;
            for (const rule of editRules) {
              const r = rule.jsonp.apply(objAfter);
              if (r === undefined) continue;
              objAfter = r;
              edited = true;
              try { window.dispatchEvent(new CustomEvent(_EVT_BLK, { detail: { url: "" } })); } catch (_e) {}
            }
            if (edited) {
              result = typeof result === 'string' ? safe.JSON_stringify(objAfter) : objAfter;
            }
          }
        }
      }
      // Regex text replacement (string responses only) — runs before the
      // JSONL pass so line-wise rules see the post-replace text.
      if (typeof result === 'string') {
        const replaceRules = applicableRules(_xhrReplaceRules, xhrDetails);
        for (const rule of replaceRules) {
          const after = result.replace(rule.re, rule.replacement);
          if (after === result) continue;
          result = after;
          try { window.dispatchEvent(new CustomEvent(_EVT_BLK, { detail: { url: "" } })); } catch (_e) {}
        }
      }
      // Line-wise JSONL editing (string responses only)
      if (typeof result === 'string') {
        const jsonlRules = applicableRules(_xhrJsonlRules, xhrDetails);
        for (const rule of jsonlRules) {
          result = jsonlEditFn(rule.jsonp, result);
        }
      }
      return (xhrDetails.response = result);
    };

    const proto = XHR.prototype;
    const descResp = Object.getOwnPropertyDescriptor(proto, 'response');
    const descText = Object.getOwnPropertyDescriptor(proto, 'responseText');
    const nativeOpen = proto.open;
    const nativeSend = proto.send;

    // content-length must track whatever computeResponse() actually hands
    // back (pruned/edited/replaced), or a page comparing
    // getResponseHeader('content-length') against the .response/.responseText
    // it reads gets a tamper-evident length mismatch for free — the body
    // getters below are the only thing this proxy patches by default, so
    // without this the header alone is a complete, un-gated leak. Runs
    // BEFORE the install-strategy branch below (prototype-override vs
    // subclass) so it applies to both — getResponseHeader/getAllResponseHeaders
    // are never shadowed by either strategy, only inherited via the
    // prototype chain either way. Only recomputes once the body is fully
    // available (readyState 4); a check at an earlier readyState (rare —
    // content-length is a header, technically readable from readyState 2,
    // but the pruned body isn't computable before it exists) still sees the
    // real, unpruned value.
    const computedByteLength = function (value) {
      if (typeof value !== 'string') {
        try { value = safe.JSON_stringify(value); } catch (e) { return undefined; }
      }
      try { return new Blob([value]).size; } catch (e) { return value.length; }
    };
    proxyApplyFn('XMLHttpRequest.prototype.getResponseHeader', function (context) {
      // Must read callArgs/thisArg BEFORE reflect() — reflect() nulls both
      // out as part of its context-pooling cleanup (see ApplyContext.reflect).
      const name = context.callArgs[0];
      const xhr = context.thisArg;
      const real = context.reflect();
      // real === null means the original response never sent this header at
      // all — must NOT synthesize one that wasn't there (same rule the fetch
      // path follows: adding a header is its own tell).
      if (!_scriptletsEnabled || real === null) return real;
      if (typeof name !== 'string' || name.toLowerCase() !== 'content-length') return real;
      if (xhr.readyState < 4 || !descResp) return real;
      const len = computedByteLength(computeResponse(xhr, descResp.get.call(xhr)));
      return len === undefined ? real : String(len);
    });
    proxyApplyFn('XMLHttpRequest.prototype.getAllResponseHeaders', function (context) {
      const xhr = context.thisArg;
      const real = context.reflect();
      if (!_scriptletsEnabled || typeof real !== 'string') return real;
      if (xhr.readyState < 4 || !descResp) return real;
      const len = computedByteLength(computeResponse(xhr, descResp.get.call(xhr)));
      if (len === undefined) return real;
      return real.replace(/^content-length:.*$/im, 'content-length: ' + len);
    });

    // Fix #1: override the getters DIRECTLY on XMLHttpRequest.prototype
    // instead of subclassing. Defeats a common anti-adblock bypass: grabbing
    // the native getter via Object.getOwnPropertyDescriptor(...prototype
    // chain...) and calling it directly to skip the subclass. By overriding
    // right on the original prototype, there is no "clean" native getter left
    // underneath to grab. Only applies when the original getter is
    // configurable (true in every modern browser); otherwise falls back to
    // the subclass approach as before.
    //
    // Fix #2 — continuous self-healing, confirmed NECESSARY on facebook.com
    // 2026-07-21: FB has internal code (Haste module system, invoked via
    // React Scheduler, running synchronously inside xhr.send()) that
    // actively re-runs Object.defineProperty on open/response/responseText
    // back to native — not once, but REPEATEDLY (once after mount via
    // 'open', and on EVERY send() via 'response'/'responseText'). Hard-
    // locking defineProperty doesn't work (they can delete+reassign,
    // sidestepping defineProperty entirely). Instead: let their overwrite
    // happen, then RE-PATCH RIGHT AFTER — at the 2 checkpoints where we know
    // for certain their overwrite has already occurred:
    //   - start of every open()  -> re-patch before registering the new request
    //   - end of every send()    -> re-patch right after native send() returns
    // Response data only ever arrives ASYNCHRONOUSLY (after the current
    // tick), so any read of .response/.responseText after that point is
    // guaranteed to see our version.
    if (descResp && descResp.get && descText && descText.get &&
        descResp.configurable !== false && descText.configurable !== false &&
        typeof nativeOpen === 'function' && typeof nativeSend === 'function') {
      const openImpl = function (method, url) {
        reassert();
        xhrInstances.set(this, { method, url });
        return nativeOpen.apply(this, arguments);
      };
      const sendImpl = function () {
        if (_editRequestRules.length !== 0 && typeof arguments[0] === 'string') {
          const details = xhrInstances.get(this) || {};
          const after = _applyEditRequestFn(arguments[0], details);
          if (after !== arguments[0]) arguments[0] = after;
        }
        const r = nativeSend.apply(this, arguments);
        reassert();
        return r;
      };
      const reassert = function () {
        try {
          Object.defineProperty(proto, 'open', { configurable: true, writable: true, value: openImpl });
          Object.defineProperty(proto, 'send', { configurable: true, writable: true, value: sendImpl });
          Object.defineProperty(proto, 'response', {
            configurable: true, enumerable: descResp.enumerable,
            get: function () { return computeResponse(this, descResp.get.call(this)); },
          });
          Object.defineProperty(proto, 'responseText', {
            configurable: true, enumerable: descText.enumerable,
            get: function () {
              const r = this.response;
              return typeof r !== 'string' ? descText.get.call(this) : r;
            },
          });
        } catch (e) { /* ignore — the next re-patch (open/send) will retry */ }
      };
      try {
        reassert();
        _xhrProxyInstalled = true;
        return;
      } catch (e) { /* fall through to the subclass fallback */ }
    }

    // Fallback: subclass (when the original getter isn't overridable on the prototype).
    self.XMLHttpRequest = class extends XHR {
      open(method, url, ...args) {
        xhrInstances.set(this, { method, url });
        return super.open(method, url, ...args);
      }
      send(body) {
        if (_editRequestRules.length !== 0 && typeof body === 'string') {
          const details = xhrInstances.get(this) || {};
          const after = _applyEditRequestFn(body, details);
          if (after !== body) body = after;
        }
        return super.send(body);
      }
      get response() { return computeResponse(this, super.response); }
      get responseText() {
        const r = this.response;
        return typeof r !== 'string' ? super.responseText : r;
      }
    };
    _xhrProxyInstalled = true;
  }

  function jsonPruneXhrResponse(rawPrunePaths, rawNeedlePaths) {
    const safe = safeSelf();
    const extraArgs = safe.getExtraArgs(Array.from(arguments), 2);
    _xhrPruneRules.push({
      prunePaths: rawPrunePaths || '',
      needlePaths: rawNeedlePaths || '',
      propNeedles: parsePropertiesToMatchFn(extraArgs.propsToMatch, 'url'),
    });
    _installXhrResponseProxy();
  }

  // ── trusted-replace-xhr-response ─────────────────────────────────
  // Regex-replaces text in XHR response bodies whose request matches
  // `propsToMatch` — e.g. blank out "adPlacements" blobs in raw JSON
  // before the page script parses them. Registers into the shared XHR
  // response proxy; no extra XMLHttpRequest layer per rule.
  function trustedReplaceXhrResponse(pattern, replacement, propsToMatch) {
    if (!pattern) return;
    var re = pattern === '*' ? /[\s\S]*/ : _toRegex(pattern);
    _xhrReplaceRules.push({
      re: re,
      replacement: replacement || '',
      propNeedles: parsePropertiesToMatchFn(propsToMatch || '', 'url'),
    });
    _installXhrResponseProxy();
  }

  // ── trusted-edit-request / trusted-edit-response ─────────────────
  // TRUSTED: unlike json_edit/jsonl_edit_xhr, value-assigning JSONPath
  // queries (path=value) are allowed here, not just deletions — see
  // _editRequestRules/_editResponseRules and _applyEditRequestFn above.
  function trustedEditRequest(jsonq, propsToMatch) {
    const jsonp = JSONPath.create(jsonq || '');
    if (!jsonp.valid) return;
    _editRequestRules.push({ jsonp, propNeedles: parsePropertiesToMatchFn(propsToMatch || '', 'url') });
    _installFetchResponseProxy();
    _installXhrResponseProxy();
  }
  function trustedEditResponse(jsonq, propsToMatch) {
    const jsonp = JSONPath.create(jsonq || '');
    if (!jsonp.valid) return;
    _editResponseRules.push({ jsonp, propNeedles: parsePropertiesToMatchFn(propsToMatch || '', 'url') });
    _installFetchResponseProxy();
    _installXhrResponseProxy();
  }

  // ── noWindowOpenIf ──────────────────────────────────────────────
  // Proxy installed ONCE at document_start so it intercepts window.open
  // before any page script can capture the original reference.
  // Rules are registered later (on async rules load) via noWindowOpenIf().
  var _noWinOpenRules = [];
  var _scriptletsEnabled = true;
  proxyApplyFn('open', function (context) {
    if (!_scriptletsEnabled || _noWinOpenRules.length === 0) return context.reflect();
    const { callArgs } = context;
    const haystack = callArgs.join(' ');
    const noopFunc = function () {};
     const _blockedUrl = callArgs[0] || '';
    for (var _ri = 0; _ri < _noWinOpenRules.length; _ri++) {
      const rule = _noWinOpenRules[_ri];
      if (rule.re.test(haystack) !== rule.match) continue;
      // Matched — every strategy below blocks the popup, so report it
      // for stats here, once, regardless of which branch handles it.
      try { window.dispatchEvent(new CustomEvent(_EVT_BLK, { detail: { url: _blockedUrl } })); } catch (_e) {}
      if (rule.delay === '') return null;
      if (rule.decoy === 'blank') {
        callArgs[0] = 'about:blank';
        const r = context.reflect();
        setTimeout(() => { try { r.close(); } catch (e) {} }, rule.ms);
        return r;
      }
      const tag = rule.decoy === 'obj' ? 'object' : 'iframe';
      const urlProp = rule.decoy === 'obj' ? 'data' : 'src';
      const decoyEl = document.createElement(tag);
      // <iframe> only: empty sandbox="" blocks script execution (plus forms,
      // popups, same-origin access...) inside whatever loads at the real
      // target URL below, while the network request/markup load still
      // happens — same "sandboxed, allow-scripts not set" behavior uBO
      // relies on for its own popup decoys. <object> has no sandbox
      // attribute, so that branch is unaffected.
      if (tag === 'iframe') decoyEl.setAttribute('sandbox', '');
      decoyEl[urlProp] = callArgs[0] || '';
      decoyEl.style.cssText = 'height:1px;position:fixed;top:-1px;width:1px;pointer-events:none';
      document.body.appendChild(decoyEl);
      setTimeout(() => { decoyEl.remove(); }, rule.ms);
      let popup = decoyEl.contentWindow;
      if (typeof popup === 'object' && popup !== null) {
        try { Object.defineProperty(popup, 'closed', { value: false }); } catch (e) {}
      } else {
        popup = new Proxy(self, {
          get(target, prop, ...args) {
            if (prop === 'closed') return false;
            const r = Reflect.get(target, prop, ...args);
            return typeof r === 'function' ? noopFunc : r;
          },
          set(...args) { return Reflect.set(...args); }
        });
      }
      return popup;
    }
    return context.reflect();
  });

  function noWindowOpenIf(pattern, delay, decoy) {
    pattern = pattern || '';
    delay = delay || '';
    decoy = decoy || '';
    const match = pattern.charAt(0) !== '!';
    if (!match) pattern = pattern.slice(1);
    _noWinOpenRules.push({ re: _toRegex(pattern), match, delay, decoy, ms: (parseFloat(delay) || 0) * 1000 });
  }

  // ── preventAddEventListener ──────────────────────────────────────
  // Blocks addEventListener when event type matches `type` AND
  // handler source code matches `pattern`.
  // Also proxies document.addEventListener directly (some ad scripts
  // bypass EventTarget.prototype by calling document.addEventListener).
  // The proxy is protected against ad scripts overwriting it.
  // Use regex syntax /foo|bar/ for alternation.
  function preventAddEventListener(type, pattern) {
    type = type || '';
    pattern = pattern || '';
    const reType = _toRegex(type);
    const rePattern = _toRegex(pattern);
    const _fnToStr = Function.prototype.toString;
    const shouldPrevent = (t, h) =>
      reType.test(t) && rePattern.test(typeof h === 'string' ? h : '');
    const proxyFn = function (context) {
      if (!_scriptletsEnabled) return context.reflect();
      const { callArgs } = context;
      let t = '', h = '';
      try { t = String(callArgs[0]); } catch (e) {}
      try {
        if (typeof callArgs[1] === 'function') {
          h = _fnToStr.call(callArgs[1]);
        } else if (callArgs[1] && typeof callArgs[1].handleEvent === 'function') {
          h = _fnToStr.call(callArgs[1].handleEvent);
        } else {
          h = String(callArgs[1]);
        }
      } catch (e) {}
      if (type === '' && pattern === '') return context.reflect();
      if (shouldPrevent(t, h)) {
        return;
      }
      return context.reflect();
    };
    // Proxy EventTarget.prototype.addEventListener (covers all elements + window)
    proxyApplyFn('EventTarget.prototype.addEventListener', proxyFn);
    // Also proxy document.addEventListener directly — some ad scripts call it
    // without going through the prototype chain
    proxyApplyFn('document.addEventListener', proxyFn);
  }

  // ── _protectAddEventListener ─────────────────────────────────────
  // Freezes addEventListener after ALL proxy rules have been installed.
  // Must be called ONCE, after all preventAddEventListener() calls,
  // so that each rule's proxyApplyFn() can stack properly.
  // If called inside preventAddEventListener(), the first call would lock
  // the property and prevent subsequent rules from installing their proxies.
  function _protectAddEventListener() {
    try {
      const _etAEL = EventTarget.prototype.addEventListener;
      Object.defineProperty(EventTarget.prototype, 'addEventListener', {
        get() { return _etAEL; },
        set() {}
      });
    } catch (e) {}
    try {
      const _docAEL = document.addEventListener;
      Object.defineProperty(document, 'addEventListener', {
        get() { return _docAEL; },
        set() {}
      });
    } catch (e) {}
  }

  // ── disableNewtabLinks ───────────────────────────────────────────
  // Strips target="_blank" from clicked <a> elements (capture phase)
  // so redirect-style ad pages can't force-open a new tab.
  function disableNewtabLinks() {
    document.addEventListener('click', function (ev) {
      let t = ev.target;
      while (t !== null) {
        if (t.localName === 'a' && t.hasAttribute('target')) {
          ev.stopPropagation();
          ev.preventDefault();
          break;
        }
        t = t.parentNode;
      }
    }, { capture: true });
  }


  // Rate-limit history.pushState/replaceState to stop history-flood back-button ads
  rateLimitHistory();

  // Block same-tab navigations to ad domains via location.href/assign/replace
  blockAdNavigations();

  // ── stripDynamicTargets ──────────────────────────────────────────
  // Proactively strips target="*" from <a>/<form> injected into the DOM,
  // and blocks <form target="..."> submissions.
  function stripDynamicTargets() {
    function _stripTargets(node) {
      if (node.nodeType !== 1) return;
      if ((node.localName === 'a' || node.localName === 'form') && node.hasAttribute('target')) {
        node.removeAttribute('target');
      }
      var els = node.querySelectorAll ? node.querySelectorAll('a[target],form[target]') : [];
      for (var i = 0; i < els.length; i++) els[i].removeAttribute('target');
    }
    new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) _stripTargets(added[j]);
      }
    }).observe(document.documentElement || document, { childList: true, subtree: true });
    document.addEventListener('submit', function (ev) {
      var t = ev.target && ev.target.target;
      if (t && t !== '_self' && t !== '_parent' && t !== '_top') {
        ev.preventDefault();
        ev.stopPropagation();
      }
    }, { capture: true });
  }

  // ── rateLimitHistory ─────────────────────────────────────────────
  // Rate-limits history.pushState/replaceState to ≤20 calls/sec.
  // Ad scripts flood the history stack with same-origin dummy entries
  // then use a popstate handler to redirect on Back; cross-origin
  // pushState always throws SecurityError so domain-checking is useless.
  function rateLimitHistory() {
    var _pushBucket = 0;
    var _pushBucketTs = 0;
    var _PUSH_LIMIT = 20;
    var _BUCKET_MS = 1000;
    function _wrapHistoryFn(name) {
      // Runs on every page (not gated by site-rules matching) — must go
      // through proxyApplyFn so Function.prototype.toString.call(...) on
      // the patched method still reports the real native source instead of
      // this wrapper's own code, which would otherwise be a universal,
      // unconditional "this browser has an interfering extension" signal.
      proxyApplyFn('History.prototype.' + name, function (context) {
        var now = Date.now();
        if (now - _pushBucketTs >= _BUCKET_MS) {
          _pushBucket = 0;
          _pushBucketTs = now;
        }
        if (++_pushBucket > _PUSH_LIMIT) return;
        return context.reflect();
      });
    }
    _wrapHistoryFn('pushState');
    _wrapHistoryFn('replaceState');
  }

  // ── blockAdNavigations ───────────────────────────────────────────
  // Blocks unexpected cross-origin navigations via location.href/assign/replace.
  // Strategy: track real user anchor-clicks (isTrusted=true) and only allow
  // cross-origin navigation when it matches the origin the user clicked toward.
  // All other programmatic cross-origin navigations (ad scripts calling
  // location.href = adUrl inside mousedown/click handlers) are blocked,
  // regardless of the ad domain — no domain blocklist needed.
  function blockAdNavigations() {
    var _allowedOrigin = null;
    var _allowedTimer = 0;

    // Record the origin the user is navigating toward when they click an <a>.
    // Synthetic/programmatic clicks (isTrusted=false) never grant an origin —
    // and if they target a cross-origin anchor, the native navigation itself
    // is cancelled (ad scripts fabricate <a>.click() to escape the Location
    // wrappers below, e.g. from a popstate handler on Back-button hijacks).
    document.addEventListener('click', function(ev) {
      var t = ev.target;
      while (t) {
        if (t.localName === 'a' && t.href && t.href.indexOf('javascript') !== 0) break;
        t = t.parentNode;
      }
      if (!ev.isTrusted) {
        if (t && !_isSafeNavigation(t.href)) {
          ev.preventDefault();
          ev.stopPropagation();
        }
        return;
      }
      if (t) {
        try {
          _allowedOrigin = new URL(t.href).origin;
          clearTimeout(_allowedTimer);
          _allowedTimer = setTimeout(function() { _allowedOrigin = null; }, 1000);
        } catch(e) {}
        return;
      }
      // Click was on a non-anchor element — no cross-origin navigation expected.
      clearTimeout(_allowedTimer);
      _allowedOrigin = null;
    }, { capture: true });

    function _isSafeNavigation(url) {
      // Resolve relative and protocol-relative forms ("//ads.example/x") against
      // the page URL — comparing the raw string lets "//" and "HTTP://" slip by.
      var abs;
      try { abs = new URL(url, location.href); } catch(e) { return true; }
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return true;
      if (abs.origin === location.origin) return true;
      if (_allowedOrigin !== null && abs.origin === _allowedOrigin) return true;
      return false;
    }

    // All three patches below run on every page (not gated by site-rules
    // matching), so — same reasoning as rateLimitHistory — they must not
    // leave a plain, readable wrapper sitting on a native prototype method:
    // Function.prototype.toString.call(...) on it would otherwise be a
    // universal, unconditional detection signal regardless of whether this
    // page ever triggers any ad-navigation block.
    try {
      var _hrefDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
      if (_hrefDesc && _hrefDesc.set) {
        var _hrefSetter = _spoofToString(_hrefDesc.set, function (url) {
          if (!_isSafeNavigation(url)) return;
          _hrefDesc.set.call(this, url);
        });
        Object.defineProperty(Location.prototype, 'href', {
          get: _hrefDesc.get,
          set: _hrefSetter,
          configurable: true,
          enumerable: _hrefDesc.enumerable
        });
      }
    } catch (e) {}

    function _wrapLocationFn(name) {
      proxyApplyFn('Location.prototype.' + name, function (context) {
        if (!_isSafeNavigation(context.callArgs[0])) return;
        return context.reflect();
      });
    }
    _wrapLocationFn('assign');
    _wrapLocationFn('replace');

    // window.open(url, '_self'/'_top'/'_parent') navigates the current tab
    // without touching the Location accessors patched above — the remaining
    // same-tab escape hatch for popstate/back-button redirect scripts.
    proxyApplyFn('open', function (context) {
      var url = context.callArgs[0];
      var target = context.callArgs[1];
      var t = target == null ? '' : String(target).toLowerCase();
      if ((t === '_self' || t === '_top' || t === '_parent') && !_isSafeNavigation(url)) return null;
      return context.reflect();
    });
  }

  // ── delay-range matching (prevent_settimeout / prevent_setinterval) ──
  // uBO's real prevent-setTimeout/prevent-setInterval support a 2nd "delay"
  // argument: exact value, "min-max", "min-" (>=min), "-max" (<=max), each
  // optionally prefixed with "!" to negate. Empty/absent delayRaw matches
  // any delay (pattern-only behavior, same as before this was added).
  function _parseDelayRange(delayRaw) {
    var s = delayRaw || '';
    var not = s.charAt(0) === '!';
    if (not) s = s.slice(1);
    var min, max;
    if (s === '') {
      // unbound — matches anything
    } else {
      var pos = s.indexOf('-');
      if (pos !== 0) min = max = parseInt(s, 10) || 0;
      if (pos !== -1) max = parseInt(s.slice(pos + 1), 10) || Number.MAX_SAFE_INTEGER;
    }
    return {
      test: function (v) {
        if (min === undefined && max === undefined) return true;
        var n = Math.min(Math.max(Number(v) || 0, 0), Number.MAX_SAFE_INTEGER);
        var r;
        if (min === max) r = (min === undefined || n === min);
        else if (min === undefined) r = n <= max;
        else if (max === undefined) r = n >= min;
        else r = n >= min && n <= max;
        return not ? !r : r;
      }
    };
  }

  // ── preventSetTimeout ────────────────────────────────────────────
  // Proxies window.setTimeout; blocks callbacks whose source matches
  // `pattern` AND whose delay matches `delayRaw` (see _parseDelayRange —
  // omit for "any delay"). Empty pattern → matches ALL callbacks (use
  // sparingly, especially without a delay filter too).
  function preventSetTimeout(pattern, delayRaw) {
    var rePattern = (pattern instanceof RegExp) ? pattern : _toRegex(pattern || '');
    var _matchAll = !pattern;
    var delayRange = _parseDelayRange(delayRaw);
    // Report the block to stats only once per rule — pages retry blocked
    // timers in a loop, and each retry is the same block, not a new one.
    var _reported = false;
    proxyApplyFn('setTimeout', function(context) {
      if (!_scriptletsEnabled) return context.reflect();
      var fn = context.callArgs[0];
      var fnStr = '';
      try {
        if (typeof fn === 'function') fnStr = fn.toString();
        else if (typeof fn === 'string') fnStr = fn;
      } catch(e) {}
      if ((_matchAll || rePattern.test(fnStr)) && delayRange.test(context.callArgs[1])) {
        if (!_reported) {
          _reported = true;
          try { window.dispatchEvent(new CustomEvent(_EVT_BLK, { detail: { url: "" } })); } catch (_e) {}
        }
        return;
      } // block
      return context.reflect();
    });
  }

  // ── preventSetInterval ───────────────────────────────────────────
  // Same as preventSetTimeout but for setInterval.
  function preventSetInterval(pattern, delayRaw) {
    var rePattern = (pattern instanceof RegExp) ? pattern : _toRegex(pattern || '');
    var _matchAll = !pattern;
    var delayRange = _parseDelayRange(delayRaw);
    proxyApplyFn('setInterval', function(context) {
      if (!_scriptletsEnabled) return context.reflect();
      var fn = context.callArgs[0];
      var fnStr = '';
      try {
        if (typeof fn === 'function') fnStr = fn.toString();
        else if (typeof fn === 'string') fnStr = fn;
      } catch(e) {}
      if ((_matchAll || rePattern.test(fnStr)) && delayRange.test(context.callArgs[1])) return; // block
      return context.reflect();
    });
  }

  // ── abortOnPropertyWrite ─────────────────────────────────────────
  // Throws when any script WRITES the target property chain — blocks
  // ad scripts from installing their globals.
  function abortOnPropertyWrite(prop) {
    if (typeof prop !== 'string' || !prop) return;
    var tok = _mkToken();
    var owner = window;
    for (;;) {
      var pos = prop.indexOf('.');
      if (pos === -1) break;
      owner = owner[prop.slice(0, pos)];
      if (owner instanceof Object === false) return;
      prop = prop.slice(pos + 1);
    }
    try { delete owner[prop]; } catch (e) {}
    try {
      Object.defineProperty(owner, prop, {
        set: function () { if (_scriptletsEnabled) throw new ReferenceError(tok); }
      });
    } catch (e) {}
  }

  // ── noEvalIf ─────────────────────────────────────────────────────
  // Blocks eval() calls whose source matches `pattern`.
  function noEvalIf(pattern) {
    if (!pattern) return;
    var re = _toRegex(pattern);
    proxyApplyFn('eval', function (context) {
      var a = '';
      try { a = String(context.callArgs[0]); } catch (e) {}
      if (_scriptletsEnabled && re.test(a)) return;
      return context.reflect();
    });
  }

  // ── noWebrtc ─────────────────────────────────────────────────────
  // Neuters RTCPeerConnection — kills WebRTC-based popup/tracking tricks.
  function noWebrtc() {
    var rtcName = window.RTCPeerConnection ? 'RTCPeerConnection'
      : (window.webkitRTCPeerConnection ? 'webkitRTCPeerConnection' : '');
    if (rtcName === '') return;
    var noop = function () {};
    var pc = function () {};
    pc.prototype = {
      close: noop,
      createDataChannel: noop,
      createOffer: noop,
      setRemoteDescription: noop,
      toString: function () { return '[object RTCPeerConnection]'; }
    };
    var z = window[rtcName];
    window[rtcName] = pc.bind(window);
    if (z.prototype) {
      z.prototype.createDataChannel = function () {
        return { close: function () {}, send: function () {} };
      }.bind(null);
    }
  }

  // ── preventBab ───────────────────────────────────────────────────
  // Defuses BlockAdBlock/FuckAdBlock detection:
  // recognizes its eval'd payload by signature and skips execution.
  function preventBab() {
    var signatures = [
      ['blockadblock'],
      ['babasbm'],
      [/getItem\('babn'\)/],
      [
        'getElementById', 'String.fromCharCode',
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
        'charAt', 'DOMContentLoaded', 'AdBlock', 'addEventListener',
        'doScroll', 'fromCharCode', '<<2|r>>4', 'sessionStorage',
        'clientWidth', 'localStorage', 'Math', 'random'
      ]
    ];
    function check(s) {
      if (typeof s !== 'string') return false;
      for (var i = 0; i < signatures.length; i++) {
        var tokens = signatures[i], match = 0;
        for (var j = 0; j < tokens.length; j++) {
          var token = tokens[j];
          var hit = token instanceof RegExp ? token.test(s) : s.includes(token);
          if (hit) match += 1;
        }
        if (match / tokens.length >= 0.8) return true;
      }
      return false;
    }
    proxyApplyFn('eval', function (context) {
      var a = context.callArgs[0];
      if (!_scriptletsEnabled || !check(a)) return context.reflect();
      if (document.body) document.body.style.removeProperty('visibility');
      var el = document.getElementById('babasbmsgx');
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    proxyApplyFn('setTimeout', function (context) {
      var a = context.callArgs[0];
      if (_scriptletsEnabled && typeof a === 'string' && /\.bab_elementid.$/.test(a)) {
        context.callArgs[0] = function () {};
      }
      return context.reflect();
    });
  }

  // ── preventRequestAnimationFrame ─────────────────────────────────
  // Replaces rAF callbacks whose source matches `pattern` with a noop.
  // Prefix '!' inverts the match.
  function preventRequestAnimationFrame(pattern) {
    if (!pattern) return;
    var not = pattern.charAt(0) === '!';
    var re = _toRegex(not ? pattern.slice(1) : pattern);
    proxyApplyFn('requestAnimationFrame', function (context) {
      if (_scriptletsEnabled) {
        var a = '';
        try {
          a = typeof context.callArgs[0] === 'function'
            ? context.callArgs[0].toString()
            : String(context.callArgs[0]);
        } catch (e) {}
        if (re.test(a) !== not) context.callArgs[0] = function () {};
      }
      return context.reflect();
    });
  }

  // ── adjustSetTimeout / adjustSetInterval ─────────────────────────
  // Rescales timer delays for matching callbacks — e.g. turn a 10s
  // "please wait" countdown into 0.5s.
  function _adjustTimerFn(name, needle, delayArg, boostArg) {
    var re = _toRegex(needle || '');
    var delay = delayArg !== '*' ? parseInt(delayArg, 10) : -1;
    if (isNaN(delay) || !isFinite(delay)) delay = 1000;
    var boost = parseFloat(boostArg);
    boost = !isNaN(boost) && isFinite(boost)
      ? Math.min(Math.max(boost, 0.001), 50)
      : 0.05;
    proxyApplyFn(name, function (context) {
      if (_scriptletsEnabled) {
        var a = context.callArgs[0], b = context.callArgs[1];
        var s = '';
        try { s = String(a); } catch (e) {}
        if ((delay === -1 || b === delay) && re.test(s)) {
          context.callArgs[1] = b * boost;
        }
      }
      return context.reflect();
    });
  }
  function adjustSetTimeout(needle, delay, boost) {
    _adjustTimerFn('setTimeout', needle, delay, boost);
  }
  function adjustSetInterval(needle, delay, boost) {
    _adjustTimerFn('setInterval', needle, delay, boost);
  }

  // ── JSONPath ─────────────────────────────────────────────────────
  // JSONPath query engine. Required by json-edit. Ported from uBO's real
  // src/js/jsonpath.js (2026-08-13) — this was previously an independent
  // reimplementation that diverged from upstream in ways that silently
  // changed match results for some query shapes (no thrown errors anywhere
  // upstream of this, so a mismatch here is invisible). Kept faithful to
  // upstream rather than re-deriving, to avoid re-introducing that class of
  // bug. NOT ported: the `{n,m};$`/`;$` quantifier step type (#QUANTIFIER) —
  // grepped rule/site-rules.txt, nothing uses it; add it back from upstream
  // jsonpath.js if a rule ever needs it.
  class JSONPath {
    static create(query) {
        const jsonp = new JSONPath();
        jsonp.compile(query);
        return jsonp;
    }
    static toJSON(obj, stringifier, ...args) {
        return (stringifier || JSON.stringify)(obj, ...args)
            .replace(/\//g, '\\/');
    }
    static keys = Object.keys;
    static entries = Object.entries;
    static hasOwn = Object.hasOwn;
    static Regex = RegExp;
    get value() {
        return this.#compiled && this.#compiled.rval;
    }
    set value(v) {
        if ( this.#compiled === undefined ) { return; }
        this.#compiled.rval = v;
    }
    get valid() {
        return this.#compiled !== undefined;
    }
    compile(query) {
        this.#compiled = undefined;
        this.v2 = query.startsWith('v2:');
        if ( this.v2 ) { query = query.slice(3); }
        const r = this.#compile(query, 0);
        if ( r === undefined ) { return; }
        if ( r.i !== query.length ) {
            let val;
            if ( query.startsWith('=', r.i) ) {
                const match = this.#reRval.exec(query.slice(r.i));
                if ( match ) {
                    r.modify = match[1];
                    val = match[2];
                } else {
                    val = query.slice(r.i+1);
                }
            } else if ( query.startsWith('+=', r.i) ) {
                r.modify = '+';
                val = query.slice(r.i+2);
            }
            try { r.rval = JSON.parse(val); }
            catch { return; }
        }
        r.v2 = this.v2;
        this.#compiled = r;
    }
    evaluate(root) {
        if ( this.valid === false ) { return []; }
        this.#root = { '$': root };
        const paths = this.#evaluate(this.#compiled.steps, []);
        this.#root = null;
        return paths;
    }
    apply(root) {
        if ( this.valid === false ) { return; }
        const { rval } = this.#compiled;
        this.#root = { '$': root };
        const paths = this.#evaluate(this.#compiled.steps, []);
        let i = paths.length;
        if ( i === 0 ) { this.#root = null; return; }
        while ( i-- ) {
            const { obj, key } = this.#resolvePath(paths[i]);
            if ( obj === undefined ) { continue; }
            if ( rval !== undefined ) {
                this.#modifyVal(obj, key);
            } else if ( Array.isArray(obj) && typeof key === 'number' ) {
                obj.splice(key, 1);
            } else {
                delete obj[key];
            }
        }
        const result = this.#root['$'] !== undefined ? this.#root['$'] : null;
        this.#root = null;
        return result;
    }
    dump() {
        return JSON.stringify(this.#compiled);
    }
    toJSON(obj, ...args) {
        return JSONPath.toJSON(obj, null, ...args);
    }
    get [Symbol.toStringTag]() {
        return 'JSONPath';
    }
    #UNDEFINED = 0;
    #ROOT = 1;
    #CURRENT = 2;
    #CHILDREN = 3;
    #DESCENDANTS = 4;
    #reUnquotedIdentifier = /^[A-Za-z_][\w]*|^\*/;
    #reExpr = /^\s*([!=^$*]=|[<>]=?)\s*(.+?)\]/;
    #reIndice = /^-?\d+/;
    #reRval = /^=([a-z]+)\((.+)\)$/;
    #root;
    #compiled;
    #compile(query, i) {
        if ( query.length === 0 ) { return; }
        const steps = [];
        let c = query.charCodeAt(i);
        if ( c === 0x24 /* $ */ ) {
            steps.push({ mv: this.#ROOT });
            i += 1;
        } else if ( c === 0x40 /* @ */ ) {
            steps.push({ mv: this.#CURRENT });
            i += 1;
        } else {
            steps.push({ mv: i === 0 ? this.#ROOT : this.#CURRENT });
        }
        let mv = this.#UNDEFINED;
        for (;;) {
            if ( i === query.length ) { break; }
            c = query.charCodeAt(i);
            if ( c === 0x20 /* whitespace */ ) {
                i += 1;
                continue;
            }
            if ( c === 0x2E /* . */ ) {
                if ( mv !== this.#UNDEFINED ) { return; }
                if ( query.startsWith('..', i) ) {
                    mv = this.#DESCENDANTS;
                    i += 2;
                } else {
                    mv = this.#CHILDREN;
                    i += 1;
                }
                continue;
            }
            if ( c !== 0x5B /* [ */ ) {
                if ( mv === this.#UNDEFINED ) {
                    const step = steps[steps.length - 1];
                    if ( step === undefined ) { return; }
                    const j = this.#compileExpr(query, step, i);
                    if ( j ) { i = j; }
                    break;
                }
                const r = this.#consumeUnquotedIdentifier(query, i);
                if ( r === undefined ) { return; }
                steps.push({ mv, k: r.s });
                i = r.i;
                mv = this.#UNDEFINED;
                continue;
            }
            if ( mv === this.#CHILDREN ) { return; }
            if ( query.startsWith('[?', i) ) {
                const not = query.charCodeAt(i+2) === 0x21 /* ! */ ? 1 : 0;
                const j = i + 2 + not;
                const r = this.#compile(query, j);
                if ( r === undefined ) { return; }
                if ( query.startsWith(']', r.i) === false ) { return; }
                if ( not ) { r.steps[r.steps.length - 1].not = true; }
                steps.push({ mv: mv || this.#CHILDREN, steps: r.steps });
                i = r.i + 1;
                mv = this.#UNDEFINED;
                continue;
            }
            if ( query.startsWith('[*]', i) ) {
                mv = mv || this.#CHILDREN;
                steps.push({ mv, k: '*' });
                i += 3;
                mv = this.#UNDEFINED;
                continue;
            }
            const r = this.#consumeIdentifier(query, i+1);
            if ( r === undefined ) { return; }
            mv = mv || this.#CHILDREN;
            steps.push({ mv, k: r.s });
            i = r.i + 1;
            mv = this.#UNDEFINED;
        }
        if ( steps.length === 0 ) { return; }
        if ( mv !== this.#UNDEFINED ) { return; }
        return { steps, i };
    }
    #evaluate(steps, pathin) {
        let resultset = [];
        if ( Array.isArray(steps) === false ) { return resultset; }
        for ( const step of steps ) {
            switch ( step.mv ) {
            case this.#ROOT:
                resultset = [ [ '$' ] ];
                break;
            case this.#CURRENT:
                if ( step.op ) {
                    const { obj, key } = this.#resolvePath(pathin);
                    if ( obj === undefined ) { return []; }
                    const outcome = this.#evaluateExpr(step, obj, key);
                    if ( outcome !== true ) { break; }
                }
                resultset = [ pathin ];
                break;
            case this.#CHILDREN:
            case this.#DESCENDANTS: {
                if ( resultset.length === 0 ) { break; }
                resultset = this.#getMatches(resultset, step);
                break;
            }
            default:
                break;
            }
        }
        return resultset;
    }
    #getMatches(listin, step) {
        const listout = [];
        for ( const pathin of listin ) {
            const { value: owner } = this.#resolvePath(pathin);
            if ( owner === undefined ) { continue; }
            if ( step.steps ) {
                this.#getMatchesFromExpr(pathin, step, owner, listout);
                continue;
            }
            const iter = this.#expandKey(owner, step.k);
            if ( iter ) {
                for ( const k of iter ) {
                    const outcome = this.#evaluateExpr(step, owner, k);
                    if ( outcome !== true ) { continue; }
                    listout.push([ ...pathin, k ]);
                }
            }
            if ( step.mv !== this.#DESCENDANTS ) { continue; }
            for ( const { obj, key, path } of this.#getDescendants(owner, true) ) {
                const iter = this.#expandKey(obj[key], step.k);
                if ( iter === undefined ) { continue; }
                for ( const k of iter ) {
                    const outcome = this.#evaluateExpr(step, obj[key], k);
                    if ( outcome !== true ) { continue; }
                    listout.push([ ...pathin, ...path, k ]);
                }
            }
        }
        return listout;
    }
    #expandKey(owner, k) {
        if ( typeof owner !== 'object' || owner === null ) { return; }
        if ( Array.isArray(k) ) {
            const out = [];
            for ( const a of k ) {
                const iter = this.#expandKey(owner, a);
                if ( iter === undefined ) { continue; }
                out.push(...iter);
            }
            return out;
        }
        if ( typeof k === 'number' ) {
            if ( Array.isArray(owner) === false ) { return; }
            return [ k >= 0 ? k : owner.length + k ];
        }
        if ( k === '*' ) {
            if ( Array.isArray(owner) ) { return owner.keys(); }
            return JSONPath.keys(owner);
        }
        if ( k instanceof JSONPath.Regex ) {
            const out = [];
            for ( const key of JSONPath.keys(owner) ) {
                if ( k.test(key) === false ) { continue; }
                out.push(key);
            }
            return out;
        }
        return [ k ];
    }
    #getMatchesFromExpr(pathin, step, owner, out) {
        const recursive = step.mv === this.#DESCENDANTS;
        const v2 = this.#compiled.v2 || recursive || Array.isArray(owner);
        for ( const { path } of this.#getDescendants(owner, recursive) ) {
            const q = v2 ? [ ...pathin, ...path ] : pathin;
            const r = this.#evaluate(step.steps, q);
            if ( Boolean(r && r.length) === false ) { continue; }
            out.push(q);
            if ( v2 === false ) { break; }
        }
    }
    #getDescendants(v, recursive) {
        const iterator = {
            next() {
                const n = this.stack.length;
                if ( n === 0 ) {
                    this.value = undefined;
                    this.done = true;
                    return this;
                }
                const details = this.stack[n-1];
                const entry = details.keys.next();
                if ( entry.done ) {
                    this.stack.pop();
                    this.path.pop();
                    return this.next();
                }
                this.path[n-1] = entry.value;
                this.value = {
                    obj: details.obj,
                    key: entry.value,
                    path: this.path.slice(),
                };
                const v = this.value.obj[this.value.key];
                if ( recursive ) {
                    if ( Array.isArray(v) ) {
                        this.stack.push({ obj: v, keys: v.keys() });
                    } else if ( typeof v === 'object' && v !== null ) {
                        this.stack.push({ obj: v, keys: JSONPath.keys(v).values() });
                    }
                }
                return this;
            },
            path: [],
            value: undefined,
            done: false,
            stack: [],
            [Symbol.iterator]() { return this; },
        };
        if ( Array.isArray(v) ) {
            iterator.stack.push({ obj: v, keys: v.keys() });
        } else if ( typeof v === 'object' && v !== null ) {
            iterator.stack.push({ obj: v, keys: JSONPath.keys(v).values() });
        }
        return iterator;
    }
    #consumeIdentifier(query, i) {
        const keys = [];
        let needIdentifier = true;
        while ( i < query.length ) {
            const c0 = query.charCodeAt(i);
            if ( c0 === 0x5D /* ] */ ) { break; }
            if ( c0 === 0x20 /* SPACE */ ) {
                i += 1;
                continue;
            }
            if ( c0 === 0x2C /* , */ ) {
                if ( needIdentifier ) { return; }
                i += 1;
                needIdentifier = true;
                continue;
            }
            if ( c0 === 0x22 /* " */ || c0 === 0x27 /* ' */ ) {
                const r = this.#untilChar(query, c0, i+1);
                if ( r === undefined ) { return; }
                keys.push(r.s);
                i = r.i;
                needIdentifier = false;
                continue;
            }
            if ( c0 === 0x2D /* - */ || c0 >= 0x30 && c0 <= 0x39 ) {
                const match = this.#reIndice.exec(query.slice(i));
                if ( match === null ) { return; }
                const indice = parseInt(query.slice(i), 10);
                keys.push(indice);
                i += match[0].length;
                needIdentifier = false;
                continue;
            }
            if ( this.v2 ) { return; }
            const r = this.#consumeUnquotedIdentifier(query, i);
            if ( r === undefined ) { return; }
            keys.push(r.s);
            i = r.i;
        }
        if ( needIdentifier ) { return; }
        return { s: keys.length === 1 ? keys[0] : keys, i };
    }
    #consumeUnquotedIdentifier(query, i) {
        if ( query.charCodeAt(i) === 0x2F /* / */ ) {
            const r = this.#untilChar(query, 0x2F, i+1);
            if ( r === undefined ) { return; }
            let re;
            try { re = new JSONPath.Regex(r.s); } catch { return; }
            return { s: re, i: r.i };
        }
        const match = this.#reUnquotedIdentifier.exec(query.slice(i));
        if ( match === null ) { return; }
        return { s: match[0], i: i + match[0].length };
    }
    #untilChar(query, targetCharCode, i) {
        const len = query.length;
        const parts = [];
        let beg = i, end = i;
        for (;;) {
            if ( end === len ) { return; }
            const c = query.charCodeAt(end);
            if ( c === targetCharCode ) {
                parts.push(query.slice(beg, end));
                end += 1;
                break;
            }
            if ( c === 0x5C /* \ */ && (end+1) < len ) {
                const d = query.charCodeAt(end+1);
                if ( d === targetCharCode ) {
                    parts.push(query.slice(beg, end));
                    end += 1;
                    beg = end;
                }
            }
            end += 1;
        }
        return { s: parts.join(''), i: end };
    }
    #compileExpr(query, step, i) {
        if ( query.startsWith('=/', i) ) {
            const r = this.#untilChar(query, 0x2F /* / */, i+2);
            if ( r === undefined ) { return i; }
            const match = /^[i]/.exec(query.slice(r.i));
            try {
                step.rval = new JSONPath.Regex(r.s, match && match[0] || undefined);
            } catch { return; }
            step.op = 're';
            if ( match ) { r.i += match[0].length; }
            return r.i;
        }
        const match = this.#reExpr.exec(query.slice(i));
        if ( match === null ) { return; }
        const op = match[1], rval = match[2];
        if ( rval.charCodeAt(0) === 0x27 /* ' */ ) {
            const r = this.#untilChar(rval, 0x27, 1);
            if ( r === undefined ) { return; }
            step.rval = r.s;
            step.op = op;
        } else {
            try {
                step.rval = JSON.parse(rval);
                step.op = op;
            } catch { return; }
        }
        return i + match[0].length - 1;
    }
    #resolvePath(path) {
        if ( path.length === 0 ) { return { value: this.#root }; }
        const key = path[path.length - 1];
        let obj = this.#root;
        for ( let i = 0, n = path.length-1; i < n; i++ ) {
            obj = obj[path[i]];
            if ( obj instanceof Object === false ) { return {}; }
        }
        return { obj, key, value: obj[key] };
    }
    #evaluateExpr(step, owner, k) {
        if ( owner === undefined || owner === null ) { return; }
        const hasOwn = owner[k] !== undefined || JSONPath.hasOwn(owner, k);
        if ( step.op !== undefined && hasOwn === false ) { return; }
        const target = step.not !== true;
        const v = owner[k];
        switch ( step.op ) {
        case '==': return (v === step.rval) === target;
        case '!=': return (v !== step.rval) === target;
        case  '<': return (v < step.rval) === target;
        case '<=': return (v <= step.rval) === target;
        case  '>': return (v > step.rval) === target;
        case '>=': return (v >= step.rval) === target;
        case '^=': return `${v}`.startsWith(step.rval) === target;
        case '$=': return `${v}`.endsWith(step.rval) === target;
        case '*=': return `${v}`.includes(step.rval) === target;
        case 're': return step.rval.test(`${v}`);
        default: break;
        }
        return hasOwn === target;
    }
    #modifyVal(obj, key) {
        let { modify, rval } = this.#compiled;
        if ( typeof rval === 'string' ) {
            rval = rval.replace('${now}', `${Date.now()}`);
        }
        switch ( modify ) {
        case undefined:
            obj[key] = rval;
            break;
        case '+': {
            if ( rval instanceof Object === false ) { return; }
            const lval = obj[key];
            if ( lval instanceof Object === false ) { return; }
            if ( Array.isArray(lval) ) { return; }
            for ( const [ k, v ] of JSONPath.entries(rval) ) {
                lval[k] = v;
            }
            break;
        }
        case 'call': {
            const entries = rval.slice();
            if ( entries.length < 2 ) { break; }
            entries.forEach((a, i, aa) => {
                if ( a === '${obj}' ) { aa[i] = obj; }
                else if ( a === '${key}' ) { aa[i] = key; }
                else if ( a === '${val}' ) { aa[i] = obj[key]; }
            });
            const instance = entries[0] ?? self;
            instance[entries[1]](...entries.slice(2));
            break;
        }
        case 'repl': {
            const lval = obj[key];
            if ( typeof lval !== 'string' ) { return; }
            if ( this.#compiled.re === undefined ) {
                this.#compiled.re = null;
                try {
                    this.#compiled.re = rval.regex !== undefined
                        ? new JSONPath.Regex(rval.regex, rval.flags)
                        : new JSONPath.Regex(rval.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
                } catch {
                }
            }
            if ( this.#compiled.re === null ) { return; }
            obj[key] = lval.replace(this.#compiled.re, rval.replacement);
            break;
        }
        default:
            break;
        }
    }
  }

  // ── json-edit ─────────────────────────────────────────────────────
  // JSON.parse proxy installed ONCE at document_start; compiled JSONPath
  // rules land in _jsonEditRules when the async config arrives.
  var _jsonEditRules = [];
  var _jsonPruneRules = []; // { prunePaths, needlePaths } — applied by the same JSON.parse proxy
  var _jsonEditProxyInstalled = false;
  function _installJsonEditProxy() {
    if (_jsonEditProxyInstalled) return;
    _jsonEditProxyInstalled = true;
    proxyApplyFn('JSON.parse', function(context) {
      const obj = context.reflect();
      if (!_scriptletsEnabled) return obj;
      if (_jsonEditRules.length === 0 && _jsonPruneRules.length === 0) return obj;
      let objAfter = obj;
      for (const rule of _jsonPruneRules) {
        const r = objectPruneFn(objAfter, rule.prunePaths, rule.needlePaths);
        if (typeof r === 'object' && r !== null) objAfter = r;
      }
      for (const jsonp of _jsonEditRules) {
        const r = jsonp.apply(objAfter);
        if (r !== undefined) objAfter = r;
      }
      return objAfter;
    });
  }

  // ── data-sjs guard ────────────────────────────────────────────────
  // Some SSR payloads (Facebook's RelayPrefetchedStreamCache bootloader
  // format) ship inside inert <script type="application/json" data-sjs>
  // tags and are never handed to the global JSON.parse — confirmed live by
  // logging every JSON.parse call and finding none matching the tag's
  // content. A MutationObserver installed at document_start catches these
  // tags the instant the HTML parser inserts them (a microtask checkpoint
  // runs after every later <script> executes, so this always wins the race
  // against whatever later reads the tag) and applies the same
  // _jsonPruneRules/_jsonEditRules directly on the tag's textContent.
  var _sjsGuardInstalled = false;
  function _installSjsGuard() {
    if (_sjsGuardInstalled) return;
    if (typeof MutationObserver === 'undefined') return;
    _sjsGuardInstalled = true;
    const safe = safeSelf();
    const processNode = function (node) {
      if (node.nodeType !== 1 || node.tagName !== 'SCRIPT') return;
      if (node.type !== 'application/json' || !node.hasAttribute('data-sjs')) return;
      if (!_scriptletsEnabled) return;
      if (_jsonEditRules.length === 0 && _jsonPruneRules.length === 0) return;
      const text = node.textContent;
      if (!text || text.length < 100) return;
      let obj;
      try { obj = safe.JSON_parse(text); } catch (e) { return; }
      if (typeof obj !== 'object' || obj === null) return;
      let objAfter = obj;
      for (const rule of _jsonPruneRules) {
        const r = objectPruneFn(objAfter, rule.prunePaths, rule.needlePaths);
        if (typeof r === 'object' && r !== null) objAfter = r;
      }
      for (const jsonp of _jsonEditRules) {
        const r = jsonp.apply(objAfter);
        if (r !== undefined) objAfter = r;
      }
      // Compare serialized output rather than object identity: safe.JSON_parse
      // may itself be the already-hooked JSON.parse (installed above), which
      // can prune objAfter in place during parsing, making an `objAfter === obj`
      // check wrongly skip the textContent rewrite.
      let textAfter;
      try { textAfter = safe.JSON_stringify(objAfter); } catch (e) { return; }
      if (textAfter === text) return;
      // data-content-len must track the new length: Facebook's BigPipe
      // loader appears to validate it before parsing the tag, and this one
      // script often bundles unrelated Haste modules — a stale length
      // fails that check and cascades into unrelated module init errors.
      try {
        if (node.hasAttribute('data-content-len')) {
          node.setAttribute('data-content-len', String(textAfter.length));
        }
        node.textContent = textAfter;
      } catch (e) {}
    };
    try {
      const existing = document.querySelectorAll('script[type="application/json"][data-sjs]');
      for (let i = 0; i < existing.length; i++) processNode(existing[i]);
      // data-sjs tags are an SSR-only mechanism written by the initial HTML
      // parse — later SPA updates (infinite scroll, etc.) never add more of
      // them, that traffic goes through fetch/XHR instead. Observing the
      // whole document subtree past DOMContentLoaded just taxes every React
      // re-render for the rest of the tab's life for zero benefit, so
      // disconnect as soon as the initial parse is done.
      if (document.readyState !== 'loading') return;
      const processAdded = function (node) {
        if (node.nodeType !== 1) return;
        // BigPipe often inserts a whole HTML chunk in one shot (e.g. via
        // innerHTML on a container), so the data-sjs tag can arrive as a
        // DESCENDANT of the addedNodes entry rather than the entry itself —
        // processNode() alone (tagName check) would silently miss it.
        processNode(node);
        if (node.querySelectorAll) {
          const nested = node.querySelectorAll('script[type="application/json"][data-sjs]');
          for (let i = 0; i < nested.length; i++) processNode(nested[i]);
        }
      };
      // Re-check an already-tracked <script data-sjs> whose text is
      // reassigned/appended AFTER insertion (a `<script>` node is often
      // added near-empty first, then filled in — reassigning .textContent
      // replaces its Text child, which is a childList mutation whose
      // addedNodes is a bare Text node (nodeType 3) that processAdded()
      // above ignores; and a direct .appendData()-style edit is a
      // characterData mutation whose target IS the Text node, one level
      // below the <script>). Walking up from mut.target catches both.
      const isSjsScript = function (el) {
        return !!(el && el.nodeType === 1 && el.tagName === 'SCRIPT' &&
          el.hasAttribute && el.hasAttribute('data-sjs'));
      };
      const mo = new MutationObserver(function (mutList) {
        if (_jsonEditRules.length === 0 && _jsonPruneRules.length === 0) return;
        const retarget = new Set();
        for (const mut of mutList) {
          for (const node of mut.addedNodes) processAdded(node);
          let el = mut.target;
          if (el && el.nodeType === 3) el = el.parentNode; // characterData: target is the Text node
          if (isSjsScript(el)) retarget.add(el);
        }
        for (const el of retarget) processNode(el);
      });
      mo.observe(document, { childList: true, subtree: true, characterData: true });
      document.addEventListener('DOMContentLoaded', function () {
        mo.disconnect();
      }, { once: true });
    } catch (e) {}
  }

  // ── json-prune (JSON.parse level) ────────────────────────────────
  // Prunes ad fields from EVERY JSON.parse result — catches payloads
  // embedded in inline scripts that never touch fetch/XHR.
  function jsonPrune(rawPrunePaths, rawNeedlePaths) {
    if (!rawPrunePaths) return;
    _jsonPruneRules.push({
      prunePaths: rawPrunePaths,
      needlePaths: rawNeedlePaths || '',
    });
    _installJsonEditProxy();
    _installSjsGuard();
  }

  // ── jspbPlayerResponsePrune (TRUSTED) ────────────────────────────────
  // YouTube's newer protobuf/jspb-decoded player-response path never
  // touches fetch()/XHR/JSON.parse at all — the object is built straight
  // from the binary response body inside an internal Promise chain, so
  // json_prune_fetch/json_prune_xhr (which only see those three surfaces)
  // are structurally blind to it. There's no URL to match against either:
  // by the time this runs, the network request itself is long gone —
  // the only handle left is a marker string inside the resolve callback's
  // OWN source, which is why this has to go through Promise.prototype.then
  // instead of a transport-level proxy.
  // Two call shapes have been observed for this path (a competing
  // extension's bypass code targets both):
  //  - an async-iterator '.next(' continuation, where the resolved value
  //    is {value: <JSON text containing "playerResponse">, ...} — value is
  //    parsed, pruned, and re-serialized in place.
  //  - a direct 'jspbResponseCtor' constructor callback, whose resolved
  //    value already has responseContext — pruned in place, no JSON step.
  // Reuses whatever paths are already configured for json_prune_fetch
  // (_fetchPruneRules) instead of hardcoding a second ad-field list here,
  // so site-rules.txt stays the single source of truth for what "ad
  // field" means on a given site.
  function installJspbPlayerResponsePrune() {
    function pruneInPlace(obj) {
      if (!obj || typeof obj !== 'object') return;
      for (var i = 0; i < _fetchPruneRules.length; i++) {
        try { objectPruneFn(obj, _fetchPruneRules[i].prunePaths, _fetchPruneRules[i].needlePaths); } catch (e) {}
      }
    }
    proxyApplyFn('Promise.prototype.then', function (context) {
      var cb = context.callArgs[0];
      var src = '';
      if (typeof cb === 'function') {
        try { src = cb.toString(); } catch (e) {}
      }
      if (src.indexOf('jspbResponseCtor') !== -1) {
        context.callArgs[0] = _spoofToString(cb, function (value) {
          if (value && value.responseContext) pruneInPlace(value);
          return cb(value);
        });
      } else if (src.indexOf('.next(') !== -1) {
        context.callArgs[0] = _spoofToString(cb, function (result) {
          try {
            if (result && typeof result.value === 'string' && result.value.indexOf('playerResponse') !== -1) {
              var parsed = JSON.parse(result.value);
              pruneInPlace(parsed);
              result.value = JSON.stringify(parsed);
            }
          } catch (e) {}
          return cb(result);
        });
      }
      return context.reflect();
    });
  }

  function jsonEdit(jsonq) {
    const jsonp = JSONPath.create(jsonq || '');
    // Untrusted variant — value-assigning queries are rejected.
    if (!jsonp.valid || jsonp.value !== undefined) return;
    _jsonEditRules.push(jsonp);
    _installJsonEditProxy();
    _installSjsGuard();
  }

  // ── jsonl-edit-xhr-response ───────────────────────────────────────
  // Intercepts XHR responses in JSONL format (one JSON object per line)
  // and applies a JSONPath query to each parsed line.
  function jsonlEditFn(jsonp, text) {
    text = text || '';
    const safe = safeSelf();
    var lineSeparatorMatch = /\r?\n/.exec(text);
    var sep = (lineSeparatorMatch && lineSeparatorMatch[0]) || '\n';
    var linesBefore = text.split('\n');
    var linesAfter = [];
    for (var i = 0; i < linesBefore.length; i++) {
      var lineBefore = linesBefore[i];
      var obj;
      try { obj = safe.JSON_parse(lineBefore); } catch(e) {}
      if (typeof obj !== 'object' || obj === null) {
        linesAfter.push(lineBefore);
        continue;
      }
      var objAfter = jsonp.apply(obj);
      if (objAfter === undefined) {
        linesAfter.push(lineBefore);
        continue;
      }
      linesAfter.push(safe.JSON_stringify(objAfter));
    }
    return linesAfter.join(sep);
  }

  // Registers a JSONL rule for the shared XHR response proxy
  // (_installXhrResponseProxy) — no extra XMLHttpRequest layer per rule.
  function jsonlEditXhrResponse(jsonq, urlPattern) {
    const jsonp = JSONPath.create(jsonq || '');
    if (!jsonp.valid || jsonp.value !== undefined) return;
    _xhrJsonlRules.push({
      jsonp,
      propNeedles: parsePropertiesToMatchFn(urlPattern || '', 'url'),
    });
    _installXhrResponseProxy();
  }

  // ── trusted-prevent-dom-bypass ──────────────────────────────────────
  function trustedPreventDomBypass(methodPath, targetProp) {
    if (!methodPath) return;
    proxyApplyFn(methodPath, function(context) {
      var elems = new Set(context.callArgs.filter(function(e) {
        return e instanceof HTMLElement;
      }));
      var r = context.reflect();
      if (elems.size === 0) return r;
      elems.forEach(function(elem) {
        try {
          if (String(elem.contentWindow) !== '[object Window]') return;
          var href = elem.contentWindow.location.href;
          if (href !== 'about:blank' && href !== self.location.href) return;
          if (targetProp) {
            var me = self, it = elem.contentWindow, chain = targetProp;
            for (;;) {
              var pos = chain.indexOf('.');
              if (pos === -1) break;
              var prop = chain.slice(0, pos);
              me = me[prop]; it = it[prop];
              chain = chain.slice(pos + 1);
            }
            it[chain] = me[chain];
          } else {
            Object.defineProperty(elem, 'contentWindow', { value: self });
          }
        } catch (e) {}
      });
      return r;
    });
  }

  // ── removeAttr (ra) ────────────────────────────────────────────
  // Removes one or more attributes from elements matching a selector.
  // rawToken: '|'-separated attribute names. rawSelector: optional CSS
  // selector (defaults to '[attr]' per token). behavior: space-separated
  // tokens — 'asap' (skip the idle-callback delay) and 'stay' (keep
  // removing on future DOM mutations instead of running once).
  function removeAttr(rawToken, rawSelector, behavior) {
    if (!rawToken) return;
    var tokens = rawToken.split(/\s*\|\s*/).filter(Boolean);
    if (!tokens.length) return;
    var selector = tokens.map(function (a) { return (rawSelector || '') + '[' + a + ']'; }).join(',');
    var stay = /\bstay\b/.test(behavior || '');
    function rmattr() {
      try {
        var nodes = document.querySelectorAll(selector);
        for (var i = 0; i < nodes.length; i++) {
          for (var j = 0; j < tokens.length; j++) {
            if (nodes[i].hasAttribute(tokens[j])) nodes[i].removeAttribute(tokens[j]);
          }
        }
      } catch (e) {}
    }
    function start() {
      rmattr();
      if (!stay) return;
      try {
        var obs = new MutationObserver(function () { rmattr(); });
        obs.observe(document, { attributes: true, attributeFilter: tokens, childList: true, subtree: true });
      } catch (e) {}
    }
    _onHtmlEl(start);
  }

  // ── removeNodeText (rmnt) / replaceNodeText (rpnt, TRUSTED) ──────
  // Shared engine: watches for nodes whose tag name matches `nodeName`
  // (existing + future, via MutationObserver) and rewrites their text
  // content. rmnt always replaces with '' (removal); rpnt (trusted) takes
  // an explicit replacement and an optional 4th arg 'includes=X excludes=Y
  // stay=1' extra-token string (sedCount/quitAfter tokens are not supported
  // here).
  function _replaceNodeTextFn(nodeName, pattern, replacement, extra) {
    if (!nodeName) return;
    var reNode = _toRegex(nodeName);
    var rePattern = pattern ? _toRegex(pattern) : null;
    var reIncludes = null, reExcludes = null, stay = false;
    if (extra) {
      var mi = /includes=(\S+)/.exec(extra); if (mi) reIncludes = _toRegex(mi[1]);
      var me = /excludes=(\S+)/.exec(extra); if (me) reExcludes = _toRegex(me[1]);
      stay = /\bstay\b/.test(extra);
    }
    function handle(node) {
      // node.nodeName is always UPPERCASE for standard HTML elements, but
      // rule authors commonly write tag names lowercase — try both.
      if (!node || (!reNode.test(node.nodeName) && !reNode.test(node.nodeName.toLowerCase()))) return;
      var before = node.textContent;
      if (!before) return;
      if (reIncludes && !reIncludes.test(before)) return;
      if (reExcludes && reExcludes.test(before)) return;
      if (rePattern && !rePattern.test(before)) return;
      var after = rePattern ? before.replace(rePattern, replacement || '') : (replacement || '');
      if (after === before) return;
      node.textContent = after;
    }
    function scan(root) {
      if (!root) return;
      if (root.nodeType === 1 || root.nodeType === 3) handle(root);
      if (root.querySelectorAll) {
        try { root.querySelectorAll('*').forEach(handle); } catch (e) {}
      }
    }
    function start() {
      scan(document.documentElement);
      try {
        var obs = new MutationObserver(function (muts) {
          for (var i = 0; i < muts.length; i++) {
            for (var j = 0; j < muts[i].addedNodes.length; j++) scan(muts[i].addedNodes[j]);
          }
        });
        obs.observe(document.documentElement || document, { childList: true, subtree: true, characterData: true });
        if (!stay) setTimeout(function () { try { obs.disconnect(); } catch (e) {} }, 10000);
      } catch (e) {}
    }
    _onHtmlEl(start);
  }
  function removeNodeText(nodeName, includes) {
    _replaceNodeTextFn(nodeName, includes || '', '', includes ? 'includes=' + includes : '');
  }
  function replaceNodeText(nodeName, pattern, replacement, extra) {
    _replaceNodeTextFn(nodeName, pattern, replacement, extra);
  }

  // ── trustedReplaceScriptText (TRUSTED) ────────────────────────────
  // replace_node_text is MutationObserver-based: it fires AFTER a node is
  // already in the DOM, which is too late for a synchronous inline <script>
  // — it runs the instant the parser/JS inserts it, before any observer
  // callback can get to it. This hooks the 4 common programmatic insertion
  // points directly (via proxyApplyFn, same primitive trustedPreventDomBypass
  // uses) and rewrites a matching node's source BEFORE the native call runs,
  // so the page's own script text never executes unmodified. Only catches
  // JS-inserted nodes (appendChild/insertBefore/insertAdjacentElement/
  // append) — nodes written directly into parsed HTML are unaffected.
  // 2026-08-14: tried adding a synchronous initial-scan pass over existing
  // nodes (mirroring uBO's real replaceNodeTextFn) to also catch nodes
  // already in parsed HTML — REVERTED same day. It rewrote a real YouTube
  // script (976 chars, matched the `serverContract` pattern) that turned out
  // to be load-bearing, not the intended target — most videos broke with
  // "This content isn't available" immediately after. Whatever the real
  // `serverContract` target is, it's apparently either not this node or not
  // present as parsed HTML in a form safe to whole-node-overwrite this way.
  // Do not re-add an initial-scan pass here without first confirming, on a
  // live page, exactly which node matches and that overwriting it is safe.
  function trustedReplaceScriptText(nodeName, pattern, replacement, extra) {
    if (!nodeName) return;
    var reNode = _toRegex(nodeName);
    var rePattern = pattern ? _toRegex(pattern) : null;
    var reIncludes = null, reExcludes = null;
    if (extra) {
      var mi = /includes=(\S+)/.exec(extra); if (mi) reIncludes = _toRegex(mi[1]);
      var me = /excludes=(\S+)/.exec(extra); if (me) reExcludes = _toRegex(me[1]);
    }
    function tryRewrite(node) {
      // node.nodeName is always UPPERCASE for standard HTML elements, but
      // rule authors commonly write tag names lowercase — try both.
      if (!node || node.nodeType !== 1) return;
      if (!reNode.test(node.nodeName) && !reNode.test(node.nodeName.toLowerCase())) return;
      var before = node.textContent;
      if (!before) return;
      if (reIncludes && !reIncludes.test(before)) return;
      if (reExcludes && reExcludes.test(before)) return;
      // pattern is an IDENTIFYING test ("is this the target script"), not a
      // substring to cut out — replacement is a complete standalone script,
      // so the WHOLE node text is swapped, not just the matched substring.
      // A partial substring .replace() would leave the rest of the
      // original script appended after our (already-complete) replacement,
      // producing invalid JS that throws instead of running either one.
      if (rePattern && !rePattern.test(before)) return;
      var after = replacement || '';
      if (after === before) return;
      try { node.textContent = after; } catch (e) {}
    }
    function hookInsertMethod(methodPath) {
      proxyApplyFn(methodPath, function (context) {
        try {
          var args = context.callArgs;
          for (var i = 0; i < args.length; i++) {
            if (args[i] instanceof Node) tryRewrite(args[i]);
          }
        } catch (e) {}
        return context.reflect();
      });
    }
    ['Node.prototype.appendChild', 'Node.prototype.insertBefore',
     'Element.prototype.insertAdjacentElement', 'Element.prototype.append']
      .forEach(hookInsertMethod);
  }

  // ── ssapUnplayableRetry (TRUSTED) ───────────────────────────────────
  // YouTube's "ad blockers violate the Terms of Service" wall shows up as
  // playabilityStatus.errorScreen.enforcementMessageViewModel, identified
  // via the internal (locale-independent) command name
  // 'openAdAllowlistInstructionCommand' — an older format
  // (playerErrorMessageRenderer/playerInterstitialRenderer, identified by
  // a support-article URL) is also checked as a fallback. It's decided
  // per-request from signals in the /player request body (see
  // trusted_edit_request's clientScreen/params/lactMilliseconds/
  // adPlaybackContext spoofs), so retrying the SAME video under a
  // different spoofed identity — cycling through `tokens`, encoded into
  // ytcfg's userAgent so the request-body editor above can see which
  // spoof is currently active — can get past it.
  // Runs directly as a page script instead of going through
  // trustedReplaceScriptText: it only needs `movie_player`/`ytcfg.data_`,
  // both of which already exist on youtube.com, so there's no real
  // YouTube script to find-and-replace here.
  function ssapUnplayableRetry(tokens) {
    // typeof-guard (not just ?.): ytInitialData is a bare global YouTube's
    // own inline script declares — referencing the identifier at all before
    // that script has run throws ReferenceError regardless of ?., since
    // optional chaining only guards against null/undefined VALUES, not an
    // entirely unbound variable NAME. This was throwing on every single
    // run (caught silently by the dispatcher's try/catch) — the actual
    // reason ssapUnplayableRetry never did anything all session.
    if (
      (typeof ytInitialData !== 'undefined' && ytInitialData?.topbar?.desktopTopbarRenderer?.logo?.topbarLogoRenderer?.iconImage?.iconType === 'YOUTUBE_PREMIUM_LOGO') ||
      location.href.startsWith('https://www.youtube.com/tv#/') ||
      location.href.startsWith('https://www.youtube.com/embed/')
    ) return; // Premium/TV/embed surfaces never show this wall.

    // Read lazily (not right here) — rules apply as soon as they arrive,
    // which can race ahead of YouTube's own inline script that defines
    // ytcfg. By the time setToken is actually called (from check(), gated
    // behind _onHtmlEl below) ytcfg is reliably present.
    var baseUserAgent = null;
    // Tracks whichever token setToken was last called with — lets check()
    // tell "this request is currently spoofed" apart from "this is the
    // real, unspoofed request" (see the safety-net check below).
    var currentToken = '';
    // While a spoof token is active, also report the tab as visible —
    // YouTube's own anti-adblock escalation does the same (confirmed in a
    // competing extension's bypass code) alongside its request-shape
    // spoofs, suggesting document.visibilityState feeds the same
    // wall/anomaly heuristic this whole function is trying to get past.
    // Shadowing an own accessor property on `document` (not touching
    // Document.prototype) is reversible per-tab and never removed, only
    // ever redefined — same idiom "restore" uses when going back to real.
    var _visibilityDesc = null;
    var _spoofVisible = function () {
      if (_visibilityDesc) return;
      try {
        _visibilityDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
        if (!_visibilityDesc) return;
        var getter = _spoofToString(_visibilityDesc.get, function () { return 'visible'; });
        Object.defineProperty(document, 'visibilityState', { get: getter, configurable: true });
      } catch (e) {}
    };
    var _restoreVisible = function () {
      if (!_visibilityDesc) return;
      try { Object.defineProperty(document, 'visibilityState', _visibilityDesc); } catch (e) {}
      _visibilityDesc = null;
    };
    var setToken = function (token) {
      currentToken = token || '';
      if (currentToken) _spoofVisible(); else _restoreVisible();
      if (baseUserAgent === null) baseUserAgent = ytcfg?.data_?.INNERTUBE_CONTEXT?.client?.userAgent || '';
      ytcfg.data_.INNERTUBE_CONTEXT.client.userAgent = token
        ? baseUserAgent.replace?.(/(Mozilla\/5\.0 \([^)]+)/, '$1; ' + token)
        : baseUserAgent;
    };
    var remaining = tokens;
    var readyToReload = false;
    // Guards against burning through every token in one burst: the
    // MutationObserver below fires check() many times per second, and
    // loadVideoById() doesn't update getPlayerResponse() synchronously — the
    // OLD (already-handled) errorScreen is still what's read on the next
    // several calls, before the new request resolves. A plain cooldown
    // (not a content-equality check) guards this: YouTube's feedbackToken/
    // trackingParams turned out NOT to be unique per response — a fresh
    // rejection can read back byte-identical to the previous one, which
    // made an earlier content-diff version of this guard permanently stop
    // retrying after the first attempt.
    var RETRY_COOLDOWN_MS = 1500;
    var lastAttemptAt = 0;

    // Shared by both "wall detected" and the safety-net below: give up on
    // the current token and either move to the next one, or — once
    // they're exhausted — settle on the real, unspoofed identity.
    function advanceToken(player, videoId, startSeconds) {
      if (Date.now() - lastAttemptAt < RETRY_COOLDOWN_MS) return;
      lastAttemptAt = Date.now();
      // Slice BEFORE picking — matches uBO's real serverContract (verified
      // live 2026-08-14: uBO's own advance step does n=n.slice(1) THEN
      // reads n[0], so its first-ever attempt already skips straight to
      // the 2nd token). An earlier "pick before slicing" version here tried
      // the 1st token (adunit) every single cycle first — live-observed on
      // this account, adunit always fails and lactmilli (2nd) is what
      // actually clears the wall, so that ordering wasted one full
      // request/response round-trip (and the visible error-screen flash)
      // on every retry cycle for nothing.
      remaining = remaining.slice(1);
      var nextToken = remaining.length > 0 ? remaining[0] : '';
      setToken(nextToken);
      readyToReload = false;
      player.loadVideoById(videoId, startSeconds);
    }

    function check() {
      var player = document.getElementById('movie_player');
      if (!player || !window.location.href.includes('/watch?')) { remaining = tokens; return; }
      var response = player.getPlayerResponse?.();
      var progress = player.getProgressState?.();
      var stats = player.getStatsForNerds?.();
      var stillPlaying = (progress && progress.duration > 0 && (progress.loaded < progress.duration || progress.duration - progress.current > 1)) || response?.videoDetails?.isLive;
      var videoId = response?.videoDetails?.videoId;
      var startSeconds = response?.playerConfig?.playbackStartConfig?.startSeconds ?? 0;
      var isBuffering = player.getPlayerStateObject?.()?.isBuffering;
      var status = response?.playabilityStatus?.status;
      var errorScreen = response?.playabilityStatus?.errorScreen;
      var errorScreenText = JSON.stringify(errorScreen) || '';
      var oldStyleText = JSON.stringify(
        errorScreen?.playerErrorMessageRenderer?.subreason?.runs ||
        errorScreen?.playerInterstitialRenderer?.content?.interstitialViewModel?.description?.commandRuns
      ) || '';
      var isAdblockWall =
        errorScreenText.includes('openAdAllowlistInstructionCommand') ||
        (oldStyleText.includes('WEB_PAGE_TYPE_UNKNOWN') && oldStyleText.includes('https://support.google.com/youtube/answer/3037019'));
      // isAdblockWall is checked BEFORE the stillPlaying gate on purpose —
      // getProgressState() reports no real progress while the wall is up
      // (nothing is loading), so gating this on stillPlaying meant the wall
      // could never be detected in the first place. stillPlaying still
      // gates the buffering-stall heuristic below, where it's meaningful.
      if (isAdblockWall) { advanceToken(player, videoId, startSeconds); return; }
      // Safety net: a spoofed identity can itself cause a real, unrelated
      // playback failure for some videos (confirmed live: clientScreen:
      // "CHANNEL" tripping a genuine "content isn't available" on a video
      // that plays fine unspoofed) — not the ad-block wall, so isAdblockWall
      // above is false, but still an error, and only while OUR spoof is
      // active (currentToken set). Treat it the same as a rejected token —
      // move on rather than get stuck on a failure we caused ourselves.
      // Once currentToken is back to '' (real identity), whatever status
      // shows is genuine and this must NOT re-trigger, or it would loop
      // forever on a real "video unavailable".
      if (currentToken && status && status !== 'OK') { advanceToken(player, videoId, startSeconds); return; }
      if (!stillPlaying) return;
      if (stats?.debug_info?.startsWith?.('SSAP, AD')) return; // real ad slot — nothing to retry
      if (remaining.length === 0) {
        readyToReload = false;
        setToken('');
      } else if (isBuffering && stats?.buffer_health_seconds === '0.00 s' && stats?.resolution === '0x0' && readyToReload) {
        setToken(remaining[0]);
        readyToReload = false;
        player.loadVideoById(videoId, startSeconds);
      }
    }

    // _onHtmlEl (not a 'DOMContentLoaded' listener): rules apply
    // asynchronously, well after that event has already fired on a real
    // page load, so a listener registered here would simply never run.
    _onHtmlEl(function () {
      check();
      new MutationObserver(check).observe(document, { childList: true, subtree: true });
      // 2026-08-15: MutationObserver alone left check() dependent entirely
      // on incidental DOM churn elsewhere on the page. Live-observed: once
      // the wall's error screen finishes rendering, the page goes static
      // (nothing left to mutate) and check() simply stops being called —
      // the retry ladder gets permanently stuck on whatever token it last
      // tried (confirmed stuck on "instream" for 20+s, well past
      // RETRY_COOLDOWN_MS, with getProgressState().duration staying 0 the
      // whole time since playback never actually started). A periodic
      // fallback guarantees forward progress independent of page activity.
      setInterval(check, 1000);
    });

    // A stalled buffer plus a "snackbar" notification is the other tell
    // that the currently-spoofed identity got flagged mid-playback —
    // advance to the next token and mark ready to reload on the next
    // check() pass (driven by the MutationObserver above).
    window.Map.prototype.has = new Proxy(window.Map.prototype.has, {
      apply: function (target, thisArg, args) {
        if (args?.[0] === 'onSnackbarMessage' && !readyToReload) {
          var player = document.getElementById('movie_player');
          if (player) {
            var stats = player.getStatsForNerds?.();
            var isBuffering = player.getPlayerStateObject?.()?.isBuffering;
            var trackingUrl = player.getPlayerResponse?.()?.playbackTracking?.videostatsPlaybackUrl?.baseUrl;
            if (isBuffering && stats?.buffer_health_seconds === '0.00 s' && stats?.resolution === '0x0' && remaining.length > 0) {
              if (trackingUrl?.includes?.('reloadxhr')) remaining = remaining.slice(1);
              readyToReload = true;
            }
          }
        }
        return Reflect.apply(target, thisArg, args);
      }
    });

    // Silences YouTube's own anomaly-detection callback so it can't react
    // to the reload/spoof cycle above.
    window.Promise.prototype.then = new Proxy(window.Promise.prototype.then, {
      apply: function (target, thisArg, args) {
        var cb = args[0];
        if (typeof cb === 'function' && cb.toString().includes('onAbnormalityDetected')) args[0] = function () {};
        return Reflect.apply(target, thisArg, args);
      }
    });
  }

  // ── refreshDefuser ────────────────────────────────────────────────
  // Defuses <meta http-equiv="refresh"> redirects. delay: if given (any
  // non-empty value), stop navigation immediately; otherwise honor the
  // page's own delay (content="N;url=...") before calling window.stop().
  function refreshDefuser(delay) {
    function defuse() {
      var meta = document.querySelector('meta[http-equiv="refresh" i][content]');
      if (!meta) return;
      var content = meta.getAttribute('content') || '';
      var ms = delay ? 0 : Math.max(parseFloat(content) || 0, 0) * 500;
      if (ms === 0) window.stop();
      else setTimeout(function () { window.stop(); }, ms);
    }
    window.addEventListener('load', defuse, { capture: true, once: true });
  }

  // ── setCookie / removeCookie ───────────────────────────────────────
  function _getCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : undefined;
  }
  function setCookie(name, value) {
    if (!name) return;
    try {
      document.cookie = name + '=' + value + '; path=/';
    } catch (e) {}
  }
  function removeCookie(needle) {
    if (!needle) return;
    var reName = _toRegex(needle);
    function remove() {
      var host = location.hostname;
      document.cookie.split(';').forEach(function (part) {
        var pos = part.indexOf('=');
        if (pos === -1) return;
        var name = part.slice(0, pos).trim();
        if (!reName.test(name)) return;
        var expire = '; Max-Age=-1000; expires=Thu, 01 Jan 1970 00:00:00 GMT';
        document.cookie = name + '=' + expire;
        document.cookie = name + '=' + '; domain=' + host + expire;
        document.cookie = name + '=' + '; domain=.' + host + expire;
        document.cookie = name + '=' + '; path=/' + expire;
        document.cookie = name + '=' + '; domain=' + host + '; path=/' + expire;
        document.cookie = name + '=' + '; domain=.' + host + '; path=/' + expire;
      });
    }
    remove();
    window.addEventListener('beforeunload', remove);
  }

  // ── setLocalStorageItem ─────────────────────────────────────────────
  // Restricted to a small set of "safe" values so this can't be abused to
  // inject arbitrary attacker-chosen data — only benign flags/empty
  // containers, or $remove$ to delete keys matching `key` as a pattern.
  function setLocalStorageItem(key, value) {
    if (!key) return;
    var safeValues = ['', 'undefined', 'null', '{}', '[]', '""', 'true', 'false'];
    try {
      if (value === '$remove$') {
        var re = _toRegex(key);
        for (var i = localStorage.length - 1; i >= 0; i--) {
          var k = localStorage.key(i);
          if (k && re.test(k)) localStorage.removeItem(k);
        }
        return;
      }
      var normalized = String(value || '').toLowerCase();
      if (safeValues.indexOf(normalized) === -1 && !/^-?\d+$/.test(normalized)) return;
      localStorage.setItem(key, value === 'emptyArr' ? '[]' : value === 'emptyObj' ? '{}' : value);
    } catch (e) {}
  }

  // ── hrefSanitizer ────────────────────────────────────────────────
  // Rewrites <a> href attributes to the "real" destination found elsewhere
  // in the element, defeating click-tracking redirect wrappers. `source`
  // supports two simple modes: 'text' (use the link's own text as the URL)
  // or '[attrName]' (use that attribute's value) — no fuller transform-step
  // language is supported.
  function hrefSanitizer(selector, source) {
    if (!selector) return;
    source = source || 'text';
    function extract(elem) {
      var m = /^\[(.+)\]$/.exec(source);
      if (m) return elem.getAttribute(m[1].trim()) || '';
      if (source === 'text') return (elem.textContent || '').trim();
      return '';
    }
    function validate(text) {
      if (!text) return '';
      try { return new URL(text, document.baseURI).href; } catch (e) { return ''; }
    }
    function sanitize() {
      var elems;
      try { elems = document.querySelectorAll(selector); } catch (e) { return; }
      for (var i = 0; i < elems.length; i++) {
        var elem = elems[i];
        if (elem.localName !== 'a' || !elem.hasAttribute('href')) continue;
        var after = validate(extract(elem));
        if (!after || after === elem.getAttribute('href')) continue;
        elem.setAttribute('href', after);
      }
    }
    function start() {
      sanitize();
      try {
        var obs = new MutationObserver(function () { sanitize(); });
        obs.observe(document.documentElement || document, { childList: true, subtree: true });
      } catch (e) {}
    }
    _onHtmlEl(start);
  }

  // ── trustedReplaceFetchResponse ─────────────────────────────────────
  // fetch() counterpart to trustedReplaceXhrResponse — a fully independent
  // proxy layer (own rule list + own install guard) so it composes with
  // _installFetchResponseProxy (json_prune_fetch) without touching that
  // already-working code path.
  var _fetchReplaceRules = [];
  var _fetchReplaceProxyInstalled = false;
  function _installFetchReplaceProxy() {
    if (_fetchReplaceProxyInstalled) return;
    _fetchReplaceProxyInstalled = true;
    var safe = safeSelf();
    var applyHandler = function (target, thisArg, args) {
      var fetchPromise = Reflect.apply(target, thisArg, args);
      return fetchPromise.then(function (responseBefore) {
        if (!_scriptletsEnabled || _fetchReplaceRules.length === 0) return responseBefore;
        var props;
        var applicable = [];
        for (var i = 0; i < _fetchReplaceRules.length; i++) {
          var rule = _fetchReplaceRules[i];
          if (rule.propNeedles.size !== 0) {
            if (props === undefined) props = collateFetchArgumentsFn.apply(null, args);
            if (matchObjectPropertiesFn(rule.propNeedles, props) === undefined) continue;
          }
          applicable.push(rule);
        }
        if (!applicable.length) return responseBefore;
        var response = responseBefore.clone();
        return response.text().then(function (textBefore) {
          var textAfter = textBefore, changed = false;
          for (var j = 0; j < applicable.length; j++) {
            var after = textAfter.replace(applicable[j].re, applicable[j].replacement);
            if (after !== textAfter) { textAfter = after; changed = true; }
          }
          if (!changed) return responseBefore;
          try { window.dispatchEvent(new CustomEvent(_EVT_BLK, { detail: { url: "" } })); } catch (_e) {}
          // Same 2 leaks _installFetchResponseProxy (json_prune_fetch) already
          // closed, ported here since this is a fully separate proxy layer:
          // (1) content-length must track the replaced text's actual byte
          // length, only touched if the original response had one at all;
          // (2) a bare `new Response(...)` defaults ok/redirected/type/url to
          // values that don't match a real network response (type:'default'
          // instead of 'cors', url:'' instead of the real one) — copying them
          // from responseBefore is what makes the swap actually pass as the
          // original response instead of an obviously JS-constructed one.
          var fixedHeaders = new Headers(responseBefore.headers);
          if (fixedHeaders.has('content-length')) {
            fixedHeaders.set('content-length', String(new Blob([textAfter]).size));
          }
          var responseAfter = new Response(textAfter, {
            status: responseBefore.status,
            statusText: responseBefore.statusText,
            headers: fixedHeaders,
          });
          safe.Object_defineProperties(responseAfter, {
            ok: { value: responseBefore.ok },
            redirected: { value: responseBefore.redirected },
            type: { value: responseBefore.type },
            url: { value: responseBefore.url },
          });
          return responseAfter;
        }).catch(function () { return responseBefore; });
      }).catch(function () { return fetchPromise; });
    };
    _ensureProxyApplyFnState();
    var nativeFetch = self.fetch;
    var proxiedFetch = new Proxy(nativeFetch, { apply: applyHandler });
    proxyApplyFn.proxies.set(proxiedFetch, nativeFetch);
    self.fetch = proxiedFetch;
  }
  function trustedReplaceFetchResponse(pattern, replacement, propsToMatch) {
    if (!pattern) return;
    var re = pattern === '*' ? /[\s\S]*/ : _toRegex(pattern);
    _fetchReplaceRules.push({
      re: re,
      replacement: replacement || '',
      propNeedles: parsePropertiesToMatchFn(propsToMatch || '', 'url'),
    });
    _installFetchReplaceProxy();
  }

  // ── trustedReplaceArgument ───────────────────────────────────────────
  // Replaces one argument of a proxied method/function call. argposRaw:
  // zero-based index (negative = from the end). argraw: literal value, or
  // 'repl:/pattern/replacement/' to regex-replace within the existing
  // stringified argument instead of substituting it outright. The
  // upstream 'condition' extra-token (gate the replacement on another
  // arg's content) is not ported — this always replaces unconditionally.
  function trustedReplaceArgument(propChain, argposRaw, argraw) {
    if (!propChain) return;
    var argpos = parseInt(argposRaw, 10);
    if (isNaN(argpos)) return;
    proxyApplyFn(propChain, function (context) {
      var args = context.callArgs.slice();
      var pos = argpos < 0 ? args.length + argpos : argpos;
      if (pos >= 0 && pos < args.length) {
        var m = /^repl:\/((?:\\.|[^\/])*)\/((?:\\.|[^\/])*)\/$/.exec(argraw || '');
        if (m) {
          try { args[pos] = String(args[pos]).replace(new RegExp(m[1], 'g'), m[2]); } catch (e) {}
        } else {
          args[pos] = argraw;
        }
      }
      context.callArgs = args;
      return context.reflect();
    });
  }

  // ── trustedReplaceOutboundText ─────────────────────────────────────
  // Regex-replaces a substring in whatever a named function RETURNS —
  // e.g. propChain "JSON.stringify" rewrites every JSON.stringify() call
  // site-wide, regardless of which request (if any) the result later feeds
  // into. Unlike trusted_edit_request (JSONPath, scoped to matching request
  // URLs via propsToMatch), this is a blunt, unconditional text substitution
  // with no URL scoping at all — only use for a pattern specific enough
  // that false positives elsewhere on the page are implausible.
  function trustedReplaceOutboundText(propChain, rawPattern, rawReplacement) {
    if (!propChain) return;
    var rePattern = rawPattern ? _toRegex(rawPattern) : null;
    proxyApplyFn(propChain, function (context) {
      var before = context.reflect();
      if (!_scriptletsEnabled || !rePattern || typeof before !== 'string') return before;
      return before.replace(rePattern, rawReplacement || '');
    });
  }

  // ── trustedPreventFetch ──────────────────────────────────────────────
  // Same as preventFetch, but with trusted=true so an unrecognized
  // `directive` token is used verbatim as the literal response body
  // instead of being rejected (generateContentFn already implements this
  // distinction — see its final `if (trusted) return directive;`).
  function trustedPreventFetch(propsToMatch, directive) {
    preventFetchFn(true, propsToMatch || '', directive || '', '');
  }

  // ── Scriptlet rule engine ────────────────────────────────────────
  // Applies rules declared in site-rules.txt via content.js bridge.
  // fetch/XHR/JSON.parse wrappers are installed once at document_start
  // (install block below); this function only fills their rule registries.
  // Each dispatch carries the FULL current rule set (global + site), so
  // registries use replace semantics — re-dispatching after an unpause or
  // RULES_CHANGED must not stack duplicate rules or proxy layers.

  // Dedup for scriptlets that still wrap an API per call (prevent_xhr,
  // prevent_dom_bypass, prevent_fetch, abort_*, …) — re-dispatching the
  // same rule must not add layers.
  var _appliedWrapOnce = new Set();

  function _wrapOnce(key, value, fn) {
    var id = key + ' ' + value;
    if (_appliedWrapOnce.has(id)) return;
    _appliedWrapOnce.add(id);
    try { fn(); } catch (e) {}
  }

  // Iterate the truthy entries of a rule-value array.
  function _eachRule(list, fn) {
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      if (list[i]) fn(list[i]);
    }
  }

  // Multi-arg scriptlet values use ", " between arguments — '|' is
  // already the loader's value separator and single
  // args (regex patterns, JSON paths) may contain spaces.
  // Splits on commas EXCEPT ones inside a /.../ regex span — a needle like
  // /^[\S\s]{2000,6000}$/ contains a comma that's part of the pattern, not
  // an argument separator. Toggles an "inside regex" flag on every '/'
  // seen, which is correct as long as regex spans are well-formed.
  function _argsOf(value) {
    var out = [], cur = '', inRe = false, ch;
    for (var i = 0; i < value.length; i++) {
      ch = value.charAt(i);
      if (ch === '/') { inRe = !inRe; cur += ch; continue; }
      if (ch === ',' && !inRe) { out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur.trim());
    return out;
  }

  // Like _argsOf, but stops after the first 2 top-level commas and returns
  // the remainder as one raw, untouched slice — for values whose LAST
  // argument is itself arbitrary code/JSON full of commas (e.g.
  // trusted_replace_script_text's replacement), where _argsOf's "split on
  // every comma" would shred it.
  function _splitFirst2(value) {
    var idx1 = -1, idx2 = -1, inRe = false, i, ch;
    for (i = 0; i < value.length; i++) {
      ch = value.charAt(i);
      if (ch === '/') { inRe = !inRe; continue; }
      if (ch === ',' && !inRe) {
        if (idx1 === -1) idx1 = i;
        else { idx2 = i; break; }
      }
    }
    if (idx1 === -1) return [value.trim(), '', ''];
    if (idx2 === -1) return [value.slice(0, idx1).trim(), value.slice(idx1 + 1).trim(), ''];
    return [value.slice(0, idx1).trim(), value.slice(idx1 + 1, idx2).trim(), value.slice(idx2 + 1).trim()];
  }

  // Like _argsOf, but splits on only the LAST top-level comma — for 2-arg
  // values whose FIRST argument is complex (e.g. a JSONPath query with a
  // JSON object/array literal as its assigned value, full of commas) and
  // whose second argument (propsToMatch) is always simple/comma-free.
  function _splitLast(value) {
    var lastIdx = -1, inRe = false, i, ch;
    for (i = 0; i < value.length; i++) {
      ch = value.charAt(i);
      if (ch === '/') { inRe = !inRe; continue; }
      if (ch === ',' && !inRe) lastIdx = i;
    }
    if (lastIdx === -1) return [value.trim(), ''];
    return [value.slice(0, lastIdx).trim(), value.slice(lastIdx + 1).trim()];
  }

  // Flag-style keys: any first value other than 0/false/off enables.
  function _flagOn(list) {
    if (!list || !list.length) return false;
    var v = String(list[0]).toLowerCase();
    return v !== '' && v !== '0' && v !== 'false' && v !== 'off';
  }

  function _applyScriptletRules(rules) {
    if (!rules) return;
    // Cache the full rule set for the NEXT page load so the install gate
    // below can apply it synchronously at document_start.
    _saveScriptletRulesCache(rules);
    _fetchPruneRules.length = 0;
    _xhrPruneRules.length = 0;
    _xhrJsonlRules.length = 0;
    _xhrReplaceRules.length = 0;
    _fetchReplaceRules.length = 0;
    _jsonEditRules.length = 0;
    _jsonPruneRules.length = 0;
    _noWinOpenRules.length = 0;
    _editRequestRules.length = 0;
    _editResponseRules.length = 0;
    var pruneF  = rules.json_prune_fetch          || [];
    var pruneX  = rules.json_prune_xhr            || [];
    var setC    = rules.set_constant              || [];
    var noWin   = rules.no_window_open_if         || [];
    var prevX   = rules.prevent_xhr               || [];

    // json_prune_fetch/xhr = prunePaths[, needlePaths, propsToMatch, urlPattern]
    // Comma-free values (the historical/common case, every non-YouTube
    // section) hit jsonPruneFetchResponse/jsonPruneXhrResponse with a single
    // arg exactly as before — fully backward compatible. A comma opts into
    // URL-scoping the prune to matching requests only (both functions
    // already supported this via getExtraArgs()/propsToMatch, just never
    // had a caller that passed it).
    for (var i = 0; i < pruneF.length; i++) {
      if (!pruneF[i]) continue;
      var pfArgs = _argsOf(pruneF[i]);
      if (pfArgs.length > 1) jsonPruneFetchResponse(pfArgs[0] || '', pfArgs[1] || '', 'propsToMatch', pfArgs[2] || '');
      else jsonPruneFetchResponse(pruneF[i]);
    }
    for (var j = 0; j < pruneX.length; j++) {
      if (!pruneX[j]) continue;
      var pxArgs = _argsOf(pruneX[j]);
      if (pxArgs.length > 1) jsonPruneXhrResponse(pxArgs[0] || '', pxArgs[1] || '', 'propsToMatch', pxArgs[2] || '');
      else jsonPruneXhrResponse(pruneX[j]);
    }
    for (var k = 0; k < setC.length; k++) {
      var parts = setC[k].split(/\s+/);
      if (parts.length >= 2) {
        try { setConstant(parts[0], parts[1]); } catch (e) { /* already defined — skip */ }
      }
    }
    for (var m = 0; m < noWin.length; m++) {
      if (noWin[m] == null) continue;
      // Format: "pattern [delay [decoy]]" — split on first 2 spaces only
      // so regex patterns like /foo bar/ are preserved intact.
      var nwParts = noWin[m].match(/^(\S+)(?:\s+(\S+)(?:\s+(\S+))?)?$/);
      if (nwParts) noWindowOpenIf(nwParts[1] || '', nwParts[2] || '', nwParts[3] || '');
      else noWindowOpenIf(noWin[m], 0, 'blank'); // fallback if format is wrong — block all matching window.open
    }
    for (var n = 0; n < prevX.length; n++) {
      if (!prevX[n] || _appliedWrapOnce.has('prevent_xhr ' + prevX[n])) continue;
      _appliedWrapOnce.add('prevent_xhr ' + prevX[n]);
      preventXhr(prevX[n]);
    }
    var jsonEd = rules.json_edit || [];
    for (var p = 0; p < jsonEd.length; p++) {
      if (jsonEd[p]) jsonEdit(jsonEd[p]);
    }
    var jsonlXhr = rules.jsonl_edit_xhr || [];
    for (var q = 0; q < jsonlXhr.length; q++) {
      if (!jsonlXhr[q]) continue;
      var spaceIdx = jsonlXhr[q].indexOf(' ');
      var jq = spaceIdx >= 0 ? jsonlXhr[q].slice(0, spaceIdx) : jsonlXhr[q];
      var urlPat = spaceIdx >= 0 ? jsonlXhr[q].slice(spaceIdx + 1) : '';
      jsonlEditXhrResponse(jq, urlPat);
    }

    var prevDomBypass = rules.prevent_dom_bypass || [];
    for (var s = 0; s < prevDomBypass.length; s++) {
      if (!prevDomBypass[s] || _appliedWrapOnce.has('prevent_dom_bypass ' + prevDomBypass[s])) continue;
      _appliedWrapOnce.add('prevent_dom_bypass ' + prevDomBypass[s]);
      var dbParts = prevDomBypass[s].trim().split(/\s+/);
      trustedPreventDomBypass(dbParts[0] || '', dbParts[1] || '');
    }

    // ── json_prune_on_set — reapplied every dispatch (idempotent via
    // configurable:false + try/catch), same idiom as set_constant above.
    _eachRule(rules.json_prune_on_set, function (v) {
      var a = _argsOf(v);
      try { jsonPruneOnSet(a[0] || '', a[1] || '', a[2] || ''); } catch (e) {}
    });

    // ── trusted_edit_request / trusted_edit_response — registry-based,
    // reset+repopulated every dispatch (see resets at the top of this fn).
    // _splitLast (not _argsOf): the JSONPath query is arg 1 and can itself
    // contain commas (assigning a JSON object/array literal); propsToMatch
    // is always the last, comma-free argument.
    _eachRule(rules.trusted_edit_request, function (v) {
      var a = _splitLast(v);
      trustedEditRequest(a[0] || '', a[1] || '');
    });
    _eachRule(rules.trusted_edit_response, function (v) {
      var a = _splitLast(v);
      trustedEditResponse(a[0] || '', a[1] || '');
    });

    // ── trusted_replace_script_text — wrap-once (proxyApplyFn installs a
    // permanent hook per call; re-dispatching the same rule must not stack).
    // Value: "nodeName, pattern, replacement" — only the first 2 commas are
    // split on (_splitFirst2), since replacement is arbitrary code that can
    // itself contain any number of commas.
    _eachRule(rules.trusted_replace_script_text, function (v) {
      _wrapOnce('trusted_replace_script_text', v, function () {
        var a = _splitFirst2(v);
        trustedReplaceScriptText(a[0] || '', a[1] || '', a[2] || '', '');
      });
    });

    // ── adblock_wall_retry — see ssapUnplayableRetry's header comment for
    // why this runs directly instead of through trusted_replace_script_text.
    // Value: pipe-separated userAgent tokens, tried in order (each one also
    // needs a matching trusted_edit_request clause to actually change the
    // outgoing /player request — a token with no such clause is a no-op
    // spoof, but still gets the referer's #reloadxhr suffix for free).
    var wallRetryTokens = rules.adblock_wall_retry || [];
    if (wallRetryTokens.length) {
      _wrapOnce('adblock_wall_retry', wallRetryTokens.join(','), function () {
        try { ssapUnplayableRetry(wallRetryTokens.slice()); } catch (e) {}
      });
    }

    // ── jspb_response_prune — flag-style, wrap-once (installs a permanent
    // Promise.prototype.then hook; see installJspbPlayerResponsePrune's
    // header comment for what it catches that json_prune_fetch/xhr can't).
    if (_flagOn(rules.jspb_response_prune)) {
      _wrapOnce('jspb_response_prune', '1', function () {
        try { installJspbPlayerResponsePrune(); } catch (e) {}
      });
    }

    // ── json_prune — registry-based (replace semantics, like json_edit) ──
    // Value: "prunePaths[, needlePaths]" — each a space-separated path list.
    _eachRule(rules.json_prune, function (v) {
      var a = _argsOf(v);
      jsonPrune(a[0] || '', a[1] || '');
    });

    // ── trusted_replace_xhr_response — registry-based ────────────────
    // Value: "pattern, replacement[, propsToMatch]". Args separated by
    // ",<space>" so regex quantifiers like {2,4} survive; write a literal
    // '|' (regex alternation) as '\|' — the rules loader splits values
    // on unescaped '|'. Empty replacement: "pattern, , propsToMatch".
    _eachRule(rules.trusted_replace_xhr_response, function (v) {
      var a = v.split(/,\s/).map(function (s) { return s.trim(); });
      trustedReplaceXhrResponse(a[0] || '', a[1] || '', a.slice(2).join(', '));
    });

    // ── Wrap-once scriptlets ─────────────────────────────────────────
    // prevent_fetch = propsToMatch[, responseBody[, responseType]]
    _eachRule(rules.prevent_fetch, function (v) {
      _wrapOnce('prevent_fetch', v, function () {
        var a = _argsOf(v);
        preventFetch(a[0] || '', a[1] || '', a[2] || '');
      });
    });
    // prevent_settimeout / prevent_setinterval = pattern[, delay]
    // _splitLast (not _argsOf): pattern is an arbitrary callback-source
    // match that can itself contain commas (e.g. "(),a,b)"), delay is
    // always the last, comma-free argument. No comma at all → delay=''
    // (_parseDelayRange('') matches any delay) — identical to the old
    // pattern-only behavior, so every existing rule keeps working unchanged.
    _eachRule(rules.prevent_settimeout, function (v) {
      _wrapOnce('prevent_settimeout', v, function () {
        var a = _splitLast(v);
        preventSetTimeout(a[0] || '', a[1] || '');
      });
    });
    _eachRule(rules.prevent_setinterval, function (v) {
      _wrapOnce('prevent_setinterval', v, function () {
        var a = _splitLast(v);
        preventSetInterval(a[0] || '', a[1] || '');
      });
    });
    // prevent_raf = pattern ('!' prefix inverts)
    _eachRule(rules.prevent_raf, function (v) {
      _wrapOnce('prevent_raf', v, function () { preventRequestAnimationFrame(v); });
    });
    // prevent_aeld = eventType[, handlerPattern]
    var hadAeld = false;
    _eachRule(rules.prevent_aeld, function (v) {
      _wrapOnce('prevent_aeld', v, function () {
        var a = _argsOf(v);
        preventAddEventListener(a[0] || '', a[1] || '');
        hadAeld = true;
      });
    });
    // Freeze addEventListener once, AFTER all aeld proxies stacked.
    if (hadAeld && !_appliedWrapOnce.has('_protect_aeld')) {
      _appliedWrapOnce.add('_protect_aeld');
      _protectAddEventListener();
    }
    // adjust_settimeout / adjust_setinterval = needle[, delay[, boost]]
    _eachRule(rules.adjust_settimeout, function (v) {
      _wrapOnce('adjust_settimeout', v, function () {
        var a = _argsOf(v);
        adjustSetTimeout(a[0] || '', a[1] || '', a[2] || '');
      });
    });
    _eachRule(rules.adjust_setinterval, function (v) {
      _wrapOnce('adjust_setinterval', v, function () {
        var a = _argsOf(v);
        adjustSetInterval(a[0] || '', a[1] || '', a[2] || '');
      });
    });
    // abort_current_script = target[, needle[, context]]
    _eachRule(rules.abort_current_script, function (v) {
      _wrapOnce('abort_current_script', v, function () {
        var a = _argsOf(v);
        abortCurrentScript(a[0] || '', a[1] || '', a[2] || '');
      });
    });
    // abort_on_property_read / abort_on_property_write = property chain
    _eachRule(rules.abort_on_property_read, function (v) {
      _wrapOnce('abort_on_property_read', v, function () { abortOnPropertyRead(v); });
    });
    _eachRule(rules.abort_on_property_write, function (v) {
      _wrapOnce('abort_on_property_write', v, function () { abortOnPropertyWrite(v); });
    });
    // abort_on_stack_trace = chain[, stackNeedle]
    _eachRule(rules.abort_on_stack_trace, function (v) {
      _wrapOnce('abort_on_stack_trace', v, function () {
        var a = _argsOf(v);
        abortOnStackTrace(a[0] || '', a[1] || '');
      });
    });
    // no_eval_if = pattern
    _eachRule(rules.no_eval_if, function (v) {
      _wrapOnce('no_eval_if', v, function () { noEvalIf(v); });
    });
    // Flag-style: no_webrtc / prevent_bab / disable_newtab_links = 1
    if (_flagOn(rules.no_webrtc)) _wrapOnce('no_webrtc', '1', noWebrtc);
    if (_flagOn(rules.prevent_bab)) _wrapOnce('prevent_bab', '1', preventBab);
    if (_flagOn(rules.disable_newtab_links)) _wrapOnce('disable_newtab_links', '1', disableNewtabLinks);

    // remove_attr = token[, selector[, behavior]]
    _eachRule(rules.remove_attr, function (v) {
      _wrapOnce('remove_attr', v, function () {
        var a = _argsOf(v);
        removeAttr(a[0] || '', a[1] || '', a[2] || '');
      });
    });
    // remove_node_text = nodeName[, includes]
    _eachRule(rules.remove_node_text, function (v) {
      _wrapOnce('remove_node_text', v, function () {
        var a = _argsOf(v);
        removeNodeText(a[0] || '', a[1] || '');
      });
    });
    // replace_node_text = nodeName, pattern, replacement[, extra] (TRUSTED)
    _eachRule(rules.replace_node_text, function (v) {
      _wrapOnce('replace_node_text', v, function () {
        var a = _argsOf(v);
        replaceNodeText(a[0] || '', a[1] || '', a[2] || '', a[3] || '');
      });
    });
    // refresh_defuser = [delay]
    _eachRule(rules.refresh_defuser, function (v) {
      _wrapOnce('refresh_defuser', v, function () { refreshDefuser(v); });
    });
    // set_cookie = name, value — direct action, no persistent install
    _eachRule(rules.set_cookie, function (v) {
      var a = _argsOf(v);
      setCookie(a[0] || '', a[1] || '');
    });
    // remove_cookie = namePattern
    _eachRule(rules.remove_cookie, function (v) {
      _wrapOnce('remove_cookie', v, function () { removeCookie(v); });
    });
    // set_local_storage_item = key, value — direct action
    _eachRule(rules.set_local_storage_item, function (v) {
      var a = _argsOf(v);
      setLocalStorageItem(a[0] || '', a[1] || '');
    });
    // href_sanitizer = selector[, source]
    _eachRule(rules.href_sanitizer, function (v) {
      _wrapOnce('href_sanitizer', v, function () {
        var a = _argsOf(v);
        hrefSanitizer(a[0] || '', a[1] || '');
      });
    });
    // trusted_replace_fetch_response = pattern, replacement[, propsToMatch] (TRUSTED)
    // Registry-based like trusted_replace_xhr_response — _fetchReplaceRules
    // was already reset above, so this rebuilds it fresh every dispatch.
    _eachRule(rules.trusted_replace_fetch_response, function (v) {
      var a = v.split(/,\s/).map(function (s) { return s.trim(); });
      trustedReplaceFetchResponse(a[0] || '', a[1] || '', a.slice(2).join(', '));
    });
    // trusted_replace_argument = propChain, argpos, argraw (TRUSTED)
    _eachRule(rules.trusted_replace_argument, function (v) {
      _wrapOnce('trusted_replace_argument', v, function () {
        var a = _argsOf(v);
        trustedReplaceArgument(a[0] || '', a[1] || '', a.slice(2).join(', '));
      });
    });
    // trusted_replace_outbound_text = propChain, pattern, replacement (TRUSTED)
    // _splitFirst2 (not _argsOf): replacement is arbitrary text that can
    // itself contain commas with no following space (e.g. JSON `},"k":`),
    // which _argsOf's plain comma-split + ', '-rejoin would corrupt by
    // inserting a space that was never there.
    _eachRule(rules.trusted_replace_outbound_text, function (v) {
      _wrapOnce('trusted_replace_outbound_text', v, function () {
        var a = _splitFirst2(v);
        trustedReplaceOutboundText(a[0] || '', a[1] || '', a[2] || '');
      });
    });
    // trusted_prevent_fetch = propsToMatch[, directive] (TRUSTED)
    _eachRule(rules.trusted_prevent_fetch, function (v) {
      _wrapOnce('trusted_prevent_fetch', v, function () {
        var a = _argsOf(v);
        trustedPreventFetch(a[0] || '', a[1] || '');
      });
    });
  }

  // ── Install response-filtering wrappers at document_start ────────
  // The wrappers AND their rules must exist BEFORE any page script runs to
  // close the boot race, but the site's config only arrives async. Bridge:
  // every rules dispatch caches the full scriptlet rule set in localStorage
  // (only on sites whose rules contain response-filter keys — json_prune_* /
  // json_edit / jsonl_edit_xhr). On the next load the cache is read
  // synchronously here, the wrappers install and the rules apply
  // immediately — set_constant/json_edit run before the page's inline
  // scripts, and the registries are live for its very first requests. The
  // async dispatch then re-applies fresh rules (replace semantics), so a
  // stale cache self-corrects on every load.
  // Sites without the cache keep fetch/XHR/JSON.parse completely untouched:
  // no extension frame in stack traces, no per-request overhead. If
  // response-filter rules arrive anyway (very first visit, rules update),
  // the registration functions install the wrappers lazily mid-session.
  var _RULES_CACHE_KEY = '__' + _qkv1Token + '_rules_cache__';
  // _qkv1Token is a fresh random value baked in by every single build (see
  // substitute_qkv1_token in _build-lib.sh) — each rebuild/update therefore
  // mints a brand new cache key, and nothing before this ever cleaned up the
  // PREVIOUS token's entry, so every prior build/version's cache accumulates
  // forever in this origin's localStorage. One-time sweep at boot: any key
  // matching our fixed __..._rules_cache__ wrapper that isn't this build's
  // own key is necessarily a stale one from a past token — safe to drop.
  try {
    for (var _si = localStorage.length - 1; _si >= 0; _si--) {
      var _sk = localStorage.key(_si);
      if (_sk && _sk !== _RULES_CACHE_KEY && _sk.slice(0, 2) === '__' && _sk.slice(-14) === '_rules_cache__') {
        localStorage.removeItem(_sk);
      }
    }
  } catch (e) {}
  var _RESPONSE_FILTER_RULE_KEYS = ['json_prune_fetch', 'json_prune_xhr', 'jsonl_edit_xhr', 'json_edit', 'json_prune', 'trusted_replace_xhr_response', 'trusted_replace_fetch_response', 'jspb_response_prune', 'no_window_open_if', 'trusted_edit_request', 'trusted_edit_response'];

  function _saveScriptletRulesCache(rules) {
    var has = false;
    for (var i = 0; i < _RESPONSE_FILTER_RULE_KEYS.length; i++) {
      var v = rules[_RESPONSE_FILTER_RULE_KEYS[i]];
      if (v && v.length) { has = true; break; }
    }
    // Only sites with response-filter rules ever get the key written;
    // removeItem on all others is a no-op that leaves no trace.
    try {
      if (has) localStorage.setItem(_RULES_CACHE_KEY, JSON.stringify(rules));
      else localStorage.removeItem(_RULES_CACHE_KEY);
    } catch (e) { /* sandboxed frame / storage blocked — lazy install still applies */ }
  }

  (function () {
    var cached = null;
    try { cached = localStorage.getItem(_RULES_CACHE_KEY); } catch (e) {}
    if (!cached) return;
    try { _installFetchResponseProxy(); } catch (e) {}
    try { _installXhrResponseProxy(); } catch (e) {}
    try { _installJsonEditProxy(); } catch (e) {}
    try { _installSjsGuard(); } catch (e) {}
    try {
      var rules = JSON.parse(cached);
      // The cache lives in page-writable storage, so treat it as untrusted
      // input: anything non-object is ignored. A page corrupting it can only
      // affect its own MAIN world — same privilege it already has.
      if (rules && typeof rules === 'object') _applyScriptletRules(rules);
    } catch (e) { /* corrupt cache — wrappers stay pass-through until dispatch */ }
  })();

  // Bridge: content.js dispatches '<token>_rules__' after async rule load.
  // Content script and MAIN world share DOM events — standard cross-world pattern.
  window.addEventListener(_EVT_RULES, function(ev) {
    _scriptletsEnabled = true;
    try { _applyScriptletRules(ev.detail); } catch (e) {}
  });

  // Bridge: "Reset all data" in the dashboard only clears chrome.storage.local
  // (extension storage) — it has no reach into this page's own localStorage,
  // where the rules cache actually lives. content.js relays this event after
  // the dashboard broadcasts CLEAR_SCRIPTLET_CACHE to every open tab.
  window.addEventListener(_EVT_CLR, function() {
    try { localStorage.removeItem(_RULES_CACHE_KEY); } catch (e) {}
  });

  // When protection is toggled OFF or domain paused, disable all scriptlet logic.
  window.addEventListener(_EVT_DIS, function() {
    _scriptletsEnabled = false;
    _noWinOpenRules.length = 0;
  });

  const original = EventTarget.prototype.addEventListener;

  EventTarget.prototype.addEventListener = function(type, listener, options) {
    if (_scriptletsEnabled && (type === "unload" || type === "beforeunload")) {
      console.debug("[Blocked]", type);
      return;
    }
    return Reflect.apply(original, this, [type, listener, options]);
  };
  const desc = Object.getOwnPropertyDescriptor(Window.prototype, "onunload");

  Object.defineProperty(window, "onunload", {
    configurable: true,
    enumerable: true,
    get() {
      return desc?.get?.call(this);
    },
    set(fn) {
      if (!_scriptletsEnabled) { desc?.set?.call(this, fn); return; }
      console.debug("Blocked onunload");
      // Callback is not stored
    }
  });
  const remove = EventTarget.prototype.removeEventListener;

  EventTarget.prototype.removeEventListener = function(type, listener, options) {
    if (_scriptletsEnabled && (type === "unload" || type === "beforeunload")) {
      return;
    }
    return Reflect.apply(remove, this, [type, listener, options]);
  };
}());
