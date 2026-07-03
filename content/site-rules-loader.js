// site-rules-loader.js — shared site-config loader for site-specific blockers.
// Primary path: one GET_SITE_CONFIG message per frame — background parses the
// rules text ONCE and returns only [global] + this host's resolved section
// (a few KB). Full-text fetching/parsing here is kept only as a fallback for
// when background messaging is unavailable.
(function(){
if(window.__adblockRuleLoader)return;

var _site=null,_loading=null;
var DEBUG_LOCAL=false; // patched to true by build.sh when 4th arg is "true"
// Shared constants from config.js — listed before this file in the
// manifest's content_scripts js array, so ADBLOCK_CONFIG is already set.
var _CFG=self.ADBLOCK_CONFIG||{};
var REMOTE_RULES_URL=_CFG.RULES_REMOTE_URL;
var LOCAL_RULES_PATH=_CFG.RULES_LOCAL_PATH;
var CACHE_KEY_TEXT=_CFG.RULES_CACHE_TEXT_KEY;
var CACHE_KEY_TIME=_CFG.RULES_CACHE_TIME_KEY;
var CACHE_TTL_MS=_CFG.RULES_CACHE_TTL_MS;

function parseRules(text){
  var out={},section=null;
  var lines=(text||'').split(/\r?\n/);
  for(var i=0;i<lines.length;i++){
    var line=lines[i].trim();
    if(!line||line[0]==='#'||line[0]===';')continue;
    if(line[0]==='['&&line[line.length-1]===']'){
      section=line.slice(1,-1).trim().toLowerCase();
      if(section&&!out[section])out[section]={};
      continue;
    }
    if(!section)continue;
    var eq=line.indexOf('=');
    if(eq===-1)continue;
    var key=line.slice(0,eq).trim().toLowerCase();
    var value=line.slice(eq+1).trim();
    if(!key)continue;
    var newVals=value?value.split('|').map(function(part){return part.trim();}).filter(Boolean):[];
    if(out[section][key]&&out[section][key].length){
      // Merge: append values not already present (supports multiple source files)
      var seen=new Set(out[section][key]);
      newVals.forEach(function(v){if(!seen.has(v)){seen.add(v);out[section][key].push(v);}});
    }else{
      out[section][key]=newVals;
    }
  }
  return out;
}

function mergeDefaults(defaults, overrides){
  var cfg={},key;
  for(key in defaults){
    if(!Object.prototype.hasOwnProperty.call(defaults,key))continue;
    cfg[key]=Array.isArray(defaults[key])?defaults[key].slice():defaults[key];
  }
  for(key in overrides){
    if(!Object.prototype.hasOwnProperty.call(overrides,key))continue;
    if(Array.isArray(overrides[key])&&overrides[key].length)cfg[key]=overrides[key].slice();
  }
  return cfg;
}

function extValid(){
  try{return !!(chrome.runtime&&chrome.runtime.getManifest());}
  catch(e){return false;}
}

function getCachedRules(){
  return new Promise(function(resolve){
    if(!extValid()||!chrome.storage||!chrome.storage.local){resolve(null);return;}
    try{
      chrome.storage.local.get([CACHE_KEY_TEXT,CACHE_KEY_TIME],function(res){
        if(chrome.runtime.lastError||!res||!res[CACHE_KEY_TEXT]){resolve(null);return;}
        resolve({
          text: res[CACHE_KEY_TEXT],
          time: Number(res[CACHE_KEY_TIME]||0)
        });
      });
    }catch(e){resolve(null);}
  });
}

function setCachedRules(text){
  return new Promise(function(resolve){
    if(!extValid()||!chrome.storage||!chrome.storage.local||!text){resolve();return;}
    try{
      var payload={};
      payload[CACHE_KEY_TEXT]=text;
      payload[CACHE_KEY_TIME]=Date.now();
      chrome.storage.local.set(payload,function(){resolve();});
    }catch(e){resolve();}
  });
}

function isFreshCache(entry){
  return !!(entry&&entry.text&&entry.time&&(Date.now()-entry.time)<CACHE_TTL_MS);
}

function fetchRemoteRules(urls) {
  return Promise.all(urls.map(function(url) {
    return fetch(url, {cache: 'no-store'})
      .then(function(res) { return res.ok ? res.text() : ''; })
      .catch(function() { return ''; });
  })).then(function(texts) {
    return texts.filter(Boolean).join('\n');
  });
}

function fetchLocalRules(){
  return fetch(chrome.runtime.getURL(LOCAL_RULES_PATH),{cache:'no-store'})
    .then(function(res){return res.ok?res.text():'';});
}

// _fetchAndMergeDirect — fallback when background messaging is unavailable.
// Reads ruleSources from storage, fetches URL sources, merges with file sources.
function _fetchAndMergeDirect(cached, resolve){
  if(!extValid()||!chrome.storage||!chrome.storage.local){resolve(null);return;}
  chrome.storage.local.get(['ruleSources','customRulesUrl','customRulesText'],function(res){
    var sources=res.ruleSources;
    // Always load the default remote as base first
    var urls=[REMOTE_RULES_URL];
    var fileParts=[];
    if(sources&&sources.length){
      sources.forEach(function(s){
        if(s.type==='url'&&s.url&&s.url!==REMOTE_RULES_URL)urls.push(s.url);
        else if(s.type==='file'&&s.text)fileParts.push(s.text);
      });
    }else if(res.customRulesUrl&&res.customRulesUrl!==REMOTE_RULES_URL){
      urls.push(res.customRulesUrl);
    }
    // Append user's custom rules text
    if(res.customRulesText)fileParts.push(res.customRulesText);
    (urls.length?fetchRemoteRules(urls):Promise.resolve(''))
      .then(function(urlText){
        var merged=[urlText].concat(fileParts).filter(Boolean).join('\n');
        if(!merged){
          if(cached&&cached.text)return cached.text;
          return fetchLocalRules();
        }
        return setCachedRules(merged).then(function(){return merged;});
      })
      .then(resolve)
      .catch(function(){resolve((cached&&cached.text)||'');});
  });
}

// _resolveFromPatterns — resolve hostname against [host_patterns] (fallback path;
// the primary path lets background resolve). Same logic as background resolveSiteKey.
// LHS forms: hostname | wildcard TLD "base.*" | '|'-separated list | /regex/ (whole LHS).
function _hostPatternMatches(pat,host){
  pat=pat.trim();
  // Raw regex form: /body/flags — the whole LHS, never split on '|'
  if(pat.charAt(0)==='/'){
    var last=pat.lastIndexOf('/');
    if(last>0){
      try{return new RegExp(pat.slice(1,last),pat.slice(last+1)).test(host);}catch(e){}
    }
    return false;
  }
  var subs=pat.split('|');
  for(var i=0;i<subs.length;i++){
    var sub=subs[i].trim();
    if(!sub)continue;
    try{
      var re;
      if(sub.slice(-2)==='.*'){
        var base=sub.slice(0,-2).replace(/[.+?^${}()|[\]\\]/g,'\\$&');
        re=new RegExp('(^|\\.)'+base+'\\.');
      } else {
        var escaped=sub.replace(/[.+?^${}()|[\]\\]/g,'\\$&');
        re=new RegExp('(^|\\.)'+escaped+'$');
      }
      if(re.test(host))return true;
    }catch(e){}
  }
  return false;
}

function _resolveFromPatterns(patterns,host){
  for(var pat in patterns){
    if(!Object.prototype.hasOwnProperty.call(patterns,pat))continue;
    var targetKey=(patterns[pat]&&patterns[pat][0])||'';
    if(!targetKey)continue;
    if(_hostPatternMatches(pat,host))return targetKey;
  }
  return '';
}

// Build the {siteKey, global, site} shape from a full rules text (fallback only).
function _fromParsedText(text){
  var parsed=parseRules(text||'');
  var host=(location.hostname||'').toLowerCase();
  var siteKey=_resolveFromPatterns(parsed.host_patterns||{},host);
  return {siteKey:siteKey,global:parsed.global||{},site:(siteKey&&parsed[siteKey])||{}};
}

function _loadFallback(resolve){
  getCachedRules().then(function(cached){
    if(isFreshCache(cached)){resolve(_fromParsedText(cached.text));return;}
    _fetchAndMergeDirect(cached,function(text){resolve(_fromParsedText(text||''));});
  });
}

function loadSiteConfig(callback){
  if(_site){callback(_site);return;}
  if(!_loading){
    _loading=new Promise(function(resolve){
      if(DEBUG_LOCAL){
        fetchLocalRules()
          .then(function(t){resolve(_fromParsedText(t));})
          .catch(function(){resolve({siteKey:'',global:{},site:{}});});
        return;
      }
      if(!extValid()){_loadFallback(resolve);return;}
      try{
        chrome.runtime.sendMessage({type:'GET_SITE_CONFIG',host:location.hostname},function(res){
          if(chrome.runtime.lastError||!res){_loadFallback(resolve);return;}
          resolve({siteKey:res.siteKey||'',global:res.global||{},site:res.site||{}});
        });
      }catch(e){_loadFallback(resolve);}
    }).then(function(site){_site=site;return site;});
  }
  _loading.then(callback);
}

window.__adblockRuleLoader={
  // loadSite — preferred API: full resolved config for this frame's hostname.
  loadSite:function(callback){loadSiteConfig(callback);},
  // load — backward-compatible section accessor ('global' or this host's siteKey).
  load:function(sectionKey,defaults,callback){
    loadSiteConfig(function(site){
      var key=(sectionKey||'').toLowerCase();
      var section={};
      if(key==='global')section=site.global;
      else if(key&&key===site.siteKey)section=site.site;
      callback(mergeDefaults(defaults||{},section||{}));
    });
  },
  reset:function(){
    _site=null;
    _loading=null;
  }
};

// Listen for RULES_CHANGED from background (triggered when rule sources are updated).
// Reset the in-memory parsed cache so the next load() call re-fetches with new sources.
if(typeof chrome!=='undefined'&&chrome.runtime&&chrome.runtime.onMessage){
  try{
    chrome.runtime.onMessage.addListener(function(msg){
      if(msg&&msg.type==='RULES_CHANGED'){
        _parsed=null;
        _loading=null;
      }
    });
  }catch(e){}
}
})();