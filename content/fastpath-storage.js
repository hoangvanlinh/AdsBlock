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
// content.js's window.__qkv1HideAttr already is (isolated-world content
// scripts in the SAME content_scripts entry share one `window`, per the
// fixed manifest.json/manifest.firefox.json load order: this file is listed
// before site-block.js so the property is already set by the time it runs).
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
    if(!_area)return Promise.resolve({});
    try{return _area.get(keys);}catch(e){return Promise.resolve({});}
  },
  set:function(payload){
    if(!_area)return Promise.resolve();
    try{return _area.set(payload);}catch(e){return Promise.resolve();}
  }
};
})();
