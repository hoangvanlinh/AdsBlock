// content/fastpath-storage.js — resolves ONCE per content-script load
// whether chrome.storage.session (or Firefox's native browser.storage.session)
// is actually reachable from THIS content script. Falls back to
// chrome.storage.local automatically when it isn't (setAccessLevel not
// granted, or genuinely unsupported/unavailable in this browser/build — see
// background.js's own setAccessLevel comment for a live-reproduced case
// where it was missing outright) so the fast-path caches in site-block.js
// keep working either way — just trading away chrome.storage.session's
// "wiped on browser close" hygiene for chrome.storage.local's. Still never
// the page's own localStorage, so no fingerprint exposure either way.
//
// Exposes window.__qkv1FastpathStorage — read by site-block.js the same way
// site-block.js's own window.__qkv1UnhideAll is later read by content.js
// (isolated-world content scripts in the SAME content_scripts entry share
// one `window`, per the fixed manifest.json/manifest.firefox.json load
// order: this file is listed before site-block.js so the property is
// already set by the time it runs).
(function(){
if(window.__qkv1FastpathStorage)return; // idempotent if ever listed twice

// Resolution logic (browser.storage.session preferred over the chrome.*
// compat shim) now lives in browser-compat.js as self.EXT_SESSION_STORAGE —
// but browser.* is Promise-ONLY (no callback support), so both get()/set()
// below always return the underlying Promise and never accept/pass a
// callback. Mixing styles on the same object reference is what silently
// broke an earlier version of this fast-path once callers started
// preferring browser.* while still calling with a callback arg.
var _sessionArea=self.EXT_SESSION_STORAGE;
var _usingSession=!!_sessionArea;
var _localArea=EXT.storage&&EXT.storage.local;
var _area=_usingSession?_sessionArea:_localArea;

// _usingSession above only means the storage.session API object exists —
// not that this content script actually has access (a separate runtime
// grant, background.js's setAccessLevel, that can silently fail). A denied
// get()/set() call REJECTS the promise rather than throwing, so retry
// against .local per-call here instead of assuming the area chosen at load
// time still works.
//
// _sessionKnownBroken (2026-09-15) — live-reported ("nháy nháy" persisting
// despite this fast path existing): on Firefox, session access is denied to
// EVERY content script, EVERY time (a platform gap, not an occasional
// failure — see background.js's own setAccessLevel comment) — so without
// this flag, EVERY get()/set() call this page load repeats the exact same
// doomed session attempt before falling back to .local, paying 2 sequential
// round trips forever instead of 1. A single page load calls this several
// times (site-block.js's scriptlet fast-dispatch read, then its cache-update
// read+write; same for the direct-CSS cache-update) — one of those sits
// directly on the "early protection" dispatch path, one hop from paint.
// Latching after the FIRST real failure means only that one call pays the
// double cost; everything after goes straight to .local. Same pattern
// already used (and working) in shared/session-storage.js's own
// _sessionKnownUnavailable, that file's background-context sibling to this
// one — this just gives the content-script side the same treatment.
var _sessionKnownBroken=false;
function _withLocalFallback(promise){
  if(!_usingSession||!_localArea||_sessionKnownBroken)return promise;
  return promise.catch(function(){_sessionKnownBroken=true;return null;});
}

window.__qkv1FastpathStorage={
  // Content scripts can inspect this if they ever need to branch on it
  // (e.g. logging/diagnostics) — none currently do, callers just use
  // get()/set() and let the fallback be transparent.
  usingSession:_usingSession,
  // Smaller LRU cap when falling back to .local: that quota is already
  // measured tight elsewhere in this codebase (siteRulesCacheText alone can
  // use ~76-87% of the 10MB default) — unlike .session, which mainly only
  // competes with background.js's own parsedRulesSessionCache for headroom.
  lruLimit:_usingSession?50:10,
  get:function(keys){
    // Session already proven broken this page load — skip straight to
    // .local, don't repeat the doomed attempt (see _sessionKnownBroken's
    // own comment above).
    if(_sessionKnownBroken)return _localArea?_localArea.get(keys).catch(function(){return {};}):Promise.resolve({});
    if(!_area)return Promise.resolve({});
    var p;
    try{p=_area.get(keys);}catch(e){p=Promise.reject(e);}
    return _withLocalFallback(p).then(function(res){
      if(res!==null)return res;
      // Session get() rejected (denied grant) — retry once against .local.
      try{return _localArea.get(keys);}catch(e2){return {};}
    }).catch(function(){return {};});
  },
  set:function(payload){
    if(_sessionKnownBroken)return _localArea?_localArea.set(payload).catch(function(){}):Promise.resolve();
    if(!_area)return Promise.resolve();
    var p;
    try{p=_area.set(payload);}catch(e){p=Promise.reject(e);}
    return _withLocalFallback(p).then(function(res){
      if(res!==null)return res;
      // Session set() rejected (denied grant) — retry once against .local.
      try{return _localArea.set(payload);}catch(e2){}
    }).catch(function(){});
  }
};
})();
