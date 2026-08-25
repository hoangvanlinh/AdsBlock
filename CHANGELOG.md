# Changelog

## 1.0.42

- Internal: consolidated the `chrome.*`/`browser.*` namespace handling that background.js and the content-script fast-path cache each duplicated into one shared module.
- Internal: reorganized the project layout — shared runtime modules moved into `shared/`, Node test suites into `test/`, build/diagnostic tooling into `tools/` — no behavior change for users.

## 1.0.25

- Fixed a YouTube ad-tracking gap: in-player ads (playerAds) weren't being pruned from network responses, only adPlacements/adSlots were.
- Fixed set_constant so multiple rules sharing the same parent object (e.g. several ytInitialPlayerResponse.* fields) all lock correctly — previously only the last-registered rule actually took effect, letting the others leak real ad data through.
- Cleaned up a redundant YouTube dialog-hiding selector no longer needed after the fix above.
- Reduced the extension's own footprint against anti-adblock detection scripts — internal signal names and injection tokens are now randomized per browser session instead of fixed, hardcoded values.
- Fixed a "please allow ads" nag dialog on tinhte.vn, including a page-scroll-lock bug the dialog left behind after being hidden.
- Blocked additional YouTube tracking requests and stripped tracking query parameters from YouTube links.
- Added internal scriptlet capabilities for more precise ad-script neutralization on complex pages.
- Fixed debug/unobfuscated development builds producing minified-looking output instead of properly readable code.
- Reduced CPU usage on pages using shadow DOM by caching ad-candidate lookups instead of rescanning the page on every check.

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
