// scripts/scriptlet-alias-map.js — single source of truth for the uBO
// scriptlet-alias -> this project's SCRIPTLET_KEY mapping, shared by
// scripts/convert-uassets.js and scripts/convert-regions.js (both `require`
// this instead of keeping their own copy — the two had drifted out of sync
// with each other before this file existed).
//
// sep: how this project's key joins multiple args ('comma' -> ", ", 'space' -> " ").
// maxArgs: args beyond this are dropped (key doesn't accept more).
// flag: value is always '1' regardless of uBO's args (presence-only toggle).
// confidence: 'high' (name+shape independently confirmed against real uBO
// source, see u-src/js/resources/*.js) or 'low' (name/purpose match only —
// argument order not independently re-verified).
const SCRIPTLET_ALIAS_MAP = {
  'acs':                        { key: 'abort_current_script',   sep: 'comma', maxArgs: 3, confidence: 'low' },
  // AdGuard's 'abort-current-inline-script' is a DIFFERENT scriptlet name
  // from uBO's, but not a different mechanism: its real 2-arg signature
  // (property, search-within-the-currently-executing-script's-own-text) is
  // exactly what content/scriptlets.js's abort_current_script dispatch
  // already does when called with only 2 args (its 3rd 'ctx'/src-filter arg
  // is uBO-only and simply unused here — see _acsImpl's own comment: `ctx &&
  // !reC.test(e.src)` is skipped entirely when ctx is empty, leaving
  // exactly "match by document.currentScript's own text", the AdGuard
  // semantic). maxArgs:2 (not 3) so a real AdGuard call's 2 args pass
  // through as-is. 'low' confidence: functionally verified against the
  // dispatch's own logic, not byte-diffed against AdGuard's real source.
  'abort-current-inline-script': { key: 'abort_current_script',  sep: 'comma', maxArgs: 2, confidence: 'low' },
  'aeld':                       { key: 'prevent_aeld',            sep: 'comma', maxArgs: 2, confidence: 'low' },
  // Real uBO filter lists spell this alias with the DOM API's own casing
  // (unlike every other hyphenated alias, which is all-lowercase) — the
  // lookup below is case-sensitive (matches the raw scriptlet name as
  // written), so this exact casing must be kept, not lowercased.
  'addEventListener-defuser':   { key: 'prevent_aeld',            sep: 'comma', maxArgs: 2, confidence: 'low' },
  'aopr':                       { key: 'abort_on_property_read',  sep: 'comma', maxArgs: 1, confidence: 'high' },
  // Full canonical name — same resource as 'aopr' above, just spelled out.
  // AdGuard's own public filter lists (e.g. their Yandex-specific rules)
  // call scriptlets by this full name via '#%#//scriptlet(...)' rather than
  // uBO's short alias, live-reported 2026-09-07.
  'abort-on-property-read':     { key: 'abort_on_property_read',  sep: 'comma', maxArgs: 1, confidence: 'high' },
  'aopw':                       { key: 'abort_on_property_write', sep: 'comma', maxArgs: 1, confidence: 'high' },
  'abort-on-property-write':    { key: 'abort_on_property_write', sep: 'comma', maxArgs: 1, confidence: 'high' },
  'aost':                       { key: 'abort_on_stack_trace',    sep: 'comma', maxArgs: 2, confidence: 'low' },
  'abort-on-stack-trace':       { key: 'abort_on_stack_trace',    sep: 'comma', maxArgs: 2, confidence: 'low' },
  'nano-sib':                   { key: 'adjust_setinterval',      sep: 'comma', maxArgs: 3, confidence: 'low' },
  'adjust-setInterval':         { key: 'adjust_setinterval',      sep: 'comma', maxArgs: 3, confidence: 'low' },
  'nano-stb':                   { key: 'adjust_settimeout',       sep: 'comma', maxArgs: 3, confidence: 'low' },
  'adjust-setTimeout':          { key: 'adjust_settimeout',       sep: 'comma', maxArgs: 3, confidence: 'low' },
  // 'nostif' = "no-SetTimeout-If" — was wrongly mapped to prevent_setinterval
  // (2026-09-03: found live via tinhte.vn's real anti-adblock counter-measure,
  // uAssets filters-general.txt: `tinhte.vn##+js(nostif, .getComputedStyle)` —
  // silently converted to the WRONG timer API, letting the site's actual
  // setTimeout-based getComputedStyle poll run unimpeded). Verified against
  // real uBO source (u-src/js/resources/prevent-settimeout.js): 'nostif'/
  // 'no-setTimeout-if'/'setTimeout-defuser' are ALL aliases of
  // prevent-setTimeout; the setInterval-targeting siblings are the
  // DIFFERENTLY-spelled 'nosiif'/'no-setInterval-if'/'setInterval-defuser'.
  // maxArgs raised 1->2 (2026-09-07): content/scriptlets.js's real dispatch
  // (`_eachRule(rules.prevent_settimeout, ...)` -> `_splitLast(v)` ->
  // `preventSetTimeout(pattern, delay)`) always supported a second `delay`
  // argument — this alias config was silently truncating it to just the
  // pattern for every uBO-syntax rule using it, found while cross-checking
  // against real AdGuard usage (`prevent-setTimeout('autoupdate', '100')`)
  // that needed the same 2-arg shape.
  'nostif':                     { key: 'prevent_settimeout',      sep: 'comma', maxArgs: 2, confidence: 'high' },
  'no-setTimeout-if':           { key: 'prevent_settimeout',      sep: 'comma', maxArgs: 2, confidence: 'high' },
  'setTimeout-defuser':         { key: 'prevent_settimeout',      sep: 'comma', maxArgs: 2, confidence: 'high' },
  'prevent-setTimeout':         { key: 'prevent_settimeout',      sep: 'comma', maxArgs: 2, confidence: 'high' },
  'nosiif':                     { key: 'prevent_setinterval',     sep: 'comma', maxArgs: 2, confidence: 'high' },
  'no-setInterval-if':          { key: 'prevent_setinterval',     sep: 'comma', maxArgs: 2, confidence: 'high' },
  'setInterval-defuser':        { key: 'prevent_setinterval',     sep: 'comma', maxArgs: 2, confidence: 'high' },
  'prevent-setInterval':        { key: 'prevent_setinterval',     sep: 'comma', maxArgs: 2, confidence: 'high' },
  'nostf':                      { key: 'prevent_settimeout',      sep: 'comma', maxArgs: 2, confidence: 'high' },
  'norafif':                    { key: 'prevent_raf',             sep: 'comma', maxArgs: 1, confidence: 'high' },
  'nowoif':                     { key: 'no_window_open_if',       sep: 'space', maxArgs: 3, confidence: 'low' },
  'noeval-if':                  { key: 'no_eval_if',              sep: 'comma', maxArgs: 1, confidence: 'high' },
  // AdGuard's full name for the same scriptlet — single 'pattern' arg
  // matches noEvalIf(v)'s dispatch exactly (content/scriptlets.js).
  'prevent-eval-if':            { key: 'no_eval_if',              sep: 'comma', maxArgs: 1, confidence: 'high' },
  'set':                        { key: 'set_constant',            sep: 'space', maxArgs: 2, confidence: 'low' },
  // Full canonical name — verified against content/scriptlets.js's own
  // `setC[k].split(/\s+/)` value parsing, same space-separated shape as 'set'.
  'set-constant':                { key: 'set_constant',           sep: 'space', maxArgs: 2, confidence: 'high' },
  'no-fetch-if':                { key: 'prevent_fetch',           sep: 'comma', maxArgs: 3, confidence: 'low' },
  'prevent-fetch':               { key: 'prevent_fetch',          sep: 'comma', maxArgs: 3, confidence: 'low' },
  'no-xhr-if':                  { key: 'prevent_xhr',             sep: 'comma', maxArgs: 1, confidence: 'high' },
  'prevent-xhr':                 { key: 'prevent_xhr',            sep: 'comma', maxArgs: 1, confidence: 'high' },
  'prevent-addEventListener':    { key: 'prevent_aeld',           sep: 'comma', maxArgs: 2, confidence: 'low' },
  // Both newly wired here (2026-09-07) — content/scriptlets.js already
  // dispatches these (`trustedSuppressNativeMethod(methodPath, signature,
  // behavior, stack)`, `preventElementSrcLoading(tagName, match)`), but
  // neither had ANY alias registered yet (not even a uBO short one), so no
  // real filter list could ever actually reach them before this.
  'trusted-suppress-native-method': { key: 'trusted_suppress_native_method', sep: 'comma', maxArgs: 4, confidence: 'high' },
  'prevent-element-src-loading':    { key: 'prevent_element_src_loading',    sep: 'comma', maxArgs: 2, confidence: 'high' },
  'json-prune':                 { key: 'json_prune',              sep: 'comma', maxArgs: 2, confidence: 'high' },
  'json-prune-fetch-response':  { key: 'json_prune_fetch',        sep: 'comma', maxArgs: 1, confidence: 'high' },
  'json-prune-xhr-response':    { key: 'json_prune_xhr',          sep: 'comma', maxArgs: 1, confidence: 'high' },
  'json-edit':                  { key: 'json_edit',               sep: 'comma', maxArgs: 1, confidence: 'high' },
  'jsonl-edit-xhr-response':    { key: 'jsonl_edit_xhr',          sep: 'comma', maxArgs: 2, confidence: 'low' },
  'trusted-replace-xhr-response': { key: 'trusted_replace_xhr_response', sep: 'comma', maxArgs: 3, confidence: 'low' },
  'trusted-prevent-dom-bypass': { key: 'prevent_dom_bypass',      sep: 'space', maxArgs: 2, confidence: 'low' },
  'nowebrtc':                   { key: 'no_webrtc',               flag: true, confidence: 'high' },
  'nobab':                      { key: 'prevent_bab',             flag: true, confidence: 'high' },
  'disable-newtab-links':       { key: 'disable_newtab_links',    flag: true, confidence: 'high' },
  // Added 2026-07 — verified against u-src/js/resources/*.js (real uBO source).
  'ra':                         { key: 'remove_attr',             sep: 'comma', maxArgs: 3, confidence: 'high' },
  'remove-attr':                { key: 'remove_attr',             sep: 'comma', maxArgs: 3, confidence: 'high' },
  'rmnt':                       { key: 'remove_node_text',        sep: 'comma', maxArgs: 2, confidence: 'high' },
  'remove-node-text':           { key: 'remove_node_text',        sep: 'comma', maxArgs: 2, confidence: 'high' },
  // rpnt/trusted-rpnt/replace-node-text are all "requires trust" in real uBO
  // (aliases of trusted-replace-node-text.js) — mapped to
  // trusted_replace_script_text (pre-execution insertion hook), NOT
  // replace_node_text (post-insertion MutationObserver, too late for a
  // synchronous inline <script> — see that key's own dispatch comment in
  // content/scriptlets.js). _abpParseFile gives this key special-cased
  // formatting (not the generic maxArgs slice) to preserve any trailing
  // sedCount/includes/excludes pairs, so maxArgs here is unused/moot.
  'rpnt':                       { key: 'trusted_replace_script_text', sep: 'comma', maxArgs: 99, confidence: 'high' },
  'trusted-rpnt':               { key: 'trusted_replace_script_text', sep: 'comma', maxArgs: 99, confidence: 'high' },
  'replace-node-text':          { key: 'trusted_replace_script_text', sep: 'comma', maxArgs: 99, confidence: 'high' },
  'refresh-defuser':            { key: 'refresh_defuser',         sep: 'comma', maxArgs: 1, confidence: 'high' },
  'prevent-refresh':            { key: 'refresh_defuser',         sep: 'comma', maxArgs: 1, confidence: 'high' },
  'set-cookie':                 { key: 'set_cookie',              sep: 'comma', maxArgs: 2, confidence: 'high' },
  'remove-cookie':              { key: 'remove_cookie',           sep: 'comma', maxArgs: 1, confidence: 'high' },
  'cookie-remover':             { key: 'remove_cookie',           sep: 'comma', maxArgs: 1, confidence: 'high' },
  'set-local-storage-item':     { key: 'set_local_storage_item',  sep: 'comma', maxArgs: 2, confidence: 'high' },
  'href-sanitizer':             { key: 'href_sanitizer',          sep: 'comma', maxArgs: 2, confidence: 'high' },
  'trusted-replace-fetch-response': { key: 'trusted_replace_fetch_response', sep: 'comma', maxArgs: 3, confidence: 'high' },
  'trusted-replace-argument':   { key: 'trusted_replace_argument', sep: 'comma', maxArgs: 3, confidence: 'high' },
  'trusted-prevent-fetch':      { key: 'trusted_prevent_fetch',   sep: 'comma', maxArgs: 2, confidence: 'high' },
};

// Dual export: Node (scripts/convert-uassets.js, scripts/convert-regions.js use
// `require`) vs the MV3 service worker (background.js uses `importScripts()`,
// which has no `module`/`require` — only plain global assignment works there).
// One data source either way, no second copy to drift out of sync.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SCRIPTLET_ALIAS_MAP;
} else {
  self.SCRIPTLET_ALIAS_MAP = SCRIPTLET_ALIAS_MAP;
}
