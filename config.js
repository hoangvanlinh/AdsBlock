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
  // Debug builds (./build.sh <target> <obf> <export> true) flip this to true:
  // every context (background DNR rules + content rule loader) then reads the
  // bundled rule/site-rules.txt instead of cache/remote, so local rule edits
  // take effect on extension reload without pushing to GitHub.
  DEBUG_LOCAL: false,
};
