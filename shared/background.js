// background.js — AdBlock Service Worker (Manifest V3)
// Handles: network blocking (declarativeNetRequest) + message routing

for (const [name, globalName] of [['abp-converter', 'AbpConverter'], ['rule-parser', 'RuleParser'], ['rule-fetcher', 'RuleFetcher'], ['settings-controller', 'SettingsController']]) {
  if (typeof importScripts === 'function' && !self[globalName]) importScripts(name + '.js');
}
const ruleFetcher = self.RuleFetcher.create();

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
// diag-logger.js (repo root shared/, same dual-loading story) — must load
// after local-storage.js (its own persistence uses self.LocalStorage).
// TEMP (2026-09-14): pulled out into its own file — see that file's own
// comment — specifically so it's easy to find/control (DiagLogger.dump()/
// .clear()/.setEnabled(false) from the background console) independent of
// whatever else is being edited in this file.
if (typeof importScripts === 'function' && !self.DiagLogger) {
  importScripts('diag-logger.js');
}
const _diagLog = (level, msg, data) => self.DiagLogger[level](msg, data);
// session-storage.js (repo root shared/, same dual-loading story) — must
// load AFTER browser-compat.js (needs self.EXT_SESSION_STORAGE) and
// local-storage.js (its own local fallback uses self.LocalStorage), and
// before any of this file's own top-level code touches self.SessionStorage.
if (typeof importScripts === 'function' && !self.SessionStorage) {
  importScripts('session-storage.js');
}
// focus-mode.js (repo root shared/, same dual-loading story) — must load
// AFTER local-storage.js (its own storage reads/writes go through
// self.LocalStorage) and before any of this file's own top-level code
// touches self.FocusMode. See that file's own header comment for the full
// design (Pomodoro phase state machine, session stats/streak, per-site
// daily time-limit tracking) — everything NEW in Focus Mode lives there by
// explicit request, not piled into this already-large file.
if (typeof importScripts === 'function' && !self.FocusMode) {
  importScripts('focus-mode.js');
}
const {
  RULES_REMOTE_URL,
  RULES_LOCAL_PATH,
  RULES_CACHE_TEXT_KEY,
  RULES_CACHE_TIME_KEY,
  RULES_CACHE_TTL_MS,
  SITE_CONFIG_HOST_CACHE_KEY,
  SITE_CONFIG_GLOBAL_CACHE_KEY,
  NETWORK_BLOCK_MATCHER_CACHE_KEY,
  MALWARE_PATH_MATCHER_CACHE_KEY,
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
// fix that specific case, but it's the more standard call to make and
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

// Shared domain-vs-path condition split for buildQueryStripRules/
// buildNetworkRedirectRules below (previously hand-duplicated in both — the
// latter's own comment already noted "same domain-vs-path condition split
// as buildQueryStripRules above" without ever actually extracting it;
// consolidated here 2026-09-15). A pattern that's a CLEAN bare domain (no
// '/', no other network-pattern syntax) becomes requestDomains; anything
// else becomes a `||pattern` urlFilter — including a pattern with NO '/' at
// all, e.g. "static.6cloud.fr^*.mp4" ('^' separator + '*' wildcard, no path
// segment). Live-confirmed bug (2026-09-24, AdGuard French filter list):
// this used to gate the urlFilter attempt on pattern.indexOf('/') === -1
// alone — that '/' check is only a valid SHORTCUT for "definitely not a
// bare domain," never a reliable test for "definitely IS one." A pattern
// with '^'/'*' but no '/' failed DOMAIN_PATTERN_RE (correctly — it isn't a
// domain) and returned null right there, never even attempting the
// urlFilter path it would have converted to cleanly. Silently dropped the
// entry as "malformed" when it wasn't. Now DOMAIN_PATTERN_RE decides
// on its own whether the WHOLE pattern is a clean domain, independent of
// '/' — an actual bare domain still can't contain '/' anyway, so this
// changes nothing for the genuinely-a-domain case, only rescues the
// no-slash-but-not-a-domain case that used to be dropped.
// Returns null only when NEITHER interpretation works — caller should
// `continue` past that entry entirely rather than guess at what was meant
// (same "don't guess, drop it" rule every other builder in this file uses).
function _buildDomainOrUrlFilterCondition(pattern) {
  if (DOMAIN_PATTERN_RE.test(pattern)) {
    return { requestDomains: [pattern.toLowerCase()] };
  }
  const urlFilter = '||' + pattern;
  if (!_isValidUrlFilter(urlFilter)) return null; // would reject the WHOLE updateDynamicRules() call
  return { urlFilter };
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
    const domainOrUrl = _buildDomainOrUrlFilterCondition(hostPath);
    if (!domainOrUrl) continue; // malformed — don't guess, drop it
    const condition = {
      resourceTypes: parts[2] === 'doc' ? ['main_frame'] : QUERY_STRIP_RESOURCE_TYPES,
      ...domainOrUrl,
    };
    rules.push({
      id: id++,
      priority: 1,
      action: { type: 'redirect', redirect: { transform: { queryTransform: { removeParams: params } } } },
      condition,
    });
  }
  return rules;
}

// network_redirect_rules entries: "urlPattern resourceName [resourceType]" —
// same domain-vs-path condition split as buildQueryStripRules above (now
// shared via _buildDomainOrUrlFilterCondition), but the action is a
// static-resource redirect (_resolveRedirectResourceName/_redirectAction)
// instead of a query-param strip. resourceName not resolving to a real
// shipped file (unknown alias, or a name that maps to a file this extension
// doesn't actually have) drops the whole entry — same "don't guess" rule as
// everywhere else a filter-syntax modifier can't be confidently honored.
// The optional 3rd field (2026-09-11) is an explicit DNR resourceType,
// present whenever _abpParseFile could derive exactly one from the source
// rule's own options (e.g. $image,redirect=...) — omitted, this still
// defaults to 'script' same as every entry did before this field existed
// (real-world redirect= rules overwhelmingly ARE script, hence the default;
// entries persisted before this field shipped are just 2 fields and behave
// identically to before).
function buildNetworkRedirectRules(entries, startId) {
  const rules = [];
  let id = startId;
  for (const entry of entries) {
    const parts = String(entry || '').trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pattern = parts[0];
    const file = _resolveRedirectResourceName(parts[1]);
    if (!file) continue;
    const resourceType = parts[2] && ABP_RESOURCE_TYPE_VALUES.has(parts[2]) ? parts[2] : 'script';
    const domainOrUrl = _buildDomainOrUrlFilterCondition(pattern);
    if (!domainOrUrl) continue; // malformed — don't guess, drop it
    const condition = { resourceTypes: [resourceType], ...domainOrUrl };
    // priority 2, not 1 (2026-09-11): Chrome's own documented same-priority
    // tie-break order is allow > block > redirect — at priority 1 (the same
    // level buildPatternRules' plain ad/tracker block rules use), a domain
    // that ALSO happens to be in some OTHER enabled source's bulk block list
    // (a real, independently-reported case: static.eclick.vn's bait image
    // matched both this redirect rule AND a separate list's plain block
    // rule) always lost to the block — the redirect target never actually
    // got served, live-verified via DevTools showing "blocked:other" instead
    // of a successful (redirected) load. Priority 2 matches the precedent
    // buildMalwareRulesFromConfig's own redirect-to-warning-page rules
    // already set for "this must win over an ordinary priority-1 block."
    rules.push({ id: id++, priority: 2, action: _redirectAction(file), condition });
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
//
// Chrome DNR requires every domain in initiatorDomains/
// excludedInitiatorDomains/excludedRequestDomains to be plain ASCII
// (punycode for IDN) — a raw Unicode domain (e.g. a $domain= value from a
// region-specific filter list written in the site's own script) rejects the
// WHOLE updateDynamicRules() batch with "cannot have non-ascii characters as
// part of ... key" (live-reported 2026-09-08, once a large enough set of
// Rule Sources was enabled to actually include one). urlFilter/pattern
// already gets this same class of protection via _isValidUrlFilter; this is
// the missing equivalent for the domain-list fields, which took a raw
// comma-split value with no validation at all before this. Uses the
// platform's own URL parser to convert (it already performs IDNA-to-punycode
// normalization as part of normal hostname parsing) rather than a
// hand-rolled punycode implementation; returns null for a domain the parser
// can't turn into a valid ASCII host, so the caller drops just that ONE
// domain — not the whole rule, not the whole batch.
function _domainToAscii(domain) {
  try {
    const host = new URL('http://' + domain).hostname;
    return host && /^[\x00-\x7F]*$/.test(host) ? host : null;
  } catch {
    return null;
  }
}
// Decodes the "types domains denyallow methods thirdParty" 5 trailing
// fields (see _abpEncodeNetworkBlockEntry's own comment for the layout)
// into DNR condition fields — factored out of buildNetworkBlockRules() so
// the wildcard-TLD regexFilter rules buildDomainNetworkBlockRules() builds
// directly (see its own comment, below) decode the exact same 6-field entry
// format identically, instead of a second hand-rolled copy that could drift.
function _buildNetworkBlockDnrConditionFields(condition, typesField, domainsField, denyallowField, methodsField, thirdPartyField) {
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
      const negated = d.charAt(0) === '~';
      const ascii = _domainToAscii(negated ? d.slice(1) : d);
      if (!ascii) continue; // can't represent as ASCII — drop just this one domain, don't guess
      (negated ? exclude : include).push(ascii);
    }
    if (include.length) condition.initiatorDomains = include;
    if (exclude.length) condition.excludedInitiatorDomains = exclude;
  }
  if (denyallowField !== '*') {
    const denyallow = denyallowField.split(',').map(_domainToAscii).filter(Boolean);
    if (denyallow.length) condition.excludedRequestDomains = denyallow;
  }
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
}
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
    _buildNetworkBlockDnrConditionFields(condition, typesField, domainsField, denyallowField, methodsField, thirdPartyField);
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
//
// [host_patterns] keys can take 4 forms (see resolveSiteKey()'s own
// comment): plain domain, wildcard-TLD ("amazon.*"), a '|'-joined bucket of
// either, or a raw regex ("/.../"). A wildcard-TLD token gets its own
// regexFilter-based DNR rule below, built directly (not routed through
// buildNetworkBlockRules() — urlFilter and regexFilter are mutually
// exclusive DNR condition shapes): the host-matching regex source mirrors
// _compileHostPattern()'s own wildcard-TLD branch (escape the base, require
// it at a domain-label boundary, allow anything up to the next '/' for the
// rest of the TLD), concatenated with the SAME path regex source
// _urlFilterToRegExp() already produces for the plain (literal-domain) path.
//
// A raw-regex token is intentionally SKIPPED here — not silently, this is a
// real DNR/RE2 platform limitation, not a "don't bother": regexFilter is
// tested against the WHOLE url string, and RE2 has no lookaround, so a
// host-scoped pattern whose own '^'/'$' anchors were written assuming an
// ISOLATED hostname string (see _compileHostPattern()'s own comment) cannot
// be safely re-anchored once spliced into a larger URL regex — e.g. a
// leading '^' meant "start of host" would instead require matching
// position 0 of the whole URL (before "https://"), which can never succeed,
// and there is no general, non-guessing way to rewrite an arbitrary
// user-authored regex body's anchors to mean something else. Firefox's
// webRequestBlocking engine has no such limitation — buildNetworkBlockComplex()
// tests the host and path as two INDEPENDENT JS regexes (host first, via
// _compileHostPattern(), then path only on a host that already matched),
// never splicing one pattern's source into the other — so raw-regex
// host_patterns keys are fully supported there. See buildNetworkBlockComplex()'s
// own comment for that side.
function buildDomainNetworkBlockRules(parsed, startId) {
  const hostPatterns = parsed.host_patterns || {};
  const entries = [];
  const regexRules = [];
  let id = startId;
  for (const domainKey in hostPatterns) {
    if (!Object.prototype.hasOwnProperty.call(hostPatterns, domainKey)) continue;
    if (domainKey.charAt(0) === '/' && domainKey.length > 1 && domainKey.lastIndexOf('/') > 0) continue; // raw-regex — not safely expressible as one DNR regexFilter, see comment above
    const sectionKey = hostPatterns[domainKey] && hostPatterns[domainKey][0];
    const section = sectionKey && parsed[sectionKey];
    const pathEntries = section && section.network_block_rules;
    if (!pathEntries || !pathEntries.length) continue;
    for (const token of domainKey.split('|').map(s => s.trim()).filter(Boolean)) {
      if (token.slice(-2) === '.*') {
        const base = token.slice(0, -2).replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        for (const pathEntry of pathEntries) {
          const parts = String(pathEntry || '').trim().split(/\s+/);
          if (parts.length !== 6) continue; // malformed — don't guess, drop it
          const [path, typesField, domainsField, denyallowField, methodsField, thirdPartyField] = parts;
          if (!_isValidUrlFilter(path)) continue; // would reject the WHOLE updateDynamicRules() call
          let pathRegexSource;
          try {
            pathRegexSource = _urlFilterToRegExp(path).source;
          } catch (e) {
            _diagLog('warn', 'buildDomainNetworkBlockRules: skipped malformed wildcard-TLD entry', { token, path, error: e && (e.message || e) });
            continue;
          }
          const regexFilter = '^[a-zA-Z][a-zA-Z0-9+.-]*:\\/\\/([^\\/]*\\.)?' + base + '\\.[^\\/]*' + pathRegexSource;
          const condition = { regexFilter };
          _buildNetworkBlockDnrConditionFields(condition, typesField, domainsField, denyallowField, methodsField, thirdPartyField);
          regexRules.push({ id: id++, priority: 1, action: { type: 'block' }, condition });
        }
        continue;
      }
      for (const pathEntry of pathEntries) {
        const parts = String(pathEntry || '').trim().split(/\s+/);
        if (parts.length !== 6) continue; // malformed — don't guess, drop it (buildNetworkBlockRules re-validates anyway)
        entries.push([token + parts[0], ...parts.slice(1)].join(' '));
      }
    }
  }
  return buildNetworkBlockRules(entries, id).concat(regexRules);
}

// NETWORK_BLOCK_MATCHER entries carry a compiled RegExp (`regex`) plus
// Set/Map fields (resourceTypes, initiatorDomains, ...) — none of those
// round-trip through JSON.stringify/parse as-is (a RegExp serializes to
// `{}`, a Set/Map to `{}` too). Convert to/from plain arrays + the regex's
// SOURCE string. Used only by _saveMatcherCacheToLocal()/
// _loadMatcherCacheFromLocal()'s NETWORK_BLOCK_MATCHER_CACHE_KEY entry (a
// per-matcher chrome.storage.local cache, restored 2026-09-08 in a narrower
// form after the earlier whole-ensureRuleDefinitionsLoaded()-output session
// cache was removed for being too big to fit chrome.storage.session's fixed
// 10MB cap — see _saveMatcherCacheToLocal's own comment for why only this
// matcher and MALWARE_PATH_MATCHER, not everything, get persisted now).
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
// Builds the option fields (resourceTypes/initiatorDomains/excludedRequestDomains/
// requestMethods/domainType) shared by every NETWORK_BLOCK_MATCHER entry —
// factored out of buildNetworkBlockMatcher() so both the literal-domain
// (combined domain+path regex) and complex (path-only regex, host matched
// separately — see buildNetworkBlockMatcher()'s own comment on
// NETWORK_BLOCK_COMPLEX) branches build entries identically, only differing
// in how `regex` itself gets constructed.
function _buildNetworkBlockEntryOptions(entry, typesField, domainsField, denyallowField, methodsField, thirdPartyField) {
  if (typesField !== '*') {
    const tokens = typesField.split(',');
    if (tokens[0].charAt(0) === '~') entry.excludedResourceTypes = new Set(tokens.map(t => t.slice(1)));
    else entry.resourceTypes = new Set(tokens);
  }
  if (domainsField !== '*') {
    const include = new Map(), exclude = new Map();
    // No DNR "reject the whole batch" risk on this JS-matching path
    // (Firefox webRequestBlocking, not native declarativeNetRequest),
    // but a raw Unicode domain here would still just silently never
    // match anything — real request hostnames are always reported in
    // ASCII/punycode form — so normalize the same way buildNetworkBlockRules
    // does, for the same underlying reason (a $domain= value can be
    // written in the site's own script).
    for (const d of domainsField.split(',')) {
      const negated = d.charAt(0) === '~';
      const ascii = _domainToAscii(negated ? d.slice(1) : d);
      if (!ascii) continue;
      (negated ? exclude : include).set(ascii, true);
    }
    if (include.size) entry.initiatorDomains = include;
    if (exclude.size) entry.excludedInitiatorDomains = exclude;
  }
  if (denyallowField !== '*') {
    const denyallow = denyallowField.split(',').map(_domainToAscii).filter(Boolean);
    if (denyallow.length) entry.excludedRequestDomains = new Map(denyallow.map(d => [d, true]));
  }
  if (methodsField !== '*') {
    const include = [], exclude = [];
    for (const m of methodsField.split(',')) { if (m.charAt(0) === '~') exclude.push(m.slice(1)); else include.push(m); }
    if (include.length) entry.requestMethods = new Set(include.map(m => m.toLowerCase()));
    if (exclude.length) entry.excludedRequestMethods = new Set(exclude.map(m => m.toLowerCase()));
  }
  if (thirdPartyField === '1') entry.domainType = 'thirdParty';
  else if (thirdPartyField === '0') entry.domainType = 'firstParty';
}

// `[host_patterns]` supports 4 left-hand-side forms (see resolveSiteKey()'s
// own comment): a plain domain, a wildcard-TLD ("amazon.*"), a `|`-joined
// bucket of either, and a raw regex ("/.../"). This — and buildDomainNetworkBlockRules()'s
// DNR equivalent — used to treat every domainKey as a literal domain (or
// bucket of literal domains) regardless of form: a wildcard-TLD key fed `*`
// straight into _urlFilterToRegExp(), which treats it as its OWN unrelated
// "any characters" wildcard (so "amazon.*" ended up matching
// "amazonEVIL.com" too, not just real TLD variants — an over-match bug); a
// raw-regex key got its whole regex-source string (parens, anchors,
// sometimes literal '|') concatenated as if it were a domain, compiling
// into a regex that can never match any real URL (a silent no-op). Only
// LITERAL-domain keys are handled here now — wildcard-TLD/raw-regex keys
// are handled by the separate buildNetworkBlockComplex() below instead
// (kept apart so this function's cache — see its caller in
// ensureRuleDefinitionsLoaded() — still only covers the expensive part;
// the complex list is cheap enough to always rebuild fresh).
function buildNetworkBlockMatcher(parsed) {
  const hostPatterns = parsed.host_patterns || {};
  const matcher = new Map();
  for (const domainKey in hostPatterns) {
    if (!Object.prototype.hasOwnProperty.call(hostPatterns, domainKey)) continue;
    if (domainKey.charAt(0) === '/' && domainKey.length > 1 && domainKey.lastIndexOf('/') > 0) continue; // raw-regex — buildNetworkBlockComplex()'s job
    const sectionKey = hostPatterns[domainKey] && hostPatterns[domainKey][0];
    const section = sectionKey && parsed[sectionKey];
    const pathEntries = section && section.network_block_rules;
    if (!pathEntries || !pathEntries.length) continue;
    for (const token of domainKey.split('|').map(s => s.trim()).filter(Boolean)) {
      if (token.slice(-2) === '.*') continue; // wildcard-TLD — buildNetworkBlockComplex()'s job
      for (const pathEntry of pathEntries) {
        const parts = String(pathEntry || '').trim().split(/\s+/);
        if (parts.length !== 6) continue; // malformed — don't guess, drop it
        const [path, typesField, domainsField, denyallowField, methodsField, thirdPartyField] = parts;
        const urlFilter = '||' + token + path;
        if (!_isValidUrlFilter(urlFilter)) continue;
        // _urlFilterToRegExp() can still throw on a genuinely malformed
        // pattern despite _isValidUrlFilter()'s check above — real
        // large-scale merged content (EasyList/EasyPrivacy/Fanboy-Social/
        // ...) is exactly the kind of external data likely to have an
        // occasional bad entry. An uncaught throw here used to abort the
        // ENTIRE matcher build for every other domain too, and (before the
        // atomic-commit fix in ensureRuleDefinitionsLoaded()) could leave
        // HTML_FILTER_MATCHER stuck empty for the rest of the background's
        // lifetime — live-reported 2026-09-14. Skip just this one entry
        // instead.
        let regex;
        try {
          regex = _urlFilterToRegExp(urlFilter);
        } catch (e) {
          _diagLog('warn', 'buildNetworkBlockMatcher: skipped malformed entry', { urlFilter, error: e && (e.message || e) });
          continue;
        }
        const entry = { regex };
        _buildNetworkBlockEntryOptions(entry, typesField, domainsField, denyallowField, methodsField, thirdPartyField);
        if (!matcher.has(token)) matcher.set(token, []);
        matcher.get(token).push(entry);
      }
    }
  }
  return matcher;
}

// The wildcard-TLD/raw-regex sibling of buildNetworkBlockMatcher() above —
// see its comment for why these forms need separate handling. Reuses
// _compileHostPattern() (this file's single existing, tested
// implementation of these exact matching semantics, otherwise only used by
// resolveSiteKey()) rather than re-deriving wildcard/regex matching a third
// time. Returned entries can't be keyed by a single literal domain — no
// fixed domain-suffix to walk to — so NETWORK_BLOCK_COMPLEX is a flat list,
// tested by host directly in _networkBlockRequestHandler(). Each entry's
// regex is built from the PATH ONLY (no domain prefix): the host match
// already gatekeeps which requests even reach it, so the path regex just
// needs to identify the right path on a request whose host is already
// confirmed to match. Expected to stay tiny (only ever populated by a
// hand-written rule/site-rules.txt or customRulesText entry — the ABP→
// native converter never emits wildcard/regex host_patterns keys), so —
// unlike buildNetworkBlockMatcher() — this is never cached, just rebuilt
// fresh on every real ensureRuleDefinitionsLoaded() build regardless of
// whether that build's plain matcher was itself a cache hit or miss.
function buildNetworkBlockComplex(parsed) {
  const hostPatterns = parsed.host_patterns || {};
  const complex = [];
  for (const domainKey in hostPatterns) {
    if (!Object.prototype.hasOwnProperty.call(hostPatterns, domainKey)) continue;
    const sectionKey = hostPatterns[domainKey] && hostPatterns[domainKey][0];
    const section = sectionKey && parsed[sectionKey];
    const pathEntries = section && section.network_block_rules;
    if (!pathEntries || !pathEntries.length) continue;
    // Raw regex form (/body/flags) is the WHOLE key and must never be split
    // on '|' — its body can (and often does, e.g. "(^|\.)") contain a
    // literal '|' as regex alternation, not a domain separator — same
    // reasoning _buildHostPatternIndex() already documents for
    // resolveSiteKey()'s own indexing.
    const isRegexForm = domainKey.charAt(0) === '/' && domainKey.length > 1 && domainKey.lastIndexOf('/') > 0;
    const tokens = isRegexForm ? [domainKey] : domainKey.split('|').map(s => s.trim()).filter(Boolean);
    for (const token of tokens) {
      if (!isRegexForm && token.slice(-2) !== '.*') continue; // literal domain — buildNetworkBlockMatcher()'s job
      const entries = [];
      for (const pathEntry of pathEntries) {
        const parts = String(pathEntry || '').trim().split(/\s+/);
        if (parts.length !== 6) continue; // malformed — don't guess, drop it
        const [path, typesField, domainsField, denyallowField, methodsField, thirdPartyField] = parts;
        if (!_isValidUrlFilter(path)) continue;
        let regex;
        try {
          regex = _urlFilterToRegExp(path);
        } catch (e) {
          _diagLog('warn', 'buildNetworkBlockComplex: skipped malformed entry', { token, path, error: e && (e.message || e) });
          continue;
        }
        const entry = { regex };
        _buildNetworkBlockEntryOptions(entry, typesField, domainsField, denyallowField, methodsField, thirdPartyField);
        entries.push(entry);
      }
      if (entries.length) {
        const test = _compileHostPattern(token);
        if (test) complex.push({ test, entries });
      }
    }
  }
  return complex;
}

// Firefox-only: HTML_FILTER_MATCHER's build step. Reuses direct_hide_
// selectors directly (2026-09-03 — was a separate opt-in `html_filter_
// selectors` key at first; folded into direct_hide_selectors so a site
// only needs ONE curated selector list, not two kept in sync by hand).
// Buffering+reparsing a whole HTML response body is a real memory/latency
// cost — worth it for a site whose ad markup is confirmed server-rendered
// directly into the initial HTML response, so no amount of CSS-injection
// speed can ever prevent the flash (the same reasoning behind a dedicated
// HTML-filter syntax elsewhere in the ad-blocking space) — but paying it
// for every ABP-converted "bucket" section
// (one `domainA|domainB|...|domainN = sitekey` line covering hundreds of
// loosely related sites, the shape EasyList/EasyPrivacy/region lists
// produce by the thousand once several large Rule Sources are enabled) is
// a real regression: it would apply the buffer+reparse cost to essentially
// every site the user visits, not the small hand-picked set this feature
// was built for. Only single-domain host_patterns entries — i.e. a
// DEDICATED, curated section for exactly that one site (`[tinhte]`,
// `[vnexpress]`, ...) — are eligible; a `|`-joined bucket key is skipped
// entirely regardless of what its section's direct_hide_selectors contain.
// Same domain -> sectionKey resolution as buildNetworkBlockMatcher above,
// but the VALUE here is just the plain selector array itself — no
// per-entry options to compile, unlike NETWORK_BLOCK_MATCHER's RegExp-bearing
// entries. Raw-regex ("/.../") and wildcard-TLD ("domain.*")
// host_patterns forms are skipped too — same reasoning buildNetworkBlockMatcher
// itself doesn't need for its own purpose, kept simple here too.
function buildHtmlFilterMatcher(parsed) {
  const hostPatterns = parsed.host_patterns || {};
  const matcher = new Map();
  for (const domainKey in hostPatterns) {
    if (!Object.prototype.hasOwnProperty.call(hostPatterns, domainKey)) continue;
    if (domainKey.charAt(0) === '/') continue; // raw-regex form — skip
    if (domainKey.indexOf('|') !== -1) continue; // bucket key (shared by many domains) — skip, dedicated single-domain entries only
    const domain = domainKey.trim().toLowerCase();
    if (!domain || domain.slice(-2) === '.*') continue; // wildcard-TLD — skip
    const sectionKey = hostPatterns[domainKey] && hostPatterns[domainKey][0];
    const section = sectionKey && parsed[sectionKey];
    const selectors = section && section.direct_hide_selectors;
    if (!selectors || !selectors.length) continue;
    matcher.set(domain, selectors);
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
// Array<{ test: (host)=>boolean, entries: [...] }> — the wildcard-TLD/raw-
// regex sibling of NETWORK_BLOCK_MATCHER (see buildNetworkBlockMatcher()'s
// own comment): entries that can't be keyed by a single literal domain, so
// there's no domain-suffix to walk in a Map. Tested by a short linear scan
// in _networkBlockRequestHandler() — expected to stay tiny (only ever
// populated by a hand-written rule/site-rules.txt or customRulesText entry,
// never by the ABP→native converter).
let NETWORK_BLOCK_COMPLEX = [];
// Map<domain, Array<RegExp>> — much simpler shape than NETWORK_BLOCK_MATCHER
// since remoteMalwarePathPatterns entries carry no options at all (no
// resourceTypes/domain=/method=/thirdParty — see buildRemoteMalwareRules'
// own comment: "one urlFilter per rule ... covering EVERY resource type in
// a single plain block").
let MALWARE_PATH_MATCHER = new Map();
// Map<domain, Array<string selector>> for the HTML stream-filter (Firefox
// only — see buildHtmlFilterMatcher's own comment further down and
// _htmlFilterRequestHandler's registration comment). Built unconditionally
// regardless of browser (cheap, just Map assignments) but only ever
// consulted where _hasHtmlStreamFilter() gates the listener's registration.
let HTML_FILTER_MATCHER = new Map();

// MALWARE_PATH_MATCHER's local cache counterpart to _serializeMatcherMap/
// _rehydrateMatcherMap above — much simpler since entries here are bare
// RegExp with no options fields to round-trip.
function _serializeRegexMatcherMap(map) {
  const out = {};
  for (const [domain, regexes] of map) out[domain] = regexes.map(r => r.source);
  return out;
}
function _rehydrateRegexMatcherMap(obj) {
  const map = new Map();
  for (const domain in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, domain)) map.set(domain, obj[domain].map(s => new RegExp(s)));
  }
  return map;
}

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
    // See buildNetworkBlockMatcher()'s matching comment — pathPatterns here
    // comes from a real external threat-intel feed (URLhaus-style), exactly
    // the kind of data likely to have an occasional malformed entry. Skip
    // just this one instead of letting the whole matcher build fail.
    let regex;
    try {
      regex = _urlFilterToRegExp(urlFilter);
    } catch (e) {
      _diagLog('warn', 'buildMalwarePathMatcher: skipped malformed entry', { urlFilter, error: e && (e.message || e) });
      continue;
    }
    if (!matcher.has(key)) matcher.set(key, []);
    matcher.get(key).push(regex);
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

// Live-reported 2026-09-14 ("469 quy tắc" instead of ~16,889): this used to
// be registered/unregistered conditionally (_updateNetworkBlockListener,
// called from inside buildActiveRulesFromStorage()'s async chain), so real
// protection from this tier depended entirely on that chain having actually
// run at least once since the last script (re)start — the SAME single
// top-level `applyNetworkRules()` call already fragile enough to have been
// silently lost 5-6+ times this session (IDE/editor churn commenting it
// out). When that call was missing, this listener was simply never
// registered at all: not just a wrong popup count, but zero real blocking
// from network_block_rules/remoteMalwarePathPatterns' path-scoped tier,
// silently, with no error anywhere. Chrome never has this failure mode at
// all — its equivalent (declarativeNetRequest dynamic rules) is persisted
// by the BROWSER itself across every service-worker restart, so there is
// nothing that ever needs to "re-register" after a respawn there.
// _htmlFilterRequestHandler already established the right pattern for this
// exact problem (see its own registration comment) — mirrored here:
// registered ONCE, unconditionally, synchronously at module top-level
// (below), never toggled on/off again, with enabled/blockAds/blockMalware/
// pausedDomains/allowedDomains all re-checked on every call instead. Even
// if a future edit loses the module-load `applyNetworkRules()` call again,
// this listener is still attached and will start blocking the moment
// NETWORK_BLOCK_MATCHER/MALWARE_PATH_MATCHER/NETWORK_BLOCK_COMPLEX get
// populated by whatever DOES eventually trigger a build (message handlers
// already call applyNetworkRules() independently in many places) — no
// longer an all-or-nothing dependency on one fragile line.
function _networkBlockRequestHandler(details) {
  if (!_settingsCache.enabled) return {};
  let host;
  try { host = new URL(details.url).hostname.toLowerCase(); } catch { return {}; }
  // Mirrors the DNR pause/allow tier (pauseAllowRules' allowAllRequests
  // rules) this handler has no visibility into otherwise — that DNR rule
  // still runs unconditionally on every browser (including Firefox) for
  // every OTHER tier, but declarativeNetRequest and this JS listener
  // evaluate completely independently, so a request this handler cancels
  // never even reaches DNR's own allow check. For a document request
  // itself (main_frame/sub_frame — matching pauseAllowRules' own
  // resourceTypes), the relevant site IS the request's own host; for every
  // other resource type (the actual ad/tracker/malware-path requests this
  // handler exists to catch), it's the INITIATING document's host instead
  // — pausedDomains/allowedDomains store the SITE the user paused, not the
  // third-party resource host being requested. Domain-suffix walk (not an
  // exact match) to mirror requestDomains' own subdomain-inclusive
  // matching (Chrome docs: a requestDomains entry matches that domain AND
  // its subdomains).
  const isDocumentRequest = details.type === 'main_frame' || details.type === 'sub_frame';
  const siteHost = isDocumentRequest ? host : _requestInitiatorHost(details);
  if (siteHost && (_walkDomainMatches(_settingsCache.pausedDomains, siteHost) || _walkDomainMatches(_settingsCache.allowedDomains, siteHost))) {
    return {};
  }
  let h = host;
  while (h) {
    if (_settingsCache.blockAds) {
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
    }
    if (_settingsCache.blockMalware) {
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
    }
    const dot = h.indexOf('.');
    if (dot === -1) break;
    h = h.slice(dot + 1);
  }
  // Wildcard-TLD / raw-regex [host_patterns] forms (e.g. "amazon.*",
  // "/(^|\.)fmovies[a-z0-9-]*\./") — see buildNetworkBlockComplex()'s own
  // comment. No domain-suffix Map lookup is possible for these (there's no
  // single literal domain), so a short linear scan against the ORIGINAL
  // full host — expected to stay tiny (hand-written entries only).
  if (_settingsCache.blockAds) {
    for (const bucket of NETWORK_BLOCK_COMPLEX) {
      if (!bucket.test(host)) continue;
      for (const entry of bucket.entries) {
        if (_matchesNetworkBlockEntry(entry, details, host)) {
          _incrementTabBlocked(details.tabId, 1);
          updateDailyStats({ blocked: 1, ads: 1, trackers: 0, malware: 0 });
          return { cancel: true };
        }
      }
    }
  }
  return {};
}

// See this function's own comment above for why this is unconditional and
// permanent — no _updateNetworkBlockListener add/removeListener toggle
// anymore (removed 2026-09-14), matching _htmlFilterRequestHandler's
// already-established registration pattern below.
if (_hasWebRequestBlocking()) {
  EXT.webRequest.onBeforeRequest.addListener(_networkBlockRequestHandler, { urls: ['<all_urls>'] }, ['blocking']);
}

// ── HTML stream filter (Firefox only) ───────────────────────────────
// For sites whose ad markup is server-rendered directly into the initial
// HTML response (confirmed via view-source, tinhte.vn being the first
// case) — no amount of cosmetic-CSS speed can ever prevent the flash for
// this category, since the browser paints from the raw HTML bytes before
// ANY extension code runs at all. browser.webRequest.filterResponseData()
// is a Firefox-exclusive StreamFilter API (not available in Chrome/Edge —
// gated below) that lets an extension rewrite a response's bytes before
// the browser ever parses them.
//
// A separate, deliberately distinct syntax for THIS kind of rule (as
// opposed to a regular ## CSS-hide selector) could fully remove the matched
// DOM node (node.remove()) instead of just hiding it — but for a real site
// like tinhte.vn, live-verified, the actually-effective approach leaves the
// ad's <ins>/wrapper element in place, just display:none'd (plus a
// nostif-style anti-detection scriptlet), rather than removing it. Rather
// than reimplementing removal (which needs a real DOM — DOMParser().parseFromString
// + querySelectorAll + reserialize — and this MV3 background context's
// DOMParser/Gecko :has()/serializer semantics were never independently
// verified against the real thing), this applies the same strategy that
// visible behavior implies is the right call for this site: inject a
// <style> block into the raw response text instead. A CSS rule is harmless
// even where it matches
// nothing on the page, so there's no need to parse the document at all to
// know WHETHER something matched — just splice one <style> block in right
// after the opening <head> tag, string-only, no DOM involved. It still
// wins the same race removal would (the rule is live from the very first
// bytes the browser's own renderer sees, long before it gets to painting
// any matching element), while leaving the element itself in the DOM —
// safer for any page script that expects it to still exist, and exactly
// the visibility profile this project's own direct_hide_selectors CSS path
// already has everywhere else.
function _hasHtmlStreamFilter() {
  return !!(EXT.webRequest && typeof EXT.webRequest.filterResponseData === 'function');
}

function _htmlFilterSelectorsForHost(host) {
  let h = host;
  while (h) {
    const sel = HTML_FILTER_MATCHER.get(h);
    if (sel) return sel;
    const dot = h.indexOf('.');
    if (dot === -1) break;
    h = h.slice(dot + 1);
  }
  return null;
}

// Buffer-then-filter, not incremental streaming (simpler, and matches the
// StreamFilter API's own ondata/onstop pattern) — a whole HTML document is small
// enough in practice that the extra latency of waiting for the full body
// before first paint is an accepted trade-off for correctness (an
// incremental string search risks splitting the <head> tag itself across a
// chunk boundary). HTML_FILTER_MAX_BYTES is a hard size guard: a
// Content-Length pre-check happens at the call site (_htmlFilterRequestHandler,
// onHeadersReceived) as a cheap first filter, and this function's own
// caller (_attachHtmlFilter's ondata) re-checks against the REAL
// accumulated byte count as a backstop against a missing or lying header.
const HTML_FILTER_MAX_BYTES = 5 * 1024 * 1024; // 5MB

// Returns the replacement HTML string, or null if there's no <head> tag to
// anchor the injected <style> on — null is the ONE fallback signal the
// caller needs to know "write the original bytes back unchanged" (see
// _attachHtmlFilter's onstop). Never throws — pure string operations.
function _applyHtmlFilterSelectors(html, selectors) {
  const headMatch = /<head[^>]*>/i.exec(html);
  if (!headMatch) return null;
  const css = selectors.map(sel => `${sel}{display:none!important}`).join('');
  const insertAt = headMatch.index + headMatch[0].length;
  return html.slice(0, insertAt) + `<style>${css}</style>` + html.slice(insertAt);
}

function _concatHtmlFilterChunks(chunks) {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(new Uint8Array(c), offset); offset += c.byteLength; }
  return out;
}

// Safety contract: always either write() the replacement bytes or write()
// the untouched original bytes, then close() — NEVER call disconnect()
// after ondata has already delivered bytes to us (per MDN, that silently
// drops whatever was buffered-but-not-yet-written, truncating the page).
// `aborted` (the running-byte-count guard tripping mid-stream) switches to
// pure passthrough for the REST of the stream rather than dropping
// anything — every chunk from that point on, including the one that
// tripped the guard, is written straight through immediately.
function _attachHtmlFilter(requestId, selectors) {
  let filter;
  try { filter = EXT.webRequest.filterResponseData(requestId); }
  catch (e) {
    _diagLog('error', 'HTML filter: filterResponseData() THREW (never attached)', { requestId, error: e && (e.message || e) });
    return;
  }
  _diagLog('log', 'HTML filter: attached', { requestId, selectorCount: selectors.length });
  let chunks = [];
  let totalBytes = 0;
  let aborted = false;
  filter.ondata = (event) => {
    if (aborted) { filter.write(event.data); return; }
    totalBytes += event.data.byteLength;
    if (totalBytes > HTML_FILTER_MAX_BYTES) {
      aborted = true;
      _diagLog('warn', 'HTML filter: ABORTED mid-stream (exceeded HTML_FILTER_MAX_BYTES) — passthrough for the rest', { requestId, totalBytes, HTML_FILTER_MAX_BYTES });
      for (const chunk of chunks) filter.write(chunk);
      chunks = [];
      filter.write(event.data);
      return;
    }
    chunks.push(event.data);
  };
  filter.onstop = () => {
    if (aborted) { filter.close(); return; } // already streamed through in ondata
    try {
      const bytes = _concatHtmlFilterChunks(chunks);
      const html = new TextDecoder().decode(bytes);
      const replacement = _applyHtmlFilterSelectors(html, selectors);
      filter.write(new TextEncoder().encode(replacement !== null ? replacement : html));
      _diagLog('log', 'HTML filter: onstop — filtered and wrote', { requestId, htmlLength: html.length, modified: replacement !== null, replacementLength: replacement === null ? null : replacement.length });
    } catch (e) {
      // Any failure here — write back the untouched original bytes rather
      // than dropping them (see the contract note above).
      _diagLog('error', 'HTML filter: onstop THREW — writing back UNTOUCHED original bytes', { requestId, error: e && (e.message || e) });
      for (const chunk of chunks) filter.write(chunk);
    }
    filter.close();
  };
  filter.onerror = () => {
    _diagLog('error', 'HTML filter: onerror fired (stream aborted by the browser, e.g. request cancelled/redirected)', { requestId, filterStatus: filter.status });
    try { filter.close(); } catch { /* already closed/disconnected */ }
  };
}

// This rewrites real page markup — a much more visible effect than
// _networkBlockRequestHandler's outright cancel, which is why (unlike that
// handler) this one DOES check enabled/blockAds/pausedDomains/
// allowedDomains directly on every call rather than through a toggled
// registration: pausing a domain (or flipping blockAds) must restore the
// original page on the very next reload, not just on the next full rules
// rebuild — and per-request state checks are cheap enough (a few Set/
// property reads) that gating registration itself buys nothing but an
// earlier chance to miss the very first navigation (see below).
function _htmlFilterRequestHandler(details) {
  if (details.type !== 'main_frame' && details.type !== 'sub_frame') return {};
  if (!_settingsCache.enabled || !_settingsCache.blockAds) {
    _diagLog('log', 'HTML filter: SKIPPED (extension disabled or blockAds off)', { url: details.url, enabled: _settingsCache.enabled, blockAds: _settingsCache.blockAds });
    return {};
  }
  let host;
  try { host = new URL(details.url).hostname.toLowerCase(); } catch { return {}; }
  if (_settingsCache.pausedDomains.has(host) || _settingsCache.allowedDomains.has(host)) {
    _diagLog('log', 'HTML filter: SKIPPED (host paused/allowed)', { host, url: details.url });
    return {};
  }
  const selectors = _htmlFilterSelectorsForHost(host);
  if (!selectors) {
    _diagLog('log', 'HTML filter: SKIPPED (no selectors for this host — HTML_FILTER_MATCHER empty or no match)', { host, url: details.url, HTML_FILTER_MATCHER_size: HTML_FILTER_MATCHER.size });
    return {};
  }
  const cl = (details.responseHeaders || []).find(h => h.name.toLowerCase() === 'content-length');
  if (cl && Number(cl.value) > HTML_FILTER_MAX_BYTES) {
    _diagLog('warn', 'HTML filter: SKIPPED (Content-Length exceeds HTML_FILTER_MAX_BYTES)', { host, url: details.url, contentLength: cl.value, HTML_FILTER_MAX_BYTES });
    return {};
  }
  _diagLog('log', 'HTML filter: request matched, attaching', { host, url: details.url, type: details.type, selectorCount: selectors.length });
  _attachHtmlFilter(details.requestId, selectors);
  return {};
}

// Registered ONCE, unconditionally, right here at module top-level — not
// gated behind ensureRuleDefinitionsLoaded()/buildActiveRulesFromStorage()
// the way HTML_FILTER_MATCHER's own CONTENT is built. The handler above
// already re-checks enabled/blockAds/pausedDomains/allowedDomains on every
// call, and _htmlFilterSelectorsForHost() just reads whatever
// HTML_FILTER_MATCHER currently holds (empty Map until the first real
// build finishes, same as any other in-flight state) — so there's nothing
// registration-time needs to wait for. Registering here means the browser
// can never be mid-navigation with this listener not yet attached: JS is
// single-threaded, so this line runs to completion before the event loop
// gets a chance to deliver ANY webRequest event, closing what would
// otherwise be a real gap on a cold background-script start (SW/event-page
// just woke up, first navigation races the async rule-build chain — that
// one request would silently skip the stream filter, falling back to
// direct_hide_selectors' CSS-only path, exactly the flash this feature
// exists to prevent).
if (_hasHtmlStreamFilter()) {
  EXT.webRequest.onHeadersReceived.addListener(
    _htmlFilterRequestHandler,
    { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] },
    ['blocking', 'responseHeaders']
  );
}

const parseRuleText = self.RuleParser.parse;

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

// Leaves real headroom under chrome.storage.local's ~10MB default quota
// (no unlimitedStorage permission in either manifest — see
// _saveMatcherCacheToLocal's own comment) for siteRulesCacheText itself,
// which alone has measured ~7MB at real multi-source scale.
const LOCAL_STORAGE_SAFE_LIMIT_BYTES = 9 * 1024 * 1024;

// Generic load/save for the two Firefox-only (webRequestBlocking) matcher
// caches — NETWORK_BLOCK_MATCHER_CACHE_KEY and MALWARE_PATH_MATCHER_CACHE_KEY.
// 2026-09-08: this project previously cached the ENTIRE
// ensureRuleDefinitionsLoaded() output (DEFAULT_RULES, MALWARE_RULES, both
// matchers, ...) in chrome.storage.session, keyed by a content hash —
// removed the same day because at "every Rule Source enabled" scale it
// measured ~20.69MB even compressed, over storage.session's fixed ~10MB cap
// (unlike storage.local, unlimitedStorage can't lift that one). Restored
// here in a narrower form: ONLY the two matchers that actually do per-entry
// RegExp compilation (NETWORK_BLOCK_MATCHER, MALWARE_PATH_MATCHER) are
// persisted — HTML_FILTER_MATCHER and the DNR-array builders (DEFAULT_RULES
// etc.) are cheap Map/array copies with no regex compile, not worth caching
// — and in chrome.storage.local instead of .session, since unlimitedStorage
// CAN raise that quota if ever needed. No such permission is requested here
// though: instead, every write is guarded by a real LocalStorage.getBytesInUse()
// check so this can never be the write that pushes storage.local over quota
// (siteRulesCacheText's own write is far more important to protect than this
// purely-a-speed-optimization cache is to keep). A null bytesInUse reading
// (API unavailable, or the call itself failed) is treated as "assume worst
// case" — skip the write — never as "assume empty." Skipping just means that
// cold start rebuilds the matcher from scratch, same as if this cache never
// existed; it never blocks or breaks anything.
// _writeLocalIfWithinQuota — shared guard for any chrome.storage.local write
// that could plausibly grow large enough to risk pushing the whole area over
// quota. Measures the payload's own byte size, checks it against current
// usage via LocalStorage.getBytesInUse(), and only writes if there's room.
//
// `onUnknownBytesInUse` controls what happens when getBytesInUse() itself
// returns null — API genuinely unavailable, Firefox's PERMANENT state here
// (see tools/inspect-rule-cache-size.js's own comment), not just an
// occasional failure:
//   'skip'  — treat null as "assume worst case, don't risk it". Right for a
//             pure speed-optimization cache (_saveMatcherCacheToLocal's
//             matcher caches below): skipping just means a cheap rebuild
//             next cold start, never blocks or breaks anything.
//   'write' — attempt the write anyway. Right for setCachedRuleText: a
//             Firefox user has NO other way to ever populate that cache
//             (getBytesInUse() is null there forever, not just sometimes),
//             so 'skip' would permanently disable the one mechanism that
//             avoids a full remote refetch of every Rule Source on every
//             cold start — strictly worse than an unguarded write.
async function _writeLocalIfWithinQuota(payload, logLabel, onUnknownBytesInUse) {
  try {
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload)).length;
    const bytesInUse = await LocalStorage.getBytesInUse();
    if (bytesInUse === null) {
      if (onUnknownBytesInUse === 'skip') {
        _diagLog('warn', logLabel + ' write skipped — bytesInUse unavailable, assuming worst case', { payloadBytes });
        return false;
      }
      // onUnknownBytesInUse === 'write': fall through, attempt the write.
    } else if (bytesInUse + payloadBytes > LOCAL_STORAGE_SAFE_LIMIT_BYTES) {
      _diagLog('warn', logLabel + ' write skipped — would exceed storage.local quota', { bytesInUse, payloadBytes, limit: LOCAL_STORAGE_SAFE_LIMIT_BYTES });
      return false;
    }
    await LocalStorage.set(payload);
    return true;
  } catch (e) {
    _diagLog('error', logLabel + ' write FAILED', { error: e && (e.message || e) });
    return false;
  }
}

async function _loadMatcherCacheFromLocal(storageKey, cacheKey, rehydrateFn) {
  try {
    const { [storageKey]: cached } = await LocalStorage.get(storageKey);
    if (!(cached && cached.key === cacheKey && cached.compressed)) return null;
    const json = await _decompressFromStorage(cached.compressed);
    if (!json) return null;
    return rehydrateFn(JSON.parse(json));
  } catch (e) {
    _diagLog('warn', 'local matcher cache read (' + storageKey + ') failed — falling through to a real build', { error: e && (e.message || e) });
    return null;
  }
}
async function _saveMatcherCacheToLocal(storageKey, cacheKey, serializedObj) {
  const compressed = await _compressForStorage(JSON.stringify(serializedObj));
  await _writeLocalIfWithinQuota({ [storageKey]: { key: cacheKey, compressed } }, 'local matcher cache (' + storageKey + ')', 'skip');
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
  const stored = await _compressForStorage(text);
  await _writeLocalIfWithinQuota({
    [RULES_CACHE_TEXT_KEY]: stored,
    [RULES_CACHE_TIME_KEY]: Date.now(),
  }, 'siteRulesCacheText', 'write');
}

function isFreshRuleCache(entry) {
  return !!(entry && entry.text && entry.time && (Date.now() - entry.time) < RULES_CACHE_TTL_MS);
}

// getDomainPatternRe is a lazy accessor, not the regex itself: DOMAIN_PATTERN_RE
// is declared with `const` further down this file, so passing it by value here
// would throw (temporal dead zone) at load time — a closure defers the read
// until abp-converter.js actually parses a rule, well after that point.
const abpConverter = self.AbpConverter.create({ fetchLocalRuleText, parseRuleText, _resolveRedirectResourceName, _isValidUrlFilter, getDomainPatternRe: () => DOMAIN_PATTERN_RE });
const { ABP_SIMPLE_NETWORK_OPTS_RE, NETWORK_RULE_BUDGET, ABP_RESOURCE_TYPE_VALUES, _abpParseNetworkOptions, _abpEncodeNetworkBlockEntry, _abpSplitNetworkPattern, _abpEmptySkipStats, _maybeConvertAbpText, _looksLikeAbpFormat } = abpConverter;

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
//
// Also appends utils.js's timezoneLangCandidates() (IANA timezone -> region
// language, e.g. Asia/Ho_Chi_Minh -> 'vi') AFTER the language-preference
// candidates — a region proxy for users whose browser UI/content language
// doesn't reflect where they actually are. Appended last, and ONLY here
// (never inside langCandidates() itself), so shared/i18n.js's UI-language
// "Auto" picker — a first-match-wins consumer of langCandidates() — is
// completely unaffected; this only ever adds NEW match possibilities for
// _uiLanguageMatches() below, never changes which candidate wins first.
function _candidateUILanguages() {
  let out = [];
  try { out = langCandidates(); } catch (e) { /* ignore */ }
  try {
    const tzLangs = typeof timezoneLangCandidates === 'function' ? timezoneLangCandidates() : [];
    if (tzLangs && tzLangs.length) out = out.concat(tzLangs);
  } catch (e) { /* ignore */ }
  return out;
}

// True if any candidate language matches a RULES_REMOTE_URL entry's `lang`
// (BCP-47 primary subtag, e.g. 'vi') — exact match or a region variant of
// it ('vi-VN' matches 'vi'). `candidates` defaults to the full merged list
// (language preference + timezone fallback); _autoEnableLangDefaultSources()
// below passes narrower lists to tell a real language-preference match apart
// from a timezone-only one.
function _uiLanguageMatches(lang, candidates) {
  const target = String(lang || '').toLowerCase();
  if (!target) return false;
  return (candidates || _candidateUILanguages()).some(cand => {
    const c = String(cand || '').toLowerCase();
    return c === target || c.startsWith(target + '-');
  });
}

// True if this entry has a `lang` and at least one of it matches the
// browser's own UI language — used by fetchRemoteRuleText() to give a
// user's own-language list priority (fetched/processed before, and placed
// ahead of in the merged output) over language-agnostic sources like
// EasyList/EasyPrivacy.
function _isLangMatchedEntry(entry) {
  return _entryLangs(entry).some(l => _uiLanguageMatches(l));
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
  // Split the match into a real language-preference signal (UI language /
  // navigator.language — what the 2026-09-24 langCandidates() fix narrowed
  // to a single primary value specifically to stop one signal from
  // auto-enabling several unrelated Rule Sources at once) vs. the timezone
  // fallback, which covers legitimately multi-language regions by returning
  // several codes for one zone (e.g. Asia/Kolkata's 10 Indian languages, all
  // of which map to the SAME single India entry — harmless). That fallback
  // is only a location GUESS, not a language choice, so if it alone (with no
  // real language-preference match backing it) would auto-enable more than
  // one DISTINCT entry — e.g. Africa/Algiers's 'ar'/'kab' matching both the
  // dedicated Arabic list and the unrelated France/Belgium list — that's the
  // exact "one signal enables several unrelated lists" pattern the
  // langCandidates() fix closed for navigator.languages, just reachable via
  // this other signal; don't guess, skip auto-enabling from it in that case.
  const primaryLangs = (() => { try { return langCandidates(); } catch (e) { return []; } })();
  const matchesPrimary = e => _entryLangs(e).some(l => _uiLanguageMatches(l, primaryLangs));
  const tzLangs = (() => { try { return typeof timezoneLangCandidates === 'function' ? timezoneLangCandidates() : []; } catch (e) { return []; } })();
  const matchesTz = e => _entryLangs(e).some(l => _uiLanguageMatches(l, tzLangs));
  const strongMatches = RULES_REMOTE_URL.filter(matchesPrimary);
  const tzOnlyMatches = RULES_REMOTE_URL.filter(e => !matchesPrimary(e) && matchesTz(e));
  const matches = tzOnlyMatches.length > 1 ? strongMatches : strongMatches.concat(tzOnlyMatches);
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
  const texts = await ruleFetcher.map(urls, async url => {
    try {
      const source = await ruleFetcher.load(url);
      const raw = source.text;
      if (source.stale) sourceErrors[url] = source.error + ' (using cached rules)';
      const stats = {};
      const converted = await _maybeConvertAbpText(raw, stats, usedKeys, dedicatedKeyMap, networkRuleBudget, !!(trackerUrls && trackerUrls.has(url)));
      if (Object.keys(stats).length) sourceStats[url] = stats;
      _diagLog('log', 'source fetch OK', { url, rawLength: raw.length, convertedLength: converted.length });
      return converted;
    } catch (e) {
      sourceErrors[url] = e && e.message ? e.message : 'fetch failed';
      _diagLog('warn', 'source fetch THREW', { url, error: e && (e.message || e) });
      return '';
    }
  });
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
  const _t0 = DEBUG_LOCAL ? performance.now() : 0;
  const stored = await LocalStorage.get(['ruleSources', 'customRulesUrl', 'customRulesText', 'defaultRuleSourceEnabled', 'defaultRuleSourceOverrides']);
  const sources = stored.ruleSources;
  // priorityUrls holds enabled default sources whose `lang` matches the
  // browser's own UI language (e.g. the Vietnam list for a vi-VN browser) —
  // kept in a SEPARATE array (not just sorted-to-front within `urls`) so
  // they can be fetched/converted as their own earlier phase below. Plain
  // array order alone wouldn't be enough: _fetchAndConvertUrls() runs its
  // whole url list through Promise.all, so which url's _maybeConvertAbpText
  // call actually claims a shared dedup key or spends the shared
  // NETWORK_RULE_BUDGET first depends on NETWORK COMPLETION TIMING, not
  // array position — a slow-loading language list could still lose a
  // budget/key race to a faster-loading global list even if it were listed
  // first. Awaiting priorityUrls to completion before starting the rest
  // (see below) makes that priority deterministic instead of a coin flip.
  const priorityUrls = [];
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
      // This repo's own curated list (the DEBUG_LOCAL swap above) always
      // stays in the non-priority group even though it has no `lang` — it's
      // language-agnostic by design, not a candidate for lang-priority.
      const bucket = _isLangMatchedEntry(entry) ? priorityUrls : urls;
      for (const u of _entryUrls(entry)) {
        bucket.push(u);
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

  // Each fetched/uploaded piece may be in raw ABP-style syntax rather than this
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
  // priorityUrls awaited to completion FIRST (its own internal Promise.all
  // for concurrency across just that group, but as a whole phase strictly
  // before the rest starts) — see priorityUrls' own comment above for why
  // this, not just array order, is what actually makes lang-matched sources
  // win any shared dedup-key or NETWORK_RULE_BUDGET race against the
  // language-agnostic sources fetched in the second phase below.
  const priorityTexts = await _fetchAndConvertUrls(priorityUrls, sharedAbpKeys, sharedDedicatedDomains, networkRuleBudget, trackerUrls);
  const texts = await _fetchAndConvertUrls(urls, sharedAbpKeys, sharedDedicatedDomains, networkRuleBudget, trackerUrls);
  const convertedFileParts = await Promise.all(fileParts.map(t => _maybeConvertAbpText(t, undefined, sharedAbpKeys, sharedDedicatedDomains, networkRuleBudget)));
  // Sequential (not Promise.all'd with the fetch above): both this and
  // _fetchAndConvertUrls independently read-modify-write the shared
  // RULE_SOURCE_ERRORS_KEY/RULE_SOURCE_STATS_KEY storage keys — running them
  // concurrently would race and drop whichever one's write lands first.
  await _updateRemoteMalwareDomains(malwareUrls);

  const merged = [...priorityTexts, ...texts, ...convertedFileParts].filter(Boolean).join('\n');
  if (!merged && (priorityUrls.length || urls.length)) {
    // At least one remote fetch was attempted and all of them came back
    // empty — that's an actual failure (network down, bad URL, ...), so
    // let getRulesText()'s catch branch fall back to cached/local rules.
    _diagLog('error', 'fetchRemoteRuleText: ALL sources returned empty -> throwing "no rules available"', { priorityUrls, urls });
    throw new Error('no rules available');
  }
  // Empty here with no urls attempted means every source was deliberately
  // disabled (or the only ones enabled produced no text) — not a fetch
  // failure, so this is a legitimate zero-rules result, not something to
  // paper over with the bundled local rules.
  await setCachedRuleText(merged);
  if (DEBUG_LOCAL) {
    _diagLog('log', 'fetchRemoteRuleText timing', {
      ms: Math.round(performance.now() - _t0),
      priorityUrlCount: priorityUrls.length, urlCount: urls.length,
      mergedLength: merged.length,
    });
  }
  return merged;
}

async function fetchLocalRuleText() {
  const res = await fetch(EXT.runtime.getURL(RULES_LOCAL_PATH), { cache: 'no-store' });
  return res.ok ? res.text() : '';
}

// ── Remote rules revalidation (ETag) ──────────────────────────────
// The 6h TTL alone means an urgent rules fix can take up to 6h to reach
// users. Instead, a periodic alarm revalidates every enabled default
// source with If-None-Match: a 304 response costs a few hundred bytes and
// just extends the cache; only a real content change triggers the full
// reload pipeline.
//
// 2026-09-17: raised from 30 to 120 minutes. This cost scales with the
// number of enabled Rule Sources (61 default entries, several with more
// than one url each — dozens of real HTTP round trips per fire), not with
// how many pages the user actually visits, so it runs unconditionally on
// this schedule the whole time the browser is open regardless of browsing
// activity. Filter lists don't typically change more than a few times a
// day, so 2h still reaches users same-day for an urgent fix while cutting
// alarm-triggered revalidation 4x (48/day -> 12/day) — well inside the 6h
// hard-TTL fallback above, which remains the actual safety net either way.
const RULES_REVALIDATE_ALARM = 'rules-revalidate';
const RULES_REVALIDATE_PERIOD_MIN = 120;
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
  'enabled', 'blockAds', 'blockTrackers', 'blockMalware',
  'referrerAnonymization', 'gpcSignal', 'dntHeader',
  'pausedDomains', 'allowedDomains', 'rules', 'remoteMalwareDomains',
  'remoteMalwarePathPatterns', 'remoteMalwareRules',
  // focusMode/distractionDomains/siteLimitsExceededToday/siteTimeLimits are
  // deliberately NOT here (removed 2026-09-18): Focus Mode blocking no
  // longer builds any DNR rule at all — see content/focus-block-overlay.js
  // and shared/focus-mode.js's own header comment for why (an explicit,
  // confirmed user choice: an in-page overlay over the real site instead of
  // a network-level block/redirect). Those keys still exist in storage and
  // still matter to FocusMode itself, just not to the DNR rule pipeline.
];
let _ruleGeneration = 0; // bumped each time ensureRuleDefinitionsLoaded() actually rebuilds
const _ruleInputHashes = {};
let _sessionAllowedDomainsHash = '';
function _hashValue(v) {
  return _hashText(JSON.stringify(v === undefined ? null : v));
}
// Both of these initial reads are fire-and-forget at module load, racing
// against real writes: e.g. a test (or the dashboard) that writes 'rules'
// via storage.local.set() immediately after the service worker starts can
// have EXT.storage.onChanged already record the fresh hash below BEFORE
// this get() resolves — its own snapshot was taken from storage as it stood
// before that write, so an unconditional assignment here would then
// clobber the fresh hash back to stale, silently freezing
// buildCustomBlockRules()'s memo (and friends) on stale input forever until
// the key changes AGAIN. Only filling in keys onChanged hasn't already
// touched keeps "last write wins" instead of "whichever resolves last wins".
LocalStorage.get(RULE_INPUT_KEYS).then(r => {
  for (const key of RULE_INPUT_KEYS) {
    if (!(key in _ruleInputHashes)) _ruleInputHashes[key] = _hashValue(r[key]);
  }
}).catch(() => {});
SessionStorage.get('sessionAllowedDomains').then(r => {
  if (!_sessionAllowedDomainsHash) _sessionAllowedDomainsHash = _hashValue(r.sessionAllowedDomains);
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
  // Not required for correctness — _tryFastSiteConfig's own textHash gating
  // already makes every entry here self-invalidating the moment the text
  // changes — but avoids orphaned per-host/global entries (computed under an
  // abandoned hash, never matched again) accumulating in storage forever.
  await LocalStorage.remove([SITE_CONFIG_HOST_CACHE_KEY, SITE_CONFIG_GLOBAL_CACHE_KEY]);
  DEFAULT_RULES = [];
  MALWARE_RULES = [];
  AD_MAINFRAME_RULES = [];
  _ruleConfigPromise = null;
  _parsedRules = null;
  abpConverter.reset();
  // Force a real rebuild of every _ruleInputHashes-memoized tier
  // (buildCustomBlockRules/remoteMalwareRules/pauseAllowRules), rather than
  // trusting that _ruleInputHashes has already caught up with whatever
  // storage write triggered this reload. reloadRules() IS the "something
  // changed, rebuild for real" signal — but _ruleInputHashes is only kept
  // current by a storage.onChanged broadcast, which is a SEPARATE async
  // event from whatever runtime message (e.g. the dashboard's own
  // RULES_CHANGED, sent right after its own storage.local.set() resolves)
  // led here, with no ordering guarantee between the two. If onChanged for
  // that write hasn't been delivered to this script yet when this runs,
  // the memo's hash comparison can still match its LAST-built value and
  // skip rebuilding — silently serving whatever `rules`/remote-malware/
  // pause-allow list was active before the change that just triggered this
  // reload (live-reported as a freshly-added custom block rule not taking
  // effect until a SECOND reload). Resetting `.rules` to null here makes
  // each tier's own falsy-`.rules` check force a fresh read no matter what
  // _ruleInputHashes currently says.
  _customBlockRulesMemo = { hash: undefined, rules: null };
  _remoteMalwareRulesMemo = { key: undefined, rules: null };
  _pauseAllowRulesMemo = { key: undefined, rules: null };
  const result = await applyNetworkRules();
  if (result?.ok === false) throw new Error(result.error);
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
    // Each url revalidated independently, IN PARALLEL — same
    // Promise.all-over-every-url shape fetchRemoteRuleText()'s own
    // _fetchAndConvertUrls() already uses for the exact same url list. This
    // used to be a sequential for-loop with an `await fetch()` per url,
    // which on every single onStartup (i.e. every time the browser reopens)
    // paid one full network round trip PER enabled source/url, one after
    // another, before returning — the likely cause of a user-reported slow
    // reopen once several default sources are enabled (2026-09-24). A
    // 304/error on one url must still never block
    // any other, whether it's a whole other source or just another url in
    // the SAME entry's group (an entry's `url` can be an array — see
    // _entryUrls' own comment; every url in the group is tracked by its own
    // ETag/hash, same as if they were separate entries) — Promise.allSettled
    // (not Promise.all) keeps that guarantee under concurrency too.
    const allUrls = enabledEntries.flatMap(entry => _entryUrls(entry));
    const results = await ruleFetcher.map(allUrls, async url => {
      try {
        const etag = etags[url] || '';
        const result = await ruleFetcher.download(url, { headers: etag ? { 'If-None-Match': etag } : {} });
        return { status: 'fulfilled', value: result.status === 304 ? null : { url, etag: result.etag, hash: _hashText(result.text) } };
      } catch (reason) { return { status: 'rejected', reason }; }
    });
    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) continue; // rejected, 304, or !ok — nothing to record
      const { url, etag, hash } = r.value;
      nextEtags[url] = etag;
      nextHashes[url] = hash;
      if (hash !== (hashes[url] || '')) changed = true;
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
// (shared/utils.js's detectStoreUrl()), reused here instead of a
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
  // Not a bait-request placeholder like everything else here — a real
  // active script (DOM/network-API patching + overlay removal) that runs
  // IN PLACE of Admiral's own loader once network_redirect_rules below
  // points Admiral's real URLs at it (2026-09-07, see that key's own
  // comment for which URLs and why each one is Admiral's, verified live
  // against twinfinite.net).
  'AdmiralJerk.user.js': ['admiral-killer', 'admiraljerk'],
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

// redirect.extensionPath (2026-09-24 — REVERSES the previous decision
// documented right here; if you're reading an old copy of this comment or a
// memory entry that still says "DO NOT use extensionPath", THIS is the
// up-to-date reasoning, not that one).
//
// Previously this used redirect.url (chrome.runtime.getURL(...), baked in
// at rule-BUILD time) specifically to get the DYNAMIC per-session id
// use_dynamic_url:true (manifest.json) provides — extensionPath resolves
// against the extension's REAL STATIC id instead, a real fingerprinting
// surface (a page can read it straight off response.url on any redirected
// request, no DevTools needed). That was a deliberate, correct call at the
// time.
//
// Live-reported (2026-09-24), root-caused precisely: chrome.runtime.
// getURL()'s dynamic id ROTATES ONCE PER REAL BROWSER START. Chrome's
// dynamic DNR ruleset persists natively across a restart, so whatever this
// extension last applied — still carrying the PREVIOUS session's now-dead
// id — is already live the instant the browser launches, before this
// script has even started running. applyNetworkRules() does correct it
// (see _ruleFingerprint()'s urlEpoch field, and _patchStaleRedirectIdsEarly()
// which fixes just this narrow thing as fast as a single declarativeNetRequest
// round trip allows, no rule-text parsing involved) — but ONLY once this
// script actually gets to run, and Chrome may restore/reload the tab that
// was ACTIVE at shutdown (not a lazily-discarded background tab) before the
// extension's own service worker has even been scheduled. That specific
// tab's very first request can race ahead of literally anything this
// script could do, no matter how fast — confirmed live: a background tab
// on the exact same site, restored lazily and only actually loaded later,
// never hit this; only the tab that was frontmost at shutdown did, every
// time. This is not something fixable from extension JS.
//
// Real-world precedent for accepting the static-id trade-off specifically
// for THIS rule type: uBlock Origin's own MV3 ruleset generator
// (platform/mv3/extension/js/ubo-parser.js, this project's uAssets/uBlock
// checkout) builds the exact same $redirect= → DNR redirect conversion
// using extensionPath, not a dynamic-id url — despite ALSO declaring
// use_dynamic_url:true on the identical resource group in its own
// manifest.json. The most scrutinized, most attacked ad blocker in
// existence makes the same call: reliability (correct from millisecond
// zero, every tab, every restart, no race window at all) over the marginal
// anti-fingerprinting benefit of a dynamic id, for network-redirect rules
// specifically.
function _redirectAction(file) {
  return { type: 'redirect', redirect: { extensionPath: `/web_accessible_resources/${file}` } };
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

  // Bulk-vs-curated split (2026-09-08): specificScriptRedirects' own key set
  // doubles as the ONLY domains that pay the "one rule per resourceType-
  // placeholder group" fan-out cost below — a real, already-vetted-as-
  // "matters enough for a dedicated stub" curated list (currently ~10
  // entries), not a guess. Every other domain — the actual bulk of
  // ad_network_patterns/tracker_network_patterns, tens of thousands of
  // entries from EasyList/EasyPrivacy/etc — gets ONE plain block rule
  // spanning every resourceType this call covers, instead of one full copy
  // of that same huge array per placeholder-file group. Still fully blocks
  // the request either way; what's given up is ONLY the "make the bait
  // request look like it succeeded" property (see REDIRECT_RESOURCE_BY_TYPE's
  // own comment on why that exists at all) for domains this repo has no
  // specific evidence are ever bait-checked directly. Live-measured
  // motivation: real EasyList+EasyPrivacy+all-sources-enabled content
  // duplicated its domain arrays across ~9 rules this way, measured at
  // ~31.6MB / 1.36s for a single updateDynamicRules() call.
  const curatedDomains = specificScriptRedirects ? domains.filter(d => specificScriptRedirects[d]) : [];
  const bulkDomains = specificScriptRedirects ? domains.filter(d => !specificScriptRedirects[d]) : domains;

  // 'script' gets split out first when per-domain overrides are in play:
  // curated domains with a specific stub each get their own single-domain
  // rule; bulk domains (no override) get the generic per-type placeholder,
  // batched into ONE rule same as before (script was never part of the
  // expensive fan-out below — only one file, noop.js, applies to it).
  let remainingTypes = resourceTypes;
  if (specificScriptRedirects && resourceTypes.includes('script')) {
    remainingTypes = resourceTypes.filter(t => t !== 'script');
    for (const d of curatedDomains) {
      rules.push({
        id: id++, priority,
        action: _redirectAction(specificScriptRedirects[d]),
        condition: { requestDomains: [d], resourceTypes: ['script'] },
      });
    }
    const scriptFile = redirectByType && redirectByType.script;
    const scriptAction = scriptFile ? _redirectAction(scriptFile) : { type: 'block' };
    if (bulkDomains.length) {
      rules.push({ id: id++, priority, action: scriptAction, condition: { requestDomains: bulkDomains, resourceTypes: ['script'] } });
    }
    for (const f of urlFilters) {
      rules.push({ id: id++, priority, action: scriptAction, condition: { urlFilter: f, resourceTypes: ['script'] } });
    }
  }

  // Bulk domains, remaining resourceTypes: ONE block rule spanning every
  // remaining type at once — see this function's own top comment for why
  // this is safe to collapse (unlike the curated group-by-placeholder loop
  // below, bulk domains never got a type-specific placeholder anyway).
  if (bulkDomains.length && remainingTypes.length) {
    rules.push({ id: id++, priority, action: { type: 'block' }, condition: { requestDomains: bulkDomains, resourceTypes: remainingTypes } });
  }

  // Curated domains, remaining resourceTypes: group by the action they'll
  // get, so types sharing a placeholder (or sharing "just block") collapse
  // into one rule — same grouping this whole function always did, just
  // scoped to the small curated list now instead of every domain.
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
    if (curatedDomains.length) {
      rules.push({ id: id++, priority, action, condition: { requestDomains: curatedDomains, resourceTypes: types } });
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

// Stale-while-revalidate (2026-09-13): a real fetchRemoteRuleText() call
// (network round trips across every enabled Rule Source) can take multiple
// seconds — this used to sit directly in getRulesText()'s blocking path
// whenever the cache aged past RULES_CACHE_TTL_MS, which is also GET_SITE_
// CONFIG's own critical path (every navigation/frame's cosmetic-hide CSS
// waits on it) — live-reported as ad boxes staying visible for several
// seconds after the extension's been idle a while (MV3 service worker
// eviction + the periodic ETag-revalidation alarm not having run recently
// enough both push the cache past its TTL). One in-flight guard so a burst
// of frames hitting the same stale cache triggers exactly one background
// refetch, not one per frame.
let _rulesTextRefreshInFlight = null;
function _refreshRulesTextInBackground() {
  if (_rulesTextRefreshInFlight) return;
  _diagLog('log', '_refreshRulesTextInBackground TRIGGERED (cache was stale)', {});
  _rulesTextRefreshInFlight = fetchRemoteRuleText()
    .then(() => {
      // fetchRemoteRuleText() already wrote the fresh text to
      // RULES_CACHE_TEXT_KEY itself — only the IN-MEMORY parsed-rules memo
      // (this SW lifetime only, see getParsedRules()' own comment) needs
      // invalidating so the NEXT getParsedRules()/GET_SITE_CONFIG call
      // re-parses the fresh text instead of continuing to serve the stale
      // in-memory one this call itself is about to return below.
      _parsedRules = null;
      _diagLog('log', '_refreshRulesTextInBackground finished OK', {});
    })
    .catch((e) => {
      _diagLog('warn', '_refreshRulesTextInBackground FAILED', { error: e && (e.message || e) });
    })
    .finally(() => { _rulesTextRefreshInFlight = null; });
}

// Single source for the merged rules text (fresh cache → remote → cached/local
// fallback). Used by rule-definition loading, GET_RULES_TEXT, and GET_SITE_CONFIG.
async function getRulesText() {
  const cached = await getCachedRuleText();
  // 2026-09-17: used to skip this branch entirely whenever DEBUG_LOCAL was
  // set, specifically so a locally-edited rule/site-rules.txt (swapped in by
  // fetchRemoteRuleText() below when DEBUG_LOCAL is on — see its own
  // comment) would take effect on every single call instead of waiting out
  // the 6h TTL. Real cost, live-reported: DEBUG_LOCAL is meant to be a pure
  // "show diagnostic logs" flag (see diag-logger.js), not a caching
  // behavior — but this made it also force a FULL refetch of every enabled
  // Rule Source (easylist, easyprivacy, badware, ...; several MB total) on
  // EVERY GET_SITE_CONFIG call, i.e. every new tab, defeating the whole
  // point of caching for anyone developing with DEBUG_LOCAL on. Caching now
  // behaves identically regardless of DEBUG_LOCAL; if you're actively
  // editing rule/site-rules.txt and need the change to land immediately
  // rather than on the next natural cache refresh, use the dashboard's
  // "reload rules" action (RULES_CHANGED -> reloadRules()) instead of
  // relying on this function to always refetch.
  if (cached && cached.text) {
    // Serve whatever's cached IMMEDIATELY, stale or not — a stale cache is
    // still far more correct than a multi-second visible-ad flash, and the
    // background refresh below (fire-and-forget, not awaited) means the
    // NEXT call — not this one — is what actually benefits from newly
    // fetched content. isFreshRuleCache() below only decides whether that
    // background refresh is even needed this call, never whether to return
    // synchronously.
    if (!isFreshRuleCache(cached)) _refreshRulesTextInBackground();
    return cached.text;
  }
  // No cache at all yet — e.g. the very first load before anything was ever
  // cached — nothing to serve immediately, so (unlike the branch above) a
  // real fetch is unavoidable right here.
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
// Hash of the raw text getParsedRules() last parsed — a cheap byproduct
// exposed as the cache key for NETWORK_BLOCK_MATCHER_CACHE_KEY (see
// ensureRuleDefinitionsLoaded()), NOT a reintroduction of the removed
// parsedRulesSessionCache: nothing here is persisted, this is just a hash
// string kept alongside the in-memory _parsedRules for this SW's lifetime.
let _parsedRulesTextHash = null;

// Cross-SW-restart session caching (parsedRulesSessionCache) was removed
// 2026-09-08: at "every Rule Source enabled" scale the parsed object
// measured ~17MB even compressed — over chrome.storage.session's fixed
// ~10MB cap (unlike storage.local, unlimitedStorage does NOT raise this),
// so the cache never actually populated there anyway, just spent CPU on a
// doomed stringify+compress+write every single cold start and logged a
// warning each time. Explicit user call: keep siteRulesCacheText (avoids
// the network refetch, the expensive part) and accept re-parsing the text
// on every cold start instead of also trying to persist the parsed form.
// _parsedRules/_parsedRulesPromise below still memoize IN-MEMORY for this
// SW's own lifetime — repeated calls within one cold start (or one
// message burst) still only parse once, same as before; only the
// cross-restart persistence is gone.
// Timing breakdown (2026-09-17) — live-reported correlation: a much smaller
// enabled rule set makes insertCSS's transient frame/url-lag errors (see
// _isTransientInsertCssError's own comment) go away almost entirely, which
// only makes sense if a bigger rule set measurably lengthens the SW's own
// cold-start work, extending the window during which a newly-opened tab's
// content script can race against still-settling browser-side frame/tab
// state. getRulesText() (fetch+decompress) and parseRuleText() (pure CPU,
// synchronous, no yield points inside — the one most likely to actually
// block the event loop and delay other messages like CSS_SET from being
// handled at all) are timed SEPARATELY here so the real bottleneck is
// visible instead of guessed at.
async function getParsedRules() {
  if (_parsedRules) return _parsedRules;
  if (!_parsedRulesPromise) {
    _parsedRulesPromise = (async () => {
      const tText0 = DEBUG_LOCAL ? performance.now() : 0;
      const text = await getRulesText();
      const tText1 = DEBUG_LOCAL ? performance.now() : 0;
      _parsedRulesTextHash = _hashText(text);
      const tParse0 = DEBUG_LOCAL ? performance.now() : 0;
      _parsedRules = parseRuleText(text);
      const tParse1 = DEBUG_LOCAL ? performance.now() : 0;
      if (DEBUG_LOCAL) {
        _diagLog('log', 'getParsedRules timing', {
          getRulesTextMs: Math.round(tText1 - tText0),
          parseRuleTextMs: Math.round(tParse1 - tParse0),
          textLength: text.length,
          textHash: _parsedRulesTextHash,
        });
      }
      return _parsedRules;
    })().finally(() => { _parsedRulesPromise = null; });
  }
  return _parsedRulesPromise;
}

// ── Per-visited-host GET_SITE_CONFIG cache (2026-09-17) ─────────────
// getParsedRules() above still re-parses the FULL merged text (~7-10MB,
// 119k+ lines at real multi-source scale) on every service-worker cold
// start — MV3 SWs terminate after ~30s idle, so this happens often. But
// resolveSiteKey()/_getClassifiedGenericSelectors() are pure functions of
// the parsed object, itself a pure function of the text: given the SAME
// text, a host's resolved {siteKey, site} answer is always byte-identical
// to what it was last time. So instead of a time-based TTL, this cache is
// gated on the rule TEXT'S OWN HASH (_hashText, already used elsewhere in
// this file, e.g. _parsedRulesTextHash) — a hit is never "probably still
// correct," it's PROVABLY correct for the exact text currently in effect,
// with zero risk of ever serving a stale answer.
//
// Two separate storage keys (see config.js's own comment on both) because
// `global` is identical for every host — SITE_CONFIG_GLOBAL_CACHE_KEY holds
// it ONCE, SITE_CONFIG_HOST_CACHE_KEY holds only the small per-host
// {siteKey, site} part. Neither is compressed (_compressForStorage) — same
// precedent as DIRECT_CSS_FASTPATH_KEY/SCRIPTLET_RULES_FASTPATH_KEY, small
// enough that compression overhead isn't worth it.
const _SITE_CONFIG_HOST_CACHE_LIMIT = 40; // a few KB/entry uncompressed -> ~150-200KB total, negligible vs LOCAL_STORAGE_SAFE_LIMIT_BYTES

// Same evict-oldest-by-timestamp algorithm as content/site-block.js's own
// _evictOldestLruEntry (that file's directCssFastPath/scriptletRulesFastPath
// LRU maps) — reimplemented here rather than shared because background.js
// (service worker) and site-block.js (isolated-world content script) are
// separate JS realms with no shared module system in this codebase.
function _evictOldestLruEntry(map) {
  let oldestHost = null, oldestTs = Infinity;
  for (const h in map) {
    if (!Object.prototype.hasOwnProperty.call(map, h)) continue;
    const ts = (map[h] && map[h].ts) || 0;
    if (ts < oldestTs) { oldestTs = ts; oldestHost = h; }
  }
  if (oldestHost !== null) delete map[oldestHost];
}

async function _loadSiteConfigCacheEntry(host) {
  try {
    const stored = await LocalStorage.get([SITE_CONFIG_HOST_CACHE_KEY, SITE_CONFIG_GLOBAL_CACHE_KEY]);
    const hostMap = stored[SITE_CONFIG_HOST_CACHE_KEY];
    const globalEntry = stored[SITE_CONFIG_GLOBAL_CACHE_KEY];
    const hostEntry = hostMap && hostMap[host];
    if (!hostEntry || !globalEntry) return null;
    return {
      siteKey: hostEntry.siteKey,
      site: hostEntry.site,
      hostTextHash: hostEntry.textHash,
      global: globalEntry.global,
      globalTextHash: globalEntry.textHash,
      gpcSignal: globalEntry.gpcSignal,
      referrerAnonymization: globalEntry.referrerAnonymization,
    };
  } catch {
    return null;
  }
}

// Returns a ready-to-send {siteKey, global, site} GET_SITE_CONFIG response
// ONLY when both the host entry and the shared global entry were computed
// from the EXACT text currently in effect (textHash match) under the EXACT
// same privacy-toggle state (gpcSignal/referrerAnonymization, which also
// influence `global` — see the real resolution path's own comment) — never
// a guess, always provably correct for right now. Returns null on any miss,
// letting the caller fall through to the real getParsedRules() path.
async function _tryFastSiteConfig(host, textHash, gpcSignal, referrerAnonymization) {
  const entry = await _loadSiteConfigCacheEntry(host);
  if (!entry) return null;
  if (entry.hostTextHash !== textHash || entry.globalTextHash !== textHash) return null;
  if (entry.gpcSignal !== gpcSignal || entry.referrerAnonymization !== referrerAnonymization) return null;
  return { siteKey: entry.siteKey, global: entry.global, site: entry.site };
}

async function _saveSiteConfigCacheEntry(host, siteKey, site, global, textHash, gpcSignal, referrerAnonymization) {
  try {
    const stored = await LocalStorage.get([SITE_CONFIG_HOST_CACHE_KEY, SITE_CONFIG_GLOBAL_CACHE_KEY]);
    const hostMap = { ...(stored[SITE_CONFIG_HOST_CACHE_KEY] || {}) };
    const isNewHost = !Object.prototype.hasOwnProperty.call(hostMap, host);
    if (isNewHost && Object.keys(hostMap).length >= _SITE_CONFIG_HOST_CACHE_LIMIT) _evictOldestLruEntry(hostMap);
    hostMap[host] = { siteKey, site, textHash, ts: Date.now() };
    // 'write' mode, not 'skip': unlike the matcher caches (which can be
    // MB-scale), this whole cache is capped at ~150-200KB total (40 entries
    // x a few KB) — low risk even written blind. On Firefox, getBytesInUse()
    // is PERMANENTLY null (not just occasionally), so 'skip' mode would
    // silently disable this entire cache, and this whole feature's benefit,
    // forever — same reasoning as setCachedRuleText's own divergence above.
    await _writeLocalIfWithinQuota({ [SITE_CONFIG_HOST_CACHE_KEY]: hostMap }, 'siteConfigHostCache', 'write');

    const prevGlobal = stored[SITE_CONFIG_GLOBAL_CACHE_KEY];
    const globalUnchanged = prevGlobal
      && prevGlobal.textHash === textHash
      && prevGlobal.gpcSignal === gpcSignal
      && prevGlobal.referrerAnonymization === referrerAnonymization;
    if (!globalUnchanged) {
      await _writeLocalIfWithinQuota({
        [SITE_CONFIG_GLOBAL_CACHE_KEY]: { global, textHash, gpcSignal, referrerAnonymization, ts: Date.now() },
      }, 'siteConfigGlobalCache', 'write');
    }
  } catch (e) {
    _diagLog('warn', 'siteConfigHostCache save FAILED', { host, error: e && (e.message || e) });
  }
}

// GET_SITE_CONFIG fires once per FRAME on every navigation — several frames
// (main + iframes, or several tabs) can resolve concurrently and each queue
// their own _saveSiteConfigCacheEntry call. Read-modify-write on the SAME
// hostMap object without serialization would let a slower write clobber a
// faster one's addition (both read the same stale map before either writes
// back) — same race _enqueueStatWrite (this file's stats accumulator) exists
// to prevent, same fix: chain every call onto one promise so writes apply
// one at a time, each seeing the previous one's result.
let _siteConfigCacheWriteChain = Promise.resolve();
function _enqueueSiteConfigCacheSave(...args) {
  _siteConfigCacheWriteChain = _siteConfigCacheWriteChain
    .then(() => _saveSiteConfigCacheEntry(...args))
    .catch(e => _diagLog('warn', 'siteConfigHostCache queued save FAILED', { error: e && (e.message || e) }));
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

// Cross-SW-restart caching of this function's OUTPUT (builtRulesSessionCache)
// was removed 2026-09-08 for the same reason as getParsedRules()'s own
// removed cache (see that function's comment): at "every Rule Source
// enabled" scale it measured ~20.69MB even compressed, over
// chrome.storage.session's fixed ~10MB cap, so it never actually cached
// anything at that scale — just a doomed stringify+compress+write and a
// warning log on every single cold start. Explicit user call: rebuild from
// the (in-memory-memoized-per-lifetime) parsed rules every cold start
// instead. The in-memory early-return two lines below (DEFAULT_RULES.length
// etc.) still skips rebuilding more than once per SW lifetime, same as
// before — only the cross-restart persistence is gone.
async function ensureRuleDefinitionsLoaded() {
  if (DEFAULT_RULES.length && MALWARE_RULES.length && AD_MAINFRAME_RULES.length) return;
  if (!_ruleConfigPromise) {
    const _t0 = DEBUG_LOCAL ? performance.now() : 0;
    _ruleConfigPromise = (async () => {
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
      // Everything below builds into LOCAL variables first — module-level
      // variables (including DEFAULT_RULES/MALWARE_RULES/AD_MAINFRAME_RULES,
      // the very guard this function checks at its own top) are committed
      // ONLY in one atomic block at the very end, after every step below
      // has succeeded without throwing. This used to commit DEFAULT_RULES/
      // MALWARE_RULES/AD_MAINFRAME_RULES FIRST, with NETWORK_BLOCK_MATCHER/
      // HTML_FILTER_MATCHER assigned several steps later — if anything in
      // between threw (e.g. buildNetworkBlockMatcher() hitting one
      // malformed entry among thousands merged from EasyList/EasyPrivacy/
      // Fanboy-Social/...), the guard was already satisfied by the time the
      // exception propagated, so this function would never retry for the
      // REST OF THIS SCRIPT'S LIFETIME — leaving HTML_FILTER_MATCHER (built
      // after the throw point) stuck at its initial empty Map permanently.
      // Live-reported (2026-09-14): HTML filter silently doing nothing on
      // vnexpress.net "after some time" (HTML_FILTER_MATCHER_size: 0 in the
      // diag log) despite GET_SITE_CONFIG — a completely separate code path
      // reading the exact same `parsed` — still returning the correct
      // selectors the whole time, since getParsedRules() has its own
      // independent success/failure, unaffected by this function's guard.
      const { adRules, trackerRules } = buildDefaultRulesFromConfig(config);
      const defaultRules = [...adRules, ...trackerRules];
      const malwareRules = buildMalwareRulesFromConfig(config, defaultRules.length + 1);
      const adMainFrameRules = buildAdMainFrameRulesFromConfig(config, defaultRules.length + malwareRules.length + 1);
      const queryStripRules = buildQueryStripRules(global.strip_query_params || [], QUERY_STRIP_RULE_ID_START);
      const networkRedirectRules = buildNetworkRedirectRules(global.network_redirect_rules || [], NETWORK_REDIRECT_RULE_ID_START);
      // network_block_rules: DNR rule objects for Chrome/Edge (and Firefox
      // when webRequestBlocking isn't available), OR a webRequest matcher
      // Map for Firefox when it is — never both, see _hasWebRequestBlocking()
      // and buildActiveRulesFromStorage()'s own gating of networkBlockActive.
      let networkBlockRules, networkBlockMatcher, networkBlockComplex;
      if (_hasWebRequestBlocking()) {
        networkBlockRules = [];
        // Cross-SW-restart cache (chrome.storage.local, quota-guarded) for
        // this specifically — the only per-entry-RegExp-compiling build in
        // this function — see _saveMatcherCacheToLocal's own comment.
        const cachedNetworkBlockMatcher = await _loadMatcherCacheFromLocal(NETWORK_BLOCK_MATCHER_CACHE_KEY, _parsedRulesTextHash, _rehydrateMatcherMap);
        if (cachedNetworkBlockMatcher) {
          networkBlockMatcher = cachedNetworkBlockMatcher;
        } else {
          networkBlockMatcher = buildNetworkBlockMatcher(parsed);
          // Fire-and-forget: measured ~8-11ms (compress + getBytesInUse +
          // storage.local.set) at real ~7,480-entry scale — the write is
          // best-effort already (try/catch inside), so there's no reason to
          // make every rebuild's caller (ensureRuleDefinitionsLoaded(),
          // GET_RULE_COUNT, applyNetworkRules()...) wait on it finishing.
          _saveMatcherCacheToLocal(NETWORK_BLOCK_MATCHER_CACHE_KEY, _parsedRulesTextHash, _serializeMatcherMap(networkBlockMatcher));
        }
        // NETWORK_BLOCK_MATCHER's wildcard-TLD/raw-regex sibling — see
        // buildNetworkBlockComplex()'s own comment for why it's always
        // rebuilt fresh here regardless of the plain matcher's cache hit/
        // miss above (expected to stay tiny — hand-written entries only).
        networkBlockComplex = buildNetworkBlockComplex(parsed);
      } else {
        networkBlockRules = buildDomainNetworkBlockRules(parsed, NETWORK_BLOCK_RULE_ID_START);
        networkBlockMatcher = new Map();
        networkBlockComplex = []; // Chrome/Edge — network_block_rules goes through NETWORK_BLOCK_RULES (DNR) instead, see buildDomainNetworkBlockRules()
      }
      // Unconditional (unlike NETWORK_BLOCK_MATCHER above) — building the
      // MAP itself is cheap regardless of browser (just copying selector
      // array references per host_patterns entry, no per-request work);
      // only the LISTENER is gated by _hasHtmlStreamFilter() (registered
      // once at module load — see _htmlFilterRequestHandler's own
      // comment), so there's nothing to branch on here. The real cost this
      // pays for is at REQUEST time on Firefox (buffer+reparse a whole
      // HTML response) — see buildHtmlFilterMatcher's own comment on
      // reusing direct_hide_selectors wholesale instead of a separate
      // opt-in key.
      const htmlFilterMatcher = buildHtmlFilterMatcher(parsed);
      const trackerRuleIds = new Set(trackerRules.map(rule => rule.id));

      // Atomic commit — see this function's own comment above for why
      // nothing above this point touches a module-level variable.
      DEFAULT_RULES = defaultRules;
      MALWARE_RULES = malwareRules;
      AD_MAINFRAME_RULES = adMainFrameRules;
      QUERY_STRIP_RULES = queryStripRules;
      NETWORK_REDIRECT_RULES = networkRedirectRules;
      NETWORK_BLOCK_RULES = networkBlockRules;
      NETWORK_BLOCK_MATCHER = networkBlockMatcher;
      NETWORK_BLOCK_COMPLEX = networkBlockComplex;
      HTML_FILTER_MATCHER = htmlFilterMatcher;
      TRACKER_RULE_IDS = trackerRuleIds;
      AD_KEYWORDS.splice(0, AD_KEYWORDS.length, ...config.adPatterns);
      TRACKER_KEYWORDS.splice(0, TRACKER_KEYWORDS.length, ...config.trackerPatterns);
      MALWARE_KEYWORDS.splice(0, MALWARE_KEYWORDS.length, ...config.malwarePatterns);
      _ruleGeneration++; // invalidates _ruleFingerprint() — static rule defs just changed
      _diagLog('log', 'ensureRuleDefinitionsLoaded REAL BUILD finished', {
        ms: DEBUG_LOCAL ? Math.round(performance.now() - _t0) : undefined,
        DEFAULT_RULES: DEFAULT_RULES.length, MALWARE_RULES: MALWARE_RULES.length, AD_MAINFRAME_RULES: AD_MAINFRAME_RULES.length,
        NETWORK_BLOCK_MATCHER: NETWORK_BLOCK_MATCHER.size, HTML_FILTER_MATCHER: HTML_FILTER_MATCHER.size,
        MALWARE_PATH_MATCHER: MALWARE_PATH_MATCHER.size, NETWORK_BLOCK_RULES: NETWORK_BLOCK_RULES.length,
        NETWORK_BLOCK_COMPLEX: NETWORK_BLOCK_COMPLEX.length,
        parsedRulesTextHash: _parsedRulesTextHash,
        hasWebRequestBlocking: _hasWebRequestBlocking(), hasHtmlStreamFilter: _hasHtmlStreamFilter(),
        userAgent: navigator.userAgent,
      });
    })().catch((e) => {
      // Nothing committed above (see the atomic-commit comment) — the
      // guard stays unsatisfied, so the NEXT call retries the whole build
      // from scratch instead of running forever with partial/stale state.
      _diagLog('error', 'ensureRuleDefinitionsLoaded REAL BUILD THREW — nothing committed, will retry on next call', { error: e && (e.message || e), stack: e && e.stack });
      throw e;
    }).finally(() => {
      _ruleConfigPromise = null;
    });
  }
  await _ruleConfigPromise;
}

const QUERY_STRIP_RULE_ID_START = 3000;
const NETWORK_REDIRECT_RULE_ID_START = 500000; // for network_redirect_rules
const NETWORK_BLOCK_RULE_ID_START = 700000;  // for network_block_rules (well clear of NETWORK_REDIRECT_RULE_ID_START's own sequential counter)
const REMOTE_MALWARE_RULE_ID_START = 100000; // for fetched blocklists
const REMOTE_MALWARE_PATH_RULE_ID_START = 900000; // for path-scoped fetched-blocklist entries (one urlFilter rule each, see REMOTE_MAX_PATH_PATTERNS)
const CUSTOM_RULE_ID_START = 200000;         // for user-created rules
const PAUSE_ALLOW_RULE_ID_START = 300000;    // for pause/allowlist allow-all rules

// ── Stable content-addressed rule IDs (Phase 3a prerequisite) ────────────
// pauseAllowRules/customBlockRules used to assign ids
// POSITIONALLY (START + array index) over pausedDomains/allowedDomains/
// rules — lists whose ORDER can change (an item removed
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
    // Focus Mode / Pomodoro / per-site time limits (shared/focus-mode.js) —
    // seeded here so a pre-update install (which never had these keys) reads
    // the exact same defaults FocusMode's own DEFAULT_* constants already
    // fall back to inline everywhere else, closing the gap the ORIGINAL
    // focusMode/distractionDomains/focusDuration/focusEndTime keys already
    // had (never seeded at all, only defaulted inline at each read site).
    'pomodoroEnabled', 'focusBreakDuration', 'focusLongBreakDuration',
    'focusCyclesBeforeLongBreak', 'distractionDomains', 'focusDuration',
    'siteTimeLimits',
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
    pomodoroEnabled:            existing.pomodoroEnabled            ?? false,
    focusBreakDuration:         existing.focusBreakDuration         ?? FocusMode.DEFAULT_BREAK_MIN,
    focusLongBreakDuration:     existing.focusLongBreakDuration     ?? FocusMode.DEFAULT_LONG_BREAK_MIN,
    focusCyclesBeforeLongBreak: existing.focusCyclesBeforeLongBreak ?? FocusMode.DEFAULT_CYCLES_BEFORE_LONG_BREAK,
    distractionDomains:         existing.distractionDomains         ?? FocusMode.DISTRACTION_DEFAULTS,
    focusDuration:              existing.focusDuration              ?? FocusMode.DEFAULT_FOCUS_DURATION_MIN,
    siteTimeLimits:             existing.siteTimeLimits             ?? {},
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

  await applyNetworkRules(); // Includes saved privacy rules atomically.
  await maybeCheckForExtensionUpdate();
});

EXT.runtime.onStartup.addListener(() => {
  applyNetworkRules();
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
// _customBlockRulesMemo above, keyed off the same
// _ruleInputHashes/_sessionAllowedDomainsHash Phase 1a already maintains.
let _remoteMalwareRulesMemo = { key: undefined, rules: null };
let _pauseAllowRulesMemo = { key: undefined, rules: null };

async function buildActiveRulesFromStorage() {
  await ensureRuleDefinitionsLoaded();
  // `enabled` gets the same `= true` default its blockAds/blockTrackers/
  // blockMalware siblings already have here — onInstalled seeds `enabled:
  // true` (see below), but that only runs on an actual install/update
  // event, never on a manual storage.local.clear() (dashboard's "Reset
  // Data" button, or storage cleared by any other means). Without this
  // default, a missing key after such a clear was read as `undefined` ->
  // falsy -> `!enabled` below -> this function returns `allRules: []` ->
  // _applyNetworkRulesImpl() then actively REMOVES every existing DNR
  // dynamic rule and updateIcon(false)'s the badge, live-reported as the
  // popup showing "0 network rules loaded" until something explicitly
  // re-writes `enabled` to storage.
  const {
    enabled = true, pausedDomains = [], allowedDomains = [],
    blockAds = true, blockTrackers = true, blockMalware = true,
    referrerAnonymization = true, gpcSignal = true, dntHeader = true,
  } = await LocalStorage.get(
    ['enabled', 'pausedDomains', 'allowedDomains', 'blockAds', 'blockTrackers', 'blockMalware', 'referrerAnonymization', 'gpcSignal', 'dntHeader']
  );

  if (!enabled) {
    // No _updateNetworkBlockListener/_updateHtmlFilterListener calls here
    // (both removed 2026-09-14/2026-08-xx respectively) — both webRequestBlocking
    // listeners are registered once, unconditionally, at module load (see
    // _networkBlockRequestHandler's and _htmlFilterRequestHandler's own
    // registration comments for why) and enforce enabled/blockAds/
    // blockMalware/pausedDomains/allowedDomains themselves on every request
    // instead.
    return { enabled: false, allRules: [] };
  }

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
      // Build into a LOCAL variable first, same reasoning as
      // ensureRuleDefinitionsLoaded()'s own atomic commit: _remoteMalwareRulesMemo
      // used to be committed BEFORE MALWARE_PATH_MATCHER was actually built
      // below — if that build ever threw (a malformed entry in a real
      // URLhaus-style feed; Fix B above makes this unlikely but not
      // impossible for other reasons), the memo would already report
      // "already built for this remoteKey", so this function would never
      // retry again until remoteKey changes — leaving MALWARE_PATH_MATCHER
      // stuck at whatever it was (empty, on a first build) for the rest of
      // this lifetime, the exact same bug class live-reported for
      // HTML_FILTER_MATCHER (2026-09-14).
      let malwarePathMatcher;
      if (_hasWebRequestBlocking()) {
        // Same cross-SW-restart local-storage cache pattern as
        // NETWORK_BLOCK_MATCHER in ensureRuleDefinitionsLoaded() — this is
        // the other per-entry-RegExp-compiling matcher, keyed off the same
        // remoteKey already used for the in-memory _remoteMalwareRulesMemo.
        const cachedMalwarePathMatcher = await _loadMatcherCacheFromLocal(MALWARE_PATH_MATCHER_CACHE_KEY, remoteKey, _rehydrateRegexMatcherMap);
        if (cachedMalwarePathMatcher) {
          malwarePathMatcher = cachedMalwarePathMatcher;
        } else {
          malwarePathMatcher = buildMalwarePathMatcher(remotePathPatterns);
          // Fire-and-forget — see the matching comment on the
          // NETWORK_BLOCK_MATCHER save above.
          _saveMatcherCacheToLocal(MALWARE_PATH_MATCHER_CACHE_KEY, remoteKey, _serializeRegexMatcherMap(malwarePathMatcher));
        }
      } else {
        malwarePathMatcher = new Map();
      }
      // Atomic commit — only after the build above succeeded without throwing.
      MALWARE_PATH_MATCHER = malwarePathMatcher;
      _remoteMalwareRulesMemo = { key: remoteKey, rules: remoteActive };
    }
  } else {
    MALWARE_PATH_MATCHER = new Map();
  }
  const customBlockRules = await buildCustomBlockRules();
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
  const privacyRules = [
    referrerAnonymization && { id: REFERRER_RULE_ID, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'remove' }] },
      condition: { resourceTypes: GPC_DNT_RESOURCE_TYPES.filter(type => type !== 'main_frame'), domainType: 'thirdParty' } },
    gpcSignal && { id: GPC_RULE_ID, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Sec-GPC', operation: 'set', value: '1' }] },
      condition: { resourceTypes: GPC_DNT_RESOURCE_TYPES } },
    dntHeader && { id: DNT_RULE_ID, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'DNT', operation: 'set', value: '1' }] },
      condition: { resourceTypes: GPC_DNT_RESOURCE_TYPES } },
  ].filter(Boolean);
  const combinedRules = [
    ...privacyRules, ...activeRules, ...adMainFrameActive, ...malwareActive, ...remoteActive,
    ...customBlockRules, ...pauseAllowRules, ...queryStripActive, ...networkRedirectActive,
    ...networkBlockActive,
  ];
  const allRules = _trimToDynamicRuleLimits(combinedRules);

  // Dev-only rule-build summary — never runs for a real user (DEBUG_LOCAL is
  // false in shipped config.js, see that constant's own comment). Answers
  // "how many rules, from which tier, how big" without having to paste
  // tools/inspect-rule-cache-size.js into the SW console by hand every time.
  if (DEBUG_LOCAL) {
    const byteSize = (v) => new TextEncoder().encode(JSON.stringify(v)).length;
    console.log('[AdBlock][DEBUG_LOCAL] rule build summary', {
      default: filteredDefaultRules.length,
      adMainFrame: adMainFrameActive.length,
      malware: malwareActive.length,
      remoteMalware: remoteActive.length,
      custom: customBlockRules.length,
      pauseAllow: pauseAllowRules.length,
      queryStrip: queryStripActive.length,
      networkRedirect: networkRedirectActive.length,
      networkBlock: networkBlockActive.length,
      '—combinedTotal': combinedRules.length,
      '—afterTrim': allRules.length,
      '—trimmedAway': combinedRules.length - allRules.length,
      '—approxBytes': byteSize(allRules),
      remoteMalwareDomainsRaw: remoteDomains.length,
      remoteMalwarePathPatternsRaw: remotePathPatterns.length,
    });
  }

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
    .then(() => _applyNetworkRulesImpl())
    .catch(error => ({ ok: false, error: error.message || 'Could not apply network rules' }));
  return _applyNetworkRulesChain;
}

// Called ONCE, unconditionally, right here at module top-level — not just
// from onInstalled/onStartup. Both DEFAULT_RULES/MALWARE_RULES/
// AD_MAINFRAME_RULES (in-memory, built by ensureRuleDefinitionsLoaded())
// and NETWORK_BLOCK_MATCHER/MALWARE_PATH_MATCHER/HTML_FILTER_MATCHER
// (in-memory, built inside buildActiveRulesFromStorage()) live only in this
// module's variables — never persisted — so they're empty every time this
// script is (re)loaded. That happens far more often than onInstalled/
// onStartup fire: Firefox idle-kills and respawns this event page after a
// period of inactivity (visible as "Background event page was not
// terminated on idle because a DevTools toolbox is attached to the
// extension" when a toolbox IS attached and this doesn't happen), and
// Chrome's MV3 service worker does the same. Neither onInstalled nor
// onStartup fires on that kind of respawn (only a real install/update or an
// actual browser launch does), so without this call the popup's rule count
// silently drops to whatever getDynamicRules() alone reports (live-reported
// as "469 quy tắc" — DNR-persisted rules only) until something else happens
// to trigger a rebuild (e.g. toggling Protected off/on, which sends a
// message that ends up calling applyNetworkRules() some other way).
// _networkBlockRequestHandler's own listener registration (see its comment,
// above) no longer depends on this call at all as of 2026-09-14 — it's
// registered unconditionally at module load regardless, so real blocking
// from that tier survives even when this call is ever lost again; only the
// MATCHER CONTENT (and the popup's displayed count) still needs a build to
// actually run, same as every other in-memory rule tier.
_diagLog('log', 'MODULE LOAD (background script (re)started)', {
  hasWebRequestBlocking: _hasWebRequestBlocking(), hasHtmlStreamFilter: _hasHtmlStreamFilter(),
  userAgent: navigator.userAgent,
});
// _autoEnableLangDefaultSources() used to run ONLY from onInstalled — but
// "Reload" in about:debugging (or a web-ext auto-reload on file change),
// the normal dev-loop way to pick up code changes, does NOT fire
// onInstalled at all; it's a plain re-execution of this script, same as
// any other respawn. If the ONE real onInstalled event for this profile
// happened before a lang-matched source existed in config.js (e.g. ABPVN,
// added 2026-08-22), or storage.local was ever reset since, this function
// never got another chance to run — live-reported (2026-09-14) as ABPVN
// staying disabled ("priorityUrlsCount: 0" in the diag log) despite a
// vi-VN/Asia-Ho_Chi_Minh-timezone browser matching its `lang`. Calling it
// here too is safe to repeat: it only fills in an override key that's
// completely ABSENT (see its own `hasOwnProperty` check) — it can never
// re-enable a source the user deliberately turned back off, and once it
// has run successfully once, every later call here is a fast no-op.
(async () => {
  await _autoEnableLangDefaultSources();
  applyNetworkRules();
})();

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
      // Dev-only timing — how long the actual DNR IPC call takes for
      // THIS diff (not the full allRules set — Phase 3a above already only
      // sends what changed, so this is the real per-call cost, not a
      // worst-case full-rebuild number every single time). See
      // buildActiveRulesFromStorage()'s own DEBUG_LOCAL summary for the
      // full-set byte size context this pairs with.
      const t0 = DEBUG_LOCAL ? performance.now() : 0;
      await EXT.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
      if (DEBUG_LOCAL) {
        const byteSize = (v) => new TextEncoder().encode(JSON.stringify(v)).length;
        console.log('[AdBlock][DEBUG_LOCAL] updateDynamicRules() timing', {
          ms: Math.round(performance.now() - t0),
          removeCount: removeRuleIds.length,
          addCount: addRules.length,
          addBytes: byteSize(addRules),
        });
      }
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
      return { ok: false, error: e.message || 'Could not apply network rules' };
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

// ── Focus mode / per-site daily limits: NO DNR rule at all ────────────
// Both used to build DNR block+redirect rules here (see git history: the
// 2026-09-18 redirect-to-blocked.html design). Removed by explicit,
// confirmed user request: Focus Mode blocking is now a purely client-side
// overlay drawn ON TOP of the real, fully-loaded page — see
// content/focus-block-overlay.js — not a network-level block/redirect. The
// tradeoff (the real site's scripts/trackers/bandwidth all still run
// underneath the overlay) was explicitly raised and accepted. The default
// distraction list itself still lives in shared/focus-mode.js
// (FocusMode.DISTRACTION_DEFAULTS); background.js no longer reads it at
// all, since it built no rules from it.

// ── Icon badge ────────────────────────────────────────────────────
// enabled=true shows the ACTIVE TAB's own blocked count (resets per
// navigation, see _tabBlockedCounts below), enabled=false shows
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

// ── Icon badge count — PER TAB ───────────────────────────────────────
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
  await ruleFetcher.map(urls, async url => {
    const stats = _abpEmptySkipStats();
    try {
      const source = await ruleFetcher.load(url);
      if (source.stale) sourceErrors[url] = source.error + ' (using cached rules)';
      const text = source.text;
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
  });

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
  if (urls.length && urls.every(u => sourceErrors[u] && !sourceStats[u])) return;

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

// alarms.create() with an existing name CANCELS and REPLACES it, resetting
// its next-fire countdown — calling it unconditionally here (top-level
// script scope) re-runs every time the MV3 service worker wakes for ANY
// reason (a message, a request, ...), not just onInstalled/onStartup. Under
// active browsing the SW routinely wakes more often than every 30 minutes,
// which was perpetually resetting RULES_REVALIDATE_ALARM before it ever got
// to fire — silently defeating the "30-minute alarm" urgent-fix propagation
// revalidateRemoteRules()'s own comment describes. get()-before-create only
// (re)creates an alarm that isn't already scheduled, so an existing alarm's
// countdown survives SW restarts as intended.
function _ensureAlarm(name, alarmInfo) {
  if (!EXT.alarms) return;
  Promise.resolve(EXT.alarms.get(name)).then(existing => {
    if (!existing) EXT.alarms.create(name, alarmInfo);
  }).catch(() => {});
}
_ensureAlarm(RULES_REVALIDATE_ALARM, { periodInMinutes: RULES_REVALIDATE_PERIOD_MIN });
_ensureAlarm('extension-update-check', { periodInMinutes: 60 * 24 });
// Per-site daily time-limit tick (shared/focus-mode.js's onSiteLimitTick) —
// the practical minimum period chrome.alarms allows; see that function's
// own comment for why this is the resolution floor for this feature, not a
// tunable knob. Armed unconditionally (not gated on siteTimeLimits being
// non-empty) since _ensureAlarm() itself is idempotent/cheap and the tick
// is already a fast no-op whenever no limited site is actually focused.
_ensureAlarm('focus-site-limit-tick', { periodInMinutes: 1 });

EXT.alarms?.onAlarm.addListener(async (alarm) => {
  if (alarm.name === RULES_REVALIDATE_ALARM) {
    await revalidateRemoteRules();
  }
  if (alarm.name === 'extension-update-check') {
    await checkForExtensionUpdate();
  }
  if (alarm.name === 'focus-end') {
    // FocusMode.onPhaseAlarm() (shared/focus-mode.js) owns the full
    // decision here now: single-session mode disables (same behavior this
    // handler used to do inline); Pomodoro mode advances to the next
    // work/break phase and re-arms this SAME alarm name for it — see that
    // function's own comment. No applyNetworkRules() call here anymore:
    // focusMode/distractionDomains stopped being DNR rule inputs entirely
    // once Focus Mode blocking moved to a client-side overlay (content/
    // focus-block-overlay.js) — a phase change or session end has nothing
    // left for the DNR pipeline to rebuild.
    await FocusMode.onPhaseAlarm();
  }
  if (alarm.name === 'focus-site-limit-tick') {
    // Same reasoning: siteLimitsExceededToday is no longer a DNR rule
    // input either, so there is nothing to conditionally rebuild here —
    // content/focus-block-overlay.js reads this key directly via its own
    // storage.onChanged listener instead.
    await FocusMode.onSiteLimitTick();
  }
});

// FocusMode needs to know, at all times, which hostname (if any) is
// currently both visible (active tab) AND actually being looked at (OS
// window focused). Two signals feed it: this listener (a DIFFERENT window
// gained/lost OS focus) and tabs.onActivated further down (the active TAB
// changed WITHIN a window, without the window itself changing focus — e.g.
// Ctrl+Tab). _focusedWindowId is the shared piece of state that lets
// tabs.onActivated tell those two cases apart: an activation in some OTHER
// (background) window must NOT overwrite what the user is actually looking
// at, or a limited site opened in a background window/tab could get time
// wrongly attributed to it.
let _focusedWindowId = null;
EXT.windows?.onFocusChanged.addListener(async (windowId) => {
  if (windowId === EXT.windows.WINDOW_ID_NONE) {
    _focusedWindowId = null;
    FocusMode.setWindowFocused(false);
    return;
  }
  _focusedWindowId = windowId;
  FocusMode.setWindowFocused(true);
  try {
    const [tab] = await EXT.tabs.query({ active: true, windowId });
    if (tab && tab.url) {
      let domain = '';
      try { domain = new URL(tab.url).hostname; } catch { domain = ''; }
      FocusMode.setActiveTab(domain);
    }
  } catch (e) {}
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

// ── Privacy: single-header modifyHeaders toggle (shared body) ───────
// applyReferrerAnonymization/applyGpcHeader/applyDntHeader below were 3
// structurally identical functions (getDynamicRules() -> check hasRule by a
// fixed id -> add/remove one single-header modifyHeaders rule), differing
// only in rule id/header name/value/resourceTypes/extra condition fields.
// Consolidated here 2026-09-15.
function _applySingleHeaderRule(...args) {
  const result = _applyNetworkRulesChain.catch(() => {}).then(() => _applySingleHeaderRuleImpl(...args));
  _applyNetworkRulesChain = result.catch(() => {});
  return result;
}
async function _applySingleHeaderRuleImpl(ruleId, enabled, header, value, resourceTypes, extraCondition) {
  const existing = await EXT.declarativeNetRequest.getDynamicRules();
  const hasRule = existing.some(r => r.id === ruleId);

  if (enabled && !hasRule) {
    await EXT.declarativeNetRequest.updateDynamicRules({
      addRules: [{
        id: ruleId,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [value === null ? { header, operation: 'remove' } : { header, operation: 'set', value }],
        },
        condition: { resourceTypes, ...extraCondition },
      }],
    });
  } else if (!enabled && hasRule) {
    await EXT.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [ruleId],
    });
  }
}

// ── Privacy: Referrer anonymization ───────────────────────────────
// Removes the cross-origin Referer header. Empty set values are rejected by Firefox.
const REFERRER_RULE_ID = 400000;

async function applyReferrerAnonymization(enabled) {
  await _applySingleHeaderRule(
    REFERRER_RULE_ID, enabled, 'Referer', null,
    ['sub_frame', 'script', 'xmlhttprequest', 'image', 'stylesheet', 'font', 'media', 'ping', 'other'],
    { domainType: 'thirdParty' }
  );
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
  await _applySingleHeaderRule(GPC_RULE_ID, enabled, 'Sec-GPC', '1', GPC_DNT_RESOURCE_TYPES);
}

// ── Privacy: Do Not Track header ────────────────────────────────────
const DNT_RULE_ID = 400002;

async function applyDntHeader(enabled) {
  await _applySingleHeaderRule(DNT_RULE_ID, enabled, 'DNT', '1', GPC_DNT_RESOURCE_TYPES);
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
// over the page's own CSS regardless of specificity/!important. removeCSS
// must pass the same origin used at insert time, or the browser won't
// recognize it as the same injection to remove.
//
// "slot" lets 3 independent CSS sources (base defaults, per-site
// direct_hide_selectors, user custom rules) update/clear without touching
// each other. Keyed per tab+frame since all_frames content scripts each
// have their own frameId.
const _frameCss = new Map(); // `${tabId}:${frameId}:${slot}` -> last-applied css text
// content.js/site-block.js legitimately re-send the exact same slot's CSS
// verbatim more than once per page (boot()'s own send, then sync()'s
// defensive re-send in case CSS_CLEAR_ALL wiped it, then another sync() on
// DOMContentLoaded — see sync()'s own comment) — byte-identical raw text
// every time on a normal page with a stable config. _frameCss above only
// short-circuits AFTER paying for _dedupeCssRules() (a split+sort+join over
// the whole CSS text) on every one of those resends. This tracks the RAW
// (pre-dedupe) text per key so an identical resend returns immediately,
// before any of that work — cleared alongside _frameCss in clearFrameCss()
// so a real fresh navigation with coincidentally-identical content (same
// host revisited) still isn't skipped incorrectly.
const _frameCssRaw = new Map();

function _frameCssKey(tabId, frameId, slot) {
  return `${tabId}:${frameId}:${slot}`;
}

// Firefox implements the same `scripting.insertCSS` namespace Chrome does
// (browser.tabs.insertCSS does not exist) — one shared implementation for
// both browsers. (This was briefly stubbed out for an isolate-test on
// 2026-09-03, whether the HTML stream filter alone could hide vnexpress.net's
// banner with no CSS fallback masking the result — restored the same day.
// Leaving this disabled by mistake breaks cosmetic hiding on EVERY site, so
// don't disable it again without a very good reason.)
//
// _isTransientInsertCssError/retry loop (2026-09-17) — live-reported: using
// the REAL sender.frameId (see the message handler below — an earlier
// attempt at this fix hardcoded frameId to 0, on the theory that this
// content script's `all_frames:false` manifest entry means it only ever
// targets "the tab's main frame" and 0 is always valid for that meaning;
// reverted — Chrome's frame id for that meaning isn't provably always 0 the
// instant a brand-new navigation's content script runs, and forcing 0
// regardless of what Chrome actually reported risked applying a guess
// computed for one document onto a DIFFERENT frame instance that happens to
// also be id 0 at that moment. Trusting sender.frameId is the honest fix;
// this retry loop is what actually recovers the transient cases instead),
// site-block.js's _fastPathDirectStyle() guess (fires essentially at the
// instant document_start content scripts start running, before
// GET_SITE_CONFIG's own round trip even begins) can hit two DIFFERENT
// transient chrome.scripting.insertCSS failures depending on exactly how
// early it lands:
//   - "No frame with id X in tab with id Y" — chrome.scripting's own
//     internal FRAME registry for that exact frame id hadn't caught up yet.
//     Live-observed with a real but SHORT-LIVED frame id (e.g. 12799) that
//     never became valid again — a known Chromium quirk where a transient
//     pre-navigation document can receive its own short-lived frame
//     identity before the real navigated document (frame id 0, in every
//     observed case) takes over. Retrying the SAME id here can't recover
//     that specific case (the id is genuinely gone, not just "not yet
//     registered") — harmless: the real document's own later 'direct'
//     CSS_SET carries the REAL frame id and succeeds independently, so
//     ad-hiding on the actual page is unaffected either way. This retry
//     still earns its keep for the case where the id Chrome reported IS the
//     real, final frame, just not registered in chrome.scripting's internal
//     table microseconds yet — indistinguishable from the dead-transient
//     case by error message alone, so both are retried the same way.
//   - "Cannot access a chrome:// URL" — chrome.scripting's own internal
//     notion of the tab's CURRENT URL hadn't caught up yet, live-confirmed
//     via the diag log's own `url` field: every occurrence reported the tab
//     as still "chrome://newtab/" while the CSS being inserted was already
//     built from a REAL site's cached selectors (the content script's own
//     location.hostname, always accurate — a page genuinely still on
//     chrome://newtab/ never runs content scripts at all, so receiving this
//     message already proves the tab is on a real page). This one DOES
//     reliably recover on retry against the same frame id — confirmed
//     live — since it's the SAME real frame the whole time, just Chrome's
//     own url-tracking metadata lagging, not a different frame instance.
// Anything else (e.g. a closed tab, invalid CSS) fails a DIFFERENT error
// message and is deliberately NOT retried, so a genuinely permanent failure
// still surfaces immediately via _diagLog.
function _isTransientInsertCssError(e) {
  const msg = e && (e.message || String(e));
  if (typeof msg !== 'string') return false;
  return msg.indexOf('No frame with id') !== -1 || msg.indexOf('Cannot access a chrome://') !== -1;
}
async function _insertFrameCss(tabId, frameId, css) {
  const retryDelaysMs = [20, 60, 150];
  for (let attempt = 0; ; attempt++) {
    try {
      await EXT.scripting.insertCSS({ target: { tabId, frameIds: [frameId] }, css, origin: 'USER' });
      return;
    } catch (e) {
      if (attempt >= retryDelaysMs.length || !_isTransientInsertCssError(e)) throw e;
      await new Promise(resolve => setTimeout(resolve, retryDelaysMs[attempt]));
    }
  }
}
async function _removeFrameCss(tabId, frameId, css) {
  await EXT.scripting.removeCSS({ target: { tabId, frameIds: [frameId] }, css, origin: 'USER' });
}

// _dedupeCssRules — content.js/site-block.js build a slot's CSS text by
// joining one rule per selector (see BASE_CSS / _scopedDirectRule); merged
// config sources ([site] + [global], or two Rule Sources sharing a
// dedicated-domain selector) can hand back the exact same selector twice,
// producing the exact same rule text twice. insertCSS doesn't care (the
// cascade just re-applies an identical rule), but it's wasted bytes across
// the privileged call and wasted browser-side parse work, so split on rule
// boundaries and keep only one copy of each exact rule text — unparsed
// cruft (a stray blank chunk) is dropped along with it.
//
// Sorted, not first-occurrence order: setFrameCss is called repeatedly
// across a page's lifetime (mutation-observer rescans, config reloads) with
// what is semantically the SAME rule set but possibly a different array
// order upstream (e.g. _cachedDirect's own order shifting). A stable,
// order-independent output means two calls carrying an equivalent rule set
// produce the exact same string, so setFrameCss's `prev === css` check
// correctly recognizes "nothing actually changed" and skips a needless
// removeCSS+insertCSS round trip — the expensive part on Firefox.
function _dedupeCssRules(css) {
  if (!css) return css;
  const parts = css.split('}');
  const seen = new Set();
  for (let i = 0; i < parts.length; i++) {
    const rule = parts[i].trim();
    if (!rule) continue;
    seen.add(rule + '}');
  }
  return Array.from(seen).sort().join('\n\n');
}

// setFrameCss's own body used to run as soon as it was called, with no
// mutual exclusion between overlapping calls for the SAME tab+frame+slot.
// content.js/site-block.js legitimately send two CSS_SET messages for the
// SAME 'direct' slot close together on every normal page load: site-
// block.js's _fastPathDirectStyle() fires last-known-good CSS immediately
// (before GET_SITE_CONFIG even resolves), then the real selectors follow
// moments later once it does. Each incoming 'CSS_SET' message spawns its
// OWN independent async IIFE in the onMessage handler, so if the real
// call's setFrameCss() started running before the fast-path call's had
// finished, BOTH would read the same (stale) `_frameCss.get(key)` and
// could end up calling EXT.scripting.insertCSS TWICE, concurrently, for
// the same frame — with neither having removed the other's sheet first.
// Live-observed on Firefox as `NS_ERROR_ILLEGAL_VALUE` from
// nsIDOMWindowUtils.addSheet on EVERY vnexpress.net load (2026-09-14), not
// just after a background respawn — individually-valid selectors and the
// post-_dedupeCssRules text both ruled out a malformed-CSS explanation
// first. Fixed by serializing calls per key: a second call for the same
// key now waits for the first's insert/remove sequence to fully settle
// before reading `_frameCss`/touching the browser, so the two can never
// overlap.
const _frameCssQueues = new Map(); // key -> tail promise of the chain for that key
function setFrameCss(tabId, frameId, slot, css) {
  if (tabId === undefined || frameId === undefined) return Promise.resolve();
  const key = _frameCssKey(tabId, frameId, slot);
  const prevTail = _frameCssQueues.get(key) || Promise.resolve();
  const tail = prevTail.catch(() => {}).then(() => _setFrameCssImpl(tabId, frameId, key, css));
  _frameCssQueues.set(key, tail);
  return tail;
}

// Live-reported 2026-09-14 ("page load not smooth, flashes") — insert the
// NEW css before removing the OLD one, not the other way around. This used
// to remove `prev` first, then insert `css` — two separate async round
// trips to chrome.scripting.removeCSS()/insertCSS(), with a real gap in
// between where NO hiding css was active at all: on every normal page load
// content.js/site-block.js legitimately supersedes the 'direct' slot's css
// two or three times in quick succession (_fastPathDirectStyle()'s
// immediate guess -> the real selectors -> _reinjectDirectStyleWithGenerics()'s
// expanded set once the async generic-selector survey resolves), and EACH
// supersession hit this gap — whatever was being hidden (ads, clutter)
// flashed visible for a moment, then got hidden again. Reordered so there
// is ALWAYS at least one ruleset active: every rule here is a `display:none`
// hide, so briefly having BOTH old and new active is harmless (idempotent
// cascade); the only behavior change for a genuine "stop hiding this"
// update is that it now stays hidden one round trip longer instead of
// flashing visible then hidden again — strictly better for an ad blocker.
// Also a strictly safer failure mode: if insertCSS throws, `prev` (if any)
// is left untouched/still active instead of having already been removed
// with nothing to replace it. _frameCssQueues' per-key serialization
// (setFrameCss, above) still wraps the whole call, so this reordering is
// entirely internal — no other call can interleave mid-sequence.
async function _setFrameCssImpl(tabId, frameId, key, rawCss) {
  if (_frameCssRaw.get(key) === rawCss) return; // byte-identical resend — skip dedupe/comparison entirely
  _frameCssRaw.set(key, rawCss);
  const css = _dedupeCssRules(rawCss);
  const prev = _frameCss.get(key);
  if (prev === css) return; // no change — already applied (or already absent)
  if (css) {
    try {
      await _insertFrameCss(tabId, frameId, css);
      _frameCss.set(key, css);
    } catch (e) {
      _diagLog('error', '_insertFrameCss FAILED', { key, tabId, frameId, cssLength: css.length, css, error: e && (e.message || e) });
      return; // insert failed — leave `prev` (if any) active rather than removing it and ending up with NOTHING hiding
    }
  } else {
    _frameCss.delete(key);
  }
  if (prev) {
    try { await _removeFrameCss(tabId, frameId, prev); }
    catch (e) { /* frame navigated away mid-flight — fine, nothing to clean up */ }
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
  for (const key of _frameCssRaw.keys()) {
    if (key.startsWith(prefix)) _frameCssRaw.delete(key);
  }
}

async function clearAllFrameCss(tabId, frameId) {
  const prefix = `${tabId}:${frameId}:`;
  for (const [key, css] of Array.from(_frameCss.entries())) {
    if (!key.startsWith(prefix)) continue;
    try { await _removeFrameCss(tabId, frameId, css); } catch (e) {}
    _frameCss.delete(key);
    // Must also forget the RAW text (see _frameCssRaw's own comment): the
    // browser-side CSS was just genuinely removed above, so the NEXT send
    // — even a byte-identical one, e.g. sync()'s own defensive re-send
    // after this exact CSS_CLEAR_ALL — must not be short-circuited as "no
    // change", or it would never actually get re-applied.
    _frameCssRaw.delete(key);
  }
}

EXT.tabs.onRemoved.addListener((tabId) => {
  const prefix = `${tabId}:`;
  for (const key of _frameCss.keys()) {
    if (key.startsWith(prefix)) _frameCss.delete(key);
  }
  for (const key of _frameCssRaw.keys()) {
    if (key.startsWith(prefix)) _frameCssRaw.delete(key);
  }
  _tabBlockedCounts.delete(tabId);
});

// ── In-memory settings cache (for the tabs.onCreated hot path below) ────
// A visible "flash" before a popup tab closes comes from latency between
// tab-creation and the tabs.remove() call — every extra `await` is a real
// IPC round-trip to the storage backend, not memory access, and gives the
// tab another paint frame to become visible/focused first. The hot path
// here makes zero fresh chrome.storage.* calls — it only reads already-
// in-memory state, kept in sync via onChanged instead of read fresh per call.
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
// Single source of truth for each scalar's fallback — both the initial
// object below AND the onChanged listener's "key was removed" branch read
// from this, so the two paths can never disagree with each other.
const _SETTINGS_CACHE_DEFAULTS = {
  enabled: true, collectStats: true, blockAds: true, blockTrackers: true, blockMalware: true,
  gpcSignal: true, referrerAnonymization: true,
};
const _settingsCache = {
  ..._SETTINGS_CACHE_DEFAULTS,
  pausedDomains: new Set(), allowedDomains: new Set(),
};
LocalStorage.get([..._SETTINGS_CACHE_SCALAR_KEYS, 'pausedDomains', 'allowedDomains']).then(r => {
  Object.assign(_settingsCache, r);
  _settingsCache.pausedDomains = new Set(r.pausedDomains || []);
  _settingsCache.allowedDomains = new Set(r.allowedDomains || []);
}).catch(() => {});
EXT.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  // storage.local.clear()/.remove() fires onChanged with newValue===undefined
  // for every key it drops — falling back to the same default a fresh
  // module load would use (instead of leaving the cache holding a bare
  // `undefined`, which reads as "disabled") is what keeps ad/tracker/malware
  // blocking from silently going dark the instant local storage is cleared,
  // until the service worker happens to restart and re-reads from scratch.
  for (const key of _SETTINGS_CACHE_SCALAR_KEYS) {
    if (changes[key]) {
      const { newValue } = changes[key];
      _settingsCache[key] = newValue !== undefined ? newValue : _SETTINGS_CACHE_DEFAULTS[key];
    }
  }
  for (const key of ['pausedDomains', 'allowedDomains']) {
    if (changes[key]) _settingsCache[key] = new Set(changes[key].newValue || []);
  }
});

// ── Popunder/click-hijack tab auto-close ─────────────────────────────
// Closing a spawned tab based on which SITE opened it, not what domain it
// landed on, is the only way to
// catch popups that land on a legitimate destination (e.g. an affiliate-
// tracked redirect to a real travel/shopping site) — no destination
// blocklist can flag those without false-positiving on direct visits to the
// same site. `chrome.tabs.onCreated`'s `openerTabId` is set the same way
// whether the tab was spawned via window.open() or a native `target="_blank"`
// anchor click, so this catches both vectors uniformly, unlike the
// MAIN-world `no_window_open_if`/`disableNewtabLinks` scriptlets which only
// see whichever single vector they specifically proxy.
// Opt-in per site (`close_popunder_tabs = 1` in that site's site-rules.txt
// section) — a curated, opt-in-per-domain model; there is no way to know a
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
  // real-world data has domains with 20-45 TLD variants each (serienstream.*,
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
  const { customRulesText = '' } = await LocalStorage.getRequired('customRulesText');
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
  await LocalStorage.setRequired({ customRulesText: newText, elementRules });
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
  const { customRulesText = '' } = await LocalStorage.getRequired('customRulesText');
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
  await LocalStorage.setRequired({ customRulesText: newText, noWindowOpenRules });
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
  const { customRulesText = '' } = await LocalStorage.getRequired('customRulesText');
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
  await LocalStorage.setRequired({ customRulesText: newText, globalScopeRules });
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
  const { customRulesText = '' } = await LocalStorage.getRequired('customRulesText');
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
  await LocalStorage.setRequired({ customRulesText: newText, siteRuleText });
  await reloadRules();
}

// ── Generic ("low-generic") cosmetic selector hash-bucketing ─────────────
// [global] direct_hide_selectors is the union of every enabled Rule
// Source's DOMAIN-AGNOSTIC hide rules — real EasyList+EasyPrivacy content
// measures ~13,600 entries there, ~96% of them a bare single class/id
// selector (2026-09-13). Sending that whole list to chrome.scripting.
// insertCSS on every single page (the previous behavior) means the
// browser's own style engine evaluates every one of those ~13,600 selectors
// against the DOM on every page, for a page that realistically only ever
// has a handful of matches — the vast majority contribute nothing.
//
// A selector this simple carries no more information than the exact
// class/id token it matches, so it can be
// looked up by HASHING that token instead of being style-engine-matched
// against the whole DOM. content/site-block.js surveys the page's own id/
// class attributes, hashes each token with the identical djb2 formula
// below, and asks GET_GENERIC_SELECTORS for just the matching subset —
// typically single/low-double-digit selectors, not 13,600+. Anything more
// complex than a bare class/id ("high generic" — attribute selectors,
// :has(), combinators, ...) can't be reduced to one lookup key this way and
// keeps the old behavior: sent directly in `global.direct_hide_selectors`,
// unconditionally, same as before this feature existed. host_patterns-
// specific direct_hide_selectors (a real per-domain section) are NOT
// touched by any of this — they're already small and precisely targeted,
// exactly the case this technique doesn't need to help with.
//
// djb2 — MUST mirror content/site-block.js's own copy of this exact
// formula, or every survey silently misses every match (the two sides only
// ever agree by computing the identical hash for the identical token).
function _hashGenericToken(type, s) {
  const len = s.length;
  const step = (len + 7) >>> 3;
  let hash = (type << 5) + type ^ len;
  for (let i = 0; i < len; i += step) hash = (hash << 5) + hash ^ s.charCodeAt(i);
  return hash & 0xFFFFFF;
}
// A bare, single class ('.foo') or id ('#bar') selector — nothing else.
const _SIMPLEST_SELECTOR_RE = /^([.#])([A-Za-z0-9_-]+)$/;

function _classifyGenericSelectors(selectors) {
  const lowGenericMap = new Map(); // hash -> Set<selector> (a hash can collide across different real class/id spellings)
  const highGeneric = [];
  for (const sel of selectors) {
    const m = _SIMPLEST_SELECTOR_RE.exec(sel);
    if (!m) { highGeneric.push(sel); continue; }
    const hash = _hashGenericToken(m[1] === '#' ? 0x23 : 0x2E, m[2]);
    if (!lowGenericMap.has(hash)) lowGenericMap.set(hash, new Set());
    lowGenericMap.get(hash).add(sel);
  }
  return { lowGenericMap, highGeneric };
}

// Memoized the same way _siteConfigGlobalMemo below is (invalidated purely
// by `parsed` reference change, i.e. a real rules reload) — this
// classification is a pure function of the parsed rules, never per-request
// or per-frame, and real content measures thousands of entries, not worth
// recomputing on every GET_SITE_CONFIG/GET_GENERIC_SELECTORS call.
let _genericSelectorsMemo = { parsed: null, lowGenericMap: null, highGeneric: null };
function _getClassifiedGenericSelectors(parsed) {
  if (_genericSelectorsMemo.parsed !== parsed) {
    const { lowGenericMap, highGeneric } = _classifyGenericSelectors((parsed.global && parsed.global.direct_hide_selectors) || []);
    _genericSelectorsMemo = { parsed, lowGenericMap, highGeneric };
  }
  return _genericSelectorsMemo;
}

// In-memory memo for GET_SITE_CONFIG's computed `global` object — see that
// handler's own comment. Never persisted; naturally cleared (and correctly
// recomputed once) on every SW restart, same as every other in-memory memo
// in this file (_customBlockRulesMemo, _remoteMalwareRulesMemo, etc.).
let _siteConfigGlobalMemo = { parsed: null, gpcSignal: null, referrerAnonymization: null, global: null };

// GENERIC_SELECTORS_SURVEY's per-batch CSS slot counter (2026-09-15) — see
// that case's own comment. Module-level (not inside the case block) so it
// actually persists a running count across calls instead of resetting to 0
// on every message.
let _genericSlotCounter = 0;

const settingsController = self.SettingsController.create({
  // getRequired/setRequired/removeRequired (not the tolerant get/set/remove)
  // — same "user-requested mutations need failures to reach the caller"
  // contract this controller's own strict-read/write comment relies on
  // (see its rollback logic and test-settings-controller.js's quota case),
  // matching every other user-triggered-mutation call site in this file.
  storage: { get: LocalStorage.getRequired, set: LocalStorage.setRequired, remove: LocalStorage.removeRequired },
  domainPatternRe: DOMAIN_PATTERN_RE,
  applyNetworkRules,
  applyPrivacy: applyNetworkRules,
  async notify(msg) {
    const tabs = await EXT.tabs.query({}).catch(() => []);
    // Each settings message needs the SAME message type/payload shape its
    // content-script listener (content.js/site-block.js) already expects —
    // collapsing everything into RULES_CHANGED means content.js's
    // disableCosmeticCss() (the only path that un-hides already-hidden
    // elements) never fires, so turning protection off/pausing/disabling
    // cosmetic filtering stops un-hiding ads on already-open tabs.
    let payload;
    if (msg.type === 'SET_PRIVACY') {
      payload = { type: 'PRIVACY_TOGGLE' };
    } else if (msg.type === 'TOGGLE') {
      payload = { type: 'TOGGLE', enabled: msg.enabled };
    } else if (msg.type === 'PAUSE_DOMAIN') {
      payload = { type: 'PAUSE_DOMAIN', domain: msg.domain, paused: msg.paused };
    } else if (msg.type === 'SET_BLOCKING' && msg.setting === 'cosmeticFiltering') {
      payload = { type: 'COSMETIC_TOGGLE', enabled: msg.value };
    } else {
      payload = { type: 'RULES_CHANGED' };
    }
    for (const tab of tabs) {
      EXT.tabs.sendMessage(tab.id, payload).catch(() => {});
      if (tab.url) { try { updateBadgeForTab(tab.id, tab.url); } catch {} }
    }
  },
});

// ── Message handler ───────────────────────────────────────────────
EXT.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {

      case 'CSS_SET': {
        const tabId = sender.tab && sender.tab.id;
        const frameId = sender.frameId;
        _diagLog('log', 'CSS_SET received', { tabId, frameId, slot: msg.slot, fresh: !!msg.fresh, cssLength: (msg.css || '').length, css: msg.css || '', url: sender.tab && sender.tab.url });
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

      case 'TOGGLE':
      case 'PAUSE_DOMAIN':
      case 'SET_BLOCKING':
      case 'SET_PRIVACY':
        sendResponse(await settingsController.handle(msg));
        break;

      case 'SAVE_ELEMENT_RULE': {
        const host = String(msg.host || '').toLowerCase();
        const selector = String(msg.selector || '').trim();
        if (!host || !DOMAIN_PATTERN_RE.test(host) || !selector || selector.length > 500) {
          sendResponse({ ok: false });
          break;
        }
        const safeSelector = selector.replace(/\|/g, '\\|');
        const { elementRules = {} } = await LocalStorage.getRequired('elementRules');
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
        const { elementRules = {} } = await LocalStorage.getRequired('elementRules');
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
        const { noWindowOpenRules = {} } = await LocalStorage.getRequired('noWindowOpenRules');
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
        const { globalScopeRules = {} } = await LocalStorage.getRequired('globalScopeRules');
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
        const { globalScopeRules = {} } = await LocalStorage.getRequired('globalScopeRules');
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
        const { siteRuleText = {} } = await LocalStorage.getRequired('siteRuleText');
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
        const { siteRuleText = {} } = await LocalStorage.getRequired('siteRuleText');
        // Saving an empty (or header-only) textarea is the "clear this
        // site's rules" gesture — no separate REMOVE message needed, unlike
        // the other two pickers' per-item add/remove model.
        if (text) siteRuleText[host] = text; else delete siteRuleText[host];
        await _applySiteRuleText(siteRuleText);
        sendResponse({ ok: true });
        break;
      }

      case 'FOCUS_MODE': {
        await LocalStorage.setRequired({ focusMode: msg.enabled });
        // FocusMode.startSession()/stopSession() (shared/focus-mode.js) own
        // the actual 'focus-end' alarm arming/clearing now — dashboard.js/
        // popup.js still compute and write focusEndTime/focusDuration to
        // storage THEMSELVES before sending this message, unchanged; this
        // just resets the phase/cycle counters to a fresh work phase and
        // arms the alarm against whatever endTime is already there (or
        // clears it on disable) — see that function's own comment.
        if (msg.enabled) {
          await FocusMode.startSession();
        } else {
          await FocusMode.stopSession();
        }
        // No applyNetworkRules() — focusMode/distractionDomains are no
        // longer DNR rule inputs (see content/focus-block-overlay.js).
        sendResponse({ ok: true });
        break;
      }

      case 'ALLOWLIST_CHANGED': {
        { const result = await applyNetworkRules(); if (result?.ok === false) throw new Error(result.error); }
        sendResponse({ ok: true });
        break;
      }

      // Dashboard's per-site time-limit editor (add/remove/edit a limit)
      // sends this after writing to `siteTimeLimits` directly — same shape
      // as ALLOWLIST_CHANGED just above. Recomputes
      // siteLimitsExceededToday WITHOUT attributing any additional time
      // (see FocusMode.recomputeExceededToday()'s own comment), so e.g.
      // raising or removing a limit can immediately un-exceed a site
      // instead of waiting up to a minute for the next tick.
      case 'SITE_LIMITS_CHANGED': {
        // No applyNetworkRules() anymore — siteLimitsExceededToday isn't a
        // DNR rule input (Focus Mode blocking moved to a client-side
        // overlay, content/focus-block-overlay.js, which reacts to this
        // key changing via its own storage.onChanged listener instead).
        await FocusMode.recomputeExceededToday();
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
          const { allowedDomains: current = [] } = await LocalStorage.getRequired('allowedDomains');
          if (!current.includes(host)) {
            await LocalStorage.setRequired({ allowedDomains: [...current, host] });
          }
        } else {
          const { sessionAllowedDomains: current = [] } = await SessionStorage.get('sessionAllowedDomains');
          if (!current.includes(host)) {
            await SessionStorage.set({ sessionAllowedDomains: [...current, host] });
          }
        }
        { const result = await applyNetworkRules(); if (result?.ok === false) throw new Error(result.error); }
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
          const { text: raw } = await ruleFetcher.download(url);
          if (!raw) { sendResponse({ ok: false, error: 'empty response' }); break; }
          const converted = await _maybeConvertAbpText(raw);
          sendResponse({ ok: true, text: converted, wasAbp: converted !== raw });
        } catch (e) {
          sendResponse({ ok: false, error: (e && e.message) || 'fetch failed' });
        }
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
        const { collectStats: collectCH = true } = await LocalStorage.getRequired('collectStats');
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
        const { rules = [] } = await LocalStorage.getRequired('rules');
        for (const r of rules) {
          if (!r.active || r.action !== 'block') continue;
          if (r.type === 'domain' && r.pattern)  adPatterns.push(r.pattern);
          if (r.type === 'keyword' && r.pattern) adPatterns.push(r.pattern);
        }

        sendResponse({ adPatterns, trackerPatterns, malwarePatterns });
        break;
      }

      case 'GET_STATS': {
        const { stats = {} } = await LocalStorage.getRequired('stats');
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
        // Gated by blockAds/blockMalware (2026-09-14) to match
        // _networkBlockRequestHandler's own per-tier gating — NETWORK_BLOCK_
        // MATCHER/NETWORK_BLOCK_COMPLEX are built unconditionally regardless
        // of blockAds, so without this the count would still include them
        // even while that tier is actually toggled off.
        const complexCount = _settingsCache.blockAds ? NETWORK_BLOCK_COMPLEX.reduce((n, bucket) => n + bucket.entries.length, 0) : 0;
        const matcherCount =
          (_settingsCache.blockAds ? _matcherEntryCount(NETWORK_BLOCK_MATCHER) : 0) +
          (_settingsCache.blockMalware ? _matcherEntryCount(MALWARE_PATH_MATCHER) : 0) +
          complexCount;
        sendResponse({ count: rules.length + matcherCount, rules: rules.map(r => r.id) });
        break;
      }

      case 'GET_UPDATE_STATUS': {
        const { updateInfo = {} } = await LocalStorage.getRequired('updateInfo');
        const currentVersion = EXT.runtime.getManifest().version;
        // Re-derive `available` from the CURRENT local version against the
        // cached latestVersion, rather than trusting updateInfo.available
        // as stored — that boolean was computed by checkForExtensionUpdate()
        // against whatever local version was active AT THAT TIME (this only
        // runs for real once/day via maybeCheckForExtensionUpdate()'s TTL,
        // or on an explicit CHECK_FOR_UPDATE_NOW). Live-reported: after
        // rebuilding/reloading the extension to a version that already
        // matches latestVersion, the popup/dashboard kept showing "update
        // available" for up to a day — the stored boolean simply hadn't
        // been recomputed since the local version changed. latestVersion
        // itself staying stale is fine (it's just "what GitHub last had"),
        // but whether that's actually NEWER than THIS install must always
        // be current, since the local version can change (a rebuild/reload)
        // far more often than the once-a-day network check does.
        sendResponse({
          ok: true,
          currentVersion,
          latestVersion: updateInfo.latestVersion || '',
          available: updateInfo.latestVersion ? _isNewerVersion(updateInfo.latestVersion, currentVersion) : false,
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
        const { malwareListCount = 0 } = await LocalStorage.getRequired('malwareListCount');
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
          const host = String(msg.host || '').toLowerCase();
          const { gpcSignal, referrerAnonymization } = _settingsCache;
          // Fast path (2026-09-17, see _tryFastSiteConfig's own comment):
          // getRulesText() only decompresses the cached text (~2ms) — no
          // parse — so a revisited host can skip getParsedRules()'s full
          // parseRuleText() over the whole merged text entirely on a cold
          // service-worker start, IF the text hasn't changed since this
          // host's answer was last computed (hash-gated, never a guess).
          const text = await getRulesText();
          const textHash = _hashText(text);
          const fast = await _tryFastSiteConfig(host, textHash, gpcSignal, referrerAnonymization);
          if (fast) { sendResponse(fast); break; }

          const parsed = await getParsedRules();
          const siteKey = resolveSiteKey(parsed.host_patterns || {}, host);
          // gpcSignal/referrerAnonymization are chrome.storage privacy
          // toggles, not site-rules.txt keys — synthesized here as flag-style
          // global entries so they ride the same SCRIPTLET_KEYS pipeline as
          // every other MAIN-world scriptlet, with no [global] override path
          // to worry about (see background.js:1305-1345 applyPrivacySettings).
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
            // Only the "high generic" subset goes out here — the ~96% that
            // are a bare class/id selector are held back in the hash-bucket
            // map instead, resolved on demand via GET_GENERIC_SELECTORS
            // (see _classifyGenericSelectors' own comment for why).
            global.direct_hide_selectors = _getClassifiedGenericSelectors(parsed).highGeneric;
            if (gpcSignal) global.gpc_signal = ['1'];
            if (referrerAnonymization) global.hide_document_referrer = ['1'];
            _siteConfigGlobalMemo = { parsed, gpcSignal, referrerAnonymization, global };
          }
          const site = (siteKey && parsed[siteKey]) || {};
          _enqueueSiteConfigCacheSave(host, siteKey, site, global, textHash, gpcSignal, referrerAnonymization); // fire-and-forget, serialized
          sendResponse({ siteKey, global, site });
        } catch {
          sendResponse(null);
        }
        break;
      }

      case 'GET_GENERIC_SELECTORS': {
        // content/site-block.js's DOM surveyor — see _classifyGenericSelectors'
        // own comment for the full picture. `msg.hashes` are id/class tokens
        // actually observed in the requesting frame's own DOM; only ever
        // returns the (typically tiny) matching subset of [global]'s
        // low-generic bucket, never the full list.
        try {
          const parsed = await getParsedRules();
          const { lowGenericMap } = _getClassifiedGenericSelectors(parsed);
          const hashes = Array.isArray(msg.hashes) ? msg.hashes : [];
          const out = new Set();
          for (const h of hashes) {
            const bucket = lowGenericMap.get(h);
            if (bucket) for (const sel of bucket) out.add(sel);
          }
          sendResponse({ selectors: Array.from(out) });
        } catch {
          sendResponse({ selectors: [] });
        }
        break;
      }

      // content/site-block.js's per-mutation generic-selector survey
      // (2026-09-15, replaces its own separate GET_GENERIC_SELECTORS +
      // CSS_SET reinject pair for this ONE call site — GET_GENERIC_SELECTORS
      // itself is untouched, still used by boot()'s post-reset reconciliation
      // survey). Same hash→selector lookup as GET_GENERIC_SELECTORS above,
      // but also APPLIES the result as CSS in this SAME round trip, instead
      // of making the content script send a second message to do that.
      // Matters specifically here (unlike most other CSS sends) because this
      // fires on EVERY newly-seen id/class token for the page's entire
      // lifetime on a continuously content-injecting page (infinite scroll,
      // ad-refresh — live-reported repeatedly on vnexpress.net) — halving
      // the round trips halves how long each new ad-slot element stays
      // visible before being hidden.
      //
      // Uses a FRESH, never-reused, never-removed-until-navigation slot key
      // per batch (`direct-generic-N`) rather than merging into the 'direct'
      // slot itself: background has no visibility into content script's own
      // _cachedDirect/_matchedGenericSelectors state, so it can't safely
      // build the FULL merged CSS text itself (two concurrent batches for
      // the same frame could each read a stale baseline and the second
      // write would silently drop the first's additions). Every generic
      // match is always a simple, standalone `display:none` rule (see
      // _scopedDirectRule in site-block.js) — purely additive, never
      // scoped/transformed — so giving each batch its own slot sidesteps
      // the merge problem entirely: `_frameCssQueues`' per-key serialization
      // never contends across different batches' keys, and `clearFrameCss`/
      // `clearAllFrameCss` already sweep every key under the tab/frame
      // prefix regardless of slot name, so these are torn down for free on
      // navigation — no new cleanup code needed. Never touches the 'direct'
      // slot itself.
      //
      // Accepted trade-off: no cap on how many direct-generic-N slots (and
      // matching insertCSS calls) accumulate over a single very long
      // infinite-scroll session — each is tiny/harmless on its own; a
      // periodic consolidation pass (insert one squashed slot, remove the
      // per-batch ones only after that succeeds — same insert-before-remove
      // ordering _setFrameCssImpl already uses) would be the follow-up if
      // this ever proves to matter in practice.
      case 'GENERIC_SELECTORS_SURVEY': {
        const tabId = sender.tab && sender.tab.id;
        const frameId = sender.frameId;
        try {
          const parsed = await getParsedRules();
          const { lowGenericMap } = _getClassifiedGenericSelectors(parsed);
          const hashes = Array.isArray(msg.hashes) ? msg.hashes : [];
          const out = new Set();
          for (const h of hashes) {
            const bucket = lowGenericMap.get(h);
            if (bucket) for (const sel of bucket) out.add(sel);
          }
          const selectors = Array.from(out);
          if (selectors.length && tabId !== undefined && frameId !== undefined) {
            const css = selectors.map(s => `${s}{display:none!important}`).join('\n\n');
            setFrameCss(tabId, frameId, `direct-generic-${++_genericSlotCounter}`, css).catch(() => {});
          }
          sendResponse({ selectors });
        } catch {
          sendResponse({ selectors: [] });
        }
        break;
      }

      case 'GET_MALWARE_STATUS': {
        await ensureRuleDefinitionsLoaded();
        const { malwareListLastUpdate = 0, malwareListCount = 0 } = await LocalStorage.getRequired(['malwareListLastUpdate', 'malwareListCount']);
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
        const { collectStats: collectMB = true } = await LocalStorage.getRequired('collectStats');
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
        const { collectStats: collectAB = true } = await LocalStorage.getRequired('collectStats');
        if (!collectAB) { sendResponse({ ok: true }); break; }
        _enqueueStatWrite(() => _writeDomainStatDelta(host, { adsBlocked: 1, totalSeen: 1 }));
        updateDailyStats({ blocked: 1, ads: 1, trackers: 0, malware: 0 });
        _incrementTabBlocked(sender.tab && sender.tab.id, 1);
        sendResponse({ ok: true });
        break;
      }

      case 'FOCUS_PAGE_BLOCKED': {
        // Sent by content/focus-block-overlay.js once per page load, the
        // moment it draws its overlay over a distraction-list/limit-
        // exceeded site — that content script (not a DNR redirect to
        // blocked.html; there is no network-level block for Focus Mode at
        // all anymore, see that file's own header comment) is the only
        // place that knows a block just happened, so it's the only way
        // these get counted, same reasoning as MALWARE_PAGE_BLOCKED/
        // AD_POPUP_PAGE_BLOCKED above. Deliberately NOT folded into
        // dailyStats/domain stats (updateDailyStats's ads/trackers/malware
        // breakdown has no category that honestly fits a self-imposed
        // block) — just the per-tab counter so the badge reflects it.
        const host = String(msg.host || '').toLowerCase();
        if (!host || !DOMAIN_PATTERN_RE.test(host)) { sendResponse({ ok: false }); break; }
        _incrementTabBlocked(sender.tab && sender.tab.id, 1);
        sendResponse({ ok: true });
        break;
      }

      case 'RESET': {
        await LocalStorage.clearRequired();
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
  })().catch(error => {
    console.error('[AdBlock] Message failed:', msg?.type, error);
    sendResponse({ ok: false, error: error.message || 'Operation failed' });
  });
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

EXT.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const tab = await EXT.tabs.get(tabId).catch(() => null);
  if (!tab?.url) return;
  updateBadgeForTab(tabId, tab.url);
  // Covers the case windows.onFocusChanged (above) can't: the ACTIVE TAB
  // changing WITHIN an already-focused window (e.g. Ctrl+Tab), with no
  // window-focus event of its own. Only update FocusMode's tracking if this
  // activation happened in the window that's actually OS-focused right
  // now — an activation in some background window must never overwrite it.
  if (windowId === _focusedWindowId) {
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch { domain = ''; }
    FocusMode.setActiveTab(domain);
  }
});

EXT.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // changeInfo.url is only present when the tab actually navigated to a new
  // URL (not on every status tick) — that's the per-tab block count's reset
  // point: "new page, new count".
  if (changeInfo.url) {
    _tabBlockedCounts.delete(tabId);
    _setTabBadge(tabId);
  }
  if (changeInfo.status === 'complete' && tab.url) {
    updateBadgeForTab(tabId, tab.url);
    // Same gating as onActivated above: a BACKGROUND tab finishing its own
    // navigation (tab.active === false, or in some other window) must never
    // overwrite what the user is actually looking at.
    if (tab.active && tab.windowId === _focusedWindowId) {
      let domain = '';
      try { domain = new URL(tab.url).hostname; } catch { domain = ''; }
      FocusMode.setActiveTab(domain);
    }
  }
});

