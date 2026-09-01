// shared/session-storage.js — single place for every BACKGROUND-context
// storage.session read/write, replacing 7 near-identical try/catch call
// sites that used to live inline in background.js, each with its own
// silently-swallowed (or, after 2026-09-01, ad-hoc logged) catch block.
//
// NOT for content scripts — those go through content/fastpath-storage.js
// instead, a separate file for a separate JS world with a DIFFERENT failure
// mode: on Firefox, storage.session isn't exposed to content scripts AT ALL
// (confirmed 2026-09-01 — see background.js's own setAccessLevel comment and
// Mozilla Bugzilla 1724754/1823717, both open/unassigned under
// [mv3-future]), whereas background/extension pages are TRUSTED_CONTEXTS by
// default and always have access regardless of that missing grant.
//
// 2026-09-01, revised same day: get()/set() now fall back to storage.local
// (prefixed, so they can never collide with a real local key) on ANY
// storage.session failure — not just "the API object doesn't exist" but
// also a live-observed QuotaExceededError ("storage.session API call
// exceeded its quota limitations", hit on BUILT_RULES_SESSION_KEY) —
// EXCEPT when the failed payload itself is too big to risk shoving into
// storage.local too (see _LOCAL_FALLBACK_MAX_BYTES on set() below): local
// is already measured tight elsewhere in this codebase, so a multi-MB
// session payload that already blew ITS OWN 10MB quota still just no-ops,
// same as before this fallback existed — only smaller payloads (the actual
// case this was built for, sessionAllowedDomains) get the new fallback.
// Every caller in background.js gets this for free just by going through
// this file, matching the same "session-or-local, transparently" shape
// content/fastpath-storage.js already uses for its own (separate) context.
// Once one call proves session is genuinely broken (not just this one
// payload being too big), _sessionKnownUnavailable latches and every LATER
// call skips straight to local — no point re-attempting a call already
// known doomed on every single get()/set() for the rest of this background
// lifetime.
//
// Trade-off worth knowing about, not hidden: storage.session's whole point
// for PARSED_RULES_SESSION_KEY/BUILT_RULES_SESSION_KEY is "cleared on
// browser restart" — harmless to lose that here, both are content-hash-keyed
// caches that just self-invalidate instead. sessionAllowedDomains is
// different: it backs the "Proceed" (temporary, this-session-only) bypass on
// blocked.html. If THAT falls back to storage.local, the bypass silently
// stops being temporary — it now survives a browser restart too, on any
// browser/build where storage.session set() fails. Accepted deliberately
// (2026-09-01, explicit user request after hitting a real "session save
// data" bug) in favor of the bypass actually working over it staying
// perfectly session-scoped on a browser where session itself is broken.
//
// Dual-loaded the same way config.js/browser-compat.js already are:
// background.js's importScripts() on Chrome, manifest.firefox.json's
// background.scripts array on Firefox (must load AFTER browser-compat.js,
// which sets self.EXT_SESSION_STORAGE, and AFTER shared/local-storage.js,
// which this file's own local fallback uses instead of EXT.storage.local
// directly — and BEFORE background.js).
(function () {
if (self.SessionStorage) return; // idempotent if ever loaded twice

var _sessionStorage = self.EXT_SESSION_STORAGE;
// Routed through shared/local-storage.js (must load before this file — see
// dual-loading comment below) rather than EXT.storage.local directly: that
// module already never throws and already logs consistently, so the local
// side of this fallback doesn't need its own try/catch duplicate of that.
var _local = self.LocalStorage;
// Keeps local-fallback entries visibly separate from real local keys (own
// namespace, never collides with allowedDomains/customRulesText/etc.) and
// easy to recognize/clear by hand if ever inspected in storage.local.
var _LOCAL_FALLBACK_PREFIX = '_qkv1SessFB_';

// Learned from a real call, not a separate synthetic probe (that was this
// file's first design — removed same day; a probe write/read/remove round
// trip added its own failure surface, live-caught by a test: some storage
// implementations don't even have remove()). The FIRST call that proves
// session is genuinely absent/broken (an 'unavailable' classification, NOT
// 'quota' — see below) flips this, and every later get()/set() this
// background lifetime skips straight to local instead of paying for a
// doomed session attempt first. Never reset back to false: a session
// confirmed dead once isn't expected to come back mid-lifetime. Deliberately
// NOT set on a 'quota' failure — that's a property of THIS payload, not of
// whether session works at all, so a smaller write later still gets a real
// attempt (see the size-guarded QuotaExceededError case in set() below).
var _sessionKnownUnavailable = false;

function _classifyError(e) {
  var msg = (e && e.message) || String(e || '');
  return /quota/i.test(msg) || (e && e.name === 'QuotaExceededError') ? 'quota' : 'unavailable';
}

// Logs and returns the classification so callers can decide whether to
// latch _sessionKnownUnavailable.
function _logSessionFail(op, keysLabel, e) {
  var kind = _classifyError(e);
  var label = kind === 'quota' ? 'QUOTA EXCEEDED' : 'failed';
  console.warn('[AdBlock] storage.session.' + op + '(' + keysLabel + ') ' + label + ' — falling back to storage.local:', e);
  return kind;
}

// keys can be a string, an array of strings, or (per the real
// storage.session.get() signature) an object of defaults — this codebase's
// own callers only ever pass a bare string or array, so the object-defaults
// form is deliberately not reproduced here beyond reading its own keys;
// applying the defaults themselves is left to the caller's own destructuring,
// same contract get() always had.
function _keysToArray(keys) {
  if (keys == null) return null;
  if (typeof keys === 'string') return [keys];
  if (Array.isArray(keys)) return keys;
  return Object.keys(keys);
}

async function _localFallbackGet(keys) {
  if (!_local) return {};
  var arr = _keysToArray(keys);
  if (!arr) { console.warn('[AdBlock] storage.local fallback: get(null) "every key" form is not supported here, returning {}'); return {}; }
  var prefixed = arr.map(function (k) { return _LOCAL_FALLBACK_PREFIX + k; });
  var raw = await _local.get(prefixed); // LocalStorage.get() never rejects — {} on any failure, same as "nothing cached yet"
  var out = {};
  for (var i = 0; i < arr.length; i++) {
    var lk = prefixed[i];
    if (lk in raw) out[arr[i]] = raw[lk];
  }
  return out;
}

async function _localFallbackSet(payload) {
  if (!_local) return false;
  var prefixed = {};
  for (var k in payload) {
    if (Object.prototype.hasOwnProperty.call(payload, k)) prefixed[_LOCAL_FALLBACK_PREFIX + k] = payload[k];
  }
  return _local.set(prefixed); // LocalStorage.set() never rejects — resolves true/false
}

// get() — tries storage.session first. On outright failure, falls back to
// the storage.local mirror entirely. On SUCCESS, still checks storage.local
// for any requested key session came back WITHOUT — a previous set() for
// that exact key may have landed in the local fallback instead (session
// merely resolving to {} for a key looks identical to "genuinely not cached
// yet" and "was written to local instead", so this can't skip that check
// just because session itself didn't reject). Always resolves (never
// rejects); returns {} if neither area has the data. The keys===null
// "give me everything" form can't be reconciled this way (no way to know
// what's "missing") — no real caller in this codebase uses it, so it just
// returns session's own result as-is in that case.
async function get(keys) {
  var arr = _keysToArray(keys);
  if (!_sessionStorage || _sessionKnownUnavailable) return _localFallbackGet(keys);
  var sessionResult;
  try {
    sessionResult = await _sessionStorage.get(keys);
  } catch (e) {
    if (_logSessionFail('get', arr || 'null', e) === 'unavailable') _sessionKnownUnavailable = true;
    return _localFallbackGet(keys);
  }
  if (!arr) return sessionResult; // null form — see comment above
  var missing = arr.filter(function (k) { return !(k in sessionResult); });
  if (!missing.length) return sessionResult;
  var localResult = await _localFallbackGet(missing);
  var merged = {};
  for (var k in sessionResult) if (Object.prototype.hasOwnProperty.call(sessionResult, k)) merged[k] = sessionResult[k];
  for (var k2 in localResult) if (Object.prototype.hasOwnProperty.call(localResult, k2)) merged[k2] = localResult[k2];
  return merged;
}

// A payload too big for storage.session's OWN 10MB quota (live-observed:
// BUILT_RULES_SESSION_KEY compressed can be several MB on a real large
// config) must not blindly fall into storage.local instead — this
// extension's local usage is already measured at ~70-87% of its own
// separate 10MB quota elsewhere (siteRulesCacheText alone: 6.97MB) for a
// real config, so an unconditional fallback here could push local OVER
// quota and start breaking real settings writes (allowedDomains,
// customRulesText, ...) — a strictly worse outcome than just losing this
// optional perf cache for one cold start. Below this, still fall back
// unconditionally (matches the explicit request this was built for): the
// data that actually needs this — sessionAllowedDomains, a handful of
// hostnames — is nowhere near this size.
var _LOCAL_FALLBACK_MAX_BYTES = 2 * 1024 * 1024;

// set() — tries storage.session first, falls back to the storage.local
// mirror on any failure UNDER the size guard above (including a
// QuotaExceededError below that size — see file header for the
// sessionAllowedDomains trade-off this implies). Always resolves; returns
// true if either area accepted the write, false if both failed or the
// payload was too big to risk the local fallback.
async function set(payload) {
  if (_sessionStorage && !_sessionKnownUnavailable) {
    try {
      await _sessionStorage.set(payload);
      return true;
    } catch (e) {
      if (_logSessionFail('set', Object.keys(payload).join(','), e) === 'unavailable') _sessionKnownUnavailable = true;
    }
  }
  var approxBytes = 0;
  try { approxBytes = JSON.stringify(payload).length; } catch (e2) {}
  if (approxBytes > _LOCAL_FALLBACK_MAX_BYTES) {
    console.warn('[AdBlock] storage.session write failed and payload is too large (~' + (approxBytes / 1024 / 1024).toFixed(2) + 'MB) to risk a storage.local fallback (already tight on quota elsewhere) — skipping, same as before this fallback existed.');
    return false;
  }
  return _localFallbackSet(payload);
}

self.SessionStorage = { get: get, set: set };
})();
