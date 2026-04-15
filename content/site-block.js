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

function shadowHasAdSignal(el,cfg){
  if(!el||!el.shadowRoot)return false;
  try{
    var shadow=el.shadowRoot;
    var labels=cfg.labels||[];
    var patterns=cfg.link_patterns||[];
    var shadowLinks=shadow.querySelectorAll('a[href],a[aria-label],[aria-label]');
    for(var i=0;i<shadowLinks.length;i++){
      var href=normalizeText(shadowLinks[i].getAttribute('href'));
      var aria=compactText(shadowLinks[i].getAttribute('aria-label'));
      var rel=compactText(shadowLinks[i].getAttribute('rel'));
      if(rel.indexOf('sponsored')!==-1)return true;
      if(matchesAny(aria,labels))return true;
      for(var j=0;j<patterns.length;j++)if(href.indexOf(normalizeText(patterns[j]))!==-1)return true;
    }
  }catch(e){}
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

function hide(el){
  if(!el||el.dataset.siteAdblockHidden)return false;
  el.style.setProperty('display','none','important');
  el.style.setProperty('visibility','hidden','important');
  el.dataset.siteAdblockHidden='1';
  return true;
}

function scan(root){
  if(!_enabled||!_config||!isEligiblePage(_config))return;
  var count=0;
  var direct=collect(root,flattenSelectors(_config,DIRECT_HIDE_KEYS));
  for(var d=0;d<direct.length;d++)if(hide(direct[d]))count++;
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
    if(!_enabled)return;
    for(var i=0;i<muts.length;i++){
      for(var j=0;j<muts[i].addedNodes.length;j++){
        if(muts[i].addedNodes[j].nodeType!==1)continue;
        schedule(muts[i].addedNodes[j]);
      }
    }
  });
  _observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['aria-label','slot','click-location','post-type','data-promoted','data-component-type','cel_widget_id','data-cel-widget']});
}

function stopObserver(){
  if(_observer){_observer.disconnect();_observer=null;}
}

function sync(cb){
  if(!extValid())return;
  try{chrome.storage.local.get(['enabled','pausedDomains','cosmeticFiltering'],function(res){
    var paused=(res.pausedDomains||[]).indexOf(location.hostname)!==-1;
    _enabled=(res.enabled!==false)&&res.cosmeticFiltering!==false&&!paused;
    if(_enabled){schedule(document);startObserver();}
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

chrome.runtime.onMessage.addListener(function(msg,_sender,sendResponse){
  if(msg.type==='TOGGLE'||msg.type==='PAUSE_DOMAIN'||msg.type==='COSMETIC_TOGGLE'){
    sync(sendResponse);
    return true;
  }
  if(msg.type==='GET_HIDDEN_COUNT')sendResponse({count:_hidden});
});
})();