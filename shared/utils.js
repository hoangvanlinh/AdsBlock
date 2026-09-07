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
// listMatchesEnvironment() uses only this) and
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
