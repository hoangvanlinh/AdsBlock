// background.js — AdBlock Service Worker (Manifest V3)
// Handles: network blocking (declarativeNetRequest) + message routing

// Shared constants live in config.js (single source of truth).
// Chrome MV3 service worker: importScripts. Firefox background page:
// importScripts does not exist there — config.js is listed before this
// file in background.scripts instead, so ADBLOCK_CONFIG is already set.
if (typeof importScripts === 'function' && !self.ADBLOCK_CONFIG) {
  importScripts('config.js');
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
let _ruleConfigPromise = null;

const QUERY_STRIP_RESOURCE_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other'];

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
      condition.requestDomains = [hostPath.toLowerCase()];
    } else {
      condition.urlFilter = '||' + hostPath;
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
    if (pattern.indexOf('/') === -1) condition.requestDomains = [pattern.toLowerCase()];
    else condition.urlFilter = '||' + pattern;
    rules.push({ id: id++, priority: 1, action: _redirectAction(file), condition });
  }
  return rules;
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

async function getCachedRuleText() {
  try {
    const cached = await chrome.storage.local.get([RULES_CACHE_TEXT_KEY, RULES_CACHE_TIME_KEY]);
    if (!cached[RULES_CACHE_TEXT_KEY]) return null;
    return {
      text: cached[RULES_CACHE_TEXT_KEY],
      time: Number(cached[RULES_CACHE_TIME_KEY] || 0),
    };
  } catch {
    return null;
  }
}

async function setCachedRuleText(text) {
  if (!text) return;
  try {
    await chrome.storage.local.set({
      [RULES_CACHE_TEXT_KEY]: text,
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
// rule/network-rules.json structured-DNR path) — simplified here to just bare
// `||domain^` (optionally $third-party/$~third-party, no path/other modifiers)
// collected into ad_network_patterns, matching the plain-domain-list shape
// [global] ad_network_patterns already expects. Anything path/modifier-scoped
// is dropped rather than guessed at.
const ABP_PROCEDURAL_RE = /:has-text\(|:matches-css|:xpath\(|:min-text-length|:remove\(|:style\(|:upward\(|:min-outer-height/;
const ABP_BARE_NETWORK_DOMAIN_RE = /^[a-z0-9.*-]+\^$/i;

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
    dedupSkipped: 0, unrecognized: 0,
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
function _abpParseFile(text, curatedPatterns, acc, stats) {
  const { domainSelectors, domainScriptlets, globalSelectors, globalScriptlets, networkDomains, networkRedirects } = acc;
  const s = stats || _abpEmptySkipStats();
  const lines = String(text || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.charAt(0) === '!') continue;

    const netMatch = /^\|\|([^$]+?)(?:\$(.*))?$/.exec(line);
    if (netMatch) {
      s.total++;
      const pattern = netMatch[1];
      const optsStr = netMatch[2] || '';
      if (ABP_BARE_NETWORK_DOMAIN_RE.test(pattern) && (!optsStr || /^~?third-party$/.test(optsStr))) {
        networkDomains.add(pattern.slice(0, -1).toLowerCase());
        s.converted++;
      } else {
        // Not a bare-domain block — the one other shape this converter
        // preserves is a path-scoped rule carrying a $redirect=/$redirect-rule=
        // that resolves to a resource this extension actually ships
        // (network_redirect_rules, background.js's buildNetworkRedirectRules).
        // Everything else about the rule (other modifiers, domain=, @@, ...)
        // is ignored; a bare-domain redirect isn't worth its own rule since
        // ad_network_patterns already blocks that domain outright.
        const redirectMatch = /(?:^|,)redirect(?:-rule)?=([^,]+)/.exec(optsStr);
        const file = redirectMatch && _resolveRedirectResourceName(redirectMatch[1]);
        if (file && !ABP_BARE_NETWORK_DOMAIN_RE.test(pattern)) {
          networkRedirects.add(pattern + ' ' + file);
          s.converted++;
        } else {
          s.complexNetwork++;
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

function _abpFinalizeGroups(domainSelectors, domainScriptlets) {
  const allDomains = new Set([...domainSelectors.keys(), ...domainScriptlets.keys()]);
  const groups = new Map();
  for (const domain of allDomains) {
    const selectors = domainSelectors.get(domain) || new Set();
    const scriptlets = domainScriptlets.get(domain) || new Map();
    const scriptletSig = [...scriptlets.entries()].map(([k, vals]) => k + '=' + [...vals].sort().join('')).sort().join('');
    const sig = [...selectors].sort().join(' ') + scriptletSig;
    if (!groups.has(sig)) groups.set(sig, { domains: [], selectors, scriptlets });
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
function _abpRender({ groups, globalSelectors, globalScriptlets, networkDomains, networkRedirects, curatedSectionNames, sharedUsedKeys }) {
  const usedKeys = sharedUsedKeys || new Set();
  const out = [];
  if (networkDomains.size || (networkRedirects && networkRedirects.size) || globalSelectors.size || globalScriptlets.size) {
    out.push('[global]');
    if (networkDomains.size) out.push('ad_network_patterns = ' + [...networkDomains].sort().join(' | '));
    if (networkRedirects && networkRedirects.size) out.push('network_redirect_rules = ' + [...networkRedirects].sort().map(_abpEscapeValue).join(' | '));
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
      const key = _abpSanitizeKey(g.domains[0], curatedSectionNames, usedKeys);
      usedKeys.add(key);
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
async function _maybeConvertAbpText(text, statsOut, sharedUsedKeys) {
  if (!_looksLikeAbpFormat(text)) return text;
  let curatedPatterns = new Set(), curatedSectionNames = new Set();
  try {
    const nativeText = await fetchLocalRuleText();
    if (nativeText) {
      const parsed = parseRuleText(nativeText);
      if (parsed.host_patterns) curatedPatterns = new Set(Object.keys(parsed.host_patterns));
      curatedSectionNames = new Set(Object.keys(parsed));
    }
  } catch (e) { /* fall back to no dedup */ }
  const acc = {
    domainSelectors: new Map(), domainScriptlets: new Map(),
    globalSelectors: new Set(), globalScriptlets: new Map(),
    networkDomains: new Set(), networkRedirects: new Set(),
  };
  const stats = _abpEmptySkipStats();
  try { _abpParseFile(text, curatedPatterns, acc, stats); } catch (e) {
    if (statsOut) statsOut.error = (e && e.message) || 'conversion failed';
    return text;
  }
  if (statsOut) Object.assign(statsOut, stats);
  const groups = _abpFinalizeGroups(acc.domainSelectors, acc.domainScriptlets);
  return _abpRender({
    groups, globalSelectors: acc.globalSelectors, globalScriptlets: acc.globalScriptlets,
    networkRedirects: acc.networkRedirects,
    networkDomains: acc.networkDomains, curatedSectionNames,
    sharedUsedKeys,
  });
}

// Effective enabled/disabled state for one built-in default Rule Source
// entry ({name, url, enable} from config.js's RULES_REMOTE_URL array): a
// per-URL override in `defaultRuleSourceOverrides` wins if present,
// otherwise the legacy single "all defaults" flag (`defaultRuleSourceEnabled
// === false`, pre-multi-source installs) wins if it was ever set, otherwise
// fall back to the entry's own ship-time `enable` field.
function _isDefaultSourceEnabled(entry, overrides, legacyAllDisabled) {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, entry.url)) return overrides[entry.url] !== false;
  if (legacyAllDisabled) return false;
  return entry.enable !== false;
}

// Every language candidate worth checking against a RULES_REMOTE_URL
// entry's `lang` — chrome.i18n.getUILanguage() (the browser's CHROME/MENU
// display language; uBlock Origin's own listMatchesEnvironment() uses only
// this) plus navigator.language/navigator.languages (the browser's
// Accept-Language / "preferred languages" list, chrome://settings/languages
// — a SEPARATE setting from the UI display language). These can genuinely
// disagree: a browser can display its own menus in English while the user's
// actual preferred/content language is Vietnamese, which is exactly the
// case getUILanguage()-only detection misses. chrome.i18n.getUILanguage()
// works the same way under Firefox's chrome.* alias; navigator exists in
// the MV3 service worker global too, so no browser/context branch needed.
function _candidateUILanguages() {
  const out = [];
  try {
    const ui = chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage();
    if (ui) out.push(ui);
  } catch (e) { /* ignore */ }
  try {
    if (typeof navigator !== 'undefined') {
      if (navigator.language) out.push(navigator.language);
      if (Array.isArray(navigator.languages)) out.push(...navigator.languages);
    }
  } catch (e) { /* ignore */ }
  return out;
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
  const { defaultRuleSourceOverrides = {} } = await chrome.storage.local.get('defaultRuleSourceOverrides');
  const updated = { ...defaultRuleSourceOverrides };
  let changed = false;
  for (const entry of matches) {
    if (!Object.prototype.hasOwnProperty.call(updated, entry.url)) {
      updated[entry.url] = true;
      changed = true;
    }
  }
  if (!changed) return;
  await chrome.storage.local.set({
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
// Concurrency note: Promise.all below only interleaves at the `await fetch`/
// `await res.text()` I/O points; once a given URL's _maybeConvertAbpText call
// resumes after its own internal await, its key-minting loop runs to
// completion with no further await, so mutating the shared Set from several
// concurrent calls is safe — no two calls can be mid-loop at the same time.
async function _fetchAndConvertUrls(urls, sharedUsedKeys) {
  const usedKeys = sharedUsedKeys || new Set();
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
      const converted = await _maybeConvertAbpText(raw, stats, usedKeys);
      if (Object.keys(stats).length) sourceStats[url] = stats;
      return converted;
    } catch (e) {
      sourceErrors[url] = e && e.message ? e.message : 'fetch failed';
      return '';
    }
  }));
  if (urls.length) {
    const { [RULE_SOURCE_ERRORS_KEY]: existingErrors = {}, [RULE_SOURCE_STATS_KEY]: existingStats = {} } =
      await chrome.storage.local.get([RULE_SOURCE_ERRORS_KEY, RULE_SOURCE_STATS_KEY]);
    const nextErrors = { ...existingErrors };
    const nextStats = { ...existingStats };
    for (const url of urls) {
      if (sourceErrors[url]) nextErrors[url] = sourceErrors[url];
      else delete nextErrors[url]; // this fetch succeeded — clear any stale error for it
      if (sourceStats[url]) nextStats[url] = sourceStats[url];
      else delete nextStats[url]; // not ABP-format (or fetch failed) — nothing to report for it now
    }
    await chrome.storage.local.set({ [RULE_SOURCE_ERRORS_KEY]: nextErrors, [RULE_SOURCE_STATS_KEY]: nextStats });
  }
  return texts;
}

async function fetchRemoteRuleText() {
  const stored = await chrome.storage.local.get(['ruleSources', 'customRulesUrl', 'customRulesText', 'defaultRuleSourceEnabled', 'defaultRuleSourceOverrides']);
  const sources = stored.ruleSources;
  const urls = [];
  const fileParts = [];
  const defaultUrls = new Set(RULES_REMOTE_URL.map(e => e.url));

  // Default remote sources — each toggleable from the dashboard's Rule
  // Source page (per-URL, defaultRuleSourceOverrides). Disabled means
  // disabled: no rules from that source at all, not even the bundled local
  // copy — the user can still layer custom sources/customRulesText on top
  // of nothing. (getRulesText()'s own catch branch still falls back to the
  // local file, but only on an actual fetch failure — see the empty-merge
  // check below.)
  //
  // DEBUG_LOCAL swaps ONLY the very first entry's URL (RULES_REMOTE_URL[0]
  // — this repo's own GitHub-hosted site-rules.txt, by convention always
  // first) for the bundled local copy, so local edits take effect on
  // reload without pushing to GitHub. Every other source — other default
  // entries, ruleSources, customRulesText — flows through this exact same
  // fetch/merge/cache pipeline in both debug and production; nothing else
  // about them changes.
  const legacyAllDisabled = stored.defaultRuleSourceEnabled === false;
  for (const [i, entry] of RULES_REMOTE_URL.entries()) {
    if (!_isDefaultSourceEnabled(entry, stored.defaultRuleSourceOverrides, legacyAllDisabled)) continue;
    urls.push(DEBUG_LOCAL && i === 0 ? chrome.runtime.getURL(RULES_LOCAL_PATH) : entry.url);
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
  // EasyPrivacy + ABPVN text, 2026-08-23).
  const sharedAbpKeys = new Set();
  const texts = await _fetchAndConvertUrls(urls, sharedAbpKeys);
  const convertedFileParts = await Promise.all(fileParts.map(t => _maybeConvertAbpText(t, undefined, sharedAbpKeys)));

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
  const res = await fetch(chrome.runtime.getURL(RULES_LOCAL_PATH), { cache: 'no-store' });
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

// Full reload pipeline — shared by the dashboard's RULES_CHANGED message and
// the revalidation alarm: drop caches, rebuild DNR rules, notify all tabs.
async function reloadRules() {
  await chrome.storage.local.set({
    [RULES_CACHE_TEXT_KEY]: '',
    [RULES_CACHE_TIME_KEY]: 0,
  });
  DEFAULT_RULES = [];
  MALWARE_RULES = [];
  AD_MAINFRAME_RULES = [];
  _ruleConfigPromise = null;
  _parsedRules = null;
  await applyNetworkRules();
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'RULES_CHANGED' }).catch(() => {});
  }
}

async function revalidateRemoteRules() {
  try {
    const stored = await chrome.storage.local.get([
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
    // Each source revalidated independently — one unreachable/erroring
    // source (e.g. a region list that moved) must not block the others.
    for (const entry of enabledEntries) {
      try {
        const etag = etags[entry.url] || '';
        const res = await fetch(entry.url, {
          cache: 'no-store',
          headers: etag ? { 'If-None-Match': etag } : {},
        });
        if (res.status === 304) continue; // unchanged
        if (!res.ok) continue;
        const text = await res.text();
        const newHash = _hashText(text);
        nextEtags[entry.url] = res.headers.get('etag') || '';
        nextHashes[entry.url] = newHash;
        if (newHash !== (hashes[entry.url] || '')) changed = true;
      } catch { /* this source failed — keep checking the others */ }
    }
    await chrome.storage.local.set({
      [RULES_REMOTE_ETAG_KEY]: nextEtags,
      [RULES_REMOTE_HASH_KEY]: nextHashes,
    });
    if (!changed) {
      // Nothing changed (all 304s / failures) — keep serving the cache and
      // push its expiry out.
      await chrome.storage.local.set({ [RULES_CACHE_TIME_KEY]: Date.now() });
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

async function checkForExtensionUpdate() {
  const currentVersion = chrome.runtime.getManifest().version;
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
    await chrome.storage.local.set({ updateInfo });
    return updateInfo;
  } catch {
    // Offline / repo unreachable — keep whatever was last known, just stamp
    // the failed attempt so the UI can show "last checked: failed just now"
    // instead of silently reusing a possibly stale success from days ago.
    const { updateInfo: prev = {} } = await chrome.storage.local.get('updateInfo');
    const updateInfo = { ...prev, lastChecked: Date.now(), lastCheckOk: false };
    await chrome.storage.local.set({ updateInfo });
    return updateInfo;
  }
}

async function maybeCheckForExtensionUpdate() {
  const { updateInfo = {} } = await chrome.storage.local.get('updateInfo');
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
  return { type: 'redirect', redirect: { url: chrome.runtime.getURL(`/web_accessible_resources/${file}`) } };
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
    else urlFilters.push(p);
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
    redirect: { regexSubstitution: chrome.runtime.getURL('blocked/blocked.html') + '?h=\\1' },
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
    redirect: { regexSubstitution: chrome.runtime.getURL('blocked/blocked.html') + '?t=ad&h=\\1' },
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
    const { customRulesText: customText = '' } = await chrome.storage.local.get('customRulesText');
    const text = customText ? baseText + '\n' + customText : baseText;
    if (text) await setCachedRuleText(text);
    return text;
  }
}

// Parsed rules cached in the service worker so the text is parsed ONCE here
// instead of by every content-script frame. Reset on RULES_CHANGED.
let _parsedRules = null;
let _parsedRulesPromise = null;

async function getParsedRules() {
  if (_parsedRules) return _parsedRules;
  if (!_parsedRulesPromise) {
    _parsedRulesPromise = getRulesText()
      .then(text => {
        _parsedRules = parseRuleText(text);
        return _parsedRules;
      })
      .finally(() => { _parsedRulesPromise = null; });
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

async function ensureRuleDefinitionsLoaded() {
  if (DEFAULT_RULES.length && MALWARE_RULES.length && AD_MAINFRAME_RULES.length) return;
  if (!_ruleConfigPromise) {
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
      const { adRules, trackerRules } = buildDefaultRulesFromConfig(config);
      DEFAULT_RULES = [...adRules, ...trackerRules];
      MALWARE_RULES = buildMalwareRulesFromConfig(config, DEFAULT_RULES.length +1);
      AD_MAINFRAME_RULES = buildAdMainFrameRulesFromConfig(config, DEFAULT_RULES.length + MALWARE_RULES.length + 1);
      QUERY_STRIP_RULES = buildQueryStripRules(global.strip_query_params || [], QUERY_STRIP_RULE_ID_START);
      NETWORK_REDIRECT_RULES = buildNetworkRedirectRules(global.network_redirect_rules || [], NETWORK_REDIRECT_RULE_ID_START);
      TRACKER_RULE_IDS = new Set(trackerRules.map(rule => rule.id));
      MALWARE_RULE_IDS = new Set(MALWARE_RULES.map(rule => rule.id));
      AD_KEYWORDS.splice(0, AD_KEYWORDS.length, ...config.adPatterns);
      TRACKER_KEYWORDS.splice(0, TRACKER_KEYWORDS.length, ...config.trackerPatterns);
      MALWARE_KEYWORDS.splice(0, MALWARE_KEYWORDS.length, ...config.malwarePatterns);
    })().finally(() => {
      _ruleConfigPromise = null;
    });
  }
  await _ruleConfigPromise;
}

const FOCUS_RULE_ID_START   = 2000;
const QUERY_STRIP_RULE_ID_START = 3000;
const NETWORK_REDIRECT_RULE_ID_START = 500000; // for network_redirect_rules
const REMOTE_MALWARE_RULE_ID_START = 100000; // for fetched blocklists
const CUSTOM_RULE_ID_START = 200000;         // for user-created rules
const PAUSE_ALLOW_RULE_ID_START = 300000;    // for pause/allowlist allow-all rules

// Remote blocklist domains are grouped into a few requestDomains rules instead
// of one rule per domain, so the dynamic-rule quota is no longer the constraint.
const REMOTE_MAX_DOMAINS = 25000;
const REMOTE_DOMAINS_PER_RULE = 1000;

function buildRemoteMalwareRules(domains) {
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
chrome.runtime.onInstalled.addListener(async () => {
  // Run on every onInstalled reason (install, update, chrome_update, ...),
  // not just 'install' — see _autoEnableLangDefaultSources()'s own comment
  // for why that gating meant this could never fire for an existing
  // install. Runs before the first applyNetworkRules() call below so a
  // newly-auto-enabled source is picked up immediately, not after the next
  // cache TTL.
  await _autoEnableLangDefaultSources();
  // Seed default settings
  const existing = await chrome.storage.local.get([
    'enabled', 'pausedDomains', 'allowedDomains', 'focusMode', 'stats', 'rules',
    'referrerAnonymization', 'collectStats',
    'blockAds', 'blockTrackers', 'cosmeticFiltering', 'blockMalware',
    'installDate', 'totalBlockedAllTime', 'reviewPromptState',
  ]);
  await chrome.storage.local.set({
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
  await maybeUpdateMalwareLists();
  await maybeCheckForExtensionUpdate();
});

chrome.runtime.onStartup.addListener(() => {
  applyNetworkRules();
  applyPrivacySettings();
  maybeUpdateMalwareLists();
  maybeCheckForExtensionUpdate();
  // Cheap ETag check (304 when unchanged) — picks up urgent rules fixes
  // published while the browser was closed, instead of waiting out the TTL.
  revalidateRemoteRules();
});

let activeStatsRules = [];
let statsRulesInitialized = false;

async function buildActiveRulesFromStorage() {
  await ensureRuleDefinitionsLoaded();
  const {
    enabled, pausedDomains = [], allowedDomains = [], focusMode = false,
    blockAds = true, blockTrackers = true, blockMalware = true,
  } = await chrome.storage.local.get(
    ['enabled', 'pausedDomains', 'allowedDomains', 'focusMode', 'blockAds', 'blockTrackers', 'blockMalware']
  );

  if (!enabled) return { enabled: false, allRules: [] };

  const AD_RULE_IDS = new Set(DEFAULT_RULES.filter(r => !TRACKER_RULE_IDS.has(r.id)).map(r => r.id));
  const filteredDefaultRules = DEFAULT_RULES.filter(r => {
    if (AD_RULE_IDS.has(r.id) && !blockAds) return false;
    if (TRACKER_RULE_IDS.has(r.id) && !blockTrackers) return false;
    return true;
  });

  const activeRules = [...filteredDefaultRules];
  const adMainFrameActive = blockAds ? [...AD_MAINFRAME_RULES] : [];
  const malwareActive = blockMalware ? [...MALWARE_RULES] : [];
  const { remoteMalwareDomains, remoteMalwareRules = [] } = await chrome.storage.local.get(
    ['remoteMalwareDomains', 'remoteMalwareRules']
  );
  // Migration: older versions stored full rule objects (one per domain).
  // Flatten them back to a domain list until the next blocklist refresh
  // rewrites storage in the new format.
  const remoteDomains = remoteMalwareDomains
    || remoteMalwareRules.flatMap(r => r.condition?.requestDomains || []);
  const remoteActive = blockMalware ? buildRemoteMalwareRules(remoteDomains) : [];
  const customBlockRules = await buildCustomBlockRules();
  const focusRules = await buildFocusRules(focusMode);
  const queryStripActive = blockTrackers ? QUERY_STRIP_RULES : [];
  const networkRedirectActive = blockAds ? NETWORK_REDIRECT_RULES : [];

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
  let sessionAllowedDomains = [];
  try {
    ({ sessionAllowedDomains = [] } = await chrome.storage.session.get('sessionAllowedDomains'));
  } catch { /* chrome.storage.session unavailable (old browser) — best-effort only */ }
  const excludedDomains = [...new Set([...pausedDomains, ...allowedDomains, ...sessionAllowedDomains])];
  const pauseAllowRules = excludedDomains.map((domain, i) => ({
    id: PAUSE_ALLOW_RULE_ID_START + i,
    priority: 10, // higher than all block rules (priority 1-2)
    action: { type: 'allowAllRequests' },
    condition: {
      requestDomains: [domain],
      resourceTypes: ['main_frame', 'sub_frame'],
    },
  }));

  return {
    enabled: true,
    allRules: [
      ...activeRules, ...adMainFrameActive, ...malwareActive, ...remoteActive,
      ...customBlockRules, ...focusRules, ...pauseAllowRules, ...queryStripActive, ...networkRedirectActive,
    ],
  };
}

// ── Apply declarativeNetRequest rules ────────────────────────────
// applyNetworkRules() has many independent call sites (onInstalled,
// onStartup, alarms, message handlers, reloadRules()) that are NOT
// sequenced against each other — e.g. onStartup fires applyNetworkRules(),
// maybeUpdateMalwareLists() (which itself calls applyNetworkRules() again
// via fetchMalwareBlocklists()), and revalidateRemoteRules() (ditto via
// reloadRules()) all in the same tick, with no await between them. Each
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
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeIds = existing.map(r => r.id);

  if (!enabled) {
    // Protection OFF — remove all rules
    if (removeIds.length) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds, addRules: [] });
    }
    await chrome.storage.local.remove(DNR_RULES_HASH_KEY);
    activeStatsRules = [];
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
  // sent. The hash is content-derived, so it self-invalidates the moment
  // anything actually changes — no separate cache-clearing step needed,
  // unlike a plain cached-value replay. existing.length is an extra,
  // cheap guard against silent drift (rules cleared by something other
  // than this function since the hash was stored).
  const newHash = _hashText(JSON.stringify(allRules));
  const { [DNR_RULES_HASH_KEY]: storedHash } = await chrome.storage.local.get(DNR_RULES_HASH_KEY);
  if (existing.length === allRules.length && storedHash === newHash) {
    activeStatsRules = allRules.filter(rule => rule.action?.type === 'block');
    statsRulesInitialized = true;
    updateIcon(true);
    return;
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: removeIds,
    addRules: allRules,
  });
  await chrome.storage.local.set({ [DNR_RULES_HASH_KEY]: newHash });

  activeStatsRules = allRules.filter(rule => rule.action?.type === 'block');
  statsRulesInitialized = true;
  updateIcon(true);
}

// ── User custom blocking rules ────────────────────────────────────
async function buildCustomBlockRules() {
  const { rules = [] } = await chrome.storage.local.get('rules');
  const blockRules = rules.filter(r => r.active && r.action === 'block');
  return blockRules.map((r, i) => {
    const ruleId = CUSTOM_RULE_ID_START + i;
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
}

// ── Focus mode blocking rules ─────────────────────────────────────
const DISTRACTION_DEFAULTS = ['twitter.com', 'youtube.com', 'reddit.com', 'instagram.com', 'tiktok.com'];

async function buildFocusRules(focusMode) {
  if (!focusMode) return [];
  const { distractionDomains = DISTRACTION_DEFAULTS } = await chrome.storage.local.get('distractionDomains');
  return distractionDomains.map((domain, i) => ({
    id:       FOCUS_RULE_ID_START + i,
    priority: 2,
    action:   { type: 'block' },
    condition: {
      requestDomains: [domain],
      resourceTypes:  ['main_frame', 'sub_frame', 'script', 'image', 'xmlhttprequest'],
    },
  }));
}

// ── Icon badge ────────────────────────────────────────────────────
// enabled=true shows the ACTIVE TAB's own blocked count (uBO-style —
// resets per navigation, see _tabBlockedCounts below), enabled=false shows
// "OFF". "OFF" is a global (no-tabId) badge value; per-tab counts are set
// via chrome.action.setBadgeText({..., tabId}), which Chrome overlays on
// top of the global value for that tab only.
async function updateIcon(enabled) {
  chrome.action.setIcon({
    path: {
      16:  enabled ? 'icons/icon16.png'     : 'icons/icon16_off.png',
      48:  enabled ? 'icons/icon48.png'     : 'icons/icon48_off.png',
      128: enabled ? 'icons/icon128.png'    : 'icons/icon128_off.png',
    },
  });
  if (!enabled) {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#f87171' });
    return;
  }
  // Clear the global "OFF" value so tabs with no per-tab override go blank
  // (not stuck showing "OFF") the moment protection is re-enabled.
  chrome.action.setBadgeText({ text: '' });
  chrome.action.setBadgeBackgroundColor({ color: '#6366f1' });
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
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
  const { stats = {} } = await chrome.storage.local.get('stats');
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
  await chrome.storage.local.set({ stats });
}

async function _writeDailyStatDelta(delta) {
  const key = todayKey();
  const { dailyStats = {}, totalBlockedAllTime = 0 } = await chrome.storage.local.get(['dailyStats', 'totalBlockedAllTime']);
  if (!dailyStats[key]) dailyStats[key] = { blocked: 0, ads: 0, trackers: 0, malware: 0 };
  dailyStats[key].blocked  += delta.blocked  || 0;
  dailyStats[key].ads      += delta.ads      || 0;
  dailyStats[key].trackers += delta.trackers || 0;
  dailyStats[key].malware  += delta.malware  || 0;
  const keys = Object.keys(dailyStats).sort();
  while (keys.length > 30) { delete dailyStats[keys.shift()]; }
  // Unlike dailyStats (pruned to 30 days), this never resets — it's the
  // review-prompt milestone counter (see popup.js maybeShowReviewPrompt).
  await chrome.storage.local.set({ dailyStats, totalBlockedAllTime: totalBlockedAllTime + (delta.blocked || 0) });
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
  chrome.action.setBadgeText({ text: _formatBadgeCount(count), tabId }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#6366f1', tabId }).catch(() => {});
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
// Fetches community blocklists every 24 hours (or on install)
const BLOCKLIST_SOURCES = [
  // URLhaus: live malware URL/domain feed (abuse.ch research project)
  { url: 'https://urlhaus.abuse.ch/downloads/hostfile/', name: 'URLhaus' },
  // Phishing Army: aggregated phishing domains
  { url: 'https://phishing.army/download/phishing_army_blocklist.txt', name: 'Phishing Army' },
];

async function fetchMalwareBlocklists() {
  const allDomains = new Set();
  for (const source of BLOCKLIST_SOURCES) {
    try {
      const resp = await fetch(source.url, { cache: 'no-cache' });
      if (!resp.ok) continue;
      const text = await resp.text();
      const lines = text.split('\n');
      for (const line of lines) {
        if (allDomains.size >= REMOTE_MAX_DOMAINS) break;
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
        // Hosts file format: "127.0.0.1 domain" or "0.0.0.0 domain" or just "domain"
        let domain = trimmed;
        if (domain.startsWith('127.0.0.1') || domain.startsWith('0.0.0.0')) {
          domain = domain.split(/\s+/)[1];
        }
        if (!domain || domain === 'localhost') continue;
        domain = domain.toLowerCase();
        if (!DOMAIN_PATTERN_RE.test(domain)) continue;
        allDomains.add(domain);
      }
    } catch (e) {
      console.warn(`[AdBlock] Failed to fetch ${source.name}:`, e.message);
    }
  }

  const domains = Array.from(allDomains);

  // Store only the domain list — rules are rebuilt on apply. Storing rule
  // objects (~150 bytes each as JSON) wasted storage; the old per-rule key
  // is removed on first update after migration.
  await chrome.storage.local.set({
    remoteMalwareDomains: domains,
    malwareListLastUpdate: Date.now(),
    malwareListCount: domains.length,
  });
  await chrome.storage.local.remove('remoteMalwareRules');

  // Re-apply all network rules
  await applyNetworkRules();

  console.log(`[AdBlock] Malware blocklist updated: ${domains.length} domains from remote sources`);
  return domains.length;
}

// Check if blocklist needs update (every 24 hours)
async function maybeUpdateMalwareLists() {
  const { malwareListLastUpdate = 0 } = await chrome.storage.local.get('malwareListLastUpdate');
  const ONE_DAY = 24 * 60 * 60 * 1000;
  if (Date.now() - malwareListLastUpdate > ONE_DAY) {
    await fetchMalwareBlocklists();
  }
}

// Schedule periodic updates via alarm
chrome.alarms?.create('malware-list-update', { periodInMinutes: 60 * 24 });
chrome.alarms?.create(RULES_REVALIDATE_ALARM, { periodInMinutes: RULES_REVALIDATE_PERIOD_MIN });
chrome.alarms?.create('extension-update-check', { periodInMinutes: 60 * 24 });
chrome.alarms?.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'malware-list-update') {
    await fetchMalwareBlocklists();
  }
  if (alarm.name === RULES_REVALIDATE_ALARM) {
    await revalidateRemoteRules();
  }
  if (alarm.name === 'extension-update-check') {
    await checkForExtensionUpdate();
  }
  if (alarm.name === 'focus-end') {
    // Auto-disable focus mode when timer expires
    await chrome.storage.local.set({ focusMode: false, focusEndTime: null });
    await applyNetworkRules();
  }
});

// ── "Hide element" picker (right-click context menu) ─────────────────
// Arms content/element-picker.js for the clicked tab/frame; the actual
// pick/hide/persist flow happens entirely client-side after that (see
// element-picker.js), reporting back only the final SAVE_ELEMENT_RULE.
// contextMenus.create throws "duplicate id" if called again while a menu
// with that id still exists — removeAll() first makes this idempotent
// across service-worker restarts (no onInstalled-only guard needed).
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
try {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'qkv1-pick-element',
      title: 'Pick element to hide…',
      contexts: ['all'],
      documentUrlPatterns: QKV1_MENU_URL_PATTERNS,
    });
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
      chrome.contextMenus.create({
        id: 'qkv1-scan-globals',
        title: 'Scan page for scripts/variables…',
        contexts: ['all'],
        documentUrlPatterns: QKV1_MENU_URL_PATTERNS,
      });
      chrome.contextMenus.create({
        id: 'qkv1-edit-rules',
        title: 'Edit rules for this site…',
        contexts: ['all'],
        documentUrlPatterns: QKV1_MENU_URL_PATTERNS,
      });
    }
  });
} catch (e) {}
chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'qkv1-pick-element') {
    chrome.tabs.sendMessage(tab.id, { type: 'QKV1_ENTER_PICKER_MODE' }, { frameId: info.frameId }, () => {
      void chrome.runtime.lastError; // no listener on this frame yet — ignore
    });
  } else if (info.menuItemId === 'qkv1-scan-globals') {
    chrome.tabs.sendMessage(tab.id, { type: 'QKV1_ENTER_SCANNER_MODE' }, { frameId: info.frameId }, () => {
      void chrome.runtime.lastError;
    });
  } else if (info.menuItemId === 'qkv1-edit-rules') {
    chrome.tabs.sendMessage(tab.id, { type: 'QKV1_ENTER_RULE_EDITOR_MODE' }, { frameId: info.frameId }, () => {
      void chrome.runtime.lastError;
    });
  }
});

// ── Privacy: Referrer anonymization ───────────────────────────────
// Uses declarativeNetRequest to strip cross-origin Referer to origin only.
const REFERRER_RULE_ID = 400000;

async function applyReferrerAnonymization(enabled) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const hasRule = existing.some(r => r.id === REFERRER_RULE_ID);

  if (enabled && !hasRule) {
    await chrome.declarativeNetRequest.updateDynamicRules({
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
    await chrome.declarativeNetRequest.updateDynamicRules({
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
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const hasRule = existing.some(r => r.id === GPC_RULE_ID);

  if (enabled && !hasRule) {
    await chrome.declarativeNetRequest.updateDynamicRules({
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
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [GPC_RULE_ID],
    });
  }
}

// ── Privacy: Do Not Track header ────────────────────────────────────
const DNT_RULE_ID = 400002;

async function applyDntHeader(enabled) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const hasRule = existing.some(r => r.id === DNT_RULE_ID);

  if (enabled && !hasRule) {
    await chrome.declarativeNetRequest.updateDynamicRules({
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
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [DNT_RULE_ID],
    });
  }
}

// Apply saved privacy settings on startup
async function applyPrivacySettings() {
  const { referrerAnonymization = true, gpcSignal = true, dntHeader = true } =
    await chrome.storage.local.get(['referrerAnonymization', 'gpcSignal', 'dntHeader']);
  await applyReferrerAnonymization(referrerAnonymization);
  await applyGpcHeader(gpcSignal);
  await applyDntHeader(dntHeader);
}

// ── Per-frame cosmetic CSS injection ────────────────────────────────
// Content scripts used to create their own `document.createElement('style')`
// nodes scoped under a toggle class on <html> — both the class and the
// style ids were page-visible fingerprint markers. Instead, apply cosmetic
// CSS via chrome.scripting.insertCSS, a privileged call that lands in the
// browser's "user stylesheet" cascade: no <style> DOM node, not enumerable
// via document.styleSheets, and no class needed to gate it on/off —
// turning it off is just removeCSS.
//
// "slot" lets 3 independent CSS sources (base defaults, per-site
// direct_hide_selectors, user custom rules) update/clear without touching
// each other. Keyed per tab+frame since all_frames content scripts each
// have their own frameId.
const _frameCss = new Map(); // `${tabId}:${frameId}:${slot}` -> last-applied css text

function _frameCssKey(tabId, frameId, slot) {
  return `${tabId}:${frameId}:${slot}`;
}

async function setFrameCss(tabId, frameId, slot, css) {
  if (tabId === undefined || frameId === undefined) return;
  const key = _frameCssKey(tabId, frameId, slot);
  const prev = _frameCss.get(key);
  if (prev === css) return; // no change — already applied (or already absent)
  if (prev) {
    try { await chrome.scripting.removeCSS({ target: { tabId, frameIds: [frameId] }, css: prev }); }
    catch (e) { /* frame navigated away mid-flight — fine, nothing to clean up */ }
  }
  if (css) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId, frameIds: [frameId] }, css });
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
    try { await chrome.scripting.removeCSS({ target: { tabId, frameIds: [frameId] }, css }); } catch (e) {}
    _frameCss.delete(key);
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
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
const _settingsCache = { enabled: true, pausedDomains: [], allowedDomains: [], collectStats: true };
chrome.storage.local.get(['enabled', 'pausedDomains', 'allowedDomains', 'collectStats']).then(r => {
  Object.assign(_settingsCache, r);
}).catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const key of ['enabled', 'pausedDomains', 'allowedDomains', 'collectStats']) {
    if (changes[key]) _settingsCache[key] = changes[key].newValue;
  }
});

// ── Popunder/click-hijack tab auto-close ─────────────────────────────
// Mirrors uBlock Origin's opener-hostname-keyed $popunder filter (see uBO's
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
chrome.tabs.onCreated.addListener(async (tab) => {
  if (!tab.openerTabId) return;
  if (!_settingsCache.enabled) return;
  // Never close this extension's own pages (dashboard/popup/blocked.html).
  // chrome.runtime.openOptionsPage() (open_in_tab:true) creates a real tab
  // via chrome.tabs.create — if the user triggers it while the CURRENTLY
  // ACTIVE tab happens to be on a close_popunder_tabs-flagged
  // site, Chrome can attribute that active tab as this new tab's opener,
  // and without this guard the dashboard/options tab gets misread as "this
  // site just spawned a popup" and closed immediately.
  const ownPrefix = chrome.runtime.getURL('');
  if ((tab.url && tab.url.startsWith(ownPrefix)) || (tab.pendingUrl && tab.pendingUrl.startsWith(ownPrefix))) return;
  try {
    // Only remaining await before the close call — Chrome doesn't hand us
    // the opener's URL in the onCreated event itself, so there's no way to
    // resolve which site spawned this tab without asking. getParsedRules()
    // below is also in-memory after its first call (module-level cache).
    const opener = await chrome.tabs.get(tab.openerTabId).catch(() => null);
    if (!opener || !opener.url) return;
    let openerHost;
    try { openerHost = new URL(opener.url).hostname.toLowerCase(); } catch { return; }
    if (_settingsCache.pausedDomains.includes(openerHost) || _settingsCache.allowedDomains.includes(openerHost)) return;
    const parsed = await getParsedRules();
    const siteKey = resolveSiteKey(parsed.host_patterns || {}, openerHost);
    const siteCfg = (siteKey && parsed[siteKey]) || {};
    const flag = siteCfg.close_popunder_tabs;
    const flagOn = !!(flag && flag.length && !['', '0', 'false', 'off'].includes(String(flag[0]).toLowerCase()));
    const globalMatch = _domainListMatches((parsed.global || {}).close_popunder_domains, openerHost);
    if (!flagOn && !globalMatch) return;
    await chrome.tabs.remove(tab.id).catch(() => {});
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
  const { customRulesText = '' } = await chrome.storage.local.get('customRulesText');
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
  await chrome.storage.local.set({ customRulesText: newText, elementRules });
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
  const { customRulesText = '' } = await chrome.storage.local.get('customRulesText');
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
  await chrome.storage.local.set({ customRulesText: newText, noWindowOpenRules });
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
  const { customRulesText = '' } = await chrome.storage.local.get('customRulesText');
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
  await chrome.storage.local.set({ customRulesText: newText, globalScopeRules });
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
  const { customRulesText = '' } = await chrome.storage.local.get('customRulesText');
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
  await chrome.storage.local.set({ customRulesText: newText, siteRuleText });
  await reloadRules();
}

// ── Message handler ───────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
        await chrome.storage.local.set({ enabled: msg.enabled });
        await applyNetworkRules();
        sendResponse({ ok: true });
        break;
      }

      case 'PAUSE_DOMAIN': {
        const { pausedDomains = [] } = await chrome.storage.local.get('pausedDomains');
        if (msg.paused && !pausedDomains.includes(msg.domain)) {
          pausedDomains.push(msg.domain);
        } else if (!msg.paused) {
          const idx = pausedDomains.indexOf(msg.domain);
          if (idx !== -1) pausedDomains.splice(idx, 1);
        }
        await chrome.storage.local.set({ pausedDomains });
        await applyNetworkRules();
        // Update badge on the active tab immediately
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.id) {
          if (msg.paused) {
            chrome.action.setBadgeText({ text: '⏸', tabId: activeTab.id });
            chrome.action.setBadgeBackgroundColor({ color: '#f59e0b', tabId: activeTab.id });
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
        const { elementRules = {} } = await chrome.storage.local.get('elementRules');
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
        const { elementRules = {} } = await chrome.storage.local.get('elementRules');
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
        const { noWindowOpenRules = {} } = await chrome.storage.local.get('noWindowOpenRules');
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
        const { globalScopeRules = {} } = await chrome.storage.local.get('globalScopeRules');
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
        const { globalScopeRules = {} } = await chrome.storage.local.get('globalScopeRules');
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
        const { siteRuleText = {} } = await chrome.storage.local.get('siteRuleText');
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
        const { siteRuleText = {} } = await chrome.storage.local.get('siteRuleText');
        // Saving an empty (or header-only) textarea is the "clear this
        // site's rules" gesture — no separate REMOVE message needed, unlike
        // the other two pickers' per-item add/remove model.
        if (text) siteRuleText[host] = text; else delete siteRuleText[host];
        await _applySiteRuleText(siteRuleText);
        sendResponse({ ok: true });
        break;
      }

      case 'FOCUS_MODE': {
        await chrome.storage.local.set({ focusMode: msg.enabled });
        if (msg.enabled) {
          // Set alarm to auto-disable focus when timer expires (even if dashboard is closed)
          const { focusEndTime } = await chrome.storage.local.get('focusEndTime');
          if (focusEndTime) {
            const delayMs = focusEndTime - Date.now();
            if (delayMs > 0) {
              chrome.alarms.create('focus-end', { when: focusEndTime });
            }
          }
        } else {
          chrome.alarms.clear('focus-end');
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
          const { allowedDomains: current = [] } = await chrome.storage.local.get('allowedDomains');
          if (!current.includes(host)) {
            await chrome.storage.local.set({ allowedDomains: [...current, host] });
          }
        } else {
          try {
            const { sessionAllowedDomains: current = [] } = await chrome.storage.session.get('sessionAllowedDomains');
            if (!current.includes(host)) {
              await chrome.storage.session.set({ sessionAllowedDomains: [...current, host] });
            }
          } catch { /* chrome.storage.session unavailable — proceed will just re-warn next time */ }
        }
        await applyNetworkRules();
        sendResponse({ ok: true });
        break;
      }

      case 'RULES_CHANGED': {
        // Invalidate caches, re-fetch all sources, rebuild DNR rules and
        // notify every tab — shared with the revalidation alarm.
        await reloadRules();
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
        await chrome.storage.local.set({ [msg.setting]: msg.value });
        if (msg.setting === 'referrerAnonymization') await applyReferrerAnonymization(msg.value);
        if (msg.setting === 'gpcSignal') await applyGpcHeader(msg.value);
        if (msg.setting === 'dntHeader') await applyDntHeader(msg.value);
        // gpcSignal/referrerAnonymization also gate MAIN-world scriptlets
        // (content/scriptlets.js) via GET_SITE_CONFIG — resync every open
        // tab so it picks up the new flag without a page reload.
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, { type: 'PRIVACY_TOGGLE' }).catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }

      case 'SET_BLOCKING': {
        // msg: { setting: 'blockAds' | 'blockTrackers' | 'cosmeticFiltering' | 'blockMalware', value: bool }
        const allowedKeys = ['blockAds', 'blockTrackers', 'cosmeticFiltering', 'blockMalware'];
        if (!allowedKeys.includes(msg.setting)) { sendResponse({ ok: false }); break; }
        await chrome.storage.local.set({ [msg.setting]: msg.value });
        if (msg.setting === 'cosmeticFiltering') {
          // Notify all tabs to enable/disable cosmetic CSS
          const tabs = await chrome.tabs.query({});
          for (const tab of tabs) {
            chrome.tabs.sendMessage(tab.id, { type: 'COSMETIC_TOGGLE', enabled: msg.value }).catch(() => {});
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
        const {
          collectStats = true, enabled: statsEnabled = true,
          blockAds: rsAds = true, blockTrackers: rsTrackers = true, blockMalware: rsMalware = true,
          pausedDomains: rsPaused = [], allowedDomains: rsAllowed = [],
        } = await chrome.storage.local.get(
          ['collectStats', 'enabled', 'blockAds', 'blockTrackers', 'blockMalware', 'pausedDomains', 'allowedDomains']
        );
        if (!collectStats) { sendResponse({ ok: true }); break; }

        const domain = msg.domain || '_global';
        // Only count categories whose blocking is actually active — a matched
        // URL is only "blocked" if the corresponding DNR rules are installed.
        if (!statsEnabled || rsPaused.includes(domain) || rsAllowed.includes(domain)) {
          sendResponse({ ok: true });
          break;
        }
        const d = msg.delta || {};
        const ads      = rsAds      ? (d.ads      || 0) : 0;
        const trackers = rsTrackers ? (d.trackers || 0) : 0;
        const malware  = rsMalware  ? (d.malware  || 0) : 0;
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
        const { collectStats: collectCH = true } = await chrome.storage.local.get('collectStats');
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
        const { rules = [] } = await chrome.storage.local.get('rules');
        for (const r of rules) {
          if (!r.active || r.action !== 'block') continue;
          if (r.type === 'domain' && r.pattern)  adPatterns.push(r.pattern);
          if (r.type === 'keyword' && r.pattern) adPatterns.push(r.pattern);
        }

        sendResponse({ adPatterns, trackerPatterns, malwarePatterns });
        break;
      }

      case 'GET_STATS': {
        const { stats = {} } = await chrome.storage.local.get('stats');
        sendResponse({ stats });
        break;
      }

      case 'GET_RULE_COUNT': {
        const rules = await chrome.declarativeNetRequest.getDynamicRules();
        sendResponse({ count: rules.length, rules: rules.map(r => r.id) });
        break;
      }

      case 'GET_UPDATE_STATUS': {
        const { updateInfo = {} } = await chrome.storage.local.get('updateInfo');
        sendResponse({
          ok: true,
          currentVersion: chrome.runtime.getManifest().version,
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
          currentVersion: chrome.runtime.getManifest().version,
          latestVersion: updateInfo.latestVersion || '',
          available: !!updateInfo.available,
          lastChecked: updateInfo.lastChecked || 0,
          lastCheckOk: updateInfo.lastCheckOk !== false,
        });
        break;
      }

      case 'UPDATE_MALWARE_LISTS': {
        const count = await fetchMalwareBlocklists();
        sendResponse({ ok: true, count });
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
        // fetched and re-parsed independently.
        try {
          const parsed = await getParsedRules();
          const host = String(msg.host || '').toLowerCase();
          const siteKey = resolveSiteKey(parsed.host_patterns || {}, host);
          // gpcSignal/referrerAnonymization are chrome.storage privacy
          // toggles, not site-rules.txt keys — synthesized here as flag-style
          // global entries so they ride the same SCRIPTLET_KEYS pipeline as
          // every other MAIN-world scriptlet, with no [global] override path
          // to worry about (see background.js:1305-1345 applyPrivacySettings).
          const { gpcSignal = true, referrerAnonymization = true } =
            await chrome.storage.local.get(['gpcSignal', 'referrerAnonymization']);
          const global = Object.assign({}, parsed.global || {});
          if (gpcSignal) global.gpc_signal = ['1'];
          if (referrerAnonymization) global.hide_document_referrer = ['1'];
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
        const { malwareListLastUpdate = 0, malwareListCount = 0 } = await chrome.storage.local.get(['malwareListLastUpdate', 'malwareListCount']);
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
        const { collectStats: collectMB = true } = await chrome.storage.local.get('collectStats');
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
        const { collectStats: collectAB = true } = await chrome.storage.local.get('collectStats');
        if (!collectAB) { sendResponse({ ok: true }); break; }
        _enqueueStatWrite(() => _writeDomainStatDelta(host, { adsBlocked: 1, totalSeen: 1 }));
        updateDailyStats({ blocked: 1, ads: 1, trackers: 0, malware: 0 });
        _incrementTabBlocked(sender.tab && sender.tab.id, 1);
        sendResponse({ ok: true });
        break;
      }

      case 'RESET': {
        await chrome.storage.local.clear();
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: (await chrome.declarativeNetRequest.getDynamicRules()).map(r => r.id),
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
async function updateBadgeForTab(tabId, url) {
  if (!url) return;
  let domain = '';
  try { domain = new URL(url).hostname; } catch { return; }
  const { pausedDomains = [] } = await chrome.storage.local.get('pausedDomains');
  if (pausedDomains.includes(domain)) {
    chrome.action.setBadgeText({ text: '⏸', tabId }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b', tabId }).catch(() => {});
  } else {
    _setTabBadge(tabId);
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url) return;
  updateBadgeForTab(tabId, tab.url);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
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