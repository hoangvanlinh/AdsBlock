// shared/utils.js — general-purpose helpers shared across every context:
// service worker (background.js), the 3 isolated-world picker content
// scripts, and the 3 HTML pages (dashboard/popup/blocked). Dual-loaded the
// same way config.js/browser-compat.js already are (importScripts() in the
// service worker, a content_scripts array entry for the isolated-world
// pickers, a plain <script> tag in each HTML page) — see each of those
// load points for where this file is wired in. Add new shared helpers here
// rather than duplicating logic per-context; each exported function should
// be self-contained and guard its own optional globals (EXT/document/
// navigator aren't guaranteed to exist in every context this file loads
// into) the same way langCandidates() below does.

// langCandidates() — the ONE place that gathers "what language does
// this user actually seem to want" candidates. Used by two independent
// features: background.js's regional-filter-list auto-enable
// (RULES_REMOTE_URL entries' `lang` field) and shared/i18n.js's manual-
// UI-language "Auto" resolution.
//
// chrome.i18n.getUILanguage() (the browser's CHROME/MENU display language;
// uBlock Origin's own listMatchesEnvironment() uses only this) and
// navigator.language/navigator.languages (the browser's Accept-Language /
// "preferred languages" list, chrome://settings/languages — a SEPARATE
// setting) can genuinely disagree: a browser can display its own menus in
// English while the user's actual preferred/content language is
// Vietnamese. getUILanguage()-only detection misses that case entirely —
// checking both catches it. chrome.i18n.getUILanguage() works the same way
// under Firefox's chrome.* alias; navigator exists in the MV3 service
// worker global too, so no browser/context branch needed.
function langCandidates() {
  var out = [];
  try {
    var ui = typeof EXT !== 'undefined' && EXT.i18n && EXT.i18n.getUILanguage && EXT.i18n.getUILanguage();
    if (ui) out.push(ui);
  } catch (e) { /* ignore */ }
  try {
    if (typeof navigator !== 'undefined') {
      if (navigator.language) out.push(navigator.language);
      if (Array.isArray(navigator.languages)) out.push.apply(out, navigator.languages);
    }
  } catch (e) { /* ignore */ }
  return out;
}
try { self.langCandidates = langCandidates; } catch (e) {}
