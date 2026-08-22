// Inert stand-in for Amazon's amzn_ads.js loader — a separate script from
// apstag.js (see amazon_apstag.js) that some pages load directly to render
// an Amazon native ad slot via window.amzn_ads(config). Real callers treat
// it as fire-and-forget (no return value or callback contract to satisfy),
// so a plain no-op is a complete stand-in.
(function () {
  'use strict';
  window.amzn_ads = function () {};
})();
