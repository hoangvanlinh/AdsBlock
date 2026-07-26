# Changelog

## 1.0.22

- Fixed a timing issue where Facebook's server-rendered sponsored post (the first ad shown on page load or refresh) could still slip through in some cases.

## 1.0.21

- Ads and trackers that get blocked at the network level (Google Analytics, Google Ad Manager/AdSense, Google Tag Manager, Amazon ads, Outbrain, Google IMA, ScorecardResearch, Chartbeat, and more) are now redirected to an inert placeholder instead of being hard-blocked. This avoids tripping anti-adblock scripts that specifically check for failed network requests, while still preventing the ad/tracker script from ever loading for real.

## 1.0.20

- Facebook: fixed sponsored posts leaking through via server-rendered (SSR) data on the very first page load.
- Facebook: added detection for the scrambled/reordered "Sponsored" label FB uses to defeat text matching.
- Fixed scriptlet argument parsing so regex arguments containing commas are no longer split incorrectly.
- Fixed the dashboard's "Reset all data" button to also clear the scriptlet cache in every open tab, not just the active one.
- Changed `unload`/`beforeunload` event handling to respect per-site scriptlet settings.
- Added Taboola "Explore More" backdrop stripping.
- Minor blocking-rule updates.

## 1.0.19 and earlier

See git history.
