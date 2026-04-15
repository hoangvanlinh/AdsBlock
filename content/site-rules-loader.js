// site-rules-loader.js — shared text rules loader for site-specific blockers
(function(){
if(window.__adblockRuleLoader)return;

var _parsed=null,_loading=null;
var REMOTE_RULES_URL='https://raw.githubusercontent.com/hoangvanlinh/AdsBlock/refs/heads/main/rule/site-rules.txt';
var LOCAL_RULES_PATH='rule/site-rules.txt';
var CACHE_KEY_TEXT='siteRulesCacheText';
var CACHE_KEY_TIME='siteRulesCacheTime';
var CACHE_TTL_MS=6*60*60*1000;

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
    out[section][key]=value?value.split('|').map(function(part){return part.trim();}).filter(Boolean):[];
  }
  return out;
}

function mergeDefaults(defaults, overrides){
  var cfg={},key;
  for(key in defaults){
    if(!Object.prototype.hasOwnProperty.call(defaults,key))continue;
    cfg[key]=Array.isArray(defaults[key])?defaults[key].slice():defaults[key];
    if(overrides&&Array.isArray(overrides[key])&&overrides[key].length)cfg[key]=overrides[key].slice();
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

function fetchRemoteRules(){
  return fetch(REMOTE_RULES_URL,{cache:'no-store'})
    .then(function(res){
      if(res.ok)return res.text();
      throw new Error('remote rules unavailable');
    })
    .then(function(text){
      if(!text)throw new Error('empty remote rules');
      return setCachedRules(text).then(function(){return text;});
    });
}

function fetchLocalRules(){
  return fetch(chrome.runtime.getURL(LOCAL_RULES_PATH),{cache:'no-store'})
    .then(function(res){return res.ok?res.text():'';});
}

function loadParsed(callback){
  if(_parsed){callback(_parsed);return;}
  if(!_loading){
    _loading=getCachedRules()
      .then(function(cached){
        if(isFreshCache(cached))return cached.text;
        return fetchRemoteRules().catch(function(){
          if(cached&&cached.text)return cached.text;
          return fetchLocalRules();
        });
      })
      .then(function(text){_parsed=parseRules(text);return _parsed;})
      .catch(function(){_parsed={};return _parsed;});
  }
  _loading.then(callback);
}

window.__adblockRuleLoader={
  load:function(siteKey,defaults,callback){
    loadParsed(function(parsed){
      var site=(siteKey||'').toLowerCase();
      callback(mergeDefaults(defaults||{},parsed[site]||{}));
    });
  }
};
})();