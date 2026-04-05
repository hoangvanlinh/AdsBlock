// content/content.js — AdBlock Cosmetic Filter Engine
// Runs at document_start on every page
// Responsibilities:
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
  'ytd-ad-slot-renderer',
  'ytd-in-feed-ad-layout-renderer',
  'ytd-banner-promo-renderer',
  'ytd-statement-banner-renderer',
  'ytd-promoted-sparkles-web-renderer',
  'ytd-promoted-video-renderer',
  'ytd-display-ad-renderer',
  'ytd-compact-promoted-video-renderer',
  'ytd-action-companion-ad-renderer',
  '.ytp-ad-module',
  '.ytp-ad-overlay-container',
  '.ytp-ad-text-overlay',
  '.ytp-ad-image-overlay',
  '.ytp-ad-player-overlay',
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

  activeObserver = new MutationObserver(mutations => {
    if (!enabled) return;

    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        hideAds(node);
        removeAdScripts(node);
      }
      if (mut.type === 'attributes' && mut.attributeName === 'src') {
        const el = mut.target;
        if (el.tagName === 'IFRAME') {
          try {
            const host = new URL(el.src).hostname;
            if (AD_SCRIPT_HOSTS.some(h => host.endsWith(h))) {
              el.style.setProperty('display', 'none', 'important');
            }
          } catch { /* ignore */ }
        }
      }
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
// Pre-roll/mid-roll video ads can't be blocked via CSS or network rules
// because they share the same domain (googlevideo.com) as real videos.
// Strategy: detect ad → show overlay → skip instantly → seamless resume.
(function initYouTubeAdSkipper() {
  if (!location.hostname.includes('youtube.com')) return;

  let ytAdObserver = null;
  let ytAdInterval = null;
  let _adMuted = false;         // track whether WE muted the video
  let _savedVolume = 1;         // volume before we muted
  let _savedPlaybackRate = 1;   // playback rate before ad
  let _blackScreenTimer = null; // recovery watchdog
  let _adActive = false;        // track current ad state to avoid duplicate work
  let _adReported = false;       // prevent duplicate AD_SKIPPED messages per ad
  let _justRestoredFromAd = false; // flag: true briefly after ad ends, to allow one play() call
  let _videoSrcObserver = null; // observe video src changes for early detection
  let _lastMainVideoSrc = '';   // remember the main video src
  let _forceSkipInterval = null; // track forceSkipAd interval to prevent duplicates
  let _lastHideAdUiTime = 0;    // debounce hideAdUiElements calls

  // ── Ad video URL detection ─────────────────────────────────────
  // YouTube ad videos come from googlevideo.com but have distinct URL
  // parameters that differ from regular content videos.
  function isAdVideoUrl(url) {
    if (!url) return false;
    try {
      const u = new URL(url);
      const params = u.searchParams;
      if (url.startsWith('blob:')) return false;
      if (u.hostname.includes('googlevideo.com')) {
        // Only flag as ad when BOTH ctier param exists AND ratebypass is absent.
        // Using a single signal caused false positives on regular videos.
        const hasCtier = params.has('ctier');
        const lacksRatebypass = !params.has('ratebypass');
        if (hasCtier && lacksRatebypass) return true;
        // Also detect via 'oad' (overlay-ad) parameter
        if (params.has('oad') && lacksRatebypass) return true;
      }
    } catch { /* not a valid URL */ }
    return false;
  }

  // ── Inject CSS to hide the ad overlay / countdown instantly ────
  function injectYtAdCss() {
    if (document.getElementById('__adblock_yt_ad__')) return;
    const s = document.createElement('style');
    s.id = '__adblock_yt_ad__';
    s.textContent = `
      /* Hide ad overlay UI immediately so user never sees it */
      html.adblock-on .ytp-ad-player-overlay,
      html.adblock-on .ytp-ad-text-overlay,
      html.adblock-on .ytp-ad-image-overlay,
      html.adblock-on .ytp-ad-overlay-container,
      html.adblock-on .ytp-ad-message-container,
      html.adblock-on .ytp-ad-persistent-progress-bar-container,
      html.adblock-on .ytp-ad-visit-advertiser-button,
      html.adblock-on .ytp-ad-feedback-dialog-container,
      html.adblock-on .video-ads.ytp-ad-module {
        display: none !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }
      /* Hide the ad video frame entirely */
      html.adblock-on .html5-video-player.ad-showing video,
      html.adblock-on .html5-video-player.ad-interrupting video {
        opacity: 0 !important;
      }
      /* Hide yellow ad progress bar */
      html.adblock-on .ytp-ad-progress-list,
      html.adblock-on .ytp-play-progress.ytp-ad-play-progress,
      html.adblock-on .ytp-progress-bar[class*="ad"],
      html.adblock-on .ytp-ad-persistent-progress-bar-container,
      html.adblock-on .html5-video-player.ad-showing .ytp-progress-bar-container,
      html.adblock-on .html5-video-player.ad-interrupting .ytp-progress-bar-container,
      html.adblock-on .html5-video-player.ad-showing .ytp-chrome-bottom,
      html.adblock-on .html5-video-player.ad-interrupting .ytp-chrome-bottom {
        display: none !important;
        opacity: 0 !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }
      /* Hide ad countdown timer / "Ad · 0:15" / "Quảng cáo" badge */
      html.adblock-on .ytp-ad-duration-remaining,
      html.adblock-on .ytp-ad-simple-ad-badge,
      html.adblock-on .ytp-ad-preview-container,
      html.adblock-on .ytp-ad-preview-text,
      html.adblock-on .ytp-ad-skip-button-container,
      html.adblock-on .ytp-ad-text,
      html.adblock-on .ytp-ad-badge-text,
      html.adblock-on .ytp-ad-player-overlay-instream-info,
      html.adblock-on .ytp-ad-action-interstitial,
      html.adblock-on .ytp-ad-overlay-slot,
      html.adblock-on .ytp-ad-info-dialog-container,
      html.adblock-on .ytp-ad-hover-text-container,
      html.adblock-on .ytp-ad-player-overlay-skip-or-preview,
      html.adblock-on .ytp-ad-module .ytp-ad-player-overlay-layout,
      html.adblock-on .ytp-ad-badge,
      html.adblock-on [class*="ytp-ad-preview"],
      html.adblock-on [class*="ytp-ad-badge"],
      html.adblock-on [class*="ytp-ad-duration"] {
        display: none !important;
        opacity: 0 !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  // ── Overlay removed ────────────────────────────────────────────
  // No more black overlay. Ads are muted + sped through silently.
  // This avoids the black screen problem entirely.
  function removeSkipOverlay(player) {
    // Clean up any leftover overlays from previous version
    player?.querySelector('.__adblock_skip_overlay')?.remove();
    document.querySelectorAll('.__adblock_skip_overlay').forEach(el => el.remove());
  }

  // ── Forcefully hide all ad UI elements via JS ──────────────────
  // CSS alone fails when YouTube uses inline styles or shadow DOM.
  // This function brute-force hides every ad-related element.
  function hideAdUiElements(player) {
    if (!player) return;
    // Debounce: don't run more than once per 200ms
    const now = Date.now();
    if (now - _lastHideAdUiTime < 200) return;
    _lastHideAdUiTime = now;
    const adUiSelectors = [
      // Yellow progress bar & bottom controls during ad
      '.ytp-chrome-bottom',
      '.ytp-progress-bar-container',
      '.ytp-progress-bar',
      // Ad progress
      '.ytp-ad-progress-list',
      '.ytp-play-progress',
      '.ytp-ad-persistent-progress-bar-container',
      // Ad timer / badge / countdown
      '.ytp-ad-duration-remaining',
      '.ytp-ad-simple-ad-badge',
      '.ytp-ad-preview-container',
      '.ytp-ad-preview-text',
      '.ytp-ad-text',
      '.ytp-ad-badge-text',
      '.ytp-ad-badge',
      '.ytp-ad-player-overlay-instream-info',
      '.ytp-ad-skip-button-container',
      '.ytp-ad-player-overlay-skip-or-preview',
      '.ytp-ad-player-overlay-layout',
      '.ytp-ad-hover-text-container',
      '.ytp-ad-info-dialog-container',
      '.ytp-ad-action-interstitial',
      '.ytp-ad-overlay-slot',
      // Ad overlay
      '.ytp-ad-player-overlay',
      '.ytp-ad-text-overlay',
      '.ytp-ad-image-overlay',
      '.ytp-ad-overlay-container',
      '.ytp-ad-message-container',
      '.ytp-ad-visit-advertiser-button',
      '.ytp-ad-feedback-dialog-container',
      '.video-ads.ytp-ad-module',
      '.ytp-ad-module',
    ];
    for (const sel of adUiSelectors) {
      try {
        player.querySelectorAll(sel).forEach(el => {
          el.style.setProperty('display', 'none', 'important');
          el.style.setProperty('opacity', '0', 'important');
          el.style.setProperty('visibility', 'hidden', 'important');
          el.style.setProperty('pointer-events', 'none', 'important');
          el.style.setProperty('height', '0', 'important');
          el.style.setProperty('overflow', 'hidden', 'important');
        });
      } catch { /* ignore */ }
    }
    // Also search in document root (some elements are outside the player)
    try {
      document.querySelectorAll('.ytp-ad-module, .video-ads, .ytp-ad-overlay-container').forEach(el => {
        el.style.setProperty('display', 'none', 'important');
      });
    } catch { /* ignore */ }
  }

  // Restore ad UI elements visibility after ad ends
  function restoreAdUiElements(player) {
    if (!player) return;
    // Only restore the controls bar — other ad elements should stay hidden
    const controls = player.querySelector('.ytp-chrome-bottom');
    if (controls) {
      controls.style.removeProperty('display');
      controls.style.removeProperty('opacity');
      controls.style.removeProperty('visibility');
      controls.style.removeProperty('pointer-events');
      controls.style.removeProperty('height');
      controls.style.removeProperty('overflow');
    }
    const progressBar = player.querySelector('.ytp-progress-bar-container');
    if (progressBar) {
      progressBar.style.removeProperty('display');
      progressBar.style.removeProperty('opacity');
      progressBar.style.removeProperty('visibility');
      progressBar.style.removeProperty('pointer-events');
      progressBar.style.removeProperty('height');
      progressBar.style.removeProperty('overflow');
    }
    const progressBarInner = player.querySelector('.ytp-progress-bar');
    if (progressBarInner) {
      progressBarInner.style.removeProperty('display');
      progressBarInner.style.removeProperty('opacity');
      progressBarInner.style.removeProperty('visibility');
      progressBarInner.style.removeProperty('pointer-events');
      progressBarInner.style.removeProperty('height');
      progressBarInner.style.removeProperty('overflow');
    }
  }

  // ── Core skip logic — called whenever an ad is detected ────────
  function skipAd() {
    if (!enabled) return;

    const player = document.querySelector('.html5-video-player');
    if (!player) return;

    const isAdPlaying = detectAdPlaying(player);
    if (!isAdPlaying) {
      if (_adActive) {
        _adActive = false;
        _adReported = false;
        restoreAfterAd(player);
      }
      return;
    }

    const video = player.querySelector('video');
    if (!video) return;

    _adActive = true;

    // 1. Hide all ad UI (timer, yellow bar, badges) via JS
    hideAdUiElements(player);

    // 2. Mute the ad immediately (no overlay — avoids black screen)
    if (!_adMuted && !video.muted) {
      _savedVolume = video.volume;
      video.volume = 0;
      video.muted = true;
      _adMuted = true;
    }

    // 3. Click any available skip button (fastest path)
    const skipped = clickSkipButton(player);

    // 4. If no skip button, force the ad to end via multiple strategies
    if (!skipped) {
      forceSkipAd(video);
    }

    // 5. Report the skipped ad to background for stats (only once per ad)
    if (!_adReported && extValid()) {
      _adReported = true;
      chrome.runtime.sendMessage({ type: 'AD_SKIPPED', domain: location.hostname }).catch(() => {});
    }

    // 6. Start recovery watchdog
    startBlackScreenWatchdog(player, video);
  }

  function clickSkipButton(player) {
    const selectors = [
      // Classic skip buttons
      '.ytp-skip-ad-button',
      '.ytp-ad-skip-button',
      '.ytp-ad-skip-button-modern',
      'button.ytp-ad-skip-button-text',
      '.ytp-ad-skip-button-container button',
      '.ytp-ad-skip-button-slot button',
      '.ytp-ad-skip-button-icon-container',
      // 2025+ skip button variants
      '.ytp-skip-ad-button__text',
      'button[class*="skip"][class*="ad"]',
      'button.ytp-ad-skip-button-modern',
      '.ytp-ad-skip-button-modern .ytp-ad-skip-button-container',
      // ID-based skip buttons
      '[id^="skip-button"] button',
      '#skip-button\\:4 button',
      '#skip-button\\:5 button',
      '#skip-button\\:6 button',
      '#skip-button\\:7 button',
      '#skip-button\\:8 button',
      // Text-based matching (skip ad in multiple languages)
      'button[data-button-action="skip"]',
      // Survey/dismiss buttons
      '.ytp-ad-survey-answer-button',
      '.ytp-ad-feedback-dialog-container button',
      // Overlay close buttons
      '.ytp-ad-overlay-close-button',
      '.ytp-ad-overlay-close-container',
    ];
    for (const sel of selectors) {
      try {
        const btn = player.querySelector(sel) || document.querySelector(sel);
        if (btn && (btn.offsetParent !== null || btn.offsetWidth > 0)) {
          btn.click();
          // Also dispatch pointer events for YouTube's event handlers
          btn.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
          return true;
        }
      } catch { /* invalid selector */ }
    }
    // Fallback: find any visible button with "skip" text
    try {
      const allBtns = player.querySelectorAll('button, [role="button"]');
      for (const btn of allBtns) {
        const text = (btn.textContent || btn.innerText || '').toLowerCase();
        if ((text.includes('skip') || text.includes('bỏ qua')) &&
            btn.offsetParent !== null) {
          btn.click();
          btn.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
          return true;
        }
      }
    } catch { /* ignore */ }
    return false;
  }

  // ── Multi-strategy ad force-skip ───────────────────────────────
  // YouTube may block playbackRate or currentTime changes on ads.
  // We try multiple approaches and keep retrying.
  function forceSkipAd(video) {
    // Prevent duplicate intervals
    if (_forceSkipInterval) {
      clearInterval(_forceSkipInterval);
      _forceSkipInterval = null;
    }
    const d = video.duration;
    // Strategy 1: seek to end + max speed
    if (d && isFinite(d) && d > 0.1 && d < 300) {
      try { video.playbackRate = 16; } catch { /* blocked */ }
      try { video.currentTime = d - 0.1; } catch { /* blocked */ }
    } else {
      // Duration not available yet — set max speed
      try { video.playbackRate = 16; } catch { /* blocked */ }
    }

    // Strategy 2: keep retrying seek in a tight loop
    // YouTube sometimes resets currentTime; this fights back
    let seekAttempts = 0;
    _forceSkipInterval = setInterval(() => {
      seekAttempts++;
      if (seekAttempts > 20) { clearInterval(_forceSkipInterval); _forceSkipInterval = null; return; }

      const player = document.querySelector('.html5-video-player');
      const isStillAd = player?.classList.contains('ad-showing') ||
                        player?.classList.contains('ad-interrupting');
      if (!isStillAd) { clearInterval(_forceSkipInterval); _forceSkipInterval = null; return; }

      // Try click skip button each iteration too
      if (player && clickSkipButton(player)) {
        clearInterval(_forceSkipInterval);
        _forceSkipInterval = null;
        return;
      }

      const dur = video.duration;
      if (dur && isFinite(dur) && dur > 0.1 && dur < 300) {
        try { video.currentTime = dur - 0.1; } catch { /* blocked */ }
        try { video.playbackRate = 16; } catch { /* blocked */ }
      }
    }, 200);
  }

  // ── Detect ad playing via multiple signals ─────────────────────
  function detectAdPlaying(player) {
    if (!player) return false;
    // Only use class-based detection — other signals cause false positives
    // which trigger play() and prevent user from pausing
    if (player.classList.contains('ad-showing') ||
        player.classList.contains('ad-interrupting')) return true;
    return false;
  }

  // ── Restore video state after ad finishes ──────────────────────
  function restoreAfterAd(player) {
    // Re-acquire player and video in case YouTube replaced them
    player = document.querySelector('.html5-video-player') || player;
    const video = player?.querySelector('video');
    if (!video) return;

    // Remove the overlay
    removeSkipOverlay(player);

    // Restore controls bar visibility (hidden during ad)
    restoreAdUiElements(player);

    // Restore volume and unmute
    if (_adMuted) {
      video.muted = false;
      video.volume = _savedVolume || 1;
      _adMuted = false;
    }

    // Restore playback rate
    if (video.playbackRate !== (_savedPlaybackRate || 1)) {
      video.playbackRate = _savedPlaybackRate || 1;
    }

    clearBlackScreenWatchdog();

    // Resume playback once after ad — use a flag so it only happens once
    _justRestoredFromAd = true;
    const resumeVideo = player?.querySelector('video');
    if (resumeVideo && resumeVideo.paused && !resumeVideo.ended) {
      resumeVideo.play().catch(() => {});
    }
    // Clear the flag after a short delay so polling doesn't keep calling play
    setTimeout(() => { _justRestoredFromAd = false; }, 1000);
  }

  // ── Black screen recovery ──────────────────────────────────────
  // Aggressively monitors the post-ad transition to resume playback
  // as fast as possible. Checks every 100ms.
  function startBlackScreenWatchdog(player, video) {
    clearBlackScreenWatchdog();
    let checks = 0;
    _blackScreenTimer = setInterval(() => {
      checks++;

      // Re-acquire player + video in case YouTube replaced them
      const currentPlayer = document.querySelector('.html5-video-player') || player;
      const currentVideo = currentPlayer.querySelector('video') || video;

      const stillAd = currentPlayer.classList.contains('ad-showing') ||
                       currentPlayer.classList.contains('ad-interrupting') ||
                       detectAdPlaying(currentPlayer);
      if (stillAd) {
        // Still in ad — keep trying to skip
        clickSkipButton(currentPlayer);
        // Keep hiding ad UI (YouTube may re-render elements)
        hideAdUiElements(currentPlayer);
        // Only speed up if the video element is still the ad video,
        // not the main content that may have loaded underneath.
        const d = currentVideo.duration;
        if (d && isFinite(d) && d > 0.1 && d < 300) {
          // Ad videos are typically <5min. Only speed up short videos
          // to avoid accidentally fast-forwarding the main content.
          currentVideo.playbackRate = 16;
          currentVideo.currentTime = d - 0.1;
        }
        // Safety: force-restore after 8s even if ad-showing persists
        // (increased from 3s — mid-roll ads sometimes take longer)
        if (checks > 80) {
          _adActive = false;
          _adReported = false;
          restoreAfterAd(currentPlayer);
        }
        return;
      }

      // Ad done — restore immediately, don't wait for time-advancing check.
      // The overlay must be removed as soon as ad-showing is gone.
      _adActive = false;
      _adReported = false;
      restoreAfterAd(currentPlayer);
    }, 100);
  }

  function clearBlackScreenWatchdog() {
    if (_blackScreenTimer) {
      clearInterval(_blackScreenTimer);
      _blackScreenTimer = null;
    }
  }

  // ── Video src observer for early ad detection ──────────────────
  // Watches for video.src changes — when YouTube swaps to an ad video
  // URL, we can react before the ad-showing class is even set.
  function startVideoSrcObserver() {
    if (_videoSrcObserver) return;

    function attach() {
      const video = document.querySelector('.html5-video-player video');
      if (!video) {
        setTimeout(attach, 500);
        return;
      }

      // Remember the current (main) video src
      if (video.src && !isAdVideoUrl(video.src)) {
        _lastMainVideoSrc = video.src;
      }

      _videoSrcObserver = new MutationObserver(() => {
        if (!enabled) return;
        const src = video.src || video.currentSrc;
        if (src && !isAdVideoUrl(src) && src !== _lastMainVideoSrc) {
          _lastMainVideoSrc = src;
        }
        // Don't preemptively call skipAd() from src observer — it causes
        // false positives that set playbackRate=16 on normal videos.
        // The class observer and polling will catch actual ads reliably.
      });
      _videoSrcObserver.observe(video, { attributes: true, attributeFilter: ['src'] });

      // Also listen for 'loadstart' which fires when a new source starts loading
      video.addEventListener('loadstart', () => {
        if (!enabled) return;
        const src = video.src || video.currentSrc;
        if (src && !isAdVideoUrl(src)) {
          _lastMainVideoSrc = src;
        }
      });

      // Safety: whenever the video fires 'playing', ensure playback rate is normal
      // unless an ad is actively being skipped. This catches any race conditions.
      video.addEventListener('playing', () => {
        const p = document.querySelector('.html5-video-player');
        const isAd = p?.classList.contains('ad-showing') || p?.classList.contains('ad-interrupting');
        if (!isAd && video.playbackRate > 4) {
          video.playbackRate = _savedPlaybackRate || 1;
        }
      });
    }

    attach();
  }

  // ── MutationObserver on the player for instant detection ───────
  function startObserver() {
    if (ytAdObserver) return;

    function attachObserver() {
      const player = document.querySelector('.html5-video-player');
      if (!player) {
        setTimeout(attachObserver, 300);
        return;
      }

      // Save normal playback rate
      const video = player.querySelector('video');
      if (video) _savedPlaybackRate = video.playbackRate || 1;

      // Observe class changes on the player (ad-showing is toggled here)
      ytAdObserver = new MutationObserver((mutations) => {
        if (!enabled) return;
        for (const mut of mutations) {
          if (mut.type === 'attributes' && mut.attributeName === 'class') {
            const isAd = detectAdPlaying(player);
            if (isAd) {
              skipAd();
            } else if (_adActive) {
              _adActive = false;
              _adReported = false;
              restoreAfterAd(player);
            }
          }
        }
      });
      ytAdObserver.observe(player, { attributes: true, attributeFilter: ['class'] });

      // Also observe for new ad containers being added to DOM
      const adContainerObserver = new MutationObserver((mutations) => {
        if (!enabled) return;
        for (const mut of mutations) {
          for (const node of mut.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            if (node.classList?.contains('ytp-ad-module') ||
                node.classList?.contains('ad-showing') ||
                node.querySelector?.('.ytp-ad-player-overlay')) {
              skipAd();
            }
          }
        }
      });
      adContainerObserver.observe(player, { childList: true, subtree: true });

      // Immediate check in case ad is already playing
      if (player.classList.contains('ad-showing') ||
          player.classList.contains('ad-interrupting')) {
        skipAd();
      }
    }

    attachObserver();
  }

  // ── Fallback polling (catches edge cases) ──────────────────────
  function startPolling() {
    if (ytAdInterval) return;
    ytAdInterval = setInterval(() => {
      if (!enabled) return;
      const player = document.querySelector('.html5-video-player');
      if (!player) return;
      const isAd = detectAdPlaying(player);
      if (isAd) {
        skipAd();
      } else if (_adActive || _adMuted) {
        // Safety net: only fix stuck states, never call play()
        const video = player.querySelector('video');
        removeSkipOverlay(player);
        if (video) {
          if (video.playbackRate > 4) {
            video.playbackRate = _savedPlaybackRate || 1;
          }
          if (_adMuted) {
            video.muted = false;
            video.volume = _savedVolume || 1;
            _adMuted = false;
          }
        }
        _adActive = false;
      }
    }, 500);
  }

  // ── Start / stop ──────────────────────────────────────────────
  function startSkipper() {
    injectYtAdCss();
    startObserver();
    startVideoSrcObserver();
    startPolling();
  }

  function stopSkipper() {
    if (ytAdObserver) {
      ytAdObserver.disconnect();
      ytAdObserver = null;
    }
    if (_videoSrcObserver) {
      _videoSrcObserver.disconnect();
      _videoSrcObserver = null;
    }
    if (ytAdInterval) {
      clearInterval(ytAdInterval);
      ytAdInterval = null;
    }
    if (_forceSkipInterval) {
      clearInterval(_forceSkipInterval);
      _forceSkipInterval = null;
    }
    clearBlackScreenWatchdog();
    // Clean up overlay if any
    const player = document.querySelector('.html5-video-player');
    if (player) removeSkipOverlay(player);
  }

  // Start/stop based on enabled state
  if (extValid()) {
    try {
      chrome.storage.local.get(['enabled', 'pausedDomains'], (result) => {
        try {
          if (chrome.runtime.lastError || !result) return;
          const { enabled: e = true, pausedDomains = [] } = result;
          if (e && !pausedDomains.includes(location.hostname)) {
            startSkipper();
          }
        } catch { /* extension context invalidated */ }
      });
    } catch { /* extension context invalidated */ }
  }

  // Listen for toggle/pause to start/stop skipper
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'TOGGLE') {
      msg.enabled ? startSkipper() : stopSkipper();
    }
    if (msg.type === 'PAUSE_DOMAIN') {
      msg.paused ? stopSkipper() : startSkipper();
    }
  });
})();
