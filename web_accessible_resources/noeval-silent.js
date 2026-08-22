// Same intent as noeval.js — replace the page's window.eval so smuggled-in
// dynamic code never runs — but returns undefined instead of throwing, for
// callers that catch a thrown eval() and retry/escalate on the error rather
// than just skip whatever depended on the result.
(function () {
  'use strict';
  window.eval = function () {};
})();
