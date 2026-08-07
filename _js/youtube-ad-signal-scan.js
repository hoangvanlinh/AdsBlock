/*!
 * YouTube Ad-Signal Scanner
 * ------------------------------------------------------------------
 * Paste this whole file into DevTools Console on any youtube.com page
 * (home feed, search, or a watch page — with or without an ad playing)
 * to pull together every ad-detection signal we know about, from as
 * many independent sources as possible, in one snapshot:
 *
 *   - window.ytInitialPlayerResponse  (adPlacements / adSlots / playerAds /
 *     adBreakServiceRenderer / adBreakHeartbeatParams ...)
 *   - window.ytInitialData            (deep-scanned for any *Ad* renderer key:
 *     displayAdRenderer, promotedSparklesWebRenderer, inFeedAdLayoutRenderer,
 *     adSlotRenderer, companionSlotRenderer, statementBannerRenderer, ...)
 *   - window.ytcfg / window.yt.config_ (experiment flags, INNERTUBE context)
 *   - the live #movie_player element   (classList ad-showing/ad-interrupting,
 *     getAdState()/getPlayerResponse() if exposed, .ytp-ad-* DOM children)
 *   - a curated list of ad-renderer custom elements / CSS hooks in the DOM
 *   - Performance/Resource Timing entries hitting known ad domains
 *   - localStorage / sessionStorage / cookies with an "ad" word in the key
 *
 * Usage:
 *   YTADS.scan()      // one-shot snapshot: prints tables, returns the summary
 *   YTADS.watch()     // hook fetch()/XHR, log ad-bearing requests as they fire
 *   YTADS.unwatch()   // remove the live hook
 *   YTADS.pickFolder() // one-time native folder picker — every scan()/watch()
 *                       // hit after this gets written to a file in that folder
 *   YTADS.download()   // fallback: save everything captured so far as one file
 *
 * Read-only / non-destructive: it only inspects state and (optionally) logs
 * network traffic, it never patches or blocks anything. A browser tab can't
 * silently write to an arbitrary path on disk — YTADS.pickFolder() opens the
 * native "choose a folder" dialog once (Chrome/Edge only, File System Access
 * API); after you grant it, the handle is remembered (IndexedDB) so you don't
 * need to pick again on the next paste/reload.
 */
(function (global) {
  'use strict';

  if (global.YTADS && global.YTADS.__installed) {
    console.log('[YTADS] already loaded — call YTADS.unwatch() first if you want to reload.');
    return;
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  // camelCase/snake_case-aware "does this key contain a standalone ad/ads
  // word" check — matches adPlacements, playerAds, displayAdRenderer,
  // ad_break_heartbeat_params, but not gradient/already/download/grid/trending.
  function keyHasAdWord(key) {
    var words = String(key).split(/(?=[A-Z])|_/);
    for (var i = 0; i < words.length; i++) {
      if (/^ads?$/i.test(words[i])) return true;
    }
    return false;
  }

  function safePreview(val) {
    try {
      if (val === null || val === undefined) return String(val);
      if (typeof val === 'string') return val.length > 80 ? val.slice(0, 80) + '…' : val;
      if (typeof val !== 'object') return String(val);
      if (Array.isArray(val)) return 'Array(' + val.length + ')';
      var keys = Object.keys(val);
      return '{' + keys.slice(0, 5).join(', ') + (keys.length > 5 ? ', …' : '') + '}';
    } catch (e) { return '<unreadable>'; }
  }

  // Depth/node-budgeted walk over a (possibly huge) YT JSON blob, collecting
  // every path whose final key contains a standalone ad/ads word.
  function deepFindAdKeys(root, rootName, maxNodes, maxDepth) {
    maxNodes = maxNodes || 25000;
    maxDepth = maxDepth || 14;
    var found = [];
    var seen = new Set();
    var visited = 0;
    var stack = [{ node: root, path: rootName, depth: 0 }];

    while (stack.length && visited < maxNodes) {
      var frame = stack.pop();
      var node = frame.node;
      visited++;
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (frame.depth > maxDepth) continue;

      var keys = Object.keys(node);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var v = node[k];
        var path = frame.path + '.' + k;
        if (keyHasAdWord(k)) {
          found.push({ path: path, key: k, preview: safePreview(v) });
        }
        if (v && typeof v === 'object') {
          stack.push({ node: v, path: Array.isArray(node) ? frame.path + '[' + k + ']' : path, depth: frame.depth + 1 });
        }
      }
    }
    return { found: found, visited: visited, truncated: visited >= maxNodes };
  }

  // ------------------------------------------------------------------
  // 1. Global JS state
  // ------------------------------------------------------------------
  function scanGlobals() {
    var out = { ytInitialPlayerResponse: null, ytInitialData: null, ytcfg: null, playerResponseSources: [] };

    // ytInitialPlayerResponse can also live under ytplayer.config.args.raw_player_response
    // on some surfaces, and gets re-fetched via /youtubei/v1/player on SPA nav —
    // window.ytInitialPlayerResponse only reflects the FIRST page load.
    var pr = global.ytInitialPlayerResponse;
    if (pr) out.playerResponseSources.push('window.ytInitialPlayerResponse');
    var player = document.getElementById('movie_player');
    if (player && typeof player.getPlayerResponse === 'function') {
      try {
        var live = player.getPlayerResponse();
        if (live) { pr = live; out.playerResponseSources.push('#movie_player.getPlayerResponse()'); }
      } catch (e) {}
    }

    if (pr) {
      var prScan = deepFindAdKeys(pr, 'playerResponse');
      out.ytInitialPlayerResponse = {
        hasPlayerAds: !!pr.playerAds,
        hasAdPlacements: !!pr.adPlacements,
        hasAdSlots: !!pr.adSlots,
        adBreakHeartbeatParams: pr.adBreakHeartbeatParams || null,
        isLiveContent: !!(pr.videoDetails && pr.videoDetails.isLiveContent),
        adKeysFound: prScan.found,
        nodesVisited: prScan.visited,
        truncated: prScan.truncated
      };
    }

    if (global.ytInitialData) {
      var idScan = deepFindAdKeys(global.ytInitialData, 'ytInitialData');
      out.ytInitialData = {
        adKeysFound: idScan.found,
        nodesVisited: idScan.visited,
        truncated: idScan.truncated
      };
    }

    var cfg = (global.ytcfg && typeof global.ytcfg.get === 'function') ? global.ytcfg.data_ : (global.yt && global.yt.config_);
    if (cfg) {
      var cfgAdKeys = Object.keys(cfg).filter(keyHasAdWord);
      var flags = cfg.EXPERIMENT_FLAGS || (cfg.WEB_PLAYER_CONTEXT_CONFIGS && null);
      var flagAdKeys = flags ? Object.keys(flags).filter(keyHasAdWord) : [];
      out.ytcfg = {
        source: global.ytcfg ? 'window.ytcfg.data_' : 'window.yt.config_',
        topLevelAdKeys: cfgAdKeys,
        experimentFlagAdKeys: flagAdKeys.slice(0, 50),
        experimentFlagAdKeyCount: flagAdKeys.length
      };
    }

    return out;
  }

  // ------------------------------------------------------------------
  // 2. Live player element
  // ------------------------------------------------------------------
  function scanPlayerElement() {
    var player = document.getElementById('movie_player');
    if (!player) return null;

    var apiProbe = ['getAdState', 'getAdPlaybackTracking', 'getPlayerResponse', 'isAtLiveHead', 'getVideoData'];
    var api = {};
    apiProbe.forEach(function (fn) {
      if (typeof player[fn] === 'function') {
        try { api[fn] = player[fn](); } catch (e) { api[fn] = '<threw: ' + e.message + '>'; }
      }
    });

    var classList = Array.prototype.slice.call(player.classList);
    var adClasses = classList.filter(function (c) { return /\bad\b|ad-showing|ad-interrupting|ad-created/i.test(c); });

    var adChildSelectors = [
      '.ytp-ad-module', '.ytp-ad-player-overlay', '.ytp-ad-player-overlay-instream-info',
      '.ytp-ad-overlay-container', '.ytp-ad-skip-button', '.ytp-ad-skip-button-modern',
      '.ytp-ad-preview-container', '.ytp-ad-text', '.video-ads', '#player-ads'
    ];
    var domChildren = {};
    adChildSelectors.forEach(function (sel) {
      var els = player.querySelectorAll(sel);
      if (els.length) domChildren[sel] = els.length;
    });

    return { adClassesOnPlayer: adClasses, exposedApi: api, adDomChildren: domChildren };
  }

  // ------------------------------------------------------------------
  // 3. Curated DOM selectors (feed / watch-page ad surfaces)
  // ------------------------------------------------------------------
  var DOM_AD_SELECTORS = [
    'ytd-display-ad-renderer', 'ytd-promoted-sparkles-web-renderer',
    'ytd-promoted-sparkles-text-search-renderer', 'ytd-promoted-video-renderer',
    'ytd-in-feed-ad-layout-renderer', 'ytd-ad-slot-renderer',
    'ytd-companion-slot-renderer', 'ytd-action-companion-ad-renderer',
    'ytd-statement-banner-renderer', 'ytd-banner-promo-renderer',
    'ytd-primetime-promo-renderer', 'ytd-mealbar-promo-renderer',
    'ytd-rich-item-renderer[is-ad]', 'ytd-carousel-ad-renderer',
    'ytd-brand-video-shelf-renderer', 'ytd-brand-video-singleton-renderer',
    'masthead-ad', 'ytd-enforcement-message-view-model',
    '#masthead-ad', '[is-ad]', '.ytd-display-ad-renderer'
  ];
  function scanDom() {
    var hits = {};
    DOM_AD_SELECTORS.forEach(function (sel) {
      try {
        var n = document.querySelectorAll(sel).length;
        if (n) hits[sel] = n;
      } catch (e) {}
    });
    return hits;
  }

  // ------------------------------------------------------------------
  // 4. Performance / Resource Timing
  // ------------------------------------------------------------------
  var AD_DOMAIN_RE = /doubleclick\.net|googlesyndication\.com|googleadservices\.com|google\.com\/pagead|googleads\.g\.doubleclick|\/pagead\/|\/ptracking|\/api\/stats\/ads|get_midroll|youtubei\/v1\/player\/ad_break|\/generate_204.*ad/i;
  function scanPerformance() {
    if (typeof performance === 'undefined' || !performance.getEntriesByType) return [];
    var entries = performance.getEntriesByType('resource');
    return entries
      .filter(function (e) { return AD_DOMAIN_RE.test(e.name); })
      .slice(-100)
      .map(function (e) { return { url: e.name, initiator: e.initiatorType, durationMs: Math.round(e.duration) }; });
  }

  // ------------------------------------------------------------------
  // 5. Storage
  // ------------------------------------------------------------------
  function scanStorage() {
    function grab(storage) {
      var out = [];
      try {
        for (var i = 0; i < storage.length; i++) {
          var k = storage.key(i);
          if (keyHasAdWord(k)) out.push(k);
        }
      } catch (e) {}
      return out;
    }
    var cookieAdKeys = document.cookie.split(';')
      .map(function (c) { return c.split('=')[0].trim(); })
      .filter(keyHasAdWord);
    return {
      localStorage: grab(global.localStorage || { length: 0 }),
      sessionStorage: grab(global.sessionStorage || { length: 0 }),
      cookies: cookieAdKeys
    };
  }

  // ------------------------------------------------------------------
  // File writer — persists every scan()/watch() hit to disk once a folder
  // has been granted via pickFolder(). Falls back to a manual Blob download
  // (download()) when the File System Access API isn't available/granted.
  // ------------------------------------------------------------------
  var dirHandle = null;
  var allEntries = []; // every scan summary + watch hit captured this session, for download()

  function idbOpen() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('ytads', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbSet(key, val) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(val, key);
        tx.oncomplete = resolve;
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  function idbGet(key) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('kv', 'readonly');
        var req = tx.objectStore('kv').get(key);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function pickFolder() {
    if (!global.showDirectoryPicker) {
      console.log('%c[YTADS] File System Access API not available in this browser — use YTADS.download() instead.', 'color:#e33');
      return Promise.resolve(null);
    }
    return global.showDirectoryPicker({ mode: 'readwrite' }).then(function (handle) {
      dirHandle = handle;
      return idbSet('dirHandle', handle).then(function () {
        console.log('[YTADS] folder granted: "' + handle.name + '" — scan()/watch() output will now be written there.');
        return handle;
      });
    }).catch(function (e) {
      console.log('[YTADS] pickFolder cancelled/failed:', e.message);
      return null;
    });
  }

  // Best-effort silent restore of a previously granted folder (no picker
  // dialog — queryPermission doesn't need a user gesture, requestPermission does).
  function restoreFolder() {
    if (!global.showDirectoryPicker) return;
    idbGet('dirHandle').then(function (handle) {
      if (!handle) return;
      return handle.queryPermission({ mode: 'readwrite' }).then(function (perm) {
        if (perm === 'granted') {
          dirHandle = handle;
          console.log('[YTADS] restored previously granted folder: "' + handle.name + '"');
        } else {
          console.log('[YTADS] a folder was picked before but permission needs re-granting — run YTADS.pickFolder().');
        }
      });
    }).catch(function () {});
  }

  function writeFile(name, content) {
    if (!dirHandle) return Promise.resolve(false);
    return dirHandle.getFileHandle(name, { create: true }).then(function (fileHandle) {
      return fileHandle.createWritable();
    }).then(function (writable) {
      return writable.write(content).then(function () { return writable.close(); });
    }).then(function () { return true; }).catch(function (e) {
      console.log('[YTADS] write failed for "' + name + '":', e.message);
      return false;
    });
  }

  function safeName(s) {
    return String(s).replace(/[^a-z0-9._-]/gi, '_');
  }

  function persistSnapshot(summary) {
    allEntries.push({ kind: 'scan', at: summary.timestamp, data: summary });
    if (!dirHandle) return;
    var name = 'ytads-scan-' + safeName(summary.timestamp) + '.json';
    writeFile(name, JSON.stringify(summary, null, 2));
  }

  // Live watch() hits are appended to one running file, debounced so a burst
  // of requests doesn't trigger a write per request.
  var watchLogLines = [];
  var watchFlushTimer = null;
  function persistWatchHit(entry) {
    allEntries.push({ kind: 'watch', at: entry.at, data: entry });
    watchLogLines.push(JSON.stringify(entry));
    if (!dirHandle) return;
    if (watchFlushTimer) return;
    watchFlushTimer = setTimeout(function () {
      watchFlushTimer = null;
      writeFile('ytads-watch.log', watchLogLines.join('\n') + '\n');
    }, 500);
  }

  function download() {
    var blob = new Blob([JSON.stringify(allEntries, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'ytads-log-' + safeName(new Date().toISOString()) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    console.log('[YTADS] downloaded ' + allEntries.length + ' entries.');
  }

  restoreFolder();

  // ------------------------------------------------------------------
  // scan(): one-shot snapshot
  // ------------------------------------------------------------------
  function scan() {
    var summary = {
      timestamp: new Date().toISOString(),
      url: location.href,
      globals: scanGlobals(),
      player: scanPlayerElement(),
      dom: scanDom(),
      network: scanPerformance(),
      storage: scanStorage()
    };

    console.groupCollapsed('%c[YTADS] YouTube ad-signal scan — ' + summary.url, 'color:#e33;font-weight:bold');

    console.groupCollapsed('globals: ytInitialPlayerResponse');
    if (summary.globals.ytInitialPlayerResponse) {
      console.log('sources:', summary.globals.playerResponseSources.join(', '));
      console.log(summary.globals.ytInitialPlayerResponse);
      if (summary.globals.ytInitialPlayerResponse.adKeysFound.length) console.table(summary.globals.ytInitialPlayerResponse.adKeysFound);
    } else {
      console.log('not found');
    }
    console.groupEnd();

    console.groupCollapsed('globals: ytInitialData (deep-scanned ad-renderer keys)');
    if (summary.globals.ytInitialData) {
      console.log('nodes visited:', summary.globals.ytInitialData.nodesVisited, 'truncated:', summary.globals.ytInitialData.truncated);
      if (summary.globals.ytInitialData.adKeysFound.length) console.table(summary.globals.ytInitialData.adKeysFound);
      else console.log('no ad-renderer keys found on this surface right now');
    } else {
      console.log('not found');
    }
    console.groupEnd();

    console.groupCollapsed('globals: ytcfg / yt.config_');
    console.log(summary.globals.ytcfg || 'not found');
    console.groupEnd();

    console.groupCollapsed('#movie_player');
    console.log(summary.player || 'not found on this page');
    console.groupEnd();

    console.groupCollapsed('DOM ad-renderer selectors');
    console.table(summary.dom);
    console.groupEnd();

    console.groupCollapsed('Performance/Resource Timing — ad-domain requests seen so far');
    console.table(summary.network);
    console.groupEnd();

    console.groupCollapsed('localStorage / sessionStorage / cookies (ad-word keys)');
    console.log(summary.storage);
    console.groupEnd();

    console.log('%cTip: run YTADS.watch() to log ad-bearing fetch()/XHR traffic live, YTADS.unwatch() to stop.', 'color:#888');
    console.groupEnd();

    global.__ytAdScan = summary;
    persistSnapshot(summary);
    if (!dirHandle) console.log('%cTip: run YTADS.pickFolder() once to auto-save every scan()/watch() hit to disk, or YTADS.download() to save what\'s captured so far.', 'color:#888');
    return summary;
  }

  // ------------------------------------------------------------------
  // watch()/unwatch(): live network hook
  // ------------------------------------------------------------------
  var watching = false;
  var origFetch = global.fetch;
  var origXhrOpen = XMLHttpRequest.prototype.open;
  var origXhrSend = XMLHttpRequest.prototype.send;

  // Returns { matched, adKeys } — matched is short human-readable strings
  // (for the console line), adKeys carries every matched key WITH its value
  // preview (path/key/preview from deepFindAdKeys) so the persisted log can
  // actually tell an empty placeholder apart from a real ad payload.
  function inspectBody(url, text) {
    var matched = [];
    var adKeys = [];
    if (AD_DOMAIN_RE.test(url)) matched.push('ad-domain URL');
    if (text) {
      try {
        var obj = JSON.parse(text);
        var scanResult = deepFindAdKeys(obj, 'body', 3000, 8);
        if (scanResult.found.length) {
          adKeys = scanResult.found;
          matched.push(scanResult.found.length + ' ad key(s): ' + scanResult.found.map(function (f) { return f.key; }).join(', '));
        }
      } catch (e) {}
    }
    return { matched: matched, adKeys: adKeys };
  }

  function watch() {
    if (watching) { console.log('[YTADS] already watching.'); return; }
    watching = true;

    global.fetch = function () {
      var args = arguments;
      var url = args[0] && args[0].url ? args[0].url : args[0];
      return origFetch.apply(this, args).then(function (res) {
        res.clone().text().then(function (text) {
          var r = inspectBody(String(url), text);
          if (r.matched.length) {
            console.log('%c[YTADS/fetch]', 'color:#e33', url, r.matched, r.adKeys);
            persistWatchHit({ at: new Date().toISOString(), source: 'fetch', url: String(url), matched: r.matched, adKeys: r.adKeys });
          }
        }).catch(function () {});
        return res;
      }).catch(function (err) {
        // Request never resolved — could be a DNR block, an ad-blocker
        // extension, or just a network error. Only worth logging when the
        // URL itself looked ad-related in the first place.
        if (AD_DOMAIN_RE.test(String(url))) {
          console.log('%c[YTADS/fetch-blocked]', 'color:#e33', url, err.message);
          persistWatchHit({ at: new Date().toISOString(), source: 'fetch-blocked', url: String(url), matched: ['blocked/rejected: ' + err.message], adKeys: [] });
        }
        throw err;
      });
    };

    XMLHttpRequest.prototype.open = function (method, url) {
      this.__ytadsUrl = url;
      return origXhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var self = this;
      this.addEventListener('load', function () {
        var r = inspectBody(String(self.__ytadsUrl || ''), self.responseText);
        if (r.matched.length) {
          console.log('%c[YTADS/xhr]', 'color:#e33', self.__ytadsUrl, r.matched, r.adKeys);
          persistWatchHit({ at: new Date().toISOString(), source: 'xhr', url: String(self.__ytadsUrl || ''), matched: r.matched, adKeys: r.adKeys });
        }
      });
      this.addEventListener('error', function () {
        if (AD_DOMAIN_RE.test(String(self.__ytadsUrl || ''))) {
          console.log('%c[YTADS/xhr-blocked]', 'color:#e33', self.__ytadsUrl);
          persistWatchHit({ at: new Date().toISOString(), source: 'xhr-blocked', url: String(self.__ytadsUrl || ''), matched: ['blocked/network error'], adKeys: [] });
        }
      });
      return origXhrSend.apply(this, arguments);
    };

    console.log('[YTADS] watching fetch()/XHR for ad-bearing requests. Scroll / play a video, then YTADS.unwatch() when done.');
  }

  function unwatch() {
    if (!watching) return;
    global.fetch = origFetch;
    XMLHttpRequest.prototype.open = origXhrOpen;
    XMLHttpRequest.prototype.send = origXhrSend;
    watching = false;
    console.log('[YTADS] stopped watching.');
  }

  global.YTADS = { __installed: true, scan: scan, watch: watch, unwatch: unwatch, pickFolder: pickFolder, download: download };
  console.log('[YTADS] loaded. Run YTADS.scan() for a one-shot snapshot, YTADS.watch() to log live ad traffic, YTADS.pickFolder() to auto-save to disk.');
})(window);
