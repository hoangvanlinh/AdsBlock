// Inert stand-in for comScore's beacon.js (ScorecardResearch tracking).
//
// Pages call window.COMSCORE.beacon(...) directly after including this
// script, and occasionally purge() to reset the internal queue array.
(function () {
  'use strict';
  window.COMSCORE = {
    beacon: function () {},
    purge: function () { window._comscore = []; },
  };
})();
