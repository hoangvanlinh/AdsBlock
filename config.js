// config.js — shared constants, single source of truth for every context.
// How each context loads this file:
//   - Chrome service worker : importScripts('config.js') at the top of background.js
//   - Firefox background    : listed before background.js in background.scripts
//   - Content scripts       : listed first in the content_scripts js array
//   - Dashboard page        : <script src="../config.js"> before dashboard.js
// `self` works in all of them (worker, window, isolated world).
self.ADBLOCK_CONFIG = {
  // Built-in default Rule Sources — each fetched and merged unless the user
  // disables it from the dashboard's Rule Source page (per-URL toggle,
  // stored separately; `enable` here is just the ship-time default for a
  // fresh install). A URL that serves raw ABP/uBO filter-list syntax
  // (EasyList, region lists, ...) is fine here too — fetchRemoteRuleText()
  // detects and converts it to this repo's own grammar automatically.
  //
  // `lang` (optional — a BCP-47 primary subtag e.g. 'vi', 'ja', or an array
  // of them when a list covers several languages) marks a source as
  // region/language-specific. On a fresh install (onInstalled, reason
  // 'install' only — never on update/reload), background.js compares each
  // `lang` entry against chrome.i18n.getUILanguage() and auto-enables the
  // ones that match, so e.g. a Vietnamese-language browser gets the Vietnam
  // list turned on without a trip to the dashboard. `enable: false` is the
  // right ship-time default for these — they should stay off for everyone
  // else, not on-by-default the way a language-agnostic source is.
  //
  // The region entries below are every asset tagged `"group": "regions"` in
  // uBlock Origin's own asset list (github.com/gorhill/uBlock — assets.json)
  // as of 2026-08-22, one entry per list (first mirror URL when an asset
  // lists more than one). Re-pull that file and re-filter on group ===
  // 'regions' to refresh this set instead of hand-editing entries in place.
  RULES_REMOTE_URL: [
    { name: 'Default site rules', url: 'https://raw.githubusercontent.com/hoangvanlinh/AdsBlock/refs/heads/main/rule/site-rules.txt', enable: true, group: "default" },
    { name: 'EasyList', url: 'https://easylist.to/easylist/easylist.txt', enable: false, group: "easylist" },
    { name: 'EasyPrivacy', url: 'https://easylist.to/easylist/easyprivacy.txt', enable: false, group: "easylist" },
    { name: 'EasyList Cookie List', url: 'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt', enable: false, group: "easylist" },
    { name: 'Fanboy\'s Annoyance List', url: 'https://secure.fanboy.co.nz/fanboy-annoyance.txt', enable: false, group: "easylist" },
    { name: 'Fanboy\'s Social Blocking List', url: 'https://easylist.to/easylist/fanboy-social.txt', enable: false, group: "easylist" },
    { name: 'Albania — Adblock List for Albania', url: 'https://raw.githubusercontent.com/AnXh3L0/blocklist/master/albanian-easylist-addition/Albania.txt', enable: false, lang: ['sq'], group: "language" },
    { name: 'Arabic — Liste AR', url: 'https://easylist-downloads.adblockplus.org/Liste_AR.txt', enable: false, lang: ['ar', 'kab'], group: "language" },
    { name: 'Bulgaria — Bulgarian Adblock list', url: 'https://stanev.org/abp/adblock_bg.txt', enable: false, lang: ['bg', 'mk'], group: "language" },
    { name: 'China/Taiwan — AdGuard Chinese (中文)', url: 'https://filters.adtidy.org/extension/ublock/filters/224.txt', enable: false, lang: ['ug', 'zh'], group: "language" },
    { name: 'Czech/Slovakia — EasyList Czech and Slovak', url: 'https://raw.githubusercontent.com/tomasko126/easylistczechandslovak/master/filters.txt', enable: false, lang: ['cs', 'sk'], group: "language" },
    { name: 'Germany/Austria/Switzerland — EasyList Germany', url: 'https://easylist.to/easylistgermany/easylistgermany.txt', enable: false, lang: ['de', 'dsb', 'hsb', 'lb', 'rm'], group: "language" },
    { name: 'Estonia — Eesti saitidele kohandatud filter', url: 'https://ubo-et.lepik.io/list.txt', enable: false, lang: ['et'], group: "language" },
    { name: 'Finland — Adblock List for Finland', url: 'https://raw.githubusercontent.com/finnish-easylist-addition/finnish-easylist-addition/gh-pages/Finland_adb.txt', enable: false, lang: ['fi'], group: "language" },
    { name: 'France/Belgium/Canada — AdGuard Français', url: 'https://filters.adtidy.org/extension/ublock/filters/16.txt', enable: false, lang: ['ar', 'br', 'ff', 'fr', 'kab', 'lb', 'oc', 'son'], group: "language" },
    { name: 'Greece/Cyprus — Greek AdBlock Filter', url: 'https://www.void.gr/kargig/void-gr-filters.txt', enable: false, lang: ['el'], group: "language" },
    { name: 'Croatia/Serbia — Dandelion Sprout\'s Serbo-Croatian filters', url: 'https://raw.githubusercontent.com/DandelionSprout/adfilt/master/SerboCroatianList.txt', enable: false, lang: ['bs', 'hr', 'sr'], group: "language" },
    { name: 'Hungary — hufilter', url: 'https://cdn.jsdelivr.net/gh/hufilter/hufilter@gh-pages/hufilter-ublock.txt', enable: false, lang: ['hu'], group: "language" },
    { name: 'Indonesia/Malaysia — ABPindo', url: 'https://raw.githubusercontent.com/ABPindo/indonesianadblockrules/master/subscriptions/abpindo.txt', enable: false, lang: ['id', 'ms'], group: "language" },
    { name: 'India/Sri Lanka/Nepal — IndianList', url: 'https://easylist-downloads.adblockplus.org/indianlist.txt', enable: false, lang: ['as', 'bn', 'gu', 'hi', 'kn', 'ml', 'mr', 'ne', 'pa', 'sat', 'si', 'ta', 'te'], group: "language" },
    { name: 'Iran — PersianBlocker', url: 'https://raw.githubusercontent.com/MasterKia/PersianBlocker/main/PersianBlocker.txt', enable: false, lang: ['fa', 'ps', 'tg'], group: "language" },
    { name: 'Iceland — Icelandic ABP List', url: 'https://raw.githubusercontent.com/brave/adblock-lists/master/custom/is.txt', enable: false, lang: ['is'], group: "language" },
    { name: 'Israel — EasyList Hebrew', url: 'https://raw.githubusercontent.com/easylist/EasyListHebrew/master/EasyListHebrew.txt', enable: false, lang: ['he'], group: "language" },
    { name: 'Italy — EasyList Italy', url: 'https://easylist-downloads.adblockplus.org/easylistitaly.txt', enable: false, lang: ['fur', 'it', 'lij', 'sc'], group: "language" },
    { name: 'Japan — AdGuard Japanese', url: 'https://filters.adtidy.org/extension/ublock/filters/7.txt', enable: false, lang: ['ja'], group: "language" },
    { name: 'Korea — 한국어 (Korean)', url: 'https://cdn.jsdelivr.net/npm/@filteringdev/filterslists-ko@latest/dist/filterslist-uBlockOrigin-classic.txt', enable: false, lang: ['ko'], group: "language" },
    { name: 'Lithuania — EasyList Lithuania', url: 'https://raw.githubusercontent.com/EasyList-Lithuania/easylist_lithuania/master/easylistlithuania.txt', enable: false, lang: ['lt'], group: "language" },
    { name: 'Latvia — Latvian List', url: 'https://raw.githubusercontent.com/Latvian-List/adblock-latvian/master/lists/latvian-list.txt', enable: false, lang: ['lv'], group: "language" },
    { name: 'North Macedonia — Macedonian adBlock Filters', url: 'https://raw.githubusercontent.com/DeepSpaceHarbor/Macedonian-adBlock-Filters/master/Filters', enable: false, lang: ['mk'], group: "language" },
    { name: 'Netherlands/Belgium — AdGuard Dutch', url: 'https://filters.adtidy.org/extension/ublock/filters/8.txt', enable: false, lang: ['af', 'fy', 'nl'], group: "language" },
    { name: 'Norway/Denmark/Iceland — Dandelion Sprouts nordiske filtre', url: 'https://raw.githubusercontent.com/DandelionSprout/adfilt/master/NorwegianList.txt', enable: false, lang: ['nb', 'nn', 'no', 'da', 'is'], group: "language" },
    { name: 'Poland — Oficjalne Polskie Filtry do uBlocka Origin', url: 'https://raw.githubusercontent.com/MajkiIT/polish-ads-filter/master/polish-adblock-filters/adblock.txt', enable: false, lang: ['szl', 'pl'], group: "language" },
    { name: 'Poland — CERT.PL\'s Warning List', url: 'https://hole.cert.pl/domains/v2/domains_ublock.txt', enable: false, lang: ['szl', 'pl'], group: "language" },
    { name: 'Romania/Moldova — Romanian Ad (ROad) Block List Light', url: 'https://raw.githubusercontent.com/tcptomato/ROad-Block/master/road-block-filters-light.txt', enable: false, lang: ['ro'], group: "language" },
    { name: 'Russia/Ukraine/Uzbekistan/Kazakhstan — RU AdList', url: 'https://raw.githubusercontent.com/easylist/ruadlist/master/RuAdList-uBO.txt', enable: false, lang: ['be', 'kk', 'tt', 'ru', 'uz'], group: "language" },
    { name: 'Russia/Ukraine/Uzbekistan/Kazakhstan — RU AdList: Counters', url: 'https://raw.githubusercontent.com/easylist/ruadlist/master/cntblock.txt', enable: false, group: "language" },
    { name: 'Spain/Latin America — EasyList Spanish', url: 'https://easylist-downloads.adblockplus.org/easylistspanish.txt', enable: false, lang: ['an', 'ast', 'ca', 'cak', 'es', 'eu', 'gl', 'gn', 'trs', 'quz'], group: "language" },
    { name: 'Spain/Latin America — AdGuard Spanish/Portuguese', url: 'https://filters.adtidy.org/extension/ublock/filters/9.txt', enable: false, lang: ['an', 'ast', 'ca', 'cak', 'es', 'eu', 'gl', 'gn', 'trs', 'pt', 'quz'], group: "language" },
    { name: 'Slovenia — Slovenian List', url: 'https://raw.githubusercontent.com/betterwebleon/slovenian-list/master/filters.txt', enable: false, lang: ['sl'], group: "language" },
    { name: 'Sweden — Frellwit\'s Swedish Filter', url: 'https://raw.githubusercontent.com/lassekongo83/Frellwits-filter-lists/master/Frellwits-Swedish-Filter.txt', enable: false, lang: ['sv'], group: "language" },
    { name: 'Thailand — EasyList Thailand', url: 'https://raw.githubusercontent.com/easylist-thailand/easylist-thailand/master/subscription/easylist-thailand.txt', enable: false, lang: ['th'], group: "language" },
    { name: 'Turkey — AdGuard Turkish', url: 'https://filters.adtidy.org/extension/ublock/filters/13.txt', enable: false, lang: ['tr'], group: "language" },
    { name: 'Ukraine — AdGuard Ukrainian', url: 'https://filters.adtidy.org/extension/ublock/filters/23.txt', enable: false, lang: ['uk'], group: "language" },
    { name: 'Vietnam — ABPVN List', url: 'https://raw.githubusercontent.com/abpvn/abpvn/master/filter/abpvn_ublock.txt', enable: false, lang: ['vi'], group: "language" },
  ],
  RULES_LOCAL_PATH: 'rule/site-rules.txt',
  RULES_CACHE_TEXT_KEY: 'siteRulesCacheText',
  RULES_CACHE_TIME_KEY: 'siteRulesCacheTime',
  RULES_CACHE_TTL_MS: 6 * 60 * 60 * 1000,
  // fetchRemoteRuleText() (background.js) records a { [url]: message } entry
  // here for every URL source that fails to fetch, and clears it on the next
  // successful fetch of that same URL — the dashboard's Rule Source page
  // reads this to show an inline error per row, unconditionally (no
  // "is this enabled" gating — a disabled source can't fail since it's
  // never fetched, so there's nothing to gate).
  RULE_SOURCE_ERRORS_KEY: 'ruleSourceErrors',
  // Same idea as RULE_SOURCE_ERRORS_KEY but for an ABP-format source that
  // fetched fine yet had some of its rules silently dropped during
  // conversion (unsupported syntax, procedural selectors, AdGuard-extended
  // modifiers, unmapped scriptlets, ...) — a { [url]: skipStats } map,
  // skipStats being _abpEmptySkipStats()'s shape (background.js). A source
  // that ISN'T ABP-format (this repo's own grammar, passed through
  // unchanged) never gets an entry here at all — there's nothing to report.
  RULE_SOURCE_STATS_KEY: 'ruleSourceStats',
  // Same GitHub repo rule/site-rules.txt is already trusted from — reusing
  // it for a version check means one canonical source, not a second thing
  // to remember to update on release. Deliberately NOT the user-configurable
  // extra rule-source URLs (dashboard's Rule Source page) — this must stay
  // pinned to the real repo regardless of what rule sources a user adds.
  // Two separate manifests, two separate version numbers that CAN and DO
  // drift out of sync (Chrome/Firefox/Edge stores review and publish on
  // their own schedules) — Edge reuses the Chrome manifest (see
  // build-edge.sh's own comment), Firefox does not. Picking the wrong one
  // would compare a Firefox install's version against Chrome's release
  // cadence, showing a false "update available" or missing a real one.
  EXTENSION_META_REMOTE_URL: 'https://raw.githubusercontent.com/hoangvanlinh/AdsBlock/refs/heads/main/manifest.json',
  EXTENSION_META_REMOTE_URL_FIREFOX: 'https://raw.githubusercontent.com/hoangvanlinh/AdsBlock/refs/heads/main/manifest.firefox.json',
  // Single source for every "take the user to our store listing" link —
  // used by both the popup's review-prompt banner and its update-available
  // chip, and the dashboard's update-available link, so they can never
  // drift out of sync with each other the way REVIEW_STORE_URLS (popup.js)
  // and UPDATE_STORE_URLS (dashboard.js) used to (same store, two
  // independently-hand-maintained URL literals, chrome+firefox happened to
  // point at the /reviews subpage but edge didn't — an easy-to-miss
  // inconsistency with two copies, impossible with one).
  STORE_URLS: {
    firefox: 'https://addons.mozilla.org/firefox/addon/adblock-ads-trackers',
    edge:    'https://microsoftedge.microsoft.com/addons/detail/pbhhhdiineoaofllgkipegloafcpiaml',
    chrome:  'https://chromewebstore.google.com/detail/adblock-%E2%80%94-ads-trackers/emdofgiggmkkncojffpebiaegdmdkgio',
  },
  // Debug builds (./build.sh <target> <obf> <export> true) flip this to true:
  // every context (background DNR rules + content rule loader) then reads the
  // bundled rule/site-rules.txt instead of cache/remote, so local rule edits
  // take effect on extension reload without pushing to GitHub.
  DEBUG_LOCAL: false,
};
