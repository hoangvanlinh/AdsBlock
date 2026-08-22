// Inert stand-in for FingerprintJS v3+'s public API
// (https://github.com/fingerprintjs/fingerprintjs) — the rewritten,
// promise-based successor to fingerprint2.js's callback style. Real
// integration code awaits FingerprintJS.load(), then calls .get() on the
// resolved agent to get a { visitorId, components } result. Both promises
// resolve immediately with a fixed, non-identifying id instead of never
// resolving, since pages that gate content behind a visitorId would
// otherwise hang.
(function () {
  'use strict';
  const STUB_VISITOR_ID = '0000000000000000000000000000000';

  const agent = {
    get: function () {
      return Promise.resolve({ visitorId: STUB_VISITOR_ID, components: {} });
    },
  };

  window.FingerprintJS = {
    load: function () { return Promise.resolve(agent); },
  };
})();
