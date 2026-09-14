// shared/diag-logger.js — TEMP diagnostic logger (2026-09-14)
// Separated out of background.js so it's easy to find/control on its own,
// independent of whatever else is being edited there.
//
// Persists every entry to chrome.storage.local (small capped ring buffer)
// instead of only console.log/warn/error, so a sequence of events can be
// reviewed LATER without keeping DevTools open the whole time in between —
// this matters specifically because a DevTools toolbox attached to
// Firefox's background page stops it from ever being idle-killed at all
// ("Background event page was not terminated on idle because a DevTools
// toolbox is attached to the extension"), which is exactly the real-world
// respawn scenario this diagnostic investigation needs to observe.
//
// Depends on self.LocalStorage (shared/local-storage.js) — must load AFTER
// it. Dual-loading story matches every other shared/*.js file: Chrome MV3
// service worker pulls it in via importScripts() below; Firefox's
// background event page lists it directly in manifest.firefox.json's
// background.scripts array instead (importScripts doesn't exist there).
if (typeof importScripts === 'function' && !self.LocalStorage) {
  importScripts('local-storage.js');
}

(function () {
  // Real users must get ZERO overhead from this file, not just silent
  // console output. build-firefox.sh/build-chrome.sh's production path
  // (debug=false, the default) runs `terser --compress drop_console=true`
  // over the shipped JS — that strips the literal console.log/warn/error(…)
  // CALLS this file makes, but not the surrounding logic that builds an
  // entry, pushes it into `buffer`, and writes it to chrome.storage.local:
  // none of that is a console.* call, so it would keep running — silently
  // growing a REAL user's storage.local with up to 400 entries nobody will
  // ever read. DEBUG_LOCAL is the one flag that build's own patch_debug()
  // step actually flips (false -> true) for a debug build and leaves alone
  // (stays false) for production — so gating on it here, not on whether
  // console calls survived stripping, is what actually keeps this a no-op
  // for everyone except an explicit debug build.
  const DEBUG_LOCAL = !!(self.ADBLOCK_CONFIG && self.ADBLOCK_CONFIG.DEBUG_LOCAL);

  const STORAGE_KEY = 'adblockDiagLog';
  const ENABLED_KEY = 'adblockDiagLogEnabled';
  const MAX_ENTRIES = 400;

  let buffer = null;        // lazy-loaded from storage, then kept in memory
  let enabled = true;       // default on; corrected from storage below on first use
  let enabledLoaded = false;
  let saveChain = Promise.resolve();

  async function ensureLoaded() {
    if (buffer === null) {
      const { [STORAGE_KEY]: stored } = await self.LocalStorage.get(STORAGE_KEY);
      buffer = Array.isArray(stored) ? stored : [];
    }
    if (!enabledLoaded) {
      enabledLoaded = true;
      const { [ENABLED_KEY]: storedEnabled } = await self.LocalStorage.get(ENABLED_KEY);
      if (storedEnabled === false) enabled = false;
    }
  }

  function write(level, msg, data) {
    if (!DEBUG_LOCAL) return; // production build — see the top-of-file comment
    // enabled starts true and is only corrected to false once storage has
    // actually been read (ensureLoaded, inside the queued write below) —
    // console output still respects the LAST KNOWN state synchronously so
    // toggling off takes effect immediately for future calls, not just
    // once the queued disk read resolves.
    if (!enabled) return;
    const entry = { t: new Date().toISOString(), level, msg, data };
    if (level === 'error') console.error('[AdBlock][DIAG]', msg, data);
    else if (level === 'warn') console.warn('[AdBlock][DIAG]', msg, data);
    else console.log('[AdBlock][DIAG]', msg, data);
    saveChain = saveChain.catch(() => {}).then(async () => {
      await ensureLoaded();
      if (!enabled) return; // disabled while this write was queued — drop it
      buffer.push(entry);
      if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
      try { await self.LocalStorage.set({ [STORAGE_KEY]: buffer }); } catch {}
    });
  }

  // Console API, from the background console (see this file's own comment
  // on why plain console.log alone isn't enough for this investigation):
  //   DiagLogger.dump()             — pretty-prints + returns the whole buffer
  //   DiagLogger.clear()            — wipes it
  //   DiagLogger.setEnabled(false)  — stop logging entirely (persists across
  //                                   respawns until turned back on)
  //   DiagLogger.isEnabled()        — check current state
  self.DiagLogger = {
    log(msg, data) { write('log', msg, data); },
    warn(msg, data) { write('warn', msg, data); },
    error(msg, data) { write('error', msg, data); },
    async setEnabled(v) {
      enabled = !!v;
      enabledLoaded = true;
      try { await self.LocalStorage.set({ [ENABLED_KEY]: enabled }); } catch {}
    },
    async isEnabled() { await ensureLoaded(); return enabled; },
    async clear() {
      buffer = [];
      try { await self.LocalStorage.set({ [STORAGE_KEY]: [] }); } catch {}
    },
    async dump() {
      await ensureLoaded();
      console.log(JSON.stringify(buffer, null, 2));
      return buffer.slice();
    },
  };
})();
