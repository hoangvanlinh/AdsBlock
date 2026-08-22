// Redirect target for the real popads.net loader script. Sites monetizing
// through PopAds commonly run a companion detector that checks whether
// window.PopAds/window.popns ended up defined after the loader "ran" — if
// not, they assume an adblocker stripped the script and show a nag. Simply
// defining both as present (without ever registering a popunder) satisfies
// that check while never actually opening anything.
(function () {
  'use strict';
  window.PopAds = { init: true, register: function () {} };
  window.popns = window.popns || {};
})();
