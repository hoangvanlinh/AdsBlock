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

//   1. Hide ad elements via CSS selectors (cosmetic filtering)
//   2. Remove ad iframes / scripts on DOM ready
//   3. Observe dynamic DOM mutations (SPA / infinite scroll)
//   4. Listen for messages from background to toggle per-domain

// Cosmetic hiding (direct_hide_selectors) is owned entirely by site-block.js,
// which injects them as a stylesheet scoped under html.adblock-on.
// This file only manages the adblock-on class, user custom CSS rules,
// and resource stats classification.

// ── Resource classification for stats ────────────────────────────
// Seeded from site-rules.txt [global] ad_network_patterns / tracker_network_patterns.
// Fallback defaults active until config loads.
let _adPatterns      = ['doubleclick.net', 'googlesyndication.com', 'googleadservices.com'];
let _trackerPatterns = ['google-analytics.com', 'analytics.google.com', 'facebook.com/tr'];
let _malwarePatterns = ['coinhive.com', 'coin-hive.com', 'jsecoin.com'];

function applyGlobalConfig(cfg) {
  if (!cfg) return;
  // Use ad_network_patterns / tracker_network_patterns for URL stats classification
  const norm = list => list.map(p => String(p).toLowerCase().trim()).filter(Boolean);
  if (Array.isArray(cfg.ad_network_patterns) && cfg.ad_network_patterns.length) {
    _adPatterns = norm(cfg.ad_network_patterns);
  }
  if (Array.isArray(cfg.tracker_network_patterns) && cfg.tracker_network_patterns.length) {
    _trackerPatterns = norm(cfg.tracker_network_patterns);
  }
  if (Array.isArray(cfg.malware_network_domains) && cfg.malware_network_domains.length) {
    _malwarePatterns = norm(cfg.malware_network_domains);
  }
}

const _globalConfigReady = new Promise((resolve) => {
  if (!(window.__adblockRuleLoader && window.__adblockRuleLoader.load)) {
    resolve();
    return;
  }
  window.__adblockRuleLoader.load('global', {}, (cfg) => {
    applyGlobalConfig(cfg);
    resolve();
  });
});

// Mirror DNR matching semantics so stats only count what would be blocked:
// bare domains anchor on the request hostname (domain or subdomain), while
// patterns with a path ("facebook.com/tr") or bare keywords stay substrings.
function _patternMatches(pattern, fullUrl, host) {
  if (pattern.includes('/')) return fullUrl.includes(pattern);
  if (pattern.includes('.')) return host === pattern || host.endsWith('.' + pattern);
  return fullUrl.includes(pattern);
}

function classifyUrl(url) {
  if (!url) return null;
  let host, full;
  try {
    const u = new URL(url, location.href);
    host = u.hostname.toLowerCase();
    full = u.href.toLowerCase();
  } catch { return null; }
  if (_malwarePatterns.some(p => _patternMatches(p, full, host))) return 'malware';
  if (_trackerPatterns.some(p => _patternMatches(p, full, host))) return 'tracker';
  if (_adPatterns.some(p => _patternMatches(p, full, host)))      return 'ad';
  return null;
}

// Batch counter — flushed every 2 s to avoid flooding the message channel
let _statBatch = { seen: 0, ads: 0, trackers: 0, malware: 0 };
let _flushTimer = null;
let _recordedUrls = new Set(); // dedup: prevent counting the same URL multiple times
const _RECORDED_URLS_MAX = 2000; // cap to prevent unbounded memory growth

function recordResource(url) {
  if (!url) return;
  // Deduplicate — same URL should only be counted once per page load
  if (_recordedUrls.has(url)) return;
  // Cap the set to prevent unbounded growth on long sessions
  if (_recordedUrls.size >= _RECORDED_URLS_MAX) _recordedUrls.clear();
  _recordedUrls.add(url);
  // Every observed resource counts toward `seen` — speedGain and the privacy
  // score treat totalSeen as ALL requests, not just the ad-tech ones.
  _statBatch.seen++;
  const kind = classifyUrl(url);
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
let enabled = true;

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
          removeAdScripts();   // seed initial stats from existing elements
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

// ── Record network elements for stats ────────────────────────────
// DNR in background.js handles actual network blocking.
// This function only reads element URLs to update stats counters.
function removeAdScripts(root = document) {
  if (!enabled) return;
  root.querySelectorAll('script[src], iframe[src], img[src], link[href]').forEach(el => {
    try {
      const rawUrl = el.src || el.getAttribute('src') || el.href || el.getAttribute('href') || '';
      if (rawUrl) recordResource(rawUrl);
    } catch { /* invalid URL */ }
  });
}

// ── MutationObserver for stats on dynamic / SPA pages ────────────
// Cosmetic hiding is CSS-driven (site-block.js stylesheet); this observer
// only records resource URLs for stats classification.
let activeObserver = null;

function observeMutations() {
  // Don't create duplicate observers
  if (activeObserver) return;

  // Batch nodes and process once per animation frame.
  let _pendingNodes = [];
  let _pendingSrcEls = [];
  let _rafPending = false;

  function processPending() {
    _rafPending = false;
    const nodes = _pendingNodes.splice(0);
    const srcEls = _pendingSrcEls.splice(0);
    for (const node of nodes) {
      removeAdScripts(node);
    }
    for (const el of srcEls) {
      try { recordResource(el.src); } catch { /* ignore */ }
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
    try { localStorage.setItem('__yt_pb', enabled ? '1' : '0'); } catch (_e) {}
    if (enabled) {
      enableCosmeticCss();
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
      try { localStorage.setItem('__yt_pb', '0'); } catch (_e) {}
      disableCosmeticCss();
      document.dispatchEvent(new CustomEvent('_ytpb_off'));
    } else {
      enabled = true;
      try { localStorage.setItem('__yt_pb', '1'); } catch (_e) {}
      enableCosmeticCss();
      observeMutations();
      document.dispatchEvent(new CustomEvent('_ytpb_on'));
    }
    sendResponse({ ok: true });
  }

  // GET_HIDDEN_COUNT is answered by site-block.js, the sole cosmetic engine.

  if (msg.type === 'COSMETIC_TOGGLE') {
    if (msg.enabled) {
      enableCosmeticCss();
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
      sendResponse({ ok: true });
    });
    return true;
  }
});


// ── YouTube video ads ────────────────────────────────────────────
// Handled by content/scriptlets.js (MAIN world): json_prune_fetch/xhr rules in
// rule/site-rules.txt strip adPlacements/adSlots from player responses before
// the page reads them, and report blocks via the __adblock_blocked__ event
// (forwarded to stats by site-block.js). YouTube cosmetic selectors live in
// rule/site-rules.txt and are applied by content/site-block.js.
