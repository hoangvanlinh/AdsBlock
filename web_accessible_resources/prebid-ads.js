// Inert stand-in for Prebid.js (https://docs.prebid.org/dev-docs/getting-started.html),
// a header-bidding wrapper most page integrations only ever touch through
// window.pbjs.que.push(fn) — a queue that either drains once the real
// script loads, or gets read by the loader script itself if it's already
// populated. We drain it the same way, and implement just enough of the
// direct API (addAdUnits/requestBids) that a queued function calling them
// doesn't throw: requestBids immediately invokes bidsBackHandler with an
// empty result, matching "no bids returned" rather than "still pending".
(function () {
  'use strict';
  const noop = function () {};

  const pbjs = {
    adUnits: [],
    addAdUnits: function (units) {
      if (Array.isArray(units)) pbjs.adUnits.push(...units);
      else if (units) pbjs.adUnits.push(units);
    },
    requestBids: function (config) {
      const handler = config && config.bidsBackHandler;
      if (typeof handler === 'function') handler({});
    },
    setConfig: noop,
    setBidderConfig: noop,
    onEvent: noop,
    offEvent: noop,
    getHighestCvpAdUnits: function () { return {}; },
    getAdserverTargeting: function () { return {}; },
    getAdserverTargetingForAdUnitCode: function () { return {}; },
    getBidResponses: function () { return {}; },
    getBidResponsesForAdUnitCode: function () { return {}; },
    initAdserverSet: false,
  };

  const pending = (window.pbjs && Array.isArray(window.pbjs.que)) ? window.pbjs.que.splice(0) : [];
  pbjs.que = { push: function (fn) { if (typeof fn === 'function') fn(); } };
  window.pbjs = pbjs;
  for (const fn of pending) {
    if (typeof fn === 'function') fn();
  }
})();
