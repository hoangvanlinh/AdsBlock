// Inert stand-in for DoubleClick's instream/ad_status.js. Real script sets
// a single global the page reads to check whether ad-serving infra loaded
// successfully; a hard-blocked (failed) request is exactly the signal a
// bait-load adblock detector watches for, so this makes the request
// "succeed" instead — same idea as google-ima.js in this folder.
(function () {
  'use strict';
  window.google_ad_status = 1;
})();
