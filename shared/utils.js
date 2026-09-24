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

// extValid() — detects an invalidated extension context (page still open
// after the extension was reloaded/updated/disabled — every EXT.* call
// throws once that happens). chrome.runtime.id is static even after
// invalidation, so it can't detect this; getManifest() actually probes the
// context and throws once it's gone. Used by every content script that
// talks to the background/EXT.* APIs (content.js, site-rules-loader.js,
// site-block.js, and transitively element-picker.js/global-scanner.js/
// rule-editor.js which load after this file per the manifests' own
// content_scripts order) — previously 3 byte-identical copies of this same
// function, consolidated here 2026-09-15.
function extValid() {
  try {
    return !!(typeof EXT !== 'undefined' && EXT.runtime && EXT.runtime.getManifest());
  } catch (e) { return false; }
}

// makeOwnNodeCheck(cssClass) — returns an `_ownNode(el)`-shaped predicate
// ("is this element part of MY OWN injected UI, not the page's"), used by
// the 3 on-page picker overlays (element-picker.js/global-scanner.js/
// rule-editor.js — each marks its own UI root with a different class:
// 'qkv1-picker-ui'/'qkv1-scanner-ui'/'qkv1-editor-ui') to avoid treating
// clicks on their own panel/buttons as clicks on the underlying page.
// Previously 3 byte-identical function bodies differing only by the
// hardcoded class string; consolidated here 2026-09-15.
function makeOwnNodeCheck(cssClass) {
  return function (el) { return !!(el && el.closest && el.closest(cssClass)); };
}

// removePanelEl(panelEl) — the shared body of every `_removePanel()` in the
// 3 picker overlays above: tear down the (possibly already-detached) panel
// element and report back the new (always null) value to assign to the
// caller's own `_panelEl` variable, e.g. `_panelEl = removePanelEl(_panelEl);`
// — each file keeps its own module-level `_panelEl`, only the teardown body
// (previously byte-identical in all 3) is shared. Safe to call with null/
// undefined (no-op).
function removePanelEl(panelEl) {
  if (panelEl) { try { panelEl.remove(); } catch (e) { /* already detached */ } }
  return null;
}

// makeButtonFactory(cssClass, padding) — returns an `_mkBtn(label, primary)`
// factory shaped like the 3 picker overlays' own button-styling boilerplate
// (differing only by class name — some use one to mark the button as their
// own UI, `_ownNode`'s cssClass — and the exact padding). `cssClass` may be
// null/omitted to skip setting className (element-picker.js's own confirm-
// panel buttons rely on an ANCESTOR element already carrying the class
// instead of marking each button individually).
function makeButtonFactory(cssClass, padding) {
  return function (label, primary) {
    var b = document.createElement('button');
    if (cssClass) b.className = cssClass;
    b.textContent = label;
    b.style.cssText =
      'font:inherit;font-weight:600;border:0;border-radius:6px;padding:' + padding + ';cursor:pointer;' +
      (primary ? 'background:#2563eb;color:#fff;' : 'background:#334155;color:#e2e8f0;');
    return b;
  };
}

// detectStoreUrl(variant) — picks this browser's real extension-store URL
// from ADBLOCK_CONFIG.STORE_URLS (Firefox/Edge/Chrome, by navigator.userAgent
// sniffing). Used by popup.js (the main store link, plus the review prompt's
// own '/reviews'-suffixed variant) and dashboard.js (the update-available
// link). variant: 'reviews' appends '/reviews' to the firefox/chrome URL
// (matches each store's own review-page URL shape) — Edge's URL already
// points at the right page either way, so it's never suffixed (an existing,
// deliberate asymmetry, not something introduced here). STORE_URLS itself
// was already centralized in config.js specifically to prevent the map
// itself from drifting out of sync between pages — but the CALLING code
// that reads it wasn't: previously 3 near-identical copies (popup.js had 2
// of its own, dashboard.js 1). Consolidated here 2026-09-15.
function detectStoreUrl(variant) {
  const urls = self.ADBLOCK_CONFIG.STORE_URLS;
  const ua = navigator.userAgent;
  const suffix = variant === 'reviews' ? '/reviews' : '';
  if (ua.includes('Firefox/')) return urls.firefox + suffix;
  if (ua.includes('Edg/')) return urls.edge;
  return urls.chrome + suffix;
}

// langCandidates() — the ONE place that gathers "what language does
// this user actually seem to want" candidates. Used by two independent
// features: background.js's regional-filter-list auto-enable
// (RULES_REMOTE_URL entries' `lang` field) and shared/i18n.js's manual-
// UI-language "Auto" resolution.
//
// chrome.i18n.getUILanguage() (the browser's CHROME/MENU display language;
// listMatchesEnvironment() uses only this) and
// navigator.language/navigator.languages (the browser's Accept-Language /
// "preferred languages" list, chrome://settings/languages — a SEPARATE
// setting) can genuinely disagree: a browser can display its own menus in
// English while the user's actual preferred/content language is
// Vietnamese. getUILanguage()-only detection misses that case entirely —
// checking both catches it. chrome.i18n.getUILanguage() works the same way
// under Firefox's chrome.* alias; navigator exists in the MV3 service
// worker global too, so no browser/context branch needed.
// navigator.languages (2026-09-24 — deliberately NOT read here anymore):
// used to push the WHOLE array in too, not just navigator.language — live-
// reported (Windows): a user's OS "Preferred languages" list had picked up
// extra entries over time (secondary keyboard layouts etc., unrelated to
// what content they actually wanted), and background.js's
// _autoEnableLangDefaultSources() — an ANY-candidate-matches consumer, not
// first-match-wins — auto-enabled a Rule Source for EVERY one of them
// (Vietnam + Thai + France at once from one machine). navigator.languages
// tends to accumulate more incidental entries on Windows than macOS in
// practice. Only the single PRIMARY signal (EXT.i18n.getUILanguage(),
// navigator.language) is used now — still closes the "UI language disagrees
// with content language" gap this function exists for, just without also
// picking up every secondary language the OS happens to have installed.
function langCandidates() {
  var out = [];
  try {
    var ui = typeof EXT !== 'undefined' && EXT.i18n && EXT.i18n.getUILanguage && EXT.i18n.getUILanguage();
    if (ui) out.push(ui);
  } catch (e) { /* ignore */ }
  try {
    if (typeof navigator !== 'undefined' && navigator.language) out.push(navigator.language);
  } catch (e) { /* ignore */ }
  return out;
}
try { self.langCandidates = langCandidates; } catch (e) {}

// timezoneLangCandidates() — a SECOND, independent signal, deliberately kept
// OUT of langCandidates() above so shared/i18n.js's UI-language "Auto"
// resolution (a first-match-wins, order-sensitive consumer of
// langCandidates() — see _matchCandidateLocale() there) is completely
// unaffected by it. Only background.js's _candidateUILanguages() merges this
// in, and only for the regional-filter-list auto-enable feature.
//
// Browser UI/content language reflects what the user CHOSE to read/install
// in, not where they actually are — someone who leaves their browser in
// English while living in Vietnam never gets the Vietnam Rule Source
// suggested. IANA timezone (Intl.DateTimeFormat().resolvedOptions().
// timeZone) is a free, local, zero-network proxy for "which region is this
// browser probably in" that doesn't depend on any language preference at
// all. It's approximate (VPNs, travel, multi-country zones like
// Asia/Kolkata) and intentionally covers only the countries/regions this
// repo already ships a matching Rule Source for (config.js's
// RULES_REMOTE_URL `lang` entries) — not every IANA zone or minority
// language, just enough to catch the "UI language disagrees with actual
// current region" gap the same way navigator.language catches "UI language
// disagrees with content language" above.
var TIMEZONE_LANG_MAP = {
  'Asia/Ho_Chi_Minh': ['vi'], 'Asia/Saigon': ['vi'],
  'Asia/Shanghai': ['zh'], 'Asia/Chongqing': ['zh'], 'Asia/Harbin': ['zh'],
  'Asia/Urumqi': ['zh', 'ug'], 'Asia/Kashgar': ['ug'],
  'Asia/Taipei': ['zh'], 'Asia/Hong_Kong': ['zh'], 'Asia/Macau': ['zh'],
  'Asia/Tokyo': ['ja'],
  'Asia/Seoul': ['ko'],
  'Asia/Bangkok': ['th'],
  'Asia/Jakarta': ['id'], 'Asia/Makassar': ['id'], 'Asia/Jayapura': ['id'], 'Asia/Pontianak': ['id'],
  'Asia/Kuala_Lumpur': ['ms'], 'Asia/Kuching': ['ms'],
  'Asia/Kolkata': ['hi', 'bn', 'gu', 'kn', 'ml', 'mr', 'pa', 'ta', 'te', 'as'],
  'Asia/Colombo': ['si', 'ta'],
  'Asia/Kathmandu': ['ne'],
  'Asia/Dhaka': ['bn'],
  'Asia/Kabul': ['ps', 'fa'],
  'Asia/Dushanbe': ['tg'],
  'Asia/Tehran': ['fa'],
  'Asia/Baghdad': ['ar'], 'Asia/Riyadh': ['ar'], 'Asia/Dubai': ['ar'], 'Asia/Kuwait': ['ar'],
  'Asia/Qatar': ['ar'], 'Asia/Bahrain': ['ar'], 'Asia/Muscat': ['ar'], 'Asia/Aden': ['ar'],
  'Asia/Amman': ['ar'], 'Asia/Beirut': ['ar'], 'Asia/Damascus': ['ar'], 'Asia/Gaza': ['ar'], 'Asia/Hebron': ['ar'],
  'Asia/Jerusalem': ['he'], 'Asia/Tel_Aviv': ['he'],
  'Asia/Nicosia': ['el'], 'Asia/Famagusta': ['el'],
  'Asia/Almaty': ['kk'], 'Asia/Qyzylorda': ['kk'], 'Asia/Aqtau': ['kk'], 'Asia/Aqtobe': ['kk'],
  'Asia/Tashkent': ['uz'], 'Asia/Samarkand': ['uz'],
  'Asia/Yekaterinburg': ['ru'], 'Asia/Novosibirsk': ['ru'], 'Asia/Krasnoyarsk': ['ru'],
  'Asia/Irkutsk': ['ru'], 'Asia/Vladivostok': ['ru'],
  'Europe/Moscow': ['ru'], 'Europe/Kaliningrad': ['ru'], 'Europe/Samara': ['ru'],
  'Europe/Kyiv': ['uk'], 'Europe/Kiev': ['uk'], 'Europe/Simferopol': ['uk'],
  'Europe/Minsk': ['be'],
  'Africa/Algiers': ['ar', 'kab'], 'Africa/Tunis': ['ar'], 'Africa/Tripoli': ['ar'], 'Africa/Casablanca': ['ar'],
  'Africa/Cairo': ['ar'], 'Africa/Khartoum': ['ar'], 'Africa/Nouakchott': ['ar'], 'Africa/Djibouti': ['ar'],
  'Europe/Tirane': ['sq'],
  'Europe/Sofia': ['bg'], 'Europe/Skopje': ['mk'],
  'Europe/Prague': ['cs'], 'Europe/Bratislava': ['sk'],
  'Europe/Berlin': ['de'], 'Europe/Vienna': ['de'], 'Europe/Zurich': ['de'],
  'Europe/Luxembourg': ['de', 'lb', 'fr'], 'Europe/Busingen': ['de'],
  'Europe/Tallinn': ['et'],
  'Europe/Helsinki': ['fi'],
  'Europe/Paris': ['fr'], 'Europe/Brussels': ['fr', 'nl'], 'America/Montreal': ['fr'], 'America/Toronto': ['fr'],
  'Indian/Reunion': ['fr'], 'Pacific/Noumea': ['fr'],
  'Europe/Athens': ['el'],
  'Europe/Zagreb': ['hr'], 'Europe/Belgrade': ['sr'], 'Europe/Sarajevo': ['bs'], 'Europe/Podgorica': ['sr'],
  'Europe/Budapest': ['hu'],
  'Atlantic/Reykjavik': ['is'],
  'Europe/Rome': ['it'], 'Europe/San_Marino': ['it'], 'Europe/Vatican': ['it'],
  'Europe/Vilnius': ['lt'],
  'Europe/Riga': ['lv'],
  'Europe/Amsterdam': ['nl'],
  'Europe/Oslo': ['nb', 'no'], 'Europe/Copenhagen': ['da'],
  'Europe/Warsaw': ['pl'],
  'Europe/Bucharest': ['ro'], 'Europe/Chisinau': ['ro'],
  'Europe/Madrid': ['es'], 'Atlantic/Canary': ['es'],
  'America/Mexico_City': ['es'], 'America/Bogota': ['es'], 'America/Argentina/Buenos_Aires': ['es'],
  'America/Lima': ['es'], 'America/Santiago': ['es'], 'America/Caracas': ['es'],
  'Europe/Lisbon': ['pt'], 'Atlantic/Madeira': ['pt'], 'America/Sao_Paulo': ['pt'],
  'Europe/Ljubljana': ['sl'],
  'Europe/Stockholm': ['sv'],
  'Europe/Istanbul': ['tr'],
};
try { self.TIMEZONE_LANG_MAP = TIMEZONE_LANG_MAP; } catch (e) {}

function timezoneLangCandidates() {
  try {
    if (typeof Intl === 'undefined' || !Intl.DateTimeFormat) return [];
    var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return (tz && TIMEZONE_LANG_MAP[tz]) || [];
  } catch (e) { return []; }
}
try { self.timezoneLangCandidates = timezoneLangCandidates; } catch (e) {}
