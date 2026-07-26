// Inert stand-in for Google Tag Manager's loader (gtm.js).
//
// GTM's real script defines window.ga as a fallback and processes
// window.dataLayer.push() calls. Sites often stall waiting on a
// dataLayer.hide.end() reveal, or on an event's eventCallback firing before
// moving on — both are handled here so the page doesn't hang:
//   - dataLayer.hide.end() is invoked immediately if present.
//   - dataLayer.push is replaced so any pushed object carrying an
//     eventCallback function still gets it called (deferred via setTimeout
//     so it runs after the pushing code finishes, matching real GTM timing).
(function () {
  'use strict';
  window.ga = window.ga || function () {};

  const dataLayer = window.dataLayer;
  if (!(dataLayer instanceof Object)) return;

  if (dataLayer.hide instanceof Object && typeof dataLayer.hide.end === 'function') {
    dataLayer.hide.end();
  }

  if (typeof dataLayer.push === 'function') {
    dataLayer.push = function (pushed) {
      if (pushed instanceof Object && typeof pushed.eventCallback === 'function') {
        setTimeout(pushed.eventCallback, 1);
      }
    };
  }
})();
