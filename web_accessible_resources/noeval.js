// Redirect target for scripts that call the page's own eval() to run
// dynamically-fetched code (a common way ad/anti-adblock loaders smuggle in
// logic that a static filter can't otherwise see). Replacing window.eval
// with something that throws stops that code path outright while leaving
// every other call site — including new Function(), which the real V8/
// SpiderMonkey eval restriction doesn't touch — untouched.
(function () {
  'use strict';
  window.eval = function () {
    throw new Error('eval blocked');
  };
})();
