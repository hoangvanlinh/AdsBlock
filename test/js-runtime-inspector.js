    /*!
    * JS Runtime Inspector
    * ------------------------------------------------------------------
    * Công cụ theo dõi runtime của JavaScript trong trình duyệt, phục vụ
    * phân tích / reverse-engineering code bị obfuscate:
    *
    *   - Bắt hàm mã hoá / giải mã (atob, btoa, JSON.parse, TextDecoder,
    *     escape/unescape, String.fromCharCode, crypto.subtle...)
    *   - Bắt code chạy động (eval, Function, setTimeout/setInterval với
    *     tham số là chuỗi)
    *   - Theo dõi biến / thuộc tính của object thay đổi khi runtime
    *   - Trace mọi lời gọi hàm trên một object (đối số vào / giá trị ra)
    *
    * Cách dùng nhanh (dán toàn bộ file này vào DevTools Console):
    *
    *   RTI.start();                      // bật hook mã hoá + eval động
    *   RTI.watch(obj, 'token');          // theo dõi obj.token thay đổi
    *   RTI.watchGlobal('secretKey');     // theo dõi biến global window.secretKey
    *   RTI.trace(obj, 'CryptoModule');   // trace mọi hàm của obj
    *   RTI.dump();                       // in bảng thống kê các lần bắt được
    *   RTI.stop();                       // gỡ toàn bộ hook, trả lại nguyên bản
    * 
    * RTI.start();          // hook crypto + eval
RTI.findFbAds();      // bật hook mạng, lọc theo marker (đã có tên mới)
// … scroll feed …
RTI.dump('net');      // xem request/response dính ad
RTI.decodeAds();      // bung JSON lồng, mở cây tìm th_dat_spo
    *
    * Không phụ thuộc thư viện ngoài. An toàn để gỡ (stop khôi phục bản gốc).
    */
    (function (globalScope) {
      'use strict';

      if (globalScope.RTI && globalScope.RTI.__installed) {
        globalScope.RTI.log('RTI đã được nạp rồi — gọi RTI.stop() trước nếu muốn nạp lại.');
        return;
      }

      // ---------------------------------------------------------------
      // Cấu hình & trạng thái
      // ---------------------------------------------------------------
      var config = {
        maxArgLen: 300,       // độ dài tối đa khi in một giá trị chuỗi
        stackDepth: 6,        // số dòng call-stack hiển thị
        logToConsole: true,   // in ra console theo thời gian thực
        color: true,          // tô màu log
        paused: false         // tạm dừng ghi log (hook vẫn chạy)
      };

      var records = [];       // lịch sử tất cả sự kiện bắt được
      var restorers = [];     // các hàm khôi phục hook -> gọi khi stop()
      var seqId = 0;
      var inHook = false;     // cờ chống đệ quy: đang trong lúc ghi log?

      // Chụp tham chiếu NATIVE trước khi hook bất cứ thứ gì. Bộ logger nội bộ
      // PHẢI dùng các bản này — nếu không, khi ta hook chính JSON.stringify thì
      // việc log lại gọi vào hàm đã hook -> đệ quy bùng nổ / treo.
      var NATIVE = {
        stringify: JSON.stringify,
        parse: JSON.parse,
        fromCharCode: String.fromCharCode,
        // decode gốc của TextDecoder — lưu TRƯỚC khi hookCrypto bọc nó, để giải
        // mã bytes của beacon mà không tự sinh thêm bản ghi.
        textDecode: (globalScope.TextDecoder && globalScope.TextDecoder.prototype.decode) || null
      };

      // ---------------------------------------------------------------
      // Tiện ích
      // ---------------------------------------------------------------
      function now() {
        return (performance && performance.now) ? performance.now().toFixed(1) + 'ms' : Date.now();
      }

      function truncate(str) {
        if (typeof str !== 'string') return str;
        return str.length > config.maxArgLen
          ? str.slice(0, config.maxArgLen) + '…(' + str.length + ' ký tự)'
          : str;
      }

      // Biểu diễn an toàn 1 giá trị bất kỳ để log (không làm vỡ do vòng lặp/ném lỗi)
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

      // Lấy call-stack gọn (bỏ các frame nội bộ của RTI)
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
          name: name,          // tên hook/biến
          detail: detail,      // object mô tả chi tiết
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
        if (entry.detail.extra) console.log('  ', entry.detail.extra);
        console.log('%c  ' + entry.stack.join('\n  '), config.color ? styles.dim : '');
        console.groupEnd();
      }

      // ---------------------------------------------------------------
      // Bọc một phương thức trên object và ghi lại input/output
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

          // Chỉ ghi log khi không đang ở trong một lượt ghi log khác. Nhờ vậy
          // việc dựng preview/record (nếu vô tình chạm hàm đã hook) không tự
          // sinh ra bản ghi lồng nhau. Lời gọi apply ở trên nằm NGOÀI guard nên
          // các lời gọi lồng nhau THẬT của ứng dụng vẫn được ghi lại.
          if (!inHook) {
            inHook = true;
            try {
              record(kind, label || propName, {
                summary: '(' + previewArgs(args) + ')' + (threw ? ' ✗' : ''),
                input: args.length === 1 ? preview(args[0]) : previewArgs(args),
                output: threw ? '⚠ ném lỗi: ' + err : preview(out)
              });
            } finally { inHook = false; }
          }

          if (threw) throw err;
          return out;
        };

        // giữ nguyên tên & prototype để ít gây phát hiện
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
          return false; // property không ghi được (non-writable)
        }
      }

      // ---------------------------------------------------------------
      // 1) Hook các hàm mã hoá / giải mã phổ biến
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

        // Các phương thức trên String.prototype thường dùng để giải mã
        ['charCodeAt', 'codePointAt'].forEach(function (m) {
          // Bỏ qua vì gọi quá thường xuyên -> gây nhiễu. Chỉ bật khi cần.
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
      // 2) Hook code chạy động: eval, Function, setTimeout/Interval(string)
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
            return _eval.apply(this, arguments); // gọi gián tiếp -> eval global scope
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
            extra: 'tham số cuối là thân hàm được biên dịch động'
          });
          // dùng bind để giữ hoạt động của cả `Function(...)` và `new Function(...)`
          var bound = Function.prototype.bind.apply(_Function, [null].concat(args));
          return new bound();
        };
        FunctionWrap.prototype = _Function.prototype;
        try {
          globalScope.Function = FunctionWrap;
          restorers.push(function () { globalScope.Function = _Function; });
        } catch (e) {}

        // setTimeout / setInterval khi callback là chuỗi (dạng eval ẩn)
        ['setTimeout', 'setInterval'].forEach(function (fn) {
          var orig = globalScope[fn];
          if (typeof orig !== 'function') return;
          var wrap = function (handler) {
            if (typeof handler === 'string') {
              record('eval', fn + '(string)', {
                summary: preview(handler),
                input: truncate(handler),
                extra: 'chuỗi truyền vào ' + fn + ' sẽ được eval'
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
      // 2b) Hook mạng: fetch + XMLHttpRequest
      // ---------------------------------------------------------------
      // Trên các site như Facebook, quảng cáo được nạp qua GraphQL/XHR chứ
      // không có biến global dễ đọc. Hook mạng cho phép soi thẳng payload.
      function toRegExp(x) {
        if (!x) return null;
        return x instanceof RegExp ? x : new RegExp(String(x), 'i');
      }

      // Giải mã bytes -> chuỗi bằng decode gốc (tránh đụng hook).
      function decodeBytes(view) {
        if (NATIVE.textDecode && globalScope.TextDecoder) {
          try { return NATIVE.textDecode.call(new globalScope.TextDecoder(), view); } catch (e) {}
        }
        var arr = ArrayBuffer.isView(view) ? view : new Uint8Array(view);
        var s = '';
        for (var i = 0; i < arr.length; i++) s += NATIVE.fromCharCode(arr[i]);
        return s;
      }

      // sendBeacon nhận nhiều kiểu data — quy về chuỗi để soi được.
      function beaconDataToText(data) {
        try {
          if (data == null) return '';
          if (typeof data === 'string') return data;
          if (typeof URLSearchParams !== 'undefined' && data instanceof URLSearchParams) return data.toString();
          if (data instanceof ArrayBuffer) return decodeBytes(new Uint8Array(data));
          if (ArrayBuffer.isView(data)) return decodeBytes(data);
          if (typeof Blob !== 'undefined' && data instanceof Blob) return '[Blob ' + data.size + ' bytes — không đọc đồng bộ được]';
          if (typeof FormData !== 'undefined' && data instanceof FormData) return '[FormData]';
          return '[' + ((data.constructor && data.constructor.name) || typeof data) + ']';
        } catch (e) { return '[không đọc được beacon]'; }
      }

      function hookNetwork(opts) {
        opts = opts || {};
        var urlFilter = toRegExp(opts.url);
        var bodyFilter = toRegExp(opts.match);
        var maxBody = opts.maxBody || 2000;

        function reportNet(label, url, reqBody, text) {
          // Chỉ ghi khi khớp bộ lọc nội dung (nếu có) — ở request HOẶC response.
          if (bodyFilter &&
              !bodyFilter.test(text || '') &&
              !(typeof reqBody === 'string' && bodyFilter.test(reqBody))) return;
          record('net', label, {
            summary: url.length > 120 ? url.slice(0, 120) + '…' : url,
            input: (reqBody != null && reqBody !== '') ? truncate(String(reqBody)) : undefined,
            output: !text ? '(rỗng)'
              : (text.length > maxBody ? text.slice(0, maxBody) + '…(' + text.length + ' ký tự)' : text),
            // Lưu payload ĐẦY ĐỦ (không bị cắt) để RTI.decodeAds() giải mã sau.
            raw: {
              req: (reqBody != null && reqBody !== '') ? String(reqBody) : undefined,
              res: text || undefined
            }
          });
        }

        // fetch — dùng response.clone() để không tiêu thụ mất body gốc.
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

        // XMLHttpRequest — bọc open() để nhớ url, và load event để đọc response.
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

        // navigator.sendBeacon — Facebook bắn telemetry (gồm log SPONSORED
        // "render_attempt", "click"...) qua đây. Không có response, payload nằm
        // ở tham số thứ 2.
        var nav = globalScope.navigator;
        if (nav && typeof nav.sendBeacon === 'function' && !nav.sendBeacon.__rtiWrapped) {
          var _sb = nav.sendBeacon;
          // sendBeacon thường nằm trên Navigator.prototype (không phải own prop);
          // nhớ lại trạng thái để khôi phục đúng: xoá override, hoặc gán lại bản gốc.
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
                else delete nav.sendBeacon;   // để lộ lại bản native trên prototype
              } catch (e) { nav.sendBeacon = _sb; }
            });
          } catch (e) {}
        }

        log('hookNetwork: đang bắt fetch + XHR + sendBeacon' +
          (urlFilter ? ' (url ~ ' + urlFilter + ')' : '') +
          (bodyFilter ? ' (nội dung ~ ' + bodyFilter + ')' : ' — CHÚ Ý: không lọc sẽ rất nhiều log') + '.');
      }

      // Dấu hiệu quảng cáo trong payload GraphQL của Facebook & tương tự.
      // th_dat_spo / sposnsor / distac: tên MỚI của sponsored_data /
      // SponsoredAuctionDistance khi cờ GHL...FieldName bật (xác nhận 2026-07-20).
      // FB cố tình viết sai chính tả để né regex /sponsor/.
      var FB_AD_MARKER =
        /sponsored|is_sponsored|sponsored_data|sponsored_label|"ad_id"|ad_client|ad_delivery|SponsoredAd|Được tài trợ|th_dat_spo|sposnsor|distac/i;

      // Bắt riêng lưu lượng chứa dấu hiệu quảng cáo (khuyên dùng cho Facebook).
      function findFbAds(extraMarker) {
        var marker = extraMarker
          ? new RegExp(FB_AD_MARKER.source + '|' + toRegExp(extraMarker).source, 'i')
          : FB_AD_MARKER;
        hookNetwork({ match: marker });
        log('findFbAds: đã bật. Lướt news feed vài giây rồi gọi RTI.dump("net") / RTI.grep("sponsored").');
      }

      // ---------------------------------------------------------------
      // 3) Theo dõi biến / thuộc tính thay đổi
      // ---------------------------------------------------------------
      function watch(target, propName, label) {
        if (!target || typeof target !== 'object') {
          log('watch: target không phải object hợp lệ');
          return;
        }
        label = label || propName;
        var current = target[propName];
        var existingDesc = Object.getOwnPropertyDescriptor(target, propName);

        if (existingDesc && !existingDesc.configurable) {
          log('watch: thuộc tính "' + propName + '" không configurable, không theo dõi được.');
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
                extra: 'gán giá trị mới'
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
          log('Đang theo dõi thuộc tính: ' + label);
        } catch (e) {
          log('watch lỗi: ' + e.message);
        }
      }

      function watchGlobal(propName) {
        watch(globalScope, propName, 'window.' + propName);
      }

      // Bọc toàn bộ object bằng Proxy -> bắt MỌI thuộc tính đọc/ghi (kể cả mới thêm)
      function watchAll(target, label) {
        if (!target || typeof target !== 'object') {
          log('watchAll: cần một object');
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
        log('watchAll: trả về Proxy — hãy gán lại biến của bạn = proxy này để theo dõi.');
        return proxy;
      }

      // ---------------------------------------------------------------
      // 4) Trace mọi hàm trên một object
      // ---------------------------------------------------------------
      // Các prototype dựng sẵn — TUYỆT ĐỐI không bọc method trên đây, vì làm
      // vậy sẽ ảnh hưởng MỌI object/array của cả trang (và cả code nội bộ RTI).
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
          log('trace: target phải là object hoặc function');
          return;
        }
        label = label || (target.constructor && target.constructor.name) || 'obj';
        var count = 0;
        var seen = {};

        // Bọc method trực tiếp trên target, và trên prototype 1 cấp NẾU đó là
        // prototype của một class tự định nghĩa (không phải built-in).
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
        log('trace: đã bọc ' + count + ' hàm trên ' + label +
          (count === 0 && Array.isArray(target) ? ' (array không có method riêng — bỏ qua)' : ''));
      }

      // ---------------------------------------------------------------
      // Truy vấn / báo cáo
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
        log('Tổng cộng ' + rows.length + ' sự kiện' + (filterKind ? ' (' + filterKind + ')' : '') + '.');
        return records;
      }

      // Lọc bản ghi mà giá trị (in/out/summary) khớp một chuỗi/regex — hữu ích khi
      // đã biết một mẩu dữ liệu và muốn tìm hàm nào đã xử lý nó.
      function grep(needle) {
        var re = needle instanceof RegExp ? needle : new RegExp(String(needle), 'i');
        var hits = records.filter(function (r) {
          return re.test(NATIVE.stringify(r.detail));
        });
        hits.forEach(emit);
        log('grep "' + needle + '": ' + hits.length + ' kết quả.');
        return hits;
      }

      // Facebook (và nhiều nơi) nhét JSON dưới dạng CHUỖI bên trong JSON, nhiều
      // lớp (extra -> "{...}" -> payload...). deepParse bung tất cả các lớp đó
      // thành cây object để đọc/expand trong console.
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

      // Giải mã các bản ghi quảng cáo: bung JSON lồng nhau và in cây object.
      // Ưu tiên dùng payload ĐẦY ĐỦ (detail.raw) nếu có, nếu không dùng bản đã cắt.
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
        log('decodeAds: đã bung ' + hits.length + ' bản ghi (deep-parse JSON lồng). Mở cây object để xem.');
        return hits;
      }

      // ---------------------------------------------------------------
      // Quét biến global theo tên (mặc định: các thư viện quảng cáo)
      // ---------------------------------------------------------------
      // Danh sách token ad-tech phổ biến. Dùng \b để tránh khớp nhầm
      // (vd "addEventListener", "address"). Khớp không phân biệt hoa/thường
      // nên "adSlot", "adUnit"... đều bắt được.
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

      // Quét tất cả biến ở phạm vi global khớp một mẫu (mặc định AD_PATTERN).
      // Trả về mảng {name,type,preview}. Không làm thay đổi gì — chỉ liệt kê.
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
          catch (e) { typ = '<không đọc được>'; val = undefined; }
          results.push({ name: key, type: typ, preview: preview(val) });
        });
        results.sort(function (a, b) { return a.name < b.name ? -1 : 1; });

        if (console.table) console.table(results.map(function (r) {
          return { name: r.name, type: r.type, preview: r.preview };
        }));
        else results.forEach(function (r) { log(r.name + ' : ' + r.type + ' = ' + r.preview); });
        log('scan: tìm thấy ' + results.length + ' biến khớp mẫu.');
        return results;
      }

      // Tiện ích: quét biến quảng cáo. action tuỳ chọn:
      //   'watch' -> theo dõi mọi biến ad tìm được bị gán lại
      //   'trace' -> bọc mọi hàm của các object/hàm ad tìm được
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
        if (action) log('findAds: đã áp "' + action + '" cho ' + found.length + ' biến.');
        return found;
      }

      function clear() { records.length = 0; log('Đã xoá lịch sử.'); }

      function log(msg) {
        console.log('%c[RTI]%c ' + msg, config.color ? 'color:#9c27b0;font-weight:bold' : '', '');
      }

      // ---------------------------------------------------------------
      // Vòng đời
      // ---------------------------------------------------------------
      function start(opts) {
        if (opts) for (var k in opts) if (k in config) config[k] = opts[k];
        hookCrypto();
        hookDynamic();
        log('Đã bật hook mã hoá + code động. Dùng RTI.watch / RTI.trace cho object cụ thể, RTI.dump() để xem.');
      }

      function stop() {
        while (restorers.length) {
          try { restorers.pop()(); } catch (e) {}
        }
        log('Đã gỡ toàn bộ hook, khôi phục hàm gốc.');
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
        watch: watch,
        watchGlobal: watchGlobal,
        watchAll: watchAll,
        trace: trace,
        dump: dump,
        grep: grep,
        deepParse: deepParse,
        decodeAds: decodeAds,
        scan: scan,
        findAds: findAds,
        clear: clear,
        records: records,
        pause: function () { config.paused = true; log('Tạm dừng log (vẫn ghi lịch sử).'); },
        resume: function () { config.paused = false; log('Tiếp tục log.'); },
        log: log
      };

      globalScope.RTI = RTI;
      log('JS Runtime Inspector đã sẵn sàng. Gõ RTI.start() để bắt đầu.');
    })(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
