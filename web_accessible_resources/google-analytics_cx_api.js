// Inert stand-in for Google Analytics' Content Experiments API (cx/api.js),
// used by pages running an A/B "experiment" to ask which variant to render.
// chooseVariation() has to return a number synchronously — page code
// branches on it immediately — so it always returns 0 (the original/control
// variant), which is the safest default when no real experiment is running.
(function () {
  'use strict';
  window.cxApi = {
    chooseVariation: function () { return 0; },
  };
})();
