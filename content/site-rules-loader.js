// site-rules-loader.js — shared site-config loader for site-specific blockers.
// Primary path: one GET_SITE_CONFIG message per frame — background parses the
// rules text ONCE and returns only [global] + this host's resolved section
// (a few KB). Full-text fetching/parsing here is kept only as a fallback for
// when background messaging is unavailable.
(function(){
if(window.__qkv1Loader)return;

var _site=null,_loading=null;
// Shared constants from config.js — listed before this file in the
// manifest's content_scripts js array, so ADBLOCK_CONFIG is already set.
var _CFG=self.ADBLOCK_CONFIG||{};
// build.sh patches DEBUG_LOCAL in config.js when the 4th arg is "true",
// switching every context (this loader + background DNR) to local rules.
var DEBUG_LOCAL=!!_CFG.DEBUG_LOCAL;
// Built-in default Rule Sources — array of {name, url, enable} (config.js).
var DEFAULT_RULE_SOURCES=_CFG.RULES_REMOTE_URL||[];
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
    // '\\|' escapes a literal '|' inside a value (kept in sync with background.js).
    var newVals=value?value.split(/(?<!\\)\|/).map(function(part){return part.trim().replace(/\\\|/g,'|');}).filter(Boolean):[];
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
  try{return !!(EXT.runtime&&EXT.runtime.getManifest());}
  catch(e){return false;}
}

// Mirrors background.js's _compressForStorage/_decompressFromStorage
// (2026-08-24) — this content-script fallback path (only engaged when
// background messaging itself is unavailable) reads/writes the SAME
// CACHE_KEY_TEXT storage key, so it must agree on the same {format,data}
// wrapper. Rule text compresses ~8.5x with deflate-raw (measured on a
// real-shaped multi-MB ruleset) — a real user's merged siteRulesCacheText
// can be several MB, a meaningful share of chrome.storage.local's ~10MB
// default quota. Best-effort: any failure (old browser missing
// CompressionStream, corrupted data) falls back to plain text / a cache
// miss, never breaks the fallback path itself.
var _B64_CHUNK=0x8000;
function _u8ToBase64(bytes){
  var binary='';
  for(var i=0;i<bytes.length;i+=_B64_CHUNK){
    binary+=String.fromCharCode.apply(null,bytes.subarray(i,i+_B64_CHUNK));
  }
  return btoa(binary);
}
function _base64ToU8(b64){
  var binary=atob(b64);
  var bytes=new Uint8Array(binary.length);
  for(var i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  return bytes;
}
function _compressForStorage(text){
  try{
    if(typeof CompressionStream==='undefined')throw new Error('unavailable');
    var cs=new CompressionStream('deflate-raw');
    var writer=cs.writable.getWriter();
    writer.write(new TextEncoder().encode(text));
    writer.close();
    return new Response(cs.readable).arrayBuffer().then(function(buf){
      return {format:'deflate-raw-b64',data:_u8ToBase64(new Uint8Array(buf))};
    });
  }catch(e){
    return Promise.resolve({format:'raw',data:text});
  }
}
function _decompressFromStorage(stored){
  if(!stored)return Promise.resolve('');
  if(typeof stored==='string')return Promise.resolve(stored); // pre-existing plain-text value
  if(stored.format==='raw')return Promise.resolve(stored.data||'');
  if(stored.format==='deflate-raw-b64'){
    try{
      var bytes=_base64ToU8(stored.data);
      var ds=new DecompressionStream('deflate-raw');
      var writer=ds.writable.getWriter();
      writer.write(bytes);
      writer.close();
      return new Response(ds.readable).arrayBuffer().then(function(buf){
        return new TextDecoder().decode(buf);
      }).catch(function(){return '';});
    }catch(e){return Promise.resolve('');}
  }
  return Promise.resolve('');
}

function getCachedRules(){
  return new Promise(function(resolve){
    if(!extValid()||!EXT.storage||!EXT.storage.local){resolve(null);return;}
    try{
      EXT.storage.local.get([CACHE_KEY_TEXT,CACHE_KEY_TIME],function(res){
        if(EXT.runtime.lastError||!res||!res[CACHE_KEY_TEXT]){resolve(null);return;}
        _decompressFromStorage(res[CACHE_KEY_TEXT]).then(function(text){
          if(!text){resolve(null);return;}
          resolve({
            text: text,
            time: Number(res[CACHE_KEY_TIME]||0)
          });
        });
      });
    }catch(e){resolve(null);}
  });
}

function setCachedRules(text){
  return new Promise(function(resolve){
    if(!extValid()||!EXT.storage||!EXT.storage.local||!text){resolve();return;}
    try{
      _compressForStorage(text).then(function(stored){
        var payload={};
        payload[CACHE_KEY_TEXT]=stored;
        payload[CACHE_KEY_TIME]=Date.now();
        EXT.storage.local.set(payload,function(){resolve();});
      });
    }catch(e){resolve();}
  });
}

function isFreshCache(entry){
  return !!(entry&&entry.text&&entry.time&&(Date.now()-entry.time)<CACHE_TTL_MS);
}

// Mirrors background.js's _isDefaultSourceEnabled() — a per-URL override in
// defaultRuleSourceOverrides wins if present, otherwise the legacy single
// "all defaults" flag (defaultRuleSourceEnabled===false, pre-multi-source
// installs) wins if it was ever set, otherwise the entry's own ship-time
// `enable` field from config.js.
// Mirrors background.js's _entryUrls()/_primaryUrl() (2026-08-25) — an
// entry's `url` can be a single string or an ARRAY of urls, ALL of which
// get fetched and merged in (not a mirror/fallback list). _primaryUrl (the
// first url) is the stable key used for the group's enable/disable toggle.
function _entryUrls(entry){
  if(!entry.url)return [];
  return Array.isArray(entry.url)?entry.url:[entry.url];
}
function _primaryUrl(entry){
  return _entryUrls(entry)[0];
}
function _isDefaultSourceEnabled(entry,overrides,legacyAllDisabled){
  var key=_primaryUrl(entry);
  if(overrides&&Object.prototype.hasOwnProperty.call(overrides,key))return overrides[key]!==false;
  if(legacyAllDisabled)return false;
  return entry.enable!==false;
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
  return fetch(EXT.runtime.getURL(LOCAL_RULES_PATH),{cache:'no-store'})
    .then(function(res){return res.ok?res.text():'';});
}

// _fetchAndMergeDirect — fallback when background messaging is unavailable.
// Reads ruleSources from storage, fetches URL sources, merges with file sources.
// Mirrors background.js's fetchRemoteRuleText() (same defaultRuleSourceEnabled
// check, own code/copy here since this path can't call into that function
// directly) — this used to unconditionally include the default remote
// regardless of that toggle, a real gap since sendMessage to a cold-starting
// service worker on a fresh navigation hits this fallback often enough in
// practice to matter, not just when messaging is truly broken.
function _fetchAndMergeDirect(cached, resolve){
  if(!extValid()||!EXT.storage||!EXT.storage.local){resolve(null);return;}
  EXT.storage.local.get(['ruleSources','customRulesUrl','customRulesText','defaultRuleSourceEnabled','defaultRuleSourceOverrides'],function(res){
    var sources=res.ruleSources;
    var defaultUrlSet={};
    var urls=[];
    var legacyAllDisabled=res.defaultRuleSourceEnabled===false;
    // DEBUG_LOCAL swaps ONLY the very first entry's URL (this repo's own
    // GitHub-hosted site-rules.txt, by convention always first) for the
    // bundled local copy, so local edits take effect on reload without
    // pushing to GitHub. Every other source flows through this exact same
    // fetch/merge pipeline in both debug and production.
    DEFAULT_RULE_SOURCES.forEach(function(entry,i){
      var entryUrls=_entryUrls(entry);
      entryUrls.forEach(function(u){defaultUrlSet[u]=true;});
      if(!_isDefaultSourceEnabled(entry,res.defaultRuleSourceOverrides,legacyAllDisabled))return;
      // format:'hosts' entries (URLhaus, Phishing Army) are plain domain-per-
      // line malware blocklists, not ABP/site-rules syntax — background.js's
      // fetchRemoteRuleText() routes them into remoteMalwareDomains/
      // remoteMalwarePathPatterns instead of this merged site-config text
      // (see config.js's own comment), and malware blocking itself is pure
      // declarativeNetRequest (no content-script involvement at all), so
      // fetching them here would just waste a request for text this path
      // can never do anything useful with.
      if(entry.format==='hosts')return;
      if(DEBUG_LOCAL&&i===0){
        urls.push(EXT.runtime.getURL(LOCAL_RULES_PATH));
      }else{
        entryUrls.forEach(function(u){urls.push(u);});
      }
    });
    var fileParts=[];
    if(sources&&sources.length){
      sources.forEach(function(s){
        if(s.enabled===false)return;
        if(s.type==='url'&&s.url&&!defaultUrlSet[s.url])urls.push(s.url);
        else if(s.type==='file'&&s.text)fileParts.push(s.text);
      });
    }else if(res.customRulesUrl&&!defaultUrlSet[res.customRulesUrl]){
      urls.push(res.customRulesUrl);
    }
    // Append user's custom rules text
    if(res.customRulesText)fileParts.push(res.customRulesText);
    (urls.length?fetchRemoteRules(urls):Promise.resolve(''))
      .then(function(urlText){
        var merged=[urlText].concat(fileParts).filter(Boolean).join('\n');
        if(!merged){
          // Empty because a real fetch was attempted and came back empty
          // (network down, bad URL) IS a failure — fall back to cached/
          // local so [host_patterns]/[global] don't silently disappear.
          // Empty because every source was deliberately disabled (no urls
          // even attempted) is NOT a failure — same distinction as
          // background.js's fetchRemoteRuleText(), so a fully-disabled
          // Rule Source config reliably means zero rules here too, instead
          // of quietly reverting to the bundled defaults.
          if(urls.length){
            if(cached&&cached.text)return cached.text;
            return fetchLocalRules();
          }
          return '';
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
//
// Compiled matcher cached per raw pattern string (mirrors background.js's own
// fix) — this used to call `new RegExp(...)` fresh on every call, for every
// pattern; with a large ABP-converted source enabled (e.g. EasyList's ~24k
// cosmetic rules, each potentially its own [host_patterns] entry) that meant
// recompiling tens of thousands of regexes on every single hostname
// resolution. Never invalidated — a pattern string's compiled matcher is a
// pure function of the string, so stale entries are just unused Map keys.
var _hostPatternMatchCache=new Map();
function _compileHostPattern(pat){
  if(pat.charAt(0)==='/'){
    var last=pat.lastIndexOf('/');
    if(last>0){
      try{
        var wholeRe=new RegExp(pat.slice(1,last),pat.slice(last+1));
        return function(host){return wholeRe.test(host);};
      }catch(e){}
    }
    return null;
  }
  var subRegexes=[];
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
      subRegexes.push(re);
    }catch(e){}
  }
  if(!subRegexes.length)return null;
  return function(host){
    for(var j=0;j<subRegexes.length;j++){if(subRegexes[j].test(host))return true;}
    return false;
  };
}
function _hostPatternMatches(pat,host){
  pat=pat.trim();
  var matcher=_hostPatternMatchCache.get(pat);
  if(matcher===undefined){
    matcher=_compileHostPattern(pat);
    _hostPatternMatchCache.set(pat,matcher);
  }
  return matcher?matcher(host):false;
}

// Mirrors background.js's resolveSiteKey() indexed rewrite — a linear scan
// through every [host_patterns] entry on every hostname resolution turns
// into thousands of tests once a large ABP-converted source (e.g.
// EasyList) is enabled, run in THIS content script's own page-thread
// fallback path, which is exactly where a live "page unresponsive" symptom
// was reported (2026-08-23). Same index: plain single-domain patterns (the
// vast majority) go into an exact-match Map, checked via a short walk up
// the host's own domain-suffix chain instead of testing every pattern.
// Wildcard-TLD/regex forms stay in a small fallback list. Cached per
// `patterns` OBJECT (WeakMap) — a fresh parse naturally invalidates it.
var _hostPatternIndexCache=new WeakMap();
function _buildHostPatternIndex(patterns){
  var exactMap=new Map();
  var complex=[];
  var order=0;
  for(var pat in patterns){
    if(!Object.prototype.hasOwnProperty.call(patterns,pat))continue;
    var key=(patterns[pat]&&patterns[pat][0])||'';
    if(!key)continue;
    var idx=order++;
    // Raw regex form (/body/flags) is the WHOLE LHS and must never be split
    // on '|' — its body can contain a literal '|' as regex alternation
    // (e.g. "(^|\.)"), not a domain separator. Mirrors the fix in
    // background.js's own _buildHostPatternIndex (2026-08-23).
    if(pat.charAt(0)==='/'&&pat.length>1&&pat.lastIndexOf('/')>0){
      complex.push({pat:pat,key:key,order:idx});
      continue;
    }
    var subs=pat.split('|').map(function(s){return s.trim();}).filter(Boolean);
    // A '|'-joined LHS with MANY domains is a generic ABP "bucket" pattern
    // (real lists like EasyList hide a common selector across a couple
    // hundred loosely related sites on one line); a single-domain LHS is a
    // dedicated, curated entry for exactly that site. A dedicated entry
    // must always outrank a bucket entry for the same domain, regardless
    // of source order — mirrors the fix in background.js's own
    // _buildHostPatternIndex (2026-08-23).
    var isBucket=subs.length>1;
    for(var i=0;i<subs.length;i++){
      var tok=subs[i];
      if(tok.slice(-2)==='.*'){
        complex.push({pat:tok,key:key,order:idx});
      }else{
        var d=tok.toLowerCase();
        var candidate={key:key,order:idx,specific:!isBucket};
        var existing=exactMap.get(d);
        if(!existing
          ||(candidate.specific&&!existing.specific)
          ||(candidate.specific===existing.specific&&candidate.order<existing.order)){
          exactMap.set(d,candidate);
        }
      }
    }
  }
  return {exactMap:exactMap,complex:complex};
}
function _resolveFromPatterns(patterns,host){
  var index=_hostPatternIndexCache.get(patterns);
  if(!index){
    index=_buildHostPatternIndex(patterns);
    _hostPatternIndexCache.set(patterns,index);
  }
  var best=null;
  var h=host;
  while(h){
    var hit=index.exactMap.get(h);
    if(hit&&(!best||hit.order<best.order))best=hit;
    var dot=h.indexOf('.');
    if(dot===-1)break;
    h=h.slice(dot+1);
  }
  for(var i=0;i<index.complex.length;i++){
    var c=index.complex[i];
    if(best&&c.order>=best.order)continue;
    if(_hostPatternMatches(c.pat,host)){
      if(!best||c.order<best.order)best={key:c.key,order:c.order};
    }
  }
  return best?best.key:'';
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
    // DEBUG_LOCAL never serves the cache — _fetchAndMergeDirect() itself
    // already swaps the bundled default entry for the local file when
    // DEBUG_LOCAL is set, so a plain cache-skip here is all that's needed
    // for local site-rules.txt edits to take effect on every reload.
    if(!DEBUG_LOCAL&&isFreshCache(cached)){resolve(_fromParsedText(cached.text));return;}
    _fetchAndMergeDirect(cached,function(text){resolve(_fromParsedText(text||''));});
  });
}

function loadSiteConfig(callback){
  if(_site){callback(_site);return;}
  if(!_loading){
    _loading=new Promise(function(resolve){
      // Primary path (GET_SITE_CONFIG message) works unchanged in
      // DEBUG_LOCAL too — background.js's getRulesText() already handles
      // the local-vs-remote swap internally, so nothing needs to know about
      // DEBUG_LOCAL here except the fallback below (used only when
      // messaging itself is unavailable).
      if(!extValid()){_loadFallback(resolve);return;}
      try{
        EXT.runtime.sendMessage({type:'GET_SITE_CONFIG',host:location.hostname},function(res){
          if(EXT.runtime.lastError||!res){_loadFallback(resolve);return;}
          resolve({siteKey:res.siteKey||'',global:res.global||{},site:res.site||{}});
        });
      }catch(e){_loadFallback(resolve);}
    }).then(function(site){_site=site;return site;});
  }
  _loading.then(callback);
}

window.__qkv1Loader={
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
if(typeof chrome!=='undefined'&&EXT.runtime&&EXT.runtime.onMessage){
  try{
    EXT.runtime.onMessage.addListener(function(msg){
      if(msg&&msg.type==='RULES_CHANGED'){
        _parsed=null;
        _loading=null;
      }
    });
  }catch(e){}
}
})();