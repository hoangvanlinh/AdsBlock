// config.js — shared constants, single source of truth for every context.
// How each context loads this file:
//   - Chrome service worker : importScripts('config.js') at the top of background.js
//   - Firefox background    : listed before background.js in background.scripts
//   - Content scripts       : listed first in the content_scripts js array
//   - Dashboard page        : <script src="../config.js"> before dashboard.js
// `self` works in all of them (worker, window, isolated world).
self.ADBLOCK_CONFIG = {
  RULES_REMOTE_URL: 'https://raw.githubusercontent.com/hoangvanlinh/AdsBlock/refs/heads/main/rule/site-rules.txt',
  RULES_LOCAL_PATH: 'rule/site-rules.txt',
  RULES_CACHE_TEXT_KEY: 'siteRulesCacheText',
  RULES_CACHE_TIME_KEY: 'siteRulesCacheTime',
  RULES_CACHE_TTL_MS: 6 * 60 * 60 * 1000,
  // Same GitHub repo rule/site-rules.txt is already trusted from — reusing
  // it for a version check means one canonical source, not a second thing
  // to remember to update on release. Deliberately NOT the user-configurable
  // extra rule-source URLs (dashboard's Rule Source page) — this must stay
  // pinned to the real repo regardless of what rule sources a user adds.
  // Two separate manifests, two separate version numbers that CAN and DO
  // drift out of sync (Chrome/Firefox/Edge stores review and publish on
  // their own schedules) — Edge reuses the Chrome manifest (see
  // build-edge.sh's own comment), Firefox does not. Picking the wrong one
  // would compare a Firefox install's version against Chrome's release
  // cadence, showing a false "update available" or missing a real one.
  EXTENSION_META_REMOTE_URL: 'https://raw.githubusercontent.com/hoangvanlinh/AdsBlock/refs/heads/main/manifest.json',
  EXTENSION_META_REMOTE_URL_FIREFOX: 'https://raw.githubusercontent.com/hoangvanlinh/AdsBlock/refs/heads/main/manifest.firefox.json',
  // Single source for every "take the user to our store listing" link —
  // used by both the popup's review-prompt banner and its update-available
  // chip, and the dashboard's update-available link, so they can never
  // drift out of sync with each other the way REVIEW_STORE_URLS (popup.js)
  // and UPDATE_STORE_URLS (dashboard.js) used to (same store, two
  // independently-hand-maintained URL literals, chrome+firefox happened to
  // point at the /reviews subpage but edge didn't — an easy-to-miss
  // inconsistency with two copies, impossible with one).
  STORE_URLS: {
    firefox: 'https://addons.mozilla.org/firefox/addon/adblock-ads-trackers',
    edge:    'https://microsoftedge.microsoft.com/addons/detail/pbhhhdiineoaofllgkipegloafcpiaml',
    chrome:  'https://chromewebstore.google.com/detail/adblock-%E2%80%94-ads-trackers/emdofgiggmkkncojffpebiaegdmdkgio',
  },
  // Debug builds (./build.sh <target> <obf> <export> true) flip this to true:
  // every context (background DNR rules + content rule loader) then reads the
  // bundled rule/site-rules.txt instead of cache/remote, so local rule edits
  // take effect on extension reload without pushing to GitHub.
  DEBUG_LOCAL: false,
};
