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
    if (!chain) return;
    var value = _parseVal(raw);
    var parts = _strSplit.call(chain, '.');
    var leaf  = parts.pop();

    function lock(obj, key) {
      try {
        Object.defineProperty(obj, key, {
          get: function () { return value; },
          set: function () {},
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
    function abort() { throw new ReferenceError(tok); }
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
    function abort() { throw new ReferenceError(tok); }
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
      const { thisArg } = context;
      const xhrDetails = xhrInstances.get(thisArg);
      if (xhrDetails === undefined || thisArg.readyState < thisArg.HEADERS_RECEIVED) return context.reflect();
      const headerName = `${context.callArgs[0]}`;
      const value = xhrDetails.headers[headerName.toLowerCase()];
      if (value !== undefined && value !== '') return value;
      return null;
    });
    proxyApplyFn('XMLHttpRequest.prototype.getAllResponseHeaders', function(context) {
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
  function jsonPruneFetchResponse(rawPrunePaths, rawNeedlePaths) {
    rawPrunePaths = rawPrunePaths || '';
    rawNeedlePaths = rawNeedlePaths || '';
    const safe = safeSelf();
    const extraArgs = safe.getExtraArgs(Array.from(arguments), 2);
    const propNeedles = parsePropertiesToMatchFn(extraArgs.propsToMatch, 'url');
    const applyHandler = function (target, thisArg, args) {
      const fetchPromise = Reflect.apply(target, thisArg, args);
      if (propNeedles.size !== 0) {
        const props = collateFetchArgumentsFn(...args);
        const matched = matchObjectPropertiesFn(propNeedles, props);
        if (matched === undefined) return fetchPromise;
      }
      return fetchPromise.then(responseBefore => {
        const response = responseBefore.clone();
        return response.json().then(objBefore => {
          if (typeof objBefore !== 'object') return responseBefore;
          const objAfter = objectPruneFn(objBefore, rawPrunePaths, rawNeedlePaths);
          if (typeof objAfter !== 'object') return responseBefore;
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

  // ── jsonPruneXhrResponse ──────────────────────────────────────────
  // Subclasses XMLHttpRequest to intercept JSON responses and remove
  // ad-related fields before the page script reads .response.
  function jsonPruneXhrResponse(rawPrunePaths, rawNeedlePaths) {
    rawPrunePaths = rawPrunePaths || '';
    rawNeedlePaths = rawNeedlePaths || '';
    const safe = safeSelf();
    const extraArgs = safe.getExtraArgs(Array.from(arguments), 2);
    const propNeedles = parsePropertiesToMatchFn(extraArgs.propsToMatch, 'url');
    const xhrInstances = new WeakMap();
    self.XMLHttpRequest = class extends self.XMLHttpRequest {
      open(method, url, ...args) {
        const xhrDetails = { method, url };
        let outcome = 'match';
        if (propNeedles.size !== 0) {
          if (matchObjectPropertiesFn(propNeedles, xhrDetails) === undefined) {
            outcome = 'nomatch';
          }
        }
        if (outcome === 'match') xhrInstances.set(this, xhrDetails);
        return super.open(method, url, ...args);
      }
      get response() {
        const innerResponse = super.response;
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
        let objBefore;
        if (typeof innerResponse === 'object') {
          objBefore = innerResponse;
        } else if (typeof innerResponse === 'string') {
          try { objBefore = safe.JSON_parse(innerResponse); } catch (e) {}
        }
        if (typeof objBefore !== 'object') return (xhrDetails.response = innerResponse);
        const objAfter = objectPruneFn(objBefore, rawPrunePaths, rawNeedlePaths);
        xhrDetails.response = typeof objAfter === 'object'
          ? (typeof innerResponse === 'string' ? safe.JSON_stringify(objAfter) : objAfter)
          : innerResponse;
        return xhrDetails.response;
      }
      get responseText() {
        const response = this.response;
        return typeof response !== 'string' ? super.responseText : response;
      }
    };
  }

  // ── noWindowOpenIf ──────────────────────────────────────────────
  // Proxies window.open and blocks calls matching `pattern`.
  // Empty pattern → block ALL window.open (popup ads).
  // Pattern starting with '!' inverts: block everything EXCEPT matches.
  function noWindowOpenIf(pattern, delay, decoy) {
    pattern = pattern || '';
    delay = delay || '';
    decoy = decoy || '';
    const targetMatchResult = pattern.charAt(0) !== '!';
    if (!targetMatchResult) pattern = pattern.slice(1);
    const rePattern = _toRegex(pattern);
    const autoRemoveAfter = (parseFloat(delay) || 0) * 1000;
    const noopFunc = function () {};
    proxyApplyFn('open', function (context) {
      const { callArgs } = context;
      const haystack = callArgs.join(' ');
      if (rePattern.test(haystack) !== targetMatchResult) return context.reflect();
      if (delay === '') return null;
      if (decoy === 'blank') {
        callArgs[0] = 'about:blank';
        const r = context.reflect();
        setTimeout(() => { try { r.close(); } catch (e) {} }, autoRemoveAfter);
        return r;
      }
      const tag = decoy === 'obj' ? 'object' : 'iframe';
      const urlProp = decoy === 'obj' ? 'data' : 'src';
      const decoyEl = document.createElement(tag);
      decoyEl[urlProp] = callArgs[0] || '';
      decoyEl.style.cssText = 'height:1px;position:fixed;top:-1px;width:1px;pointer-events:none';
      document.body.appendChild(decoyEl);
      setTimeout(() => { decoyEl.remove(); }, autoRemoveAfter);
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
    });
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
    // Synthetic/programmatic clicks (isTrusted=false) are ignored.
    document.addEventListener('click', function(ev) {
      if (!ev.isTrusted) return;
      var t = ev.target;
      while (t) {
        if (t.localName === 'a' && t.href && t.href.indexOf('javascript') !== 0) {
          try {
            _allowedOrigin = new URL(t.href).origin;
            clearTimeout(_allowedTimer);
            _allowedTimer = setTimeout(function() { _allowedOrigin = null; }, 1000);
          } catch(e) {}
          return;
        }
        t = t.parentNode;
      }
      // Click was on a non-anchor element — no cross-origin navigation expected.
      clearTimeout(_allowedTimer);
      _allowedOrigin = null;
    }, { capture: true });

    function _isSafeNavigation(url) {
      if (typeof url !== 'string' || !url.startsWith('http')) return true;
      try {
        var targetOrigin = new URL(url).origin;
        if (targetOrigin === location.origin) return true;
        if (_allowedOrigin !== null && targetOrigin === _allowedOrigin) return true;
      } catch(e) { return true; }
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
  }

  // ── YouTube ad removal ───────────────────────────────────────────
  // Applies only on youtube.com — prunes adPlacements/adSlots from
  // player API JSON responses (fetch + XHR) before player reads them.
  if (/(?:^|\.)youtube\.com$/.test(location.hostname)) {
    jsonPruneFetchResponse(
      'adPlacements adSlots playerResponse.adPlacements playerResponse.adSlots' +
      ' [].playerResponse.adPlacements [].playerResponse.adSlots'
    );
    jsonPruneXhrResponse(
      'adPlacements adSlots playerResponse.adPlacements playerResponse.adSlots' +
      ' [].playerResponse.adPlacements [].playerResponse.adSlots'
    );
    // Reels / Shorts — remove isAd flag from watch-sequence responses
    jsonPruneFetchResponse(
      'reelWatchSequenceResponse.entries.[-].command.reelWatchEndpoint.adClientParams.isAd' +
      ' entries.[-].command.reelWatchEndpoint.adClientParams.isAd'
    );
    // Freeze ytInitialPlayerResponse ad properties (inline page script)
    setConstant('ytInitialPlayerResponse.playerAds',    'undefined');
    setConstant('ytInitialPlayerResponse.adPlacements', 'undefined');
    setConstant('ytInitialPlayerResponse.adSlots',      'undefined');
  }

}());
