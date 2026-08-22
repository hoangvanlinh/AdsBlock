// A simpler alternative to popads.js, for rules that just need window.PopAds
// to be truthy (e.g. a page-side `if (!window.PopAds) { ...show nag... }`
// check) without needing the object shaped like the real loader's — no
// register()/init property, just presence.
(function () {
  'use strict';
  window.PopAds = window.PopAds || {};
})();
