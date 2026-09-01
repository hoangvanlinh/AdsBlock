// background.js — AdBlock Service Worker (Manifest V3)
// Handles: network blocking (declarativeNetRequest) + message routing

// Shared constants live in config.js (single source of truth).
// Chrome MV3 service worker: importScripts. Firefox background page:
// importScripts does not exist there — config.js is listed before this
// file in background.scripts instead, so ADBLOCK_CONFIG is already set.
if (typeof importScripts === 'function' && !self.ADBLOCK_CONFIG) {
  importScripts('config.js');
}
// browser-compat.js (repo root, same dual-loading story as config.js) —
// defines self.EXT (shared chrome./browser. alias) and self.EXT_SESSION_STORAGE.
if (typeof importScripts === 'function' && !self.EXT) {
  importScripts('browser-compat.js');
}
// utils.js (repo root shared/, same dual-loading story) — defines
// langCandidates(), which both _candidateUILanguages() below and
// i18n.js's own "Auto" resolution build on. Must load before i18n.js.
if (typeof importScripts === 'function' && !self.langCandidates) {
  importScripts('utils.js');
}
// i18n.js (repo root shared/, same dual-loading story) — installs the
// manual-language-override EXT.i18n.getMessage() wrapper every
// getMessage() call in this file already goes through unmodified, and
// exposes self.EXT_I18N_READY (awaited below before creating context menus,
// so a non-"auto" Settings choice is reflected in the menu titles too).
if (typeof importScripts === 'function' && !self.EXT_I18N_READY) {
  importScripts('i18n.js');
}
// scriptlet-alias-map.js (repo root, same place as config.js — both are
// shared across contexts: background.js here, scripts/convert-uassets.js and
// scripts/convert-regions.js via `require()` offline, and both get copied to
// the build root by _build-lib.sh's copy_static_files(), unlike scripts/
// itself which is dev-only tooling never packaged into a built extension).
// Dual-exports so this one runtime importScripts() picks up the identical
// data (see that file's own dual-export comment) instead of forking a
// second copy that could drift.
if (typeof importScripts === 'function' && !self.SCRIPTLET_ALIAS_MAP) {
  importScripts('scriptlet-alias-map.js');
}
// local-storage.js (repo root shared/, same dual-loading story) — must load
// AFTER browser-compat.js (needs self.EXT) and BEFORE session-storage.js
// (its own storage.local fallback calls into this module).
if (typeof importScripts === 'function' && !self.LocalStorage) {
  importScripts('local-storage.js');
}
// session-storage.js (repo root shared/, same dual-loading story) — must
// load AFTER browser-compat.js (needs self.EXT_SESSION_STORAGE) and
// local-storage.js (its own local fallback uses self.LocalStorage), and
// before any of this file's own top-level code touches self.SessionStorage.
if (typeof importScripts === 'function' && !self.SessionStorage) {
  importScripts('session-storage.js');
}
const {
  RULES_REMOTE_URL,
  RULES_LOCAL_PATH,
  RULES_CACHE_TEXT_KEY,
  RULES_CACHE_TIME_KEY,
  RULES_CACHE_TTL_MS,
  RULE_SOURCE_ERRORS_KEY,
  RULE_SOURCE_STATS_KEY,
  DEBUG_LOCAL,
  EXTENSION_META_REMOTE_URL,
  EXTENSION_META_REMOTE_URL_FIREFOX,
} = self.ADBLOCK_CONFIG;

// Resolution logic (browser.storage.session preferred over the chrome.*
// compat shim) now lives in browser-compat.js as self.EXT_SESSION_STORAGE —
// see that file for why. Live-reproduced 2026-08-25: on that build,
// chrome.storage.session.get/set/getBytesInUse all worked but
// .setAccessLevel was undefined on BOTH chrome.storage.session and
// browser.storage.session — so preferring browser.* alone isn't expected to
// fix that specific case, but it's the same call uBOL itself makes and
// removes any doubt about whether the compat shim specifically was the gap.
var _sessionStorage = self.EXT_SESSION_STORAGE;

// Grants content scripts (untrusted contexts) direct _sessionStorage
// access — default access level is TRUSTED_CONTEXTS only (background/extension
// pages), so without this a content script's own storage.session.get/
// set calls silently no-op or reject. Must be (re)called every time this
// service worker starts, not just on install — the access level does not
// reliably survive a SW restart. See site-block.js's DIRECT_CSS_FASTPATH_KEY
// fast-path cache, which needs this (data lives in the extension's own
// storage, never the page's — chrome.storage.session isn't reachable from
// page JS under any circumstance, unlike the page's own localStorage).
// Takes an { accessLevel } OPTIONS OBJECT, not a bare string — a bare string
// throws SYNCHRONOUSLY ("No matching signature"), live-reproduced 2026-08-25
// sitting at the TOP of this file with nothing around it: an uncaught
// synchronous throw here would abort the rest of this script's top-level
// evaluation, not just silently skip this one grant. try/catch below guards
// the synchronous form of that failure; .catch() guards an async rejection
// from a call that DID match the signature but still failed for some other
// reason (old browser, disabled API, etc.) — need both, one doesn't cover
// the other.
try {
  _sessionStorage?.setAccessLevel?.({accessLevel:'TRUSTED_AND_UNTRUSTED_CONTEXTS'})
    ?.catch(e => console.error('[AdBlock] storage.session.setAccessLevel rejected — content-script fast-path caches will silently no-op:', e));
} catch (e) {
  console.error('[AdBlock] storage.session.setAccessLevel threw synchronously — content-script fast-path caches will silently no-op:', e);
}

const FALLBACK_RULE_CONFIG = {
  adNetworkPatterns: ['doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adnxs.com', 'outbrain.com', 'taboola.com', 'ads.yahoo.com', 'amazon-adsystem.com', 'media.net', 'criteo.com'],
  trackerNetworkPatterns: ['google-analytics.com', 'analytics.google.com', 'facebook.com/tr', 'hotjar.com', 'mixpanel.com', 'segment.com', 'amplitude.com', 'fullstory.com', 'clarity.ms', 'quantserve.com'],
  malwareNetworkDomains: ['malware-check.disconnect.me', 'phishing.example.net', 'dl.free-counter.co.uk', 'naifrede.com', 'clafrfrede.com', 'coinhive.com', 'coin-hive.com', 'jsecoin.com', 'crypto-loot.com', 'authedmine.com', '0-internal.paypal.com.de', 'apple-icloud.org.uk', 'login-microsoft-office.com', 'secure-login-bank.com', 'netflix-account.com', 'installcore.net', 'softonic-analytics.net', 'bonzi.software', 'adf.ly', 'sh.st', 'ad-maven.com', 'propellerads.com', 'rig-exploit.com', 'exploit-kit-check.net', 'mspy.com', 'flexispy.com', 'virus-alert-windows.com', 'your-pc-is-infected.com', 'push-notification.tools', 'notification-service.club'],
  adPatterns: ['doubleclick', 'googlesyndication', 'googleadservices', 'adnxs', 'outbrain', 'taboola', 'amazon-adsystem', 'media.net', 'criteo', 'advertising.com', 'pubmatic', 'openx.net', 'rubiconproject'],
  trackerPatterns: ['google-analytics.com', 'analytics.google.com', 'facebook.com/tr', 'hotjar.com', 'mixpanel.com', 'segment.com', 'amplitude.com', 'fullstory.com', 'clarity.ms', 'quantserve.com'],
  malwarePatterns: ['coinhive', 'coin-hive', 'jsecoin', 'crypto-loot', 'authedmine', 'cryptonight', 'minero.cc'],
};

let DEFAULT_RULES = [];
let MALWARE_RULES = [];
let AD_MAINFRAME_RULES = [];
let TRACKER_RULE_IDS = new Set();
let MALWARE_RULE_IDS = new Set();
let QUERY_STRIP_RULES = [];
let NETWORK_REDIRECT_RULES = [];
let NETWORK_BLOCK_RULES = [];
let _ruleConfigPromise = null;

const QUERY_STRIP_RESOURCE_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other'];

// Hard backstop for buildActiveRulesFromStorage()'s final rule count — belt
// AND suspenders alongside NETWORK_RULE_BUDGET's own cap. NETWORK_RULE_BUDGET
// is a hand-tuned SOFT preference (live-measured against today's filter-list
// content — see [[abp-path-scoped-network-rule-conversion]] memory) that can
// go stale as EasyList/AdGuard/etc. grow over time or new default Rule
// Sources get added later; this reads the browser's OWN real runtime
// constants instead of hardcoding a number, so it stays correct even if
// those values ever change.
//
// 2026-08-31 correction (a first pass here wrongly assumed one flat 30000
// limit and read the WRONG, deprecated property — see memory for the full
// story): Chrome/Edge 120+ actually split dynamic rules into TWO INDEPENDENT
// quotas by action.type — MAX_NUMBER_OF_DYNAMIC_RULES = 30000 for "safe"
// rules (block/allow/allowAllRequests/upgradeScheme) and
// MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES = 5000 for "unsafe" rules (redirect/
// modifyHeaders/anything else) — a redirect rule does NOT compete with a
// block rule for the same pool. This repo's DEFAULT_RULES (ad/tracker
// bait-detector redirects), network_redirect_rules, strip_query_params, and
// the ad/malware main_frame warning-page redirects are ALL 'redirect' type
// — i.e. the unsafe pool, not the 30000 one. Firefox does NOT split these:
// MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES is never exposed there, and its single
// MAX_NUMBER_OF_DYNAMIC_RULES (5000, confirmed via MDN 2026-08-31) covers
// EVERY dynamic rule together regardless of action type — Firefox needs
// this backstop MORE than Chrome, not less; there is no "Firefox doesn't
// need a limit" case. Same flat-shared-pool behavior on legacy Chrome/
// Firefox that still only expose the older, deprecated
// MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES (also a flat 5000, pre-Chrome-120/
// pre-Firefox-126).
const SAFE_DNR_ACTION_TYPES = new Set(['block', 'allow', 'allowAllRequests', 'upgradeScheme']);

// Returns { maxSafe, maxUnsafe, shared }. `shared: true` means maxSafe ===
// maxUnsafe and both action categories draw from the SAME pool (Firefox, or
// legacy pre-split Chrome) — the trim below must track ONE combined counter
// in that case, not two independent ones, or it would let up to
// maxSafe+maxUnsafe total through instead of just maxSafe.
function _dynamicRuleLimits() {
  const dnr = EXT.declarativeNetRequest || {};
  const num = v => (typeof v === 'number' && v > 0) ? v : undefined;
  const safeCap = num(dnr.MAX_NUMBER_OF_DYNAMIC_RULES);
  const unsafeCap = num(dnr.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES);
  if (safeCap !== undefined && unsafeCap !== undefined) {
    return { maxSafe: safeCap, maxUnsafe: unsafeCap, shared: false };
  }
  const flatCap = safeCap !== undefined ? safeCap : num(dnr.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES);
  return { maxSafe: flatCap, maxUnsafe: flatCap, shared: true };
}

// Trims `rules` (already ordered highest-priority-to-keep FIRST) down to
// whatever this browser's REAL limits are, dropping lowest-priority entries
// within whichever pool(s) actually overflow — never dropping a
// higher-priority rule ahead of a lower-priority one within the same pool.
// No-op (returns `rules` unchanged) when neither limit is exposed at all
// (e.g. this repo's own Node test harness unless it stubs these).
function _trimToDynamicRuleLimits(rules) {
  const { maxSafe, maxUnsafe, shared } = _dynamicRuleLimits();
  if (maxSafe === undefined && maxUnsafe === undefined) return rules;
  const kept = [];
  let safeCount = 0, unsafeCount = 0, sharedCount = 0;
  let droppedSafe = 0, droppedUnsafe = 0;
  for (const rule of rules) {
    const isSafe = SAFE_DNR_ACTION_TYPES.has(rule.action && rule.action.type);
    if (shared) {
      if (maxSafe !== undefined && sharedCount >= maxSafe) { isSafe ? droppedSafe++ : droppedUnsafe++; continue; }
      sharedCount++;
    } else if (isSafe) {
      if (maxSafe !== undefined && safeCount >= maxSafe) { droppedSafe++; continue; }
      safeCount++;
    } else {
      if (maxUnsafe !== undefined && unsafeCount >= maxUnsafe) { droppedUnsafe++; continue; }
      unsafeCount++;
    }
    kept.push(rule);
  }
  if (droppedSafe || droppedUnsafe) {
    console.warn(`[AdBlock] built ${rules.length} dynamic rules, over this browser's real limit(s) — trimmed ${droppedSafe} lowest-priority safe (block/allow/allowAllRequests) + ${droppedUnsafe} lowest-priority unsafe (redirect/modifyHeaders) rules so updateDynamicRules() still succeeds instead of Chrome rejecting the whole batch`);
  }
  return kept;
}

// Chrome DNR's documented urlFilter constraints (developer.chrome.com/docs/
// extensions/reference/api/declarativeNetRequest#type-RuleCondition): must
// be non-empty ASCII, a pattern starting with "||*" is explicitly
// disallowed, and '|' is only valid as the very first/last character (or as
// the first TWO characters together, the "||" domain anchor). Chrome's
// updateDynamicRules() call is ATOMIC — one rule anywhere with an invalid
// urlFilter/requestDomains value rejects the ENTIRE call (live-reported
// 2026-08-24: "Rule with id 500009 specifies an incorrect value for the
// urlFilter key" from adding a third-party ABP list — network_redirect_rules/
// strip_query_params entries get a raw '||'+pattern urlFilter built directly
// from arbitrary ABP-source text with no sanitization at all, unlike
// buildPatternRules() elsewhere in this file, which at least checks
// DOMAIN_PATTERN_RE before routing a pattern to requestDomains). Validating
// here — same "don't guess, drop what we can't confidently honor" rule this
// file already applies to unmapped scriptlets/resource names — means one bad
// line from a third-party list can no longer take down every rule this
// extension has, default site-rules.txt included.
function _isValidUrlFilter(f) {
  if (!f || !/^[\x00-\x7F]*$/.test(f)) return false;
  if (f.startsWith('||*')) return false;
  for (let i = 0; i < f.length; i++) {
    if (f[i] !== '|') continue;
    const partOfDomainAnchor = (i === 0 && f[1] === '|') || (i === 1 && f[0] === '|');
    const leftAnchor = i === 0 && f[1] !== '|';
    const rightAnchor = i === f.length - 1;
    if (!(partOfDomainAnchor || leftAnchor || rightAnchor)) return false;
  }
  return true;
}

// Converts a Chrome DNR urlFilter (already validated by _isValidUrlFilter)
// into an equivalent JS RegExp, tested against a full URL string — needed
// ONLY for the webRequestBlocking engine (buildNetworkBlockMatcher() below):
// Firefox's plain webRequest API hands a raw URL string per request, not
// Chrome's own native urlFilter matcher, so this repo has to reimplement
// DNR's mini-language itself for that one path. Per Chrome's docs
// (developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest
// #type-RuleCondition): '||' at the very start anchors to a hostname label
// boundary (matches the scheme + optional "sub.domain." prefix immediately
// before the literal text that follows); a lone leading '|' anchors to the
// start of the whole URL; a trailing '|' anchors to the end; '*' matches any
// run of characters (including none); '^' matches a single "separator"
// character (anything that ISN'T a letter/digit/_/-/./%) OR end-of-string;
// every other character is literal. Deliberately NOT case-insensitive
// end-to-end: the domain portion is already lowercased wherever this repo
// builds one of these entries (matching a browser-normalized-lowercase
// request hostname), but the PATH portion stays case-sensitive on purpose —
// URL paths ARE case-sensitive (see _abpSplitNetworkPattern's own comment).
function _urlFilterToRegExp(urlFilter) {
  let i = 0;
  const end0 = urlFilter.length;
  let out = '';
  if (urlFilter.startsWith('||')) {
    out += '^[a-zA-Z][a-zA-Z0-9+.-]*:\\/\\/([^\\/]*\\.)?';
    i = 2;
  } else if (urlFilter.startsWith('|')) {
    out += '^';
    i = 1;
  }
  let end = end0;
  if (end > i && urlFilter[end - 1] === '|') end -= 1; // trailing anchor, handled after the loop
  for (; i < end; i++) {
    const c = urlFilter[i];
    if (c === '*') out += '.*';
    else if (c === '^') out += '(?:[^a-zA-Z0-9_.%-]|$)';
    else if (c === '|') out += '\\|'; // mid-string '|' — shouldn't occur (see _isValidUrlFilter), escape defensively
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  if (end !== end0) out += '$';
  return new RegExp(out);
}

// strip_query_params entries: "host[/pathSubstr] param1,param2[ doc]"
// — same-origin query-param removal (tracking IDs like YouTube's ?si=/?is=),
// doesn't need host permissions since the redirect target stays same-origin.
function buildQueryStripRules(entries, startId) {
  const rules = [];
  let id = startId;
  for (const entry of entries) {
    const parts = String(entry || '').trim().split(/\s+/);
    if (parts.length < 2) continue;
    const hostPath = parts[0];
    const params = parts[1].split(',').map(s => s.trim()).filter(Boolean);
    if (!params.length) continue;
    const slashIdx = hostPath.indexOf('/');
    const condition = {
      resourceTypes: parts[2] === 'doc' ? ['main_frame'] : QUERY_STRIP_RESOURCE_TYPES,
    };
    if (slashIdx === -1) {
      if (!DOMAIN_PATTERN_RE.test(hostPath)) continue; // malformed — don't guess, drop it
      condition.requestDomains = [hostPath.toLowerCase()];
    } else {
      const urlFilter = '||' + hostPath;
      if (!_isValidUrlFilter(urlFilter)) continue; // would reject the WHOLE updateDynamicRules() call
      condition.urlFilter = urlFilter;
    }
    rules.push({
      id: id++,
      priority: 1,
      action: { type: 'redirect', redirect: { transform: { queryTransform: { removeParams: params } } } },
      condition,
    });
  }
  return rules;
}

// network_redirect_rules entries: "urlPattern resourceName" — same
// domain-vs-path condition split as buildQueryStripRules above, but the
// action is a static-resource redirect (_resolveRedirectResourceName/
// _redirectAction) instead of a query-param strip. resourceName not
// resolving to a real shipped file (unknown alias, or a name that maps to
// a file this extension doesn't actually have) drops the whole entry —
// same "don't guess" rule as everywhere else a filter-syntax modifier
// can't be confidently honored.
function buildNetworkRedirectRules(entries, startId) {
  const rules = [];
  let id = startId;
  for (const entry of entries) {
    const parts = String(entry || '').trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pattern = parts[0];
    const file = _resolveRedirectResourceName(parts[1]);
    if (!file) continue;
    const condition = { resourceTypes: ['script'] }; // real-world redirect= rules are ~always script
    if (pattern.indexOf('/') === -1) {
      if (!DOMAIN_PATTERN_RE.test(pattern)) continue; // malformed — don't guess, drop it
      condition.requestDomains = [pattern.toLowerCase()];
    } else {
      const urlFilter = '||' + pattern;
      if (!_isValidUrlFilter(urlFilter)) continue; // would reject the WHOLE updateDynamicRules() call
      condition.urlFilter = urlFilter;
    }
    rules.push({ id: id++, priority: 1, action: _redirectAction(file), condition });
  }
  return rules;
}

// Decodes network_block_rules entries — see _abpEncodeNetworkBlockEntry's
// own comment for the "pattern types domains denyallow methods thirdParty"
// field layout ('*' = unrestricted, comma-separated multi-values, a '~'
// prefix = excluded rather than included) — into real DNR block rules.
// Always exactly ONE rule per entry, no matter how many types/domains it
// carries — unlike ad_network_patterns' buildPatternRules, which fans a
// single urlFilter out across one rule PER resourceType/redirect-file group
// (see ABP_SIMPLE_NETWORK_OPTS_RE's own comment for why that matters here).
// Same "one bad urlFilter must not reject the WHOLE updateDynamicRules()
// call" validation every other builder here already does.
function buildNetworkBlockRules(entries, startId) {
  const rules = [];
  let id = startId;
  for (const entry of entries) {
    const parts = String(entry || '').trim().split(/\s+/);
    if (parts.length !== 6) continue; // malformed — don't guess, drop it
    const [pattern, typesField, domainsField, denyallowField, methodsField, thirdPartyField] = parts;
    const urlFilter = '||' + pattern;
    if (!_isValidUrlFilter(urlFilter)) continue; // would reject the WHOLE updateDynamicRules() call
    const condition = { urlFilter };

    if (typesField !== '*') {
      const tokens = typesField.split(',');
      // _abpParseNetworkOptions never mixes included/excluded types in one
      // rule, so either every token here is '~'-prefixed or none are.
      if (tokens[0].charAt(0) === '~') condition.excludedResourceTypes = tokens.map(t => t.slice(1));
      else condition.resourceTypes = tokens;
    }
    if (domainsField !== '*') {
      const include = [], exclude = [];
      for (const d of domainsField.split(',')) {
        if (d.charAt(0) === '~') exclude.push(d.slice(1)); else include.push(d);
      }
      if (include.length) condition.initiatorDomains = include;
      if (exclude.length) condition.excludedInitiatorDomains = exclude;
    }
    if (denyallowField !== '*') condition.excludedRequestDomains = denyallowField.split(',');
    if (methodsField !== '*') {
      const include = [], exclude = [];
      for (const m of methodsField.split(',')) {
        if (m.charAt(0) === '~') exclude.push(m.slice(1)); else include.push(m);
      }
      if (include.length) condition.requestMethods = include;
      if (exclude.length) condition.excludedRequestMethods = exclude;
    }
    if (thirdPartyField === '1') condition.domainType = 'thirdParty';
    else if (thirdPartyField === '0') condition.domainType = 'firstParty';

    rules.push({ id: id++, priority: 1, action: { type: 'block' }, condition });
  }
  return rules;
}

// network_block_rules entries live under each domain's OWN [host_patterns]
// section (see _abpSplitNetworkPattern/_abpFinalizeGroups) — each entry
// there stores only the PATH portion (the field buildNetworkBlockRules
// expects as "pattern" is missing its domain prefix). This reconstructs the
// full entry by walking [host_patterns]' domain -> section-key mapping,
// prepending that domain onto every network_block_rules value found in the
// matching section, then hands the whole flat list to buildNetworkBlockRules
// unchanged. A '|'-joined bucket key (domainA|domainB — never produced by
// this converter's own forced single-domain rule for network_block_rules,
// but nothing stops a hand-written site-rules.txt from doing it) applies
// the same path/options to every domain in the group.
function buildDomainNetworkBlockRules(parsed, startId) {
  const hostPatterns = parsed.host_patterns || {};
  const entries = [];
  for (const domainKey in hostPatterns) {
    if (!Object.prototype.hasOwnProperty.call(hostPatterns, domainKey)) continue;
    const sectionKey = hostPatterns[domainKey] && hostPatterns[domainKey][0];
    const section = sectionKey && parsed[sectionKey];
    const pathEntries = section && section.network_block_rules;
    if (!pathEntries || !pathEntries.length) continue;
    for (const domain of domainKey.split('|')) {
      for (const pathEntry of pathEntries) {
        const parts = String(pathEntry || '').trim().split(/\s+/);
        if (parts.length !== 6) continue; // malformed — don't guess, drop it (buildNetworkBlockRules re-validates anyway)
        entries.push([domain + parts[0], ...parts.slice(1)].join(' '));
      }
    }
  }
  return buildNetworkBlockRules(entries, startId);
}

// Firefox-only sibling of buildDomainNetworkBlockRules() — same source data
// (parsed.host_patterns' per-domain network_block_rules entries) and the
// same 6-field decode as buildNetworkBlockRules() above, but the OUTPUT is a
// Map<domain, Array<matcherEntry>> for the webRequestBlocking listener to
// walk per-request, instead of DNR rule objects — Chrome/Edge keep using
// buildDomainNetworkBlockRules() unchanged; this function is never called on
// those browsers (gated by _hasWebRequestBlocking() at the call site).
// `regex` is built from the FULL '||domain+path' urlFilter (not just the
// path suffix) via _urlFilterToRegExp() — matching the whole request URL
// against one self-contained regex per entry mirrors Chrome's own anchored
// matching semantics exactly, rather than risking subtle drift from
// splitting "domain already matched via the Map key" from "now match just
// the remaining path" as two separate steps. The Map is purely a fast
// pre-filter (only test entries bucketed under a domain the request
// actually targets), not part of the match semantics itself.
function buildNetworkBlockMatcher(parsed) {
  const hostPatterns = parsed.host_patterns || {};
  const matcher = new Map();
  for (const domainKey in hostPatterns) {
    if (!Object.prototype.hasOwnProperty.call(hostPatterns, domainKey)) continue;
    const sectionKey = hostPatterns[domainKey] && hostPatterns[domainKey][0];
    const section = sectionKey && parsed[sectionKey];
    const pathEntries = section && section.network_block_rules;
    if (!pathEntries || !pathEntries.length) continue;
    for (const domain of domainKey.split('|')) {
      for (const pathEntry of pathEntries) {
        const parts = String(pathEntry || '').trim().split(/\s+/);
        if (parts.length !== 6) continue; // malformed — don't guess, drop it
        const [path, typesField, domainsField, denyallowField, methodsField, thirdPartyField] = parts;
        const urlFilter = '||' + domain + path;
        if (!_isValidUrlFilter(urlFilter)) continue;
        const entry = { regex: _urlFilterToRegExp(urlFilter) };
        if (typesField !== '*') {
          const tokens = typesField.split(',');
          if (tokens[0].charAt(0) === '~') entry.excludedResourceTypes = new Set(tokens.map(t => t.slice(1)));
          else entry.resourceTypes = new Set(tokens);
        }
        if (domainsField !== '*') {
          const include = new Map(), exclude = new Map();
          for (const d of domainsField.split(',')) { if (d.charAt(0) === '~') exclude.set(d.slice(1), true); else include.set(d, true); }
          if (include.size) entry.initiatorDomains = include;
          if (exclude.size) entry.excludedInitiatorDomains = exclude;
        }
        if (denyallowField !== '*') entry.excludedRequestDomains = new Map(denyallowField.split(',').map(d => [d, true]));
        if (methodsField !== '*') {
          const include = [], exclude = [];
          for (const m of methodsField.split(',')) { if (m.charAt(0) === '~') exclude.push(m.slice(1)); else include.push(m); }
          if (include.length) entry.requestMethods = new Set(include.map(m => m.toLowerCase()));
          if (exclude.length) entry.excludedRequestMethods = new Set(exclude.map(m => m.toLowerCase()));
        }
        if (thirdPartyField === '1') entry.domainType = 'thirdParty';
        else if (thirdPartyField === '0') entry.domainType = 'firstParty';
        if (!matcher.has(domain)) matcher.set(domain, []);
        matcher.get(domain).push(entry);
      }
    }
  }
  return matcher;
}

// Walks host's own registrable-domain suffixes ("sub.ads.example.com" ->
// "sub.ads.example.com", "ads.example.com", "example.com", "com") looking
// for a Map key — same technique content/content.js's _domainSetMatches()
// already uses for stats classification, reimplemented here (not literally
// imported) since content.js is a content-script file that never loads into
// the background page at all; the algorithm itself is only ~8 lines.
function _walkDomainMatches(map, host) {
  let h = host;
  while (h) {
    if (map.has(h)) return h;
    const dot = h.indexOf('.');
    if (dot === -1) break;
    h = h.slice(dot + 1);
  }
  return null;
}

// Extracts the registrable-ish initiating domain from a webRequest details
// object for $domain=/$denyallow=/thirdParty matching. Chrome's webRequest
// exposes `details.initiator` (origin string); Firefox's exposes
// `details.documentUrl` (the requesting frame/document's own URL) instead —
// try both rather than assuming one, so this stays correct regardless of
// which of the two ever actually reaches this code path.
function _requestInitiatorHost(details) {
  const raw = details.initiator || details.documentUrl || details.originUrl;
  if (!raw || raw === 'null') return null;
  try { return new URL(raw).hostname.toLowerCase(); } catch { return null; }
}

// The webRequestBlocking engine itself — Firefox-only (see
// _hasWebRequestBlocking()). Replaces TWO DNR tiers that independently
// exceed Firefox's flat 5000 dynamic-rule cap on their own: network_block_
// rules (buildDomainNetworkBlockRules/NETWORK_BLOCK_RULES) and the
// path-scoped half of remoteMalwarePathPatterns (buildRemoteMalwareRules'
// one-urlFilter-per-rule branch — live-measured 2026-08-31: URLhaus alone
// contributes ~9,857 of these). Every OTHER tier (ads/trackers, malware
// bare-domain blocks, custom rules, focus mode, network_redirect_rules,
// strip_query_params, privacy headers, pause/allow) stays on
// declarativeNetRequest unchanged on every browser, Firefox included. No
// rule-count ceiling applies to either matcher below — see
// NETWORK_RULE_BUDGET's own comment and fetchRemoteRuleText()'s/
// buildActiveRulesFromStorage()'s conditional handling of each.
let NETWORK_BLOCK_MATCHER = new Map();
// Map<domain, Array<RegExp>> — much simpler shape than NETWORK_BLOCK_MATCHER
// since remoteMalwarePathPatterns entries carry no options at all (no
// resourceTypes/domain=/method=/thirdParty — see buildRemoteMalwareRules'
// own comment: "one urlFilter per rule ... covering EVERY resource type in
// a single plain block").
let MALWARE_PATH_MATCHER = new Map();

// Same source/shape buildRemoteMalwareRules()'s path-pattern branch reads
// (already-full `||domain/path...^` urlFilter strings, no further
// decoding needed) — just compiled into regexes and bucketed by domain
// (via _abpSplitNetworkPattern, purely for fast lookup, same technique
// buildNetworkBlockMatcher() uses) instead of built into DNR rule objects.
function buildMalwarePathMatcher(pathPatterns) {
  const matcher = new Map();
  for (const urlFilter of pathPatterns || []) {
    if (!_isValidUrlFilter(urlFilter)) continue;
    const bare = urlFilter.startsWith('||') ? urlFilter.slice(2) : urlFilter;
    const { domain } = _abpSplitNetworkPattern(bare);
    const key = domain.toLowerCase();
    if (!key) continue;
    if (!matcher.has(key)) matcher.set(key, []);
    matcher.get(key).push(_urlFilterToRegExp(urlFilter));
  }
  return matcher;
}

// Total entry count across a Map<domain, Array<...>> matcher (NETWORK_BLOCK_
// MATCHER/MALWARE_PATH_MATCHER) — used by GET_RULE_COUNT so the popup's
// displayed count means "how many rules are actually enforced" on every
// browser, not just "how many are registered with declarativeNetRequest".
function _matcherEntryCount(map) {
  let n = 0;
  for (const arr of map.values()) n += arr.length;
  return n;
}

function _matchesNetworkBlockEntry(entry, details, requestHost) {
  if (!entry.regex.test(details.url)) return false;
  if (entry.resourceTypes && !entry.resourceTypes.has(details.type)) return false;
  if (entry.excludedResourceTypes && entry.excludedResourceTypes.has(details.type)) return false;
  if (entry.requestMethods || entry.excludedRequestMethods) {
    const method = String(details.method || 'get').toLowerCase();
    if (entry.requestMethods && !entry.requestMethods.has(method)) return false;
    if (entry.excludedRequestMethods && entry.excludedRequestMethods.has(method)) return false;
  }
  const needsInitiator = entry.initiatorDomains || entry.excludedInitiatorDomains || entry.domainType || entry.excludedRequestDomains;
  if (needsInitiator) {
    const initiatorHost = _requestInitiatorHost(details);
    if (entry.initiatorDomains && !(initiatorHost && _walkDomainMatches(entry.initiatorDomains, initiatorHost))) return false;
    if (entry.excludedInitiatorDomains && initiatorHost && _walkDomainMatches(entry.excludedInitiatorDomains, initiatorHost)) return false;
    if (entry.excludedRequestDomains && _walkDomainMatches(entry.excludedRequestDomains, requestHost)) return false;
    if (entry.domainType) {
      const isThirdParty = !initiatorHost || !(initiatorHost === requestHost || initiatorHost.endsWith('.' + requestHost) || requestHost.endsWith('.' + initiatorHost));
      if (entry.domainType === 'thirdParty' && !isThirdParty) return false;
      if (entry.domainType === 'firstParty' && isThirdParty) return false;
    }
  }
  return true;
}

function _networkBlockRequestHandler(details) {
  let host;
  try { host = new URL(details.url).hostname.toLowerCase(); } catch { return {}; }
  let h = host;
  while (h) {
    const entries = NETWORK_BLOCK_MATCHER.get(h);
    if (entries) {
      for (const entry of entries) {
        if (_matchesNetworkBlockEntry(entry, details, host)) {
          _incrementTabBlocked(details.tabId, 1);
          updateDailyStats({ blocked: 1, ads: 1, trackers: 0, malware: 0 });
          return { cancel: true };
        }
      }
    }
    const malwareRegexes = MALWARE_PATH_MATCHER.get(h);
    if (malwareRegexes) {
      for (const re of malwareRegexes) {
        if (re.test(details.url)) {
          _incrementTabBlocked(details.tabId, 1);
          updateDailyStats({ blocked: 1, ads: 0, trackers: 0, malware: 1 });
          return { cancel: true };
        }
      }
    }
    const dot = h.indexOf('.');
    if (dot === -1) break;
    h = h.slice(dot + 1);
  }
  return {};
}

let _networkBlockListenerRegistered = false;
function _updateNetworkBlockListener(enable) {
  if (!_hasWebRequestBlocking()) return;
  if (enable && !_networkBlockListenerRegistered) {
    EXT.webRequest.onBeforeRequest.addListener(_networkBlockRequestHandler, { urls: ['<all_urls>'] }, ['blocking']);
    _networkBlockListenerRegistered = true;
  } else if (!enable && _networkBlockListenerRegistered) {
    EXT.webRequest.onBeforeRequest.removeListener(_networkBlockRequestHandler);
    _networkBlockListenerRegistered = false;
  }
}

function parseRuleText(text) {
  const out = {};
  let section = '';
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line[0] === '#' || line[0] === ';') continue;
    if (line[0] === '[' && line[line.length - 1] === ']') {
      section = line.slice(1, -1).trim().toLowerCase();
      if (section && !out[section]) out[section] = {};
      continue;
    }
    if (!section) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (!key) continue;
    // Values are '|'-separated; a literal '|' inside a value (regex
    // alternation in scriptlet args) is written as '\\|' and unescaped here.
    const newVals = value ? value.split(/(?<!\\)\|/).map(part => part.trim().replace(/\\\|/g, '|')).filter(Boolean) : [];
    // Merge duplicate keys across multiple source files (same semantics as the
    // content-side parser): append values not already present.
    if (out[section][key] && out[section][key].length) {
      const seen = new Set(out[section][key]);
      for (const v of newVals) {
        if (!seen.has(v)) { seen.add(v); out[section][key].push(v); }
      }
    } else {
      out[section][key] = newVals;
    }
  }
  return out;
}

// ── Compressed rule-cache storage (2026-08-24) ───────────────────────
// A real user's merged siteRulesCacheText measured 6.97MB/119k lines
// (several large Rule Sources enabled) — ~70%+ of chrome.storage.local's
// ~10MB default quota (no unlimitedStorage permission in manifest.json) on
// this ONE key alone. Rule text is extremely repetitive (same
// "direct_hide_selectors = ", [abp_xxx] section headers, domain patterns,
// thousands of times) — measured deflate-raw compression on a same-shape
// synthetic dataset: ~8.5x smaller (11.7% of original), ~42ms to compress,
// ~2ms to decompress. Stored as a small wrapper object (not a bare string)
// so old-format plain-text values already in storage, and any environment
// where CompressionStream/DecompressionStream is unavailable, both still
// round-trip correctly — every reader must go through _decompressFromStorage.
const _b64Chunk = 0x8000; // avoid a call-stack blowup from String.fromCharCode(...hugeArray)
function _uint8ToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += _b64Chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + _b64Chunk));
  }
  return btoa(binary);
}
function _base64ToUint8(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
async function _compressForStorage(text) {
  // DEBUG_LOCAL: skip compression so chrome://extensions' storage inspector
  // (and the SW console) show plain readable text instead of an opaque
  // base64 blob while developing. _decompressFromStorage already has to
  // handle this exact {format:'raw'} shape unconditionally (its own
  // old-browser/CompressionStream-unavailable fallback below), so reading it
  // back needs no changes, and toggling DEBUG_LOCAL on/off never breaks
  // already-stored (possibly compressed) values either way.
  if (DEBUG_LOCAL) return { format: 'raw', data: text };
  try {
    if (typeof CompressionStream === 'undefined') throw new Error('CompressionStream unavailable');
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    writer.write(new TextEncoder().encode(text));
    writer.close();
    const buf = await new Response(cs.readable).arrayBuffer();
    return { format: 'deflate-raw-b64', data: _uint8ToBase64(new Uint8Array(buf)) };
  } catch (e) {
    // Old/unsupported browser, or any failure — store as plain text instead
    // of failing the write outright. Slightly wasteful, never incorrect.
    return { format: 'raw', data: text };
  }
}
async function _decompressFromStorage(stored) {
  if (!stored) return '';
  // Backward compat: a value written before this change is a bare STRING,
  // not the {format,data} wrapper — treat it as already-decompressed text.
  if (typeof stored === 'string') return stored;
  if (stored.format === 'raw') return stored.data || '';
  if (stored.format === 'deflate-raw-b64') {
    try {
      const bytes = _base64ToUint8(stored.data);
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      writer.write(bytes);
      writer.close();
      const buf = await new Response(ds.readable).arrayBuffer();
      return new TextDecoder().decode(buf);
    } catch (e) {
      return ''; // corrupted/unreadable — caller treats this as a cache miss
    }
  }
  return ''; // unrecognized format — treat as a cache miss, never guess
}

// remoteMalwareDomains (see _updateRemoteMalwareDomains()) is an array, not text —
// reuse the same deflate-raw machinery by round-tripping through JSON first.
async function _compressDomainsForStorage(domains) {
  return _compressForStorage(JSON.stringify(domains));
}
async function _decompressDomainsFromStorage(stored) {
  if (!stored) return [];
  // Backward compat: installs from before this change stored a bare array.
  if (Array.isArray(stored)) return stored;
  try {
    const parsed = JSON.parse(await _decompressFromStorage(stored));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return []; // corrupted/unreadable — treat as empty rather than guess
  }
}

async function getCachedRuleText() {
  try {
    const cached = await LocalStorage.get([RULES_CACHE_TEXT_KEY, RULES_CACHE_TIME_KEY]);
    if (!cached[RULES_CACHE_TEXT_KEY]) return null;
    const text = await _decompressFromStorage(cached[RULES_CACHE_TEXT_KEY]);
    if (!text) return null;
    return {
      text,
      time: Number(cached[RULES_CACHE_TIME_KEY] || 0),
    };
  } catch {
    return null;
  }
}

async function setCachedRuleText(text) {
  if (!text) return;
  try {
    const stored = await _compressForStorage(text);
    await LocalStorage.set({
      [RULES_CACHE_TEXT_KEY]: stored,
      [RULES_CACHE_TIME_KEY]: Date.now(),
    });
  } catch {}
}

function isFreshRuleCache(entry) {
  return !!(entry && entry.text && entry.time && (Date.now() - entry.time) < RULES_CACHE_TTL_MS);
}

// ── ABP/uBO format auto-detect + convert (Rule Source "Add URL") ──────
// Ported from scripts/convert-uassets.js's own tested parseFile/finalizeGroups/
// render (this repo's own code, previously offline-only — ran via
// `node scripts/convert-uassets.js`, never inside the actual extension).
// parseRuleText() below only understands this repo's own [section]/key=value
// grammar, so a Rule Source URL/file in raw ABP/uBO syntax (! comments,
// ##selector cosmetic rules, ##+js(name,args) scriptlet calls, ||domain^ network
// rules) previously contributed nothing at all, silently. This makes that
// conversion happen automatically wherever fetchRemoteRuleText() merges in a
// Rule Source's text.
//
// Dropped vs. the offline version: fs/path/require I/O (loadFilterEntries's
// assets.json batch scaffolding, fs.writeFileSync output — no equivalent for
// converting one ad-hoc fetched URL at runtime), and the network-rule half
// (parseNetOptions/buildNetworkRule, which target the currently-unwired
// rule/network-rules.json structured-DNR path) — simplified here to bare
// `||domain^` (optionally $third-party/$~third-party/$all, no path) collected
// into ad_network_patterns, matching the plain-domain-list shape [global]
// ad_network_patterns already expects. A path/URL-scoped pattern (e.g.
// `||example.com/exact/file.js^$all`, or one carrying $domain=/$denyallow=/
// $method=/a resourceType/$important — see _abpParseNetworkOptions) is ALSO
// converted, but into network_block_rules (buildNetworkBlockRules), NEVER
// ad_network_patterns — see ABP_SIMPLE_NETWORK_OPTS_RE's own comment for why
// that distinction is load-bearing, not stylistic. A bare $removeparam=name
// goes to the EXISTING strip_query_params mechanism instead of either (see
// the netMatch handling's own comment). Anything carrying a modifier this
// repo can't faithfully represent at all (csp=, popup, badfilter, mixed
// include/exclude resourceTypes, ...) is still dropped rather than guessed at.
const ABP_PROCEDURAL_RE = /:has-text\(|:matches-css|:xpath\(|:min-text-length|:remove\(|:style\(|:upward\(|:min-outer-height/;
const ABP_BARE_NETWORK_DOMAIN_RE = /^[a-z0-9.*-]+\^$/i;
// Options simple enough that a BARE DOMAIN carrying them can still go into
// ad_network_patterns's cheap, batched requestDomains path: no options at
// all, third-party/~third-party, or $all (equivalent to no options). This
// gate applies ONLY to the bare-domain branch below — a path-scoped pattern
// is NEVER added to ad_network_patterns regardless of how simple its options
// are: buildPatternRules() gives every distinct resourceType a DIFFERENT
// bait-detector-defeating placeholder file (REDIRECT_RESOURCE_BY_TYPE), so a
// urlFilter it's handed gets duplicated into its own rule PER TYPE-GROUP — a
// 5x fan-out that's free for one shared domain array but catastrophic for
// thousands of individual patterns (live-measured: real EasyList+EasyPrivacy+
// Fanboy-Social content alone produced ~31,000 rules from ~6,300 such
// urlFilters this way, pushing a fresh install's total dynamic rule count to
// 41,000+ — well past Chrome's ~30,000 limit, which made updateDynamicRules()
// reject the WHOLE batch atomically and silently keep serving whatever
// near-empty rule set existed before). Anything more than this — a single
// resourceType, domain=, denyallow=, method=, removeparam=, important, ... —
// goes to network_block_rules/strip_query_params instead (a true
// one-DNR-rule-per-entry cost — see NETWORK_RULE_BUDGET).
const ABP_SIMPLE_NETWORK_OPTS_RE = /^(?:~?third-party|all)?$/;
// Shared cap (one {remaining} counter threaded through every source
// converted together in one fetchRemoteRuleText() run — see its own call
// site) on how many network_block_rules entries get minted total, across
// EVERY enabled Rule Source combined. network_block_rules builds exactly ONE
// DNR rule per entry (buildNetworkBlockRules) — no multiplier — so this
// number IS the real rule-count cost, unlike ad_network_patterns urlFilters
// (see ABP_SIMPLE_NETWORK_OPTS_RE's comment for why those are kept out of
// this path entirely rather than budgeted). Live-measured 2026-08-31: real
// EasyList+EasyPrivacy+Fanboy-Social content converts to ~7,480 such
// entries (93% of the original 8,000 cap) — raised to 12,000 the same day
// for headroom to enable more ad/tracker Rule Sources without hitting the
// cap, while keeping the combined total (this + REMOTE_MAX_PATH_PATTERNS +
// the cheap/batched rest of the rule set — live-measured ~17,500 total
// today) comfortably under Chrome's ~30,000 dynamic+session rule limit with
// a large safety margin for custom/focus/pause rules and future growth.
// Once exhausted, further matches fall back to complexNetwork (dropped)
// exactly like before this feature existed, regardless of how many Rule
// Sources are enabled — degrading gracefully instead of risking
// updateDynamicRules() rejecting the WHOLE batch atomically.
const NETWORK_RULE_BUDGET = 12000;
// DNR resourceType for each ABP/uBO single-content-type option token this
// converter understands (`$script`, `$image`, ...; `~name` negates it, e.g.
// `$~script` means "every type except script"). Tokens with no real DNR
// equivalent (popup, csp=, badfilter, first-party used standalone, ...) —
// or ANY option this parser doesn't recognize at all — make the whole
// option string `unsupported` (see _abpParseNetworkOptions), so the caller
// drops the rule entirely rather than converting a wrong subset of it.
const ABP_RESOURCE_TYPE_MAP = {
  script: 'script', image: 'image', stylesheet: 'stylesheet', object: 'object',
  xmlhttprequest: 'xmlhttprequest', xhr: 'xmlhttprequest', subdocument: 'sub_frame',
  document: 'main_frame', font: 'font', media: 'media', websocket: 'websocket',
  ping: 'ping', other: 'other',
};
// chrome.declarativeNetRequest.RequestMethod's own enum — an ABP `$method=`
// value outside this set can't be mapped, so the whole option is unsupported.
const ABP_REQUEST_METHODS = new Set(['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put']);

// Parses one ABP/uBO network-rule option string (everything after the '$',
// e.g. "script,domain=a.com|~b.com,denyallow=cdn.example.com") into the
// pieces buildNetworkBlockRules() needs to build a real DNR condition:
// resourceTypes/excludedResourceTypes ($script, $~script, ...),
// initiatorDomains/excludedInitiatorDomains ($domain=), excludedRequestDomains
// ($denyallow=), requestMethods/excludedRequestMethods ($method=), and
// domainType ($third-party/$~third-party). `$important` is silently dropped
// from consideration — its only real-world purpose (override a conflicting
// `@@` exception rule) can never apply here, since `@@` exceptions are
// already unconditionally dropped by this converter with no equivalent at
// all, so a rule behaves identically with or without it. `$all` is likewise
// a no-op here — it just means "no resourceType restriction," the same as
// specifying no type option at all, which is already this function's
// default when includeTypes/excludeTypes stay empty. `$redirect=`/
// `$redirect-rule=`/`$removeparam=` are NOT handled here — _abpParseFile's
// caller checks for those FIRST (they map to a different native key/action
// entirely, not a block), so reaching this function with one of those tokens
// still present means the caller's own more-specific handling didn't apply
// (e.g. an unresolvable redirect target) — treated as unsupported here too,
// same conservative "don't guess" behavior as before this function existed.
// Returns { unsupported: true } for anything it can't faithfully represent.
function _abpParseNetworkOptions(optsStr) {
  const result = {
    includeTypes: [], excludeTypes: [],
    includeDomains: [], excludeDomains: [],
    denyallowDomains: [],
    includeMethods: [], excludeMethods: [],
    thirdParty: null, // null = unspecified, true = $third-party, false = $~third-party
  };
  const tokens = optsStr ? optsStr.split(',').map(t => t.trim()).filter(Boolean) : [];
  for (const tok of tokens) {
    if (tok === 'important' || tok === 'all') continue;
    if (tok === 'third-party') { result.thirdParty = true; continue; }
    if (tok === '~third-party') { result.thirdParty = false; continue; }
    const eq = tok.indexOf('=');
    if (eq === -1) {
      const negated = tok.charAt(0) === '~';
      const name = negated ? tok.slice(1) : tok;
      const dnrType = ABP_RESOURCE_TYPE_MAP[name];
      if (!dnrType) return { unsupported: true };
      (negated ? result.excludeTypes : result.includeTypes).push(dnrType);
      continue;
    }
    const key = tok.slice(0, eq);
    const val = tok.slice(eq + 1);
    if (!val) return { unsupported: true };
    if (key === 'domain' || key === 'from') {
      for (const d of val.split('|')) {
        const t = d.trim();
        if (!t) continue;
        if (t.charAt(0) === '~') result.excludeDomains.push(t.slice(1).toLowerCase());
        else result.includeDomains.push(t.toLowerCase());
      }
      continue;
    }
    if (key === 'denyallow') {
      for (const d of val.split('|')) {
        const t = d.trim();
        if (t) result.denyallowDomains.push(t.toLowerCase());
      }
      continue;
    }
    if (key === 'method') {
      for (const m of val.split('|')) {
        const t = m.trim().toLowerCase();
        if (!t) continue;
        const negated = t.charAt(0) === '~';
        const name = negated ? t.slice(1) : t;
        if (!ABP_REQUEST_METHODS.has(name)) return { unsupported: true };
        (negated ? result.excludeMethods : result.includeMethods).push(name);
      }
      continue;
    }
    return { unsupported: true }; // redirect=/redirect-rule=/removeparam= (see comment above), csp=, popup, badfilter, ...
  }
  if (result.includeTypes.length && result.excludeTypes.length) return { unsupported: true }; // ABP rules don't mix these — don't guess which side wins
  return result;
}

// Encodes one _abpParseNetworkOptions() result into the single space-
// separated string network_block_rules stores per entry (site-rules.txt's
// own array values are '|'-joined, so a comma is used as the in-field
// multi-value separator instead — see buildNetworkBlockRules for the
// matching decoder). `*` marks a field as unrestricted/unspecified so every
// entry has the same fixed field count regardless of which options were
// actually present.
function _abpEncodeNetworkBlockEntry(pattern, opts) {
  const types = opts.excludeTypes.length ? opts.excludeTypes.map(t => '~' + t).join(',')
    : opts.includeTypes.length ? opts.includeTypes.join(',')
    : '*';
  const domains = (opts.includeDomains.length || opts.excludeDomains.length)
    ? [...opts.includeDomains, ...opts.excludeDomains.map(d => '~' + d)].join(',')
    : '*';
  const denyallow = opts.denyallowDomains.length ? opts.denyallowDomains.join(',') : '*';
  const methods = (opts.includeMethods.length || opts.excludeMethods.length)
    ? [...opts.includeMethods, ...opts.excludeMethods.map(m => '~' + m)].join(',')
    : '*';
  const thirdParty = opts.thirdParty === true ? '1' : opts.thirdParty === false ? '0' : '*';
  return [pattern, types, domains, denyallow, methods, thirdParty].join(' ');
}

// Splits a network-rule pattern (the part between '||' and '$', e.g.
// "codeload.github.com/user/repo/zip/refs/heads/branch^") into its target
// domain and the remainder, so a path-scoped network_block_rules entry can
// be stored under that domain's own [host_patterns] section (site-rules.txt
// grammar) instead of one flat global list — grouped the same way cosmetic
// hide-selector/scriptlet rules already are for that domain. A domain name
// can't itself contain '/' or '^' (those only ever appear in the path/
// separator that follows), so the first occurrence of either character is
// an unambiguous, lossless split point: `domain + rest` always reconstructs
// the exact original pattern, whether rest is '' (bare domain, reached here
// only because its OPTIONS weren't simple — see ABP_SIMPLE_NETWORK_OPTS_RE),
// '^' alone, or a full '/path...^' suffix.
function _abpSplitNetworkPattern(pattern) {
  const idx = pattern.search(/[/^]/);
  if (idx === -1) return { domain: pattern, rest: '' };
  return { domain: pattern.slice(0, idx), rest: pattern.slice(idx) };
}

// Build-tool-generated class/id hash — e.g. styled-jsx's `.jsx-2126301199`,
// a CRC32/epoch-timestamp-style numeric id (`#popup-1720497466`),
// styled-components/emotion's `.sc-xxxxxxxx`. These are worthless past the
// one build that produced them (regenerated on the site's next deploy), so
// skip converting them. Threshold is 8+ digits, not 6+: real ad-dimension
// classes concatenate two 3-digit numbers (`.ad-300250` = 300x250) and land
// at exactly 6 digits — 8+ avoids that false positive while still catching
// real hashes/timestamps (9-10 digits).
const ABP_LOW_VALUE_HASH_RE = /-\d{8,}\b/;

// This repo's own grammar always opens with a [section] header (after
// optional #/; comment lines) — ABP/uBO text uses ! comments and has no
// bracket sections. First non-blank, non-#/;-comment line starting with '['
// => native (skip conversion). Empty/comment-only text => nothing to convert
// either way (falls through unchanged, same as today).
function _looksLikeAbpFormat(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.charAt(0) === '#' || line.charAt(0) === ';') continue;
    // The ABP spec requires "[Adblock Plus 2.0]" as literally the first
    // line of every standard filter list (EasyList, EasyPrivacy, ...) — a
    // format-version marker, not a section header, but it starts with '['
    // just like this repo's own [section] syntax. Without this check every
    // real-world ABP list misdetects as "already native" here and silently
    // converts to nothing.
    if (/^\[adblock plus[^\]]*\]$/i.test(line)) continue;
    return line.charAt(0) !== '[';
  }
  return false;
}

function _abpSplitDomainList(s) {
  const out = [];
  let cur = '', inRegex = false;
  for (const ch of s) {
    if (ch === '/') { inRegex = !inRegex; cur += ch; continue; }
    if (ch === ',' && !inRegex) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function _abpParseDomainPart(domainPart, curatedPatterns) {
  let hasGlobal = false;
  let dedupSkipped = 0;
  const domains = [];
  for (const raw of _abpSplitDomainList(domainPart.trim())) {
    const tok = raw.trim();
    if (!tok || tok.charAt(0) === '~') continue;
    if (tok === '*') { hasGlobal = true; continue; }
    if (tok.charAt(0) === '/' && tok.length > 1 && tok.lastIndexOf('/') > 0) {
      if (!curatedPatterns.has(tok)) domains.push(tok); else dedupSkipped++;
      continue;
    }
    const d = tok.toLowerCase();
    if (!curatedPatterns.has(d)) domains.push(d); else dedupSkipped++;
  }
  return { domains, hasGlobal, dedupSkipped };
}

function _abpStripTld(domain) {
  const idx = domain.lastIndexOf('.');
  return idx > 0 ? domain.slice(0, idx) : domain;
}

// Every key this mints always carries the same "abp_" prefix, unlike the old
// scheme (bare domain name, only "ua_"-prefixed on collision) — so an
// ABP-source-converted section is visually distinguishable at a glance from
// a hand-curated one ([youtube], [tuoitre] in the bundled site-rules.txt)
// and from a picker/dashboard-generated one (_elementRuleSiteKey's "qkv1_"
// family), the same way those two are already told apart by their own
// prefixes. On a collision (this key already claimed — by a curated
// section, or an earlier group in this batch via `usedKeys`, see
// _maybeConvertAbpText's comment on why usedKeys must be SHARED across every
// source converted together) a numeric suffix is appended and bumped until
// free, rather than the old single-shot "ua_" rename — which itself could
// still collide a second time with 3+ unrelated groups sharing the same
// TLD-stripped name (e.g. example.com / example.org / example.net) and
// silently merge the 2nd and 3rd into one section.
function _abpSanitizeKey(domain, curatedSectionNames, usedKeys) {
  let base = _abpStripTld(domain).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(base)) base = 'x' + base;
  let key = 'abp_' + base;
  if (curatedSectionNames.has(key) || usedKeys.has(key)) {
    let n = 2;
    while (curatedSectionNames.has(key + '_' + n) || usedKeys.has(key + '_' + n)) n++;
    key = key + '_' + n;
  }
  return key;
}

function _abpEscapeValue(v) {
  return v.replace(/\|/g, '\\|');
}

// Real-world scriptlet args protect internal commas one of two ways:
// backslash-escaping each comma individually (\,), or wrapping the WHOLE
// argument in a leading quote (' or ") and leaving commas inside it
// unescaped — both conventions show up across real uAssets filter lists
// (sometimes for the very same rule, in different revisions). A single
// regex split can only ever handle one of these, so this is a small
// character scanner instead: a quote is only treated as opening a quoted
// argument when it's the very first non-space character of that argument
// (a quote appearing mid-argument, e.g. inside already-written JS, is just
// a literal character) — everything up to the matching unescaped closing
// quote is consumed verbatim, commas and all, then dropped from the output
// (dequoted) the same way \, unescapes to a literal comma outside quotes.
function _abpSplitScriptletArgs(inner) {
  const out = [];
  let cur = '';
  let i = 0;
  const n = inner.length;
  while (i < n) {
    const ch = inner[i];
    if ((ch === "'" || ch === '"') && cur.trim() === '') {
      const quote = ch;
      i++;
      while (i < n && !(inner[i] === quote && inner[i - 1] !== '\\')) {
        cur += inner[i];
        i++;
      }
      i++; // skip the closing quote itself
      continue;
    }
    if (ch === '\\' && inner[i + 1] === ',') {
      cur += ',';
      i += 2;
      continue;
    }
    if (ch === ',') {
      out.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  out.push(cur.trim());
  return out;
}

function _abpFormatScriptletValue(mapping, args) {
  const used = args.slice(0, mapping.maxArgs).filter(a => a !== '');
  if (!used.length) return null;
  return mapping.sep === 'space' ? used.join(' ') : used.join(', ');
}

// trusted_replace_script_text's own value grammar can't just join args like
// the generic formatter above: real uBO rpnt/trusted-rpnt rules trail
// "sedCount, N" / "includes, X" / "excludes, X" pairs AFTER the replacement
// (args[2]) — but the replacement is arbitrary JS that can itself contain
// any number of commas, so there's no reliable way to find where it ends
// once those pairs are just appended after it. Reordering into
// "nodeName, pattern, key=value..., replacement" (extras BEFORE the
// unbounded replacement) at THIS layer — while args is still a clean,
// escape-aware-split array, not yet a flattened string — lets the content-
// script side peel recognized "key=value," prefixes off the front and
// safely treat everything left over as the replacement, verbatim commas
// and all. args here is the FULL split (background.js's caller passes the
// untruncated parts, ignoring mapping.maxArgs for this one key).
function _abpFormatTrustedReplaceScriptText(args) {
  if (args.length < 3) return null;
  const [nodeName, pattern, replacement, ...rest] = args;
  const knownExtraKeys = new Set(['sedCount', 'includes', 'excludes']);
  const extras = [];
  for (let i = 0; i + 1 < rest.length; i += 2) {
    if (knownExtraKeys.has(rest[i])) extras.push(rest[i] + '=' + rest[i + 1]);
  }
  return [nodeName, pattern, ...extras, replacement].filter(a => a !== '').join(', ');
}

// Empty/zeroed skip-stats shape — one bucket per reason a rule LINE (not
// blank lines/comments — those are just noise, not filter rules) ends up
// contributing nothing to the converted output, plus `converted` for lines
// that DID. `dedupSkipped` is its own bucket, separate from the "unsupported
// syntax" ones — a domain skipped because this repo's own site-rules.txt
// already curates it is the dedup mechanism working as intended (see
// _maybeConvertAbpText's own comment), not a parsing failure, and
// conflating the two would make a perfectly healthy source look broken.
function _abpEmptySkipStats() {
  return {
    total: 0, converted: 0, exception: 0, procedural: 0,
    adguardExtended: 0, unmappedScriptlet: 0, complexNetwork: 0,
    dedupSkipped: 0, unrecognized: 0, lowValueHash: 0,
  };
}

// Core line-by-line classifier — mirrors convert-uassets.js's parseFile,
// minus the network-rules.json structured-rule half (see file header comment above).
// `stats` (optional) tallies why each non-comment line did or didn't end up
// contributing to the output — see _abpEmptySkipStats() for the buckets;
// exposed so a caller (fetchRemoteRuleText()'s per-URL loop) can report
// per-Rule-Source "N lines skipped" instead of the previous all-or-nothing
// visibility (a source either obviously produced nothing at all, or
// silently dropped some fraction of its rules with no way to tell how much
// or why short of manually diffing input against output).
// `isTracker` (optional, default false): marks EVERY bare-domain entry this
// call converts as belonging to `[global] tracker_network_patterns` instead
// of `ad_network_patterns` — set per-SOURCE (config.js's RULES_REMOTE_URL
// entries can carry `category: 'tracker'`, e.g. EasyPrivacy) by the caller,
// never inferred from the pattern text itself. Path-scoped conversions
// (network_block_rules/network_redirect_rules/strip_query_params) are NOT
// split by this flag — they stay a single shared pool regardless of source,
// since network_block_rules is already gated by blockAds only (see
// buildActiveRulesFromStorage's own networkBlockActive) and splitting that
// too would need a parallel tracker_block_rules key/builder/gate this
// session's request didn't ask for.
function _abpParseFile(text, curatedPatterns, acc, stats, networkRuleBudget, isTracker) {
  const { domainSelectors, domainScriptlets, globalSelectors, globalScriptlets, networkDomains, trackerDomains, networkRedirects, domainNetworkBlocks, queryStrips } = acc;
  const s = stats || _abpEmptySkipStats();
  // `networkRuleBudget` caps network_block_rules conversions — see
  // NETWORK_RULE_BUDGET's own comment for why. Omitted (or `undefined`)
  // defaults to unlimited — every existing single-example caller/test that
  // isn't testing the cap itself needs no changes.
  const budget = networkRuleBudget || { remaining: Infinity };
  const lines = String(text || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.charAt(0) === '!') continue;

    const netMatch = /^\|\|([^$]+?)(?:\$(.*))?$/.exec(line);
    if (netMatch) {
      s.total++;
      const pattern = netMatch[1];
      const optsStr = netMatch[2] || '';
      const hasSimpleOpts = ABP_SIMPLE_NETWORK_OPTS_RE.test(optsStr);
      if (ABP_BARE_NETWORK_DOMAIN_RE.test(pattern) && hasSimpleOpts) {
        // Bare domain — batches into ad_network_patterns' (or, for a
        // tracker-marked source, tracker_network_patterns') shared
        // requestDomains array (buildPatternRules), so this stays cheap
        // (a handful of rules total) no matter how many domains land here.
        (isTracker ? trackerDomains : networkDomains).add(pattern.slice(0, -1).toLowerCase());
        s.converted++;
      } else {
        // Not a bare-domain-with-simple-opts block — three other shapes this
        // converter preserves, none of them ad_network_patterns (see
        // ABP_SIMPLE_NETWORK_OPTS_RE's own comment for why that distinction
        // matters): (a) a path-scoped rule carrying a $redirect=/
        // $redirect-rule= that resolves to a resource this extension
        // actually ships (network_redirect_rules, background.js's
        // buildNetworkRedirectRules) — a bare-domain redirect isn't worth its
        // own rule since ad_network_patterns already blocks that domain
        // outright, so this only fires for a genuinely path-scoped pattern;
        // (b) a bare $removeparam=name (optionally with third-party) — maps
        // to this repo's EXISTING strip_query_params mechanism
        // (buildQueryStripRules) instead of a block, since removeparam=
        // means "strip this param and let the (modified) request through,"
        // not "block it"; (c) any other pattern whose options
        // _abpParseNetworkOptions can represent ($domain=, $denyallow=,
        // $method=, a single/multiple resourceType, $important, $all, or no
        // options at all) — stored as a network_block_rules entry under the
        // pattern's OWN target domain's [host_patterns] section (see
        // _abpSplitNetworkPattern's own comment), grouped the same way that
        // domain's cosmetic/scriptlet rules already are, instead of one flat
        // global list — buildNetworkBlockRules still builds exactly ONE DNR
        // rule per entry, no matter how many types/domains it carries. A
        // negated/regex removeparam= value, removeparam= combined with
        // anything beyond third-party, or any option outside everything
        // above (csp=, popup, badfilter, ...) is dropped rather than
        // guessed at.
        const urlFilter = '||' + pattern;
        const optTokens = optsStr ? optsStr.split(',').map(t => t.trim()).filter(Boolean) : [];
        const redirectTok = optTokens.find(t => /^redirect(?:-rule)?=/.test(t));
        const file = redirectTok && _resolveRedirectResourceName(redirectTok.slice(redirectTok.indexOf('=') + 1));
        const removeparamToks = optTokens.filter(t => t.startsWith('removeparam='));
        const nonThirdPartyToks = optTokens.filter(t => t !== 'third-party' && t !== '~third-party');
        if (file && !ABP_BARE_NETWORK_DOMAIN_RE.test(pattern)) {
          networkRedirects.add(pattern + ' ' + file);
          s.converted++;
        } else if (
          removeparamToks.length === 1 && nonThirdPartyToks.length === 1 &&
          /^removeparam=[^~/][^,]*$/.test(removeparamToks[0]) && _isValidUrlFilter(urlFilter)
        ) {
          queryStrips.add(pattern + ' ' + removeparamToks[0].slice('removeparam='.length));
          s.converted++;
        } else {
          const opts = _abpParseNetworkOptions(optsStr);
          if (!opts.unsupported && budget.remaining > 0 && _isValidUrlFilter(urlFilter)) {
            const { domain: rawDomain, rest } = _abpSplitNetworkPattern(pattern);
            // Lowercased for the same reason the bare-domain branch above
            // does (host matching is case-insensitive; keeps this domain
            // groupable with any OTHER rule for the same host regardless of
            // the source text's own casing) — `rest` (the path) is left
            // exactly as-is, since URL paths ARE case-sensitive.
            const domain = rawDomain.toLowerCase();
            if (!domainNetworkBlocks.has(domain)) domainNetworkBlocks.set(domain, new Set());
            domainNetworkBlocks.get(domain).add(_abpEncodeNetworkBlockEntry(rest, opts));
            budget.remaining--;
            s.converted++;
          } else {
            s.complexNetwork++;
          }
        }
      }
      continue;
    }
    if (line.charAt(0) === '@' && line.charAt(1) === '@') { s.total++; s.exception++; continue; } // exceptions — no equivalent here, dropped

    // '#@#' (cosmetic EXCEPTION) never contains '##' as a substring, so it
    // needs its own detection rather than falling out of the '##' check
    // below. Real-world lists use '#@#+js(...)' for two different things:
    // (a) cancelling a `##selector` hide rule from another list — no
    // equivalent here (direct_hide_selectors has no cancellation model),
    // still dropped; (b) injecting a scriptlet via exception syntax
    // specifically so OTHER exception rules can't cancel it (uBO's own
    // convention). Since this repo's dispatch has no cancellation concept
    // at all, that distinction is moot here — a '#@#+js(...)' scriptlet
    // call behaves identically to a '##+js(...)' one, so it's handled the
    // same way instead of being dropped like a plain cosmetic exception.
    const excIdx = line.indexOf('#@#');
    const hideIdx = line.indexOf('##');
    let sepIdx = -1, sepLen = 0, isException = false;
    if (hideIdx !== -1 && (excIdx === -1 || hideIdx < excIdx)) { sepIdx = hideIdx; sepLen = 2; }
    else if (excIdx !== -1) { sepIdx = excIdx; sepLen = 3; isException = true; }
    if (sepIdx === -1) { s.total++; s.unrecognized++; continue; }

    const domainPart = line.slice(0, sepIdx);
    const selectorPart = line.slice(sepIdx + sepLen);

    if (!selectorPart) { s.total++; s.unrecognized++; continue; }
    s.total++;
    const isScriptletCall = selectorPart.indexOf('+js(') === 0 && selectorPart.charAt(selectorPart.length - 1) === ')';
    if (isException && !isScriptletCall) { s.exception++; continue; } // plain cosmetic exception — unsupported, dropped
    if (domainPart.trim().charAt(0) === '[') { s.adguardExtended++; continue; } // AdGuard extended modifier syntax — not supported

    if (isScriptletCall) {
      const inner = selectorPart.slice(4, -1);
      const parts = _abpSplitScriptletArgs(inner);
      const name = (parts.shift() || '').trim();
      const mapping = self.SCRIPTLET_ALIAS_MAP && self.SCRIPTLET_ALIAS_MAP[name];
      if (!mapping || !domainPart) { s.unmappedScriptlet++; continue; }
      const value = mapping.flag ? '1'
        : mapping.key === 'trusted_replace_script_text' ? _abpFormatTrustedReplaceScriptText(parts)
        : _abpFormatScriptletValue(mapping, parts);
      if (value === null) { s.unmappedScriptlet++; continue; }
      const { domains, hasGlobal, dedupSkipped } = _abpParseDomainPart(domainPart, curatedPatterns);
      if (hasGlobal) {
        if (!globalScriptlets.has(mapping.key)) globalScriptlets.set(mapping.key, new Set());
        globalScriptlets.get(mapping.key).add(value);
      }
      for (const d of domains) {
        if (!domainScriptlets.has(d)) domainScriptlets.set(d, new Map());
        const perKey = domainScriptlets.get(d);
        if (!perKey.has(mapping.key)) perKey.set(mapping.key, new Set());
        perKey.get(mapping.key).add(value);
      }
      if (domains.length || hasGlobal) s.converted++;
      else if (dedupSkipped) s.dedupSkipped++;
      else s.unrecognized++;
      continue;
    }

    if (ABP_PROCEDURAL_RE.test(selectorPart)) { s.procedural++; continue; }
    if (ABP_LOW_VALUE_HASH_RE.test(selectorPart)) { s.lowValueHash++; continue; }

    if (!domainPart) { globalSelectors.add(selectorPart); s.converted++; continue; }

    const { domains, hasGlobal, dedupSkipped } = _abpParseDomainPart(domainPart, curatedPatterns);
    if (hasGlobal) globalSelectors.add(selectorPart);
    for (const d of domains) {
      if (!domainSelectors.has(d)) domainSelectors.set(d, new Set());
      domainSelectors.get(d).add(selectorPart);
    }
    if (domains.length || hasGlobal) s.converted++;
    else if (dedupSkipped) s.dedupSkipped++;
    else s.unrecognized++;
  }
}

// `domainNetworkBlocks` (optional): Map<domain, Set<entry>> of that domain's
// own network_block_rules entries (see _abpSplitNetworkPattern). A domain
// carrying any of these is ALWAYS forced into its own dedicated (single-
// domain) group, never bucketed with another domain even if their
// selectors/scriptlets happen to be identical — folding the domain's own
// name into its signature guarantees that. Merging would otherwise apply
// domain A's path-scoped network block to sibling domain B too, since a
// bucket section's rules apply to every domain mapped to it.
function _abpFinalizeGroups(domainSelectors, domainScriptlets, domainNetworkBlocks) {
  const allDomains = new Set([
    ...domainSelectors.keys(), ...domainScriptlets.keys(),
    ...(domainNetworkBlocks ? domainNetworkBlocks.keys() : []),
  ]);
  const groups = new Map();
  for (const domain of allDomains) {
    const selectors = domainSelectors.get(domain) || new Set();
    const scriptlets = domainScriptlets.get(domain) || new Map();
    const networkBlocks = (domainNetworkBlocks && domainNetworkBlocks.get(domain)) || new Set();
    const scriptletSig = [...scriptlets.entries()].map(([k, vals]) => k + '=' + [...vals].sort().join('')).sort().join('');
    const sig = [...selectors].sort().join(' ') + scriptletSig +
      (networkBlocks.size ? ' netblock:' + domain : '');
    if (!groups.has(sig)) groups.set(sig, { domains: [], selectors, scriptlets, networkBlocks });
    groups.get(sig).domains.push(domain);
  }
  return groups;
}

// `sharedUsedKeys` (optional): pass the SAME Set across multiple _abpRender
// calls (one per Rule Source being converted together) so a domain-group key
// minted by an earlier source blocks a later source from reusing it, instead
// of each call starting from a fresh empty Set — see _maybeConvertAbpText's
// own comment on why per-call scoping alone let two independently-enabled
// sources collide on the same key.
// `sharedDedicatedKeyMap` (optional): a Map<domain, key> spanning the same
// batch of sources as sharedUsedKeys. When TWO different sources each have
// their own DEDICATED (single-domain, non-bucket — g.domains.length === 1)
// group for the EXACT SAME domain, the second one REUSES the first one's
// key instead of minting a fresh one — so parseRuleText()'s own same-section
// merge (see its comment) unions both sources' selectors/scriptlets into one
// section, instead of the second source's rules for that domain silently
// resolving to nothing (resolveSiteKey()/_buildHostPatternIndex() only ever
// keep ONE key per domain — confirmed live, 2026-08-23: two sources with
// their own dedicated rule for the same domain, only the first-processed
// one's selector ever became reachable). Only applies domain-for-domain
// between two DEDICATED groups — a multi-domain BUCKET group is never
// added to or matched against this map, so it can't inherit a dedicated
// group's selector for its OTHER (unrelated) domains, which would
// reintroduce the exact cross-source leak _abpSanitizeKey's usedKeys
// sharing was built to close.
function _abpRender({ groups, globalSelectors, globalScriptlets, networkDomains, trackerDomains, networkRedirects, queryStrips, curatedSectionNames, sharedUsedKeys, sharedDedicatedKeyMap }) {
  const usedKeys = sharedUsedKeys || new Set();
  const dedicatedKeyMap = sharedDedicatedKeyMap || new Map();
  const out = [];
  if (networkDomains.size || (trackerDomains && trackerDomains.size) || (networkRedirects && networkRedirects.size) ||
      (queryStrips && queryStrips.size) || globalSelectors.size || globalScriptlets.size) {
    out.push('[global]');
    // ad_network_patterns/tracker_network_patterns only ever hold bare
    // lowercase domains here (no '|' chars) — path-scoped patterns are
    // deliberately kept out of both (see ABP_SIMPLE_NETWORK_OPTS_RE's own
    // comment) — so no escaping needed. strip_query_params entries carry a
    // raw pattern that CAN start with a single '|' anchor (see
    // _isValidUrlFilter), so those ARE escaped, same as network_redirect_
    // rules already is. network_block_rules is rendered per-domain below,
    // not here — see _abpFinalizeGroups' own comment.
    if (networkDomains.size) out.push('ad_network_patterns = ' + [...networkDomains].sort().join(' | '));
    if (trackerDomains && trackerDomains.size) out.push('tracker_network_patterns = ' + [...trackerDomains].sort().join(' | '));
    if (networkRedirects && networkRedirects.size) out.push('network_redirect_rules = ' + [...networkRedirects].sort().map(_abpEscapeValue).join(' | '));
    if (queryStrips && queryStrips.size) out.push('strip_query_params = ' + [...queryStrips].sort().map(_abpEscapeValue).join(' | '));
    if (globalSelectors.size) out.push('direct_hide_selectors = ' + [...globalSelectors].sort().map(_abpEscapeValue).join(' | '));
    for (const [scriptletKey, vals] of [...globalScriptlets.entries()].sort()) {
      out.push(scriptletKey + ' = ' + [...vals].sort().map(_abpEscapeValue).join(' | '));
    }
    out.push('');
  }
  const groupList = [...groups.values()].sort((a, b) => a.domains[0].localeCompare(b.domains[0]));
  if (groupList.length) {
    out.push('[host_patterns]');
    const groupKeys = [];
    for (const g of groupList) {
      const isDedicated = g.domains.length === 1;
      const existingKey = isDedicated ? dedicatedKeyMap.get(g.domains[0]) : undefined;
      const key = existingKey || _abpSanitizeKey(g.domains[0], curatedSectionNames, usedKeys);
      if (!existingKey) {
        usedKeys.add(key);
        if (isDedicated) dedicatedKeyMap.set(g.domains[0], key);
      }
      groupKeys.push(key);
      out.push([...g.domains].sort().join('|') + ' = ' + key);
    }
    out.push('');
    groupList.forEach((g, i) => {
      out.push('[' + groupKeys[i] + ']');
      if (g.selectors.size) out.push('direct_hide_selectors = ' + [...g.selectors].sort().map(_abpEscapeValue).join(' | '));
      for (const [scriptletKey, vals] of [...g.scriptlets.entries()].sort()) {
        out.push(scriptletKey + ' = ' + [...vals].sort().map(_abpEscapeValue).join(' | '));
      }
      // network_block_rules entries here are PATH-only (the domain is this
      // section's own [host_patterns] mapping) — see _abpSplitNetworkPattern
      // and buildDomainNetworkBlockRules, which reconstructs the full
      // urlFilter from the two together at build time. A dedicated
      // (single-domain) group is guaranteed here whenever networkBlocks is
      // non-empty (see _abpFinalizeGroups' forced-uniqueness signature), so
      // there's exactly one unambiguous domain to reconstruct against.
      if (g.networkBlocks && g.networkBlocks.size) out.push('network_block_rules = ' + [...g.networkBlocks].sort().map(_abpEscapeValue).join(' | '));
      out.push('');
    });
  }
  return out.join('\n');
}

// Orchestrator — detect, and if ABP-format, convert to this repo's own
// site-rules.txt grammar; otherwise return the text unchanged. Dedup against
// already-curated rules reads the BUNDLED LOCAL site-rules.txt
// (fetchLocalRuleText() — a local/bundled fetch, no network, no deadlock
// risk) rather than the merged CACHE. This used to read getCachedRuleText()
// instead, which seemed equivalent but silently broke multi-source setups:
// the cache is the FULL MERGED text from every currently-enabled Rule
// Source, not just this repo's own hand-curated rules — so enabling EasyList
// first (which can incidentally cover the same domain a later source also
// targets, just with worse/generic selectors) would cache a host_patterns
// entry for that domain, and a Rule Source enabled AFTER it (e.g. Vietnam —
// ABPVN List) would then see that domain as "already curated" and have its
// OWN rules for it dropped entirely instead of merged — reported live
// (2026-08-23) as ABPVN's rules "not executing", a .banner-ads selector
// never getting injected. Reading only the bundled local file means
// dedup protects exactly what it was meant to (this repo's own
// hand-written site-rules.txt), never another Rule Source's output —
// every OTHER enabled ABP source can still freely contribute its own
// selectors for the same domain, which parseRuleText()'s normal
// same-section merge unions together rather than either one winning.
// `statsOut` (optional, mutated in place) — pass an object to receive the
// per-line skip/convert tally (_abpEmptySkipStats()'s shape) for THIS call.
// Omit it and the function behaves exactly as before (return value is
// unchanged either way — a plain string — so every existing caller/test
// that doesn't care about stats needs no changes).
// `sharedUsedKeys` (optional): a Set threaded in from the caller and passed
// straight through to _abpRender(). Each generated [host_patterns] section
// key is derived purely from its group's leading domain name (_abpSanitizeKey),
// so two DIFFERENT Rule Sources converted via two SEPARATE calls to this
// function can independently mint the identical key for two otherwise
// unrelated domain groups (e.g. EasyList's own "accuweather.com" group and
// EasyPrivacy's unrelated "accuweather.com|costco.com|delta.com|..." bucket
// both sanitize to "accuweather") — parseRuleText then merges both groups'
// selectors/scriptlets into that one shared section, so every domain in
// EITHER group ends up matched against the UNION of both, leaking rules
// across completely unrelated sites (confirmed against real EasyList +
// EasyPrivacy + ABPVN text, 2026-08-23: 10 such collisions). Passing the
// SAME Set across every source converted together (see _fetchAndConvertUrls
// and fetchRemoteRuleText) closes this the same way _elementRuleSiteKey's
// callers already avoid a different flavor of this problem within
// customRulesText: whichever source's key gets claimed first keeps the
// plain "abp_"-prefixed name, every later collision on that same key gets a
// numeric suffix instead of silently merging into the first source's
// section. Omit it (or pass nothing) and a fresh per-call Set is used —
// unchanged single-source behavior for every existing caller/test.
// Memoized bundled-local-file dedup sets (Phase 2a perf fix) — every enabled
// ABP-format source's own _maybeConvertAbpText() call used to independently
// re-fetch (chrome.runtime.getURL, still an actual fetch() I/O call) AND
// re-parseRuleText() this repo's own bundled site-rules.txt, purely to
// rebuild the same two dedup Sets. That file is static extension content —
// it cannot change without a new extension version (which always cold-starts
// the service worker anyway) — so it's safe to compute this once per SW
// lifetime and reuse across every source converted in the same
// fetchRemoteRuleText() run (N enabled ABP sources = 1 fetch+parse instead
// of N). Reset alongside _parsedRules in reloadRules() purely for symmetry
// (tying its invalidation to the same reset point costs nothing extra).
let _curatedDedupPromise = null;
function _getCuratedDedupSets() {
  if (!_curatedDedupPromise) {
    _curatedDedupPromise = (async () => {
      try {
        const nativeText = await fetchLocalRuleText();
        if (!nativeText) return { curatedPatterns: new Set(), curatedSectionNames: new Set() };
        const parsed = parseRuleText(nativeText);
        return {
          curatedPatterns: new Set(parsed.host_patterns ? Object.keys(parsed.host_patterns) : []),
          curatedSectionNames: new Set(Object.keys(parsed)),
        };
      } catch (e) {
        return { curatedPatterns: new Set(), curatedSectionNames: new Set() };
      }
    })();
  }
  return _curatedDedupPromise;
}

async function _maybeConvertAbpText(text, statsOut, sharedUsedKeys, sharedDedicatedKeyMap, networkRuleBudget, isTracker) {
  if (!_looksLikeAbpFormat(text)) return text;
  const { curatedPatterns, curatedSectionNames } = await _getCuratedDedupSets();
  const acc = {
    domainSelectors: new Map(), domainScriptlets: new Map(),
    globalSelectors: new Set(), globalScriptlets: new Map(),
    networkDomains: new Set(), trackerDomains: new Set(), networkRedirects: new Set(),
    domainNetworkBlocks: new Map(), queryStrips: new Set(),
  };
  const stats = _abpEmptySkipStats();
  try { _abpParseFile(text, curatedPatterns, acc, stats, networkRuleBudget, isTracker); } catch (e) {
    if (statsOut) statsOut.error = (e && e.message) || 'conversion failed';
    return text;
  }
  if (statsOut) Object.assign(statsOut, stats);
  const groups = _abpFinalizeGroups(acc.domainSelectors, acc.domainScriptlets, acc.domainNetworkBlocks);
  return _abpRender({
    groups, globalSelectors: acc.globalSelectors, globalScriptlets: acc.globalScriptlets,
    networkRedirects: acc.networkRedirects, queryStrips: acc.queryStrips,
    networkDomains: acc.networkDomains, trackerDomains: acc.trackerDomains, curatedSectionNames,
    sharedUsedKeys, sharedDedicatedKeyMap,
  });
}

// Effective enabled/disabled state for one built-in default Rule Source
// entry ({name, url, enable} from config.js's RULES_REMOTE_URL array): a
// per-URL override in `defaultRuleSourceOverrides` wins if present,
// otherwise the legacy single "all defaults" flag (`defaultRuleSourceEnabled
// === false`, pre-multi-source installs) wins if it was ever set, otherwise
// fall back to the entry's own ship-time `enable` field.
function _isDefaultSourceEnabled(entry, overrides, legacyAllDisabled) {
  const key = _primaryUrl(entry);
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key] !== false;
  if (legacyAllDisabled) return false;
  return entry.enable !== false;
}

// Candidate-gathering itself now lives in shared/utils.js
// (langCandidates()) — shared with shared/i18n.js's manual-UI-
// language "Auto" resolution, which needs the exact same
// getUILanguage()-vs-navigator.language gap closed but from contexts this
// file never loads into (content scripts, HTML pages). This wrapper just
// keeps the name every call site below already uses.
function _candidateUILanguages() {
  try { return langCandidates(); } catch (e) { return []; }
}

// True if any candidate language matches a RULES_REMOTE_URL entry's `lang`
// (BCP-47 primary subtag, e.g. 'vi') — exact match or a region variant of
// it ('vi-VN' matches 'vi').
function _uiLanguageMatches(lang) {
  const target = String(lang || '').toLowerCase();
  if (!target) return false;
  return _candidateUILanguages().some(cand => {
    const c = String(cand || '').toLowerCase();
    return c === target || c.startsWith(target + '-');
  });
}

// A RULES_REMOTE_URL entry's `lang` is either a single BCP-47 subtag or an
// array of them (some region lists cover several languages, e.g. Spain's
// list also covers Catalan/Basque/Galician) — normalize to an array either
// way, empty if the entry has no `lang` at all.
function _entryLangs(entry) {
  if (!entry.lang) return [];
  return Array.isArray(entry.lang) ? entry.lang : [entry.lang];
}

// 2026-08-25: an entry's `url` is likewise either a single URL string or an
// ARRAY of urls (same "string-or-array" pattern as `lang` above) — ALL urls
// in the array are fetched and merged in, same as if they were separate
// entries (NOT a mirror/fallback list — every url is used every time, not
// just tried until one succeeds; a fetch failure on one url is reported and
// skipped independently, same as any other single-URL source failing
// today, while the rest of the group's urls still contribute normally).
// _entryUrls() normalizes either shape to an array; _primaryUrl() (the
// FIRST url) is the one stable identifier used for every piece of tracking
// keyed by "this source" as a GROUP — defaultRuleSourceOverrides (one
// toggle enables/disables every url in the group together),
// RULES_REMOTE_ETAG_KEY/RULES_REMOTE_HASH_KEY (per-url, see
// revalidateRemoteRules), RULE_SOURCE_ERRORS_KEY/RULE_SOURCE_STATS_KEY
// (also per-url — each url in the group is its own independent fetch, so
// each gets its own error/stats entry), and the dashboard's single row for
// the whole group.
function _entryUrls(entry) {
  if (!entry.url) return [];
  return Array.isArray(entry.url) ? entry.url : [entry.url];
}
function _primaryUrl(entry) {
  return _entryUrls(entry)[0];
}


// Auto-enable any built-in default Rule Source whose `lang` matches the
// browser's UI language, so e.g. a Vietnamese-language install gets the
// Vietnam list on without a trip to the dashboard. Called from onInstalled
// on EVERY reason (install, update, chrome_update, ...), not just a genuine
// fresh install: a user already running the extension from before this
// feature shipped never gets a fresh 'install' event again, only 'update'
// ones (including the "Reload" button in chrome://extensions during dev,
// which fires onInstalled with reason 'update') — gating on 'install' only
// meant this could never actually run for any existing install. Safe to
// call unconditionally/repeatedly: only ever SETS an override to true for a
// matching entry that has no override yet — never touches one the user (or
// a previous run of this same function) already decided about, and never
// touches language-agnostic entries (no `lang` field).
async function _autoEnableLangDefaultSources() {
  const matches = RULES_REMOTE_URL.filter(e => _entryLangs(e).some(l => _uiLanguageMatches(l)));
  if (!matches.length) return;
  const { defaultRuleSourceOverrides = {} } = await LocalStorage.get('defaultRuleSourceOverrides');
  const updated = { ...defaultRuleSourceOverrides };
  let changed = false;
  for (const entry of matches) {
    const key = _primaryUrl(entry);
    if (!Object.prototype.hasOwnProperty.call(updated, key)) {
      updated[key] = true;
      changed = true;
    }
  }
  if (!changed) return;
  await LocalStorage.set({
    defaultRuleSourceOverrides: updated,
    // Bust the rules cache so the newly-enabled source is actually fetched
    // by the applyNetworkRules() call onInstalled makes right after this —
    // without this, a pre-existing fresh cache (any install that isn't
    // brand new) would keep serving the old merged text for up to
    // RULES_CACHE_TTL_MS (6h) before the new source ever got picked up.
    [RULES_CACHE_TEXT_KEY]: '',
    [RULES_CACHE_TIME_KEY]: 0,
  });
  _ruleConfigPromise = null;
  _parsedRules = null;
}

// Fetch + ABP-convert every URL in `urls`, recording a per-URL fetch error
// into RULE_SOURCE_ERRORS_KEY unconditionally — no "only if X" gating — so
// the dashboard's Rule Source page can show the user WHY a source silently
// contributed nothing, instead of the only-visible-via-DevTools-console
// silence this used to be.
// `sharedUsedKeys` (optional): one Set shared across every URL fetched here,
// threaded down to _maybeConvertAbpText/_abpRender — see _maybeConvertAbpText's
// comment for why generated [host_patterns] keys need this to avoid two
// unrelated sources' domain groups colliding on the same section name.
// `sharedDedicatedKeyMap` (optional): one Map<domain,key> shared the same
// way, so two DIFFERENT sources that each have their OWN dedicated rule for
// the SAME domain get merged into one section instead of the second one
// silently never resolving — see _abpRender's own comment.
// Concurrency note: Promise.all below only interleaves at the `await fetch`/
// `await res.text()` I/O points; once a given URL's _maybeConvertAbpText call
// resumes after its own internal await, its key-minting loop runs to
// completion with no further await, so mutating the shared Set/Map from
// several concurrent calls is safe — no two calls can be mid-loop at once.
// `trackerUrls` (optional Set<url>): URLs in here get isTracker=true passed
// to _maybeConvertAbpText, so their bare-domain patterns land in
// tracker_network_patterns instead of ad_network_patterns — see
// _abpParseFile's own comment. Membership is decided by the CALLER
// (fetchRemoteRuleText(), from config.js's RULES_REMOTE_URL `category:
// 'tracker'` field), never inferred here from the URL/content itself.
async function _fetchAndConvertUrls(urls, sharedUsedKeys, sharedDedicatedKeyMap, networkRuleBudget, trackerUrls) {
  const usedKeys = sharedUsedKeys || new Set();
  const dedicatedKeyMap = sharedDedicatedKeyMap || new Map();
  const sourceErrors = {};
  const sourceStats = {}; // url -> _abpEmptySkipStats() shape, only for ABP-format sources
  const texts = await Promise.all(urls.map(async url => {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        sourceErrors[url] = `HTTP ${res.status}`;
        return '';
      }
      const raw = await res.text();
      if (!raw) return '';
      const stats = {};
      const converted = await _maybeConvertAbpText(raw, stats, usedKeys, dedicatedKeyMap, networkRuleBudget, !!(trackerUrls && trackerUrls.has(url)));
      if (Object.keys(stats).length) sourceStats[url] = stats;
      return converted;
    } catch (e) {
      sourceErrors[url] = e && e.message ? e.message : 'fetch failed';
      return '';
    }
  }));
  if (urls.length) {
    const { [RULE_SOURCE_ERRORS_KEY]: existingErrors = {}, [RULE_SOURCE_STATS_KEY]: existingStats = {} } =
      await LocalStorage.get([RULE_SOURCE_ERRORS_KEY, RULE_SOURCE_STATS_KEY]);
    const nextErrors = { ...existingErrors };
    const nextStats = { ...existingStats };
    for (const url of urls) {
      if (sourceErrors[url]) nextErrors[url] = sourceErrors[url];
      else delete nextErrors[url]; // this fetch succeeded — clear any stale error for it
      if (sourceStats[url]) nextStats[url] = sourceStats[url];
      else delete nextStats[url]; // not ABP-format (or fetch failed) — nothing to report for it now
    }
    await LocalStorage.set({ [RULE_SOURCE_ERRORS_KEY]: nextErrors, [RULE_SOURCE_STATS_KEY]: nextStats });
  }
  return texts;
}

async function fetchRemoteRuleText() {
  const stored = await LocalStorage.get(['ruleSources', 'customRulesUrl', 'customRulesText', 'defaultRuleSourceEnabled', 'defaultRuleSourceOverrides']);
  const sources = stored.ruleSources;
  const urls = [];
  const fileParts = [];
  const defaultUrls = new Set(RULES_REMOTE_URL.flatMap(e => _entryUrls(e)));

  // Default remote sources — each toggleable from the dashboard's Rule
  // Source page (per-GROUP, defaultRuleSourceOverrides keyed by the group's
  // _primaryUrl — see _entryUrls' own comment). Disabled means disabled: no
  // rules from that source at all, not even the bundled local copy — the
  // user can still layer custom sources/customRulesText on top of nothing.
  // (getRulesText()'s own catch branch still falls back to the local file,
  // but only on an actual fetch failure — see the empty-merge check below.)
  // An entry whose `url` is an array contributes EVERY url in it — all
  // fetched and merged in, not a mirror/fallback list.
  //
  // DEBUG_LOCAL swaps ONLY the very first entry's ENTIRE group (RULES_
  // REMOTE_URL[0] — this repo's own GitHub-hosted site-rules.txt, by
  // convention always first and single-url) for the bundled local copy, so
  // local edits take effect on reload without pushing to GitHub. Every
  // other source — other default entries, ruleSources, customRulesText —
  // flows through this exact same fetch/merge/cache pipeline in both debug
  // and production; nothing else about them changes.
  // Entries with format:'hosts' (URLhaus, Phishing Army — see config.js's
  // own comment) are plain domain-per-line blocklists, not ABP filter
  // syntax — routed to _updateRemoteMalwareDomains() below instead of the
  // ad_network_patterns/network_block_rules/ABP-conversion path so
  // blockMalware stays independent of blockAds and hits still redirect to
  // the dedicated malware warning page rather than counting as an ad block.
  const malwareUrls = [];
  // Entries carrying `category: 'tracker'` (e.g. EasyPrivacy in config.js)
  // convert their bare-domain patterns into tracker_network_patterns instead
  // of ad_network_patterns — see _abpParseFile's own comment. A plain Set of
  // urls, not entries, since that's what _fetchAndConvertUrls/urls already
  // key on.
  const trackerUrls = new Set();
  const legacyAllDisabled = stored.defaultRuleSourceEnabled === false;
  for (const [i, entry] of RULES_REMOTE_URL.entries()) {
    if (!_isDefaultSourceEnabled(entry, stored.defaultRuleSourceOverrides, legacyAllDisabled)) continue;
    if (entry.format === 'hosts') {
      for (const u of _entryUrls(entry)) malwareUrls.push(u);
      continue;
    }
    if (DEBUG_LOCAL && i === 0) {
      urls.push(EXT.runtime.getURL(RULES_LOCAL_PATH));
    } else {
      for (const u of _entryUrls(entry)) {
        urls.push(u);
        if (entry.category === 'tracker') trackerUrls.add(u);
      }
    }
  }

  if (sources && sources.length) {
    for (const s of sources) {
      if (s.enabled === false) continue;
      if (s.type === 'url' && s.url && !defaultUrls.has(s.url)) urls.push(s.url);
      else if (s.type === 'file' && s.text) fileParts.push(s.text);
    }
  } else if (stored.customRulesUrl && !defaultUrls.has(stored.customRulesUrl)) {
    urls.push(stored.customRulesUrl);
  }

  // Append user's custom rules text (merged with built-in rules via parseRuleText merge logic)
  if (stored.customRulesText) fileParts.push(stored.customRulesText);

  // Each fetched/uploaded piece may be in raw ABP/uBO syntax rather than this
  // repo's own grammar — _maybeConvertAbpText detects and converts, or
  // returns the text unchanged if it's already native (including the local
  // fallback/customRulesText pieces in fileParts, which always are). One
  // shared usedKeys Set spans EVERY piece converted below (URLs and uploaded
  // files alike) so two independently-enabled ABP-format sources can never
  // mint the same [host_patterns] section key for two unrelated domain
  // groups — see _maybeConvertAbpText's own comment for the real
  // cross-source contamination this closes (confirmed with real EasyList +
  // EasyPrivacy + ABPVN text, 2026-08-23). sharedDedicatedDomains is the
  // complementary fix (2026-08-23): when two DIFFERENT sources each have
  // their OWN dedicated rule for the exact same domain, they now merge into
  // one section instead of only the first-processed source's rules for that
  // domain ever actually resolving (see _abpRender's own comment).
  const sharedAbpKeys = new Set();
  const sharedDedicatedDomains = new Map();
  // Shared across EVERY source converted in this call (urls AND fileParts) —
  // see NETWORK_RULE_BUDGET's own comment for why this exists. This runs
  // per-install (each browser fetches+converts its OWN copy, nothing shared
  // server-side), so the budget itself can be conditional: on a browser with
  // webRequestBlocking (Firefox — see _hasWebRequestBlocking()),
  // network_block_rules never becomes a DNR rule at all (buildNetworkBlockMatcher()
  // instead), so there's no DNR rule-count ceiling to protect here — every
  // eligible entry converts, uncapped. Chrome/Edge keep the real cap.
  const networkRuleBudget = { remaining: _hasWebRequestBlocking() ? Infinity : NETWORK_RULE_BUDGET };
  const texts = await _fetchAndConvertUrls(urls, sharedAbpKeys, sharedDedicatedDomains, networkRuleBudget, trackerUrls);
  const convertedFileParts = await Promise.all(fileParts.map(t => _maybeConvertAbpText(t, undefined, sharedAbpKeys, sharedDedicatedDomains, networkRuleBudget)));
  // Sequential (not Promise.all'd with the fetch above): both this and
  // _fetchAndConvertUrls independently read-modify-write the shared
  // RULE_SOURCE_ERRORS_KEY/RULE_SOURCE_STATS_KEY storage keys — running them
  // concurrently would race and drop whichever one's write lands first.
  await _updateRemoteMalwareDomains(malwareUrls);

  const merged = [...texts, ...convertedFileParts].filter(Boolean).join('\n');
  if (!merged && urls.length) {
    // At least one remote fetch was attempted and all of them came back
    // empty — that's an actual failure (network down, bad URL, ...), so
    // let getRulesText()'s catch branch fall back to cached/local rules.
    throw new Error('no rules available');
  }
  // Empty here with no urls attempted means every source was deliberately
  // disabled (or the only ones enabled produced no text) — not a fetch
  // failure, so this is a legitimate zero-rules result, not something to
  // paper over with the bundled local rules.
  await setCachedRuleText(merged);
  return merged;
}

async function fetchLocalRuleText() {
  const res = await fetch(EXT.runtime.getURL(RULES_LOCAL_PATH), { cache: 'no-store' });
  return res.ok ? res.text() : '';
}

// ── Remote rules revalidation (ETag) ──────────────────────────────
// The 6h TTL alone means an urgent rules fix can take up to 6h to reach
// users. Instead, a 30-minute alarm revalidates every enabled default
// source with If-None-Match: a 304 response costs a few hundred bytes and
// just extends the cache; only a real content change triggers the full
// reload pipeline.
const RULES_REVALIDATE_ALARM = 'rules-revalidate';
const RULES_REVALIDATE_PERIOD_MIN = 30;
// Both now { [url]: value } maps — one default source's ETag/hash per key,
// since RULES_REMOTE_URL can hold more than one built-in source.
const RULES_REMOTE_ETAG_KEY = 'siteRulesRemoteEtag';
const RULES_REMOTE_HASH_KEY = 'siteRulesRemoteHash';
// Fingerprint of the LAST dynamic rule set actually sent to
// updateDynamicRules() — see _applyNetworkRulesImpl's own comment for why.
const DNR_RULES_HASH_KEY = 'dnrRulesAppliedHash';

// djb2 — cheap content fingerprint, fallback when the server rotates ETags
// (CDN) or omits them, so a 200 with identical content doesn't force a reload.
function _hashText(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// ── Rule-input fingerprint (Phase 1a perf fix) ───────────────────────
// buildActiveRulesFromStorage()'s output is a PURE function of: these
// storage keys, sessionAllowedDomains (chrome.storage.session), and the
// static DEFAULT_RULES/MALWARE_RULES/etc. definitions (which only change
// when ensureRuleDefinitionsLoaded() actually rebuilds them, tracked below
// via _ruleGeneration). Hashing each input individually — computed once
// per storage WRITE via onChanged, not once per applyNetworkRules() CALL —
// instead of JSON.stringify-ing the full generated `allRules` array (which
// can carry a remoteMalwareDomains list up to REMOTE_MAX_DOMAINS=200000
// entries spread across requestDomains conditions) turns the "did anything
// change" check from O(total rule/domain count) per call into O(1) per
// call, paying the real cost only when an input actually changes.
const RULE_INPUT_KEYS = [
  'enabled', 'blockAds', 'blockTrackers', 'blockMalware', 'focusMode',
  'pausedDomains', 'allowedDomains', 'rules', 'remoteMalwareDomains',
  'remoteMalwarePathPatterns', 'remoteMalwareRules', 'distractionDomains',
];
let _ruleGeneration = 0; // bumped each time ensureRuleDefinitionsLoaded() actually rebuilds
const _ruleInputHashes = {};
let _sessionAllowedDomainsHash = '';
function _hashValue(v) {
  return _hashText(JSON.stringify(v === undefined ? null : v));
}
LocalStorage.get(RULE_INPUT_KEYS).then(r => {
  for (const key of RULE_INPUT_KEYS) _ruleInputHashes[key] = _hashValue(r[key]);
}).catch(() => {});
SessionStorage.get('sessionAllowedDomains').then(r => {
  _sessionAllowedDomainsHash = _hashValue(r.sessionAllowedDomains);
});
EXT.storage.onChanged.addListener((changes, area) => {
  if (area === 'session') {
    if (changes.sessionAllowedDomains) _sessionAllowedDomainsHash = _hashValue(changes.sessionAllowedDomains.newValue);
    return;
  }
  if (area !== 'local') return;
  for (const key of RULE_INPUT_KEYS) {
    if (changes[key]) _ruleInputHashes[key] = _hashValue(changes[key].newValue);
  }
});
function _ruleFingerprint() {
  return _hashText(JSON.stringify({ gen: _ruleGeneration, session: _sessionAllowedDomainsHash, ..._ruleInputHashes }));
}

// Full reload pipeline — shared by the dashboard's RULES_CHANGED message and
// the revalidation alarm: drop caches, rebuild DNR rules, notify all tabs.
async function reloadRules() {
  await LocalStorage.set({
    [RULES_CACHE_TEXT_KEY]: '',
    [RULES_CACHE_TIME_KEY]: 0,
  });
  DEFAULT_RULES = [];
  MALWARE_RULES = [];
  AD_MAINFRAME_RULES = [];
  _ruleConfigPromise = null;
  _parsedRules = null;
  _curatedDedupPromise = null;
  await applyNetworkRules();
  const tabs = await EXT.tabs.query({});
  for (const tab of tabs) {
    EXT.tabs.sendMessage(tab.id, { type: 'RULES_CHANGED' }).catch(() => {});
  }
}

// Debounced trailing-edge wrapper around reloadRules(), used ONLY by the
// dashboard's own RULES_CHANGED message handler below — not by the
// revalidation alarm or other direct reloadRules() callers, which are each
// already single, deliberate actions. Toggling several rule sources on/off
// in quick succession (or an autosaving custom-rules textarea) previously
// fired one full re-fetch-all-sources+rebuild pass PER message; this
// coalesces any messages arriving within RULES_CHANGED_DEBOUNCE_MS into a
// single reloadRules() call reflecting the final state, while still
// resolving every caller's sendResponse once that single run finishes.
const RULES_CHANGED_DEBOUNCE_MS = 400;
let _rulesChangedTimer = null;
let _rulesChangedWaiters = [];
function debouncedReloadRules() {
  return new Promise((resolve, reject) => {
    _rulesChangedWaiters.push({ resolve, reject });
    if (_rulesChangedTimer) clearTimeout(_rulesChangedTimer);
    _rulesChangedTimer = setTimeout(() => {
      _rulesChangedTimer = null;
      const waiters = _rulesChangedWaiters;
      _rulesChangedWaiters = [];
      reloadRules().then(
        () => { for (const w of waiters) w.resolve(); },
        (err) => { for (const w of waiters) w.reject(err); }
      );
    }, RULES_CHANGED_DEBOUNCE_MS);
  });
}

async function revalidateRemoteRules() {
  try {
    const stored = await LocalStorage.get([
      'defaultRuleSourceEnabled', 'defaultRuleSourceOverrides',
      RULES_REMOTE_ETAG_KEY, RULES_REMOTE_HASH_KEY,
    ]);
    const legacyAllDisabled = stored.defaultRuleSourceEnabled === false;
    const enabledEntries = RULES_REMOTE_URL.filter(
      e => _isDefaultSourceEnabled(e, stored.defaultRuleSourceOverrides, legacyAllDisabled)
    );
    if (!enabledEntries.length) return false; // every default source turned off — nothing to revalidate

    const etags = stored[RULES_REMOTE_ETAG_KEY] || {};
    const hashes = stored[RULES_REMOTE_HASH_KEY] || {};
    const nextEtags = { ...etags };
    const nextHashes = { ...hashes };
    let changed = false;
    // Each url revalidated independently — one unreachable/erroring url
    // (e.g. a region list that moved) must not block the others, whether
    // it's a whole other source or just another url in the SAME entry's
    // group (an entry's `url` can be an array — see _entryUrls' own
    // comment; every url in the group is tracked by its own ETag/hash,
    // same as if they were separate entries).
    for (const entry of enabledEntries) {
      for (const url of _entryUrls(entry)) {
        try {
          const etag = etags[url] || '';
          const res = await fetch(url, {
            cache: 'no-store',
            headers: etag ? { 'If-None-Match': etag } : {},
          });
          if (res.status === 304) continue; // unchanged
          if (!res.ok) continue;
          const text = await res.text();
          const newHash = _hashText(text);
          nextEtags[url] = res.headers.get('etag') || '';
          nextHashes[url] = newHash;
          if (newHash !== (hashes[url] || '')) changed = true;
        } catch { /* this url failed — keep checking the rest of the group and other sources */ }
      }
    }
    await LocalStorage.set({
      [RULES_REMOTE_ETAG_KEY]: nextEtags,
      [RULES_REMOTE_HASH_KEY]: nextHashes,
    });
    if (!changed) {
      // Nothing changed (all 304s / failures) — keep serving the cache and
      // push its expiry out.
      await LocalStorage.set({ [RULES_CACHE_TIME_KEY]: Date.now() });
      return false;
    }
    // At least one source's content actually changed — run the full
    // pipeline (re-fetches ALL sources incl. user ruleSources, rebuilds
    // DNR, notifies tabs).
    await reloadRules();
    console.log('[AdBlock] Remote rules changed — reloaded');
    return true;
  } catch {
    return false; // offline etc. — cache TTL remains the safety net
  }
}

// ── Extension update check ──────────────────────────────────────────
// Chrome/Firefox both auto-update a STORE-installed extension silently in
// the background — this does NOT trigger or replace that, there's no
// public API for an extension to force it (chrome.runtime.requestUpdateCheck
// exists but only asks the browser to check on ITS OWN schedule, gives no
// target version number to display, and is a no-op for an unpacked/dev
// install). This is a lightweight informational check instead: fetch this
// repo's own manifest.json (the SAME GitHub repo rule/site-rules.txt
// already comes from — one already-trusted canonical source) and compare
// its version against what's actually installed, so the popup/dashboard
// can show "a newer version exists" with a link to the store listing.
// Particularly useful for exactly the kind of manually-loaded/unpacked
// install this repo's own DEBUG_LOCAL workflow produces, which the
// browser's silent auto-update mechanism never covers at all.
function _isNewerVersion(remote, local) {
  const r = String(remote || '').split('.').map(n => parseInt(n, 10) || 0);
  const l = String(local || '').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(r.length, l.length);
  for (let i = 0; i < len; i++) {
    const rv = r[i] || 0, lv = l[i] || 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

// navigator.userAgent is available in the service worker context just like
// anywhere else — same technique popup.js/dashboard.js already use for this
// exact kind of "pick a URL for the current browser" decision
// (_detectStoreUrl/_detectUpdateStoreUrl), reused here instead of a
// different detection method for the same purpose. Not manifest content
// (browser_specific_settings isn't actually Firefox-exclusive by spec, it
// just happens to be the one distinguishing field between this repo's two
// CURRENT manifests — a coincidence, not a guarantee).
function _isFirefoxInstall() {
  return navigator.userAgent.includes('Firefox/');
}

// True only where the webRequest/webRequestBlocking permissions were
// actually granted — Firefox, after manifest.firefox.json requested them
// (Chrome/Edge MV3 never grants blocking webRequest, so this always resolves
// false there with no UA sniffing needed). Feature-detection instead of
// _isFirefoxInstall()-style UA checking on purpose: it self-corrects if a
// future manifest change adds/drops the permission, and it's what actually
// determines whether EXT.webRequest.onBeforeRequest is even callable.
// network_block_rules is the one DNR tier this backs OUT of on this browser
// (see buildNetworkBlockMatcher()/the webRequest listener below) — Firefox's
// declarativeNetRequest dynamic-rule cap is a flat 5000 covering every OTHER
// tier combined too (confirmed live 2026-08-31, see
// [[abp-path-scoped-network-rule-conversion]] memory), and network_block_
// rules alone routinely exceeds that on its own — moving just this one tier
// to webRequestBlocking (no rule-count ceiling at all) fixes it without
// touching manifest_version or any other tier's DNR-based logic.
function _hasWebRequestBlocking() {
  return !!(EXT.webRequest && EXT.webRequest.onBeforeRequest && EXT.webRequest.onBeforeRequest.addListener);
}

async function checkForExtensionUpdate() {
  const currentVersion = EXT.runtime.getManifest().version;
  const metaUrl = _isFirefoxInstall() ? EXTENSION_META_REMOTE_URL_FIREFOX : EXTENSION_META_REMOTE_URL;
  try {
    const res = await fetch(metaUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error('bad status');
    const remoteManifest = await res.json();
    const latestVersion = String(remoteManifest.version || '');
    const updateInfo = {
      latestVersion: latestVersion || currentVersion,
      available: latestVersion ? _isNewerVersion(latestVersion, currentVersion) : false,
      lastChecked: Date.now(),
      lastCheckOk: true,
    };
    await LocalStorage.set({ updateInfo });
    return updateInfo;
  } catch {
    // Offline / repo unreachable — keep whatever was last known, just stamp
    // the failed attempt so the UI can show "last checked: failed just now"
    // instead of silently reusing a possibly stale success from days ago.
    const { updateInfo: prev = {} } = await LocalStorage.get('updateInfo');
    const updateInfo = { ...prev, lastChecked: Date.now(), lastCheckOk: false };
    await LocalStorage.set({ updateInfo });
    return updateInfo;
  }
}

async function maybeCheckForExtensionUpdate() {
  const { updateInfo = {} } = await LocalStorage.get('updateInfo');
  const ONE_DAY = 24 * 60 * 60 * 1000;
  if (Date.now() - (updateInfo.lastChecked || 0) > ONE_DAY) {
    await checkForExtensionUpdate();
  }
}

// A pattern that is a bare hostname can be matched via requestDomains, which is
// domain-indexed by the browser (much faster than urlFilter substring scan) and
// lets many domains share a single rule. Anything else (paths like
// "facebook.com/tr") stays as an individual urlFilter rule.
const DOMAIN_PATTERN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

// Sites that fingerprint adblockers by bait-loading a known ad URL and
// checking onload (succeeded) vs onerror (blocked) — see VNExpress's own
// detector, jn() — see a real network error from a hard `block` action just
// as clearly as they'd see the ad itself missing. Redirecting instead to an
// inert placeholder from web_accessible_resources/ (same folder + manifest
// wiring as inject-web-accessible-resources.js) makes the request "succeed"
// harmlessly, defeating that class of detector. Only resourceTypes with a
// safe, well-understood placeholder are mapped; anything else still falls
// back to a hard block.
// One shared table for BOTH ad and tracker rules (buildPatternRules already
// takes `resourceTypes` as its own filter argument — an entry here for a
// type the caller's resourceTypes list doesn't include is simply never
// looked up, so ads and trackers safely share one merged table instead of
// keeping two near-duplicate ones in sync by hand). sub_frame is only ever
// requested by the ad-rule call site, ping only by the tracker-rule call
// site — trackers get the exact same treatment as ads (analytics beacons
// fail exactly the same visible way as ad bait requests do); ping reads no
// response at all, so it gets the 0-byte file rather than a typed placeholder.
const REDIRECT_RESOURCE_BY_TYPE = {
  script: 'noop.js',
  image: '1x1.gif',
  sub_frame: 'noop.html',
  xmlhttprequest: 'noop.txt', // '{}' — safe for JSON.parse() callers
  ping: 'empty',
  other: 'empty', // uncategorized/misc requests — no format guarantee, 0-byte is safest
};

// A handful of tracker/ad domains ship a purpose-built, API-compatible stub
// in web_accessible_resources/ (e.g. a fake ga()/gtag() shim) rather than
// being served the fully-generic noop.js. That matters because page code
// often calls a global the real script would have defined (ga(...),
// __gaTracker(...), googletag.cmd.push(...)) — a truly empty script leaves
// that global undefined and throws, whereas the matching stub defines a
// harmless no-op version of it. Only ever applies to the 'script'
// resourceType; other resourceTypes for these same domains still use the
// generic per-type placeholder.
const SPECIFIC_SCRIPT_REDIRECTS = {
  'google-analytics.com': 'google-analytics_analytics.js',
  'googlesyndication.com': 'googlesyndication_adsbygoogle.js',
  'googletagmanager.com': 'googletagmanager_gtm.js',
  'googletagservices.com': 'googletagservices_gpt.js',
  'amazon-adsystem.com': 'amazon_apstag.js',
  'outbrain.com': 'outbrain-widget.js',
  'imasdk.googleapis.com': 'google-ima.js',
  'scorecardresearch.com': 'scorecardresearch_beacon.js',
  'chartbeat.com': 'chartbeat.js',
  'doubleclick.net': 'doubleclick_instream_ad_status.js',
};

// Alternate spellings a filter list's own $redirect=/$redirect-rule= value
// might use for one of the files this extension actually ships in
// web_accessible_resources/ — only entries for files that exist here are
// listed; a name that would resolve to a file we don't have is left
// unresolvable on purpose (network_redirect_rules below drops the whole
// rule rather than point a redirect at a 404). Grouped by canonical
// filename for readability; REDIRECT_RESOURCE_ALIASES (below) is the
// flattened alias->file lookup actually used at match time.
const REDIRECT_RESOURCE_FILES = {
  'noop.js': ['noopjs'],
  'noop.html': ['noopframe'],
  'noop.txt': ['nooptext'],
  'noop.json': ['noopjson'],
  'empty': ['noop'],
  '1x1.gif': ['1x1-transparent.gif', '1x1transparent.gif'],
  'google-ima.js': ['google-ima', 'google-ima3', 'googleima3'],
  'googlesyndication_adsbygoogle.js': ['googlesyndication.com/adsbygoogle.js', 'adsbygoogle.js'],
  'googletagservices_gpt.js': ['googletagservices.com/gpt.js', 'googletagservices-gpt', 'gpt.js'],
  'google-analytics_analytics.js': ['google-analytics.com/analytics.js'],
  'googletagmanager_gtm.js': ['googletagmanager.com/gtm.js', 'gtm.js'],
  'amazon_apstag.js': ['amazon-adsystem.com/aax2/amazon-apstag.js'],
  'scorecardresearch_beacon.js': ['scorecardresearch.com/beacon.js'],
  'doubleclick_instream_ad_status.js': ['doubleclick.net/instream/ad_status.js'],
  'chartbeat.js': [],
  'outbrain-widget.js': [],
  'noop.css': [],
  '2x2.png': ['2x2-transparent.png'],
  '32x32.png': ['32x32-transparent.png'],
  '3x2.png': [],
  'noop-0.1s.mp3': ['noopmp3-0.1s'],
  'noop-1s.mp4': ['noopmp4-1s'],
  'noop-vast2.xml': ['noopvast-2.0', 'noopvast2'],
  'noop-vast3.xml': ['noopvast-3.0', 'noopvast3'],
  'noop-vast4.xml': ['noopvast-4.0', 'noopvast4'],
  'noop-vmap1.xml': ['noop-vmap1.0.xml', 'noopvmap1', 'noopvmap-1.0'],
  'google-analytics_ga.js': ['google-analytics.com/ga.js'],
  'google-analytics_cx_api.js': ['google-analytics.com/cx/api.js'],
  'amazon_ads.js': ['amazon-adsystem.com/aax2/amzn_ads.js'],
  'fingerprint2.js': [],
  'fingerprint3.js': [],
  'nofab.js': ['fuckadblock.js-3.2.0', 'fuckadblock-3.2.0.js'],
  'popads-dummy.js': [],
  'popads.js': ['popads.net.js', 'popads.net'],
  'click2load.html': [],
  'prebid-ads.js': ['prebid'],
  'hd-main.js': [],
  'sensors-analytics.js': [],
  'ampproject_v0.js': [],
  'nitropay_ads.js': [],
  'adthrive_abd.js': [],
  'noeval.js': [],
  'noeval-silent.js': [],
};
const REDIRECT_RESOURCE_ALIASES = new Map();
for (const [file, aliases] of Object.entries(REDIRECT_RESOURCE_FILES)) {
  REDIRECT_RESOURCE_ALIASES.set(file, file);
  for (const alias of aliases) REDIRECT_RESOURCE_ALIASES.set(alias, file);
}

// A filter-list $redirect= value can carry a ":priority" suffix (only
// meaningful when several $redirect rules on the SAME request compete —
// this project's DNR-based rules only ever redirect to one place, so the
// suffix is stripped and ignored rather than acted on).
function _resolveRedirectResourceName(name) {
  return REDIRECT_RESOURCE_ALIASES.get(String(name || '').replace(/:\d+$/, ''));
}

// redirect.url (a fully-resolved chrome.runtime.getURL() call, baked in at
// rule-BUILD time), NOT redirect.extensionPath (a bare relative path Chrome
// resolves against the extension's REAL STATIC id at request-match time —
// confirmed live via DevTools + a purpose-built leak scanner, see
// [[self-inflicted-fingerprint-markers]]'s 2026-08-07 entries: extensionPath
// does NOT honor this resource's use_dynamic_url:true manifest entry at
// all, it always resolves to the permanent id, which a page can read
// straight off response.url on any redirected request with zero DevTools
// needed — a strictly worse leak than what dynamic ids exist to prevent).
// chrome.runtime.getURL() correctly returns the dynamic per-session id;
// applyNetworkRules() (called from both onInstalled and onStartup) rebuilds
// every dynamic rule fresh each time it runs, so a freshly-reloaded
// extension always re-bakes a current id. DO NOT "fix" 307/SecurityError
// noop.txt failures by switching this back to extensionPath — that trades
// a staleness bug for a strictly worse, already-diagnosed static-id leak.
function _redirectAction(file) {
  return { type: 'redirect', redirect: { url: EXT.runtime.getURL(`/web_accessible_resources/${file}`) } };
}

// One invalid domain in requestDomains rejects the whole updateDynamicRules
// call, so every grouped domain must be validated first.
// redirectByType (optional): { resourceType: 'placeholder-file-in-web_accessible_resources/' }
// — resourceTypes with an entry get action:redirect to that file; the rest
// still get action:block. specificScriptRedirects (optional): domain ->
// file, checked only for the 'script' resourceType, taking priority over
// redirectByType.script for that domain. Rule IDs (not action type) drive
// stat attribution (see AD_RULE_IDS/TRACKER_RULE_IDS below), so switching
// block->redirect here doesn't affect the "ads blocked" counter.
function buildPatternRules(patterns, startId, resourceTypes, priority, redirectByType, specificScriptRedirects) {
  const domains = [];
  const urlFilters = [];
  for (const p of patterns) {
    if (DOMAIN_PATTERN_RE.test(p)) domains.push(p.toLowerCase());
    // Everything else (wildcard-TLD patterns like "example.*", or any other
    // complex ABP construct ad_network_patterns/tracker_network_patterns
    // can carry from third-party sources) is used directly as a urlFilter
    // with no other sanitization — validate it first, same "one bad rule
    // rejects the WHOLE updateDynamicRules() call" reasoning as
    // buildNetworkRedirectRules/buildQueryStripRules's own _isValidUrlFilter
    // check (2026-08-24).
    else if (_isValidUrlFilter(p)) urlFilters.push(p);
  }

  const rules = [];
  let id = startId;

  // 'script' gets split out first when per-domain overrides are in play:
  // domains with a specific stub each get their own single-domain rule;
  // everything else (domains without an override, plus all urlFilters)
  // still gets batched under the generic per-type placeholder exactly like
  // every other resourceType below.
  let remainingTypes = resourceTypes;
  if (specificScriptRedirects && resourceTypes.includes('script')) {
    remainingTypes = resourceTypes.filter(t => t !== 'script');
    const overridden = domains.filter(d => specificScriptRedirects[d]);
    const generic = domains.filter(d => !specificScriptRedirects[d]);
    for (const d of overridden) {
      rules.push({
        id: id++, priority,
        action: _redirectAction(specificScriptRedirects[d]),
        condition: { requestDomains: [d], resourceTypes: ['script'] },
      });
    }
    const scriptFile = redirectByType && redirectByType.script;
    const scriptAction = scriptFile ? _redirectAction(scriptFile) : { type: 'block' };
    if (generic.length) {
      rules.push({ id: id++, priority, action: scriptAction, condition: { requestDomains: generic, resourceTypes: ['script'] } });
    }
    for (const f of urlFilters) {
      rules.push({ id: id++, priority, action: scriptAction, condition: { urlFilter: f, resourceTypes: ['script'] } });
    }
  }

  // Remaining resourceTypes: group by the action they'll get, so types
  // sharing a placeholder (or sharing "just block") collapse into one rule.
  const groups = new Map(); // actionKey -> { action, types }
  for (const t of remainingTypes) {
    const file = redirectByType && redirectByType[t];
    const actionKey = file || '__block__';
    if (!groups.has(actionKey)) {
      groups.set(actionKey, { action: file ? _redirectAction(file) : { type: 'block' }, types: [] });
    }
    groups.get(actionKey).types.push(t);
  }
  for (const { action, types } of groups.values()) {
    if (domains.length) {
      rules.push({ id: id++, priority, action, condition: { requestDomains: domains, resourceTypes: types } });
    }
    for (const f of urlFilters) {
      rules.push({ id: id++, priority, action, condition: { urlFilter: f, resourceTypes: types } });
    }
  }
  return rules;
}

function buildDefaultRulesFromConfig(config) {
  const adTypes = ['script', 'image', 'xmlhttprequest', 'sub_frame', 'other'];
  const trackerTypes = ['script', 'image', 'xmlhttprequest', 'ping', 'other'];
  // Both ads and trackers get the fake-success redirect — defeats
  // bait-request adblock/tracker-block detectors (image, script, and xhr/
  // beacon failures are all equally visible to page code checking for them).
  const adRules = buildPatternRules(config.adNetworkPatterns, 1, adTypes, 1, REDIRECT_RESOURCE_BY_TYPE, SPECIFIC_SCRIPT_REDIRECTS);
  const trackerRules = buildPatternRules(config.trackerNetworkPatterns, adRules.length + 1, trackerTypes, 1, REDIRECT_RESOURCE_BY_TYPE, SPECIFIC_SCRIPT_REDIRECTS);
  return { adRules, trackerRules };
}

// main_frame malware hits are redirected to the extension's warning page
// instead of plain-blocked: a blocked navigation runs no content script, so
// it would otherwise be invisible in stats. The warning page reports the
// blocked host back via MALWARE_PAGE_BLOCKED. \1 captures the hostname.
const MALWARE_REDIRECT_REGEX = '^[a-zA-Z]+://([^/:]+)';

function malwareMainFrameRedirect() {
  return {
    type: 'redirect',
    redirect: { regexSubstitution: EXT.runtime.getURL('blocked/blocked.html') + '?h=\\1' },
  };
}

function buildMalwareRulesFromConfig(config, startId) {
  const subresourceTypes = ['sub_frame', 'script', 'xmlhttprequest', 'image'];
  const domains = config.malwareNetworkDomains
    .filter(d => DOMAIN_PATTERN_RE.test(d))
    .map(d => d.toLowerCase());
  if (!domains.length) return [];
  return [
    {
      id: startId,
      priority: 2,
      action: { type: 'block' },
      condition: { requestDomains: domains, resourceTypes: subresourceTypes },
    },
    {
      id: startId + 1,
      priority: 2,
      action: malwareMainFrameRedirect(),
      condition: {
        requestDomains: domains,
        regexFilter: MALWARE_REDIRECT_REGEX,
        resourceTypes: ['main_frame'],
      },
    },
  ];
}

// ── Ad-network / popunder main_frame auto-detect ────────────────────────
// Click-hijack ("poster" click opens a new tab) and popunder ads almost
// always navigate the new tab straight to a known ad-network domain — the
// same list already used to block ad subresources (adNetworkPatterns), just
// never applied to main_frame before. Reusing it here means every site gets
// this protection automatically, with no per-site rule needed: the moment a
// click opens a tab pointing at one of these domains, the navigation itself
// is redirected to the warning page instead of loading the ad site.
function adMainFrameRedirect() {
  return {
    type: 'redirect',
    redirect: { regexSubstitution: EXT.runtime.getURL('blocked/blocked.html') + '?t=ad&h=\\1' },
  };
}

function buildAdMainFrameRulesFromConfig(config, startId) {
  const domains = config.adNetworkPatterns
    .filter(d => DOMAIN_PATTERN_RE.test(d))
    .map(d => d.toLowerCase());
  if (!domains.length) return [];
  return [
    {
      id: startId,
      priority: 2,
      action: adMainFrameRedirect(),
      condition: {
        requestDomains: domains,
        regexFilter: MALWARE_REDIRECT_REGEX,
        resourceTypes: ['main_frame'],
      },
    },
  ];
}

// Single source for the merged rules text (fresh cache → remote → cached/local
// fallback). Used by rule-definition loading, GET_RULES_TEXT, and GET_SITE_CONFIG.
async function getRulesText() {
  const cached = await getCachedRuleText();
  // Debug build: never serve the cache — fetchRemoteRuleText() itself
  // already swaps the bundled default entry for the local file when
  // DEBUG_LOCAL is set (see its own comment), so a plain cache-skip here is
  // all that's needed for local site-rules.txt edits to take effect on
  // every reload instead of waiting out the 6h TTL.
  if (!DEBUG_LOCAL && isFreshRuleCache(cached)) return cached.text;
  try {
    return await fetchRemoteRuleText();
  } catch {
    // Fallback: use cached/local rules, but still append customRulesText
    const baseText = (cached && cached.text) || await fetchLocalRuleText();
    const { customRulesText: customText = '' } = await LocalStorage.get('customRulesText');
    const text = customText ? baseText + '\n' + customText : baseText;
    if (text) await setCachedRuleText(text);
    return text;
  }
}

// Parsed rules cached in the service worker so the text is parsed ONCE here
// instead of by every content-script frame. Reset on RULES_CHANGED.
let _parsedRules = null;
let _parsedRulesPromise = null;

// Cross-SW-restart parse cache (2026-08-23, compressed 2026-08-25).
// `_parsedRules` above only survives ONE service-worker lifetime — a real
// user with several large Rule Sources enabled can have a multi-MB merged
// siteRulesCacheText, and MV3 service workers restart on a short idle
// timeout, far more often than the rules text itself actually changes. That
// means the custom line-by-line parseRuleText() reran on EVERY cold start
// even though its input was identical — measured live 654.6ms at a real
// 18.79MB/344,586-line multi-source config, once per restart.
// chrome.storage.session (cleared on browser restart, NOT on SW restart, and
// a SEPARATE quota pool from chrome.storage.local — doesn't worsen local's
// already-tight usage) lets the ALREADY-PARSED object itself survive a cold
// start. Stored COMPRESSED (deflate-raw, same _compressForStorage/
// _decompressFromStorage helpers as siteRulesCacheText), not the bare
// object: at that same real scale, the raw parsed object was 14.84MB —
// OVER chrome.storage.session's 10MB quota, so an uncompressed write
// silently failed every time (caught by the try/catch below) and this cache
// never populated at all — every cold start paid the full parse cost above
// for zero benefit, invisibly. Compressed, that object measured 5.40MB
// (fits), and decompress+JSON.parse read-back measured 116.4ms — an 82%
// reduction vs re-parsing from scratch. The extra stringify+compress cost on
// write (~378ms measured) doesn't matter: it happens once per rules change,
// not on the cold-start hot path this cache exists for. Keyed by a content
// hash of the raw rules text so it's self-invalidating the moment that text
// actually changes (reloadRules() doesn't need to explicitly clear this —
// the hash simply won't match next time, same self-invalidation style the
// hash-based caches elsewhere in this file already use), and best-effort
// (old-browser session-storage-unavailable, corrupt/undersized cache, or any
// read/write failure just falls through to a real parse — never blocks or
// breaks anything).
const PARSED_RULES_SESSION_KEY = 'parsedRulesSessionCache'; // { hash, compressed }

// Cross-SW-restart cache for ensureRuleDefinitionsLoaded()'s OUTPUT (2026-08-31)
// — same idea as PARSED_RULES_SESSION_KEY above, one layer deeper. That cache
// only saves parseRuleText() (text -> parsed object); everything BUILT from
// the parsed object (DEFAULT_RULES, MALWARE_RULES, AD_MAINFRAME_RULES,
// QUERY_STRIP_RULES, NETWORK_REDIRECT_RULES, NETWORK_BLOCK_RULES/
// NETWORK_BLOCK_MATCHER) lived in plain module-level `let`s that don't
// survive a SW restart, so the FULL build reran every single cold start —
// live-measured 2026-08-31 at a real default-enabled-sources scale: ~99ms
// per restart, unchanged regardless of how many restarts happen with
// identical input (MV3 restarts the SW after a short idle timeout, far more
// often than the rules text itself changes). Same fix, same pattern: store
// compressed in chrome.storage.session, keyed by the SAME content hash
// getParsedRules() already computes — one hash invalidates both caches
// together the instant the underlying text actually changes.
const BUILT_RULES_SESSION_KEY = 'builtRulesSessionCache'; // { hash, compressed }

// NETWORK_BLOCK_MATCHER's entries carry a compiled RegExp (`regex`) plus
// Set/Map fields (resourceTypes, initiatorDomains, ...) — none of those
// round-trip through JSON.stringify/parse as-is (a RegExp serializes to
// `{}`, a Set/Map to `{}` too). Convert to/from plain arrays + the regex's
// SOURCE string; _urlFilterToRegExp's caller already only ever needs
// `new RegExp(source)` back, not the exact same object reference.
function _serializeMatcherEntry(e) {
  const out = { regexSource: e.regex.source };
  if (e.resourceTypes) out.resourceTypes = [...e.resourceTypes];
  if (e.excludedResourceTypes) out.excludedResourceTypes = [...e.excludedResourceTypes];
  if (e.initiatorDomains) out.initiatorDomains = [...e.initiatorDomains.keys()];
  if (e.excludedInitiatorDomains) out.excludedInitiatorDomains = [...e.excludedInitiatorDomains.keys()];
  if (e.excludedRequestDomains) out.excludedRequestDomains = [...e.excludedRequestDomains.keys()];
  if (e.requestMethods) out.requestMethods = [...e.requestMethods];
  if (e.excludedRequestMethods) out.excludedRequestMethods = [...e.excludedRequestMethods];
  if (e.domainType) out.domainType = e.domainType;
  return out;
}
function _rehydrateMatcherEntry(o) {
  const e = { regex: new RegExp(o.regexSource) };
  if (o.resourceTypes) e.resourceTypes = new Set(o.resourceTypes);
  if (o.excludedResourceTypes) e.excludedResourceTypes = new Set(o.excludedResourceTypes);
  if (o.initiatorDomains) e.initiatorDomains = new Map(o.initiatorDomains.map(d => [d, true]));
  if (o.excludedInitiatorDomains) e.excludedInitiatorDomains = new Map(o.excludedInitiatorDomains.map(d => [d, true]));
  if (o.excludedRequestDomains) e.excludedRequestDomains = new Map(o.excludedRequestDomains.map(d => [d, true]));
  if (o.requestMethods) e.requestMethods = new Set(o.requestMethods);
  if (o.excludedRequestMethods) e.excludedRequestMethods = new Set(o.excludedRequestMethods);
  if (o.domainType) e.domainType = o.domainType;
  return e;
}
function _serializeMatcherMap(map) {
  const out = {};
  for (const [domain, entries] of map) out[domain] = entries.map(_serializeMatcherEntry);
  return out;
}
function _rehydrateMatcherMap(obj) {
  const map = new Map();
  for (const domain in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, domain)) map.set(domain, obj[domain].map(_rehydrateMatcherEntry));
  }
  return map;
}

async function getParsedRules() {
  if (_parsedRules) return _parsedRules;
  if (!_parsedRulesPromise) {
    _parsedRulesPromise = (async () => {
      const text = await getRulesText();
      const textHash = _hashText(text);
      const { [PARSED_RULES_SESSION_KEY]: cached } = await SessionStorage.get(PARSED_RULES_SESSION_KEY);
      if (cached && cached.hash === textHash && cached.compressed) {
        const json = await _decompressFromStorage(cached.compressed);
        if (json) {
          _parsedRules = JSON.parse(json);
          return _parsedRules;
        }
      }
      _parsedRules = parseRuleText(text);
      // Compressed, not the bare object (2026-08-25 live measurement: a real
      // multi-source config's parsed object hit 14.84MB — OVER
      // chrome.storage.session's 10MB quota, so the uncompressed write
      // silently failed and this cache never populated at all, meaning every
      // cold start paid the full parseRuleText() cost — 654.6ms measured —
      // for zero benefit. Compressed (deflate-raw, same helper as
      // siteRulesCacheText) that same object measured 5.40MB — fits — and
      // read-back (decompress + JSON.parse) measured 116.4ms, an 82%
      // reduction vs reparsing from scratch. The extra stringify+compress
      // cost on write (~378ms measured) doesn't matter: it happens once per
      // rules change, not on the cold-start hot path this cache exists for.
      const compressed = await _compressForStorage(JSON.stringify(_parsedRules));
      await SessionStorage.set({ [PARSED_RULES_SESSION_KEY]: { hash: textHash, compressed } });
      return _parsedRules;
    })().finally(() => { _parsedRulesPromise = null; });
  }
  return _parsedRulesPromise;
}

// Resolve hostname against the dynamic [host_patterns] section.
// "vnexpress.net" also matches *.vnexpress.net; "amazon.*" matches any TLD.
// _hostPatternMatches — one [host_patterns] left-hand side vs a hostname.
// Supported forms:
//   vnexpress.net                  — host + subdomains
//   amazon.*                       — wildcard TLD (amazon.com, amazon.co.uk, ...)
//   a.com | b.net | c.*            — several patterns sharing one key
//   /(^|\.)fmovies[a-z0-9-]*\./    — raw regex tested against the hostname;
//                                    '|' inside is regex alternation. Do not
//                                    use '=' inside (the line parser splits on
//                                    the first '='). Keys are lowercased.
//
// _compileHostPattern() result is cached (below) keyed by the raw pattern
// string — this used to recompile every `new RegExp(...)` on EVERY call,
// for EVERY pattern, on EVERY hostname resolution. With only a handful of
// curated [host_patterns] entries that was unnoticeable; with a large
// converted ABP source enabled (e.g. EasyList's ~24k cosmetic rules, each
// potentially becoming its own [host_patterns] entry) resolveSiteKey()'s
// per-navigation loop could be recompiling tens of thousands of regexes on
// every single GET_SITE_CONFIG call — live-reported (2026-08-23) as
// content scripts seemingly not running at all once EasyList was enabled,
// consistent with the service worker becoming slow/unresponsive enough to
// look dead. A pattern string's compiled matcher never needs invalidating
// (it's a pure function of the string), so this cache is never cleared —
// stale entries for patterns no longer in use are just a few unused Map
// keys, not a correctness issue.
const _hostPatternMatchCache = new Map(); // pattern string -> (host)=>bool, or null if invalid
function _compileHostPattern(pat) {
  // Raw regex form: /body/flags — the whole LHS, never split on '|'
  if (pat.charAt(0) === '/') {
    const last = pat.lastIndexOf('/');
    if (last > 0) {
      try {
        const re = new RegExp(pat.slice(1, last), pat.slice(last + 1));
        return host => re.test(host);
      } catch { /* bad regex */ }
    }
    return null;
  }
  const subRegexes = [];
  for (let sub of pat.split('|')) {
    sub = sub.trim();
    if (!sub) continue;
    try {
      let re;
      if (sub.slice(-2) === '.*') {
        const base = sub.slice(0, -2).replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        re = new RegExp('(^|\\.)' + base + '\\.');
      } else {
        const escaped = sub.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        re = new RegExp('(^|\\.)' + escaped + '$');
      }
      subRegexes.push(re);
    } catch { /* bad sub-pattern — skip */ }
  }
  return subRegexes.length ? host => subRegexes.some(re => re.test(host)) : null;
}
function _hostPatternMatches(pat, host) {
  pat = pat.trim();
  let matcher = _hostPatternMatchCache.get(pat);
  if (matcher === undefined) {
    matcher = _compileHostPattern(pat);
    _hostPatternMatchCache.set(pat, matcher);
  }
  return matcher ? matcher(host) : false;
}

// resolveSiteKey() used to do a linear scan through EVERY [host_patterns]
// entry, testing each against the host — fine for a handful of curated
// entries, but a large ABP-converted source (EasyList's ~24k cosmetic rules
// can expand into thousands of host_patterns entries) turns this into
// thousands of pattern tests on EVERY SINGLE frame navigation (every
// iframe on a page gets its own GET_SITE_CONFIG call) — live-reported
// (2026-08-23) as the page/service worker becoming unresponsive with
// EasyList enabled, even after caching the compiled regexes (that made
// each individual test cheaper, but there were still thousands of them per
// resolution). Indexed instead: the vast majority of patterns are plain
// single-domain entries (no wildcard, no regex) — those go into an
// exact-match Map, checked via a short walk up the HOST's own
// domain-suffix chain (e.g. "a.b.vnexpress.net" -> "b.vnexpress.net" ->
// "vnexpress.net", a handful of Map lookups) instead of testing every
// pattern against the host. This exactly reproduces the old regex
// '(^|\.)domain$' semantics (matches the domain itself or any subdomain).
// Wildcard-TLD ("domain.*") and raw-regex ("/.../") patterns are rare and
// stay in a small fallback list, still tested directly — but skipped once
// something earlier in insertion order has already matched, since it can't
// possibly win. The index is cached per `patterns` OBJECT via a WeakMap —
// a fresh parsed-rules object after every rule reload naturally
// invalidates it, nothing to clear manually.
const _hostPatternIndexCache = new WeakMap();
function _buildHostPatternIndex(patterns) {
  const exactMap = new Map(); // domain -> { key, order, specific }
  const complex = []; // { pat, key, order } — wildcard-TLD / regex forms
  let order = 0;
  for (const pat in patterns) {
    if (!Object.prototype.hasOwnProperty.call(patterns, pat)) continue;
    const key = (patterns[pat] && patterns[pat][0]) || '';
    if (!key) continue;
    const idx = order++;
    // Raw regex form (/body/flags) is the WHOLE LHS and must never be split
    // on '|' — its body can (and often does, e.g. "(^|\.)") contain a
    // literal '|' as regex alternation, not a domain separator. Splitting
    // it first (as an earlier version of this function did) shredded the
    // pattern into garbage fragments and silently dropped it from the
    // index entirely — caught by a direct regression test (2026-08-23).
    if (pat.charAt(0) === '/' && pat.length > 1 && pat.lastIndexOf('/') > 0) {
      complex.push({ pat, key, order: idx });
      continue;
    }
    const subTokens = pat.split('|').map(s => s.trim()).filter(Boolean);
    // A '|'-joined LHS with MANY domains is a generic ABP "bucket" pattern
    // — real filter lists (EasyList in particular) routinely hide a common
    // selector (e.g. a generic ".banner") across a couple hundred loosely
    // related sites on one line, purely to save space. A single-domain LHS
    // is a dedicated, curated entry for exactly that one site. Live bug
    // (2026-08-23): EasyList's bucket line happened to include the same
    // domain a later-enabled, more specific source (Vietnam — ABPVN List)
    // had its OWN dedicated entry for — since parseRuleText() treats the
    // whole joined string as one opaque object key, the two never merge at
    // the text level, and "first insertion order wins" let EasyList's
    // generic bucket permanently shadow ABPVN's specific rules for that
    // domain, even though ABPVN loaded and converted correctly. A
    // dedicated single-domain entry must always outrank a bucket entry for
    // the same domain, regardless of which source was enabled/processed
    // first — that's the whole point of a source being domain-specific.
    const isBucket = subTokens.length > 1;
    for (const tok of subTokens) {
      if (tok.slice(-2) === '.*') {
        complex.push({ pat: tok, key, order: idx });
      } else {
        const d = tok.toLowerCase();
        const candidate = { key, order: idx, specific: !isBucket };
        const existing = exactMap.get(d);
        if (!existing
          || (candidate.specific && !existing.specific)
          || (candidate.specific === existing.specific && candidate.order < existing.order)) {
          exactMap.set(d, candidate);
        }
      }
    }
  }
  return { exactMap, complex };
}

function resolveSiteKey(patterns, host) {
  let index = _hostPatternIndexCache.get(patterns);
  if (!index) {
    index = _buildHostPatternIndex(patterns);
    _hostPatternIndexCache.set(patterns, index);
  }
  let best = null; // { key, order }
  let h = host;
  while (h) {
    const hit = index.exactMap.get(h);
    if (hit && (!best || hit.order < best.order)) best = hit;
    const dot = h.indexOf('.');
    if (dot === -1) break;
    h = h.slice(dot + 1);
  }
  for (const c of index.complex) {
    if (best && c.order >= best.order) continue; // can't possibly win — skip the test
    if (_hostPatternMatches(c.pat, host)) {
      if (!best || c.order < best.order) best = { key: c.key, order: c.order };
    }
  }
  return best ? best.key : '';
}

// A domain that ends up in BOTH malwareNetworkDomains and adNetworkPatterns/
// trackerNetworkPatterns (curated sources — default + EasyList + region
// lists — can genuinely overlap; nothing currently dedupes across them at
// merge time) would otherwise produce two main_frame redirect rules at the
// SAME DNR priority (2) with DIFFERENT targets (blocked.html?h= for
// malware vs blocked.html?t=ad&h= for an ad popup). Chrome's tie-break
// between same-priority, same-action-type ('redirect') rules is
// unspecified/undocumented — which warning actually shows would be
// unpredictable. Malware always wins here: it's the more severe warning,
// and a user should never see "just an ad" for a domain actually flagged
// as malware/phishing by resolving the conflict ourselves before it ever
// reaches Chrome's own (unspecified) tie-break.
function _dedupeMalwarePriority(config) {
  const malwareSet = new Set(config.malwareNetworkDomains.map(d => d.toLowerCase()));
  return {
    ...config,
    adNetworkPatterns: config.adNetworkPatterns.filter(d => !malwareSet.has(d.toLowerCase())),
    trackerNetworkPatterns: config.trackerNetworkPatterns.filter(d => !malwareSet.has(d.toLowerCase())),
  };
}

// Rehydrates ensureRuleDefinitionsLoaded()'s module-level output from
// BUILT_RULES_SESSION_KEY. Returns true on a real cache hit (module vars are
// now populated, caller should return without doing a real build); false on
// any miss/corruption/unavailable-storage (caller falls through to the real
// build path — never blocks or breaks anything, same philosophy
// PARSED_RULES_SESSION_KEY already established).
async function _loadBuiltRulesFromCache(cacheKey) {
  try {
    // SessionStorage.get() itself never rejects (resolves {} on failure,
    // already logged there) — this try/catch is for JSON.parse/decompress/
    // rehydrate below throwing on a genuinely corrupt cache entry.
    const { [BUILT_RULES_SESSION_KEY]: cached } = await SessionStorage.get(BUILT_RULES_SESSION_KEY);
    if (!(cached && cached.key === cacheKey && cached.compressed)) return false;
    const json = await _decompressFromStorage(cached.compressed);
    if (!json) return false;
    const data = JSON.parse(json);
    DEFAULT_RULES = data.DEFAULT_RULES;
    MALWARE_RULES = data.MALWARE_RULES;
    AD_MAINFRAME_RULES = data.AD_MAINFRAME_RULES;
    QUERY_STRIP_RULES = data.QUERY_STRIP_RULES;
    NETWORK_REDIRECT_RULES = data.NETWORK_REDIRECT_RULES;
    NETWORK_BLOCK_RULES = data.NETWORK_BLOCK_RULES;
    NETWORK_BLOCK_MATCHER = _rehydrateMatcherMap(data.NETWORK_BLOCK_MATCHER);
    TRACKER_RULE_IDS = new Set(data.TRACKER_RULE_IDS);
    MALWARE_RULE_IDS = new Set(data.MALWARE_RULE_IDS);
    AD_KEYWORDS.splice(0, AD_KEYWORDS.length, ...data.AD_KEYWORDS);
    TRACKER_KEYWORDS.splice(0, TRACKER_KEYWORDS.length, ...data.TRACKER_KEYWORDS);
    MALWARE_KEYWORDS.splice(0, MALWARE_KEYWORDS.length, ...data.MALWARE_KEYWORDS);
    _ruleGeneration++;
    return true;
  } catch (e) { console.warn('[AdBlock] storage.session read (built-rules cache) failed — falling through to a real build:', e); return false; }
}

async function _saveBuiltRulesToCache(cacheKey) {
  try {
    const data = {
      DEFAULT_RULES, MALWARE_RULES, AD_MAINFRAME_RULES, QUERY_STRIP_RULES,
      NETWORK_REDIRECT_RULES, NETWORK_BLOCK_RULES,
      NETWORK_BLOCK_MATCHER: _serializeMatcherMap(NETWORK_BLOCK_MATCHER),
      TRACKER_RULE_IDS: [...TRACKER_RULE_IDS], MALWARE_RULE_IDS: [...MALWARE_RULE_IDS],
      AD_KEYWORDS: [...AD_KEYWORDS], TRACKER_KEYWORDS: [...TRACKER_KEYWORDS], MALWARE_KEYWORDS: [...MALWARE_KEYWORDS],
    };
    const compressed = await _compressForStorage(JSON.stringify(data));
    await SessionStorage.set({ [BUILT_RULES_SESSION_KEY]: { key: cacheKey, compressed } });
  } catch (e) { console.warn('[AdBlock] storage.session write (built-rules cache) failed — next restart will just rebuild again:', e); }
}

async function ensureRuleDefinitionsLoaded() {
  if (DEFAULT_RULES.length && MALWARE_RULES.length && AD_MAINFRAME_RULES.length) return;
  if (!_ruleConfigPromise) {
    _ruleConfigPromise = (async () => {
      // Cheap (raw-text-sized, not the full parsed-object-sized
      // PARSED_RULES_SESSION_KEY cache) — compute this BEFORE calling
      // getParsedRules() so a built-rules cache hit skips that heavier read
      // entirely, not just the build step. `_hasWebRequestBlocking()` is
      // folded into the key so a Chrome-shaped (DNR rules) cache entry can
      // never be misread as a Firefox-shaped (webRequest matcher) one or
      // vice versa — constant per install in practice, just defensive.
      const text = await getRulesText();
      const cacheKey = _hashText(text) + '|' + (_hasWebRequestBlocking() ? 'wr' : 'dnr');
      if (await _loadBuiltRulesFromCache(cacheKey)) return;

      const parsed = await getParsedRules();
      const global = parsed.global || {};
      const config = _dedupeMalwarePriority({
        adNetworkPatterns: global.ad_network_patterns?.length ? global.ad_network_patterns : FALLBACK_RULE_CONFIG.adNetworkPatterns,
        trackerNetworkPatterns: global.tracker_network_patterns?.length ? global.tracker_network_patterns : FALLBACK_RULE_CONFIG.trackerNetworkPatterns,
        malwareNetworkDomains: global.malware_network_domains?.length ? global.malware_network_domains : FALLBACK_RULE_CONFIG.malwareNetworkDomains,
        adPatterns: global.ad_patterns?.length ? global.ad_patterns : FALLBACK_RULE_CONFIG.adPatterns,
        trackerPatterns: global.tracker_patterns?.length ? global.tracker_patterns : FALLBACK_RULE_CONFIG.trackerPatterns,
        malwarePatterns: global.malware_patterns?.length ? global.malware_patterns : FALLBACK_RULE_CONFIG.malwarePatterns,
      });
      const { adRules, trackerRules } = buildDefaultRulesFromConfig(config);
      DEFAULT_RULES = [...adRules, ...trackerRules];
      MALWARE_RULES = buildMalwareRulesFromConfig(config, DEFAULT_RULES.length +1);
      AD_MAINFRAME_RULES = buildAdMainFrameRulesFromConfig(config, DEFAULT_RULES.length + MALWARE_RULES.length + 1);
      QUERY_STRIP_RULES = buildQueryStripRules(global.strip_query_params || [], QUERY_STRIP_RULE_ID_START);
      NETWORK_REDIRECT_RULES = buildNetworkRedirectRules(global.network_redirect_rules || [], NETWORK_REDIRECT_RULE_ID_START);
      // network_block_rules: DNR rule objects for Chrome/Edge (and Firefox
      // when webRequestBlocking isn't available), OR a webRequest matcher
      // Map for Firefox when it is — never both, see _hasWebRequestBlocking()
      // and buildActiveRulesFromStorage()'s own gating of networkBlockActive.
      if (_hasWebRequestBlocking()) {
        NETWORK_BLOCK_RULES = [];
        NETWORK_BLOCK_MATCHER = buildNetworkBlockMatcher(parsed);
      } else {
        NETWORK_BLOCK_RULES = buildDomainNetworkBlockRules(parsed, NETWORK_BLOCK_RULE_ID_START);
        NETWORK_BLOCK_MATCHER = new Map();
      }
      TRACKER_RULE_IDS = new Set(trackerRules.map(rule => rule.id));
      MALWARE_RULE_IDS = new Set(MALWARE_RULES.map(rule => rule.id));
      AD_KEYWORDS.splice(0, AD_KEYWORDS.length, ...config.adPatterns);
      TRACKER_KEYWORDS.splice(0, TRACKER_KEYWORDS.length, ...config.trackerPatterns);
      MALWARE_KEYWORDS.splice(0, MALWARE_KEYWORDS.length, ...config.malwarePatterns);
      _ruleGeneration++; // invalidates _ruleFingerprint() — static rule defs just changed
      await _saveBuiltRulesToCache(cacheKey);
    })().finally(() => {
      _ruleConfigPromise = null;
    });
  }
  await _ruleConfigPromise;
}

const FOCUS_RULE_ID_START   = 2000;
const QUERY_STRIP_RULE_ID_START = 3000;
const NETWORK_REDIRECT_RULE_ID_START = 500000; // for network_redirect_rules
const NETWORK_BLOCK_RULE_ID_START = 700000;  // for network_block_rules (well clear of NETWORK_REDIRECT_RULE_ID_START's own sequential counter)
const REMOTE_MALWARE_RULE_ID_START = 100000; // for fetched blocklists
const REMOTE_MALWARE_PATH_RULE_ID_START = 900000; // for path-scoped fetched-blocklist entries (one urlFilter rule each, see REMOTE_MAX_PATH_PATTERNS)
const CUSTOM_RULE_ID_START = 200000;         // for user-created rules
const PAUSE_ALLOW_RULE_ID_START = 300000;    // for pause/allowlist allow-all rules

// ── Stable content-addressed rule IDs (Phase 3a prerequisite) ────────────
// pauseAllowRules/customBlockRules/focusRules used to assign ids
// POSITIONALLY (START + array index) over pausedDomains/allowedDomains/
// rules/distractionDomains — lists whose ORDER can change (an item removed
// from the middle shifts every later id) even when their CONTENT mostly
// didn't. That made a real id-level diff (below) meaningless: removing one
// paused domain would look like "every subsequent paused domain's rule
// changed". _stableIdFor() derives an id purely from the item's own content
// (djb2 hash of a caller-provided key, folded into a fixed-size slot range
// reserved between this category's *_ID_START and the next category's
// start), so the SAME domain/rule always gets the SAME id regardless of
// what else is in the list or what order it's in. `claimed` is a plain Set
// scoped to ONE _assignStableIds() call — collisions (two different keys
// hashing to the same slot) are resolved via linear probing within that
// call, so ids are always unique in a single addRules batch; the (rare)
// case where a collision's resolution order shifts between calls just means
// a slightly less optimal diff for the colliding items, never a dropped or
// duplicated rule.
function _stableIdSlot(key, rangeSize, claimed) {
  let slot = parseInt(_hashText(key), 36) % rangeSize;
  while (claimed.has(slot)) slot = (slot + 1) % rangeSize;
  claimed.add(slot);
  return slot;
}
function _assignStableIds(items, keyFn, idStart, rangeSize) {
  const claimed = new Set();
  return items.map(item => ({ item, id: idStart + _stableIdSlot(keyFn(item), rangeSize, claimed) }));
}
const FOCUS_ID_RANGE       = 900;    // FOCUS_RULE_ID_START..+900, buffer before QUERY_STRIP at 3000
const CUSTOM_ID_RANGE       = 90000; // CUSTOM_RULE_ID_START..+90000, buffer before PAUSE_ALLOW at 300000
const PAUSE_ALLOW_ID_RANGE  = 190000; // PAUSE_ALLOW_RULE_ID_START..+190000, buffer before NETWORK_REDIRECT at 500000

// Per-rule content-hash cache (Phase 3a), keyed by object REFERENCE so a
// rule object reused across calls (e.g. from Phase 2c's sub-build memos, or
// DEFAULT_RULES/MALWARE_RULES/etc. which only get rebuilt on a generation
// bump) never gets re-JSON.stringify-ed after the first time it's seen —
// only genuinely new/changed rule objects pay that cost.
const _ruleContentHashCache = new WeakMap();
function _hashRule(rule) {
  let h = _ruleContentHashCache.get(rule);
  if (h === undefined) {
    h = _hashText(JSON.stringify(rule));
    _ruleContentHashCache.set(rule, h);
  }
  return h;
}

// Remote blocklist domains are grouped into a few requestDomains rules instead
// of one rule per domain (REMOTE_DOMAINS_PER_RULE), so Chrome's dynamic-rule
// COUNT quota is not the real constraint even at real full-feed scale
// (URLhaus + Phishing Army combined ~155k domains today = ~310 rules, far
// under Chrome's dynamic+session rule limit). The cap below exists only to
// bound storage/memory against a misbehaving or unexpectedly huge feed, not
// because of the rule quota — raised from 25,000 (which used to truncate
// Phishing Army's alphabetically-sorted list partway through, silently and
// permanently dropping every domain past early "a") to comfortably cover the
// real current combined feed size with headroom for growth. Domains are
// stored compressed (_compressDomainsForStorage/_decompressDomainsFromStorage)
// specifically so this higher cap doesn't reintroduce the chrome.storage.local
// quota pressure that motivated compressing siteRulesCacheText.
const REMOTE_MAX_DOMAINS = 200000;
const REMOTE_DOMAINS_PER_RULE = 1000;
// Path-scoped malware entries (e.g. URLhaus's own mirror ships full ABP
// `||domain/path^$all` lines alongside its bare-hostname ones, for
// shared/multi-tenant hosts like bitbucket.org/drive.google.com where
// blocking the whole domain the way bare hostnames do would take down
// unrelated legitimate content — see _updateRemoteMalwareDomains) each need
// their OWN dynamic rule — DNR's condition.urlFilter is singular, unlike
// requestDomains which batches REMOTE_DOMAINS_PER_RULE bare domains into one
// rule — so this cap bounds real Chrome dynamic-rule-COUNT growth (not just
// storage) unlike REMOTE_MAX_DOMAINS above. ~8,400 in URLhaus's real feed;
// 10,000 leaves comfortable headroom while keeping the combined worst case
// (this + NETWORK_RULE_BUDGET + the cheap/batched rest of the rule set)
// safely under Chrome's ~30,000 dynamic+session rule limit.
const REMOTE_MAX_PATH_PATTERNS = 10000;

function buildRemoteMalwareRules(domains, pathPatterns) {
  const rules = [];
  for (let i = 0; i < domains.length; i += REMOTE_DOMAINS_PER_RULE) {
    const chunk = domains.slice(i, i + REMOTE_DOMAINS_PER_RULE);
    rules.push({
      id: REMOTE_MALWARE_RULE_ID_START + rules.length,
      priority: 2,
      action: { type: 'block' },
      condition: {
        requestDomains: chunk,
        // Exclude sub_frame to avoid blocking embedded video players (iframes)
        resourceTypes: ['script', 'xmlhttprequest', 'image'],
      },
    });
    rules.push({
      id: REMOTE_MALWARE_RULE_ID_START + rules.length,
      priority: 2,
      action: malwareMainFrameRedirect(),
      condition: {
        requestDomains: chunk,
        regexFilter: MALWARE_REDIRECT_REGEX,
        resourceTypes: ['main_frame'],
      },
    });
  }
  // Path-scoped entries (see REMOTE_MAX_PATH_PATTERNS's own comment) — one
  // urlFilter per rule (DNR's condition.urlFilter is singular, can't batch
  // these the way requestDomains chunks bare domains above) covering EVERY
  // resource type in a single plain block, not the dedicated main_frame-
  // redirect-to-warning-page treatment the bare-domain rules above get —
  // that page is meant for "this whole site is malicious," not one flagged
  // payload URL on an otherwise-legitimate shared host; a direct hit here
  // just gets Chrome's own generic net::ERR_BLOCKED_BY_CLIENT instead.
  if (pathPatterns) {
    let pathId = 0;
    for (const urlFilter of pathPatterns) {
      rules.push({
        id: REMOTE_MALWARE_PATH_RULE_ID_START + pathId++,
        priority: 2,
        action: { type: 'block' },
        condition: { urlFilter },
      });
    }
  }
  return rules;
}

// ── Privacy score calculation ─────────────────────────────────────
// Pure function — duplicated in popup.js and dashboard.js too.
// domainStats: { adsBlocked, trackersBlocked, totalSeen }
// settings:    { enabled, paused, referrerAnonymization }
function calculatePrivacyScore(domainStats = {}, settings = {}) {
  const total = domainStats.totalSeen || 0;
  const protectionActive = settings.enabled !== false && !settings.paused;

  // Component 1 — Ads blocked (0–100)
  // Heuristic: expect ~15% of requests to be ads on a typical page.
  // Score = (adsBlocked / expectedAds) * 100, capped at 100.
  let adsScore = protectionActive ? 50 : 0; // 50 = no data yet but protection on
  if (total > 0) {
    const expected = Math.max(total * 0.15, 1);
    adsScore = protectionActive
      ? Math.min(100, Math.round(((domainStats.adsBlocked || 0) / expected) * 100))
      : 0;
  }

  // Component 2 — Trackers blocked (0–100)
  // Heuristic: expect ~10% of requests to be trackers.
  let trackersScore = protectionActive ? 50 : 0;
  if (total > 0) {
    const expected = Math.max(total * 0.10, 1);
    trackersScore = protectionActive
      ? Math.min(100, Math.round(((domainStats.trackersBlocked || 0) / expected) * 100))
      : 0;
  }

  // Component 3 — Referrer anonymization (setting-based)
  const referrerScore = settings.referrerAnonymization !== false ? 85 : 20;

  // Component 4 — Malware blocked (0–100)
  // Any malware blocked = excellent; having protection active = good baseline
  let malwareScore = protectionActive ? 70 : 0;
  if ((domainStats.malwareBlocked || 0) > 0) malwareScore = 100;

  // Weighted average: ads 30%, trackers 25%, malware 20%, referrer 25%
  const score = Math.round(
    adsScore       * 0.30 +
    trackersScore  * 0.25 +
    malwareScore   * 0.20 +
    referrerScore  * 0.25
  );

  return {
    score: Math.max(0, Math.min(100, score)),
    components: {
      ads:         Math.min(100, Math.round(adsScore)),
      trackers:    Math.min(100, Math.round(trackersScore)),
      malware:     Math.min(100, Math.round(malwareScore)),
      referrer:    referrerScore,
    },
  };
}

// ── Install / startup ─────────────────────────────────────────────
EXT.runtime.onInstalled.addListener(async () => {
  // Run on every onInstalled reason (install, update, chrome_update, ...),
  // not just 'install' — see _autoEnableLangDefaultSources()'s own comment
  // for why that gating meant this could never fire for an existing
  // install. Runs before the first applyNetworkRules() call below so a
  // newly-auto-enabled source is picked up immediately, not after the next
  // cache TTL.
  await _autoEnableLangDefaultSources();
  // Seed default settings
  const existing = await LocalStorage.get([
    'enabled', 'pausedDomains', 'allowedDomains', 'focusMode', 'stats', 'rules',
    'referrerAnonymization', 'collectStats',
    'blockAds', 'blockTrackers', 'cosmeticFiltering', 'blockMalware',
    'installDate', 'totalBlockedAllTime', 'reviewPromptState',
  ]);
  await LocalStorage.set({
    enabled:                existing.enabled                ?? true,
    pausedDomains:          existing.pausedDomains          ?? [],
    allowedDomains:         existing.allowedDomains         ?? [],
    focusMode:              existing.focusMode              ?? false,
    stats:                  existing.stats                  ?? {},
    rules:                  existing.rules                  ?? [],
    referrerAnonymization:  existing.referrerAnonymization  ?? true,
    collectStats:           existing.collectStats           ?? true,
    blockAds:               existing.blockAds               ?? true,
    blockTrackers:          existing.blockTrackers           ?? true,
    cosmeticFiltering:      existing.cosmeticFiltering      ?? true,
    blockMalware:           existing.blockMalware           ?? true,
    // Review-prompt gating (see popup.js maybeShowReviewPrompt): a real
    // install timestamp + an all-time counter that (unlike dailyStats,
    // which prunes past 30 days) never gets pruned.
    installDate:            existing.installDate            ?? Date.now(),
    totalBlockedAllTime:    existing.totalBlockedAllTime    ?? 0,
    reviewPromptState:      existing.reviewPromptState      ?? 'unseen', // 'unseen' | 'dismissed' | 'reviewed'
  });

  await applyNetworkRules();
  await applyPrivacySettings();
  await maybeCheckForExtensionUpdate();
});

EXT.runtime.onStartup.addListener(() => {
  applyNetworkRules();
  applyPrivacySettings();
  maybeCheckForExtensionUpdate();
  // Cheap ETag check (304 when unchanged) — picks up urgent rules fixes
  // published while the browser was closed, instead of waiting out the TTL.
  revalidateRemoteRules();
});

let activeStatsRules = [];
let statsRulesInitialized = false;
let _lastFingerprint = null; // last _ruleFingerprint() this SW lifetime actually applied (Phase 2b skip check)
let _lastRuleHashById = null; // Map<id,hash> from the last successful updateDynamicRules() this SW lifetime (Phase 3a diff)

// Phase 2c: in-memory-only memoization for the two remaining sub-builds
// inside buildActiveRulesFromStorage() that don't have their own dedicated
// function-level memo (buildRemoteMalwareRules() is a plain sync mapper,
// and pauseAllowRules is built inline) — same pattern as
// _customBlockRulesMemo/_focusRulesMemo above, keyed off the same
// _ruleInputHashes/_sessionAllowedDomainsHash Phase 1a already maintains.
let _remoteMalwareRulesMemo = { key: undefined, rules: null };
let _pauseAllowRulesMemo = { key: undefined, rules: null };

async function buildActiveRulesFromStorage() {
  await ensureRuleDefinitionsLoaded();
  const {
    enabled, pausedDomains = [], allowedDomains = [], focusMode = false,
    blockAds = true, blockTrackers = true, blockMalware = true,
  } = await LocalStorage.get(
    ['enabled', 'pausedDomains', 'allowedDomains', 'focusMode', 'blockAds', 'blockTrackers', 'blockMalware']
  );

  if (!enabled) {
    _updateNetworkBlockListener(false);
    return { enabled: false, allRules: [] };
  }
  // Same gates networkBlockActive/remoteActive's path-pattern half (DNR
  // path) use for these two tiers below — kept in sync here since the
  // webRequestBlocking listener is a replacement for both, not an addition
  // (see _hasWebRequestBlocking()'s own comment).
  _updateNetworkBlockListener(blockAds || blockMalware);

  const AD_RULE_IDS = new Set(DEFAULT_RULES.filter(r => !TRACKER_RULE_IDS.has(r.id)).map(r => r.id));
  const filteredDefaultRules = DEFAULT_RULES.filter(r => {
    if (AD_RULE_IDS.has(r.id) && !blockAds) return false;
    if (TRACKER_RULE_IDS.has(r.id) && !blockTrackers) return false;
    return true;
  });

  const activeRules = [...filteredDefaultRules];
  const adMainFrameActive = blockAds ? [...AD_MAINFRAME_RULES] : [];
  const malwareActive = blockMalware ? [...MALWARE_RULES] : [];
  const { remoteMalwareDomains, remoteMalwarePathPatterns, remoteMalwareRules = [] } = await LocalStorage.get(
    ['remoteMalwareDomains', 'remoteMalwarePathPatterns', 'remoteMalwareRules']
  );
  // Migration: older versions stored full rule objects (one per domain).
  // Flatten them back to a domain list until the next blocklist refresh
  // rewrites storage in the new format.
  const remoteDomains = remoteMalwareDomains
    ? await _decompressDomainsFromStorage(remoteMalwareDomains)
    : remoteMalwareRules.flatMap(r => r.condition?.requestDomains || []);
  const remotePathPatterns = await _decompressDomainsFromStorage(remoteMalwarePathPatterns);
  let remoteActive = [];
  if (blockMalware) {
    const remoteKey = _ruleInputHashes.remoteMalwareDomains + '|' + _ruleInputHashes.remoteMalwarePathPatterns + '|' + _ruleInputHashes.remoteMalwareRules;
    if (_remoteMalwareRulesMemo.rules && _remoteMalwareRulesMemo.key === remoteKey) {
      remoteActive = _remoteMalwareRulesMemo.rules;
    } else {
      // On Firefox (webRequestBlocking), the path-scoped half routes through
      // MALWARE_PATH_MATCHER instead (see its own comment for why — up to
      // 10,000 individual DNR rules on its own easily exceeds Firefox's flat
      // 5000 cap). Pass an empty array here so buildRemoteMalwareRules()
      // still builds the small, batched bare-domain DNR rules but skips the
      // path ones entirely on this browser.
      remoteActive = buildRemoteMalwareRules(remoteDomains, _hasWebRequestBlocking() ? [] : remotePathPatterns);
      _remoteMalwareRulesMemo = { key: remoteKey, rules: remoteActive };
      MALWARE_PATH_MATCHER = _hasWebRequestBlocking() ? buildMalwarePathMatcher(remotePathPatterns) : new Map();
    }
  } else {
    MALWARE_PATH_MATCHER = new Map();
  }
  const customBlockRules = await buildCustomBlockRules();
  const focusRules = await buildFocusRules(focusMode);
  const queryStripActive = blockTrackers ? QUERY_STRIP_RULES : [];
  const networkRedirectActive = blockAds ? NETWORK_REDIRECT_RULES : [];
  const networkBlockActive = blockAds ? NETWORK_BLOCK_RULES : [];

  // Build allowAllRequests rules for paused + allowlisted domains.
  // These have higher priority and override ALL blocking rules for
  // requests originating from these domains. This is the only
  // reliable way to fully pause blocking per-domain.
  //
  // sessionAllowedDomains (chrome.storage.session — cleared on browser
  // restart, survives a service-worker restart within the same session) is
  // the "Proceed" button on blocked/blocked.html WITHOUT the "Don't warn me
  // again" checkbox: a one-session bypass for that specific blocked host so
  // the very next navigation there doesn't immediately get redirected right
  // back to the warning page, without permanently allowlisting it the way
  // checking that box does (that goes into `allowedDomains` instead, via
  // the PROCEED_BLOCKED_HOST message handler below).
  const { sessionAllowedDomains = [] } = await SessionStorage.get('sessionAllowedDomains');
  const pauseAllowKey = _ruleInputHashes.pausedDomains + '|' + _ruleInputHashes.allowedDomains + '|' + _sessionAllowedDomainsHash;
  let pauseAllowRules;
  if (_pauseAllowRulesMemo.rules && _pauseAllowRulesMemo.key === pauseAllowKey) {
    pauseAllowRules = _pauseAllowRulesMemo.rules;
  } else {
    const excludedDomains = [...new Set([...pausedDomains, ...allowedDomains, ...sessionAllowedDomains])];
    // Stable id (Phase 3a) keyed on the domain itself, not array position.
    const withIds = _assignStableIds(excludedDomains, domain => domain, PAUSE_ALLOW_RULE_ID_START, PAUSE_ALLOW_ID_RANGE);
    pauseAllowRules = withIds.map(({ item: domain, id }) => ({
      id,
      priority: 10, // higher than all block rules (priority 1-2)
      action: { type: 'allowAllRequests' },
      condition: {
        requestDomains: [domain],
        resourceTypes: ['main_frame', 'sub_frame'],
      },
    }));
    _pauseAllowRulesMemo = { key: pauseAllowKey, rules: pauseAllowRules };
  }

  // Ordered highest-priority-to-keep FIRST, lowest-priority-to-sacrifice
  // LAST within each action-type pool — networkBlockActive (network_
  // block_rules, all 'block'/safe) is deliberately last among the safe
  // tiers, and queryStripActive/networkRedirectActive (both 'redirect'/
  // unsafe) are last among the unsafe ones: these are the tiers already
  // designed to degrade gracefully (see NETWORK_RULE_BUDGET's own comment),
  // so they're also what _trimToDynamicRuleLimits() eats into first if a
  // pool ever overflows what THIS browser actually allows (see its own
  // comment for the safe/unsafe split and Firefox's flat shared pool).
  // NETWORK_RULE_BUDGET already keeps this from triggering in the common
  // case; this is the guarantee for when that hand-tuned number goes stale
  // (list growth, a new default Rule Source added later, ...) instead of
  // gambling the whole updateDynamicRules() call on it staying accurate.
  const combinedRules = [
    ...activeRules, ...adMainFrameActive, ...malwareActive, ...remoteActive,
    ...customBlockRules, ...focusRules, ...pauseAllowRules, ...queryStripActive, ...networkRedirectActive,
    ...networkBlockActive,
  ];
  const allRules = _trimToDynamicRuleLimits(combinedRules);

  return { enabled: true, allRules };
}

// ── Apply declarativeNetRequest rules ────────────────────────────
// applyNetworkRules() has many independent call sites (onInstalled,
// onStartup, alarms, message handlers, reloadRules()) that are NOT
// sequenced against each other — e.g. onStartup fires applyNetworkRules()
// and revalidateRemoteRules() (which can itself call applyNetworkRules()
// again via reloadRules()) in the same tick, with no await between them. Each
// call does getDynamicRules() → updateDynamicRules({removeRuleIds,
// addRules}) as two separate round trips; if two calls overlap, the second
// one's getDynamicRules() snapshot can be taken BEFORE the first one's
// updateDynamicRules() commits, so its removeRuleIds doesn't include ids
// the first call just added — its addRules then tries to add those same
// (still-fixed, deterministic) ids again, and Chrome rejects with "Rule
// with id N does not have a unique ID." This chain serializes every call
// through a single queue so the getDynamicRules()/updateDynamicRules()
// pair for one invocation always fully completes before the next one's
// getDynamicRules() runs, eliminating the race regardless of caller.
let _applyNetworkRulesChain = Promise.resolve();
function applyNetworkRules() {
  _applyNetworkRulesChain = _applyNetworkRulesChain
    .catch(() => {})
    .then(() => _applyNetworkRulesImpl());
  return _applyNetworkRulesChain;
}

async function _applyNetworkRulesImpl() {
  const { enabled, allRules } = await buildActiveRulesFromStorage();

  // Remove all existing dynamic rules
  const existing = await EXT.declarativeNetRequest.getDynamicRules();
  const removeIds = existing.map(r => r.id);

  if (!enabled) {
    // Protection OFF — remove all rules
    if (removeIds.length) {
      await EXT.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds, addRules: [] });
    }
    await LocalStorage.remove(DNR_RULES_HASH_KEY);
    activeStatsRules = [];
    _lastFingerprint = null;
    _lastRuleHashById = null;
    statsRulesInitialized = true;
    updateIcon(false);
    return;
  }

  // applyNetworkRules() runs unconditionally on every SW cold start
  // (onStartup) even though the underlying rule text only actually
  // changes once per TTL/edit — updateDynamicRules() forces Chrome's own
  // DNR engine to re-index the whole rule set (large requestDomains
  // arrays included) from scratch, so it's the most expensive part of
  // this pipeline by far. Skip that ONE call (not the cheaper in-memory
  // rebuild above, which other code — stats classification, malware
  // count — needs populated regardless of DNR state) when the rule set
  // we're about to send is byte-identical to what we last successfully
  // sent. newHash is now an INPUT fingerprint (_ruleFingerprint(), see its
  // own comment above) rather than a hash of the generated `allRules`
  // array itself — buildActiveRulesFromStorage() is a pure function of
  // those inputs, so equal fingerprints guarantee equal output without
  // ever JSON.stringify-ing the (potentially thousands-of-domains-large)
  // allRules array just to detect "nothing changed". existing.length is an
  // extra, cheap guard against silent drift (rules cleared by something
  // other than this function since the hash was stored).
  const newHash = _ruleFingerprint();
  const { [DNR_RULES_HASH_KEY]: storedHash } = await LocalStorage.get(DNR_RULES_HASH_KEY);
  if (existing.length === allRules.length && storedHash === newHash) {
    // Same fingerprint as our own last successful run within this SW
    // lifetime (statsRulesInitialized true, _lastFingerprint matches) means
    // activeStatsRules is already correct in memory — skip re-filtering the
    // full allRules array. A cold-start call (statsRulesInitialized false)
    // still falls through and filters once, same as before.
    if (!(statsRulesInitialized && _lastFingerprint === newHash)) {
      activeStatsRules = allRules.filter(rule => rule.action?.type === 'block');
    }
    _lastFingerprint = newHash;
    statsRulesInitialized = true;
    updateIcon(true);
    return;
  }

  // Phase 3a: diff against what's actually different, instead of always
  // remove-ALL-existing + add-ALL-new — Chrome's DNR engine only has to
  // re-index the rules that actually changed, not the whole set, every time
  // e.g. one paused domain or one custom rule is toggled.
  const { removeRuleIds, addRules, nextHashById } = _computeRuleDiff(allRules, existing);
  if (removeRuleIds.length || addRules.length) {
    try {
      await EXT.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
    } catch (e) {
      // Chrome validates the WHOLE batch before committing any of it — one
      // malformed rule anywhere (e.g. a third-party ABP list contributing an
      // invalid urlFilter/requestDomains entry that slipped past
      // buildNetworkRedirectRules'/buildQueryStripRules' own validation, or
      // any other unforeseen edge case) used to throw here as an uncaught
      // promise rejection, live-reported 2026-08-24 ("Rule with id 500009
      // specifies an incorrect value for the urlFilter key"). Since the
      // update is atomic, the previously-applied rules are still intact —
      // log clearly instead of crashing, and deliberately do NOT update
      // _lastRuleHashById/DNR_RULES_HASH_KEY/_lastFingerprint below, so the
      // next applyNetworkRules() call retries the real diff against
      // Chrome's actual (unchanged) state instead of wrongly assuming this
      // update landed.
      console.error('[AdBlock] updateDynamicRules() rejected — rules NOT updated, previous rule set is still active:', e);
      updateIcon(true);
      return;
    }
  }
  _lastRuleHashById = nextHashById;
  await LocalStorage.set({ [DNR_RULES_HASH_KEY]: newHash });

  activeStatsRules = allRules.filter(rule => rule.action?.type === 'block');
  _lastFingerprint = newHash;
  statsRulesInitialized = true;
  updateIcon(true);
}

// Computes a precise add/remove diff for chrome.declarativeNetRequest.
// updateDynamicRules() instead of blindly replacing everything (Phase 3a).
// Fast path: if _lastRuleHashById is populated (a successful apply already
// happened this SW lifetime), diff purely from our own bookkeeping — no
// need to touch `existing` (the freshly chrome.declarativeNetRequest.
// getDynamicRules()-fetched objects) at all, since Chrome always returns
// NEW JS objects there (no reference-equality win possible on that side).
// Cold-start path (SW just started, no bookkeeping yet): must compare
// against `existing` directly — this pays a real per-rule hash cost once,
// same "cold start does one real pass" invariant as the rest of this file
// (ensureRuleDefinitionsLoaded, getParsedRules, etc.), then _lastRuleHashById
// carries forward for every subsequent call this lifetime.
function _computeRuleDiff(allRules, existing) {
  const newById = new Map();
  for (const rule of allRules) newById.set(rule.id, rule);
  const removeRuleIds = [];
  const addRules = [];

  if (_lastRuleHashById) {
    for (const id of _lastRuleHashById.keys()) {
      if (!newById.has(id)) removeRuleIds.push(id);
    }
    for (const [id, rule] of newById) {
      const oldHash = _lastRuleHashById.get(id);
      const newHash = _hashRule(rule); // WeakMap-cached — cheap on a reused object reference
      if (oldHash === undefined) {
        addRules.push(rule);
      } else if (oldHash !== newHash) {
        removeRuleIds.push(id);
        addRules.push(rule);
      }
    }
  } else {
    const existingById = new Map();
    for (const rule of existing) existingById.set(rule.id, rule);
    for (const id of existingById.keys()) {
      if (!newById.has(id)) removeRuleIds.push(id);
    }
    for (const [id, rule] of newById) {
      const oldRule = existingById.get(id);
      if (!oldRule) {
        addRules.push(rule);
      } else if (_hashRule(oldRule) !== _hashRule(rule)) {
        removeRuleIds.push(id);
        addRules.push(rule);
      }
    }
  }

  const nextHashById = new Map();
  for (const [id, rule] of newById) nextHashById.set(id, _hashRule(rule));
  return { removeRuleIds, addRules, nextHashById };
}

// ── User custom blocking rules ────────────────────────────────────
// Phase 2c perf fix: memoized in-memory (never persisted, so a real SW
// restart always recomputes once) keyed by _ruleInputHashes.rules — the
// same per-key hash Phase 1a already maintains via storage.onChanged, kept
// fresh at write-time rather than recomputed per call. A repeat call within
// the same SW lifetime with an unchanged `rules` storage key skips rebuilding
// this array (and the chrome.storage.local.get round-trip) entirely.
let _customBlockRulesMemo = { hash: undefined, rules: null };
async function buildCustomBlockRules() {
  const hash = _ruleInputHashes.rules;
  if (_customBlockRulesMemo.rules && _customBlockRulesMemo.hash === hash) return _customBlockRulesMemo.rules;
  const { rules = [] } = await LocalStorage.get('rules');
  const blockRules = rules.filter(r => r.active && r.action === 'block');
  // Stable id (Phase 3a) keyed on the rule's own type+pattern, not array
  // position — removing one custom rule no longer shifts every other
  // custom rule's DNR id.
  const withIds = _assignStableIds(blockRules, r => `${r.type}|${r.pattern}`, CUSTOM_RULE_ID_START, CUSTOM_ID_RANGE);
  const result = withIds.map(({ item: r, id: ruleId }) => {
    const condition = { resourceTypes: [
    'main_frame',
    'sub_frame',
    'stylesheet',
    'script',
    'image',
    'font',
    'object',
    'xmlhttprequest',
    'ping',
    'csp_report',
    'media',
    'websocket',
    'other',
  ] };

    if (r.type === 'domain') {
      condition.requestDomains = [r.pattern];
    } else if (r.type === 'keyword') {
      condition.urlFilter = r.pattern;
    } else if (r.type === 'regex') {
      condition.regexFilter = r.pattern;
    } else {
      // css type → hide only, handled by content script
      return null;
    }
    return { id: ruleId, priority: 1, action: { type: 'block' }, condition };
  }).filter(Boolean);
  _customBlockRulesMemo = { hash, rules: result };
  return result;
}

// ── Focus mode blocking rules ─────────────────────────────────────
const DISTRACTION_DEFAULTS = ['twitter.com', 'youtube.com', 'reddit.com', 'instagram.com', 'tiktok.com'];

// Phase 2c: same in-memory memoization approach as buildCustomBlockRules()
// above, keyed by (focusMode, _ruleInputHashes.distractionDomains).
let _focusRulesMemo = { key: undefined, rules: null };
async function buildFocusRules(focusMode) {
  if (!focusMode) return [];
  const key = focusMode + '|' + _ruleInputHashes.distractionDomains;
  if (_focusRulesMemo.rules && _focusRulesMemo.key === key) return _focusRulesMemo.rules;
  const { distractionDomains = DISTRACTION_DEFAULTS } = await LocalStorage.get('distractionDomains');
  // Stable id (Phase 3a) keyed on the domain itself, not array position.
  const withIds = _assignStableIds(distractionDomains, domain => domain, FOCUS_RULE_ID_START, FOCUS_ID_RANGE);
  const result = withIds.map(({ item: domain, id }) => ({
    id,
    priority: 2,
    action:   { type: 'block' },
    condition: {
      requestDomains: [domain],
      resourceTypes:  ['main_frame', 'sub_frame', 'script', 'image', 'xmlhttprequest'],
    },
  }));
  _focusRulesMemo = { key, rules: result };
  return result;
}

// ── Icon badge ────────────────────────────────────────────────────
// enabled=true shows the ACTIVE TAB's own blocked count (uBO-style —
// resets per navigation, see _tabBlockedCounts below), enabled=false shows
// "OFF". "OFF" is a global (no-tabId) badge value; per-tab counts are set
// via chrome.action.setBadgeText({..., tabId}), which Chrome overlays on
// top of the global value for that tab only.
async function updateIcon(enabled) {
  EXT.action.setIcon({
    // Absolute extension URLs, not bare relative paths — setIcon() resolves
    // a relative path against the CALLING SCRIPT's own URL, not the
    // extension root, so a bare 'icons/...' silently broke ("Failed to
    // fetch") once background.js moved into shared/ (would resolve to
    // shared/icons/... instead of the real root-level icons/).
    path: {
      16:  EXT.runtime.getURL(enabled ? 'icons/icon16.png'  : 'icons/icon16_off.png'),
      48:  EXT.runtime.getURL(enabled ? 'icons/icon48.png'  : 'icons/icon48_off.png'),
      128: EXT.runtime.getURL(enabled ? 'icons/icon128.png' : 'icons/icon128_off.png'),
    },
  });
  if (!enabled) {
    EXT.action.setBadgeText({ text: 'OFF' });
    EXT.action.setBadgeBackgroundColor({ color: '#f87171' });
    const [offTab] = await EXT.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    let offDomain = '';
    try { offDomain = offTab?.url ? new URL(offTab.url).hostname : ''; } catch {}
    updateContextMenuVisibility(offDomain, false);
    return;
  }
  // Clear the global "OFF" value so tabs with no per-tab override go blank
  // (not stuck showing "OFF") the moment protection is re-enabled.
  EXT.action.setBadgeText({ text: '' });
  EXT.action.setBadgeBackgroundColor({ color: '#6366f1' });
  const [activeTab] = await EXT.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (activeTab?.url) updateBadgeForTab(activeTab.id, activeTab.url);
}

// ── Stats tracking ────────────────────────────────────────────────
function initDomainStats() {
  return { blocked: 0, adsBlocked: 0, cosmeticHidden: 0, trackersBlocked: 0, malwareBlocked: 0, totalSeen: 0, bandwidth: 0, timeSaved: 0, speedGain: 0, https: false };
}

// Average bytes saved per blocked request (heuristic)
const AVG_AD_BYTES      = 50000;  // ~50 KB per ad script/image
const AVG_TRACKER_BYTES = 15000;  // ~15 KB per tracker request

// ── Daily stats accumulator ────────────────────────────────────────
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Serialized stats writer ─────────────────────────────────────
// All reads-then-writes on 'stats'/'dailyStats' go through this chain
// to prevent concurrent reads returning stale data and overwriting each other.
let _statsWriteChain = Promise.resolve();

function _enqueueStatWrite(fn) {
  _statsWriteChain = _statsWriteChain
    .then(fn)
    .catch(e => console.warn('[AdBlock] stat write error:', e));
}

async function _writeDomainStatDelta(domain, delta) {
  const { stats = {} } = await LocalStorage.get('stats');
  if (!stats[domain]) {
    stats[domain] = { blocked: 0, adsBlocked: 0, cosmeticHidden: 0, trackersBlocked: 0, malwareBlocked: 0, totalSeen: 0, bandwidth: 0, timeSaved: 0, speedGain: 0 };
  }
  const s = stats[domain];
  s.totalSeen       += delta.totalSeen       || 0;
  s.adsBlocked      += delta.adsBlocked      || 0;
  s.cosmeticHidden   = (s.cosmeticHidden || 0) + (delta.cosmeticHidden || 0);
  s.trackersBlocked += delta.trackersBlocked || 0;
  s.malwareBlocked  += delta.malwareBlocked  || 0;
  s.blocked = s.adsBlocked + s.trackersBlocked + s.malwareBlocked;
  recalcDerived(s);
  // Cap per-domain stats to 200 domains
  const domainKeys = Object.keys(stats).filter(k => k !== '_global');
  if (domainKeys.length > 200) {
    domainKeys.sort((a, b) => (stats[a].totalSeen || 0) - (stats[b].totalSeen || 0));
    for (const k of domainKeys.slice(0, domainKeys.length - 200)) delete stats[k];
  }
  await LocalStorage.set({ stats });
}

async function _writeDailyStatDelta(delta) {
  const key = todayKey();
  const { dailyStats = {}, totalBlockedAllTime = 0 } = await LocalStorage.get(['dailyStats', 'totalBlockedAllTime']);
  if (!dailyStats[key]) dailyStats[key] = { blocked: 0, ads: 0, trackers: 0, malware: 0 };
  dailyStats[key].blocked  += delta.blocked  || 0;
  dailyStats[key].ads      += delta.ads      || 0;
  dailyStats[key].trackers += delta.trackers || 0;
  dailyStats[key].malware  += delta.malware  || 0;
  const keys = Object.keys(dailyStats).sort();
  while (keys.length > 30) { delete dailyStats[keys.shift()]; }
  // Unlike dailyStats (pruned to 30 days), this never resets — it's the
  // review-prompt milestone counter (see popup.js maybeShowReviewPrompt).
  await LocalStorage.set({ dailyStats, totalBlockedAllTime: totalBlockedAllTime + (delta.blocked || 0) });
}

// ── Icon badge count — PER TAB, uBO-style ───────────────────────────
// Counts reset per navigation (see the tabs.onUpdated listener below) and
// are pure in-memory state — a service-worker restart just means every open
// tab's badge goes blank until its next block event, same as reloading the
// extension. Not persisted: this is a live "how much is happening on THIS
// page" indicator, not a stat (daily/domain totals still accumulate in
// chrome.storage via _writeDailyStatDelta/_writeDomainStatDelta above).
const _tabBlockedCounts = new Map(); // tabId -> count
function _formatBadgeCount(n) {
  if (!n) return '';
  if (n < 1000) return String(n);
  return Math.floor(n / 1000) + 'k'; // badge text is only a few px wide
}
// Setting badge text to '' for a specific tabId doesn't blank that tab — it
// clears the tab-specific override, so Chrome falls back to showing the
// global (no-tabId) value for it. Since the global value is only ever ''
// or 'OFF' (see updateIcon), a 0-count tab correctly reads as blank.
function _setTabBadge(tabId) {
  if (tabId === undefined || tabId < 0) return; // -1 = no real tab (e.g. background fetch)
  if (!_settingsCache.enabled) return; // updateIcon(false) owns the "OFF" badge
  const count = _tabBlockedCounts.get(tabId) || 0;
  EXT.action.setBadgeText({ text: _formatBadgeCount(count), tabId }).catch(() => {});
  EXT.action.setBadgeBackgroundColor({ color: '#6366f1', tabId }).catch(() => {});
}
function _incrementTabBlocked(tabId, n) {
  if (!n || tabId === undefined || tabId < 0) return;
  _tabBlockedCounts.set(tabId, (_tabBlockedCounts.get(tabId) || 0) + n);
  _setTabBadge(tabId);
}

function updateDailyStats(delta) {
  _enqueueStatWrite(() => _writeDailyStatDelta(delta));
}

function recalcDerived(s) {
  s.timeSaved  = Math.round(s.blocked * 0.3);
  // Bandwidth is only saved by blocked NETWORK requests — cosmetically hidden
  // elements were still downloaded, so exclude them from the estimate.
  const networkAds = Math.max(0, s.adsBlocked - (s.cosmeticHidden || 0));
  s.bandwidth  = (networkAds * AVG_AD_BYTES) + (s.trackersBlocked * AVG_TRACKER_BYTES);
  s.speedGain  = s.totalSeen > 0 ? Math.round((s.blocked / s.totalSeen) * 100) : 0;
}

const AD_KEYWORDS = FALLBACK_RULE_CONFIG.adPatterns.slice();

const TRACKER_KEYWORDS = FALLBACK_RULE_CONFIG.trackerPatterns.slice();

const MALWARE_KEYWORDS = FALLBACK_RULE_CONFIG.malwarePatterns.slice();

// ── Remote malware blocklist updater ──────────────────────────────
// Fetches config.js's format:'hosts' RULES_REMOTE_URL entries (URLhaus,
// Phishing Army) — called from fetchRemoteRuleText() itself, so these two
// sources share the exact same per-source enable/disable, error/stats
// reporting, 6h cache, and 30-min ETag-revalidation cadence as every other
// default Rule Source, instead of a bespoke 24h alarm. Output goes to
// remoteMalwareDomains/remoteMalwarePathPatterns (consumed by
// buildRemoteMalwareRules), never into the merged ad_network_patterns/
// network_block_rules text, so blockMalware/the malware warning page/the
// malwareBlocked stat category all stay independent of ad blocking.
async function _updateRemoteMalwareDomains(urls) {
  const domains = new Set();
  const pathPatterns = new Set();
  const sourceErrors = {};
  const sourceStats = {};
  await Promise.all(urls.map(async url => {
    const stats = _abpEmptySkipStats();
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) { sourceErrors[url] = `HTTP ${res.status}`; return; }
      const text = await res.text();
      for (const rawLine of text.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
        stats.total++;

        // Some malware-hosts feeds mix bare hostname lines with full ABP
        // `||domain/path^$opts` lines — URLhaus's own mirror does this for
        // shared/multi-tenant hosts (bitbucket.org, drive.google.com,
        // web.archive.org, ...) where blocking the WHOLE domain the way a
        // bare hostname line does would take down unrelated legitimate
        // content; only the exact malicious path is meant to be blocked.
        const netMatch = /^\|\|([^$]+?)(?:\$(.*))?$/.exec(trimmed);
        if (netMatch) {
          if (pathPatterns.size >= REMOTE_MAX_PATH_PATTERNS) { stats.unrecognized++; continue; }
          const urlFilter = '||' + netMatch[1];
          // Same conservative "only options that don't narrow what should
          // match" bar as _abpParseFile's own path-scoped conversion — a
          // modifier this code can't faithfully represent (a resourceType,
          // domain=, ...) means dropping the entry rather than guessing.
          if (!ABP_SIMPLE_NETWORK_OPTS_RE.test(netMatch[2] || '') || !_isValidUrlFilter(urlFilter)) {
            stats.unrecognized++;
            continue;
          }
          if (pathPatterns.has(urlFilter)) { stats.dedupSkipped++; continue; }
          pathPatterns.add(urlFilter);
          stats.converted++;
          continue;
        }

        if (domains.size >= REMOTE_MAX_DOMAINS) { stats.unrecognized++; continue; }
        // Hosts file format: "127.0.0.1 domain" or "0.0.0.0 domain" or just "domain"
        let domain = trimmed;
        if (domain.startsWith('127.0.0.1') || domain.startsWith('0.0.0.0')) {
          domain = domain.split(/\s+/)[1];
        }
        if (!domain || domain === 'localhost') { stats.unrecognized++; continue; }
        domain = domain.toLowerCase();
        if (!DOMAIN_PATTERN_RE.test(domain)) { stats.unrecognized++; continue; }
        if (domains.has(domain)) { stats.dedupSkipped++; continue; }
        domains.add(domain);
        stats.converted++;
      }
      sourceStats[url] = stats;
    } catch (e) {
      sourceErrors[url] = (e && e.message) || 'fetch failed';
    }
  }));

  // Same per-URL error/stats bookkeeping fetchRemoteRuleText's own
  // _fetchAndConvertUrls uses, so the dashboard's Rule Source rows show
  // fetch errors/counts for these two sources exactly like any other.
  if (urls.length) {
    const { [RULE_SOURCE_ERRORS_KEY]: existingErrors = {}, [RULE_SOURCE_STATS_KEY]: existingStats = {} } =
      await LocalStorage.get([RULE_SOURCE_ERRORS_KEY, RULE_SOURCE_STATS_KEY]);
    const nextErrors = { ...existingErrors };
    const nextStats = { ...existingStats };
    for (const url of urls) {
      if (sourceErrors[url]) nextErrors[url] = sourceErrors[url];
      else delete nextErrors[url];
      if (sourceStats[url]) nextStats[url] = sourceStats[url];
      else delete nextStats[url];
    }
    await LocalStorage.set({ [RULE_SOURCE_ERRORS_KEY]: nextErrors, [RULE_SOURCE_STATS_KEY]: nextStats });
  }

  // An empty `urls` (both sources disabled from the dashboard) legitimately
  // clears this to zero, same as a fully-disabled ad Rule Source produces no
  // rules. But unlike the old 24h-alarm-driven fetchMalwareBlocklists(),
  // this now runs on EVERY fetchRemoteRuleText() call — i.e. every time ANY
  // default source's cache goes stale, several times more often than
  // malware sources actually change — so a transient failure of BOTH
  // sources at once (offline, a CDN outage) must NOT wipe out a
  // previously-good list the way it would have on the old rare cadence;
  // keep serving the last known-good domains until a fetch actually
  // succeeds again, same as fetchRemoteRuleText() itself falls back to
  // cached/local text rather than an empty ruleset on a total failure.
  if (urls.length && urls.every(u => sourceErrors[u])) return;

  // Store only the domain/pattern lists — rules are rebuilt on apply.
  // Storing rule objects (~150 bytes each as JSON) wasted storage; the old
  // per-rule key is removed on first update after migration. Compressed
  // (deflate-raw) the same way as siteRulesCacheText — necessary now that
  // REMOTE_MAX_DOMAINS covers the real ~155k-domain combined feed instead of
  // truncating it. _compressDomainsForStorage/_decompressDomainsFromStorage
  // round-trip through JSON so they work unchanged for path patterns too —
  // it's still just "an array of strings" from their point of view.
  const domainList = Array.from(domains);
  const pathPatternList = Array.from(pathPatterns);
  const [compressedDomains, compressedPathPatterns] = await Promise.all([
    _compressDomainsForStorage(domainList),
    _compressDomainsForStorage(pathPatternList),
  ]);
  await LocalStorage.set({
    remoteMalwareDomains: compressedDomains,
    remoteMalwarePathPatterns: compressedPathPatterns,
    malwareListLastUpdate: Date.now(),
    malwareListCount: domainList.length + pathPatternList.length,
  });
  await LocalStorage.remove('remoteMalwareRules');
}

EXT.alarms?.create(RULES_REVALIDATE_ALARM, { periodInMinutes: RULES_REVALIDATE_PERIOD_MIN });
EXT.alarms?.create('extension-update-check', { periodInMinutes: 60 * 24 });
EXT.alarms?.onAlarm.addListener(async (alarm) => {
  if (alarm.name === RULES_REVALIDATE_ALARM) {
    await revalidateRemoteRules();
  }
  if (alarm.name === 'extension-update-check') {
    await checkForExtensionUpdate();
  }
  if (alarm.name === 'focus-end') {
    // Auto-disable focus mode when timer expires
    await LocalStorage.set({ focusMode: false, focusEndTime: null });
    await applyNetworkRules();
  }
});

// ── "Hide element" picker (right-click context menu) ─────────────────
// Arms content/element-picker.js for the clicked tab/frame; the actual
// pick/hide/persist flow happens entirely client-side after that (see
// element-picker.js), reporting back only the final SAVE_ELEMENT_RULE.
// contextMenus.create() fails (async, via runtime.lastError — not a thrown
// exception) if called again while a menu with that id still exists —
// removeAll() first makes this idempotent across service-worker restarts
// (no onInstalled-only guard needed). Two overlapping removeAll()->create()
// sequences can still race during rapid dev-reload cycles though (each
// instance's removeAll finishes, then their create()s interleave) — every
// create() below takes a callback that reads runtime.lastError so that race
// logs nothing instead of an "Unchecked runtime.lastError" console warning.
// documentUrlPatterns scopes these to http/https pages only — matches
// where the content scripts they arm (element-picker.js/global-scanner.js/
// rule-editor.js) actually run. <all_urls> (the manifest's content_scripts
// match) never injects into chrome://, chrome-extension:// (including this
// extension's own popup/dashboard), about:, or the PDF viewer regardless
// of match pattern — a hard platform restriction, not a config choice —
// so without this scoping these 3 items would show everywhere including
// those pages, where selecting them is a silent no-op (the message has no
// listener on the other end). file:// deliberately excluded too: only
// works if the user has separately opted the extension into file access,
// an uncommon case not worth cluttering the common one for.
const QKV1_MENU_URL_PATTERNS = ['http://*/*', 'https://*/*'];
// Waits for EXT_I18N_READY (i18n.js) so a non-"auto" Settings language
// choice is reflected in these titles too, not just the dashboard/popup —
// falls back to creating immediately if i18n.js somehow didn't load.
(self.EXT_I18N_READY || Promise.resolve()).then(() => { try {
  EXT.contextMenus.removeAll(() => {
    EXT.contextMenus.create({
      id: 'qkv1-pick-element',
      title: EXT.i18n.getMessage('menu_pickElement'),
      contexts: ['all'],
      documentUrlPatterns: QKV1_MENU_URL_PATTERNS,
    }, () => { void EXT.runtime.lastError; });
    // "Scan page globals" and "Edit rules for this site" are still-evolving
    // power-user tools — real risk of breaking a page if misused (permanent
    // configurable:false locks / raw rule-text entry), and the global-scope
    // scanner in particular reads as a fairly generic-sounding capability to
    // an outside reviewer even though its actual mechanism is squarely
    // ad-blocking-related (see the 2026-08-19 review). Gated behind
    // DEBUG_LOCAL for now — only reachable in local/debug builds, not
    // shipped to regular users, until they've had more real-world testing
    // and (if published) a store-listing description update. Element picker
    // stays unconditional — it's the established, lower-risk feature.
    if (DEBUG_LOCAL) {
      EXT.contextMenus.create({
        id: 'qkv1-scan-globals',
        title: EXT.i18n.getMessage('menu_scanGlobals'),
        contexts: ['all'],
        documentUrlPatterns: QKV1_MENU_URL_PATTERNS,
      }, () => { void EXT.runtime.lastError; });
      EXT.contextMenus.create({
        id: 'qkv1-edit-rules',
        title: EXT.i18n.getMessage('menu_editRules'),
        contexts: ['all'],
        documentUrlPatterns: QKV1_MENU_URL_PATTERNS,
      }, () => { void EXT.runtime.lastError; });
    }
  });
} catch (e) {} });
EXT.contextMenus?.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'qkv1-pick-element') {
    EXT.tabs.sendMessage(tab.id, { type: 'QKV1_ENTER_PICKER_MODE' }, { frameId: info.frameId }, () => {
      void EXT.runtime.lastError; // no listener on this frame yet — ignore
    });
  } else if (info.menuItemId === 'qkv1-scan-globals') {
    EXT.tabs.sendMessage(tab.id, { type: 'QKV1_ENTER_SCANNER_MODE' }, { frameId: info.frameId }, () => {
      void EXT.runtime.lastError;
    });
  } else if (info.menuItemId === 'qkv1-edit-rules') {
    EXT.tabs.sendMessage(tab.id, { type: 'QKV1_ENTER_RULE_EDITOR_MODE' }, { frameId: info.frameId }, () => {
      void EXT.runtime.lastError;
    });
  }
});

// ── Privacy: Referrer anonymization ───────────────────────────────
// Uses declarativeNetRequest to strip cross-origin Referer to origin only.
const REFERRER_RULE_ID = 400000;

async function applyReferrerAnonymization(enabled) {
  const existing = await EXT.declarativeNetRequest.getDynamicRules();
  const hasRule = existing.some(r => r.id === REFERRER_RULE_ID);

  if (enabled && !hasRule) {
    await EXT.declarativeNetRequest.updateDynamicRules({
      addRules: [{
        id: REFERRER_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{
            header: 'Referer',
            operation: 'set',
            value: '',
          }],
        },
        condition: {
          domainType: 'thirdParty',
          resourceTypes: ['sub_frame', 'script', 'xmlhttprequest', 'image', 'stylesheet', 'font', 'media', 'ping', 'other'],
        },
      }],
    });
  } else if (!enabled && hasRule) {
    await EXT.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [REFERRER_RULE_ID],
    });
  }
}

// ── Privacy: Global Privacy Control signal ──────────────────────────
// Sends the Sec-GPC request header — the HTTP half of the GPC opt-out
// signal (the JS half, navigator.globalPrivacyControl, is spoofed
// separately in content/scriptlets.js's spoofGpcSignal).
const GPC_RULE_ID = 400001;
const GPC_DNT_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'script', 'xmlhttprequest', 'image',
  'stylesheet', 'font', 'media', 'ping', 'other',
];

async function applyGpcHeader(enabled) {
  const existing = await EXT.declarativeNetRequest.getDynamicRules();
  const hasRule = existing.some(r => r.id === GPC_RULE_ID);

  if (enabled && !hasRule) {
    await EXT.declarativeNetRequest.updateDynamicRules({
      addRules: [{
        id: GPC_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{
            header: 'Sec-GPC',
            operation: 'set',
            value: '1',
          }],
        },
        condition: { resourceTypes: GPC_DNT_RESOURCE_TYPES },
      }],
    });
  } else if (!enabled && hasRule) {
    await EXT.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [GPC_RULE_ID],
    });
  }
}

// ── Privacy: Do Not Track header ────────────────────────────────────
const DNT_RULE_ID = 400002;

async function applyDntHeader(enabled) {
  const existing = await EXT.declarativeNetRequest.getDynamicRules();
  const hasRule = existing.some(r => r.id === DNT_RULE_ID);

  if (enabled && !hasRule) {
    await EXT.declarativeNetRequest.updateDynamicRules({
      addRules: [{
        id: DNT_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{
            header: 'DNT',
            operation: 'set',
            value: '1',
          }],
        },
        condition: { resourceTypes: GPC_DNT_RESOURCE_TYPES },
      }],
    });
  } else if (!enabled && hasRule) {
    await EXT.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [DNT_RULE_ID],
    });
  }
}

// Apply saved privacy settings on startup
async function applyPrivacySettings() {
  const { referrerAnonymization = true, gpcSignal = true, dntHeader = true } =
    await LocalStorage.get(['referrerAnonymization', 'gpcSignal', 'dntHeader']);
  await applyReferrerAnonymization(referrerAnonymization);
  await applyGpcHeader(gpcSignal);
  await applyDntHeader(dntHeader);
}

// ── Per-frame cosmetic CSS injection ────────────────────────────────
// Content scripts used to create their own `document.createElement('style')`
// nodes scoped under a toggle class on <html> — both the class and the
// style ids were page-visible fingerprint markers. Instead, apply cosmetic
// CSS via chrome.scripting.insertCSS, a privileged call that lands in the
// browser's own stylesheet layer: no <style> DOM node, not enumerable via
// document.styleSheets, and no class needed to gate it on/off — turning it
// off is just removeCSS.
//
// origin:'USER' places it in the "user" cascade origin, which always wins
// over the page's own CSS regardless of specificity/!important — matches
// uBlock Origin's own approach. removeCSS must pass the same origin used
// at insert time, or the browser won't recognize it as the same injection
// to remove.
//
// "slot" lets 3 independent CSS sources (base defaults, per-site
// direct_hide_selectors, user custom rules) update/clear without touching
// each other. Keyed per tab+frame since all_frames content scripts each
// have their own frameId.
const _frameCss = new Map(); // `${tabId}:${frameId}:${slot}` -> last-applied css text

function _frameCssKey(tabId, frameId, slot) {
  return `${tabId}:${frameId}:${slot}`;
}

// Firefox implements the same `scripting.insertCSS` namespace Chrome does
// (browser.tabs.insertCSS does not exist) — one shared implementation for
// both browsers.
async function _insertFrameCss(tabId, frameId, css) {
  await EXT.scripting.insertCSS({ target: { tabId, frameIds: [frameId] }, css, origin: 'USER' });
}
async function _removeFrameCss(tabId, frameId, css) {
  await EXT.scripting.removeCSS({ target: { tabId, frameIds: [frameId] }, css, origin: 'USER' });
}

async function setFrameCss(tabId, frameId, slot, css) {
  if (tabId === undefined || frameId === undefined) return;
  const key = _frameCssKey(tabId, frameId, slot);
  const prev = _frameCss.get(key);
  if (prev === css) return; // no change — already applied (or already absent)
  if (prev) {
    try { await _removeFrameCss(tabId, frameId, prev); }
    catch (e) { /* frame navigated away mid-flight — fine, nothing to clean up */ }
  }
  if (css) {
    try {
      await _insertFrameCss(tabId, frameId, css);
      _frameCss.set(key, css);
    } catch (e) { _frameCss.delete(key); }
  } else {
    _frameCss.delete(key);
  }
}

// A brand-new document (fresh navigation) can't know whether stale state is
// left over from the PREVIOUS document in this tab/frame — insertCSS'd
// content doesn't survive navigation, but our bookkeeping Map would, so the
// very first CSS_SET per page load (content.js's earlyInject, slot 'base')
// passes fresh:true to wipe any old entries for this tab/frame first.
function clearFrameCss(tabId, frameId) {
  const prefix = `${tabId}:${frameId}:`;
  for (const key of _frameCss.keys()) {
    if (key.startsWith(prefix)) _frameCss.delete(key);
  }
}

async function clearAllFrameCss(tabId, frameId) {
  const prefix = `${tabId}:${frameId}:`;
  for (const [key, css] of Array.from(_frameCss.entries())) {
    if (!key.startsWith(prefix)) continue;
    try { await _removeFrameCss(tabId, frameId, css); } catch (e) {}
    _frameCss.delete(key);
  }
}

EXT.tabs.onRemoved.addListener((tabId) => {
  const prefix = `${tabId}:`;
  for (const key of _frameCss.keys()) {
    if (key.startsWith(prefix)) _frameCss.delete(key);
  }
  _tabBlockedCounts.delete(tabId);
});

// ── In-memory settings cache (for the tabs.onCreated hot path below) ────
// A visible "flash" before a popup tab closes comes from latency between
// tab-creation and the tabs.remove() call — every extra `await` is a real
// IPC round-trip to the storage backend, not memory access, and gives the
// tab another paint frame to become visible/focused first. uBO's own
// onPopupUpdated (src/js/tab.js) makes zero fresh chrome.storage.* calls in
// its hot path — it only reads already-in-memory state (tabContextManager,
// parsed filter lists) — confirmed by reading their source. This cache
// mirrors that: kept in sync via onChanged instead of read fresh per call.
// pausedDomains/allowedDomains are Sets (not the raw storage arrays) so the
// per-new-tab / per-blocked-request membership checks below are O(1) instead
// of an O(n) Array scan. blockAds/blockTrackers/blockMalware are cached here
// too so the RESOURCE_SEEN hot path (below) doesn't need its own fresh
// chrome.storage.local.get() IPC round-trip on every blocked-resource report.
// gpcSignal/referrerAnonymization are cached here too (2026-08-23) so
// GET_SITE_CONFIG — which fires once per FRAME on every navigation/iframe
// load, the actual per-domain hot path, not resolveSiteKey()/getParsedRules()
// which were already indexed/cached earlier the same day — no longer does
// its own chrome.storage.local.get() round-trip on every single call.
const _SETTINGS_CACHE_SCALAR_KEYS = ['enabled', 'collectStats', 'blockAds', 'blockTrackers', 'blockMalware', 'gpcSignal', 'referrerAnonymization'];
const _settingsCache = {
  enabled: true, collectStats: true, blockAds: true, blockTrackers: true, blockMalware: true,
  gpcSignal: true, referrerAnonymization: true,
  pausedDomains: new Set(), allowedDomains: new Set(),
};
LocalStorage.get([..._SETTINGS_CACHE_SCALAR_KEYS, 'pausedDomains', 'allowedDomains']).then(r => {
  Object.assign(_settingsCache, r);
  _settingsCache.pausedDomains = new Set(r.pausedDomains || []);
  _settingsCache.allowedDomains = new Set(r.allowedDomains || []);
}).catch(() => {});
EXT.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const key of _SETTINGS_CACHE_SCALAR_KEYS) {
    if (changes[key]) _settingsCache[key] = changes[key].newValue;
  }
  for (const key of ['pausedDomains', 'allowedDomains']) {
    if (changes[key]) _settingsCache[key] = new Set(changes[key].newValue || []);
  }
});

// ── Popunder/click-hijack tab auto-close ─────────────────────────────
// src/js/tab.js onPopupUpdated/popunderMatch): closing a spawned tab based
// on which SITE opened it, not what domain it landed on, is the only way to
// catch popups that land on a legitimate destination (e.g. an affiliate-
// tracked redirect to a real travel/shopping site) — no destination
// blocklist can flag those without false-positiving on direct visits to the
// same site. `chrome.tabs.onCreated`'s `openerTabId` is set the same way
// whether the tab was spawned via window.open() or a native `target="_blank"`
// anchor click, so this catches both vectors uniformly, unlike the
// MAIN-world `no_window_open_if`/`disableNewtabLinks` scriptlets which only
// see whichever single vector they specifically proxy.
// Opt-in per site (`close_popunder_tabs = 1` in that site's site-rules.txt
// section) — same curation model uBO itself uses; there is no way to know a
// site abuses new-tab opens without someone having observed it first, and
// closing indiscriminately would also kill legitimate outbound new-tab links.
// Also opt-in via a GLOBAL list (`[global] close_popunder_domains`) — the
// close_popunder_tabs equivalent of content/site-rules-loader.js's
// open_defuser_domains (same idea, same _hostPatternMatches-based wildcard
// support, just living here since closing a tab needs the tabs API, which
// only background.js has). Seeded per-site as live-verified: no_window_open_if
// alone doesn't stop a site whose popup uses a native anchor click rather
// than window.open() — confirmed live on primesrc.me (2026-08-16): despite
// open_defuser_domains correctly injecting no_window_open_if there, the
// "Embed" demo player still opened a real popup tab (sportshard.com),
// proving the window.open-proxy vector isn't what this site uses.
function _domainListMatches(list, host) {
  if (!list || !list.length) return false;
  // Reuses _hostPatternMatches (already defined above for [host_patterns])
  // so entries here support the same "domain.*" wildcard-TLD shorthand —
  // uBO's real data has domains with 20-45 TLD variants each (serienstream.*,
  // txxx.*, acortalo.*) that would otherwise need enumerating every one.
  for (const d of list) if (_hostPatternMatches(d, host)) return true;
  return false;
}
EXT.tabs.onCreated.addListener(async (tab) => {
  if (!tab.openerTabId) return;
  if (!_settingsCache.enabled) return;
  // Never close this extension's own pages (dashboard/popup/blocked.html).
  // chrome.runtime.openOptionsPage() (open_in_tab:true) creates a real tab
  // via chrome.tabs.create — if the user triggers it while the CURRENTLY
  // ACTIVE tab happens to be on a close_popunder_tabs-flagged
  // site, Chrome can attribute that active tab as this new tab's opener,
  // and without this guard the dashboard/options tab gets misread as "this
  // site just spawned a popup" and closed immediately.
  const ownPrefix = EXT.runtime.getURL('');
  if ((tab.url && tab.url.startsWith(ownPrefix)) || (tab.pendingUrl && tab.pendingUrl.startsWith(ownPrefix))) return;
  try {
    // Only remaining await before the close call — Chrome doesn't hand us
    // the opener's URL in the onCreated event itself, so there's no way to
    // resolve which site spawned this tab without asking. getParsedRules()
    // below is also in-memory after its first call (module-level cache).
    const opener = await EXT.tabs.get(tab.openerTabId).catch(() => null);
    if (!opener || !opener.url) return;
    let openerHost;
    try { openerHost = new URL(opener.url).hostname.toLowerCase(); } catch { return; }
    if (_settingsCache.pausedDomains.has(openerHost) || _settingsCache.allowedDomains.has(openerHost)) return;
    const parsed = await getParsedRules();
    const siteKey = resolveSiteKey(parsed.host_patterns || {}, openerHost);
    const siteCfg = (siteKey && parsed[siteKey]) || {};
    const flag = siteCfg.close_popunder_tabs;
    const flagOn = !!(flag && flag.length && !['', '0', 'false', 'off'].includes(String(flag[0]).toLowerCase()));
    const globalMatch = _domainListMatches((parsed.global || {}).close_popunder_domains, openerHost);
    if (!flagOn && !globalMatch) return;
    await EXT.tabs.remove(tab.id).catch(() => {});
    if (_settingsCache.collectStats) {
      _enqueueStatWrite(() => _writeDomainStatDelta(openerHost, { adsBlocked: 1, totalSeen: 1 }));
      updateDailyStats({ blocked: 1, ads: 1, trackers: 0, malware: 0 });
    }
    // Credited to the OPENER's tab (the page that spawned the popunder) —
    // the popunder tab itself is already gone by this point.
    _incrementTabBlocked(tab.openerTabId, 1);
  } catch (e) {}
});

// ── "Hide element" picker persistence ────────────────────────────────
// Source of truth is the elementRules map ({host: [selector,...]}), NOT the
// generated text — regenerating the whole delimited block from the map on
// every write (instead of patching customRulesText in place) means a picked
// selector can never desync from what's actually saved. The block reuses
// [host_patterns]/direct_hide_selectors verbatim — the exact same, already
// battle-tested pipeline this whole session's site.rules.txt work went
// through, so no new "apply" code is needed, only "generate the text".
const ELEMENT_RULES_MARKER = '# === Auto-generated by "Hide element" — do not hand-edit below this line ===';
const ELEMENT_RULES_END_MARKER = '# === End "Hide element" rules ===';
function _elementRuleSiteKey(host) {
  return 'qkv1_' + host.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
// existingHostPatterns — the [host_patterns] map resolved from everything
// OUTSIDE this block (base rules file + any hand-written custom rules). A
// host already covered by a pre-existing [sitekey] section (e.g. a built-in
// [tuoitre] for tuoitre.vn) must reuse THAT key instead of minting our own
// qkv1_ one: parseRuleText merges duplicate [host_patterns] keys into an
// array and resolveSiteKey always takes the first match, so a second entry
// for the same host is silently unreachable — the picked selector would
// hide the element instantly (element-picker.js edits the live DOM too) but
// never re-apply after a reload, since GET_SITE_CONFIG resolves to the
// pre-existing key, not ours.
function _buildElementRulesBlock(elementRules, existingHostPatterns) {
  existingHostPatterns = existingHostPatterns || {};
  const hosts = Object.keys(elementRules).filter(h => elementRules[h] && elementRules[h].length);
  if (!hosts.length) return '';
  const newHostPatternLines = [];
  const sections = hosts.map(h => {
    const ownKey = _elementRuleSiteKey(h);
    const existingKey = resolveSiteKey(existingHostPatterns, h);
    // BUG (found 2026-08-23): comparing targetKey===ownKey to decide
    // whether to mint a NEW [host_patterns] line is wrong whenever
    // existingKey and ownKey happen to be the SAME STRING — which they
    // always are for a host already covered by a DIFFERENT marker block
    // of this same qkv1_ family (_elementRuleSiteKey is a pure function of
    // the host, so Hide-element's and Decline-ad-popup's "own key" for the
    // identical host are identical too). That made the old check ALWAYS
    // true in exactly the case it needed to be false, re-emitting a
    // redundant (if harmless — parseRuleText's merge dedupes it) duplicate
    // line every time a second feature touched an already-covered host.
    // The real question is just "did resolveSiteKey find ANYTHING for this
    // host already" — existingKey truthy already answers that, regardless
    // of which specific key it is.
    const targetKey = existingKey || ownKey;
    if (!existingKey) newHostPatternLines.push(`${h} = ${ownKey}`);
    return `[${targetKey}]\ndirect_hide_selectors = ${elementRules[h].join(' | ')}`;
  });
  const hostPatternsBlock = newHostPatternLines.length ? `[host_patterns]\n${newHostPatternLines.join('\n')}\n\n` : '';
  return `${ELEMENT_RULES_MARKER}\n${hostPatternsBlock}${sections.join('\n\n')}\n${ELEMENT_RULES_END_MARKER}`;
}
// Cuts out only the marker..end-marker region and keeps whatever text sits
// before AND after it — e.g. rules the user hand-typed in the dashboard's
// Rules tab below the generated block. An older block (pre end-marker) has
// no closing marker to find, so it falls back to dropping everything from
// the start marker onward, same as before — a one-time loss on first save
// after update, unavoidable since the old format never recorded where the
// block ended; every save from then on carries the end marker and is safe.
// Resolves existingHostPatterns for a marker-block rebuild, EXCLUDING that
// SAME block's own (stale, about-to-be-replaced) prior content — wherever
// it physically landed in the merged rules text — from the result.
// Without this, a host already present in the source map being rebuilt
// (elementRules/globalScopeRules/siteRuleText/noWindowOpenRules) is seen as
// "pre-existing" via its OWN outdated self-entry (getParsedRules()'s cache
// still has the pre-update customRulesText baked in until reloadRules()
// clears it, later in the SAME _applyXRules() call) — so the fix for the
// cross-feature-duplicate bug this helper exists for would then wrongly
// SKIP re-emitting that host's [host_patterns] line instead of keeping it,
// losing the mapping entirely the moment the stale block gets replaced
// (live-reported + reproduced 2026-08-23, alongside the duplicate-line bug
// itself). customRulesText is folded VERBATIM into the merged rules text
// (never ABP-converted — it's already this repo's own grammar), so the
// same marker strings that delimit a block in customRulesText also delimit
// it in the full merged text — stripping by marker search is safe
// regardless of where exactly the block ended up.
async function _getExistingHostPatternsExcludingBlock(marker, endMarker) {
  let text = '';
  try { text = await getRulesText(); } catch { return {}; }
  const startIdx = text.indexOf(marker);
  if (startIdx !== -1) {
    const endIdx = text.indexOf(endMarker);
    text = (endIdx !== -1 && endIdx > startIdx)
      ? text.slice(0, startIdx) + text.slice(endIdx + endMarker.length)
      : text.slice(0, startIdx);
  }
  try { return parseRuleText(text).host_patterns || {}; } catch { return {}; }
}

async function _applyElementRules(elementRules) {
  const { customRulesText = '' } = await LocalStorage.get('customRulesText');
  const startIdx = customRulesText.indexOf(ELEMENT_RULES_MARKER);
  const endIdx = customRulesText.indexOf(ELEMENT_RULES_END_MARKER);
  let before, after;
  if (startIdx === -1) {
    before = customRulesText;
    after = '';
  } else if (endIdx !== -1 && endIdx > startIdx) {
    before = customRulesText.slice(0, startIdx);
    after = customRulesText.slice(endIdx + ELEMENT_RULES_END_MARKER.length);
  } else {
    before = customRulesText.slice(0, startIdx);
    after = '';
  }
  before = before.replace(/\s*$/, '');
  after = after.replace(/^\s*/, '');
  const existingHostPatterns = await _getExistingHostPatternsExcludingBlock(ELEMENT_RULES_MARKER, ELEMENT_RULES_END_MARKER);
  const block = _buildElementRulesBlock(elementRules, existingHostPatterns);
  let newText = before;
  if (block) newText += (before ? '\n\n' : '') + block;
  if (after) newText += (newText ? '\n\n' : '') + after;
  await LocalStorage.set({ customRulesText: newText, elementRules });
  await reloadRules();
}

// ── "Decline ad popup, remember for next time" — no_window_open_if rule ──
// Written when the user ticks "Don't warn me again" on the ad-popup warning
// page and clicks Go back/Close (see blocked.js's AUTO_DECLINE_KEY comment
// for why that's a SEPARATE decision from Proceed's permanent-allow). A
// complementary, PROACTIVE layer on top of autoDeclineHosts: instead of
// only reacting after the popup already opened, it stops window.open()
// calls to that EXACT declined ad domain from firing at all on future
// visits to the SITE that spawned it — narrower than the site-wide
// close_popunder_tabs flag (per-domain, not "block every popup this site
// ever opens"), and it only covers the window.open() vector (not
// target="_blank" click-hijacks, which autoDeclineHosts/close_popunder_tabs
// still exist to catch). Same marker-block/siteKey-reuse pattern as
// _buildElementRulesBlock/_applyElementRules just above.
const NO_WINDOW_OPEN_RULES_MARKER = '# === Auto-generated by "Decline ad popup" — do not hand-edit below this line ===';
const NO_WINDOW_OPEN_RULES_END_MARKER = '# === End "Decline ad popup" rules ===';

function _buildNoWindowOpenRulesBlock(noWindowOpenRules, existingHostPatterns) {
  existingHostPatterns = existingHostPatterns || {};
  const hosts = Object.keys(noWindowOpenRules).filter(h => noWindowOpenRules[h] && noWindowOpenRules[h].length);
  if (!hosts.length) return '';
  const newHostPatternLines = [];
  const sections = hosts.map(h => {
    const ownKey = _elementRuleSiteKey(h);
    const existingKey = resolveSiteKey(existingHostPatterns, h);
    // BUG (found 2026-08-23): comparing targetKey===ownKey to decide
    // whether to mint a NEW [host_patterns] line is wrong whenever
    // existingKey and ownKey happen to be the SAME STRING — which they
    // always are for a host already covered by a DIFFERENT marker block
    // of this same qkv1_ family (_elementRuleSiteKey is a pure function of
    // the host, so Hide-element's and Decline-ad-popup's "own key" for the
    // identical host are identical too). That made the old check ALWAYS
    // true in exactly the case it needed to be false, re-emitting a
    // redundant (if harmless — parseRuleText's merge dedupes it) duplicate
    // line every time a second feature touched an already-covered host.
    // The real question is just "did resolveSiteKey find ANYTHING for this
    // host already" — existingKey truthy already answers that, regardless
    // of which specific key it is.
    const targetKey = existingKey || ownKey;
    if (!existingKey) newHostPatternLines.push(`${h} = ${ownKey}`);
    // "pattern, delayMs, decoy" per declined ad domain — 0 delay, "blank"
    // decoy (opens about:blank instead of nothing) matches this repo's own
    // pre-existing hand-curated [global] no_window_open_if convention.
    // pattern is a bare domain string, not a /regex/ — content/scriptlets.js's
    // _toRegex() escapes and substring-matches a plain string automatically.
    const value = noWindowOpenRules[h].map(adHost => `${adHost}, 0, blank`).join(' | ');
    return `[${targetKey}]\nno_window_open_if = ${value}`;
  });
  const hostPatternsBlock = newHostPatternLines.length ? `[host_patterns]\n${newHostPatternLines.join('\n')}\n\n` : '';
  return `${NO_WINDOW_OPEN_RULES_MARKER}\n${hostPatternsBlock}${sections.join('\n\n')}\n${NO_WINDOW_OPEN_RULES_END_MARKER}`;
}

async function _applyNoWindowOpenRules(noWindowOpenRules) {
  const { customRulesText = '' } = await LocalStorage.get('customRulesText');
  const startIdx = customRulesText.indexOf(NO_WINDOW_OPEN_RULES_MARKER);
  const endIdx = customRulesText.indexOf(NO_WINDOW_OPEN_RULES_END_MARKER);
  let before, after;
  if (startIdx === -1) {
    before = customRulesText;
    after = '';
  } else if (endIdx !== -1 && endIdx > startIdx) {
    before = customRulesText.slice(0, startIdx);
    after = customRulesText.slice(endIdx + NO_WINDOW_OPEN_RULES_END_MARKER.length);
  } else {
    before = customRulesText.slice(0, startIdx);
    after = '';
  }
  before = before.replace(/\s*$/, '');
  after = after.replace(/^\s*/, '');
  const existingHostPatterns = await _getExistingHostPatternsExcludingBlock(NO_WINDOW_OPEN_RULES_MARKER, NO_WINDOW_OPEN_RULES_END_MARKER);
  const block = _buildNoWindowOpenRulesBlock(noWindowOpenRules, existingHostPatterns);
  let newText = before;
  if (block) newText += (before ? '\n\n' : '') + block;
  if (after) newText += (newText ? '\n\n' : '') + after;
  await LocalStorage.set({ customRulesText: newText, noWindowOpenRules });
  await reloadRules();
}

// ── "Scan page globals" picker persistence ────────────────────────────
// Same design as the element-rules block above: globalScopeRules ({host:
// [{chain, action, value?}]}) is the source of truth, the marker-delimited
// block in customRulesText is always fully regenerated from it, never
// hand-patched. Reuses _elementRuleSiteKey (NOT a re-derived copy — a
// second independently-maintained sanitizer could drift and silently break
// the "reuse an existing site-key" collision-avoidance both features rely
// on) so a host with both an element rule and a global rule shares ONE
// [host_patterns] entry / one merged [qkv1_host] section — parseRuleText
// merges re-entered [section] headers by adding new keys into the same
// object (confirmed by reading its loop), so direct_hide_selectors from
// the element-rules block and set_constant/abort_on_property_read from
// this block combine correctly even though they're two separately
// generated marker regions.
//
// Action → scriptlet key mapping (reuses existing, already-wired scriptlet
// keys — no new scriptlet-application code needed anywhere):
//   block  -> abort_on_property_read only. abortOnPropertyRead (scriptlets.js)
//             already makes every future READ throw unconditionally,
//             regardless of what's since been written — so a page can never
//             observe a value through this property either way, achieving
//             "block" in effect. abort_on_property_write is deliberately NOT
//             also applied here: both scriptlets Object.defineProperty the
//             same leaf with configurable:false, so whichever one runs
//             first permanently claims that property slot and the second
//             silently no-ops (verified by reading both functions) — they
//             do not compose. Using only the read-block is the strictly
//             safer choice (avoids the page's own `x = y` write statements
//             throwing synchronously, which abort_on_property_write does).
//   edit   -> set_constant chain <value> (value already _parseVal-grammar
//             checked/escaped by SAVE_GLOBAL_RULE).
//   delete -> set_constant chain undefined (closest persistable
//             approximation — see SAVE_GLOBAL_RULE's comment on why a true
//             `delete` can't be made to stick against a page that
//             recreates the property; the ad-hoc one-time delete for
//             instant feedback happens client-side in scriptlets.js,
//             separately from this persisted form).
const GLOBAL_RULES_MARKER = '# === Auto-generated by "Global scope rules" — do not hand-edit below this line ===';
const GLOBAL_RULES_END_MARKER = '# === End "Global scope rules" rules ===';
const GLOBAL_RULE_CHAIN_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
const GLOBAL_RULE_ACTIONS = new Set(['block', 'edit', 'delete']);

function _buildGlobalRulesBlock(globalScopeRules, existingHostPatterns) {
  existingHostPatterns = existingHostPatterns || {};
  const hosts = Object.keys(globalScopeRules).filter(h => globalScopeRules[h] && globalScopeRules[h].length);
  if (!hosts.length) return '';
  const newHostPatternLines = [];
  const sections = hosts.map(h => {
    const ownKey = _elementRuleSiteKey(h);
    const existingKey = resolveSiteKey(existingHostPatterns, h);
    // BUG (found 2026-08-23): comparing targetKey===ownKey to decide
    // whether to mint a NEW [host_patterns] line is wrong whenever
    // existingKey and ownKey happen to be the SAME STRING — which they
    // always are for a host already covered by a DIFFERENT marker block
    // of this same qkv1_ family (_elementRuleSiteKey is a pure function of
    // the host, so Hide-element's and Decline-ad-popup's "own key" for the
    // identical host are identical too). That made the old check ALWAYS
    // true in exactly the case it needed to be false, re-emitting a
    // redundant (if harmless — parseRuleText's merge dedupes it) duplicate
    // line every time a second feature touched an already-covered host.
    // The real question is just "did resolveSiteKey find ANYTHING for this
    // host already" — existingKey truthy already answers that, regardless
    // of which specific key it is.
    const targetKey = existingKey || ownKey;
    if (!existingKey) newHostPatternLines.push(`${h} = ${ownKey}`);
    const reads = [], setC = [];
    for (const r of globalScopeRules[h]) {
      if (r.action === 'block') reads.push(r.chain);
      else if (r.action === 'edit') setC.push(`${r.chain} ${r.value}`);
      else if (r.action === 'delete') setC.push(`${r.chain} undefined`);
    }
    const lines = [];
    if (reads.length) lines.push(`abort_on_property_read = ${reads.join(' | ')}`);
    if (setC.length) lines.push(`set_constant = ${setC.join(' | ')}`);
    return `[${targetKey}]\n${lines.join('\n')}`;
  });
  const hostPatternsBlock = newHostPatternLines.length ? `[host_patterns]\n${newHostPatternLines.join('\n')}\n\n` : '';
  return `${GLOBAL_RULES_MARKER}\n${hostPatternsBlock}${sections.join('\n\n')}\n${GLOBAL_RULES_END_MARKER}`;
}

async function _applyGlobalRules(globalScopeRules) {
  const { customRulesText = '' } = await LocalStorage.get('customRulesText');
  const startIdx = customRulesText.indexOf(GLOBAL_RULES_MARKER);
  const endIdx = customRulesText.indexOf(GLOBAL_RULES_END_MARKER);
  let before, after;
  if (startIdx === -1) {
    before = customRulesText;
    after = '';
  } else if (endIdx !== -1 && endIdx > startIdx) {
    before = customRulesText.slice(0, startIdx);
    after = customRulesText.slice(endIdx + GLOBAL_RULES_END_MARKER.length);
  } else {
    before = customRulesText.slice(0, startIdx);
    after = '';
  }
  before = before.replace(/\s*$/, '');
  after = after.replace(/^\s*/, '');
  const existingHostPatterns = await _getExistingHostPatternsExcludingBlock(GLOBAL_RULES_MARKER, GLOBAL_RULES_END_MARKER);
  const block = _buildGlobalRulesBlock(globalScopeRules, existingHostPatterns);
  let newText = before;
  if (block) newText += (before ? '\n\n' : '') + block;
  if (after) newText += (newText ? '\n\n' : '') + after;
  await LocalStorage.set({ customRulesText: newText, globalScopeRules });
  await reloadRules();
}

// ── "Edit rules for this site" picker persistence ──────────────────────
// Same design as the two blocks above, but instead of one fixed key
// (direct_hide_selectors / set_constant+abort_on_property_read), the user
// types arbitrary raw site-rules.txt lines directly (key = value | value2
// syntax) for their own site section — a scoped-down, on-page version of
// the dashboard's whole-file Custom Rules textarea. siteRuleText ({host:
// text}) is the source of truth; the marker-delimited block is always
// fully regenerated from it, same as the other two features. Reuses
// _elementRuleSiteKey (see that function's own comment on why sharing it,
// not re-deriving it, matters) so a host with rules from any/all of the
// three picker features still lands in ONE merged [qkv1_host] section.
const SITE_RULE_TEXT_MARKER = '# === Auto-generated by "Rule editor" — do not hand-edit below this line ===';
const SITE_RULE_TEXT_END_MARKER = '# === End "Rule editor" rules ===';
const SITE_RULE_TEXT_MAX_LEN = 4000;

// Strips any line that looks like a [section] header. Unlike the
// dashboard's whole-file editor (where headers are the whole point), this
// text is embedded inside a [targetKey] wrapper WE control — a typed-in
// header would escape that scope and land content in a DIFFERENT section
// (potentially [global]) instead of just this site's own. Not a defense
// against a hostile page (this text only ever comes from a human typing
// into the on-page editor's own textarea, an isolated-world UI a page's JS
// cannot reach) — just scope containment for someone pasting a full
// example block from documentation without stripping its header first.
function _sanitizeSiteRuleText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter(line => !/^\s*\[.*\]\s*$/.test(line))
    .join('\n')
    .trim();
}

function _buildSiteRuleTextBlock(siteRuleText, existingHostPatterns) {
  existingHostPatterns = existingHostPatterns || {};
  const hosts = Object.keys(siteRuleText).filter(h => siteRuleText[h] && siteRuleText[h].trim());
  if (!hosts.length) return '';
  const newHostPatternLines = [];
  const sections = hosts.map(h => {
    const ownKey = _elementRuleSiteKey(h);
    const existingKey = resolveSiteKey(existingHostPatterns, h);
    // BUG (found 2026-08-23): comparing targetKey===ownKey to decide
    // whether to mint a NEW [host_patterns] line is wrong whenever
    // existingKey and ownKey happen to be the SAME STRING — which they
    // always are for a host already covered by a DIFFERENT marker block
    // of this same qkv1_ family (_elementRuleSiteKey is a pure function of
    // the host, so Hide-element's and Decline-ad-popup's "own key" for the
    // identical host are identical too). That made the old check ALWAYS
    // true in exactly the case it needed to be false, re-emitting a
    // redundant (if harmless — parseRuleText's merge dedupes it) duplicate
    // line every time a second feature touched an already-covered host.
    // The real question is just "did resolveSiteKey find ANYTHING for this
    // host already" — existingKey truthy already answers that, regardless
    // of which specific key it is.
    const targetKey = existingKey || ownKey;
    if (!existingKey) newHostPatternLines.push(`${h} = ${ownKey}`);
    return `[${targetKey}]\n${siteRuleText[h].trim()}`;
  });
  const hostPatternsBlock = newHostPatternLines.length ? `[host_patterns]\n${newHostPatternLines.join('\n')}\n\n` : '';
  return `${SITE_RULE_TEXT_MARKER}\n${hostPatternsBlock}${sections.join('\n\n')}\n${SITE_RULE_TEXT_END_MARKER}`;
}

async function _applySiteRuleText(siteRuleText) {
  const { customRulesText = '' } = await LocalStorage.get('customRulesText');
  const startIdx = customRulesText.indexOf(SITE_RULE_TEXT_MARKER);
  const endIdx = customRulesText.indexOf(SITE_RULE_TEXT_END_MARKER);
  let before, after;
  if (startIdx === -1) {
    before = customRulesText;
    after = '';
  } else if (endIdx !== -1 && endIdx > startIdx) {
    before = customRulesText.slice(0, startIdx);
    after = customRulesText.slice(endIdx + SITE_RULE_TEXT_END_MARKER.length);
  } else {
    before = customRulesText.slice(0, startIdx);
    after = '';
  }
  before = before.replace(/\s*$/, '');
  after = after.replace(/^\s*/, '');
  const existingHostPatterns = await _getExistingHostPatternsExcludingBlock(SITE_RULE_TEXT_MARKER, SITE_RULE_TEXT_END_MARKER);
  const block = _buildSiteRuleTextBlock(siteRuleText, existingHostPatterns);
  let newText = before;
  if (block) newText += (before ? '\n\n' : '') + block;
  if (after) newText += (newText ? '\n\n' : '') + after;
  await LocalStorage.set({ customRulesText: newText, siteRuleText });
  await reloadRules();
}

// In-memory memo for GET_SITE_CONFIG's computed `global` object — see that
// handler's own comment. Never persisted; naturally cleared (and correctly
// recomputed once) on every SW restart, same as every other in-memory memo
// in this file (_customBlockRulesMemo, _focusRulesMemo, etc.).
let _siteConfigGlobalMemo = { parsed: null, gpcSignal: null, referrerAnonymization: null, global: null };

// ── Message handler ───────────────────────────────────────────────
EXT.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {

      case 'CSS_SET': {
        const tabId = sender.tab && sender.tab.id;
        const frameId = sender.frameId;
        if (tabId !== undefined && frameId !== undefined) {
          if (msg.fresh) clearFrameCss(tabId, frameId);
          await setFrameCss(tabId, frameId, msg.slot, msg.css || '');
        }
        sendResponse({ ok: true });
        break;
      }

      case 'CSS_CLEAR_ALL': {
        const tabId = sender.tab && sender.tab.id;
        const frameId = sender.frameId;
        if (tabId !== undefined && frameId !== undefined) {
          await clearAllFrameCss(tabId, frameId);
        }
        sendResponse({ ok: true });
        break;
      }

      case 'TOGGLE': {
        await LocalStorage.set({ enabled: msg.enabled });
        await applyNetworkRules();
        sendResponse({ ok: true });
        break;
      }

      case 'PAUSE_DOMAIN': {
        const { pausedDomains = [] } = await LocalStorage.get('pausedDomains');
        if (msg.paused && !pausedDomains.includes(msg.domain)) {
          pausedDomains.push(msg.domain);
        } else if (!msg.paused) {
          const idx = pausedDomains.indexOf(msg.domain);
          if (idx !== -1) pausedDomains.splice(idx, 1);
        }
        await LocalStorage.set({ pausedDomains });
        await applyNetworkRules();
        // Update badge on the active tab immediately
        const [activeTab] = await EXT.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.id) {
          if (msg.paused) {
            EXT.action.setBadgeText({ text: '⏸', tabId: activeTab.id });
            EXT.action.setBadgeBackgroundColor({ color: '#f59e0b', tabId: activeTab.id });
          } else {
            _setTabBadge(activeTab.id); // restore this tab's own block count
          }
        }
        sendResponse({ ok: true });
        break;
      }

      case 'SAVE_ELEMENT_RULE': {
        const host = String(msg.host || '').toLowerCase();
        const selector = String(msg.selector || '').trim();
        if (!host || !DOMAIN_PATTERN_RE.test(host) || !selector || selector.length > 500) {
          sendResponse({ ok: false });
          break;
        }
        const safeSelector = selector.replace(/\|/g, '\\|');
        const { elementRules = {} } = await LocalStorage.get('elementRules');
        const list = elementRules[host] || [];
        if (!list.includes(safeSelector)) list.push(safeSelector);
        elementRules[host] = list;
        await _applyElementRules(elementRules);
        sendResponse({ ok: true });
        break;
      }

      case 'REMOVE_ELEMENT_RULE': {
        const host = String(msg.host || '').toLowerCase();
        if (!host) { sendResponse({ ok: false }); break; }
        const { elementRules = {} } = await LocalStorage.get('elementRules');
        if (msg.selector) {
          const list = (elementRules[host] || []).filter(s => s !== msg.selector);
          if (list.length) elementRules[host] = list;
          else delete elementRules[host];
        } else {
          delete elementRules[host]; // no selector given — drop the whole host
        }
        await _applyElementRules(elementRules);
        sendResponse({ ok: true });
        break;
      }

      // Sent by blocked/blocked.js when the user declines an ad-popup (Go
      // back/Close + "Don't warn me again") AND the popup's opener site
      // could be resolved (chrome.tabs.get(openerTabId)) — writes a
      // no_window_open_if rule scoped to the OPENER's siteKey, targeting
      // just this one declined ad domain. See _applyNoWindowOpenRules's own
      // comment for how this differs from autoDeclineHosts.
      case 'SAVE_NO_WINDOW_OPEN_RULE': {
        const openerHost = String(msg.openerHost || '').toLowerCase();
        const adHost = String(msg.adHost || '').toLowerCase();
        if (!openerHost || !DOMAIN_PATTERN_RE.test(openerHost) || !adHost || !DOMAIN_PATTERN_RE.test(adHost)) {
          sendResponse({ ok: false });
          break;
        }
        const { noWindowOpenRules = {} } = await LocalStorage.get('noWindowOpenRules');
        const list = noWindowOpenRules[openerHost] || [];
        if (!list.includes(adHost)) list.push(adHost);
        noWindowOpenRules[openerHost] = list;
        await _applyNoWindowOpenRules(noWindowOpenRules);
        sendResponse({ ok: true });
        break;
      }

      case 'SAVE_GLOBAL_RULE': {
        const host = String(msg.host || '').toLowerCase();
        const chain = String(msg.chain || '').trim();
        const action = String(msg.action || '');
        if (!host || !DOMAIN_PATTERN_RE.test(host)) { sendResponse({ ok: false }); break; }
        if (!chain || chain.length > 300 || !GLOBAL_RULE_CHAIN_RE.test(chain)) { sendResponse({ ok: false }); break; }
        if (!GLOBAL_RULE_ACTIONS.has(action)) { sendResponse({ ok: false }); break; }
        let value;
        if (action === 'edit') {
          value = String(msg.value ?? '').trim();
          // _parseVal (scriptlets.js) reads only the first whitespace-run-
          // separated token after the chain — a value containing a space
          // would silently truncate at the message-consumer end, so reject
          // it here instead of storing something that won't do what the
          // user picked. '|' is this codebase's value-list separator
          // (site-rules.txt / customRulesText both split on it), same
          // belt-and-suspenders double-escape convention as SAVE_ELEMENT_RULE.
          if (!value || value.length > 500 || /\s/.test(value)) { sendResponse({ ok: false }); break; }
          value = value.replace(/\|/g, '\\|');
        }
        const { globalScopeRules = {} } = await LocalStorage.get('globalScopeRules');
        const list = globalScopeRules[host] || [];
        const idx = list.findIndex(r => r.chain === chain);
        const entry = { chain, action };
        if (action === 'edit') entry.value = value;
        if (idx !== -1) list[idx] = entry; else list.push(entry);
        globalScopeRules[host] = list;
        await _applyGlobalRules(globalScopeRules);
        sendResponse({ ok: true });
        break;
      }

      case 'REMOVE_GLOBAL_RULE': {
        const host = String(msg.host || '').toLowerCase();
        if (!host) { sendResponse({ ok: false }); break; }
        const { globalScopeRules = {} } = await LocalStorage.get('globalScopeRules');
        if (msg.chain) {
          const list = (globalScopeRules[host] || []).filter(r => r.chain !== msg.chain);
          if (list.length) globalScopeRules[host] = list;
          else delete globalScopeRules[host];
        } else {
          delete globalScopeRules[host]; // no chain given — drop the whole host
        }
        await _applyGlobalRules(globalScopeRules);
        sendResponse({ ok: true });
        break;
      }

      case 'GET_SITE_RULE_TEXT': {
        const host = String(msg.host || '').toLowerCase();
        if (!host || !DOMAIN_PATTERN_RE.test(host)) { sendResponse({ ok: false }); break; }
        const { siteRuleText = {} } = await LocalStorage.get('siteRuleText');
        // `existingText` is the FULL resolved section for this host — built-in
        // rule/site-rules.txt content, plus anything already added via the
        // element picker / global-scope picker / this same rule editor,
        // however it got there. Read-only reference in the UI: `text` (this
        // feature's own tracked delta, the one actually round-tripped through
        // the editable textarea) already appears WITHIN existingText too
        // (parseRuleText merges every source into one resolved object), so
        // there's no separate "what's mine vs. everyone else's" split here —
        // deliberately simple, since parseRuleText's merge is additive-only
        // (same key from multiple sources unions their values, never
        // overrides), so there's no real "ownership" distinction to draw.
        let existingText = '';
        try {
          const parsed = await getParsedRules();
          const siteKey = resolveSiteKey(parsed.host_patterns || {}, host);
          const site = (siteKey && parsed[siteKey]) || {};
          existingText = Object.keys(site)
            .filter(k => site[k] && site[k].length)
            .map(k => `${k} = ${site[k].join(' | ')}`)
            .join('\n');
        } catch {}
        sendResponse({ ok: true, text: siteRuleText[host] || '', existingText });
        break;
      }

      case 'SAVE_SITE_RULE_TEXT': {
        const host = String(msg.host || '').toLowerCase();
        if (!host || !DOMAIN_PATTERN_RE.test(host)) { sendResponse({ ok: false }); break; }
        if (String(msg.text ?? '').length > SITE_RULE_TEXT_MAX_LEN) { sendResponse({ ok: false }); break; }
        const text = _sanitizeSiteRuleText(msg.text);
        const { siteRuleText = {} } = await LocalStorage.get('siteRuleText');
        // Saving an empty (or header-only) textarea is the "clear this
        // site's rules" gesture — no separate REMOVE message needed, unlike
        // the other two pickers' per-item add/remove model.
        if (text) siteRuleText[host] = text; else delete siteRuleText[host];
        await _applySiteRuleText(siteRuleText);
        sendResponse({ ok: true });
        break;
      }

      case 'FOCUS_MODE': {
        await LocalStorage.set({ focusMode: msg.enabled });
        if (msg.enabled) {
          // Set alarm to auto-disable focus when timer expires (even if dashboard is closed)
          const { focusEndTime } = await LocalStorage.get('focusEndTime');
          if (focusEndTime) {
            const delayMs = focusEndTime - Date.now();
            if (delayMs > 0) {
              EXT.alarms.create('focus-end', { when: focusEndTime });
            }
          }
        } else {
          EXT.alarms.clear('focus-end');
        }
        await applyNetworkRules();
        sendResponse({ ok: true });
        break;
      }

      case 'ALLOWLIST_CHANGED': {
        await applyNetworkRules();
        sendResponse({ ok: true });
        break;
      }

      // Sent by blocked/blocked.js's "Proceed anyway" button. msg.permanent
      // (the "Don't warn me again about this site" checkbox) decides which
      // list the host goes into — see buildActiveRulesFromStorage()'s own
      // comment on sessionAllowedDomains vs allowedDomains for why there
      // are two. Rules are rebuilt and acknowledged BEFORE blocked.js
      // navigates away, so the real destination doesn't immediately bounce
      // back to this same warning page.
      case 'PROCEED_BLOCKED_HOST': {
        const host = String(msg.host || '').toLowerCase();
        if (!host) { sendResponse({ ok: false }); break; }
        if (msg.permanent) {
          const { allowedDomains: current = [] } = await LocalStorage.get('allowedDomains');
          if (!current.includes(host)) {
            await LocalStorage.set({ allowedDomains: [...current, host] });
          }
        } else {
          const { sessionAllowedDomains: current = [] } = await SessionStorage.get('sessionAllowedDomains');
          if (!current.includes(host)) {
            await SessionStorage.set({ sessionAllowedDomains: [...current, host] });
          }
        }
        await applyNetworkRules();
        sendResponse({ ok: true });
        break;
      }

      case 'RULES_CHANGED': {
        // Invalidate caches, re-fetch all sources, rebuild DNR rules and
        // notify every tab. Debounced (see debouncedReloadRules()'s own
        // comment) so several rapid dashboard edits collapse into one pass.
        await debouncedReloadRules();
        sendResponse({ ok: true });
        break;
      }

      // Dashboard's per-URL "Export" button on the Rule Source list — lets
      // the user download what one specific ABP-format source actually
      // converts to in this repo's own grammar, for inspection/debugging
      // (e.g. checking the "abp_"-prefixed [host_patterns] keys it minted).
      // Always re-fetches + re-converts fresh rather than reading any cache:
      // the merged RULES_CACHE_TEXT_KEY blob is every enabled source
      // combined, with no per-URL breakdown kept anywhere, and re-fetching
      // one source's own raw text is cheap/one-shot compared to that.
      case 'EXPORT_CONVERTED_RULE_SOURCE': {
        const url = String(msg.url || '');
        if (!/^https?:\/\//i.test(url)) { sendResponse({ ok: false, error: 'invalid url' }); break; }
        try {
          const res = await fetch(url, { cache: 'no-store' });
          if (!res.ok) { sendResponse({ ok: false, error: `HTTP ${res.status}` }); break; }
          const raw = await res.text();
          if (!raw) { sendResponse({ ok: false, error: 'empty response' }); break; }
          const converted = await _maybeConvertAbpText(raw);
          sendResponse({ ok: true, text: converted, wasAbp: converted !== raw });
        } catch (e) {
          sendResponse({ ok: false, error: (e && e.message) || 'fetch failed' });
        }
        break;
      }

      case 'SET_PRIVACY': {
        // msg: { setting: 'referrerAnonymization' | 'gpcSignal' | 'dntHeader', value: bool }
        const allowed = ['referrerAnonymization', 'gpcSignal', 'dntHeader'];
        if (!allowed.includes(msg.setting)) { sendResponse({ ok: false }); break; }
        await LocalStorage.set({ [msg.setting]: msg.value });
        if (msg.setting === 'referrerAnonymization') await applyReferrerAnonymization(msg.value);
        if (msg.setting === 'gpcSignal') await applyGpcHeader(msg.value);
        if (msg.setting === 'dntHeader') await applyDntHeader(msg.value);
        // gpcSignal/referrerAnonymization also gate MAIN-world scriptlets
        // (content/scriptlets.js) via GET_SITE_CONFIG — resync every open
        // tab so it picks up the new flag without a page reload.
        const tabs = await EXT.tabs.query({});
        for (const tab of tabs) {
          EXT.tabs.sendMessage(tab.id, { type: 'PRIVACY_TOGGLE' }).catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }

      case 'SET_BLOCKING': {
        // msg: { setting: 'blockAds' | 'blockTrackers' | 'cosmeticFiltering' | 'blockMalware', value: bool }
        const allowedKeys = ['blockAds', 'blockTrackers', 'cosmeticFiltering', 'blockMalware'];
        if (!allowedKeys.includes(msg.setting)) { sendResponse({ ok: false }); break; }
        await LocalStorage.set({ [msg.setting]: msg.value });
        if (msg.setting === 'cosmeticFiltering') {
          // Notify all tabs to enable/disable cosmetic CSS
          const tabs = await EXT.tabs.query({});
          for (const tab of tabs) {
            EXT.tabs.sendMessage(tab.id, { type: 'COSMETIC_TOGGLE', enabled: msg.value }).catch(() => {});
          }
        } else {
          await applyNetworkRules();
        }
        sendResponse({ ok: true });
        break;
      }

      case 'RESOURCE_SEEN': {
        // Sent by content.js MutationObserver with classification counts.
        // delta: { seen, ads, trackers, malware }
        // Reads _settingsCache (kept in sync via storage.onChanged, see its
        // own comment above) instead of a fresh chrome.storage.local.get()
        // — this handler fires once per blocked-resource report, a genuine
        // per-request hot path, so skipping the IPC round-trip and the
        // Array.includes() scans (Set.has() instead) both matter here.
        if (!_settingsCache.collectStats) { sendResponse({ ok: true }); break; }

        const domain = msg.domain || '_global';
        // Only count categories whose blocking is actually active — a matched
        // URL is only "blocked" if the corresponding DNR rules are installed.
        if (!_settingsCache.enabled || _settingsCache.pausedDomains.has(domain) || _settingsCache.allowedDomains.has(domain)) {
          sendResponse({ ok: true });
          break;
        }
        const d = msg.delta || {};
        const ads      = _settingsCache.blockAds      ? (d.ads      || 0) : 0;
        const trackers = _settingsCache.blockTrackers ? (d.trackers || 0) : 0;
        const malware  = _settingsCache.blockMalware  ? (d.malware  || 0) : 0;
        _enqueueStatWrite(() => _writeDomainStatDelta(domain, {
          totalSeen:       d.seen || 0,
          adsBlocked:      ads,
          trackersBlocked: trackers,
          malwareBlocked:  malware,
        }));
        updateDailyStats({
          blocked:  ads + trackers + malware,
          ads,
          trackers,
          malware,
        });
        _incrementTabBlocked(sender.tab && sender.tab.id, ads + trackers + malware);
        sendResponse({ ok: true });
        break;
      }

      case 'COSMETIC_HIDDEN': {
        // Sent by content.js / site-block.js when cosmetic filtering hides ad elements.
        const { collectStats: collectCH = true } = await LocalStorage.get('collectStats');
        if (!collectCH) { sendResponse({ ok: true }); break; }

        const chDomain = (msg.url ? new URL(msg.url).hostname : null) || '_global';
        const hiddenCount = msg.count || 0;
        _enqueueStatWrite(() => _writeDomainStatDelta(chDomain, {
          adsBlocked: hiddenCount, cosmeticHidden: hiddenCount, totalSeen: hiddenCount,
        }));
        updateDailyStats({ blocked: hiddenCount, ads: hiddenCount, trackers: 0, malware: 0 });
        _incrementTabBlocked(sender.tab && sender.tab.id, hiddenCount);
        sendResponse({ ok: true });
        break;
      }

      case 'GET_CLASSIFIER_LISTS': {
        await ensureRuleDefinitionsLoaded();
        // Derive classifier patterns directly from actual DNR rule definitions.
        // content.js uses these to classify observed DOM resources for stats.
        // Patterns live either in a grouped requestDomains rule or in
        // individual urlFilter rules.
        const adPatterns = [];
        const trackerPatterns = [];
        for (const r of DEFAULT_RULES) {
          const bucket = TRACKER_RULE_IDS.has(r.id) ? trackerPatterns : adPatterns;
          if (r.condition.urlFilter) bucket.push(r.condition.urlFilter);
          if (r.condition.requestDomains) bucket.push(...r.condition.requestDomains);
        }

        const malwarePatterns = [...new Set(
          MALWARE_RULES.flatMap(r => r.condition.requestDomains || [])
        )];

        // Also include user custom block rules (domain + keyword types)
        const { rules = [] } = await LocalStorage.get('rules');
        for (const r of rules) {
          if (!r.active || r.action !== 'block') continue;
          if (r.type === 'domain' && r.pattern)  adPatterns.push(r.pattern);
          if (r.type === 'keyword' && r.pattern) adPatterns.push(r.pattern);
        }

        sendResponse({ adPatterns, trackerPatterns, malwarePatterns });
        break;
      }

      case 'GET_STATS': {
        const { stats = {} } = await LocalStorage.get('stats');
        sendResponse({ stats });
        break;
      }

      case 'GET_RULE_COUNT': {
        const rules = await EXT.declarativeNetRequest.getDynamicRules();
        // On Firefox (webRequestBlocking), network_block_rules and the
        // path-scoped half of remoteMalwarePathPatterns are matched via
        // NETWORK_BLOCK_MATCHER/MALWARE_PATH_MATCHER instead of DNR — see
        // _hasWebRequestBlocking()'s own comment — so getDynamicRules()
        // alone massively UNDER-reports real coverage there (live-reported
        // 2026-08-31: popup showed "155" on Firefox vs "17526" on Chrome for
        // equivalent protection). Add both matchers' entry counts so the
        // displayed total means the same thing on every browser — on
        // Chrome/Edge both Maps are always empty, so this is a no-op there.
        const matcherCount = _matcherEntryCount(NETWORK_BLOCK_MATCHER) + _matcherEntryCount(MALWARE_PATH_MATCHER);
        sendResponse({ count: rules.length + matcherCount, rules: rules.map(r => r.id) });
        break;
      }

      case 'GET_UPDATE_STATUS': {
        const { updateInfo = {} } = await LocalStorage.get('updateInfo');
        sendResponse({
          ok: true,
          currentVersion: EXT.runtime.getManifest().version,
          latestVersion: updateInfo.latestVersion || '',
          available: !!updateInfo.available,
          lastChecked: updateInfo.lastChecked || 0,
          lastCheckOk: updateInfo.lastCheckOk !== false,
        });
        break;
      }

      case 'CHECK_FOR_UPDATE_NOW': {
        const updateInfo = await checkForExtensionUpdate();
        sendResponse({
          ok: true,
          currentVersion: EXT.runtime.getManifest().version,
          latestVersion: updateInfo.latestVersion || '',
          available: !!updateInfo.available,
          lastChecked: updateInfo.lastChecked || 0,
          lastCheckOk: updateInfo.lastCheckOk !== false,
        });
        break;
      }

      case 'UPDATE_MALWARE_LISTS': {
        // Malware sources are just RULES_REMOTE_URL entries now — a manual
        // refresh forces the same full pipeline the dashboard's "Reload
        // rules" and the 30-min ETag revalidation alarm already use.
        await reloadRules();
        const { malwareListCount = 0 } = await LocalStorage.get('malwareListCount');
        sendResponse({ ok: true, count: malwareListCount });
        break;
      }

      case 'GET_RULES_TEXT': {
        // Legacy/fallback: full merged rules text. Content scripts normally use
        // GET_SITE_CONFIG which sends only the relevant parsed sections.
        try {
          sendResponse({ text: await getRulesText() });
        } catch {
          sendResponse({ text: '' });
        }
        break;
      }

      case 'GET_SITE_CONFIG': {
        // Sends a frame only what it needs: [global] + its resolved site section
        // (a few KB), instead of the full rules text that every frame previously
        // fetched and re-parsed independently. This handler fires once per
        // FRAME on every navigation/iframe load — the real per-domain hot
        // path here — so nothing below it should do a fresh
        // chrome.storage.local.get() or rebuild an object that didn't change.
        try {
          const parsed = await getParsedRules();
          const host = String(msg.host || '').toLowerCase();
          const siteKey = resolveSiteKey(parsed.host_patterns || {}, host);
          // gpcSignal/referrerAnonymization are chrome.storage privacy
          // toggles, not site-rules.txt keys — synthesized here as flag-style
          // global entries so they ride the same SCRIPTLET_KEYS pipeline as
          // every other MAIN-world scriptlet, with no [global] override path
          // to worry about (see background.js:1305-1345 applyPrivacySettings).
          // Read from _settingsCache (kept in sync via storage.onChanged, see
          // its own comment) instead of chrome.storage.local.get() — this
          // used to be a real per-call storage IPC round-trip on every single
          // frame/navigation, confirmed 2026-08-23.
          const { gpcSignal, referrerAnonymization } = _settingsCache;
          // The computed `global` object only actually changes when parsed
          // (a stable reference across calls — see getParsedRules()'s own
          // comment) or these two flags change, so memoize it instead of
          // reallocating + re-assigning on every call.
          let global;
          if (_siteConfigGlobalMemo.parsed === parsed
            && _siteConfigGlobalMemo.gpcSignal === gpcSignal
            && _siteConfigGlobalMemo.referrerAnonymization === referrerAnonymization) {
            global = _siteConfigGlobalMemo.global;
          } else {
            global = Object.assign({}, parsed.global || {});
            if (gpcSignal) global.gpc_signal = ['1'];
            if (referrerAnonymization) global.hide_document_referrer = ['1'];
            _siteConfigGlobalMemo = { parsed, gpcSignal, referrerAnonymization, global };
          }
          sendResponse({
            siteKey,
            global,
            site: (siteKey && parsed[siteKey]) || {},
          });
        } catch {
          sendResponse(null);
        }
        break;
      }

      case 'GET_MALWARE_STATUS': {
        await ensureRuleDefinitionsLoaded();
        const { malwareListLastUpdate = 0, malwareListCount = 0 } = await LocalStorage.get(['malwareListLastUpdate', 'malwareListCount']);
        // Grouped rules (block + main_frame redirect) share the same domain
        // list — count unique domains, not per-rule entries.
        const builtinMalwareCount = new Set(
          MALWARE_RULES.flatMap(r => r.condition.requestDomains || [])
        ).size;
        sendResponse({ lastUpdate: malwareListLastUpdate, count: malwareListCount + builtinMalwareCount });
        break;
      }

      case 'MALWARE_PAGE_BLOCKED': {
        // Sent by blocked/blocked.js after a main_frame malware navigation was
        // redirected to the warning page — the only way such blocks get counted.
        const host = String(msg.host || '').toLowerCase();
        if (!host || !DOMAIN_PATTERN_RE.test(host)) { sendResponse({ ok: false }); break; }
        const { collectStats: collectMB = true } = await LocalStorage.get('collectStats');
        if (!collectMB) { sendResponse({ ok: true }); break; }
        _enqueueStatWrite(() => _writeDomainStatDelta(host, { malwareBlocked: 1, totalSeen: 1 }));
        updateDailyStats({ blocked: 1, ads: 0, trackers: 0, malware: 1 });
        _incrementTabBlocked(sender.tab && sender.tab.id, 1);
        sendResponse({ ok: true });
        break;
      }

      case 'AD_POPUP_PAGE_BLOCKED': {
        // Sent by blocked/blocked.js after a main_frame navigation to a known
        // ad-network domain (popunder/click-hijack) was redirected here —
        // the only way such blocks get counted, same as MALWARE_PAGE_BLOCKED.
        const host = String(msg.host || '').toLowerCase();
        if (!host || !DOMAIN_PATTERN_RE.test(host)) { sendResponse({ ok: false }); break; }
        const { collectStats: collectAB = true } = await LocalStorage.get('collectStats');
        if (!collectAB) { sendResponse({ ok: true }); break; }
        _enqueueStatWrite(() => _writeDomainStatDelta(host, { adsBlocked: 1, totalSeen: 1 }));
        updateDailyStats({ blocked: 1, ads: 1, trackers: 0, malware: 0 });
        _incrementTabBlocked(sender.tab && sender.tab.id, 1);
        sendResponse({ ok: true });
        break;
      }

      case 'RESET': {
        await LocalStorage.clear();
        await EXT.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: (await EXT.declarativeNetRequest.getDynamicRules()).map(r => r.id),
          addRules: [],
        });
        activeStatsRules = [];
        statsRulesInitialized = true;
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ ok: false, error: 'Unknown message type' });
    }
  })();
  return true; // keep channel open for async response
});

// ── Tab tracking (pause badge + per-tab block count) ────────────────
// Pause state always wins the badge (⏸); otherwise the tab shows its own
// _tabBlockedCounts entry via _setTabBadge.
function updateBadgeForTab(tabId, url) {
  if (!url) return;
  let domain = '';
  try { domain = new URL(url).hostname; } catch { return; }
  // Reads _settingsCache (Set, kept in sync via storage.onChanged) instead
  // of a fresh chrome.storage.local.get() + Array.includes() — this runs on
  // every tab activate/navigation-complete, a genuine per-navigation hot path.
  if (_settingsCache.pausedDomains.has(domain)) {
    EXT.action.setBadgeText({ text: '⏸', tabId }).catch(() => {});
    EXT.action.setBadgeBackgroundColor({ color: '#f59e0b', tabId }).catch(() => {});
  } else {
    _setTabBadge(tabId);
  }
  updateContextMenuVisibility(domain);
}

// "Pick element to hide…" (and the two DEBUG_LOCAL-only power-user items)
// only make sense where blocking would actually apply — hide them entirely
// (not just grey out) for the active tab's domain while protection is
// globally off, the site is paused, or the site is allowlisted, since a
// rule captured there would never take effect. `enabledOverride` lets
// updateIcon(false) pass the just-computed `enabled` value directly instead
// of reading _settingsCache.enabled, which may not have caught up yet via
// storage.onChanged at that exact call site.
function updateContextMenuVisibility(domain, enabledOverride) {
  const enabled = enabledOverride !== undefined ? enabledOverride : _settingsCache.enabled;
  const visible = enabled && !!domain && !_settingsCache.pausedDomains.has(domain) && !_settingsCache.allowedDomains.has(domain);
  EXT.contextMenus?.update?.('qkv1-pick-element', { visible }, () => { void EXT.runtime.lastError; });
  if (DEBUG_LOCAL) {
    EXT.contextMenus?.update?.('qkv1-scan-globals', { visible }, () => { void EXT.runtime.lastError; });
    EXT.contextMenus?.update?.('qkv1-edit-rules', { visible }, () => { void EXT.runtime.lastError; });
  }
}

EXT.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await EXT.tabs.get(tabId).catch(() => null);
  if (!tab?.url) return;
  updateBadgeForTab(tabId, tab.url);
});

EXT.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // changeInfo.url is only present when the tab actually navigated to a new
  // URL (not on every status tick) — that's the per-tab block count's reset
  // point, same "new page, new count" behavior as uBO's badge.
  if (changeInfo.url) {
    _tabBlockedCounts.delete(tabId);
    _setTabBadge(tabId);
  }
  if (changeInfo.status === 'complete' && tab.url) {
    updateBadgeForTab(tabId, tab.url);
  }
});

// ── Helpers ───────────────────────────────────────────────────────
function extractDomain(url) {
  try { return new URL(url).hostname; }
  catch { return null; }
}