// Inert stand-in for Google AdSense's adsbygoogle.js.
//
// Pages using AdSense create `<ins class="adsbygoogle">` placeholders and
// then either call `(adsbygoogle = window.adsbygoogle || []).push({})` or
// expect the real script to find and fill those placeholders on its own.
// This stub does both: exposes a queue-shaped `window.adsbygoogle`, and
// fills every not-yet-processed placeholder with a blank iframe + the
// status attributes AdSense's own script would set, so page layout code
// waiting on "ad filled" signals doesn't stall. A short-lived
// MutationObserver catches placeholders that render after this script runs
// (lazy-loaded ad slots), then disconnects once the page has settled.
(function () {
  'use strict';

  window.adsbygoogle = window.adsbygoogle || {
    loaded: true,
    push: function () {},
  };

  let nextAdId = 1;

  function fillPlaceholder(el) {
    const frame = document.createElement('iframe');
    frame.id = 'aswift_' + nextAdId;
    frame.setAttribute('name', frame.id);
    nextAdId += 1;
    el.dataset.adsbygoogleStatus = 'loading';
    el.dataset.adStatus = 'loading';
    el.appendChild(frame);
    frame.addEventListener('load', function () {
      el.dataset.adsbygoogleStatus = 'done';
      el.dataset.adStatus = 'filled';
      frame.dataset.loadComplete = 'true';
    }, { once: true });
    frame.src = 'about:blank';
  }

  function fillPendingPlaceholders() {
    document.querySelectorAll('.adsbygoogle:not([data-ad-status][data-adsbygoogle-status])')
      .forEach(fillPlaceholder);
  }

  fillPendingPlaceholders();

  let pendingFrame = null;
  let watcher = new MutationObserver(function () {
    if (pendingFrame !== null) return;
    pendingFrame = requestAnimationFrame(function () {
      pendingFrame = null;
      fillPendingPlaceholders();
    });
  });
  watcher.observe(document, {
    attributes: true,
    attributeFilter: ['class'],
    childList: true,
    subtree: true,
  });

  // Ad slots are almost always in place well before this — stop watching
  // once the page has had time to settle, rather than for its whole life.
  setTimeout(function () {
    watcher.disconnect();
    watcher = null;
  }, 20000);
})();
