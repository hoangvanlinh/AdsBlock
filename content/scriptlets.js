// content/scriptlets.js — Core ad-blocking scriptlets (MAIN world)
// Functions: setConstant, abortCurrentScript, abortOnPropertyRead,
//            abortOnStackTrace, preventFetch, preventXhr,
//            jsonPruneFetchResponse, jsonPruneXhrResponse,
//            noWindowOpenIf, preventAddEventListener, disableNewtabLinks,
//            stripDynamicTargets, rateLimitHistory, blockAdNavigations
// Injected at document_start into MAIN world by content.js.

(function _adblock_scriptlets() {
  'use strict';

  var _G = Symbol.for('_adblock_scriptlets');
  if (window[_G]) return;
  window[_G] = 1;

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

  function setConstant(chain, raw) {
    if (!chain || !_scriptletsEnabled) return;
    var value = _parseVal(raw);
    var parts = _strSplit.call(chain, '.');
    var leaf  = parts.pop();

    function lock(obj, key) {
      var origVal = obj[key];
      try {
        Object.defineProperty(obj, key, {
          get: function () { return _scriptletsEnabled ? value : origVal; },
          set: function (v) { if (!_scriptletsEnabled) origVal = v; },
          configurable: false, enumerable: true
        });
      } catch (e) { try { obj[key] = value; } catch (ee) {} }
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

    walk(window, parts);
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
    if (proxyApplyFn.CtorContext === undefined) {
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
  function _installFetchResponseProxy() {
    if (_fetchProxyInstalled) return;
    _fetchProxyInstalled = true;
    const safe = safeSelf();
    const applyHandler = function (target, thisArg, args) {
      const fetchPromise = Reflect.apply(target, thisArg, args);
      return fetchPromise.then(responseBefore => {
        if (!_scriptletsEnabled || _fetchPruneRules.length === 0) return responseBefore;
        let props;
        const applicable = [];
        for (const rule of _fetchPruneRules) {
          if (rule.propNeedles.size !== 0) {
            if (props === undefined) props = collateFetchArgumentsFn(...args);
            if (matchObjectPropertiesFn(rule.propNeedles, props) === undefined) continue;
          }
          applicable.push(rule);
        }
        if (applicable.length === 0) return responseBefore;
        const response = responseBefore.clone();
        return response.json().then(objBefore => {
          if (typeof objBefore !== 'object' || objBefore === null) return responseBefore;
          let objAfter = objBefore, pruned = false;
          for (const rule of applicable) {
            const r = objectPruneFn(objAfter, rule.prunePaths, rule.needlePaths);
            if (typeof r !== 'object' || r === null) continue;
            objAfter = r;
            pruned = true;
            try { window.dispatchEvent(new CustomEvent('__adblock_blocked__', { detail: { url: "" } })); } catch (_e) {}
          }
          if (!pruned) return responseBefore;
          const responseAfter = Response.json(objAfter, {
            status: responseBefore.status,
            statusText: responseBefore.statusText,
            headers: responseBefore.headers,
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
    self.fetch = new Proxy(self.fetch, { apply: applyHandler });
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
    _xhrProxyInstalled = true;
    const safe = safeSelf();
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
    self.XMLHttpRequest = class extends self.XMLHttpRequest {
      open(method, url, ...args) {
        // Details are always recorded — rules may arrive between open()
        // and the page reading .response.
        xhrInstances.set(this, { method, url });
        return super.open(method, url, ...args);
      }
      get response() {
        const innerResponse = super.response;
        if (!_scriptletsEnabled) return innerResponse;
        if (_xhrPruneRules.length === 0 && _xhrJsonlRules.length === 0 &&
            _xhrReplaceRules.length === 0) return innerResponse;
        const xhrDetails = xhrInstances.get(this);
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
              try { window.dispatchEvent(new CustomEvent('__adblock_blocked__', { detail: { url: "" } })); } catch (_e) {}
            }
            if (pruned) {
              result = typeof result === 'string' ? safe.JSON_stringify(objBefore) : objBefore;
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
            try { window.dispatchEvent(new CustomEvent('__adblock_blocked__', { detail: { url: "" } })); } catch (_e) {}
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
      }
      get responseText() {
        const response = this.response;
        return typeof response !== 'string' ? super.responseText : response;
      }
    };
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
      try { window.dispatchEvent(new CustomEvent('__adblock_blocked__', { detail: { url: _blockedUrl } })); } catch (_e) {}
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
      var orig = History.prototype[name];
      if (typeof orig !== 'function') return;
      History.prototype[name] = function () {
        var now = Date.now();
        if (now - _pushBucketTs >= _BUCKET_MS) {
          _pushBucket = 0;
          _pushBucketTs = now;
        }
        if (++_pushBucket > _PUSH_LIMIT) return;
        return orig.apply(this, arguments);
      };
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

    try {
      var _hrefDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
      if (_hrefDesc && _hrefDesc.set) {
        Object.defineProperty(Location.prototype, 'href', {
          get: _hrefDesc.get,
          set: function (url) {
            if (!_isSafeNavigation(url)) return;
            _hrefDesc.set.call(this, url);
          },
          configurable: true,
          enumerable: _hrefDesc.enumerable
        });
      }
    } catch (e) {}

    function _wrapLocationFn(name) {
      var orig = Location.prototype[name];
      if (typeof orig !== 'function') return;
      Location.prototype[name] = function (url) {
        if (!_isSafeNavigation(url)) return;
        return orig.apply(this, arguments);
      };
    }
    _wrapLocationFn('assign');
    _wrapLocationFn('replace');

    // window.open(url, '_self'/'_top'/'_parent') navigates the current tab
    // without touching the Location accessors patched above — the remaining
    // same-tab escape hatch for popstate/back-button redirect scripts.
    try {
      var _origOpen = window.open;
      window.open = function (url, target) {
        var t = target == null ? '' : String(target).toLowerCase();
        if ((t === '_self' || t === '_top' || t === '_parent') && !_isSafeNavigation(url)) return null;
        return _origOpen.apply(this, arguments);
      };
    } catch (e) {}
  }

  // ── preventSetTimeout ────────────────────────────────────────────
  // Proxies window.setTimeout; blocks callbacks whose source matches `pattern`.
  // Empty pattern → block ALL setTimeout calls (use sparingly).
  function preventSetTimeout(pattern) {
    var rePattern = (pattern instanceof RegExp) ? pattern : _toRegex(pattern || '');
    var _matchAll = !pattern;
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
      if (_matchAll || rePattern.test(fnStr)) {
        if (!_reported) {
          _reported = true;
          try { window.dispatchEvent(new CustomEvent('__adblock_blocked__', { detail: { url: "" } })); } catch (_e) {}
        }
        return;
      } // block
      return context.reflect();
    });
  }

  // ── preventSetInterval ───────────────────────────────────────────
  // Same as preventSetTimeout but for setInterval.
  function preventSetInterval(pattern) {
    var rePattern = (pattern instanceof RegExp) ? pattern : _toRegex(pattern || '');
    var _matchAll = !pattern;
    proxyApplyFn('setInterval', function(context) {
      if (!_scriptletsEnabled) return context.reflect();
      var fn = context.callArgs[0];
      var fnStr = '';
      try {
        if (typeof fn === 'function') fnStr = fn.toString();
        else if (typeof fn === 'string') fnStr = fn;
      } catch(e) {}
      if (_matchAll || rePattern.test(fnStr)) return; // block
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
  // JSONPath query engine. Required by json-edit.
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
        const r = this.#compile(query, 0);
        if ( r === undefined ) { return; }
        if ( r.i !== query.length ) {
            let val;
            if ( query.startsWith('=', r.i) ) {
                if ( /^=repl\(.+\)$/.test(query.slice(r.i)) ) {
                    r.modify = 'repl';
                    val = query.slice(r.i+6, -1);
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
        this.#compiled = r;
    }
    evaluate(root) {
        if ( this.valid === false ) { return []; }
        this.#root = root;
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
    #reExpr = /^([!=^$*]=|[<>]=?)(.+?)\]/;
    #reIndice = /^-?\d+/;
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
                    i = this.#compileExpr(query, step, i);
                    break;
                }
                const s = this.#consumeUnquotedIdentifier(query, i);
                if ( s === undefined ) { return; }
                steps.push({ mv, k: s });
                i += s.length;
                mv = this.#UNDEFINED;
                continue;
            }
            if ( query.startsWith('[?', i) ) {
                const not = query.charCodeAt(i+2) === 0x21 /* ! */;
                const j = i + 2 + (not ? 1 : 0);
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
                resultset = [ pathin ];
                break;
            case this.#CHILDREN:
            case this.#DESCENDANTS:
                resultset = this.#getMatches(resultset, step);
                break;
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
            if ( step.k === '*' ) {
                this.#getMatchesFromAll(pathin, step, owner, listout);
            } else if ( step.k !== undefined ) {
                this.#getMatchesFromKeys(pathin, step, owner, listout);
            } else if ( step.steps ) {
                this.#getMatchesFromExpr(pathin, step, owner, listout);
            }
        }
        return listout;
    }
    #getMatchesFromAll(pathin, step, owner, out) {
        const recursive = step.mv === this.#DESCENDANTS;
        for ( const { path } of this.#getDescendants(owner, recursive) ) {
            out.push([ ...pathin, ...path ]);
        }
    }
    #getMatchesFromKeys(pathin, step, owner, out) {
        const kk = Array.isArray(step.k) ? step.k : [ step.k ];
        for ( const k of kk ) {
            const normalized = this.#evaluateExpr(step, owner, k);
            if ( normalized === undefined ) { continue; }
            out.push([ ...pathin, normalized ]);
        }
        if ( step.mv !== this.#DESCENDANTS ) { return; }
        for ( const { obj, key, path } of this.#getDescendants(owner, true) ) {
            for ( const k of kk ) {
                const normalized = this.#evaluateExpr(step, obj[key], k);
                if ( normalized === undefined ) { continue; }
                out.push([ ...pathin, ...path, normalized ]);
            }
        }
    }
    #getMatchesFromExpr(pathin, step, owner, out) {
        const recursive = step.mv === this.#DESCENDANTS;
        if ( Array.isArray(owner) === false ) {
            const r = this.#evaluate(step.steps, pathin);
            if ( r.length !== 0 ) { out.push(pathin); }
            if ( recursive !== true ) { return; }
        }
        for ( const { obj, key, path } of this.#getDescendants(owner, recursive) ) {
            if ( Array.isArray(obj[key]) ) { continue; }
            const q = [ ...pathin, ...path ];
            const r = this.#evaluate(step.steps, q);
            if ( r.length === 0 ) { continue; }
            out.push(q);
        }
    }
    #normalizeKey(owner, key) {
        if ( typeof key === 'number' ) {
            if ( Array.isArray(owner) ) {
                return key >= 0 ? key : owner.length + key;
            }
        }
        return key;
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
                        this.stack.push({ obj: v, keys: Object.keys(v).values() });
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
            iterator.stack.push({ obj: v, keys: Object.keys(v).values() });
        }
        return iterator;
    }
    #consumeIdentifier(query, i) {
        const keys = [];
        for (;;) {
            const c0 = query.charCodeAt(i);
            if ( c0 === 0x5D /* ] */ ) { break; }
            if ( c0 === 0x2C /* , */ ) {
                i += 1;
                continue;
            }
            if ( c0 === 0x27 /* ' */ ) {
                const r = this.#untilChar(query, 0x27 /* ' */, i+1);
                if ( r === undefined ) { return; }
                keys.push(r.s);
                i = r.i;
                continue;
            }
            if ( c0 === 0x2D /* - */ || c0 >= 0x30 && c0 <= 0x39 ) {
                const match = this.#reIndice.exec(query.slice(i));
                if ( match === null ) { return; }
                const indice = parseInt(query.slice(i), 10);
                keys.push(indice);
                i += match[0].length;
                continue;
            }
            const s = this.#consumeUnquotedIdentifier(query, i);
            if ( s === undefined ) { return; }
            keys.push(s);
            i += s.length;
        }
        return { s: keys.length === 1 ? keys[0] : keys, i };
    }
    #consumeUnquotedIdentifier(query, i) {
        const match = this.#reUnquotedIdentifier.exec(query.slice(i));
        if ( match === null ) { return; }
        return match[0];
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
                step.rval = new RegExp(r.s, match && match[0] || undefined);
            } catch {
                return i;
            }
            step.op = 're';
            if ( match ) { r.i += match[0].length; }
            return r.i;
        }
        const match = this.#reExpr.exec(query.slice(i));
        if ( match === null ) { return i; }
        try {
            step.rval = JSON.parse(match[2]);
            step.op = match[1];
        } catch {
        }
        return i + match[1].length + match[2].length;
    }
    #resolvePath(path) {
        if ( path.length === 0 ) { return { value: this.#root }; }
        const key = path[path.length - 1];
        let obj = this.#root;
        for ( let i = 0, n = path.length-1; i < n; i++ ) {
            obj = obj[path[i]];
        }
        return { obj, key, value: obj[key] };
    }
    #evaluateExpr(step, owner, key) {
        if ( owner === undefined || owner === null ) { return; }
        if ( typeof key === 'number' ) {
            if ( Array.isArray(owner) === false ) { return; }
        }
        const k = this.#normalizeKey(owner, key);
        const hasOwn = Object.prototype.hasOwnProperty.call(owner, k);
        if ( step.op !== undefined && hasOwn === false ) { return; }
        const target = step.not !== true;
        const v = owner[k];
        let outcome = false;
        switch ( step.op ) {
        case '==': outcome = (v === step.rval) === target; break;
        case '!=': outcome = (v !== step.rval) === target; break;
        case  '<': outcome = (v < step.rval) === target; break;
        case '<=': outcome = (v <= step.rval) === target; break;
        case  '>': outcome = (v > step.rval) === target; break;
        case '>=': outcome = (v >= step.rval) === target; break;
        case '^=': outcome = `${v}`.startsWith(step.rval) === target; break;
        case '$=': outcome = `${v}`.endsWith(step.rval) === target; break;
        case '*=': outcome = `${v}`.includes(step.rval) === target; break;
        case 're': outcome = step.rval.test(`${v}`); break;
        default: outcome = hasOwn === target; break;
        }
        if ( outcome ) { return k; }
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
            for ( const [ k, v ] of Object.entries(rval) ) {
                lval[k] = v;
            }
            break;
        }
        case 'repl': {
            const lval = obj[key];
            if ( typeof lval !== 'string' ) { return; }
            if ( this.#compiled.re === undefined ) {
                this.#compiled.re = null;
                try {
                    this.#compiled.re = rval.regex !== undefined
                        ? new RegExp(rval.regex, rval.flags)
                        : new RegExp(rval.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
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
  }

  function jsonEdit(jsonq) {
    const jsonp = JSONPath.create(jsonq || '');
    // Untrusted variant — value-assigning queries are rejected.
    if (!jsonp.valid || jsonp.value !== undefined) return;
    _jsonEditRules.push(jsonp);
    _installJsonEditProxy();
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
  function _argsOf(value) {
    return value.split(',').map(function (s) { return s.trim(); });
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
    _jsonEditRules.length = 0;
    _jsonPruneRules.length = 0;
    _noWinOpenRules.length = 0;
    var pruneF  = rules.json_prune_fetch          || [];
    var pruneX  = rules.json_prune_xhr            || [];
    var setC    = rules.set_constant              || [];
    var noWin   = rules.no_window_open_if         || [];
    var prevX   = rules.prevent_xhr               || [];

    for (var i = 0; i < pruneF.length; i++) {
      if (pruneF[i]) jsonPruneFetchResponse(pruneF[i]);
    }
    for (var j = 0; j < pruneX.length; j++) {
      if (pruneX[j]) jsonPruneXhrResponse(pruneX[j]);
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
    // prevent_settimeout / prevent_setinterval = pattern (whole value)
    _eachRule(rules.prevent_settimeout, function (v) {
      _wrapOnce('prevent_settimeout', v, function () { preventSetTimeout(v); });
    });
    _eachRule(rules.prevent_setinterval, function (v) {
      _wrapOnce('prevent_setinterval', v, function () { preventSetInterval(v); });
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
  var _RULES_CACHE_KEY = '__abrules';
  var _RESPONSE_FILTER_RULE_KEYS = ['json_prune_fetch', 'json_prune_xhr', 'jsonl_edit_xhr', 'json_edit', 'json_prune', 'trusted_replace_xhr_response', 'no_window_open_if'];

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
    try {
      var rules = JSON.parse(cached);
      // The cache lives in page-writable storage, so treat it as untrusted
      // input: anything non-object is ignored. A page corrupting it can only
      // affect its own MAIN world — same privilege it already has.
      if (rules && typeof rules === 'object') _applyScriptletRules(rules);
    } catch (e) { /* corrupt cache — wrappers stay pass-through until dispatch */ }
  })();

  // Bridge: content.js dispatches '__adblock_scriptlet_rules__' after async rule load.
  // Content script and MAIN world share DOM events — standard cross-world pattern.
  window.addEventListener('__adblock_scriptlet_rules__', function(ev) {
    _scriptletsEnabled = true;
    try { _applyScriptletRules(ev.detail); } catch (e) {}
  });

  // When protection is toggled OFF or domain paused, disable all scriptlet logic.
  window.addEventListener('__adblock_scriptlet_disable__', function() {
    _scriptletsEnabled = false;
    _noWinOpenRules.length = 0;
  });


}());
