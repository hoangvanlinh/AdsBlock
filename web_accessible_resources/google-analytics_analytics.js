// Inert stand-in for Google Analytics' classic analytics.js (analytics.js /
// Universal Analytics API — https://developers.google.com/analytics/devguides/collection/analyticsjs/).
//
// Page code typically calls the global tracker function (window.ga by
// default, or whatever window.GoogleAnalyticsObject renamed it to) either
// directly with a trailing hitCallback, or via ga('send', ..., {hitCallback})
// — either way, that callback has to fire or pages waiting on it (e.g.
// before following a link) would hang. `Tracker` is a minimal stand-in for
// the tracker object create()/getByName()/getAll() are expected to return.
(function () {
  'use strict';

  function Tracker() {}
  Tracker.prototype.get = function () {};
  Tracker.prototype.set = function () {};
  Tracker.prototype.send = function () {};

  function findHitCallback(args) {
    if (args.length === 0) return null;
    const last = args[args.length - 1];
    if (last instanceof Object && last.hitCallback instanceof Function) {
      return last.hitCallback;
    }
    if (last instanceof Function) {
      return function () { last(tracker.create()); };
    }
    const idx = args.indexOf('hitCallback');
    if (idx !== -1 && args[idx + 1] instanceof Function) {
      return args[idx + 1];
    }
    return null;
  }

  const tracker = function (...args) {
    const cb = findHitCallback(args);
    if (!cb) return;
    try { cb(); } catch (e) { /* mirror real GA: swallow tracker callback errors */ }
  };
  tracker.create = function () { return new Tracker(); };
  tracker.getByName = function () { return new Tracker(); };
  tracker.getAll = function () { return [new Tracker()]; };
  tracker.remove = function () {};
  tracker.loaded = true;

  const globalName = window.GoogleAnalyticsObject || 'ga';
  const previousQueue = window[globalName];
  window[globalName] = tracker;

  // dataLayer interop: GA-via-GTM setups often gate visible content behind
  // dataLayer.hide until analytics.js loads, and expect any already-pushed
  // item's eventCallback to eventually fire.
  const dataLayer = window.dataLayer;
  if (dataLayer instanceof Object) {
    if (dataLayer.hide instanceof Object && typeof dataLayer.hide.end === 'function') {
      dataLayer.hide.end();
      dataLayer.hide.end = function () {};
    }
    if (typeof dataLayer.push === 'function') {
      const runCallback = function (item) {
        if (!(item instanceof Object) || typeof item.eventCallback !== 'function') return;
        setTimeout(item.eventCallback, 1);
        item.eventCallback = function () {};
      };
      dataLayer.push = new Proxy(dataLayer.push, {
        apply: function (target, thisArg, callArgs) {
          runCallback(callArgs[0]);
          return Reflect.apply(target, thisArg, callArgs);
        },
      });
      if (Array.isArray(dataLayer)) {
        for (const item of dataLayer.slice()) runCallback(item);
      }
    }
  }

  // Flush anything queued on the stub GA snippet before this script ran
  // (the real snippet stores queued calls on `.q`).
  if (previousQueue instanceof Function && Array.isArray(previousQueue.q)) {
    for (const entry of previousQueue.q.splice(0)) tracker(...entry);
  }
})();
