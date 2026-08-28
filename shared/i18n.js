// shared/i18n.js — runtime data-i18n substitution pass + manual-language
// override. Loaded right after browser-compat.js (self.EXT = chrome), as
// early as possible in every context: HTML pages (before the page's own
// script), the 3 isolated-world picker content scripts (manifest.json
// content_scripts array), and the service worker (background.js's
// importScripts). Works with zero DOM in the service worker — every
// document.* access below is guarded.
//
// chrome.i18n has NO built-in way to pick a language other than the one the
// browser itself resolves (getUILanguage()) — there is no "set locale"
// call. To let Settings offer a manual language choice anyway, this file
// installs a drop-in EXT.i18n.getMessage() WRAPPER (reassigns the .i18n
// property on the shared EXT/chrome object, so all ~312 EXISTING call
// sites across every file keep working completely unchanged) that checks
// an in-memory override map first and falls through to the real
// chrome.i18n.getMessage() otherwise. The override map is normally loaded
// async (chrome.storage.local has no synchronous read API in MV3) — which
// on its own means every page opens showing native/English first, then
// visibly swaps to the override language once that resolves (live-reported
// 2026-08-28: "open popup, shows English then Vietnamese"). Fixed for the
// 3 HTML pages (dashboard/popup/blocked — each is the extension's OWN
// origin, so its localStorage is synchronous AND not shared with any real
// website) by caching the last-applied {lang, messages} there: read
// synchronously BEFORE the very first data-i18n pass, so a repeat visit
// paints correctly from frame one, no flash. The async chrome.storage.local
// path still runs after that to confirm/refresh the cache — content
// scripts and the service worker have no localStorage at all and keep the
// original English-first-paint behavior (a picker panel/context-menu title
// is normally read well after page load anyway, not at first paint, so the
// gap matters far less there than on a page a user just opened to look at).
(function () {
  // Keep in sync with the directories actually shipped under _locales/.
  var AVAILABLE_LOCALES = ['en', 'vi'];

  function applyI18n(root) {
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    var scope = root || document;
    try {
      var textNodes = scope.querySelectorAll('[data-i18n]');
      for (var i = 0; i < textNodes.length; i++) {
        var key = textNodes[i].getAttribute('data-i18n');
        var msg = EXT.i18n.getMessage(key);
        if (msg) textNodes[i].textContent = msg;
      }
      var placeholderNodes = scope.querySelectorAll('[data-i18n-placeholder]');
      for (var j = 0; j < placeholderNodes.length; j++) {
        var pKey = placeholderNodes[j].getAttribute('data-i18n-placeholder');
        var pMsg = EXT.i18n.getMessage(pKey);
        if (pMsg) placeholderNodes[j].setAttribute('placeholder', pMsg);
      }
      var titleNodes = scope.querySelectorAll('[data-i18n-title]');
      for (var k = 0; k < titleNodes.length; k++) {
        var tKey = titleNodes[k].getAttribute('data-i18n-title');
        var tMsg = EXT.i18n.getMessage(tKey);
        if (tMsg) titleNodes[k].setAttribute('title', tMsg);
      }
    } catch (e) {}
  }
  self.__i18nApply = applyI18n;

  // ── manual-language override wrapper ──────────────────────────────
  var _overrideMsgs = null; // {key: {message, placeholders?}} once loaded; null = pure passthrough

  function _substitute(msg, subs) {
    if (subs === undefined || subs === null) return msg;
    var arr = Array.isArray(subs) ? subs : [subs];
    var out = msg;
    for (var i = 0; i < arr.length; i++) {
      out = out.split('$' + (i + 1)).join(String(arr[i]));
    }
    return out;
  }

  function _installWrapper() {
    var native = EXT.i18n;
    if (!native || native.__qkv1Wrapped) return;
    var wrapper = {
      __qkv1Wrapped: true,
      getMessage: function (key, subs) {
        if (_overrideMsgs) {
          var entry = _overrideMsgs[key];
          if (entry && typeof entry.message === 'string') return _substitute(entry.message, subs);
        }
        return native.getMessage(key, subs);
      },
      getUILanguage: function () { return native.getUILanguage(); },
      getAcceptLanguages: function (cb) { return native.getAcceptLanguages(cb); },
      detectLanguage: function (text, cb) { return native.detectLanguage(text, cb); },
    };
    try {
      EXT.i18n = wrapper; // chrome's per-namespace objects are plain, writable objects — this sticks
    } catch (e) {
      // Extremely defensive fallback if some platform ever locks chrome.i18n:
      // replace the whole EXT/chrome reference with a passthrough Proxy that
      // only special-cases .i18n. Every other EXT.xxx caller is unaffected.
      try {
        var real = EXT;
        self.EXT = new Proxy(real, {
          get: function (target, prop) { return prop === 'i18n' ? wrapper : target[prop]; },
        });
      } catch (e2) {}
    }
  }

  function _loadOverride(lang) {
    return new Promise(function (resolve) {
      try {
        fetch(EXT.runtime.getURL('_locales/' + lang + '/messages.json'))
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) { _overrideMsgs = data || null; resolve(); })
          .catch(function () { resolve(); });
      } catch (e) { resolve(); }
    });
  }

  // ── synchronous localStorage fast-path (HTML pages only) ───────────
  // Only the 3 extension-owned HTML pages ever reach this — content
  // scripts run on third-party origins (localStorage there would be the
  // WEBSITE's, not ours) and the service worker has no localStorage at
  // all; both are already guarded out by the try/catch below (localStorage
  // is undefined in the service worker, throwing before any read/write).
  var LOCAL_CACHE_KEY = 'i18nCache';

  function _readLocalCache() {
    try {
      if (typeof localStorage === 'undefined') return null;
      var raw = localStorage.getItem(LOCAL_CACHE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed.lang === 'string' && parsed.messages) return parsed;
    } catch (e) {}
    return null;
  }

  function _writeLocalCache(lang, messages) {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify({ lang: lang, messages: messages }));
    } catch (e) {}
  }

  function _clearLocalCache() {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.removeItem(LOCAL_CACHE_KEY);
    } catch (e) {}
  }
  // Exposed so Settings' language dropdown can drop a stale cached
  // language BEFORE its own location.reload() — otherwise a switch away
  // from a previously-cached language would flash the OLD cached one for
  // a frame on the very reload meant to show the new choice.
  self.i18nClearCache = _clearLocalCache;

  // "Auto" gap this closes: chrome.i18n's own native resolution only ever
  // looks at getUILanguage() (the browser's CHROME/MENU display language —
  // uBlock Origin's own listMatchesEnvironment() uses only this too). A
  // browser can display its own menus in English while the user's actual
  // OS/content-language preference (navigator.language,
  // chrome://settings/languages — a SEPARATE setting) is Vietnamese;
  // getUILanguage()-only resolution misses that entirely. Candidate
  // gathering itself lives in shared/utils.js's
  // langCandidates() — shared with background.js's own
  // _candidateUILanguages()/_uiLanguageMatches() pair, built for the exact
  // same gap on the regional-filter-list auto-enable feature. That file
  // isn't reachable from this one's every context by a plain reference, so
  // utils.js is loaded ahead of this file everywhere i18n.js itself
  // is (content_scripts array, background.js's importScripts, the 3 HTML
  // pages' <script> tags) rather than duplicating the gathering logic here.
  function _matchCandidateLocale() {
    try {
      if (typeof langCandidates !== 'function') return null;
      var cands = langCandidates();
      for (var i = 0; i < cands.length; i++) {
        var primary = String(cands[i] || '').toLowerCase().split('-')[0];
        // 'en' deliberately excluded — that's default_locale, native
        // resolution already lands there for free, no override needed.
        if (primary && primary !== 'en' && AVAILABLE_LOCALES.indexOf(primary) !== -1) return primary;
      }
    } catch (e) {}
    return null;
  }

  // Auto-detect result cache key — written once the FIRST time "auto" mode
  // has to actually derive a language from getUILanguage()/navigator.*
  // (the gap case), read back on every later page load instead of
  // re-deriving it. Only a speedup, never a correctness requirement: an
  // explicit Settings language choice always wins over this regardless (see
  // _resolveLanguage below), and a stale cached guess self-heals the moment
  // the user picks a language by hand. Bundled in the SAME storage.local.get
  // call as 'uiLanguage' — zero extra round-trip for the fast path.
  var UI_LANG_DETECTED_KEY = 'uiLanguageDetected';

  function _resolveLanguage() {
    return new Promise(function (resolve) {
      try {
        EXT.storage.local.get(['uiLanguage', UI_LANG_DETECTED_KEY], function (res) {
          var pref = res && res.uiLanguage;
          if (pref && pref !== 'auto' && AVAILABLE_LOCALES.indexOf(pref) !== -1) { resolve(pref); return; }
          // "auto" (explicit or default/unset). If getUILanguage() itself
          // already resolves to a NON-English available locale, native
          // chrome.i18n resolution already serves it correctly with zero
          // extra fetch — nothing to do. 'en' deliberately excluded from
          // this short-circuit even though it's technically "one of our
          // locales" too: getUILanguage()==='en' is exactly the
          // (English-menu, non-English-content-language) case this whole
          // function exists to catch, not a reason to stop looking —
          // live-caught 2026-08-28: the original `indexOf(uiPrimary) !== -1`
          // check (with no 'en' exclusion) matched 'en' itself and returned
          // before ever reaching _matchCandidateLocale(), silently
          // defeating the entire feature for exactly the case it targets.
          try {
            var ui = EXT.i18n && EXT.i18n.getUILanguage && EXT.i18n.getUILanguage();
            var uiPrimary = String(ui || '').toLowerCase().split('-')[0];
            if (uiPrimary && uiPrimary !== 'en' && AVAILABLE_LOCALES.indexOf(uiPrimary) !== -1) { resolve(null); return; }
          } catch (e) {}
          // Cached from a PREVIOUS auto-detect pass — skip re-deriving it
          // from getUILanguage()/navigator.language this time.
          var cached = res && res[UI_LANG_DETECTED_KEY];
          if (cached && AVAILABLE_LOCALES.indexOf(cached) !== -1) { resolve(cached); return; }
          var detected = _matchCandidateLocale();
          if (detected) {
            try { EXT.storage.local.set(_kv(UI_LANG_DETECTED_KEY, detected)); } catch (e) {}
          }
          resolve(detected);
        });
      } catch (e) { resolve(null); }
    });
  }
  function _kv(k, v) { var o = {}; o[k] = v; return o; }

  _installWrapper();

  // Apply a cached override SYNCHRONOUSLY, before the very first data-i18n
  // pass, so a repeat page open already paints the right language on frame
  // one — this is what actually fixes the reported flash (chrome.storage.local
  // has no sync read API and previously left every first paint on native/
  // English no matter what). First-ever open (no cache yet) is unaffected:
  // still one native-language paint, exactly as before this fix.
  var _cache = _readLocalCache();
  if (_cache) _overrideMsgs = _cache.messages;

  // No-arg calls only: applyI18n's OWN typeof-guard protects its internal
  // `document` uses, but merely WRITING the bare identifier `document` here
  // as an argument expression throws ReferenceError immediately in the
  // service worker (no `document` global exists there at all, guarded or
  // not) — live-caught 2026-08-28. applyI18n(root) already defaults
  // `root || document` internally, past its own guard, so omitting the
  // argument is both correct and required.
  applyI18n(); // immediate pass: correct already whenever a matching cache existed

  var ready = _resolveLanguage().then(function (lang) {
    // Cache already matches the resolved language (both the same non-null
    // locale, or both "no override needed") — nothing left to do, the
    // synchronous pass above already painted correctly. Skip the fetch and
    // the second DOM pass entirely.
    if (_cache && _cache.lang === (lang || null)) return;

    if (!lang) {
      // Resolved to native/English but a (now stale) cache had applied a
      // different language above — put English back and drop the cache.
      if (_cache) { _overrideMsgs = null; _clearLocalCache(); }
      return;
    }

    return _loadOverride(lang).then(function () {
      if (_overrideMsgs) _writeLocalCache(lang, _overrideMsgs);
    });
  });
  self.EXT_I18N_READY = ready;
  ready.then(function () { applyI18n(); });
})();
