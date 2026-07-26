// Inert stand-in for Amazon Publisher Services' bidding tag (apstag.js).
//
// Real apstag.js queues calls made before it's fully loaded into
// window.apstag._Q as [prefix, args] pairs, then drains that queue once it
// installs its own push(). We replicate just enough of that contract so
// page code calling apstag.fetchBids(config, callback) — before or after
// this stub runs — still gets its callback invoked with an empty bid list,
// instead of throwing "apstag.fetchBids is not a function".
(function () {
  'use strict';
  const noop = function () {};
  const queue = (window.apstag && window.apstag._Q) || [];

  const api = {
    _Q: queue,
    fetchBids: function (_config, callback) {
      if (typeof callback === 'function') callback([]);
    },
    init: noop,
    setDisplayBids: noop,
    targetingKeys: noop,
  };

  function dispatch(entry) {
    if (!Array.isArray(entry)) return;
    const [prefix, args] = entry;
    try {
      if (prefix === 'f') api.fetchBids.apply(null, args);
    } catch (e) { /* malformed queued call — ignore */ }
  }

  const pending = queue.splice(0);
  queue.push = dispatch;
  window.apstag = api;
  for (const entry of pending) dispatch(entry);
})();
