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
    return !!(EXT.runtime && EXT.runtime.getManifest());
  } catch { return false; }
}

// Substituted with a random string at build time (_build-lib.sh) — must
// match content/scriptlets.js's own copy of the same placeholder exactly.
const _QKV1_TOKEN = '__QKV1_BUILD_TOKEN__';

// Marker attribute for elements already hidden by site-block.js's
// hide()/collapseParentIfEmpty (dedup + collapse-propagation state, see that
// file). Random PER PAGE LOAD (not a build-time constant like _QKV1_TOKEN
// above) — a page can enumerate this attribute's NAME (it's on the DOM), so
// unlike the event names/localStorage key (which stay inside JS and never
// touch the DOM), a static name of any kind is eventually observable by
// whoever's loaded THIS specific page. Regenerating it every navigation
// means an observed value is worthless on the next page load.
// content.js and site-block.js are separate closures but run in the SAME
// content_scripts entry (isolated world) in the order listed in
// manifest.json — content.js runs first and stashes the value on the
// isolated-world `window` (confirmed NOT page-visible: isolated-world
// content scripts get their own separate `window`, distinct from the page's
// real one) for site-block.js to read synchronously — no chrome.storage /
// message round-trip, so this doesn't delay the "fire CSS immediately"
// fast path below.
const _HIDE_ATTR = 'h' + (
  window.crypto && window.crypto.randomUUID
    ? window.crypto.randomUUID().replace(/-/g, '')
    : Math.random().toString(36).slice(2) + Date.now().toString(36)
);
window.__qkv1HideAttr = _HIDE_ATTR;

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
    EXT.runtime.sendMessage({ type: 'CSS_SET', slot, css: css || '', fresh: !!fresh }).catch(() => {});
  } catch { /* extension context invalidated */ }
}

function _clearAllCss() {
  if (!extValid()) return;
  try { EXT.runtime.sendMessage({ type: 'CSS_CLEAR_ALL' }).catch(() => {}); } catch { /* invalidated */ }
}

// ── Base cosmetic CSS (default known-ad-provider selectors) ────────
// IMPORTANT: No broad wildcard selectors like [class*="ad-"]. Those cause
// false positives on sites like YouTube where legitimate elements contain
// "ad" in class/id names. Every selector here targets a KNOWN ad provider
// element. The [_HIDE_ATTR="1"] rule is belt-and-suspenders backup for
// elements JS already hid via site-block.js's hide()/removeEl (which set
// their own inline style directly) — this CSS rule alone is what matters
// for any OTHER element sharing that marker.
//
// Single display:none!important property only (not also height/min-height/
// margin/padding/border/overflow, which this block had before 2026-08-30):
// live-verified on Firefox that a CSS block with several properties in one
// declaration triggered NS_ERROR_ILLEGAL_VALUE from
// nsIDOMWindowUtils.addSheet on chrome.scripting.insertCSS (Gecko-internal,
// exact trigger still unconfirmed) — the same simplification already
// applied to site-block.js's _injectDirectStyle() stopped reproducing it
// there. display:none alone is sufficient regardless: once it wins the
// cascade (origin:'USER', see background.js's setFrameCss), the element
// already takes zero layout space, so the other properties never had
// anything left to add.
const BASE_CSS = `[${_HIDE_ATTR}="1"]{display:none!important}`;

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
//
// classifyUrl() runs on EVERY observed network resource on the page — a
// real per-request hot path, not one-time setup. Enabling several large
// Rule Sources (EasyList, EasyPrivacy, region lists) can grow these arrays
// into the thousands (2026-08-24: a real user's merged config carried this
// scale), turning what used to be a handful of `.some()` comparisons into a
// genuine per-resource linear scan over thousands of entries, times up to 3
// (malware, tracker, ad) per URL. Every ABP-converted network-domain entry
// is a BARE domain string (background.js's `_abpParseFile` only ever adds
// `ABP_BARE_NETWORK_DOMAIN_RE`-matched patterns here, stripped of the
// trailing `^`) — the same shape resolveSiteKey()'s domain-suffix-walk
// already exploits in background.js. Patterns are split ONCE per config
// load (not per resource) into a domain Set (checked via O(host-label-
// depth) suffix walk, mirroring _patternMatches' own `host === pattern ||
// host.endsWith('.'+pattern)` semantics) and a small "other" bucket for the
// rare path-scoped ("facebook.com/tr") or bare-keyword patterns, which
// still need substring matching against the full URL — same matching
// semantics as before, just not an O(n) scan for the dominant domain case.
function _splitPatterns(list) {
  const domainSet = new Set();
  const other = [];
  for (const p of list) {
    if (p.indexOf('.') !== -1 && p.indexOf('/') === -1) domainSet.add(p);
    else other.push(p);
  }
  return { domainSet, other };
}
function _domainSetMatches(domainSet, host) {
  let h = host;
  while (h) {
    if (domainSet.has(h)) return true;
    const dot = h.indexOf('.');
    if (dot === -1) break;
    h = h.slice(dot + 1);
  }
  return false;
}
function _otherPatternsMatch(patterns, fullUrl) {
  for (let i = 0; i < patterns.length; i++) if (fullUrl.indexOf(patterns[i]) !== -1) return true;
  return false;
}

let { domainSet: _adDomainSet, other: _adOtherPatterns } =
  _splitPatterns(['doubleclick.net', 'googlesyndication.com', 'googleadservices.com']);
let { domainSet: _trackerDomainSet, other: _trackerOtherPatterns } =
  _splitPatterns(['google-analytics.com', 'analytics.google.com', 'facebook.com/tr']);
let { domainSet: _malwareDomainSet, other: _malwareOtherPatterns } =
  _splitPatterns(['coinhive.com', 'coin-hive.com', 'jsecoin.com']);

function applyGlobalConfig(cfg) {
  if (!cfg) return;
  // Use ad_network_patterns / tracker_network_patterns for URL stats classification
  const norm = list => list.map(p => String(p).toLowerCase().trim()).filter(Boolean);
  if (Array.isArray(cfg.ad_network_patterns) && cfg.ad_network_patterns.length) {
    ({ domainSet: _adDomainSet, other: _adOtherPatterns } = _splitPatterns(norm(cfg.ad_network_patterns)));
  }
  if (Array.isArray(cfg.tracker_network_patterns) && cfg.tracker_network_patterns.length) {
    ({ domainSet: _trackerDomainSet, other: _trackerOtherPatterns } = _splitPatterns(norm(cfg.tracker_network_patterns)));
  }
  if (Array.isArray(cfg.malware_network_domains) && cfg.malware_network_domains.length) {
    ({ domainSet: _malwareDomainSet, other: _malwareOtherPatterns } = _splitPatterns(norm(cfg.malware_network_domains)));
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

function classifyUrl(url) {
  if (!url) return null;
  let host, full;
  try {
    const u = new URL(url, location.href);
    host = u.hostname.toLowerCase();
    full = u.href.toLowerCase();
  } catch { return null; }
  if (_domainSetMatches(_malwareDomainSet, host) || _otherPatternsMatch(_malwareOtherPatterns, full)) return 'malware';
  if (_domainSetMatches(_trackerDomainSet, host) || _otherPatternsMatch(_trackerOtherPatterns, full)) return 'tracker';
  if (_domainSetMatches(_adDomainSet, host)      || _otherPatternsMatch(_adOtherPatterns, full))      return 'ad';
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
  EXT.runtime.sendMessage({
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
    EXT.storage.local.get(['enabled', 'pausedDomains', 'cosmeticFiltering'], (result) => {
      try {
        if (EXT.runtime.lastError || !result) return;
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
    EXT.storage.local.get(['enabled', 'pausedDomains'], (result) => {
      try {
        if (EXT.runtime.lastError || !result) return;
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
  document.querySelectorAll(`[${_HIDE_ATTR}]`).forEach(el => {
    el.style.removeProperty('display');
    el.style.removeProperty('visibility');
    el.style.removeProperty('height');
    el.style.removeProperty('min-height');
    el.style.removeProperty('margin');
    el.style.removeProperty('padding');
    el.style.removeProperty('overflow');
    el.removeAttribute(_HIDE_ATTR);
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
    EXT.storage.local.get('rules', (result) => {
      try {
        if (EXT.runtime.lastError || !result) return;
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
EXT.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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

});


// ── YouTube video ads ────────────────────────────────────────────
// Handled by content/scriptlets.js (MAIN world): json_prune_fetch/xhr rules in
// rule/site-rules.txt strip adPlacements/adSlots from player responses before
// the page reads them, and report blocks via the token-suffixed "blk" event
// (forwarded to stats by site-block.js). YouTube cosmetic selectors live in
// rule/site-rules.txt and are applied by content/site-block.js.
