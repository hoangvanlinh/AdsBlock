// Inert stand-in for Outbrain's widget bootstrap script.
//
// Outbrain's real widget exposes a large window.OBR.extern surface that
// page code (and Outbrain's own later-loaded pieces) call into directly.
// The exact method names below come from Outbrain's public integration —
// every one is a safe no-op so callers never hit a "not a function" error.
(function () {
  'use strict';
  const noop = function () {};
  const externMethodNames = [
    'callClick', 'callLoadMore', 'callRecs', 'callUserZapping', 'callWhatIs',
    'cancelRecommendation', 'cancelRecs', 'closeCard', 'closeModal', 'closeTbx',
    'errorInjectionHandler', 'getCountOfRecs', 'getStat', 'imageError',
    'manualVideoClicked', 'onOdbReturn', 'onVideoClick', 'pagerLoad',
    'recClicked', 'refreshSpecificWidget', 'renderSpaWidgets', 'refreshWidget',
    'reloadWidget', 'researchWidget', 'returnedError', 'returnedHtmlData',
    'returnedIrdData', 'returnedJsonData', 'scrollLoad', 'showDescription',
    'showRecInIframe', 'userZappingMessage', 'zappingFormAction',
  ];
  const extern = {
    video: { getVideoRecs: noop, videoClicked: noop },
  };
  for (const name of externMethodNames) extern[name] = noop;
  window.OBR = window.OBR || { extern };
})();
