// site-block.js — generic native ad blocker driven by rule/site-rules.txt
(function(){
// Substituted with a random string at build time (_build-lib.sh) — must
// match content.js/content/scriptlets.js's own copy of the placeholder.
var _QKV1_TOKEN='__QKV1_BUILD_TOKEN__';

// _directAuthInjected/_DIRECT_CSS_SESSION_KEY/_fastPathDirectStyle() must come
// FIRST, before any other declaration in this file: the goal is to fire the
// last-known-good 'direct' CSS (see _injectDirectStyle() further down) as
// early as possible, before loadSite()'s GET_SITE_CONFIG round-trip to
// background even resolves. `_sendCssSlot`/`_fastPathDirectStyle` are
// `function` declarations (fully hoisted, body and all) so calling
// _fastPathDirectStyle() here — before their textual definition further down
// — is safe; only the `var`s right below it are NOT hoisted-with-value, so
// they genuinely must be assigned before this call.
var _directAuthInjected=false;
// content/fastpath-storage.js (listed right before this file in
// manifest.json/manifest.firefox.json) already resolved, ONCE, whether
// chrome.storage.session is actually reachable from this content script and
// falls back to chrome.storage.local transparently when it isn't
// (setAccessLevel not granted, or genuinely unavailable — see
// background.js's own setAccessLevel comment for a live-reproduced case).
// _fpStorage.get()/.set() are always Promise-based (never callback-style —
// mixing styles broke an earlier version of this once the underlying object
// could resolve to Firefox's native, Promise-only browser.storage.session).
// Falls back to an inert no-op stub if fastpath-storage.js somehow didn't
// run first (defensive — should never happen given the fixed manifest.json
// load order, same defensive fallback style as _HIDE_ATTR below).
var _fpStorage=window.__qkv1FastpathStorage||{get:function(){return Promise.resolve({});},set:function(){return Promise.resolve();},lruLimit:10,usingSession:false};
// Per-host LRU-capped map (NOT a single shared slot — neither storage.session
// nor storage.local is naturally per-origin the way localStorage is, so this
// manages that scoping ourselves) holding the last CSS computed for the
// 'direct' slot per hostname. Lives in the extension's own storage: unlike
// the page's own localStorage, no page JS (not even a same-origin
// third-party iframe like an embedded Facebook widget) can ever read,
// enumerate, or tamper with it — chrome.storage simply isn't reachable from
// page JS under any circumstance, whichever area _fpStorage lands on.
// Capped at _fpStorage.lruLimit entries (evict-oldest-by-timestamp, smaller
// when the .local fallback is in play — see fastpath-storage.js's own
// comment) because the underlying quota is SHARED across the whole
// extension either way — background.js's own parsedRulesSessionCache alone
// measured up to 8.27MB of chrome.storage.session's 10MB on a real large
// config, and siteRulesCacheText alone measured ~76-87% of
// chrome.storage.local's — an unbounded per-host map here would compete
// with (and could starve) either. Trade-off accepted: _fpStorage.get() is
// still asynchronous (no API gives a truly synchronous read here), so this
// is a best-effort head start, not a guaranteed pre-paint.
var _DIRECT_CSS_SESSION_KEY=(self.ADBLOCK_CONFIG&&self.ADBLOCK_CONFIG.DIRECT_CSS_FASTPATH_KEY)||'directCssFastPath';
_fastPathDirectStyle();

// _scriptletAuthDispatched/_SCRIPTLET_RULES_SESSION_KEY/
// _fastPathDispatchScriptletRules() — same early-fire pattern as the direct
// CSS fast path above, but bridges a curated-safe subset of scriptlet rules
// into scriptlets.js's MAIN world via the existing _EVT_RULES CustomEvent
// (see _dispatchScriptletRules() further down), since MAIN world has NO
// chrome.* access at all and can never read chrome.storage itself — this is
// the only way to get it anything before the real GET_SITE_CONFIG round-trip
// resolves. Only SCRIPTLET_SAFE_CACHE_KEYS (defined near SCRIPTLET_KEYS
// below) are ever cached/replayed here — see that constant's own comment for
// why the rest of SCRIPTLET_KEYS is excluded.
var _scriptletAuthDispatched=false;
var _SCRIPTLET_RULES_SESSION_KEY=(self.ADBLOCK_CONFIG&&self.ADBLOCK_CONFIG.SCRIPTLET_RULES_FASTPATH_KEY)||'scriptletRulesFastPath';
_fastPathDispatchScriptletRules();

var siteKey='';

var _enabled=true,_observer=null,_hidden=0,_raf=0,_config=null;
// requestIdleCallback scheduling — run cosmetic work when the browser is
// idle; fall back to setTimeout(fn,50) if rIC not available.
var _ric=window.requestIdleCallback?function(fn){return requestIdleCallback(fn,{timeout:100});}:function(fn){return setTimeout(fn,50);};
// Track widened scan root across multiple schedule() calls in the same mutation batch.
var _pendingScanRoot=null;
var DEFAULT_ATTR_KEYS=['aria-label','data-promoted','post-type','recommendation-source','slot','click-location','data-component-type','cel_widget_id','data-cel-widget'];
var CANDIDATE_KEYS=['selectors','feed_selectors','market_selectors','right_rail_selectors','post_selectors'];
var HOST_KEYS=['ad_host_selectors'];
var DIRECT_HIDE_KEYS=['direct_hide_selectors'];
// strip_page_classes — class names some pages toggle on <html>/<body> to drive
// a CSS-only takeover overlay (e.g. Taboola's "Explore More" gray backdrop).
// Hiding the element itself doesn't help when the backdrop is painted purely
// from the root class (::before/background-on-root), so we strip the class instead.
var STRIP_PAGE_CLASS_KEYS=['strip_page_classes'];
// strip_inline_styles — CSS property names some pages set DIRECTLY on
// <html>/<body>.style (not via a class) to lock scroll while a modal/overlay
// is "open" (e.g. react-modal's body.style.overflow='hidden', set alongside
// but independently of its own bodyOpenClassName toggle). A class-only
// strip like the one above does nothing for this — the inline style wins
// the cascade regardless of what class is or isn't present.
var STRIP_INLINE_STYLE_KEYS=['strip_inline_styles'];
// Selector caches — rebuilt once when _config changes, reused on every scan/mutation
var _cachedDirect=[], _cachedCandidates=[], _cachedHosts=[], _cachedStripClasses=[], _cachedStripInlineStyles=[];
var _cachedDirectStr='', _cachedCandidateStr='', _cachedHostStr='';
// Pre-normalized labels/link_patterns — matchesAny()/hasMatchingLink() used
// to re-run compactText()/normalizeText() on these same small, static
// arrays on EVERY call, for EVERY ad-candidate element scan() finds (up to
// 3x per candidate via isAdCandidate). Normalizing once here instead, kept
// in sync with _cachedDirect/etc. by _rebuildSelectorCache().
var _cachedLabelsCompact=[], _cachedLinkPatternsCompact=[], _cachedLinkPatternsNorm=[];

function extValid(){
  try{return !!(EXT.runtime&&EXT.runtime.getManifest());}
  catch(e){return false;}
}

// Marker attribute for elements already hidden by hide()/collapseParentIfEmpty
// (dedup + collapse-propagation state, see below). Generated fresh per page
// load by content.js (runs earlier in this same content_scripts entry — see
// its own comment for why) and read back here off the shared isolated-world
// `window`, NOT computed from the build-static _QKV1_TOKEN above — a value
// that changes every navigation is worthless to a page that only ever
// observes one load. Falls back to the old build-token derivation only if
// content.js somehow didn't run first (defensive — should never happen
// given the fixed manifest.json load order).
var _HIDE_ATTR=window.__qkv1HideAttr||('h'+_QKV1_TOKEN);

function normalizeText(value){
  return (value||'').replace(/\s+/g,' ').trim().toLowerCase();
}

function compactText(value){
  return normalizeText(value).replace(/\s+/g,'');
}

// limit (optional) — stop checking FURTHER selectors once out.length hits
// it. Only caller today (contextText) always immediately .slice(0,16)s the
// result anyway, so once earlier (higher-priority) selectors already
// gathered enough, later selectors' querySelectorAll calls are skipped
// entirely instead of matching a page-wide set just to throw it away.
function collect(root,selectors,limit){
  var out=[],seen=new Set(),i;
  if(!root||!selectors||!selectors.length)return out;
  for(i=0;i<selectors.length;i++){
    if(limit&&out.length>=limit)break;
    try{
      if(root.nodeType===1&&root.matches(selectors[i])&&!seen.has(root)){
        seen.add(root);out.push(root);
      }
      if(!root.querySelectorAll)continue;
      root.querySelectorAll(selectors[i]).forEach(function(el){
        if(seen.has(el))return;
        seen.add(el);out.push(el);
      });
    }catch(e){}
  }
  return out;
}

function flattenSelectors(cfg,keys){
  var out=[],seen=new Set(),i,j,list;
  for(i=0;i<keys.length;i++){
    list=cfg[keys[i]]||[];
    for(j=0;j<list.length;j++){
      if(seen.has(list[j]))continue;
      seen.add(list[j]);out.push(list[j]);
    }
  }
  return out;
}

// collectFast — single querySelectorAll with a pre-joined selector string.
// ~10-50x faster than calling querySelectorAll once per selector.
function collectFast(root,selectorStr){
  if(!root||!selectorStr)return[];
  var out=[];
  try{
    if(root.nodeType===1&&root.matches(selectorStr))out.push(root);
    if(root.querySelectorAll)root.querySelectorAll(selectorStr).forEach(function(el){out.push(el);});
  }catch(e){}
  return out;
}

// _rebuildSelectorCache — compute and cache flattened+joined selector strings from _config.
// Called once after _config is assigned so scan() and the observer don't recompute per call.
var _directCounted=false;
function _rebuildSelectorCache(){
  _directCounted=false;
  if(!_config){
    _cachedDirect=[];_cachedCandidates=[];_cachedHosts=[];_cachedStripClasses=[];_cachedStripInlineStyles=[];
    _cachedDirectStr='';_cachedCandidateStr='';_cachedHostStr='';
    _cachedLabelsCompact=[];_cachedLinkPatternsCompact=[];_cachedLinkPatternsNorm=[];
    return;
  }
  _cachedDirect=flattenSelectors(_config,DIRECT_HIDE_KEYS);
  _cachedCandidates=flattenSelectors(_config,CANDIDATE_KEYS);
  _cachedHosts=flattenSelectors(_config,HOST_KEYS);
  _cachedStripClasses=flattenSelectors(_config,STRIP_PAGE_CLASS_KEYS);
  _cachedStripInlineStyles=flattenSelectors(_config,STRIP_INLINE_STYLE_KEYS);
  _cachedDirectStr=_cachedDirect.join(',');
  _cachedCandidateStr=_cachedCandidates.join(',');
  _cachedHostStr=_cachedHosts.join(',');
  var labels=_config.labels||[], linkPatterns=_config.link_patterns||[];
  _cachedLabelsCompact=labels.map(compactText);
  _cachedLinkPatternsCompact=linkPatterns.map(compactText);
  _cachedLinkPatternsNorm=linkPatterns.map(normalizeText);
}

// _stripClassesFrom — remove any cached class from a single root element
// (<html> or <body>) the instant it's present.
function _stripClassesFrom(el){
  if(!el||!_cachedStripClasses.length)return;
  for(var i=0;i<_cachedStripClasses.length;i++){
    if(el.classList.contains(_cachedStripClasses[i]))el.classList.remove(_cachedStripClasses[i]);
  }
}

// _stripInlineStylesFrom — clear any cached inline style property directly
// set on a single root element (<html> or <body>) the instant it's present.
// removeProperty (not setting to '' / 'auto') so the page's OWN stylesheet
// rules resume deciding the value, same "get out of the way" behavior as
// _stripClassesFrom.
function _stripInlineStylesFrom(el){
  if(!el||!_cachedStripInlineStyles.length)return;
  for(var i=0;i<_cachedStripInlineStyles.length;i++){
    if(el.style.getPropertyValue(_cachedStripInlineStyles[i]))el.style.removeProperty(_cachedStripInlineStyles[i]);
  }
}

// Two dedicated observers (one per root element) rather than a subtree
// observer — we only ever care about these two nodes' own class/style
// attributes, so watching the whole tree would be wasteful.
var _htmlClassObserver=null,_bodyClassObserver=null;
function watchPageClasses(){
  if(!_cachedStripClasses.length&&!_cachedStripInlineStyles.length)return;
  if(!_htmlClassObserver&&document.documentElement){
    _stripClassesFrom(document.documentElement);
    _stripInlineStylesFrom(document.documentElement);
    _htmlClassObserver=new MutationObserver(function(){_stripClassesFrom(document.documentElement);_stripInlineStylesFrom(document.documentElement);});
    _htmlClassObserver.observe(document.documentElement,{attributes:true,attributeFilter:['class','style']});
  }
  if(!_bodyClassObserver&&document.body){
    _stripClassesFrom(document.body);
    _stripInlineStylesFrom(document.body);
    _bodyClassObserver=new MutationObserver(function(){_stripClassesFrom(document.body);_stripInlineStylesFrom(document.body);});
    _bodyClassObserver.observe(document.body,{attributes:true,attributeFilter:['class','style']});
  }
}

function stopPageClassWatch(){
  if(_htmlClassObserver){_htmlClassObserver.disconnect();_htmlClassObserver=null;}
  if(_bodyClassObserver){_bodyClassObserver.disconnect();_bodyClassObserver=null;}
}

// _injectDirectStyle — direct_hide_selectors are sent to background as the
// 'direct' CSS slot (background applies via chrome.scripting.insertCSS —
// see background.js's setFrameCss). The style engine then hides current AND
// future matching nodes for free — no per-mutation JS matching, and an empty
// slot send instantly disables everything (content.js's CSS_CLEAR_ALL, on
// pause/disable, clears this slot the same way it clears 'base'/'custom').
function _sendCssSlot(slot,css){
  if(!extValid())return;
  try{EXT.runtime.sendMessage({type:'CSS_SET',slot:slot,css:css||''}).catch(function(){});}catch(e){}
}
// Bare `body`/`html`-anchored selectors (e.g. `body:has(x) > y`) must skip
// the auto-prefix below — 'body '+'body:has(...)' is always false.
var _ALREADY_ROOT_SCOPED_RE=/^(body|html)(?![\w-])/i;
// _evictOldestLruEntry — drop the least-recently-written host entry from a
// per-host session-cache map (shared by the direct-CSS and scriptlet-rules
// fast-path caches below) so it stays within its own LRU cap. O(n) over the
// capped map (at most a few dozen entries) — trivial, only runs on a NEW
// host being added while already at the cap, not on every write.
function _evictOldestLruEntry(map){
  var oldestHost=null,oldestTs=Infinity;
  for(var h in map){
    if(!Object.prototype.hasOwnProperty.call(map,h))continue;
    var ts=(map[h]&&map[h].ts)||0;
    if(ts<oldestTs){oldestTs=ts;oldestHost=h;}
  }
  if(oldestHost!==null)delete map[oldestHost];
}

// _updateDirectCssCacheEntry — read-modify-write the per-host LRU map for
// THIS host only. A plain read-then-write (not atomic) is fine here: worst
// case under a race is one write among several independent frames/hosts
// gets clobbered, which just means that ONE host's fast-path guess is a
// visit older than it could've been — self-corrects on its own next real
// visit, same "lossy cache, not a source of truth" tolerance the rest of
// this fast-path already relies on.
function _updateDirectCssCacheEntry(host,css){
  if(!extValid())return;
  try{
    _fpStorage.get([_DIRECT_CSS_SESSION_KEY]).then(function(res){
      var map=(res&&res[_DIRECT_CSS_SESSION_KEY])||{};
      if(!css){
        // Nothing to hide on this host — drop any stale non-empty guess from
        // an earlier visit rather than keep serving it.
        delete map[host];
      }else{
        var isNewHost=!Object.prototype.hasOwnProperty.call(map,host);
        if(isNewHost&&Object.keys(map).length>=_fpStorage.lruLimit)_evictOldestLruEntry(map);
        map[host]={css:css,ts:Date.now()};
      }
      var payload={};payload[_DIRECT_CSS_SESSION_KEY]=map;
      _fpStorage.set(payload).catch(function(){});
    }).catch(function(){});
  }catch(e){}
}

// Scope under `body ` so a broad selector can never match body/html itself
// and blank the whole page — skipped when already root-scoped.
function _scopedDirectRule(sel){
  var scoped=_ALREADY_ROOT_SCOPED_RE.test(sel)?sel:'body '+sel;
  return scoped+'{display:none!important}';
}

// Only worth the per-selector document.querySelector() cost below (each
// call is cheap alone, but _cachedDirect can be 13,000+ entries when a site
// has no dedicated section and inherits [global] wholesale straight from a
// large merged ABP source like EasyList — real-measured 2026-08-30) once
// the list is actually that large. A real site-specific direct_hide_selectors
// list is always small (tens of entries), never worth filtering.
var _DIRECT_FILTER_CACHE_THRESHOLD=100;

function _injectDirectStyle(){
  _directAuthInjected=true; // real config wins over the fast-path guess from here on
  var host=location.hostname;
  if(!_cachedDirect.length){
    _sendCssSlot('direct','');
    _updateDirectCssCacheEntry(host,'');
    return;
  }
  // One SEPARATE rule per selector (not one combined :where(...) list) —
  // matches uBlock Origin's own actual generated CSS (vAPI.hideStyle,
  // explodeCSS — verified against their real source), and gives the same
  // per-selector fault tolerance :where() existed for without needing it: a
  // syntactically invalid selector fails to parse its OWN rule only (normal
  // CSS parse-error recovery, rule-by-rule), leaving every other rule
  // unaffected — no O(n) synchronous document.querySelector() validation
  // needed either way. display:none!important alone (not also visibility/
  // height/overflow/pointer-events) — also matching uBO's vAPI.hideStyle —
  // is sufficient on its own: once it wins the cascade (origin:'user'/
  // cssOrigin:'user', see background.js's setFrameCss), the element already
  // takes zero layout space and paints nothing, so the other 4 properties
  // never had anything left to add.
  //
  // The REAL CSS sent to the browser (below) always covers the FULL
  // _cachedDirect list — never narrowed — so correctness never depends on
  // which selectors happened to match at injection time (late-arriving ads
  // are still covered). Only the SEPARATE fast-path CACHE (further down)
  // gets narrowed, and only for the [global]-inherited case.
  var rules=[];
  for(var i=0;i<_cachedDirect.length;i++)rules.push(_scopedDirectRule(_cachedDirect[i]));
  _sendCssSlot('direct',rules.join('\n\n'));

  // directCssFastPath's per-host cache entry (2026-08-30): a host with NO
  // dedicated site section inherits [global].direct_hide_selectors AS-IS —
  // live-measured over 1MB for a single host once EasyList (13,632 global
  // selectors) is enabled, duplicated again for every OTHER such host up to
  // _fpStorage.lruLimit entries. Caching the full list is real, unavoidable
  // work the FIRST time this host is seen (one-time
  // document.querySelector() pass per candidate selector, accepted cost —
  // same "pay once, reuse cheaply after" trade _fastPathDirectStyle's
  // whole existence already rests on) — but only the selectors that
  // actually matched something on THIS page's DOM are worth caching for
  // NEXT time; the other several thousand that matched nothing here almost
  // certainly won't next time either (same site, same template).
  var cacheSelectors=_cachedDirect;
  if(_cachedDirect.length>_DIRECT_FILTER_CACHE_THRESHOLD){
    cacheSelectors=[];
    for(var j=0;j<_cachedDirect.length;j++){
      try{if(document.querySelector(_cachedDirect[j]))cacheSelectors.push(_cachedDirect[j]);}catch(e){}
    }
  }
  var cacheRules=[];
  for(var k=0;k<cacheSelectors.length;k++)cacheRules.push(_scopedDirectRule(cacheSelectors[k]));
  _updateDirectCssCacheEntry(host,cacheRules.join('\n\n'));
}

// _fastPathDirectStyle — fires the LAST successfully-computed 'direct' CSS
// for THIS host (from its own last visit — see the LRU map comment near
// _fpStorage above) as early as possible at content-script start,
// before loadSite()'s GET_SITE_CONFIG round-trip to background even
// resolves. That round-trip is fast on a warm service worker but can cost a
// chrome.storage.session read (cold-started SW) or a full remote rule fetch
// (no valid parsed-rules cache yet) with no timeout — during which ads would
// otherwise flash unhidden. This read is itself a chrome.storage.session
// call (same async class as that round-trip), so it's a best-effort head
// start, not a guaranteed win — chosen over the page's own localStorage
// specifically because chrome.storage is never reachable from page JS (no
// fingerprint exposure, not even inside a same-page third-party iframe like
// an embedded Facebook widget). _injectDirectStyle() always re-sends the
// real CSS once loadSite() resolves and _directAuthInjected stops this
// stale guess from winning a race against it.
function _fastPathDirectStyle(){
  if(!extValid())return;
  try{
    _fpStorage.get([_DIRECT_CSS_SESSION_KEY]).then(function(res){
      if(_directAuthInjected)return;
      var map=res&&res[_DIRECT_CSS_SESSION_KEY];
      var entry=map&&map[location.hostname];
      var css=entry&&entry.css;
      if(css)_sendCssSlot('direct',css);
    }).catch(function(){});
  }catch(e){}
}

// _sendScriptletRulesEvent — the actual isolated-world→MAIN-world handoff,
// shared by the real dispatch (_dispatchScriptletRules, further down) and
// the early fast-path guess (_fastPathDispatchScriptletRules, right below).
// cloneInto: see _dispatchScriptletRules's own comment on this line — Firefox
// Xray-wraps a plain object handed across the world boundary, which would
// make every key silently read undefined on the MAIN-world side.
function _sendScriptletRulesEvent(rules){
  var detail=rules;
  try{if(typeof cloneInto==='function')detail=cloneInto(rules,window);}catch(e){}
  try{window.dispatchEvent(new CustomEvent('__'+_QKV1_TOKEN+'_rules__',{detail:detail}));}catch(e){}
}

// _fastPathDispatchScriptletRules — mirrors _fastPathDirectStyle's timing
// strategy, but for scriptlets.js instead of the 'direct' CSS slot.
// scriptlets.js runs in MAIN world, which has NO chrome.* access at all
// (browsers never inject extension APIs into the page's own JS realm — a
// hard platform limit, not a permissions one), so it can never read
// chrome.storage itself. This isolated-world script reads the per-host cache
// instead and bridges it across via the SAME _EVT_RULES CustomEvent
// _dispatchScriptletRules() uses for the real data — scriptlets.js doesn't
// need to know or care whether a given dispatch was the early guess or the
// real one; _applyScriptletRules() already replaces its registries on every
// dispatch (replace semantics), so the real one arriving after this one
// simply supersedes it. Only ever fires SCRIPTLET_SAFE_CACHE_KEYS values
// (enforced by what _updateScriptletCacheEntry writes below, not by any
// filtering here) — the whole reason that curated subset exists in the
// first place.
function _fastPathDispatchScriptletRules(){
  if(!extValid())return;
  try{
    _fpStorage.get([_SCRIPTLET_RULES_SESSION_KEY]).then(function(res){
      if(_scriptletAuthDispatched)return;
      var map=res&&res[_SCRIPTLET_RULES_SESSION_KEY];
      var entry=map&&map[location.hostname];
      var rules=entry&&entry.rules;
      if(rules&&Object.keys(rules).length){
        // Deliberately does NOT set _scriptletRulesActive — that flag means
        // "the REAL dispatch has happened" and gates sync()'s decision to
        // call _dispatchScriptletRules() below. Setting it here from a
        // stale cache guess was a real bug: it made sync() think the real
        // dispatch already ran and permanently skip it for the rest of this
        // page's life whenever the fast path fired successfully — the exact
        // opposite of "replace semantics" this function's own comment
        // promises, live-caught 2026-08-25 by re-auditing the flag's usage.
        _sendScriptletRulesEvent(rules);
      }
    }).catch(function(){});
  }catch(e){}
}

// _updateScriptletCacheEntry — read-modify-write the per-host LRU map for
// THIS host's SAFE-subset scriptlet rules, same lossy-cache tolerance as
// _updateDirectCssCacheEntry above (a clobbered write just means a slightly
// staler guess next visit, self-corrects on the next real dispatch).
function _updateScriptletCacheEntry(host,safeRules){
  if(!extValid())return;
  try{
    _fpStorage.get([_SCRIPTLET_RULES_SESSION_KEY]).then(function(res){
      var map=(res&&res[_SCRIPTLET_RULES_SESSION_KEY])||{};
      if(!safeRules||!Object.keys(safeRules).length){
        delete map[host];
      }else{
        var isNewHost=!Object.prototype.hasOwnProperty.call(map,host);
        if(isNewHost&&Object.keys(map).length>=_fpStorage.lruLimit)_evictOldestLruEntry(map);
        map[host]={rules:safeRules,ts:Date.now()};
      }
      var payload={};payload[_SCRIPTLET_RULES_SESSION_KEY]=map;
      _fpStorage.set(payload).catch(function(){});
    }).catch(function(){});
  }catch(e){}
}

// patterns must already be normalized (compactText) — callers pass
// _cachedLabelsCompact/_cachedLinkPatternsCompact (see _rebuildSelectorCache),
// never cfg.labels/cfg.link_patterns raw.
function matchesAny(value,normalizedPatterns){
  if(!value||!normalizedPatterns||!normalizedPatterns.length)return false;
  for(var i=0;i<normalizedPatterns.length;i++)if(value.indexOf(normalizedPatterns[i])!==-1)return true;
  return false;
}

// patterns must already be normalized (normalizeText) — callers pass
// _cachedLinkPatternsNorm (see _rebuildSelectorCache), never cfg.link_patterns raw.
function hasMatchingLink(root,normalizedPatterns){
  if(!root||!root.querySelectorAll||!normalizedPatterns||!normalizedPatterns.length)return false;
  var links=root.querySelectorAll('a[href]');
  for(var i=0;i<links.length;i++){
    var href=normalizeText(links[i].getAttribute('href'));
    for(var j=0;j<normalizedPatterns.length;j++)if(href.indexOf(normalizedPatterns[j])!==-1)return true;
  }
  return false;
}

function attrBlob(el,attrKeys){
  if(!el||!el.getAttribute)return '';
  var parts=[],keys=attrKeys&&attrKeys.length?attrKeys:DEFAULT_ATTR_KEYS;
  for(var i=0;i<keys.length;i++){
    var value=el.getAttribute(keys[i]);
    if(value)parts.push(value);
  }
  return compactText(parts.join(' '));
}

function contextText(root,cfg){
  if(!root)return '';
  var selectors=cfg.context_selectors&&cfg.context_selectors.length?cfg.context_selectors:['header','[role="heading"]','span','a'];
  var nodes=collect(root,selectors,16).slice(0,16);
  if(!nodes.length)nodes=[root];
  for(var i=0;i<nodes.length;i++){
    var text=compactText(nodes[i].getAttribute&&nodes[i].getAttribute('aria-label')||nodes[i].textContent);
    if(text&&text.length<=240)return text;
  }
  return '';
}

// Live registry of shadow hosts, populated from observeShadowRoot() — every
// discovery path (attachShadow hook, boot walk, nested walk) calls that
// function, so it's the one place that needs to register hosts. Almost no
// site config actually needs shadow-DOM signal checks (grep
// rule/site-rules.txt: only Reddit does), so isAdCandidate's per-candidate
// shadowHasAdSignal call used to pay for a full `root.querySelectorAll('*')`
// subtree walk on every site just to find zero shadow hosts. Filtering this
// small known-hosts set by containment instead turns that into an O(1)
// empty-Set return on pages with no shadow DOM at all, and O(knownHosts)
// elsewhere.
var _knownShadowHosts=new Set();
function collectShadowHosts(root){
  var out=[];
  if(!root||!_knownShadowHosts.size)return out;
  // Detached hosts (removed by SPA navigation) are pruned lazily here rather
  // than tracked via a disconnect callback — cheap, and self-corrects on
  // every subsequent call.
  _knownShadowHosts.forEach(function(host){
    if(!host.isConnected){_knownShadowHosts.delete(host);return;}
    if(host===root||(root.contains&&root.contains(host)))out.push(host);
  });
  return out;
}

function shadowRootHasAdSignal(shadow){
  if(!shadow)return false;
  try{
    var shadowLinks=shadow.querySelectorAll('a[href],a[aria-label],[aria-label],[slot="credit-bar"],faceplate-screen-reader-content');
    for(var i=0;i<shadowLinks.length;i++){
      var href=normalizeText(shadowLinks[i].getAttribute&&shadowLinks[i].getAttribute('href'));
      var aria=compactText(shadowLinks[i].getAttribute&&shadowLinks[i].getAttribute('aria-label'));
      var rel=compactText(shadowLinks[i].getAttribute&&shadowLinks[i].getAttribute('rel'));
      var text=compactText(shadowLinks[i].textContent);
      if(rel.indexOf('sponsored')!==-1)return true;
      if(matchesAny(aria,_cachedLabelsCompact)||matchesAny(text,_cachedLabelsCompact))return true;
      for(var j=0;j<_cachedLinkPatternsNorm.length;j++)if(href.indexOf(_cachedLinkPatternsNorm[j])!==-1)return true;
    }
  }catch(e){}
  return false;
}

function shadowHasAdSignal(el){
  if(!el)return false;
  var hosts=collectShadowHosts(el);
  for(var i=0;i<hosts.length;i++)if(shadowRootHasAdSignal(hosts[i].shadowRoot))return true;
  return false;
}

function nearestHideTarget(el,cfg){
  if(!el||!el.closest)return null;
  var selectors=cfg.hide_closest||[];
  for(var i=0;i<selectors.length;i++){
    try{
      var found=el.closest(selectors[i]);
      if(found)return found;
    }catch(e){}
  }
  return null;
}

function isEligiblePage(cfg){
  var paths=cfg.paths||[];
  var queryKeys=cfg.query_keys||[];
  var pathOk=!paths.length;
  var queryOk=!queryKeys.length;
  for(var i=0;i<paths.length;i++)if(location.pathname.indexOf(paths[i])===0){pathOk=true;break;}
  for(var j=0;j<queryKeys.length;j++)if(location.search.indexOf(queryKeys[j]+'=')!==-1){queryOk=true;break;}
  return pathOk&&queryOk;
}

function isAdCandidate(el,cfg){
  if(!el)return false;
  if(matchesAny(attrBlob(el,cfg.attr_keys),_cachedLabelsCompact))return true;
  if(matchesAny(attrBlob(el,cfg.attr_keys),_cachedLinkPatternsCompact))return true;
  if(hasMatchingLink(el,_cachedLinkPatternsNorm))return true;
  if(shadowHasAdSignal(el))return true;
  if(matchesAny(contextText(el,cfg),_cachedLabelsCompact))return true;
  return false;
}

function collapseParentIfEmpty(el){
  var parent=el&&el.parentElement;
  if(!parent||parent===document.body||parent===document.documentElement)return;
  var hasVisible=false;
  for(var i=0;i<parent.children.length;i++){
    var c=parent.children[i];
    // Cheap checks first (inline style / our own JS-hide marker) — a
    // direct_hide_selectors match is hidden PURELY by the injected
    // stylesheet (see scan() below) and never gets either of those, so it
    // would otherwise look "visible" here and block the parent from
    // collapsing. getComputedStyle() is the fallback, not the common case,
    // since it forces a style recalc (real cost, only worth paying when the
    // cheap checks don't already have an answer).
    if(c.style.display==='none'||c.hasAttribute(_HIDE_ATTR))continue;
    if(getComputedStyle(c).display==='none')continue;
    hasVisible=true;break;
  }
  if(!hasVisible){
    parent.style.setProperty('display','none','important');
    parent.style.setProperty('height','0','important');
    parent.style.setProperty('min-height','0','important');
    parent.style.setProperty('margin','0','important');
    parent.style.setProperty('padding','0','important');
    parent.style.setProperty('overflow','hidden','important');
    parent.setAttribute(_HIDE_ATTR,'1');
  }
}

// removeEl — fully removes element from DOM (used for known/direct ad selectors)
// After removal checks one level up to collapse empty parent containers.
function removeEl(el){
  if(!el)return false;
  var parent=el.parentElement;
  el.replaceChildren();
  el.style.setProperty('display','none','important');
  if(parent)collapseParentIfEmpty({parentElement:parent});
  return true;
}

function hide(el){
  if(!el||el.hasAttribute(_HIDE_ATTR))return false;
  // Never hide the page itself — a broad rule (e.g. *:has(>[ad-attr]))
  // can match body/html when an ad script appends straight into <body>.
  if(el===document.body||el===document.documentElement)return false;
  el.style.setProperty('display','none','important');
  el.style.setProperty('visibility','hidden','important');
  el.setAttribute(_HIDE_ATTR,'1');
  collapseParentIfEmpty(el);
  return true;
}

function scan(root){
  if(!_enabled||!_config||!isEligiblePage(_config))return;
  var count=0;
  // direct_hide_selectors are already hidden the instant they exist by the
  // injected stylesheet (_injectDirectStyle) — re-matching the full (often
  // large, merged-across-sources) selector string against every mutation
  // batch bought nothing visually and got slower the more rules were enabled.
  // Only re-run it once per boot (root===document catches the first full
  // scan) purely to seed the "ads blocked" counter; later dynamically-added
  // matches are still hidden instantly by CSS, just not re-counted.
  //
  // No DOM touch on these elements themselves (2026-08-30, 3rd attempt) —
  // relying purely on the injected stylesheet. The 2nd attempt was
  // live-disproven (getComputedStyle showed display:block/flex, not none)
  // — but that was BEFORE the real root cause was found: a CSS block with
  // several properties in one declaration was triggering
  // NS_ERROR_ILLEGAL_VALUE (nsIDOMWindowUtils.addSheet) on Firefox, which
  // silently failed the whole insertCSS call — not a cascade/origin
  // problem. Both this file's CSS (_injectDirectStyle, single property per
  // rule) and content.js's BASE_CSS were simplified to one
  // display:none!important property per rule, and live-verified on
  // Firefox afterward: getComputedStyle correctly read back display:none
  // for supper_masthead/banner-ads/rich-media-banner-ads/contact-quangcao.
  // collapseParentIfEmpty() still runs (cheap, no CSS dependency) so
  // parent containers still collapse correctly once these are hidden.
  if(!_directCounted&&root===document){
    _directCounted=true;
    var direct=collectFast(root,_cachedDirectStr);
    for(var d=0;d<direct.length;d++){
      // Skip a match already marked by an EARLIER iteration's
      // collapseParentIfEmpty() in this same loop (e.g. direct[d] is itself
      // the parent container a prior direct[] match just collapsed) —
      // same double-count guard hide()'s own hasAttribute(_HIDE_ATTR)
      // early-return used to provide before this loop stopped calling it.
      if(direct[d].hasAttribute(_HIDE_ATTR))continue;
      collapseParentIfEmpty(direct[d]);
      count++;
    }
  }
  var candidates=collectFast(root,_cachedCandidateStr);
  for(var i=0;i<candidates.length;i++){
    if(!isAdCandidate(candidates[i],_config))continue;
    var target=nearestHideTarget(candidates[i],_config)||candidates[i];
    if(hide(target))count++;
  }
  var hosts=collectFast(root,_cachedHostStr);
  for(var j=0;j<hosts.length;j++){
    if(!isAdCandidate(hosts[j],_config))continue;
    var hostTarget=nearestHideTarget(hosts[j],_config)||hosts[j];
    if(hide(hostTarget))count++;
  }
  if(count>0){
    _hidden+=count;
    if(extValid())EXT.runtime.sendMessage({type:'COSMETIC_HIDDEN',count:count,url:location.href}).catch(function(){});
  }
}

function schedule(root){
  root=root||document;
  // Widen pending root when multiple different subtrees are queued in the same batch
  // (the old RAF approach silently dropped all calls after the first via `if(_raf)return`).
  if(_pendingScanRoot===null){
    _pendingScanRoot=root;
  } else if(_pendingScanRoot!==document&&!_pendingScanRoot.contains(root)){
    _pendingScanRoot=document;
  }
  if(_raf)return;
  _raf=_ric(function(){
    _raf=0;
    var r=_pendingScanRoot||document;
    _pendingScanRoot=null;
    scan(r);
  });
}

function startObserver(){
  if(_observer)return;
  // direct_hide_selectors are handled entirely by the injected stylesheet
  // (_injectDirectStyle) — the observer only queues candidate/host scanning,
  // which runs deferred at idle. No selector matching on the mutation hot path.
  _observer=new MutationObserver(function(muts){
    if(!_enabled||!_config)return;
    for(var i=0;i<muts.length;i++){
      var mut=muts[i];
      if(mut.type==='childList'){
        for(var j=0;j<mut.addedNodes.length;j++){
          var node=mut.addedNodes[j];
          if(node.nodeType!==1)continue;
          if(node===document.body)watchPageClasses();
          schedule(node);
        }
      } else if(mut.type==='attributes'){
        // Attribute change may make an existing element become an ad
        var target=mut.target;
        if(target&&target.nodeType===1)schedule(target);
      }
    }
  });
  _observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['aria-label','slot','click-location','post-type','data-promoted','data-component-type','cel_widget_id','data-cel-widget','promoted','ad-type','placement','data-ad-rendering-role','data-ad-comet-preview','data-ad-preview']});
}

function stopObserver(){
  if(_observer){_observer.disconnect();_observer=null;}
}

// Shadow DOM support — observe each shadow root for direct_hide_selectors
var _shadowObservers=new WeakMap();

function observeShadowRoot(shadow){
  if(!shadow)return;
  // Every discovery path (attachShadow hook, boot walk, nested walk below)
  // routes through here — a single choke point to register the host in
  // _knownShadowHosts, so collectShadowHosts never has to re-walk the DOM.
  if(shadow.host)_knownShadowHosts.add(shadow.host);
  if(_shadowObservers.has(shadow))return;
  // The injected stylesheet does not pierce shadow roots, so direct_hide_selectors
  // still need JS matching here — using the pre-joined cached string (previously
  // this recomputed flattenSelectors on every mutation batch).
  //
  // That JS matching goes through schedule() (idle-batched), NOT run
  // synchronously per mutation like an earlier version of this observer
  // did — live-profiled (2026-08-10) as the actual cause of a "video
  // takes a while to start" complaint: a call to `collectFast`+`scan()`
  // (2-3 querySelectorAll passes each) on EVERY single shadow-DOM
  // mutation, and YouTube's own player is built from many nested,
  // heavily-churning shadow roots during startup — the main thread was
  // getting blocked by querySelectorAll repeatedly at exactly that
  // moment. scan() (called via schedule()) already does the same
  // collectFast(root,_cachedDirectStr) as its first step, so nothing is
  // lost — matches inside shadow DOM just get hidden a tick later
  // instead of perfectly synchronously.
  var obs=new MutationObserver(function(muts){
    if(!_enabled||!_config)return;
    for(var i=0;i<muts.length;i++){
      for(var j=0;j<muts[i].addedNodes.length;j++){
        var node=muts[i].addedNodes[j];
        if(node.nodeType!==1)continue;
        schedule(node);
        // Recurse into nested shadow roots — stays synchronous (cheap,
        // no selector matching) so a newly-created shadow root's own
        // mutations are never missed.
        if(node.shadowRoot)observeShadowRoot(node.shadowRoot);
      }
    }
  });
  obs.observe(shadow,{childList:true,subtree:true,attributes:true,attributeFilter:['aria-label','slot','promoted','ad-type','placement']});
  _shadowObservers.set(shadow,obs);
  // Scan what's already in this shadow root — deferred (see comment
  // above): many shadow roots get discovered in quick succession during
  // YouTube's initial player construction, and schedule() coalesces them
  // into far fewer actual scan() passes than calling scan() synchronously
  // here once per discovery would.
  schedule(shadow);
  // Watch for nested shadow roots already present
  try{
    shadow.querySelectorAll('*').forEach(function(el){
      if(el.shadowRoot)observeShadowRoot(el.shadowRoot);
    });
  }catch(e){}
}

var _shadowListenerAttached=false;
function attachShadowListeners(){
  // Listen for shadow-hook.js events (MAIN world patches attachShadow)
  if(!_shadowListenerAttached){
    _shadowListenerAttached=true;
    document.addEventListener('__'+_QKV1_TOKEN+'_sh__',function(e){
      var host=e&&e.detail&&e.detail.host;
      if(!host)return;
      Promise.resolve().then(function(){
        if(host.shadowRoot)observeShadowRoot(host.shadowRoot);
      });
    });
  }
  // Walk shadow roots already in page at boot time
  try{
    document.querySelectorAll('*').forEach(function(el){
      if(el.shadowRoot)observeShadowRoot(el.shadowRoot);
    });
  }catch(e){}
}

// Scriptlet rules bridge — receiving the token-suffixed "rules" event
// re-enables scriptlets in the MAIN world, so rules must only be dispatched
// while _enabled. _scriptletRulesActive tracks the MAIN-world state so
// sync() can re-dispatch after an unpause without re-wrapping APIs on every
// sync.
var SCRIPTLET_KEYS=['json_prune_fetch','json_prune_xhr','set_constant','no_window_open_if','prevent_xhr','json_edit','jsonl_edit_xhr','prevent_dom_bypass',
  // Wired 2026-07: previously defined in scriptlets.js but unreachable from rules,
  // plus newly ported scriptlets (see _applyScriptletRules for value formats).
  'json_prune','prevent_fetch','prevent_settimeout','prevent_setinterval','prevent_raf','prevent_aeld',
  'adjust_settimeout','adjust_setinterval','abort_current_script','abort_on_property_read',
  'abort_on_property_write','abort_on_stack_trace','no_eval_if','no_webrtc','prevent_bab','disable_newtab_links',
  'trusted_replace_xhr_response',
  // Wired 2026-07: newly ported scriptlets.
  'remove_attr','remove_node_text','replace_node_text','refresh_defuser','set_cookie','remove_cookie',
  'set_local_storage_item','href_sanitizer','trusted_replace_fetch_response','trusted_replace_argument',
  'trusted_replace_outbound_text',
  'trusted_prevent_fetch',
  // Wired 2026-07-31: request/response JSONPath editing + prune-on-assignment +
  // pre-insertion script rewriting (see _applyScriptletRules for value formats).
  'trusted_edit_request','trusted_edit_response','json_prune_on_set','trusted_replace_script_text',
  // 'adblock_wall_retry' removed 2026-08-16 — ssapUnplayableRetry now
  // auto-enables on youtube.com unconditionally (content/scriptlets.js),
  // no site-rules.txt key to relay here anymore.
  // Wired 2026-08-16: ported from ABY (AdGuard Scriptlets, clean-room) — see
  // trustedPruneInboundObject/trustedSuppressNativeMethod/m3uPrune/
  // preventElementSrcLoading in scriptlets.js for value formats.
  'trusted_prune_inbound_object','trusted_suppress_native_method','m3u_prune','prevent_element_src_loading',
  // Wired 2026-08-21: generic setter-hijack for anti-adblock overlay
  // counter-scripts — see trustedSuppressSetter in scriptlets.js for value format.
  'trusted_suppress_setter',
  // Wired 2026-08-21: privacy signal flags — background.js's GET_SITE_CONFIG
  // synthesizes these from chrome.storage (dashboard Privacy toggles), never
  // hand-written in site-rules.txt. See spoofGpcSignal/hideDocumentReferrerJs
  // in scriptlets.js.
  'gpc_signal','hide_document_referrer',
  // Wired 2026-08-28: makes the data-sjs SSR guard's marker attribute name
  // and length-tracking attribute config-driven instead of hardcoded — see
  // _configureSjsGuard/_installSjsGuard in scriptlets.js. Value format:
  // "markerAttr[, lengthAttr]" — absent key means "use the current
  // default", zero behavior change.
  'sjs_guard'];
// SCRIPTLET_SAFE_CACHE_KEYS — the ONLY SCRIPTLET_KEYS entries ever written
// to/replayed from _fastPathDispatchScriptletRules()'s per-host cache.
// Audited 2026-08-25 key by key against scriptlets.js's actual
// implementation (not assumed): SAFE means _applyScriptletRules() fully
// resets and rebuilds that rule's registry/array on every dispatch
// (`_fetchPruneRules.length=0` etc.), so a stale cached value is completely
// superseded the instant the real dispatch lands — no residue. Everything
// else in SCRIPTLET_KEYS installs a PERMANENT hook at install time (a
// non-configurable defineProperty trap, a MutationObserver, a wrap-once
// proxy with the pattern baked into its closure) that nothing ever
// un-installs — a stale value there can win FOREVER even after the real one
// arrives, not just briefly. This audit found two former assumptions wrong:
// set_constant and abort_on_property_read/write were in an EARLIER (now
// removed) cache's "safe" list, but actually use a non-configurable
// defineProperty — a second call with a different same-typed value is
// silently swallowed, so a stale cached constant would permanently block
// the real one from ever taking effect. Excluded here on that basis.
var SCRIPTLET_SAFE_CACHE_KEYS=['json_prune_fetch','json_prune_xhr','json_edit','jsonl_edit_xhr','json_prune',
  'no_window_open_if','trusted_edit_request','trusted_edit_response','trusted_replace_xhr_response',
  'trusted_replace_fetch_response','m3u_prune','set_cookie','set_local_storage_item','refresh_defuser',
  'no_webrtc','prevent_bab','disable_newtab_links','gpc_signal','hide_document_referrer',
  'sjs_guard'];
var _SCRIPTLET_SAFE_CACHE_SET={};
(function(){for(var i=0;i<SCRIPTLET_SAFE_CACHE_KEYS.length;i++)_SCRIPTLET_SAFE_CACHE_SET[SCRIPTLET_SAFE_CACHE_KEYS[i]]=true;})();
var _scriptletRulesActive=false;
function _dispatchScriptletRules(cfg){
  _scriptletAuthDispatched=true; // real config wins over the fast-path guess from here on
  var rules={},safeRules={},hasAny=false,hasSafe=false,k,i;
  for(i=0;i<SCRIPTLET_KEYS.length;i++){
    k=SCRIPTLET_KEYS[i];
    if(cfg[k]&&cfg[k].length){
      rules[k]=cfg[k];hasAny=true;
      if(_SCRIPTLET_SAFE_CACHE_SET[k]){safeRules[k]=cfg[k];hasSafe=true;}
    }
  }
  if(hasAny){
    // Firefox Xray-wraps objects an isolated-world content script hands to the
    // page: the MAIN-world scriptlets.js listener would see `rules` as opaque
    // (every key reads undefined), so set_constant/json_prune_* never apply
    // and e.g. YouTube pre-roll ads play unblocked. cloneInto() clones the
    // object into the page's own compartment so it reads normally there.
    // Chrome has no Xray vision and no cloneInto global, so this is a no-op there.
    // (see _sendScriptletRulesEvent, shared with the fast-path dispatch above)
    _sendScriptletRulesEvent(rules);
    _scriptletRulesActive=true;
  }
  _updateScriptletCacheEntry(location.hostname,hasSafe?safeRules:null);
}

function sync(cb){
  if(!extValid())return;
  try{EXT.storage.local.get(['enabled','pausedDomains','cosmeticFiltering'],function(res){
    var paused=(res.pausedDomains||[]).indexOf(location.hostname)!==-1;
    _enabled=(res.enabled!==false)&&res.cosmeticFiltering!==false&&!paused;
    if(_enabled){
      // Re-send in case a previous pause/disable cleared it in background
      // (CSS_CLEAR_ALL wipes ALL slots, not just content.js's own) — a no-op
      // send (background diffs and skips) when it was never cleared.
      _injectDirectStyle();
      schedule(document);startObserver();attachShadowListeners();watchPageClasses();
      if(_config&&!_scriptletRulesActive)_dispatchScriptletRules(_config);
    }
    else{
      stopObserver();
      stopPageClassWatch();
      try{window.dispatchEvent(new CustomEvent('__'+_QKV1_TOKEN+'_dis__'));}catch(_e){}
      _scriptletRulesActive=false;
    }
    if(cb)cb({ok:true});
  });}catch(e){}
}

// Merge two config objects: a key the site section defines for itself
// REPLACES the global value entirely — sites curate their own selector/
// pattern lists deliberately, and appending the generic global list on
// top just adds matching cost (querySelectorAll, JSONPath, etc.) for
// patterns that realistically never occur on that site's DOM/traffic. A
// key the site does NOT define still falls back to global as before.
// Scalar fields from overlay override base unconditionally either way.
function _mergeConfigs(base,overlay){
  var cfg={},key;
  for(key in base){
    if(!Object.prototype.hasOwnProperty.call(base,key))continue;
    cfg[key]=Array.isArray(base[key])?base[key].slice():base[key];
  }
  for(key in overlay){
    if(!Object.prototype.hasOwnProperty.call(overlay,key))continue;
    if(Array.isArray(overlay[key])&&overlay[key].length){
      cfg[key]=overlay[key].slice();
    } else if(overlay[key]!==undefined&&!Array.isArray(overlay[key])){
      cfg[key]=overlay[key];
    }
  }
  return cfg;
}

function boot(){
  if(!(window.__qkv1Loader&&window.__qkv1Loader.loadSite))return;
  // One loader call returns {siteKey, global, site} — the loader (or background)
  // resolves [host_patterns] for this frame's hostname.
  window.__qkv1Loader.loadSite(function(res){
    siteKey=(res&&res.siteKey)||'';
    var base=(res&&res.global)||{};
    _config=_mergeConfigs(base,(res&&res.site)||{});
    _rebuildSelectorCache();
    // Send the direct-hide CSS immediately (before DOMContentLoaded) so
    // late-rendered ads never paint. content.js's CSS_CLEAR_ALL (on
    // pause/disable) clears this slot in background for free.
    _injectDirectStyle();
    // New/changed config must always be re-dispatched — reset the flag so the
    // sync below sends it (but only if the site turns out to be enabled).
    _scriptletRulesActive=false;
    sync();
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){sync();watchPageClasses();});
  });
}

boot();

// Re-scan entire document after YouTube SPA navigation.
// MutationObserver catches individual nodes but may miss elements rendered
// during large DOM replacements. A delayed full scan fills the gap.
/// var _navScanT=0;
/// function _onSpaNav(){
///   if(!_enabled||!_config)return;
///   if(_navScanT)clearTimeout(_navScanT);
///   _navScanT=setTimeout(function(){_navScanT=0;scan(document);},500);
/// }
/// document.addEventListener('yt-navigate-finish',_onSpaNav);
/// document.addEventListener('yt-page-data-updated',_onSpaNav);

window.addEventListener('__'+_QKV1_TOKEN+'_blk__',function(e){
  if(!extValid()||!_enabled)return;
  var url=location.href;
  EXT.runtime.sendMessage({type:'COSMETIC_HIDDEN',count:1,url:url}).catch(function(){});
});

EXT.runtime.onMessage.addListener(function(msg,_sender,sendResponse){
  if(msg.type==='TOGGLE'||msg.type==='PAUSE_DOMAIN'||msg.type==='COSMETIC_TOGGLE'){
    sync(sendResponse);
    return true;
  }
  if(msg.type==='GET_HIDDEN_COUNT')sendResponse({count:_hidden});
  if(msg.type==='RULES_CHANGED'||msg.type==='PRIVACY_TOGGLE'){
    // Rule sources were updated (or a dashboard privacy toggle flipped,
    // which GET_SITE_CONFIG folds into `global` — see background.js) —
    // reset the cached parsed rules and re-apply. loadSiteConfig() in
    // site-rules-loader.js caches its GET_SITE_CONFIG result in module-level
    // _site until reset() clears it, so sync() alone (used by TOGGLE/
    // PAUSE_DOMAIN/COSMETIC_TOGGLE above) would keep re-dispatching the
    // stale cached config instead of picking up the new flag value.
    if(window.__qkv1Loader&&window.__qkv1Loader.reset)window.__qkv1Loader.reset();
    _config=null;
    siteKey='';
    stopObserver();
    stopPageClassWatch();
    boot();
  }
});
})();