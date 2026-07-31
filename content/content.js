// content/content.js — AdBlock Cosmetic Filter Engine
// Runs at document_start on every page
// Responsibilities:
//   1. Hide ad elements via CSS selectors (cosmetic filtering)
//   2. Remove ad iframes / scripts on DOM ready
//   3. Observe dynamic DOM mutations (SPA / infinite scroll)
//   4. Listen for messages from background to toggle per-domain

// ── Guard: detect invalidated extension context ───────────────────
function extValid() {
  try {
    // chrome.runtime.id is static; use getManifest() to actually probe the context
    return !!(chrome.runtime && chrome.runtime.getManifest());
  } catch { return false; }
}

// Substituted with a random string at build time (_build-lib.sh) — must
// match content/scriptlets.js's own copy of the same placeholder exactly.
const _QKV1_TOKEN = '__QKV1_BUILD_TOKEN__';

// _sendCss — forwards CSS text to background, which applies it via
// chrome.scripting.insertCSS (the browser's privileged "user stylesheet"
// layer). This never creates a page-visible <style> DOM node and never
// needs a toggle class on <html> — an empty css string tells background to
// remove whatever was previously applied for that slot. `fresh` must only
// ever be set on the very first CSS_SET of a page load (see earlyInject
// below): it tells background to discard any bookkeeping left over from
// the PREVIOUS document in this tab/frame, since insertCSS'd content does
// not itself survive navigation but our own tracking Map would.
function _sendCss(slot, css, fresh) {
  if (!extValid()) return;
  try {
    chrome.runtime.sendMessage({ type: 'CSS_SET', slot, css: css || '', fresh: !!fresh }).catch(() => {});
  } catch { /* extension context invalidated */ }
}

function _clearAllCss() {
  if (!extValid()) return;
  try { chrome.runtime.sendMessage({ type: 'CSS_CLEAR_ALL' }).catch(() => {}); } catch { /* invalidated */ }
}

// ── Base cosmetic CSS (default known-ad-provider selectors) ────────
// IMPORTANT: No broad wildcard selectors like [class*="ad-"]. Those cause
// false positives on sites like YouTube where legitimate elements contain
// "ad" in class/id names. Every selector here targets a KNOWN ad provider
// element. The last block ([data-qkv1-h="1"]) collapses layout space for
// elements JS already hid via site-block.js's hide()/collapseParentIfEmpty
// — belt-and-suspenders alongside the inline styles those set directly.
const BASE_CSS = `

[data-qkv1-h="1"] {
  display: none !important;
  height: 0 !important;
  min-height: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  border: none !important;
  overflow: hidden !important;
}
`;

// ── FAST PATH: fire the base CSS off immediately (frame 0, before any
// async storage read). "Send first, clear if needed" is faster than "wait
// then send" for the 99% case where adblock is active. `fresh: true`
// resets background's per-tab/frame bookkeeping for a brand-new document.
let _baseActive = true;
_sendCss('base', BASE_CSS, true);

// Cosmetic hiding (direct_hide_selectors) is owned entirely by site-block.js,
// which sends its own 'direct' CSS slot the same way.
// This file only manages base/custom CSS slots and resource stats classification.

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
  if (!(window.__qkv1Loader && window.__qkv1Loader.load)) {
    resolve();
    return;
  }
  window.__qkv1Loader.load('global', {}, (cfg) => {
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

// ── State ─────────────────────────────────────────────────────────
let enabled = true;

// Check storage — only to CLEAR the base CSS if disabled/paused.
// The base CSS was already sent synchronously above.
if (extValid()) {
  try {
    chrome.storage.local.get(['enabled', 'pausedDomains', 'cosmeticFiltering'], (result) => {
      try {
        if (chrome.runtime.lastError || !result) return;
        const { enabled: e = true, pausedDomains = [], cosmeticFiltering = true } = result;
        const host = location.hostname;
        if (!e || pausedDomains.includes(host) || !cosmeticFiltering) {
          enabled = false;
          _baseActive = false;
          _clearAllCss();
          return;
        }
        // Already active — just ensure custom user rules are sent
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
        // Ensure base CSS is active (may already be from the early send above)
        if (!_baseActive) injectBaseCss();
        _globalConfigReady.finally(() => {
          removeAdScripts();   // seed initial stats from existing elements
          observeMutations();
        });
      } catch { /* extension context invalidated */ }
    });
  } catch { /* extension context invalidated */ }
}

function disableCosmeticCss() {
  _baseActive = false;
  // Clears base + custom + site-block.js's 'direct' slot in one shot —
  // mirrors what removing the old toggle class used to do for free.
  _clearAllCss();
  // Stop observing DOM mutations
  disconnectObserver();
  // Unhide any elements already hidden by JS (site-block.js / collapseParentIfEmpty)
  document.querySelectorAll('[data-qkv1-h]').forEach(el => {
    el.style.removeProperty('display');
    el.style.removeProperty('visibility');
    el.style.removeProperty('height');
    el.style.removeProperty('min-height');
    el.style.removeProperty('margin');
    el.style.removeProperty('padding');
    el.style.removeProperty('overflow');
    delete el.dataset.qkv1H;
  });
}

function enableCosmeticCss() {
  injectBaseCss();
}

// ── (Re-)send base cosmetic CSS ─────────────────────────────────
function injectBaseCss() {
  _baseActive = true;
  _sendCss('base', BASE_CSS);
  injectCustomCssRules();
}

function injectCustomCssRules() {
  if (!extValid()) return;
  try {
    chrome.storage.local.get('rules', (result) => {
      try {
        if (chrome.runtime.lastError || !result) return;
        const rules = result.rules || [];
        const cssRules = rules.filter(r => r.active && r.action === 'hide' && r.type === 'css' && r.pattern);
        const kwRules  = rules.filter(r => r.active && r.action === 'hide' && r.type === 'keyword' && r.pattern);

        if (!cssRules.length && !kwRules.length) { _sendCss('custom', ''); return; }

        const selectors = [];
        for (const r of cssRules) selectors.push(r.pattern);
        for (const r of kwRules) {
          // Keyword hide → match elements containing the keyword in class/id
          selectors.push(`[class*="${r.pattern}"]`);
          selectors.push(`[id*="${r.pattern}"]`);
        }

        _sendCss('custom', selectors.join(',\n') + ` {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }`);
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
    // Re-send custom CSS rules when user modifies rules
    _globalConfigReady.finally(() => {
      injectCustomCssRules();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'CLEAR_SCRIPTLET_CACHE') {
    // Relay into the MAIN world — the rules cache lives in this page's own
    // localStorage, which content.js (isolated world) can't touch directly.
    window.dispatchEvent(new CustomEvent(`__${_QKV1_TOKEN}_clr__`));
    sendResponse({ ok: true });
  }

});


// ── YouTube video ads ────────────────────────────────────────────
// Handled by content/scriptlets.js (MAIN world): json_prune_fetch/xhr rules in
// rule/site-rules.txt strip adPlacements/adSlots from player responses before
// the page reads them, and report blocks via the token-suffixed "blk" event
// (forwarded to stats by site-block.js). YouTube cosmetic selectors live in
// rule/site-rules.txt and are applied by content/site-block.js.
