    /*!
    * JS Runtime Inspector
    * ------------------------------------------------------------------
    * Runtime monitoring tool for JavaScript in the browser, built for
    * analyzing / reverse-engineering obfuscated code:
    *
    *   - Catches encode/decode functions (atob, btoa, JSON.parse, TextDecoder,
    *     escape/unescape, String.fromCharCode, crypto.subtle...)
    *   - Catches dynamically-run code (eval, Function, setTimeout/setInterval
    *     with a string argument)
    *   - Watches an object's variables/properties for changes at runtime
    *   - Traces every function call on an object (input args / return value)
    *
    * Quick usage (paste this whole file into DevTools Console):
    *
    *   RTI.start();                      // enable encode/decode + dynamic-eval hooks
    *   RTI.watch(obj, 'token');          // watch obj.token for changes
    *   RTI.watchGlobal('secretKey');     // watch the global variable window.secretKey
    *   RTI.trace(obj, 'CryptoModule');   // trace every function on obj
    *   RTI.dump();                       // print a summary table of everything captured
    *   RTI.stop();                       // remove all hooks, restore originals
    *
    * RTI.start();          // hook crypto + eval
RTI.findFbAds();      // enable network hook, filter by marker (renamed field included)
// … scroll feed …
RTI.dump('net');      // view ad-related request/response
RTI.decodeAds();      // unwrap nested JSON, expand the tree to find th_dat_spo
    *
    * No external dependencies. Safe to remove (stop restores the originals).
    */
    (function (globalScope) {
      'use strict';

      if (globalScope.RTI && globalScope.RTI.__installed) {
        globalScope.RTI.log('RTI is already loaded — call RTI.stop() first if you want to reload.');
        return;
      }

      // ---------------------------------------------------------------
      // Config & state
      // ---------------------------------------------------------------
      var config = {
        maxArgLen: 300,       // max length when printing a string value
        stackDepth: 6,        // number of call-stack lines to show
        logToConsole: true,   // print to console in real time
        color: true,          // color the log output
        paused: false,        // pause logging (hooks keep running)
        maxExpand: 500000     // net payloads <= this size get logged as an expandable "full ▶" JSON tree
      };

      var records = [];       // history of every captured event
      var restorers = [];     // hook-restore functions -> called on stop()
      var seqId = 0;
      var inHook = false;     // recursion guard: currently inside a log write?

      // Capture NATIVE references before hooking anything. The internal
      // logger MUST use these — otherwise, once we hook JSON.stringify
      // itself, logging would call back into the hooked function ->
      // recursion blow-up / hang.
      var NATIVE = {
        stringify: JSON.stringify,
        parse: JSON.parse,
        fromCharCode: String.fromCharCode,
        // TextDecoder's original decode — saved BEFORE hookCrypto wraps it, so
        // beacon bytes can be decoded without generating an extra record.
        textDecode: (globalScope.TextDecoder && globalScope.TextDecoder.prototype.decode) || null
      };

      // ---------------------------------------------------------------
      // Utilities
      // ---------------------------------------------------------------
      function now() {
        return (performance && performance.now) ? performance.now().toFixed(1) + 'ms' : Date.now();
      }

      function truncate(str) {
        if (typeof str !== 'string') return str;
        return str.length > config.maxArgLen
          ? str.slice(0, config.maxArgLen) + '…(' + str.length + ' chars)'
          : str;
      }

      // Safely render any value for logging (won't break on cycles/throws)
      function preview(val) {
        try {
          if (val === null) return 'null';
          var t = typeof val;
          if (t === 'undefined') return 'undefined';
          if (t === 'string') return NATIVE.stringify(truncate(val));
          if (t === 'number' || t === 'boolean' || t === 'bigint') return String(val);
          if (t === 'function') return '[function ' + (val.name || 'anonymous') + ']';
          if (t === 'symbol') return val.toString();
          if (val instanceof ArrayBuffer) return 'ArrayBuffer(' + val.byteLength + ')';
          if (ArrayBuffer.isView(val)) return val.constructor.name + '(' + val.length + ')';
          var json = NATIVE.stringify(val);
          return truncate(json !== undefined ? json : Object.prototype.toString.call(val));
        } catch (e) {
          return Object.prototype.toString.call(val);
        }
      }

      function previewArgs(args) {
        return Array.prototype.map.call(args, preview).join(', ');
      }

      // Get a trimmed call-stack (strips RTI's own internal frames)
      function getStack() {
        var raw = (new Error()).stack || '';
        var lines = raw.split('\n').slice(1)
          .filter(function (l) { return l.indexOf('js-runtime-inspector') === -1 && l.indexOf('RTI') === -1; })
          .map(function (l) { return l.trim(); });
        return lines.slice(0, config.stackDepth);
      }

      var styles = {
        crypto: 'color:#e91e63;font-weight:bold',
        eval:   'color:#ff9800;font-weight:bold',
        watch:  'color:#2196f3;font-weight:bold',
        trace:  'color:#4caf50;font-weight:bold',
        net:    'color:#00bcd4;font-weight:bold',
        dim:    'color:#888'
      };

      function record(kind, name, detail) {
        var entry = {
          id: ++seqId,
          time: now(),
          kind: kind,          // 'crypto' | 'eval' | 'watch' | 'trace'
          name: name,          // hook/variable name
          detail: detail,      // detail description object
          stack: getStack()
        };
        records.push(entry);
        if (config.logToConsole && !config.paused) emit(entry);
        return entry;
      }

      function emit(entry) {
        var tag = '%c[RTI:' + entry.kind + ']%c ' + entry.name;
        var st = config.color ? (styles[entry.kind] || '') : '';
        if (config.color) {
          console.groupCollapsed(tag, st, 'color:inherit', entry.detail.summary || '');
        } else {
          console.group('[RTI:' + entry.kind + '] ' + entry.name, entry.detail.summary || '');
        }
        if (entry.detail.input !== undefined) console.log('  in :', entry.detail.input);
        if (entry.detail.output !== undefined) console.log('  out:', entry.detail.output);
        // "View all": for net records (full payload available in detail.raw), log
        // the unwrapped JSON tree directly — DevTools shows a ▶ triangle to expand
        // and view the full thing, right-click -> Copy object/string. If the
        // payload is too large, just suggest RTI.raw() to avoid hanging the
        // console while building the tree.
        var rw = entry.detail.raw;
        if (rw && (rw.res || rw.req)) {
          var body = rw.res || rw.req;
          if (typeof body === 'string' && body.length <= config.maxExpand) {
            var tree; try { tree = deepParse(body); } catch (e) { tree = body; }
            console.log('  full ▶', tree);
          } else {
            console.log('  full ▶ (' + (body ? body.length : 0) + ' chars, too large) → copy(RTI.raw(' +
              entry.id + ',"res",true)) or RTI.raw(' + entry.id + ')');
          }
        }
        if (entry.detail.extra) console.log('  ', entry.detail.extra);
        console.log('%c  ' + entry.stack.join('\n  '), config.color ? styles.dim : '');
        console.groupEnd();
      }

      // ---------------------------------------------------------------
      // Wrap a method on an object and record input/output
      // ---------------------------------------------------------------
      function wrapMethod(target, propName, kind, label) {
        var original = target[propName];
        if (typeof original !== 'function' || original.__rtiWrapped) return;

        var wrapped = function () {
          var args = arguments;
          var out, threw = false, err;
          try {
            out = original.apply(this, args);
          } catch (e) { threw = true; err = e; }

          // Only log when not already inside another log write. This way,
          // building a preview/record (if it happens to touch an already-hooked
          // function) doesn't generate a nested record on its own. The apply()
          // call above sits OUTSIDE the guard, so genuinely nested calls from
          // the application are still recorded.
          if (!inHook) {
            inHook = true;
            try {
              record(kind, label || propName, {
                summary: '(' + previewArgs(args) + ')' + (threw ? ' ✗' : ''),
                input: args.length === 1 ? preview(args[0]) : previewArgs(args),
                output: threw ? '⚠ threw: ' + err : preview(out)
              });
            } finally { inHook = false; }
          }

          if (threw) throw err;
          return out;
        };

        // keep the original name & prototype to reduce detectability
        try {
          Object.defineProperty(wrapped, 'name', { value: original.name, configurable: true });
          Object.defineProperty(wrapped, 'length', { value: original.length, configurable: true });
        } catch (e) {}
        wrapped.toString = function () { return original.toString(); };
        wrapped.__rtiWrapped = true;
        wrapped.__rtiOriginal = original;

        try {
          target[propName] = wrapped;
          restorers.push(function () { target[propName] = original; });
          return true;
        } catch (e) {
          return false; // property is not writable
        }
      }

      // ---------------------------------------------------------------
      // 1) Hook common encode/decode functions
      // ---------------------------------------------------------------
      var CRYPTO_TARGETS = [
        [globalScope, 'atob',   'base64 decode'],
        [globalScope, 'btoa',   'base64 encode'],
        [globalScope, 'escape', 'escape'],
        [globalScope, 'unescape', 'unescape'],
        [globalScope, 'encodeURIComponent', 'encodeURIComponent'],
        [globalScope, 'decodeURIComponent', 'decodeURIComponent'],
        [globalScope, 'encodeURI', 'encodeURI'],
        [globalScope, 'decodeURI', 'decodeURI'],
        [JSON, 'parse', 'JSON.parse'],
        [JSON, 'stringify', 'JSON.stringify'],
        [String, 'fromCharCode', 'String.fromCharCode'],
        [String, 'fromCodePoint', 'String.fromCodePoint']
      ];

      function hookCrypto() {
        CRYPTO_TARGETS.forEach(function (t) {
          if (t[0] && t[0][t[1]]) wrapMethod(t[0], t[1], 'crypto', t[2]);
        });

        // Methods on String.prototype often used for decoding
        ['charCodeAt', 'codePointAt'].forEach(function (m) {
          // Skipped — called too frequently, causes noise. Enable only when needed.
        });

        // Web Crypto API
        if (globalScope.crypto && globalScope.crypto.subtle) {
          ['encrypt', 'decrypt', 'digest', 'sign', 'verify', 'deriveKey', 'importKey'].forEach(function (m) {
            wrapMethod(globalScope.crypto.subtle, m, 'crypto', 'crypto.subtle.' + m);
          });
        }

        // TextDecoder / TextEncoder
        if (globalScope.TextDecoder) wrapMethod(globalScope.TextDecoder.prototype, 'decode', 'crypto', 'TextDecoder.decode');
        if (globalScope.TextEncoder) wrapMethod(globalScope.TextEncoder.prototype, 'encode', 'crypto', 'TextEncoder.encode');
      }

      // ---------------------------------------------------------------
      // 2) Hook dynamically-run code: eval, Function, setTimeout/Interval(string)
      // ---------------------------------------------------------------
      function hookDynamic() {
        // eval
        var _eval = globalScope.eval;
        if (typeof _eval === 'function') {
          var evalWrap = function (code) {
            record('eval', 'eval', {
              summary: preview(code),
              input: typeof code === 'string' ? truncate(code) : preview(code)
            });
            return _eval.apply(this, arguments); // indirect call -> evaluates in global scope
          };
          try {
            globalScope.eval = evalWrap;
            restorers.push(function () { globalScope.eval = _eval; });
          } catch (e) {}
        }

        // Function constructor (new Function("...body..."))
        var _Function = globalScope.Function;
        var FunctionWrap = function () {
          var args = Array.prototype.slice.call(arguments);
          record('eval', 'new Function', {
            summary: preview(args[args.length - 1]),
            input: args.map(truncate).join(' , '),
            extra: 'last argument is the dynamically-compiled function body'
          });
          // use bind to preserve both `Function(...)` and `new Function(...)` behavior
          var bound = Function.prototype.bind.apply(_Function, [null].concat(args));
          return new bound();
        };
        FunctionWrap.prototype = _Function.prototype;
        try {
          globalScope.Function = FunctionWrap;
          restorers.push(function () { globalScope.Function = _Function; });
        } catch (e) {}

        // setTimeout / setInterval when the callback is a string (hidden eval form)
        ['setTimeout', 'setInterval'].forEach(function (fn) {
          var orig = globalScope[fn];
          if (typeof orig !== 'function') return;
          var wrap = function (handler) {
            if (typeof handler === 'string') {
              record('eval', fn + '(string)', {
                summary: preview(handler),
                input: truncate(handler),
                extra: 'the string passed to ' + fn + ' will be eval\'d'
              });
            }
            return orig.apply(this, arguments);
          };
          try {
            globalScope[fn] = wrap;
            restorers.push(function () { globalScope[fn] = orig; });
          } catch (e) {}
        });
      }

      // ---------------------------------------------------------------
      // 2b) Network hooks: fetch + XMLHttpRequest
      // ---------------------------------------------------------------
      // On sites like Facebook, ads are loaded via GraphQL/XHR rather than
      // sitting in an easily-readable global variable. The network hook lets
      // us inspect the payload directly.
      function escapeRe(s) {
        return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }

      // Convert a value -> RegExp:
      //   RegExp   -> kept as-is
      //   Array    -> list of LITERAL strings, joined with OR (auto-escaped) — for
      //               URL lists, e.g. ['/api/graphql/', '/ajax/bulk-route-definitions/']
      //   String   -> treated as a regex pattern (keeps old behavior for FB_AD_MARKER...)
      function toRegExp(x) {
        if (!x) return null;
        if (x instanceof RegExp) return x;
        if (Array.isArray(x)) {
          var parts = x.filter(Boolean).map(escapeRe);
          return parts.length ? new RegExp(parts.join('|'), 'i') : null;
        }
        return new RegExp(String(x), 'i');
      }

      // Decode bytes -> string using the original decoder (avoid touching the hook).
      function decodeBytes(view) {
        if (NATIVE.textDecode && globalScope.TextDecoder) {
          try { return NATIVE.textDecode.call(new globalScope.TextDecoder(), view); } catch (e) {}
        }
        var arr = ArrayBuffer.isView(view) ? view : new Uint8Array(view);
        var s = '';
        for (var i = 0; i < arr.length; i++) s += NATIVE.fromCharCode(arr[i]);
        return s;
      }

      // sendBeacon accepts many data types — normalize to a string so it can be inspected.
      function beaconDataToText(data) {
        try {
          if (data == null) return '';
          if (typeof data === 'string') return data;
          if (typeof URLSearchParams !== 'undefined' && data instanceof URLSearchParams) return data.toString();
          if (data instanceof ArrayBuffer) return decodeBytes(new Uint8Array(data));
          if (ArrayBuffer.isView(data)) return decodeBytes(data);
          if (typeof Blob !== 'undefined' && data instanceof Blob) return '[Blob ' + data.size + ' bytes — cannot read synchronously]';
          if (typeof FormData !== 'undefined' && data instanceof FormData) return '[FormData]';
          return '[' + ((data.constructor && data.constructor.name) || typeof data) + ']';
        } catch (e) { return '[could not read beacon]'; }
      }

      function hookNetwork(opts) {
        opts = opts || {};
        var urlFilter = toRegExp(opts.url);
        var bodyFilter = toRegExp(opts.match);
        var maxBody = opts.maxBody || 2000;

        function reportNet(label, url, reqBody, text) {
          // Only record when the content filter (if any) matches — in either the
          // request OR the response.
          if (bodyFilter &&
              !bodyFilter.test(text || '') &&
              !(typeof reqBody === 'string' && bodyFilter.test(reqBody))) return;
          record('net', label, {
            summary: url.length > 120 ? url.slice(0, 120) + '…' : url,
            input: (reqBody != null && reqBody !== '') ? truncate(String(reqBody)) : undefined,
            output: !text ? '(empty)'
              : (text.length > maxBody ? text.slice(0, maxBody) + '…(' + text.length + ' chars)' : text),
            // Store the FULL (untruncated) payload for RTI.decodeAds() to decode later.
            raw: {
              req: (reqBody != null && reqBody !== '') ? String(reqBody) : undefined,
              res: text || undefined
            }
          });
        }

        // fetch — uses response.clone() so the original body isn't consumed.
        if (typeof globalScope.fetch === 'function' && !globalScope.fetch.__rtiWrapped) {
          var _fetch = globalScope.fetch;
          var fetchWrap = function (input, init) {
            var url = (typeof input === 'string') ? input : (input && input.url) || '';
            var reqBody = init && init.body;
            var p = _fetch.apply(this, arguments);
            if (!urlFilter || urlFilter.test(url)) {
              try {
                p.then(function (res) {
                  try {
                    res.clone().text().then(function (text) {
                      reportNet('fetch', url, reqBody, text);
                    }, function () {});
                  } catch (e) {}
                  return res;
                }, function () {});
              } catch (e) {}
            }
            return p;
          };
          fetchWrap.__rtiWrapped = true;
          try {
            globalScope.fetch = fetchWrap;
            restorers.push(function () { globalScope.fetch = _fetch; });
          } catch (e) {}
        }

        // XMLHttpRequest — wraps open() to remember the url, and the load event to read the response.
        var XHR = globalScope.XMLHttpRequest;
        if (XHR && XHR.prototype && XHR.prototype.open && !XHR.prototype.open.__rtiWrapped) {
          var _open = XHR.prototype.open;
          var _send = XHR.prototype.send;
          XHR.prototype.open = function (method, url) {
            this.__rtiUrl = url;
            this.__rtiMethod = method;
            return _open.apply(this, arguments);
          };
          XHR.prototype.open.__rtiWrapped = true;
          XHR.prototype.send = function (body) {
            var self = this;
            var url = self.__rtiUrl || '';
            if (!urlFilter || urlFilter.test(url)) {
              self.addEventListener('load', function () {
                var text = '';
                try {
                  if (self.responseType === '' || self.responseType === 'text') text = self.responseText;
                } catch (e) {}
                reportNet('xhr', url, body, text);
              });
            }
            return _send.apply(this, arguments);
          };
          restorers.push(function () {
            XHR.prototype.open = _open;
            XHR.prototype.send = _send;
          });
        }

        // navigator.sendBeacon — Facebook fires telemetry through this (including
        // SPONSORED "render_attempt", "click" logs...). No response; the payload
        // is in the 2nd argument.
        var nav = globalScope.navigator;
        if (nav && typeof nav.sendBeacon === 'function' && !nav.sendBeacon.__rtiWrapped) {
          var _sb = nav.sendBeacon;
          // sendBeacon usually lives on Navigator.prototype (not an own prop);
          // remember that so restore is correct: either delete the override, or
          // reassign the original.
          var hadOwn = Object.prototype.hasOwnProperty.call(nav, 'sendBeacon');
          var sbWrap = function (url, data) {
            if (!urlFilter || urlFilter.test(String(url))) {
              reportNet('sendBeacon', String(url), beaconDataToText(data), '');
            }
            return _sb.apply(nav, arguments);
          };
          sbWrap.__rtiWrapped = true;
          try {
            nav.sendBeacon = sbWrap;
            restorers.push(function () {
              try {
                if (hadOwn) nav.sendBeacon = _sb;
                else delete nav.sendBeacon;   // expose the native prototype version again
              } catch (e) { nav.sendBeacon = _sb; }
            });
          } catch (e) {}
        }

        log('hookNetwork: capturing fetch + XHR + sendBeacon' +
          (urlFilter ? ' (url ~ ' + urlFilter + ')' : '') +
          (bodyFilter ? ' (content ~ ' + bodyFilter + ')' : ' — NOTE: no filter means a LOT of logs') + '.');
      }

      // Ad markers in Facebook's (and similar sites') GraphQL payloads.
      // th_dat_spo / sposnsor / distac: the NEW names for sponsored_data /
      // SponsoredAuctionDistance once the GHL...FieldName flag is on (confirmed 2026-07-20).
      // FB deliberately misspells these to dodge the /sponsor/ regex.
      var FB_AD_MARKER =
        /sponsored|is_sponsored|sponsored_data|sponsored_label|"ad_id"|ad_client|ad_delivery|SponsoredAd|Được tài trợ|th_dat_spo|sposnsor|distac/i;

      // Capture only traffic containing an ad marker (recommended for Facebook).
      function findFbAds(extraMarker) {
        var marker = extraMarker
          ? new RegExp(FB_AD_MARKER.source + '|' + toRegExp(extraMarker).source, 'i')
          : FB_AD_MARKER;
        hookNetwork({ match: marker });
        log('findFbAds: enabled. Scroll the news feed for a few seconds then call RTI.dump("net") / RTI.grep("sponsored").');
      }

      // Default URL list to watch (Facebook GraphQL + bulk-route).
      var URL_WATCH_DEFAULT = ['/api/graphql/', '/ajax/bulk-route-definitions/'];

      // Capture ONLY traffic from the URLs in the list (no content filtering).
      //   RTI.watchUrls();                              // use the default list
      //   RTI.watchUrls(['/api/graphql/']);             // custom list
      //   RTI.watchUrls(['/api/graphql/'], {match:/ad_id/});  // with content filter too
      // Full payload is stored in records -> RTI.dump('net') / RTI.decodeAds().
      function watchUrls(urls, opts) {
        opts = opts || {};
        var list = (urls && urls.length) ? urls : URL_WATCH_DEFAULT;
        hookNetwork({ url: list, match: opts.match, maxBody: opts.maxBody });
        log('watchUrls: capturing only URLs ~ ' + list.join(' | ') +
          (opts.match ? '  (content filter ~ ' + toRegExp(opts.match) + ')' : ''));
      }

      // ---------------------------------------------------------------
      // 3) Watch a variable/property for changes
      // ---------------------------------------------------------------
      function watch(target, propName, label) {
        if (!target || typeof target !== 'object') {
          log('watch: target is not a valid object');
          return;
        }
        label = label || propName;
        var current = target[propName];
        var existingDesc = Object.getOwnPropertyDescriptor(target, propName);

        if (existingDesc && !existingDesc.configurable) {
          log('watch: property "' + propName + '" is not configurable, cannot be watched.');
          return;
        }

        try {
          Object.defineProperty(target, propName, {
            configurable: true,
            enumerable: existingDesc ? existingDesc.enumerable : true,
            get: function () { return current; },
            set: function (v) {
              var old = current;
              current = v;
              record('watch', label, {
                summary: preview(old) + ' → ' + preview(v),
                input: preview(old),
                output: preview(v),
                extra: 'value assigned'
              });
            }
          });
          restorers.push(function () {
            try {
              Object.defineProperty(target, propName, {
                configurable: true, enumerable: true, writable: true, value: current
              });
            } catch (e) {}
          });
          log('Watching property: ' + label);
        } catch (e) {
          log('watch error: ' + e.message);
        }
      }

      function watchGlobal(propName) {
        watch(globalScope, propName, 'window.' + propName);
      }

      // Wrap the entire object in a Proxy -> catch EVERY property read/write (including newly-added ones)
      function watchAll(target, label) {
        if (!target || typeof target !== 'object') {
          log('watchAll: needs an object');
          return target;
        }
        label = label || 'object';
        var proxy = new Proxy(target, {
          set: function (obj, prop, value) {
            var old = obj[prop];
            if (old !== value) {
              record('watch', label + '.' + String(prop), {
                summary: preview(old) + ' → ' + preview(value),
                input: preview(old),
                output: preview(value)
              });
            }
            obj[prop] = value;
            return true;
          }
        });
        log('watchAll: returning a Proxy — reassign your variable = this proxy to watch it.');
        return proxy;
      }

      // ---------------------------------------------------------------
      // 4) Trace every function on an object
      // ---------------------------------------------------------------
      // Built-in prototypes — NEVER wrap methods on these, since doing so
      // would affect EVERY object/array on the entire page (including RTI's
      // own internal code).
      var BUILTIN_PROTOS = [
        Object.prototype, Array.prototype, Function.prototype,
        String.prototype, Number.prototype, Boolean.prototype
      ];
      if (globalScope.Promise) BUILTIN_PROTOS.push(Promise.prototype);
      if (globalScope.Map) BUILTIN_PROTOS.push(Map.prototype);
      if (globalScope.Set) BUILTIN_PROTOS.push(Set.prototype);

      function isBuiltinProto(obj) {
        return BUILTIN_PROTOS.indexOf(obj) !== -1;
      }

      function trace(target, label) {
        if (!target || (typeof target !== 'object' && typeof target !== 'function')) {
          log('trace: target must be an object or function');
          return;
        }
        label = label || (target.constructor && target.constructor.name) || 'obj';
        var count = 0;
        var seen = {};

        // Wrap methods directly on target, and on the prototype one level up IF
        // that's the prototype of a user-defined class (not a built-in).
        [target, Object.getPrototypeOf(target)].forEach(function (obj) {
          if (!obj || isBuiltinProto(obj)) return;
          Object.getOwnPropertyNames(obj).forEach(function (key) {
            if (seen[key] || key === 'constructor') return;
            seen[key] = true;
            var desc;
            try { desc = Object.getOwnPropertyDescriptor(obj, key); }
            catch (e) { return; }
            if (desc && typeof desc.value === 'function') {
              if (wrapMethod(obj, key, 'trace', label + '.' + key)) count++;
            }
          });
        });
        log('trace: wrapped ' + count + ' function(s) on ' + label +
          (count === 0 && Array.isArray(target) ? ' (array has no own methods — skipped)' : ''));
      }

      // ---------------------------------------------------------------
      // Query / reporting
      // ---------------------------------------------------------------
      function dump(filterKind) {
        var rows = records
          .filter(function (r) { return !filterKind || r.kind === filterKind; })
          .map(function (r) {
            return {
              '#': r.id,
              kind: r.kind,
              name: r.name,
              detail: r.detail.summary
            };
          });
        if (console.table) console.table(rows);
        else console.log(rows);
        log('Total: ' + rows.length + ' event(s)' + (filterKind ? ' (' + filterKind + ')' : '') + '.');
        return records;
      }

      // Filter records whose value (in/out/summary) matches a string/regex — useful
      // when you already know a piece of data and want to find which function handled it.
      function grep(needle) {
        var re = needle instanceof RegExp ? needle : new RegExp(String(needle), 'i');
        var hits = records.filter(function (r) {
          return re.test(NATIVE.stringify(r.detail));
        });
        hits.forEach(emit);
        log('grep "' + needle + '": ' + hits.length + ' result(s).');
        return hits;
      }

      // Facebook (and many other sites) embeds JSON as a STRING inside JSON,
      // multiple layers deep (extra -> "{...}" -> payload...). deepParse unwraps
      // all of those layers into an object tree, readable/expandable in the console.
      function deepParse(value, depth) {
        depth = depth || 0;
        if (depth > 20) return value;
        if (typeof value === 'string') {
          var s = value.trim();
          if (s && (s.charAt(0) === '{' || s.charAt(0) === '[')) {
            try { return deepParse(NATIVE.parse(s), depth + 1); } catch (e) { return value; }
          }
          return value;
        }
        if (Array.isArray(value)) {
          return value.map(function (v) { return deepParse(v, depth + 1); });
        }
        if (value && typeof value === 'object') {
          var out = {};
          for (var k in value) {
            if (Object.prototype.hasOwnProperty.call(value, k)) out[k] = deepParse(value[k], depth + 1);
          }
          return out;
        }
        return value;
      }

      // Decode ad records: unwrap nested JSON and print the object tree.
      // Prefers the FULL payload (detail.raw) when available, falls back to the truncated version.
      function decodeAds(needle) {
        var re = needle ? toRegExp(needle)
          : /sponsored|is_sponsored|"ad_id"|ad_client|Được tài trợ|th_dat_spo|sposnsor|distac/i;
        var hits = records.filter(function (r) {
          var hay = (r.detail && r.detail.raw) ? NATIVE.stringify(r.detail.raw) : NATIVE.stringify(r.detail);
          return re.test(hay);
        });
        hits.forEach(function (r) {
          var raw = (r.detail && r.detail.raw) || {};
          var src = raw.res || raw.req || r.detail.output || r.detail.input;
          var parsed;
          try { parsed = deepParse(src); } catch (e) { parsed = src; }
          if (config.color) console.groupCollapsed('%c[RTI:decode]%c #' + r.id + ' ' + r.name, styles.net, '');
          else console.group('[RTI:decode] #' + r.id + ' ' + r.name);
          console.log(parsed);
          console.groupEnd();
        });
        log('decodeAds: unwrapped ' + hits.length + ' record(s) (deep-parsed nested JSON). Expand the tree to view.');
        return hits;
      }

      // Get the FULL payload (not truncated like the out: field in the console) of
      // one net record, for copying in DevTools:
      //   copy(RTI.raw())            // full response of the MOST RECENT net record
      //   copy(RTI.raw(1708))        // by record id (see the id in RTI.dump('net'))
      //   copy(RTI.raw(1708,'req'))  // request body instead of response
      //   copy(RTI.raw(1708,'res',true))  // deep-parse nested JSON -> copy the object tree
      // Returns a string (or an object if parse=true) to feed straight into copy().
      function raw(id, which, parse) {
        var r;
        if (id == null) {
          for (var i = records.length - 1; i >= 0; i--) {
            if (records[i].kind === 'net') { r = records[i]; break; }
          }
        } else {
          for (var j = 0; j < records.length; j++) {
            if (records[j].id === id) { r = records[j]; break; }
          }
        }
        if (!r) { log('raw: no record found' + (id != null ? ' #' + id : ' of kind net')); return; }
        var rw = (r.detail && r.detail.raw) || {};
        var src = which === 'req' ? rw.req : rw.res;
        if (src == null) src = which === 'req' ? r.detail.input : r.detail.output;
        if (parse) { try { return deepParse(src); } catch (e) { return src; } }
        return src;
      }

      // ---------------------------------------------------------------
      // whyAd($0): reads the React fiber props of a CURRENTLY-DISPLAYED ad to
      // find which field marks it as an ad — WITHOUT guessing the field name upfront.
      // ---------------------------------------------------------------
      // Usage: right-click an ad → Inspect (element becomes $0) → RTI.whyAd($0)
      // Prints: the post/feed-unit data objects (story/node/feedEdge...) found
      // along the fiber tree, with their key lists — eyeball which unusual key
      // only ads have (e.g. th_dat_spo, sponsored_data, whatsapp_ad_context with
      // a value, ad_id...). Since it reads already-rendered data directly, it
      // stays correct even as FB renames fields across releases.
      // Find the React fiber attached to a DOM node. FB attaches it under a key
      // like '__reactFiber$<rand>' (and '__reactProps$', '__reactContainer$') as
      // NON-ENUMERABLE → Object.keys misses it; MUST use getOwnPropertyNames.
      // Walk up the parent tree until a fiber is found, also crossing into the
      // shadow root if present.
      function _fiberKey(node) {
        var ks;
        try { ks = Object.getOwnPropertyNames(node); } catch (e) { return null; }
        for (var i = 0; i < ks.length; i++) {
          var k = ks[i];
          if (k.indexOf('__reactFiber$') === 0 ||
              k.indexOf('__reactInternalInstance$') === 0 ||
              k.indexOf('__reactContainer$') === 0) return k;
        }
        return null;
      }
      function _fiberOf(el) {
        while (el) {
          var k = _fiberKey(el);
          if (k) return el[k];
          // cross the shadow-DOM boundary if there's a host
          el = el.parentElement || (el.parentNode && el.parentNode.host) || null;
        }
        return null;
      }

      // "Broad" regex used ONLY to highlight suspicious keys — not used to decide.
      var WHYAD_HINT = /sponsor|sposnsor|th_dat_spo|_ad_|ad_id|adid|client_token|auction|distac|boost|promoted|whatsapp_ad|is_demo_ad|brs_filter/i;

      function whyAd(el) {
        if (!el || el.nodeType !== 1) {
          log('Usage: right-click an ad → Inspect → RTI.whyAd($0)');
          return;
        }
        var fiber = _fiberOf(el);
        if (!fiber) { log('whyAd: element is not part of a React tree (no __reactFiber$).'); return; }

        // Props that commonly hold post/feed-unit data.
        var DATA_PROPS = ['story', 'node', 'feedUnit', 'feedEdge', 'edge', 'adStory', 'unit', 'post', 'row', 'group'];
        var found = [], depth = 0, seen = (typeof WeakSet === 'function') ? new WeakSet() : null;

        while (fiber && depth < 120 && found.length < 6) {
          var props = fiber.memoizedProps;
          if (props && typeof props === 'object') {
            for (var i = 0; i < DATA_PROPS.length; i++) {
              var cand = props[DATA_PROPS[i]];
              if (!cand || typeof cand !== 'object') continue;
              if (seen) { if (seen.has(cand)) continue; seen.add(cand); }
              var keys = Object.keys(cand);
              if (keys.length < 2) continue;
              var hintKeys = keys.filter(function (k) {
                var v = cand[k];
                var meaningful = v !== null && v !== undefined && v !== false && v !== 0 && v !== '';
                return WHYAD_HINT.test(k) && meaningful;
              });
              found.push({ prop: DATA_PROPS[i], depth: depth, obj: cand, keys: keys, hintKeys: hintKeys });
            }
          }
          fiber = fiber.return;
          depth++;
        }

        if (!found.length) {
          log('whyAd: no props.story/node/feedUnit found along the fiber tree. Try console.dir($0) and dig ' +
              'manually, or select a parent/child element of the ad and call this again.');
          return;
        }
        if (config.color) console.groupCollapsed('%c[RTI:whyAd]%c ' + found.length + ' post-data object(s)', styles.net, '');
        else console.group('[RTI:whyAd] ' + found.length + ' post-data object(s)');
        found.forEach(function (f) {
          log('props.' + f.prop + ' (fiber depth ' + f.depth + ') — ' + f.keys.length + ' key(s)' +
              (f.hintKeys.length ? ' | SUSPECT KEYS: ' + f.hintKeys.join(', ') : ' | (no key matched the hint — inspect manually below)'));
          console.log('  keys:', f.keys.join(', '));
          console.dir(f.obj);
        });
        console.groupEnd();
        log('whyAd: compare an AD object against a REGULAR post — whichever key/branch only the ad has is the field to write a rule for.');
        return found;
      }

      // ---------------------------------------------------------------
      // Scan global variables by name (default: ad-tech libraries)
      // ---------------------------------------------------------------
      // List of common ad-tech tokens. Uses \b to avoid false matches (e.g.
      // "addEventListener", "address"). Case-insensitive, so "adSlot",
      // "adUnit"... all get caught.
      var AD_PATTERN = new RegExp(
        '\\b(' + [
          'ads', 'adsbygoogle', 'advert(ising|isement)?',
          'googletag(services)?', 'gpt', 'gptadslots', 'pubads',
          'adslot', 'adunit', 'adserver', 'adserv', 'adconfig', 'admanager',
          'doubleclick', 'dfp',
          'prebid', 'pbjs',           // Prebid
          'apstag',                   // Amazon TAM
          'criteo', 'taboola', 'outbrain', 'openx', 'rubicon', 'indexexchange',
          'adsense', 'adroll', 'adform', 'adtech', 'admob', 'adnxs', 'appnexus',
          'sponsor', 'banner', 'yieldbot', 'moatinit', 'ima'
        ].join('|') + ')\\b',
        'i'
      );

      // Scan every variable in global scope matching a pattern (default AD_PATTERN).
      // Returns an array of {name,type,preview}. Read-only — doesn't change anything.
      function scan(pattern) {
        var re = pattern
          ? (pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i'))
          : AD_PATTERN;

        var keys;
        try { keys = Object.getOwnPropertyNames(globalScope); }
        catch (e) { keys = Object.keys(globalScope); }

        var results = [];
        keys.forEach(function (key) {
          if (!re.test(key)) return;
          var val, typ;
          try { val = globalScope[key]; typ = typeof val; }
          catch (e) { typ = '<could not read>'; val = undefined; }
          results.push({ name: key, type: typ, preview: preview(val) });
        });
        results.sort(function (a, b) { return a.name < b.name ? -1 : 1; });

        if (console.table) console.table(results.map(function (r) {
          return { name: r.name, type: r.type, preview: r.preview };
        }));
        else results.forEach(function (r) { log(r.name + ' : ' + r.type + ' = ' + r.preview); });
        log('scan: found ' + results.length + ' matching variable(s).');
        return results;
      }

      // Convenience: scan for ad-related variables. Optional action:
      //   'watch' -> watch every found ad variable for reassignment
      //   'trace' -> wrap every function on the found ad objects/functions
      function findAds(action) {
        var found = scan(AD_PATTERN);
        found.forEach(function (r) {
          var val;
          try { val = globalScope[r.name]; } catch (e) { return; }
          if (action === 'watch') {
            watch(globalScope, r.name, 'window.' + r.name);
          } else if (action === 'trace' && val && (typeof val === 'object' || typeof val === 'function')) {
            trace(val, r.name);
          }
        });
        if (action) log('findAds: applied "' + action + '" to ' + found.length + ' variable(s).');
        return found;
      }

      function clear() { records.length = 0; log('History cleared.'); }

      function log(msg) {
        console.log('%c[RTI]%c ' + msg, config.color ? 'color:#9c27b0;font-weight:bold' : '', '');
      }

      // ---------------------------------------------------------------
      // Lifecycle
      // ---------------------------------------------------------------
      function start(opts) {
        if (opts) for (var k in opts) if (k in config) config[k] = opts[k];
        hookCrypto();
        hookDynamic();
        log('Encode/decode + dynamic-code hooks enabled. Use RTI.watch / RTI.trace on a specific object, RTI.dump() to view.');
      }

      function stop() {
        while (restorers.length) {
          try { restorers.pop()(); } catch (e) {}
        }
        log('All hooks removed, originals restored.');
      }

      // ---------------------------------------------------------------
      // Public API
      // ---------------------------------------------------------------
      var RTI = {
        __installed: true,
        config: config,
        start: start,
        stop: stop,
        hookCrypto: hookCrypto,
        hookDynamic: hookDynamic,
        hookNetwork: hookNetwork,
        findFbAds: findFbAds,
        watchUrls: watchUrls,
        watch: watch,
        watchGlobal: watchGlobal,
        watchAll: watchAll,
        trace: trace,
        dump: dump,
        grep: grep,
        deepParse: deepParse,
        decodeAds: decodeAds,
        raw: raw,
        whyAd: whyAd,
        scan: scan,
        findAds: findAds,
        clear: clear,
        records: records,
        pause: function () { config.paused = true; log('Logging paused (history still recorded).'); },
        resume: function () { config.paused = false; log('Logging resumed.'); },
        log: log
      };

      globalScope.RTI = RTI;
      log('JS Runtime Inspector ready. Type RTI.start() to begin.');
    })(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
