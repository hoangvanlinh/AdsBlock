// Inert stand-in for FingerprintJS v2's public API
// (https://github.com/fingerprintjs/fingerprintjs, the pre-Pro "Fingerprint2"
// global). Real callers pass a callback to Fingerprint2.get(cb) — the
// callback is expected to eventually run with (fingerprintHash, components)
// — or use the newer .load().then(fp => fp.get()) promise chain some
// integration snippets wrap around it. Both resolve to the same fixed,
// non-identifying hash here rather than never resolving at all, since pages
// that gate content behind "fingerprint received" would otherwise hang.
(function () {
  'use strict';
  const STUB_HASH = '0000000000000000000000000000000';

  function get(callback) {
    if (typeof callback === 'function') callback(STUB_HASH, []);
  }

  window.Fingerprint2 = {
    get: get,
    getPromise: function () { return Promise.resolve([]); },
    getV18: get,
    x64hash128: function () { return STUB_HASH; },
    VERSION: '2.1.4',
  };
})();
