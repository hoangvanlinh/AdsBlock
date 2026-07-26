// Inert stand-in for Chartbeat's tracking snippet (chartbeat.js).
//
// Chartbeat's real script briefly injects a <style id="chartbeat-flicker-
// control-...">  to hide page content until it finishes initializing. Since
// this stub never runs the real tracking code, that style has to be
// removed here or the page content it hides would stay hidden forever.
// window.pSUPERFLY is the object pages call into to report page views /
// activity — both methods are safe no-ops.
(function () {
  'use strict';
  window.pSUPERFLY = {
    activity: function () {},
    virtualPage: function () {},
  };
  document.querySelectorAll('style[id^="chartbeat-flicker-control"]').forEach(function (el) {
    el.remove();
  });
})();
