// content/content.js — AdBlock Cosmetic Filter Engine
// Runs at document_start on every page
// Responsibilities:

// ── YouTube: inject yt-adblock.js into MAIN world via DOM ─────────
// chrome.scripting is not needed — a <script src> tag from content world
// executes in MAIN world, same as the page's own scripts.
if (/youtube\.com/.test(location.hostname) && !window.__adblockYtInjected) {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('content/yt-adblock.js');
  s.async = false;
  (document.documentElement || document.head || document.body).appendChild(s);
  s.remove(); // clean up after load
}
//   1. Hide ad elements via CSS selectors (cosmetic filtering)
//   2. Remove ad iframes / scripts on DOM ready
//   3. Observe dynamic DOM mutations (SPA / infinite scroll)
//   4. Listen for messages from background to toggle per-domain

// ── Cosmetic selector list ─────────────────────────────────────────
// IMPORTANT: No broad [class*="ad-"] or [id*="ad-"] wildcards!
// Those cause false positives on YouTube, Facebook, etc. where
// legitimate UI elements contain "ad" in class/id names.
// Every selector must target a KNOWN ad provider element specifically.
const COSMETIC_SELECTORS = [
  // Google Ads / DFP (specific elements)
  'ins.adsbygoogle', '.adsbygoogle',
  '[id^="div-gpt-ad"]',
  '[id^="google_ads_iframe"]',
  '[id^="dfp-ad-"]',
  'iframe[src*="googleadservices"]',
  'iframe[src*="doubleclick.net"]',
  'iframe[src*="googlesyndication"]',

  // YouTube-specific ad elements
  // NOTE: Do NOT include .ytp-ad-module, .ytp-ad-overlay-container,
  // .ytp-ad-player-overlay or any video-player ad containers here.
  // Those must remain renderable so the JS ad skipper can mute + speed-skip.
  // Using display:none on them causes a stuck black screen.
  'ytd-ad-slot-renderer',
  'ytd-in-feed-ad-layout-renderer',
  'ytd-banner-promo-renderer',
  'ytd-statement-banner-renderer',
  'ytd-promoted-sparkles-web-renderer',
  'ytd-promoted-video-renderer',
  'ytd-display-ad-renderer',
  'ytd-compact-promoted-video-renderer',
  'ytd-action-companion-ad-renderer',
  '#player-ads',
  '#masthead-ad',

  // YouTube Premium upsell / promo elements
  'ytd-mealbar-promo-renderer',
  'ytd-background-promo-renderer',
  'ytd-official-card-renderer',
  'ytd-survey-notification-renderer',
  '.ytd-mealbar-promo-renderer',
  'ytd-enforcement-message-view-model',
  '#offer-module',
  '.ytp-paid-content-overlay',
  '.ytp-premium-yoodle',

  // YouTube in-feed video ads (promoted videos in feed/search/sidebar)
  'ytd-rich-item-renderer:has(ytd-ad-slot-renderer)',
  'ytd-video-renderer[is-ad]',
  'ytd-rich-item-renderer[is-ad]',
  'ytd-reel-item-renderer[is-ad]',
  'ytd-search-pyv-renderer',
  'ytd-promoted-sparkles-text-search-renderer',
  'ytd-movie-offer-module-renderer',
  'ytd-compact-movie-renderer[is-ad]',


  // Outbrain / Taboola
  '.OUTBRAIN', 'div.ob-widget', 'div.ob-smartfeed-wrapper',
  '[data-widget-id^="outbrain"]',
  '.trc_related_container',
  '[id^="taboola-"]', '.taboola-container',

  // Amazon ads
  'iframe[src*="amazon-adsystem"]',

  // Criteo
  '.criteo-ad',
  '[id^="crt-"][id$="-wrapper"]',

  // Ad provider iframes
  'iframe[src*="adnxs.com"]',
  'iframe[src*="media.net"]',
  'iframe[src*="pubmatic.com"]',
  'iframe[src*="openx.net"]',
  'iframe[src*="rubiconproject.com"]',

  // Known ad class names (exact class, not wildcard)
  '.ad-banner', '.ad-wrapper', '.ad-container',
  '.ad-slot', '.ad-unit', '.ad-frame',
  '.ad-leaderboard', '.ad-sidebar', '.ad-rectangle',
  '#ad-banner', '#ad-wrapper', '#ad-container',

  // Sponsored / promoted content (specific attributes)
  '[aria-label="Advertisement"]',
  '[aria-label="Sponsored"]',
  '[data-ad="true"]',
  'li[data-promoted="true"]',
  '.sponsored-post', '.promoted-content',

  // Interstitials
  '.ad-modal', '.ad-popup', '.interstitial-ad',
];

// ── Ad script / network hostnames to block via mutation ───────────
const AD_SCRIPT_HOSTS = [
  'googlesyndication.com', 'doubleclick.net', 'googleadservices.com',
  'adnxs.com', 'outbrain.com', 'taboola.com', 'amazon-adsystem.com',
  'media.net', 'criteo.com', 'advertising.com', 'pubmatic.com',
  'openx.net', 'rubiconproject.com', 'casalemedia.com', 'sovrn.com',
];

// ── Resource classification for stats ────────────────────────────
// Populated dynamically from background.js rule patterns on init.
// Fallback defaults active until background responds.
let _adPatterns      = ['doubleclick', 'googlesyndication', 'googleadservices', 'adnxs', 'outbrain', 'taboola', 'amazon-adsystem', 'media.net', 'criteo', 'advertising.com', 'pubmatic', 'openx.net', 'rubiconproject'];
let _trackerPatterns = ['google-analytics', 'analytics.google', 'facebook.com/tr', 'hotjar', 'mixpanel', 'segment.io', 'amplitude', 'fullstory', 'clarity.ms', 'quantserve'];
let _malwarePatterns = ['coinhive', 'coin-hive', 'jsecoin', 'crypto-loot', 'authedmine', 'cryptonight', 'minero.cc'];

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

// Check storage FIRST before injecting any CSS.
// This prevents the flash-block-then-unblock on paused domains.
if (extValid()) {
  try {
    chrome.storage.local.get(['enabled', 'pausedDomains', 'cosmeticFiltering'], (result) => {
      try {
        if (chrome.runtime.lastError || !result) return;
        const { enabled: e = true, pausedDomains = [], cosmeticFiltering = true } = result;
        const host = location.hostname;
        if (!e || pausedDomains.includes(host) || !cosmeticFiltering) {
          // Paused, disabled, or cosmetic off — do NOT inject cosmetic CSS
          enabled = false;
          return;
        }
        // Active — inject CSS immediately
        injectBaseCss();
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
        hideAds();
        loadClassifierLists();   // fetch real rule patterns from background
        removeAdScripts();       // seeds initial stats from existing elements
        observeMutations();
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
  // Unhide any elements already hidden by JS (hideAds)
  document.querySelectorAll('[data-adblock-hidden]').forEach(el => {
    el.style.removeProperty('display');
    el.style.removeProperty('visibility');
    delete el.dataset.adblockHidden;
  });
}

function enableCosmeticCss() {
  document.documentElement.classList.add('adblock-on');
  injectBaseCss();
}

// ── Inject base cosmetic CSS (blocks paint) ─────────────────────
function injectBaseCss() {
  // Add html.adblock-on — this activates all html.adblock-on rules in content.css
  document.documentElement.classList.add('adblock-on');

  // Guard: don't inject twice
  if (document.getElementById('__adblock_base__')) return;

  // Inline style for the most critical selectors (scoped to html.adblock-on)
  const style = document.createElement('style');
  style.id = '__adblock_base__';
  style.textContent = `
    html.adblock-on ins.adsbygoogle,
    html.adblock-on [id^="div-gpt-ad"],
    html.adblock-on iframe[src*="doubleclick.net"],
    html.adblock-on iframe[src*="googlesyndication"] {
      display: none !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  // Inject user custom CSS hide rules
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

// ── Hide ad elements in DOM ───────────────────────────────────────
function hideAds(root = document) {
  if (!enabled || !cosmeticEnabled) return;

  let count = 0;
  for (const sel of COSMETIC_SELECTORS) {
    try {
      root.querySelectorAll(sel).forEach(el => {
        if (el.dataset.adblockHidden) return;
        // Protect video player elements from being hidden
        if (isVideoPlayerElement(el)) return;
        // On YouTube, skip elements inside the video player
        if (isYouTube && el.closest('.html5-video-player')) return;
        el.style.setProperty('display',    'none',   'important');
        el.style.setProperty('visibility', 'hidden', 'important');
        el.dataset.adblockHidden = '1';
        count++;
      });
    } catch {
      // ignore invalid selector
    }
  }

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
      if (AD_SCRIPT_HOSTS.some(h => host.endsWith(h))) {
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
        if (AD_SCRIPT_HOSTS.some(h => host.endsWith(h))) {
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
    if (enabled) {
      enableCosmeticCss();
      hideAds();
      observeMutations();
    } else {
      disableCosmeticCss();
    }
    sendResponse({ ok: true });
  }

  if (msg.type === 'PAUSE_DOMAIN') {
    if (msg.paused) {
      enabled = false;
      disableCosmeticCss();
    } else {
      enabled = true;
      enableCosmeticCss();
      hideAds();
      observeMutations();
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
    injectCustomCssRules();
    sendResponse({ ok: true });
  }
});


// ── YouTube video ad skipper ─────────────────────────────────────
// Moved entirely to content/yt-adblock.js (MAIN world).
// content.js injects that file at the top of this script via a <script> tag.
// yt-adblock.js handles: setInterval polling, MutationObserver, forceSkipAd,
// clickSkipButton, restoreAfterAd, blackscreen watchdog, CSS injection.
// Keeping duplicate logic here doubled CPU/RAM usage on YouTube tabs.
