// Inert stand-in for Google Publisher Tag (gpt.js — window.googletag),
// reference: https://developers.google.com/doubleclick-gpt/reference
//
// Pages queue setup calls in window.googletag.cmd before the real script
// loads, then call into services/slots returned by it. This stub gives
// every one of those calls somewhere safe to land (all no-ops returning
// harmless chainable/empty values) instead of throwing, and immediately
// drains + replaces the cmd queue so already-queued calls still run.
(function () {
  'use strict';

  const noop = function () {};
  const returnsSelf = function () { return this; };
  const returnsNull = function () { return null; };
  const returnsEmptyArray = function () { return []; };
  const returnsEmptyString = function () { return ''; };

  const companionAdsService = {
    addEventListener: returnsSelf,
    enableSyncLoading: noop,
    setRefreshUnfilledSlots: noop,
  };

  const contentService = {
    addEventListener: returnsSelf,
    setContent: noop,
  };

  function PassbackSlot() {}
  Object.assign(PassbackSlot.prototype, {
    display: noop,
    get: returnsNull,
    set: returnsSelf,
    setClickUrl: returnsSelf,
    setTagForChildDirectedTreatment: returnsSelf,
    setTargeting: returnsSelf,
    updateTargetingFromMap: returnsSelf,
  });

  const pubAdsService = {
    addEventListener: returnsSelf,
    clear: noop,
    clearCategoryExclusions: returnsSelf,
    clearTagForChildDirectedTreatment: returnsSelf,
    clearTargeting: returnsSelf,
    collapseEmptyDivs: noop,
    defineOutOfPagePassback: function () { return new PassbackSlot(); },
    definePassback: function () { return new PassbackSlot(); },
    disableInitialLoad: noop,
    display: noop,
    enableAsyncRendering: noop,
    enableLazyLoad: noop,
    enableSingleRequest: noop,
    enableSyncRendering: noop,
    enableVideoAds: noop,
    get: returnsNull,
    getAttributeKeys: returnsEmptyArray,
    getTargeting: returnsEmptyArray,
    getTargetingKeys: returnsEmptyArray,
    getSlots: returnsEmptyArray,
    refresh: noop,
    removeEventListener: noop,
    set: returnsSelf,
    setCategoryExclusion: returnsSelf,
    setCentering: noop,
    setCookieOptions: returnsSelf,
    setForceSafeFrame: returnsSelf,
    setLocation: returnsSelf,
    setPublisherProvidedId: returnsSelf,
    setPrivacySettings: returnsSelf,
    setRequestNonPersonalizedAds: returnsSelf,
    setSafeFrameConfig: returnsSelf,
    setTagForChildDirectedTreatment: returnsSelf,
    setTargeting: returnsSelf,
    setVideoContent: returnsSelf,
    updateCorrelator: noop,
  };

  function SizeMappingBuilder() {}
  Object.assign(SizeMappingBuilder.prototype, {
    addSize: returnsSelf,
    build: returnsNull,
  });

  function Slot() {}
  Object.assign(Slot.prototype, {
    addService: returnsSelf,
    clearCategoryExclusions: returnsSelf,
    clearTargeting: returnsSelf,
    defineSizeMapping: returnsSelf,
    get: returnsNull,
    getAdUnitPath: returnsEmptyArray,
    getAttributeKeys: returnsEmptyArray,
    getCategoryExclusions: returnsEmptyArray,
    getDomId: returnsEmptyString,
    getResponseInformation: returnsNull,
    getSlotElementId: returnsEmptyString,
    getSlotId: returnsSelf,
    getTargeting: returnsEmptyArray,
    getTargetingKeys: returnsEmptyArray,
    set: returnsSelf,
    setCategoryExclusion: returnsSelf,
    setClickUrl: returnsSelf,
    setCollapseEmptyDiv: returnsSelf,
    setTargeting: returnsSelf,
    updateTargetingFromMap: returnsSelf,
  });

  const existing = window.googletag || {};
  const pendingCmds = existing.cmd || [];

  const googletag = existing;
  googletag.apiReady = true;
  googletag.pubadsReady = true;
  googletag.cmd = [];
  googletag.cmd.push = function (fn) {
    try { fn(); } catch (e) { /* a queued setup call may reference things we don't stub */ }
    return 1;
  };
  googletag.companionAds = function () { return companionAdsService; };
  googletag.content = function () { return contentService; };
  googletag.defineOutOfPageSlot = function () { return new Slot(); };
  googletag.defineSlot = function () { return new Slot(); };
  googletag.destroySlots = noop;
  googletag.disablePublisherConsole = noop;
  googletag.display = noop;
  googletag.enableServices = noop;
  googletag.getVersion = returnsEmptyString;
  googletag.pubads = function () { return pubAdsService; };
  googletag.setAdIframeTitle = noop;
  googletag.sizeMapping = function () { return new SizeMappingBuilder(); };

  window.googletag = googletag;
  while (pendingCmds.length !== 0) {
    googletag.cmd.push(pendingCmds.shift());
  }
})();
