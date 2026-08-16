// site-block.js — generic native ad blocker driven by rule/site-rules.txt
(function(){
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

function extValid(){
  try{return !!(chrome.runtime&&chrome.runtime.getManifest());}
  catch(e){return false;}
}

// Substituted with a random string at build time (_build-lib.sh) — must
// match content.js/content/scriptlets.js's own copy of the placeholder.
var _QKV1_TOKEN='__QKV1_BUILD_TOKEN__';

function normalizeText(value){
  return (value||'').replace(/\s+/g,' ').trim().toLowerCase();
}

function compactText(value){
  return normalizeText(value).replace(/\s+/g,'');
}

function collect(root,selectors){
  var out=[],seen=new Set(),i;
  if(!root||!selectors||!selectors.length)return out;
  for(i=0;i<selectors.length;i++){
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
function _rebuildSelectorCache(){
  if(!_config){_cachedDirect=[];_cachedCandidates=[];_cachedHosts=[];_cachedStripClasses=[];_cachedStripInlineStyles=[];_cachedDirectStr='';_cachedCandidateStr='';_cachedHostStr='';return;}
  _cachedDirect=flattenSelectors(_config,DIRECT_HIDE_KEYS);
  _cachedCandidates=flattenSelectors(_config,CANDIDATE_KEYS);
  _cachedHosts=flattenSelectors(_config,HOST_KEYS);
  _cachedStripClasses=flattenSelectors(_config,STRIP_PAGE_CLASS_KEYS);
  _cachedStripInlineStyles=flattenSelectors(_config,STRIP_INLINE_STYLE_KEYS);
  _cachedDirectStr=_cachedDirect.join(',');
  _cachedCandidateStr=_cachedCandidates.join(',');
  _cachedHostStr=_cachedHosts.join(',');
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
  try{chrome.runtime.sendMessage({type:'CSS_SET',slot:slot,css:css||''}).catch(function(){});}catch(e){}
}
// Bare `body`/`html`-anchored selectors (e.g. `body:has(x) > y`) must skip
// the auto-prefix below — 'body '+'body:has(...)' is always false.
var _ALREADY_ROOT_SCOPED_RE=/^(body|html)(?![\w-])/i;
function _injectDirectStyle(){
  if(!_cachedDirect.length){_sendCssSlot('direct','');return;}
  // Validate each selector — one invalid selector drops the whole CSS rule.
  var valid=[];
  for(var i=0;i<_cachedDirect.length;i++){
    var sel=_cachedDirect[i];
    try{
      document.querySelector(sel);
      // Scope under `body ` so a broad selector can never match body/html
      // itself and blank the whole page — skipped when already root-scoped.
      valid.push(_ALREADY_ROOT_SCOPED_RE.test(sel)?sel:'body '+sel);
    }catch(e){}
  }
  if(!valid.length){_sendCssSlot('direct','');return;}
  _sendCssSlot('direct',valid.join(',\n')+'{display:none!important;visibility:hidden!important;height:0!important;overflow:hidden!important;pointer-events:none!important}');
}

function matchesAny(value,patterns){
  if(!value||!patterns||!patterns.length)return false;
  for(var i=0;i<patterns.length;i++)if(value.indexOf(compactText(patterns[i]))!==-1)return true;
  return false;
}

function hasMatchingLink(root,patterns){
  if(!root||!root.querySelectorAll||!patterns||!patterns.length)return false;
  var links=root.querySelectorAll('a[href]');
  for(var i=0;i<links.length;i++){
    var href=normalizeText(links[i].getAttribute('href'));
    for(var j=0;j<patterns.length;j++)if(href.indexOf(normalizeText(patterns[j]))!==-1)return true;
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
  var nodes=collect(root,selectors).slice(0,16);
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

function shadowRootHasAdSignal(shadow,cfg){
  if(!shadow)return false;
  try{
    var labels=cfg.labels||[];
    var patterns=cfg.link_patterns||[];
    var shadowLinks=shadow.querySelectorAll('a[href],a[aria-label],[aria-label],[slot="credit-bar"],faceplate-screen-reader-content');
    for(var i=0;i<shadowLinks.length;i++){
      var href=normalizeText(shadowLinks[i].getAttribute&&shadowLinks[i].getAttribute('href'));
      var aria=compactText(shadowLinks[i].getAttribute&&shadowLinks[i].getAttribute('aria-label'));
      var rel=compactText(shadowLinks[i].getAttribute&&shadowLinks[i].getAttribute('rel'));
      var text=compactText(shadowLinks[i].textContent);
      if(rel.indexOf('sponsored')!==-1)return true;
      if(matchesAny(aria,labels)||matchesAny(text,labels))return true;
      for(var j=0;j<patterns.length;j++)if(href.indexOf(normalizeText(patterns[j]))!==-1)return true;
    }
  }catch(e){}
  return false;
}

function shadowHasAdSignal(el,cfg){
  if(!el)return false;
  var hosts=collectShadowHosts(el);
  for(var i=0;i<hosts.length;i++)if(shadowRootHasAdSignal(hosts[i].shadowRoot,cfg))return true;
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
  if(matchesAny(attrBlob(el,cfg.attr_keys),cfg.labels))return true;
  if(matchesAny(attrBlob(el,cfg.attr_keys),cfg.link_patterns))return true;
  if(hasMatchingLink(el,cfg.link_patterns))return true;
  if(shadowHasAdSignal(el,cfg))return true;
  if(matchesAny(contextText(el,cfg),cfg.labels))return true;
  return false;
}

function collapseParentIfEmpty(el){
  var parent=el&&el.parentElement;
  if(!parent||parent===document.body||parent===document.documentElement)return;
  var hasVisible=false;
  for(var i=0;i<parent.children.length;i++){
    var c=parent.children[i];
    if(c.style.display!=='none'&&!c.dataset.qkv1H){hasVisible=true;break;}
  }
  if(!hasVisible){
    parent.style.setProperty('display','none','important');
    parent.style.setProperty('height','0','important');
    parent.style.setProperty('min-height','0','important');
    parent.style.setProperty('margin','0','important');
    parent.style.setProperty('padding','0','important');
    parent.style.setProperty('overflow','hidden','important');
    parent.dataset.qkv1H='1';
  }
}

// removeEl — fully removes element from DOM (used for known/direct ad selectors)
// After removal checks one level up to collapse empty parent containers.
function removeEl(el){
  if(!el)return false;
  var parent=el.parentElement;
  el.remove();
  if(parent)collapseParentIfEmpty({parentElement:parent});
  return true;
}

function hide(el){
  if(!el||el.dataset.qkv1H)return false;
  // Never hide the page itself — a broad rule (e.g. *:has(>[ad-attr]))
  // can match body/html when an ad script appends straight into <body>.
  if(el===document.body||el===document.documentElement)return false;
  el.style.setProperty('display','none','important');
  el.style.setProperty('visibility','hidden','important');
  el.dataset.qkv1H='1';
  collapseParentIfEmpty(el);
  return true;
}

function scan(root){
  if(!_enabled||!_config||!isEligiblePage(_config))return;
  var count=0;
  var direct=collectFast(root,_cachedDirectStr);
  for(var d=0;d<direct.length;d++)if(hide(direct[d]))count++;
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
    if(extValid())chrome.runtime.sendMessage({type:'COSMETIC_HIDDEN',count:count,url:location.href}).catch(function(){});
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
  'trusted_prune_inbound_object','trusted_suppress_native_method','m3u_prune','prevent_element_src_loading'];
var _scriptletRulesActive=false;
function _dispatchScriptletRules(cfg){
  var rules={},hasAny=false,k,i;
  for(i=0;i<SCRIPTLET_KEYS.length;i++){
    k=SCRIPTLET_KEYS[i];
    if(cfg[k]&&cfg[k].length){
      rules[k]=cfg[k];hasAny=true;
    }
  }
  if(hasAny){
    // Firefox Xray-wraps objects an isolated-world content script hands to the
    // page: the MAIN-world scriptlets.js listener would see `rules` as opaque
    // (every key reads undefined), so set_constant/json_prune_* never apply
    // and e.g. YouTube pre-roll ads play unblocked. cloneInto() clones the
    // object into the page's own compartment so it reads normally there.
    // Chrome has no Xray vision and no cloneInto global, so this is a no-op there.
    var detail=rules;
    try{if(typeof cloneInto==='function')detail=cloneInto(rules,window);}catch(e){}
    try{window.dispatchEvent(new CustomEvent('__'+_QKV1_TOKEN+'_rules__',{detail:detail}));_scriptletRulesActive=true;}catch(e){}
  }
}

function sync(cb){
  if(!extValid())return;
  try{chrome.storage.local.get(['enabled','pausedDomains','cosmeticFiltering'],function(res){
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
var _navScanT=0;
function _onSpaNav(){
  if(!_enabled||!_config)return;
  if(_navScanT)clearTimeout(_navScanT);
  _navScanT=setTimeout(function(){_navScanT=0;scan(document);},500);
}
document.addEventListener('yt-navigate-finish',_onSpaNav);
document.addEventListener('yt-page-data-updated',_onSpaNav);

window.addEventListener('__'+_QKV1_TOKEN+'_blk__',function(e){
  if(!extValid()||!_enabled)return;
  var url=location.href;
  chrome.runtime.sendMessage({type:'COSMETIC_HIDDEN',count:1,url:url}).catch(function(){});
});

chrome.runtime.onMessage.addListener(function(msg,_sender,sendResponse){
  if(msg.type==='TOGGLE'||msg.type==='PAUSE_DOMAIN'||msg.type==='COSMETIC_TOGGLE'){
    sync(sendResponse);
    return true;
  }
  if(msg.type==='GET_HIDDEN_COUNT')sendResponse({count:_hidden});
  if(msg.type==='RULES_CHANGED'){
    // Rule sources were updated — reset the cached parsed rules and re-apply.
    if(window.__qkv1Loader&&window.__qkv1Loader.reset)window.__qkv1Loader.reset();
    _config=null;
    siteKey='';
    stopObserver();
    stopPageClassWatch();
    boot();
  }
});
})();