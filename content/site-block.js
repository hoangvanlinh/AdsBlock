// site-block.js — generic native ad blocker driven by rule/site-rules.txt
(function(){
var hostname=location.hostname;
var siteKey=resolveSiteKey(hostname);
if(!siteKey)return;

var _enabled=true,_observer=null,_hidden=0,_raf=0,_config=null;
var DEFAULT_ATTR_KEYS=['aria-label','data-promoted','post-type','recommendation-source','slot','click-location','data-component-type','cel_widget_id','data-cel-widget'];
var CANDIDATE_KEYS=['selectors','feed_selectors','market_selectors','right_rail_selectors','post_selectors'];
var HOST_KEYS=['ad_host_selectors'];
var DIRECT_HIDE_KEYS=['direct_hide_selectors'];

function resolveSiteKey(host){
  if(/(^|\.)youtube\.com$/.test(host))return 'youtube';
  if(/(^|\.)facebook\.com$/.test(host))return 'facebook';
  if(/(^|\.)reddit\.com$/.test(host))return 'reddit';
  if(/(^|\.)instagram\.com$/.test(host))return 'instagram';
  if(/(^|\.)tiktok\.com$/.test(host))return 'tiktok';
  if(/(^|\.)x\.com$|(^|\.)twitter\.com$/.test(host))return 'x';
  if(/(^|\.)linkedin\.com$/.test(host))return 'linkedin';
  if(/(^|\.)pinterest\.com$/.test(host))return 'pinterest';
  if(/(^|\.)quora\.com$/.test(host))return 'quora';
  if(host.indexOf('amazon.')!==-1)return 'amazon';
  if(host.indexOf('google.')!==-1)return 'google';
  return '';
}

function extValid(){
  try{return !!(chrome.runtime&&chrome.runtime.getManifest());}
  catch(e){return false;}
}

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

function collectShadowHosts(root){
  var out=[],seen=new Set(),nodes=[],i;
  if(!root)return out;
  if(root.nodeType===1)nodes.push(root);
  if(root.querySelectorAll){
    try{root.querySelectorAll('*').forEach(function(el){nodes.push(el);});}catch(e){}
  }
  for(i=0;i<nodes.length;i++){
    if(!nodes[i]||!nodes[i].shadowRoot||seen.has(nodes[i]))continue;
    seen.add(nodes[i]);
    out.push(nodes[i]);
  }
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
    if(c.style.display!=='none'&&!c.dataset.adblockHidden){hasVisible=true;break;}
  }
  if(!hasVisible){
    parent.style.setProperty('display','none','important');
    parent.style.setProperty('height','0','important');
    parent.style.setProperty('min-height','0','important');
    parent.style.setProperty('margin','0','important');
    parent.style.setProperty('padding','0','important');
    parent.style.setProperty('overflow','hidden','important');
    parent.dataset.adblockHidden='1';
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
  if(!el||el.dataset.adblockHidden)return false;
  el.style.setProperty('display','none','important');
  el.style.setProperty('visibility','hidden','important');
  el.dataset.adblockHidden='1';
  collapseParentIfEmpty(el);
  return true;
}

function scan(root){
  if(!_enabled||!_config||!isEligiblePage(_config))return;
  var count=0;
  var direct=collect(root,flattenSelectors(_config,DIRECT_HIDE_KEYS));
  for(var d=0;d<direct.length;d++)if(removeEl(direct[d]))count++;
  var candidates=collect(root,flattenSelectors(_config,CANDIDATE_KEYS));
  for(var i=0;i<candidates.length;i++){
    if(!isAdCandidate(candidates[i],_config))continue;
    var target=nearestHideTarget(candidates[i],_config)||candidates[i];
    if(hide(target))count++;
  }
  var hosts=collect(root,flattenSelectors(_config,HOST_KEYS));
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
  if(_raf)return;
  _raf=requestAnimationFrame(function(){
    _raf=0;
    scan(root||document);
  });
}

function startObserver(){
  if(_observer)return;
  _observer=new MutationObserver(function(muts){
    if(!_enabled||!_config)return;
    var directSelectors=flattenSelectors(_config,DIRECT_HIDE_KEYS);
    for(var i=0;i<muts.length;i++){
      var mut=muts[i];
      // Fast path: direct_hide_selectors — hide immediately without RAF
      if(mut.type==='childList'){
        for(var j=0;j<mut.addedNodes.length;j++){
          var node=mut.addedNodes[j];
          if(node.nodeType!==1)continue;
          // Check node itself
          if(directSelectors.length){
            for(var s=0;s<directSelectors.length;s++){
              try{
                if(node.matches(directSelectors[s])){removeEl(node);break;}
              }catch(e){}
            }
          }
          // Check descendants inside the added node
          if(directSelectors.length&&node.querySelectorAll){
            var found=collect(node,directSelectors);
            for(var f=0;f<found.length;f++)removeEl(found[f]);
          }
          // Full scan for candidate/host selectors (deferred via RAF)
          schedule(node);
        }
      } else if(mut.type==='attributes'){
        // Attribute change may make an existing element become an ad
        var target=mut.target;
        if(target&&target.nodeType===1){
          if(directSelectors.length){
            for(var s2=0;s2<directSelectors.length;s2++){
              try{if(target.matches(directSelectors[s2])){removeEl(target);break;}}catch(e){}
            }
          }
          schedule(target);
        }
      }
    }
  });
  _observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['aria-label','slot','click-location','post-type','data-promoted','data-component-type','cel_widget_id','data-cel-widget','promoted','ad-type','placement']});
}

function stopObserver(){
  if(_observer){_observer.disconnect();_observer=null;}
}

// Shadow DOM support — observe each shadow root for direct_hide_selectors
var _shadowObservers=new WeakMap();

function observeShadowRoot(shadow){
  if(!shadow||_shadowObservers.has(shadow))return;
  var obs=new MutationObserver(function(muts){
    if(!_enabled||!_config)return;
    var directSelectors=flattenSelectors(_config,DIRECT_HIDE_KEYS);
    for(var i=0;i<muts.length;i++){
      for(var j=0;j<muts[i].addedNodes.length;j++){
        var node=muts[i].addedNodes[j];
        if(node.nodeType!==1)continue;
        // Fast hide for direct_hide_selectors inside shadow root
        for(var s=0;s<directSelectors.length;s++){
          try{if(node.matches(directSelectors[s])){removeEl(node);break;}}catch(e){}
        }
        if(node.querySelectorAll){
          var found=collect(node,directSelectors);
          for(var f=0;f<found.length;f++)removeEl(found[f]);
        }
        // Scan also runs full candidate check
        scan(node);
        // Recurse into nested shadow roots
        if(node.shadowRoot)observeShadowRoot(node.shadowRoot);
      }
    }
  });
  obs.observe(shadow,{childList:true,subtree:true,attributes:true,attributeFilter:['aria-label','slot','promoted','ad-type','placement']});
  _shadowObservers.set(shadow,obs);
  // Scan what's already in this shadow root
  scan(shadow);
  // Watch for nested shadow roots already present
  try{
    shadow.querySelectorAll('*').forEach(function(el){
      if(el.shadowRoot)observeShadowRoot(el.shadowRoot);
    });
  }catch(e){}
}

function attachShadowListeners(){
  // Listen for shadow-hook.js events (MAIN world patches attachShadow)
  document.addEventListener('__adblock_shadow_attached__',function(e){
    var host=e&&e.detail&&e.detail.host;
    if(!host)return;
    Promise.resolve().then(function(){
      if(host.shadowRoot)observeShadowRoot(host.shadowRoot);
    });
  });
  // Walk shadow roots already in page at boot time
  try{
    document.querySelectorAll('*').forEach(function(el){
      if(el.shadowRoot)observeShadowRoot(el.shadowRoot);
    });
  }catch(e){}
}

function sync(cb){
  if(!extValid())return;
  try{chrome.storage.local.get(['enabled','pausedDomains','cosmeticFiltering'],function(res){
    var paused=(res.pausedDomains||[]).indexOf(location.hostname)!==-1;
    _enabled=(res.enabled!==false)&&res.cosmeticFiltering!==false&&!paused;
    if(_enabled){schedule(document);startObserver();attachShadowListeners();}
    else stopObserver();
    if(cb)cb({ok:true});
  });}catch(e){}
}

function boot(){
  if(!(window.__adblockRuleLoader&&window.__adblockRuleLoader.load))return;
  window.__adblockRuleLoader.load(siteKey,{},function(cfg){
    _config=cfg||{};
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){sync();});
    else sync();
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

chrome.runtime.onMessage.addListener(function(msg,_sender,sendResponse){
  if(msg.type==='TOGGLE'||msg.type==='PAUSE_DOMAIN'||msg.type==='COSMETIC_TOGGLE'){
    sync(sendResponse);
    return true;
  }
  if(msg.type==='GET_HIDDEN_COUNT')sendResponse({count:_hidden});
});
})();