// Inert stand-in for Google Analytics' legacy ga.js (Classic/urchin.js-era
// tracker — https://developers.google.com/analytics/devguides/collection/gajs/).
//
// Page code reaches this through the global _gat.GA_Tracker_ constructor
// (via _gat._getTracker/_createTracker) or the pre-loaded _gaq push-queue.
// Both APIs are fire-and-forget — no callback contract like analytics.js —
// so a plain no-op method bag on the tracker plus draining any queued _gaq
// calls (so they don't silently accumulate) is enough.
(function () {
  'use strict';
  const noop = function () {};

  function Tracker() {}
  const trackerMethods = [
    '_getName', '_setName', '_getAccount', '_setAccount', '_trackPageview',
    '_trackEvent', '_trackSocial', '_trackTrans', '_setAllowAnchor',
    '_setAllowHash', '_setAllowLinker', '_setCampaignTrack',
    '_setClientInfo', '_setDomainName', '_setLocalRemoteServerMode',
    '_setSampleRate', '_setSessionCookieTimeout', '_setVisitorCookieTimeout',
    '_link', '_linkByPost', '_addOrganic', '_addIgnoredOrganic',
    '_addIgnoredRef', '_cookiePathCopy', '_deleteCustomVar', '_getVersion',
    '_getVisitorCustomVar', '_setCustomVar', '_setReferrerOverride',
  ];
  for (const name of trackerMethods) Tracker.prototype[name] = noop;

  window._gat = window._gat || {
    _getTracker: function () { return new Tracker(); },
    _createTracker: function () { return new Tracker(); },
    _anonymizeIp: noop,
  };

  const queued = Array.isArray(window._gaq) ? window._gaq.splice(0) : [];
  const gaq = { push: noop };
  window._gaq = gaq;
  void queued;
})();
