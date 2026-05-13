// site-rules-loader.js — shared text rules loader for site-specific blockers
(function(){
if(window.__adblockRuleLoader)return;

var _parsed=null,_loading=null;
var DEBUG_LOCAL=false; // patched to true by build.sh when 4th arg is "true"
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
  chrome.storage.local.get(['ruleSources','customRulesUrl'],function(res){
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

function loadParsed(callback){
  if(_parsed){callback(_parsed);return;}
  if(!_loading){
    _loading=(DEBUG_LOCAL
      ? fetchLocalRules()
      : getCachedRules().then(function(cached){
          if(isFreshCache(cached))return cached.text;
          // Delegate to background service worker — it is the single fetcher that
          // reads ruleSources (URL + file), merges, and writes the shared cache.
          // This prevents the double-fetch of REMOTE_RULES_URL.
          return new Promise(function(resolve){
            if(!extValid()){_fetchAndMergeDirect(cached,resolve);return;}
            try{
              chrome.runtime.sendMessage({type:'GET_RULES_TEXT'},function(res){
                if(chrome.runtime.lastError||!res||!res.text){
                  _fetchAndMergeDirect(cached,resolve);return;
                }
                // Cache the received text so isFreshCache works on next page load
                setCachedRules(res.text).then(function(){resolve(res.text);});
              });
            }catch(e){_fetchAndMergeDirect(cached,resolve);}
          });
        })
    ).then(function(text){_parsed=parseRules(text);return _parsed;})
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
  },
  reset:function(){
    _parsed=null;
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