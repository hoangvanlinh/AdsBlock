// ABP/uBO conversion engine. Browser I/O and DNR validation are injected by the caller.
(function (root) {
function create({ fetchLocalRuleText, parseRuleText, _resolveRedirectResourceName, _isValidUrlFilter, getDomainPatternRe }) {
// ── ABP-style format auto-detect + convert (Rule Source "Add URL") ──────
// Ported from scripts/convert-uassets.js's own tested parseFile/finalizeGroups/
// render (this repo's own code, previously offline-only — ran via
// `node scripts/convert-uassets.js`, never inside the actual extension).
// parseRuleText() below only understands this repo's own [section]/key=value
// grammar, so a Rule Source URL/file in raw ABP-style syntax (! comments,
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
// DNR resourceType for each ABP-style single-content-type option token this
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
// Just the DNR-side values (buildNetworkRedirectRules' own validation of an
// optional hand-written 3rd field — see its comment) — a Set since it's a
// membership check, not the ABP-token-name-keyed lookup above.
const ABP_RESOURCE_TYPE_VALUES = new Set(Object.values(ABP_RESOURCE_TYPE_MAP));
// chrome.declarativeNetRequest.RequestMethod's own enum — an ABP `$method=`
// value outside this set can't be mapped, so the whole option is unsupported.
const ABP_REQUEST_METHODS = new Set(['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put']);

// Parses one ABP-style network-rule option string (everything after the '$',
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
// one build that produced them (regenerated on the site's next deploy).
// Threshold is 8+ digits, not 6+: real ad-dimension classes concatenate two
// 3-digit numbers (`.ad-300250` = 300x250) and land at exactly 6 digits —
// 8+ avoids that false positive while still catching real hashes/
// timestamps (9-10 digits). Only applied to global/bucket selectors (see
// _abpParseFile's own comment on isDedicatedSingleDomain) — a dedicated
// single-domain rule keeps a hash-qualified selector even though it may go
// stale on the next rebuild, since it costs nothing outside that one site
// and is sometimes the only way to pin down an element on a page that
// otherwise reuses generic classes everywhere.
const ABP_LOW_VALUE_HASH_RE = /-\d{8,}\b/;

// This repo's own grammar always opens with a [section] header (after
// optional #/; comment lines) — ABP-style text uses ! comments and has no
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
    // A bracket-prefixed line with more content AFTER its closing ']' can
    // never be this repo's own [section] header (always exactly "[name]",
    // the WHOLE line, nothing trailing) — it's some other bracket-leading
    // syntax instead, most commonly AdGuard's own '[$path=...]'-style
    // extended-modifier prefix on an otherwise-ordinary rule (e.g.
    // '[$path=/images]domain##selector'). Finding one this early is
    // decisive proof of ABP format, same reasoning as the Adblock Plus
    // version-marker check just above for a different '['-starting shape —
    // without this, a source whose very FIRST rule happens to carry this
    // modifier misdetects as "already native" and never converts at all
    // (live-reproduced 2026-09-07 while adding '$path=' support itself).
    const closeIdx = line.indexOf(']');
    if (line.charAt(0) === '[' && closeIdx !== -1 && closeIdx !== line.length - 1) return true;
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
// the generic formatter above: real-world rpnt/trusted-rpnt rules trail
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

// Classifies an AdGuard '#$#selector { declarations }' CSS-injection rule
// body. Three real destinations:
//   'hide'          — direct_hide_selectors (existing mechanism, unchanged)
//   'strip-overflow'— the existing strip_inline_styles mechanism (unchanged)
//   'force'         — NEW (2026-09-07): direct_style_rules, a verbatim CSS
//                      injection primitive (see its own handling below) for
//                      everything else this repo previously left unsupported
//                      — force-showing an element via display:block, and any
//                      other single or COMPOUND declaration block. Safe to
//                      inject as literal CSS text unexamined: unlike a
//                      scriptlet, CSS can't execute code, navigate, or read
//                      page data — worst case is a wrong visual on one site,
//                      the same risk direct_hide_selectors' arbitrary
//                      selectors already carry, not a new category of harm.
// Only 'remove: true' (AdGuard's own element-REMOVAL directive, not a real
// CSS property — would silently no-op as literal CSS) gets special-cased to
// 'hide' instead of 'force': display:none achieves the same practical
// "gone" effect without this repo needing actual DOM-removal machinery.
// Audited against a real-world AdGuard list (AdguardTeam/AdguardFilters'
// AnnoyancesFilter/Popups/sections/antiadblock.txt, 2026-09-07).
function _abpClassifyCssInjection(declText) {
  const decls = declText.split(';').map(d => d.trim()).filter(Boolean);
  if (!decls.length) return null;
  if (decls.length === 1) {
    const m = /^([a-z-]+)\s*:\s*(.+?)\s*(?:!important)?$/i.exec(decls[0]);
    if (m) {
      const prop = m[1].toLowerCase();
      const value = m[2].trim().toLowerCase();
      if (prop === 'display' && value.startsWith('none')) return 'hide';
      if (prop === 'visibility' && value.startsWith('hidden')) return 'hide';
      if (prop === 'remove' && value === 'true') return 'hide';
      // Restoring scroll only makes sense as NOT 'hidden' — a rule that
      // itself sets overflow:hidden is the opposite intent (locking, not
      // unlocking) and has no equivalent mechanism here either.
      if ((prop === 'overflow' || prop === 'overflow-x' || prop === 'overflow-y') && !value.startsWith('hidden')) return 'strip-overflow';
    }
  }
  // Fallback: 'force', but only if every declaration at least LOOKS like
  // real CSS ('prop: value') — rejects genuine garbage (e.g. AdGuard's own
  // 'remove: true' already peeled off above, or a stray non-declaration
  // token) rather than injecting it verbatim.
  if (!decls.every(d => /^[a-z-]+\s*:\s*\S/i.test(d))) return null;
  return 'force';
}

// AdGuard's own '$path=' extended-modifier value: a value wrapped in
// '/.../' is a regex (its source used as-is, delimiters stripped); any other
// value is a plain string meaning a path PREFIX — escaped here so any
// regex-special characters in it (e.g. a literal '.' in '/pogoda.html') are
// matched literally, then anchored at the start. Returns null for a regex
// value that doesn't actually compile (malformed source in the wild), so
// the caller can drop the line instead of shipping a broken RegExp.
function _abpPathModifierToRegexSource(value) {
  if (value.length > 1 && value.charAt(0) === '/' && value.charAt(value.length - 1) === '/') {
    const source = value.slice(1, -1);
    try { new RegExp(source); } catch { return null; }
    return source;
  }
  return '^' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Encodes an optional path-condition onto a direct_hide_selectors/scriptlet
// value string — this repo's site-rules.txt grammar has no separate key for
// "only on pages whose path matches X" (AdGuard's own '$path=' modifier, see
// _abpPathModifierToRegexSource above), so the condition rides along INSIDE
// the string itself using a control character (0x01) as the delimiter —
// never appears in real CSS selectors or scriptlet arguments, unlike any
// printable choice ('::' collides with real CSS pseudo-elements like
// '::before', for instance). content/site-block.js's _stripPathScope() is
// the matching decode side — the ONE place (content script, not the service
// worker) that already knows the current page's real location.pathname —
// and is the only consumer that ever needs to understand this format; every
// other reader of these values (parseRuleText, the dashboard's raw-text
// views, _abpEscapeValue's '|'-only escaping) treats it as an opaque string
// and passes it through untouched, exactly as before. A prefix with an empty
// pathRegexSource (the overwhelmingly common case — no '$path=' on the
// source rule) is a no-op, returning `value` completely unchanged.
function _abpEncodePathScope(pathRegexSource, value) {
  return pathRegexSource ? '\x01' + pathRegexSource + '\x01' + value : value;
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
        // matters): (a) a rule carrying a $redirect=/$redirect-rule= that
        // resolves to a resource this extension actually ships
        // (network_redirect_rules, background.js's buildNetworkRedirectRules)
        // — bare-domain patterns are included here too (2026-09-11; used to
        // be excluded on the theory that ad_network_patterns already blocks
        // that domain outright, but that reasoning didn't hold: a bare
        // domain with an unresolvable option like $redirect= never actually
        // REACHES ad_network_patterns — ABP_SIMPLE_NETWORK_OPTS_RE only
        // allows third-party/all, nothing else — so it fell through to
        // _abpParseNetworkOptions below, which has no representation for a
        // redirect target either, and got dropped as complexNetwork with
        // ZERO effect: not blocked, not redirected. A real-world case that
        // motivated the fix: `||static.eclick.vn^$image,redirect=1x1.gif` —
        // an ad CDN subdomain some sites bait-load to detect adblockers by
        // checking onerror/onload, where an outright block IS visibly
        // different from a "succeeded" 1x1 placeholder); (b) a bare
        // $removeparam=name (optionally with third-party) — maps
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
        if (file) {
          const isBareDomain = ABP_BARE_NETWORK_DOMAIN_RE.test(pattern);
          // A bare-domain pattern's stored token must NOT carry the trailing
          // '^' separator — buildNetworkRedirectRules treats a slash-free
          // pattern as a literal hostname for requestDomains, not a urlFilter
          // (real domains never contain '^'). The '*' TLD-wildcard shape
          // ABP_BARE_NETWORK_DOMAIN_RE also allows (e.g. "example.*^") isn't
          // a literal domain either — DOMAIN_PATTERN_RE rejects it, same
          // "don't guess" drop as everywhere else here.
          const redirectPattern = isBareDomain ? pattern.slice(0, -1).toLowerCase() : pattern;
          if (isBareDomain && !getDomainPatternRe().test(redirectPattern)) {
            s.complexNetwork++;
          } else {
            // A single, unambiguous resourceType alongside $redirect= (e.g.
            // $image,redirect=1x1.gif) is carried through as an explicit 3rd
            // field so buildNetworkRedirectRules can honor it instead of
            // always assuming 'script' — see that function's own comment.
            // Anything less clear-cut (no type option, more than one, a
            // negated one, $domain=, ...) still converts, just without a
            // type restriction — the pre-existing script-only behavior,
            // never a regression from not recognizing this case at all.
            const typeToks = optTokens.filter(t => t !== redirectTok && t !== 'third-party' && t !== '~third-party');
            const singleType = typeToks.length === 1 && typeToks[0].charAt(0) !== '~' ? ABP_RESOURCE_TYPE_MAP[typeToks[0]] : null;
            networkRedirects.add(redirectPattern + ' ' + file + (singleType ? ' ' + singleType : ''));
            s.converted++;
          }
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
    // specifically so OTHER exception rules can't cancel it (a real
    // convention some filter lists rely on). Since this repo's dispatch has
    // no cancellation concept
    // at all, that distinction is moot here — a '#@#+js(...)' scriptlet
    // call behaves identically to a '##+js(...)' one, so it's handled the
    // same way instead of being dropped like a plain cosmetic exception.
    // AdGuard's own JS-injection separators: '#%#//scriptlet(...)' (apply)
    // and '#@%#//scriptlet(...)' (exception form — same "no cancellation
    // model here, so it behaves identically to the apply form" reasoning as
    // '#@#+js(...)' above). Only the standardized //scriptlet(name, args...)
    // call wrapper is recognized — that's what AdGuard's own public filter
    // lists use for cross-engine portability; bare
    // '#%#<arbitrary JS>' has no equivalent here (same as an arbitrary '#@#'
    // cosmetic exception) and falls through to unrecognized below. Checked
    // as its own marker pair (not folded into the '##'/'#@#' pair) because
    // its content starts right after an already-consumed '(' rather than
    // needing the '+js(' prefix check '##'-based scriptlet calls use.
    const ADG_SCRIPTLET_MARKER = '#%#//scriptlet(';
    const ADG_SCRIPTLET_EXC_MARKER = '#@%#//scriptlet(';
    // AdGuard's ExtendedCSS elemhide markers ('#?#'/'#@?#') — semantically
    // IDENTICAL to '##'/'#@#' (same direct_hide_selectors destination, same
    // ABP_PROCEDURAL_RE filtering of genuinely ExtCSS-only operators below);
    // AdGuard just uses a different marker to tell its OWN engine "run this
    // through the ExtendedCSS matcher, not native querySelectorAll" — a
    // distinction this repo's dispatch (native CSS engine only) doesn't need
    // to make, so these fall through the exact same code path as '##'.
    const EXTCSS_HIDE_MARKER = '#?#';
    const EXTCSS_HIDE_EXC_MARKER = '#@?#';
    // AdGuard's CSS-injection markers ('#$#'/'#@$#' plain, '#$?#'/'#@$?#'
    // ExtendedCSS-selector variant) — carry a full 'selector { declarations }'
    // CSS rule rather than a bare selector, so unlike every marker above they
    // get their OWN handling block below (_abpClassifyCssInjection) instead
    // of falling into the plain-selector path.
    const CSS_INJECT_MARKER = '#$#';
    const CSS_INJECT_EXC_MARKER = '#@$#';
    const CSS_INJECT_EXTCSS_MARKER = '#$?#';
    const CSS_INJECT_EXTCSS_EXC_MARKER = '#@$?#';
    const excIdx = line.indexOf('#@#');
    const hideIdx = line.indexOf('##');
    const adgIdx = line.indexOf(ADG_SCRIPTLET_MARKER);
    const adgExcIdx = line.indexOf(ADG_SCRIPTLET_EXC_MARKER);
    const extcssIdx = line.indexOf(EXTCSS_HIDE_MARKER);
    const extcssExcIdx = line.indexOf(EXTCSS_HIDE_EXC_MARKER);
    const cssInjIdx = line.indexOf(CSS_INJECT_MARKER);
    const cssInjExcIdx = line.indexOf(CSS_INJECT_EXC_MARKER);
    const cssInjExtcssIdx = line.indexOf(CSS_INJECT_EXTCSS_MARKER);
    const cssInjExtcssExcIdx = line.indexOf(CSS_INJECT_EXTCSS_EXC_MARKER);
    let sepIdx = -1, sepLen = 0, isException = false, isAdgScriptletMarker = false, isCssInjectionMarker = false;
    for (const cand of [
      { idx: hideIdx, len: 2, exc: false, adg: false, css: false },
      { idx: excIdx, len: 3, exc: true, adg: false, css: false },
      { idx: adgIdx, len: ADG_SCRIPTLET_MARKER.length, exc: false, adg: true, css: false },
      { idx: adgExcIdx, len: ADG_SCRIPTLET_EXC_MARKER.length, exc: true, adg: true, css: false },
      { idx: extcssIdx, len: EXTCSS_HIDE_MARKER.length, exc: false, adg: false, css: false },
      { idx: extcssExcIdx, len: EXTCSS_HIDE_EXC_MARKER.length, exc: true, adg: false, css: false },
      { idx: cssInjIdx, len: CSS_INJECT_MARKER.length, exc: false, adg: false, css: true },
      { idx: cssInjExcIdx, len: CSS_INJECT_EXC_MARKER.length, exc: true, adg: false, css: true },
      { idx: cssInjExtcssIdx, len: CSS_INJECT_EXTCSS_MARKER.length, exc: false, adg: false, css: true },
      { idx: cssInjExtcssExcIdx, len: CSS_INJECT_EXTCSS_EXC_MARKER.length, exc: true, adg: false, css: true },
    ]) {
      if (cand.idx !== -1 && (sepIdx === -1 || cand.idx < sepIdx)) {
        sepIdx = cand.idx; sepLen = cand.len; isException = cand.exc; isAdgScriptletMarker = cand.adg; isCssInjectionMarker = cand.css;
      }
    }
    if (sepIdx === -1) { s.total++; s.unrecognized++; continue; }

    let domainPart = line.slice(0, sepIdx);
    const selectorPart = line.slice(sepIdx + sepLen);

    if (!selectorPart) { s.total++; s.unrecognized++; continue; }
    s.total++;
    const isUboScriptletCall = selectorPart.indexOf('+js(') === 0 && selectorPart.charAt(selectorPart.length - 1) === ')';
    // The ADG marker already consumed the '//scriptlet(' opening above —
    // selectorPart just needs a matching trailing ')' to be well-formed.
    const isAdgScriptletCall = isAdgScriptletMarker && selectorPart.charAt(selectorPart.length - 1) === ')';
    const isScriptletCall = isUboScriptletCall || isAdgScriptletCall;
    // A '#%#'/'#@%#' line is ALWAYS a scriptlet attempt, never a cosmetic
    // selector — unlike the '##'/'#@#' path below, there's no legitimate
    // fallback interpretation for a malformed one, so drop it here instead
    // of letting it fall through to the cosmetic-selector handling further
    // down (which would otherwise wrongly treat raw JS/malformed scriptlet
    // text as a CSS selector to hide).
    if (isAdgScriptletMarker && !isScriptletCall) { s.unrecognized++; continue; }
    // CSS-injection exception markers ('#@$#'/'#@$?#') get the same "no
    // cancellation model, behaves like the apply form" treatment as
    // '#@#+js(...)'/'#@%#//scriptlet(...)' above — exempted from the
    // plain-exception drop below so they reach the CSS-injection handling
    // block instead.
    if (isException && !isScriptletCall && !isCssInjectionMarker) { s.exception++; continue; } // plain cosmetic exception — unsupported, dropped
    // AdGuard's own '[$...]' extended-modifier prefix — only '[$path=...]'
    // is understood (see _abpPathModifierToRegexSource); any OTHER modifier
    // ('$domain=', '$app=', ...) is left unsupported/dropped exactly as
    // before, rather than guessed at. A matched '[$path=...]' is stripped
    // off domainPart (so every downstream _abpParseDomainPart call below
    // sees the real domain list, not the bracket) and its compiled regex
    // source rides along on the eventual selector/scriptlet value instead —
    // see _abpEncodePathScope's own comment for why (this repo's grammar has
    // no separate "path condition" key), decoded and enforced entirely by
    // content/site-block.js's _stripPathScope() at apply time, the one place
    // that actually knows the current page's location.pathname.
    let pathPrefix = '';
    if (domainPart.trim().charAt(0) === '[') {
      const pathMatch = /^\[\$path=(.*)\]/.exec(domainPart.trim());
      if (!pathMatch) { s.adguardExtended++; continue; }
      const regexSource = _abpPathModifierToRegexSource(pathMatch[1]);
      if (!regexSource) { s.unrecognized++; continue; }
      pathPrefix = regexSource;
      domainPart = domainPart.trim().slice(pathMatch[0].length);
    }

    if (isScriptletCall) {
      const inner = isUboScriptletCall ? selectorPart.slice(4, -1) : selectorPart.slice(0, -1);
      const parts = _abpSplitScriptletArgs(inner);
      const name = (parts.shift() || '').trim();
      const mapping = self.SCRIPTLET_ALIAS_MAP && self.SCRIPTLET_ALIAS_MAP[name];
      if (!mapping || !domainPart) { s.unmappedScriptlet++; continue; }
      const value = mapping.flag ? '1'
        : mapping.key === 'trusted_replace_script_text' ? _abpFormatTrustedReplaceScriptText(parts)
        : _abpFormatScriptletValue(mapping, parts);
      if (value === null) { s.unmappedScriptlet++; continue; }
      const { domains, hasGlobal, dedupSkipped } = _abpParseDomainPart(domainPart, curatedPatterns);
      const encodedValue = _abpEncodePathScope(pathPrefix, value);
      if (hasGlobal) {
        if (!globalScriptlets.has(mapping.key)) globalScriptlets.set(mapping.key, new Set());
        globalScriptlets.get(mapping.key).add(encodedValue);
      }
      for (const d of domains) {
        if (!domainScriptlets.has(d)) domainScriptlets.set(d, new Map());
        const perKey = domainScriptlets.get(d);
        if (!perKey.has(mapping.key)) perKey.set(mapping.key, new Set());
        perKey.get(mapping.key).add(encodedValue);
      }
      if (domains.length || hasGlobal) s.converted++;
      else if (dedupSkipped) s.dedupSkipped++;
      else s.unrecognized++;
      continue;
    }

    if (isCssInjectionMarker) {
      // selectorPart is the raw 'selector { declarations }' body. Only a
      // single trailing rule block is accepted — anything before an
      // unmatched '{' or after the closing '}' means this isn't the simple
      // one-rule shape this repo can safely interpret.
      const cssMatch = /^(.*)\{([^{}]*)\}\s*$/.exec(selectorPart);
      if (!cssMatch) { s.unrecognized++; continue; }
      const cssSelector = cssMatch[1].trim();
      const declText = cssMatch[2].trim();
      if (!cssSelector || !declText) { s.unrecognized++; continue; }
      if (ABP_PROCEDURAL_RE.test(cssSelector)) { s.procedural++; continue; }
      const kind = _abpClassifyCssInjection(declText);
      if (!kind) { s.unrecognized++; continue; } // still-unrecognized declaration shape (fails even the basic 'prop: value' sanity check)
      const { domains, hasGlobal, dedupSkipped } = _abpParseDomainPart(domainPart, curatedPatterns);
      if (kind === 'hide') {
        const isDedicatedSingleDomain = domains.length === 1 && !hasGlobal;
        if (!isDedicatedSingleDomain && ABP_LOW_VALUE_HASH_RE.test(cssSelector)) { s.lowValueHash++; continue; }
        const encodedSelector = _abpEncodePathScope(pathPrefix, cssSelector);
        if (hasGlobal) globalSelectors.add(encodedSelector);
        for (const d of domains) {
          if (!domainSelectors.has(d)) domainSelectors.set(d, new Set());
          domainSelectors.get(d).add(encodedSelector);
        }
      } else if (kind === 'force') {
        // NEW (2026-09-07): direct_style_rules — a verbatim-CSS-injection
        // key, content/site-block.js appends each entry's ALREADY-COMPLETE
        // 'selector{declarations}' text straight into the same 'direct' CSS
        // slot direct_hide_selectors already uses (just not auto-wrapped in
        // '{display:none!important}' the way a bare hide selector is — this
        // one already carries its own full declaration block). Reuses the
        // SAME low-value-hash guard as 'hide' above, keyed off the selector
        // half only (a volatile per-build hash class is exactly as
        // low-value here as it is for a plain hide rule).
        const isDedicatedSingleDomain = domains.length === 1 && !hasGlobal;
        if (!isDedicatedSingleDomain && ABP_LOW_VALUE_HASH_RE.test(cssSelector)) { s.lowValueHash++; continue; }
        const DIRECT_STYLE_RULES_KEY = 'direct_style_rules';
        const ruleText = _abpEncodePathScope(pathPrefix, cssSelector + '{' + declText + '}');
        if (hasGlobal) {
          if (!globalScriptlets.has(DIRECT_STYLE_RULES_KEY)) globalScriptlets.set(DIRECT_STYLE_RULES_KEY, new Set());
          globalScriptlets.get(DIRECT_STYLE_RULES_KEY).add(ruleText);
        }
        for (const d of domains) {
          if (!domainScriptlets.has(d)) domainScriptlets.set(d, new Map());
          const perKey = domainScriptlets.get(d);
          if (!perKey.has(DIRECT_STYLE_RULES_KEY)) perKey.set(DIRECT_STYLE_RULES_KEY, new Set());
          perKey.get(DIRECT_STYLE_RULES_KEY).add(ruleText);
        }
      } else {
        // pathPrefix is deliberately NOT applied here — strip_inline_styles
        // isn't selector-scoped at apply time either (see its own comment
        // below), so a per-rule path condition wouldn't have anywhere
        // meaningful to attach; no real-world source has combined '$path='
        // with an overflow-restore '#$#' rule so far (audited 2026-09-07).
        // 'strip-overflow' — reuses the EXISTING strip_inline_styles
        // mechanism (content/site-block.js: removes a matching inline style
        // property found on a scanned element) instead of a new primitive.
        // Not selector-scoped there (it's a flat per-site property list, see
        // its own comment), so cssSelector itself isn't used beyond having
        // proven this is a genuine single-declaration overflow-restore rule —
        // safe even when the site actually locks scroll via a CSS class
        // rather than an inline style: this then simply strips nothing
        // (no-op), never the wrong thing.
        const STRIP_INLINE_STYLES_KEY = 'strip_inline_styles';
        if (hasGlobal) {
          if (!globalScriptlets.has(STRIP_INLINE_STYLES_KEY)) globalScriptlets.set(STRIP_INLINE_STYLES_KEY, new Set());
          globalScriptlets.get(STRIP_INLINE_STYLES_KEY).add('overflow');
        }
        for (const d of domains) {
          if (!domainScriptlets.has(d)) domainScriptlets.set(d, new Map());
          const perKey = domainScriptlets.get(d);
          if (!perKey.has(STRIP_INLINE_STYLES_KEY)) perKey.set(STRIP_INLINE_STYLES_KEY, new Set());
          perKey.get(STRIP_INLINE_STYLES_KEY).add('overflow');
        }
      }
      if (domains.length || hasGlobal) s.converted++;
      else if (dedupSkipped) s.dedupSkipped++;
      else s.unrecognized++;
      continue;
    }

    if (ABP_PROCEDURAL_RE.test(selectorPart)) { s.procedural++; continue; }

    if (!domainPart) {
      // No domain at all -> the [global] pool, shared across every site
      // that inherits it wholesale. A volatile per-build hash class here
      // would be dead weight for the vast majority of sites it never
      // actually matches, so the low-value filter always applies.
      if (ABP_LOW_VALUE_HASH_RE.test(selectorPart)) { s.lowValueHash++; continue; }
      globalSelectors.add(_abpEncodePathScope(pathPrefix, selectorPart)); s.converted++; continue;
    }

    const { domains, hasGlobal, dedupSkipped } = _abpParseDomainPart(domainPart, curatedPatterns);
    // A line naming exactly ONE specific domain (not a `,`-joined bucket,
    // not `*`) is that domain's OWN dedicated rule — unlike a bucket/global
    // selector, it can never leak into an unrelated site's ruleset, so a
    // volatile per-build hash class (e.g. tinhte.vn's styled-jsx
    // `jsx-XXXXXXXXXX` scoping classes) is worth keeping even though it may
    // go stale on the next site rebuild: it costs nothing elsewhere, and a
    // hash-qualified compound selector (".main.jsx-2126301199") is often
    // the ONLY way a filter-list author had to pin down one specific
    // element on a site that reuses generic classes everywhere.
    const isDedicatedSingleDomain = domains.length === 1 && !hasGlobal;
    if (!isDedicatedSingleDomain && ABP_LOW_VALUE_HASH_RE.test(selectorPart)) { s.lowValueHash++; continue; }
    const encodedSelectorPart = _abpEncodePathScope(pathPrefix, selectorPart);
    if (hasGlobal) globalSelectors.add(encodedSelectorPart);
    for (const d of domains) {
      if (!domainSelectors.has(d)) domainSelectors.set(d, new Set());
      domainSelectors.get(d).add(encodedSelectorPart);
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


return { ABP_SIMPLE_NETWORK_OPTS_RE, NETWORK_RULE_BUDGET, ABP_RESOURCE_TYPE_VALUES, _abpParseNetworkOptions, _abpEncodeNetworkBlockEntry, _abpSplitNetworkPattern, _abpEmptySkipStats, _maybeConvertAbpText, _looksLikeAbpFormat, reset() { _curatedDedupPromise = null; } };
}
root.AbpConverter = { create };
if (typeof module !== 'undefined') module.exports = root.AbpConverter;
})(typeof self === 'undefined' ? globalThis : self);
