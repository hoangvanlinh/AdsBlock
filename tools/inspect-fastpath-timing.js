// inspect-fastpath-timing.js — diagnostic script, NOT run via Node.
//
// Checks whether chrome.storage.session's setAccessLevel actually granted
// content scripts access (the untrusted-context grant background.js makes
// at startup), and measures REAL round-trip timing for the two fast-path
// caches (directCssFastPath, scriptletRulesFastPath) on THIS device — built
// to debug a report of Firefox Android seemingly painting the page before
// the fast-path CSS lands.
//
// How to run — TWO separate checks, in TWO different console contexts:
//
//   A) Background context (proves setAccessLevel itself succeeded):
//      Firefox desktop: about:debugging#/runtime/this-firefox → find the
//      extension → "Inspect" → paste into that Console.
//      Firefox Android: connect the phone via USB, enable USB debugging on
//      the phone, then on a DESKTOP Firefox go to
//      about:debugging#/runtime/<your-device-id> → find the extension under
//      "Extensions" → "Inspect" → paste into that Console.
//      Chrome: chrome://extensions → Developer mode → "service worker".
//
//   B) Content-script (untrusted) context — the one that actually matters,
//      since this is what site-block.js itself runs as:
//      Open any real site with ads, open DevTools on THAT PAGE, and in the
//      Console panel's context/target dropdown (top-left, usually says
//      "Top" by default) switch to this extension's content script context
//      (Firefox and Chrome both list injected content scripts there when
//      one is active on the page). Paste into THAT context, not "Top" —
//      pasting into "Top" runs as the PAGE's own script, which never had
//      chrome.* injected at all and will just report "chrome is undefined",
//      telling you nothing about whether the grant worked.
//
// The script auto-detects which context it's in and runs the relevant
// checks. Read-only except one thing: section 2 in the content-script
// context does ONE real get() against the actual live cache keys (same
// calls site-block.js already makes) to measure real timing — no writes.
(function () {
  function fmtMs(ms) { return ms.toFixed(1) + 'ms'; }

  var hasChrome = typeof chrome !== 'undefined' && chrome && chrome.storage;
  console.log('chrome.storage available in this context:', hasChrome);
  if (!hasChrome) {
    console.log('If you pasted this into the PAGE\'s own "Top" console context, that\'s expected — switch the console\'s context/target dropdown to this extension\'s content script instead (see script header).');
    return;
  }

  var hasSession = !!chrome.storage.session;
  console.log('chrome.storage.session exists:', hasSession);
  if (!hasSession) {
    console.log('This browser/version does not expose chrome.storage.session at all (needs Firefox 121+ / Chrome 102+) — the fast-path caches silently no-op here by design (see site-block.js\'s own extValid()/chrome.storage.session guards), explaining slow-feeling CSS with no error anywhere.');
    return;
  }

  // Is this the background (trusted) context, or a content script (untrusted
  // one)? A reasonably reliable signal: background contexts can call
  // chrome.runtime.getBackgroundPage / have no `location` pointing at a real
  // page, but the simplest robust check is just: does a get() succeed at
  // all? TRUSTED_CONTEXTS-only (the default, before any grant) already lets
  // BACKGROUND itself read/write — that's not informative either way. The
  // real test that matters is whether THIS specific call, from THIS
  // specific context, succeeds — so just run it and report pass/fail,
  // regardless of which context you're in.
  var isLikelyContentScript = typeof location !== 'undefined' && location.href && !/^(moz|chrome)-extension:/.test(location.href);
  console.log('Looks like a content-script (page) context:', isLikelyContentScript, isLikelyContentScript ? ('(' + location.hostname + ')') : '');

  console.log('\n=== Testing chrome.storage.session.get() from THIS context ===');
  var t0 = performance.now();
  chrome.storage.session.get(null).then(function (all) {
    var ms = performance.now() - t0;
    console.log('SUCCESS — get() resolved in', fmtMs(ms));
    console.log('All keys currently in chrome.storage.session:', Object.keys(all));

    if (isLikelyContentScript) {
      var host = location.hostname;
      var cssMap = all.directCssFastPath || {};
      var scriptletMap = all.scriptletRulesFastPath || {};
      console.log('\n--- directCssFastPath for THIS host (' + host + ') ---');
      console.log(cssMap[host] ? ('found, cached ' + new Date(cssMap[host].ts).toLocaleTimeString()) : 'no entry for this host yet (first visit, or not written yet)');
      console.log('--- scriptletRulesFastPath for THIS host (' + host + ') ---');
      console.log(scriptletMap[host] ? ('found, cached ' + new Date(scriptletMap[host].ts).toLocaleTimeString()) : 'no entry for this host yet');

      console.log('\nIf get() succeeded above, setAccessLevel DID work in this browser — any remaining "site paints before CSS" feeling is real IPC/device latency (see the ' + fmtMs(ms) + ' above), not a broken grant. Reload this exact page a SECOND time now that an entry exists (if it didn\'t already) and re-run this script — the read should be faster on a warm cache and you can compare against how it feels visually.');
    }
  }).catch(function (e) {
    var ms = performance.now() - t0;
    console.log('FAILED after', fmtMs(ms), '—', e && e.message);
    console.log(isLikelyContentScript
      ? 'This context could NOT read chrome.storage.session — setAccessLevel did not actually grant this content script access. Check the BACKGROUND context (see script header, check A) for a "[AdBlock] chrome.storage.session.setAccessLevel ..." error to see why.'
      : 'Unexpected — even a trusted/background context should always have implicit access. Check chrome.runtime.lastError / this exact error message for what\'s different about this browser\'s implementation.');
  });
})();
