// content/content.js — AdBlock Cosmetic Filter Engine
// Runs at document_start on every page
// Responsibilities:

// ── FAST PATH: synchronous CSS inject (frame 0, before any async) ──────
// Inject adblock-on + critical inline style immediately, before storage
// callback fires (~10-50ms). If domain is paused, the class is removed
// in the async check below. "Inject first, remove if needed" is faster
// than "wait then inject" for the 99% case where adblock is active.
(function earlyInject() {
  document.documentElement.classList.add('adblock-on');
  if (document.getElementById('__adblock_base__')) return;
  const s = document.createElement('style');
  s.id = '__adblock_base__';
  s.textContent =
    'html.adblock-on ins.adsbygoogle,' +
    'html.adblock-on .adsbygoogle,' +
    'html.adblock-on [id^="div-gpt-ad"],' +
    'html.adblock-on [id^="google_ads_iframe"],' +
    'html.adblock-on iframe[src*="doubleclick.net"],' +
    'html.adblock-on iframe[src*="googlesyndication"],' +
    'html.adblock-on iframe[src*="googleadservices"],' +
    'html.adblock-on [data-google-query-id],' +
    'html.adblock-on [id^="adnzone_"],' +
    'html.adblock-on [data-admssprqid],' +
    'html.adblock-on [id^="taboola-"],' +
    'html.adblock-on .OUTBRAIN' +
    '{display:none!important;visibility:hidden!important;height:0!important;overflow:hidden!important}';
  document.documentElement.appendChild(s);
})();

// ── Inject anti-detect.js into MAIN world on all pages ─────────────
// Fakes XHR / fetch / sendBeacon for known ad network hosts so their
// SDKs receive synthetic 200 OK instead of status=0 (network error),
// preventing "ad blocker detected" code paths from triggering.
// Only inject on real HTML pages — skip text/plain, JSON, XML, etc.
if (!window[Symbol.for('_adblock_antidetect')] && document.contentType === 'text/html') {
  const _ad = document.createElement('script');
  _ad.src = chrome.runtime.getURL('content/anti-detect.js');
  _ad.async = false;
  (document.documentElement || document.head || document.body).appendChild(_ad);
  _ad.remove();
  // Send initial protection state to anti-detect.js after it loads.
  // Default is _enabled=false in anti-detect.js; dispatches _ytpb_on/off
  // (same event as yt-adblock.js) to toggle state in all MAIN world scripts.
  chrome.storage.local.get(['enabled', 'pausedDomains'], (r) => {
    const _host = location.hostname;
    const _active = r.enabled !== false && !(r.pausedDomains || []).includes(_host);
    document.dispatchEvent(new CustomEvent(_active ? '_ytpb_on' : '_ytpb_off'));
  });
}
// Dispatch dynamic host list from site-rules.txt to MAIN world
// anti-detect.js listens for __adblock_ad_hosts__ and rebuilds its regex
// This runs after site-rules-loader.js has set window.__adblockRuleLoader
function _dispatchAdHosts() {
  if (!(window.__adblockRuleLoader && window.__adblockRuleLoader.load)) return;
  window.__adblockRuleLoader.load('global', {}, function (cfg) {
    const hosts = (cfg.ad_script_hosts || [])
      .concat(cfg.ad_network_patterns || [])
      .filter(function (h, i, a) { return h && a.indexOf(h) === i; });
    if (hosts.length) {
      document.dispatchEvent(new CustomEvent('__adblock_ad_hosts__', { detail: hosts }));
    }
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _dispatchAdHosts);
} else {
  _dispatchAdHosts();
}

// ── YouTube: inject yt-adblock.js into MAIN world via DOM ─────────
// chrome.scripting is not needed — a <script src> tag from content world
// executes in MAIN world, same as the page's own scripts.
// Always inject at document_start so ytcfg is intercepted early.
// yt-adblock.js itself checks _ytEnabled before doing any blocking.
if (/youtube\.com/.test(location.hostname) && !window[Symbol.for('_yt_pb')]) {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('content/yt-adblock.js');
  s.async = false;
  (document.documentElement || document.head || document.body).appendChild(s);
  s.remove(); // clean up after load
  // Send initial protection state to yt-adblock.js after script loads.
  // Use a microtask-safe approach: script is sync so it runs before this.
  chrome.storage.local.get(['enabled', 'pausedDomains'], (r) => {
    const host = location.hostname;
    const e = r.enabled !== false;
    const paused = (r.pausedDomains || []).includes(host);
    const active = e && !paused;
    // Write to localStorage so yt-adblock.js can read state synchronously
    // on the NEXT (or current) page load — avoids async race at document_start.
    try { localStorage.setItem('_ytpb_state', active ? '1' : '0'); } catch (_e) {}
    if (!active) {
      document.dispatchEvent(new CustomEvent('_ytpb_off'));
    } else {
      document.dispatchEvent(new CustomEvent('_ytpb_on'));
    }
  });
}

document.addEventListener('_ytpb1', (event) => {
  if (!extValid()) return;
  const detail = event.detail || {};
  chrome.runtime.sendMessage({
    type: 'AD_SKIPPED',
    domain: detail.domain || location.hostname,
    url: detail.url || location.href,
  }).catch(() => {});
});

document.addEventListener('_ytpb2', (event) => {
  if (!extValid()) return;
  const detail = event.detail || {};
  chrome.runtime.sendMessage({
    type: 'AD_BLOCKED',
    domain: detail.domain || location.hostname,
    url: detail.url || location.href,
  }).catch(() => {});
});
//   1. Hide ad elements via CSS selectors (cosmetic filtering)
//   2. Remove ad iframes / scripts on DOM ready
//   3. Observe dynamic DOM mutations (SPA / infinite scroll)
//   4. Listen for messages from background to toggle per-domain

// Shared selectors and classifier patterns primarily live in rule/site-rules.txt.
// Keep a minimal fallback in code so the engine still works if config loading
// is unavailable or delayed.
const FALLBACK_COSMETIC_SELECTORS = [
  'ins.adsbygoogle', '.adsbygoogle',
  '[id^="div-gpt-ad"]',
  '[id^="google_ads_iframe"]',
  '[id^="dfp-ad-"]',
  'iframe[src*="googleadservices"]',
  'iframe[src*="doubleclick.net"]',
  'iframe[src*="googlesyndication"]',
];

const FALLBACK_AD_SCRIPT_HOSTS = [
  'googlesyndication.com', 'doubleclick.net', 'googleadservices.com',
];

let _cosmeticSelectors = FALLBACK_COSMETIC_SELECTORS.slice();
let _adScriptHosts = FALLBACK_AD_SCRIPT_HOSTS.slice();

// ── Cached joined selector string ────────────────────────────────
// querySelectorAll with a joined selector is ~10x faster than N separate calls.
// Rebuilt only when _cosmeticSelectors changes (applyGlobalConfig / init).
let _joinedSelector = _buildJoinedSelector(FALLBACK_COSMETIC_SELECTORS);

function _buildJoinedSelector(selectors) {
  // Validate each selector; skip any that throw so one bad rule can't break all.
  const valid = [];
  for (const s of selectors) {
    try { document.querySelector(s); valid.push(s); } catch { /* invalid — skip */ }
  }
  return valid.join(',');
}

// ── Resource classification for stats ────────────────────────────
// Populated dynamically from background.js rule patterns on init.
// Fallback defaults active until background responds.
let _adPatterns      = ['doubleclick', 'googlesyndication', 'googleadservices'];
let _trackerPatterns = ['google-analytics', 'analytics.google', 'facebook.com/tr'];
let _malwarePatterns = ['coinhive', 'coin-hive', 'jsecoin'];

function applyGlobalConfig(cfg) {
  if (!cfg) return;
  if (Array.isArray(cfg.direct_hide_selectors) && cfg.direct_hide_selectors.length) {
    _cosmeticSelectors = cfg.direct_hide_selectors.slice();
    _joinedSelector = _buildJoinedSelector(_cosmeticSelectors); // rebuild cache
  }
  if (Array.isArray(cfg.ad_script_hosts) && cfg.ad_script_hosts.length) {
    _adScriptHosts = cfg.ad_script_hosts.slice();
  }
  if (Array.isArray(cfg.ad_patterns) && cfg.ad_patterns.length) {
    _adPatterns = cfg.ad_patterns.slice();
  }
  if (Array.isArray(cfg.tracker_patterns) && cfg.tracker_patterns.length) {
    _trackerPatterns = cfg.tracker_patterns.slice();
  }
  if (Array.isArray(cfg.malware_patterns) && cfg.malware_patterns.length) {
    _malwarePatterns = cfg.malware_patterns.slice();
  }
}

const _globalConfigReady = new Promise((resolve) => {
  if (!(window.__adblockRuleLoader && window.__adblockRuleLoader.load)) {
    resolve();
    return;
  }
  window.__adblockRuleLoader.load('global', {
    direct_hide_selectors: FALLBACK_COSMETIC_SELECTORS,
    ad_script_hosts: FALLBACK_AD_SCRIPT_HOSTS,
    ad_patterns: _adPatterns,
    tracker_patterns: _trackerPatterns,
    malware_patterns: _malwarePatterns,
  }, (cfg) => {
    applyGlobalConfig(cfg);
    resolve();
  });
});

function classifyUrl(url) {
  if (!url) return null;
  const u = url.toLowerCase();
  if (_malwarePatterns.some(h => u.includes(h))) return 'malware';
  if (_trackerPatterns.some(h => u.includes(h))) return 'tracker';
  if (_adPatterns.some(h => u.includes(h)))      return 'ad';
  return null;
}

// Fetch real classifier lists from background (derived from actual DNR rules)
function loadClassifierLists() {
  if (!extValid()) return;
  try {
    chrome.runtime.sendMessage({ type: 'GET_CLASSIFIER_LISTS' }, (res) => {
      if (chrome.runtime.lastError || !res) return;
      if (res.adPatterns?.length)      _adPatterns      = res.adPatterns;
      if (res.trackerPatterns?.length) _trackerPatterns = res.trackerPatterns;
      if (res.malwarePatterns?.length) _malwarePatterns = res.malwarePatterns;
    });
  } catch { /* extension context invalidated */ }
}

// Batch counter — flushed every 2 s to avoid flooding the message channel
let _statBatch = { seen: 0, ads: 0, trackers: 0, malware: 0 };
let _flushTimer = null;
let _recordedUrls = new Set(); // dedup: prevent counting the same URL multiple times
const _RECORDED_URLS_MAX = 500; // cap to prevent unbounded memory growth

function recordResource(url) {
  const kind = classifyUrl(url);
  if (!kind) return; // not something we track
  // Deduplicate — same URL should only be counted once per page load
  if (_recordedUrls.has(url)) return;
  // Cap the set to prevent unbounded growth on long sessions
  if (_recordedUrls.size >= _RECORDED_URLS_MAX) _recordedUrls.clear();
  _recordedUrls.add(url);
  _statBatch.seen++;
  if (kind === 'ad')      _statBatch.ads++;
  else if (kind === 'tracker') _statBatch.trackers++;
  else if (kind === 'malware') _statBatch.malware++;

  if (!_flushTimer) {
    _flushTimer = setTimeout(flushStats, 2000);
  }
}

function flushStats() {
  _flushTimer = null;
  if (!extValid()) return;
  const delta = { ..._statBatch };
  _statBatch = { seen: 0, ads: 0, trackers: 0, malware: 0 };
  if (delta.seen === 0) return;
  chrome.runtime.sendMessage({
    type: 'RESOURCE_SEEN',
    domain: location.hostname,
    delta,
  }).catch(() => {});
}

// ── Guard: detect invalidated extension context ───────────────────
function extValid() {
  try {
    // chrome.runtime.id is static; use getManifest() to actually probe the context
    return !!(chrome.runtime && chrome.runtime.getManifest());
  } catch { return false; }
}

// ── State ─────────────────────────────────────────────────────────
const isYouTube = location.hostname.includes('youtube.com');
let enabled = true;
let cosmeticEnabled = true;
let hiddenCount = 0;

// Check storage — only to REMOVE adblock-on if disabled/paused.
// The class was already injected synchronously by earlyInject above.
if (extValid()) {
  try {
    chrome.storage.local.get(['enabled', 'pausedDomains', 'cosmeticFiltering'], (result) => {
      try {
        if (chrome.runtime.lastError || !result) return;
        const { enabled: e = true, pausedDomains = [], cosmeticFiltering = true } = result;
        const host = location.hostname;
        if (!e || pausedDomains.includes(host) || !cosmeticFiltering) {
          enabled = false;
          document.documentElement.classList.remove('adblock-on');
          document.getElementById('__adblock_base__')?.remove();
          return;
        }
        // Already active — just ensure custom user rules are injected
        injectCustomCssRules();
      } catch { /* extension context invalidated */ }
    });
  } catch { /* extension context invalidated */ }
}

// ── On DOM ready ──────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

function init() {
  if (!extValid()) return;
  try {
    chrome.storage.local.get(['enabled', 'pausedDomains'], (result) => {
      try {
        if (chrome.runtime.lastError || !result) return;
        const { enabled: e = true, pausedDomains = [] } = result;
        const host = location.hostname;
        if (!e || pausedDomains.includes(host)) {
          enabled = false;
          disableCosmeticCss();
          return;
        }
        enabled = true;
        // Ensure CSS is active (may already be from the early check above)
        if (!document.documentElement.classList.contains('adblock-on')) {
          injectBaseCss();
        }
        _globalConfigReady.finally(() => {
          hideAds();
          loadClassifierLists();   // fetch real rule patterns from background
          removeAdScripts();       // seeds initial stats from existing elements
          observeMutations();
        });
      } catch { /* extension context invalidated */ }
    });
  } catch { /* extension context invalidated */ }
}

function disableCosmeticCss() {
  // Remove html.adblock-on — instantly disables all content.css rules
  document.documentElement.classList.remove('adblock-on');
  // Remove the inline style injected by injectBaseCss
  document.getElementById('__adblock_base__')?.remove();
  // Stop observing DOM mutations
  disconnectObserver();
  // Unhide any elements already hidden by JS (site-block.js / collapseParentIfEmpty)
  document.querySelectorAll('[data-adblock-hidden]').forEach(el => {
    el.style.removeProperty('display');
    el.style.removeProperty('visibility');
    el.style.removeProperty('height');
    el.style.removeProperty('min-height');
    el.style.removeProperty('margin');
    el.style.removeProperty('padding');
    el.style.removeProperty('overflow');
    delete el.dataset.adblockHidden;
  });
}

function enableCosmeticCss() {
  document.documentElement.classList.add('adblock-on');
  injectBaseCss();
}

// ── Inject base cosmetic CSS (blocks paint) ─────────────────────
function injectBaseCss() {
  // earlyInject() already ran synchronously — just ensure class is present
  document.documentElement.classList.add('adblock-on');
  injectCustomCssRules();
}

function injectCustomCssRules() {
  // Remove old custom style if any
  document.getElementById('__adblock_custom__')?.remove();

  if (!extValid()) return;
  try {
    chrome.storage.local.get('rules', (result) => {
      try {
        if (chrome.runtime.lastError || !result) return;
        const rules = result.rules || [];
        const cssRules = rules.filter(r => r.active && r.action === 'hide' && r.type === 'css' && r.pattern);
        const kwRules  = rules.filter(r => r.active && r.action === 'hide' && r.type === 'keyword' && r.pattern);

        if (!cssRules.length && !kwRules.length) return;

        const selectors = [];
        for (const r of cssRules) selectors.push(`html.adblock-on ${r.pattern}`);
        for (const r of kwRules) {
          // Keyword hide → match elements containing the keyword in class/id
          selectors.push(`html.adblock-on [class*="${r.pattern}"]`);
          selectors.push(`html.adblock-on [id*="${r.pattern}"]`);
        }

        const style = document.createElement('style');
        style.id = '__adblock_custom__';
        style.textContent = selectors.join(',\n') + ` {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }`;
        (document.head || document.documentElement).appendChild(style);
      } catch { /* extension context invalidated */ }
    });
  } catch { /* extension context invalidated */ }
}

// ── Video player protection ──────────────────────────────────────
// Never hide or remove elements that are (or contain) the main video player.
function isVideoPlayerElement(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  // Direct video/embed/object elements
  if (tag === 'VIDEO' || tag === 'EMBED' || tag === 'OBJECT') return true;
  // Iframes that are likely video players (large size or video-related src)
  if (tag === 'IFRAME') {
    const src = (el.src || '').toLowerCase();
    // Known video player / streaming embed patterns
    if (/player|embed|video|stream|hls|dash|jwplayer|plyr|vimeo|dailymotion|mp4|m3u8/.test(src)) return true;
    // Large iframes are usually the main content player, not ads
    const rect = el.getBoundingClientRect();
    if (rect.width > 200 && rect.height > 150) return true;
  }
  // Element contains a video/iframe player inside
  if (el.querySelector && (el.querySelector('video, embed, object') ||
      el.querySelector('iframe[src*="player"], iframe[src*="embed"], iframe[src*="video"]'))) {
    return true;
  }
  return false;
}

// ── Batch parent collapse via RAF ────────────────────────────────
const _COLLAPSE_SKIP_TAGS = new Set(['SCRIPT','STYLE','LINK','META','NOSCRIPT','TEMPLATE','BR','WBR']);
let _collapsePending = new Set();
let _collapseRafId = null;

function _flushCollapse() {
  _collapseRafId = null;
  const nodes = _collapsePending;
  _collapsePending = new Set();
  for (const el of nodes) _collapseWalk(el);
}

function _collapseWalk(el) {
  let node = el;
  while (true) {
    const parent = node.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement) break;
    if (parent.dataset.adblockHidden) break;
    if (isVideoPlayerElement(parent)) break;
    let visible = 0;
    for (const child of parent.children) {
      if (_COLLAPSE_SKIP_TAGS.has(child.tagName)) continue;
      if (child.dataset.adblockHidden) continue;
      if (child.style.display === 'none' || child.style.visibility === 'hidden') continue;
      visible++;
    }
    if (visible > 0) break;
    parent.style.setProperty('display',    'none',   'important');
    parent.style.setProperty('visibility', 'hidden', 'important');
    parent.style.setProperty('height',     '0',      'important');
    parent.style.setProperty('min-height', '0',      'important');
    parent.style.setProperty('margin',     '0',      'important');
    parent.style.setProperty('padding',    '0',      'important');
    parent.style.setProperty('overflow',   'hidden', 'important');
    parent.dataset.adblockHidden = '1';
    node = parent;
  }
}

function _scheduleCollapse(el) {
  _collapsePending.add(el);
  if (!_collapseRafId) _collapseRafId = requestAnimationFrame(_flushCollapse);
}

// ── Hide ad elements in DOM — single querySelectorAll call ───────
function hideAds(root = document) {
  if (!enabled || !cosmeticEnabled || !_joinedSelector) return;

  let count = 0;
  try {
    (root === document ? document : root).querySelectorAll(_joinedSelector).forEach(el => {
      if (el.dataset.adblockHidden) return;
      if (isVideoPlayerElement(el)) return;
      if (isYouTube && el.closest('.html5-video-player')) return;
      el.style.setProperty('display',    'none',   'important');
      el.style.setProperty('visibility', 'hidden', 'important');
      el.dataset.adblockHidden = '1';
      _scheduleCollapse(el);
      count++;
    });
  } catch { /* joined selector parse error — extremely rare */ }

  hiddenCount += count;
  if (count > 0 && extValid()) {
    chrome.runtime.sendMessage({ type: 'COSMETIC_HIDDEN', count, url: location.href }).catch(() => {});
  }
}

// ── Remove injected ad scripts ────────────────────────────────────
function removeAdScripts(root = document) {
  if (!enabled) return;
  root.querySelectorAll('script[src], iframe[src], img[src], link[href]').forEach(el => {
    try {
      const rawUrl = el.src || el.getAttribute('src') || el.href || el.getAttribute('href') || '';
      if (!rawUrl) return;
      const host = new URL(rawUrl).hostname;
      // Record for stats regardless of whether we physically remove it
      // (DNR already blocked the request; we just observe the attempt)
      recordResource(rawUrl);
      if (_adScriptHosts.some(h => host.endsWith(h))) {
        // Don't remove iframes that are likely video players
        if (el.tagName === 'IFRAME' && isVideoPlayerElement(el)) return;
        // On YouTube, don't remove elements inside the video player
        if (isYouTube && el.closest('.html5-video-player')) return;
        el.remove();
      }
    } catch { /* invalid URL */ }
  });
}

// ── MutationObserver for dynamic / SPA pages ─────────────────────
let activeObserver = null;

function observeMutations() {
  // Don't create duplicate observers
  if (activeObserver) return;

  // Batch nodes and process once per animation frame to avoid
  // calling querySelectorAll (70+ selectors) on every single DOM mutation.
  let _pendingNodes = [];
  let _pendingSrcEls = [];
  let _rafPending = false;

  function processPending() {
    _rafPending = false;
    const nodes = _pendingNodes.splice(0);
    const srcEls = _pendingSrcEls.splice(0);
    for (const node of nodes) {
      hideAds(node);
      removeAdScripts(node);
    }
    for (const el of srcEls) {
      if (isYouTube && el.closest('.html5-video-player')) continue;
      try {
        const host = new URL(el.src).hostname;
        if (_adScriptHosts.some(h => host.endsWith(h))) {
          el.style.setProperty('display', 'none', 'important');
        }
      } catch { /* ignore */ }
    }
  }

  activeObserver = new MutationObserver(mutations => {
    if (!enabled) return;

    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        _pendingNodes.push(node);
      }
      if (mut.type === 'attributes' && mut.attributeName === 'src') {
        if (mut.target.tagName === 'IFRAME') _pendingSrcEls.push(mut.target);
      }
    }

    if (!_rafPending && (_pendingNodes.length || _pendingSrcEls.length)) {
      _rafPending = true;
      requestAnimationFrame(processPending);
    }
  });

  activeObserver.observe(document.documentElement, {
    childList:  true,
    subtree:    true,
    attributes: true,
    attributeFilter: ['src'],
  });
}

function disconnectObserver() {
  if (activeObserver) {
    activeObserver.disconnect();
    activeObserver = null;
  }
}

// ── Message listener (from popup / background) ───────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'TOGGLE') {
    enabled = msg.enabled;
    try { localStorage.setItem('_ytpb_state', enabled ? '1' : '0'); } catch (_e) {}
    if (enabled) {
      enableCosmeticCss();
      hideAds();
      observeMutations();
      document.dispatchEvent(new CustomEvent('_ytpb_on'));
    } else {
      disableCosmeticCss();
      document.dispatchEvent(new CustomEvent('_ytpb_off'));
    }
    sendResponse({ ok: true });
  }

  if (msg.type === 'PAUSE_DOMAIN') {
    if (msg.paused) {
      enabled = false;
      try { localStorage.setItem('_ytpb_state', '0'); } catch (_e) {}
      disableCosmeticCss();
      document.dispatchEvent(new CustomEvent('_ytpb_off'));
    } else {
      enabled = true;
      try { localStorage.setItem('_ytpb_state', '1'); } catch (_e) {}
      enableCosmeticCss();
      hideAds();
      observeMutations();
      document.dispatchEvent(new CustomEvent('_ytpb_on'));
    }
    sendResponse({ ok: true });
  }

  if (msg.type === 'GET_HIDDEN_COUNT') {
    sendResponse({ count: hiddenCount });
  }

  if (msg.type === 'COSMETIC_TOGGLE') {
    if (msg.enabled) {
      enableCosmeticCss();
      hideAds();
      observeMutations();
    } else {
      disableCosmeticCss();
    }
    sendResponse({ ok: true });
  }

  if (msg.type === 'RULES_CHANGED') {
    // Re-inject custom CSS rules when user modifies rules
    _globalConfigReady.finally(() => {
      injectCustomCssRules();
      hideAds();
      sendResponse({ ok: true });
    });
    return true;
  }
});


// ── YouTube video ad skipper ─────────────────────────────────────
// Moved entirely to content/yt-adblock.js (MAIN world).
// content.js injects that file at the top of this script via a <script> tag.
// yt-adblock.js handles: setInterval polling, MutationObserver, forceSkipAd,
// clickSkipButton, restoreAfterAd, blackscreen watchdog, CSS injection.
// YouTube cosmetic selectors now live in rule/site-rules.txt and are
// applied by content/site-block.js so the shared content engine stays generic.
