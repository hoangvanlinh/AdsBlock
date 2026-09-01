// shared/local-storage.js — single place for every BACKGROUND-context
// storage.local read/write, mirroring shared/session-storage.js's shape
// (get/set never throw, log consistently on failure) for the same reason
// that file exists: background.js had ~69 raw EXT.storage.local.get/set/
// remove/clear call sites, almost none with their own try/catch — a
// rejection there (quota, extension-context invalidated mid-call, etc.)
// would surface as a bare unhandled promise rejection with no [AdBlock]
// context, instead of a clear, attributable log line.
//
// Unlike storage.session, there IS no further fallback below storage.local
// (session-storage.js's own local-fallback already routes into THIS file,
// see below) — a storage.local failure here is terminal for that call: log
// it, return the same safe default get()/set() already returned on any
// "nothing there yet" case, and let the caller's own destructuring default
// (e.g. `const { x = [] } = await LocalStorage.get('x')`) carry it, exactly
// like every one of those callers already handled a legitimately-empty read.
//
// NOT for content scripts — those already have their own established wrapper
// (content/fastpath-storage.js) for a separate JS world with separate
// concerns (session/local racing, not relevant to background).
//
// Dual-loaded the same way config.js/session-storage.js already are:
// background.js's importScripts() on Chrome, manifest.firefox.json's
// background.scripts array on Firefox (must load AFTER browser-compat.js,
// which sets self.EXT, and BEFORE session-storage.js and background.js —
// session-storage.js's own local fallback calls into this module).
(function () {
if (self.LocalStorage) return; // idempotent if ever loaded twice

var _localArea = self.EXT && EXT.storage && EXT.storage.local;

function _log(op, keysLabel, e) {
  console.warn('[AdBlock] storage.local.' + op + '(' + keysLabel + ') failed:', e);
}

// get() — same signature/contract as the real storage.local.get(): keys can
// be a string, array, object-of-defaults, or null/undefined ("everything").
// Always resolves (never rejects); returns {} on any failure.
async function get(keys) {
  if (!_localArea) return {};
  try {
    return await _localArea.get(keys);
  } catch (e) {
    _log('get', _keysLabel(keys), e);
    return {};
  }
}

// set() — always resolves; returns true if the write succeeded, false on
// any failure (quota exceeded, etc.).
async function set(payload) {
  if (!_localArea) return false;
  try {
    await _localArea.set(payload);
    return true;
  } catch (e) {
    _log('set', Object.keys(payload).join(','), e);
    return false;
  }
}

// remove() — same signature as the real storage.local.remove() (a single
// key or an array of keys). Always resolves; returns true/false like set().
async function remove(keys) {
  if (!_localArea) return false;
  try {
    await _localArea.remove(keys);
    return true;
  } catch (e) {
    _log('remove', _keysLabel(keys), e);
    return false;
  }
}

// clear() — wipes the entire storage.local area (RESET message handler
// only). Always resolves; returns true/false like set()/remove().
async function clear() {
  if (!_localArea) return false;
  try {
    await _localArea.clear();
    return true;
  } catch (e) {
    _log('clear', '*', e);
    return false;
  }
}

function _keysLabel(keys) {
  if (keys == null) return 'null';
  if (typeof keys === 'string') return keys;
  if (Array.isArray(keys)) return keys.join(',');
  try { return Object.keys(keys).join(','); } catch (e) { return String(keys); }
}

self.LocalStorage = { get: get, set: set, remove: remove, clear: clear };
})();
