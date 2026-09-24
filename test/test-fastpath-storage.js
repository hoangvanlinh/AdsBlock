// Harness: runs the real content/fastpath-storage.js in Node (same vm-sandbox
// technique as the other content-script test files) to verify the
// session-vs-local fallback logic, specifically the _sessionKnownBroken latch
// (2026-09-15) — live-reported ("nháy nháy" persisting despite
// directCssFastPath/scriptletRulesFastPath already existing): on Firefox,
// a content script's storage.session access is ALWAYS denied (not just
// sometimes), so without a latch, every single get()/set() call this page
// load repeated the same doomed session attempt before falling back to
// .local — 2 sequential round trips forever instead of 1 after the first.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'content/fastpath-storage.js'), 'utf8');

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); }
}

// opts.hasSession === false -> self.EXT_SESSION_STORAGE is undefined (API
// object itself doesn't exist — the OTHER, unrelated way _usingSession can be
// false, already handled by the pre-existing `if(!_usingSession...)` guard).
// opts.sessionRejects (default true) -> the session API object EXISTS but
// every get()/set() call against it rejects — the real Firefox scenario this
// fix targets.
function makeSandbox(opts) {
  opts = opts || {};
  const sessionCalls = [];
  const localCalls = [];
  const localData = opts.localData ? { ...opts.localData } : {};
  const sessionData = opts.sessionData ? { ...opts.sessionData } : {};
  const sessionRejects = opts.sessionRejects !== false;
  const sessionStorageStub = {
    get(keys) {
      sessionCalls.push({ op: 'get', keys });
      if (sessionRejects) return Promise.reject(new Error('denied'));
      // Healthy session, but only returns what's actually IN sessionData —
      // same as the real API resolving fine with no data for a key it was
      // never asked to store this session (e.g. right after a browser
      // restart, which is what opts.sessionData being left empty models).
      const arr = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of arr) if (k in sessionData) out[k] = sessionData[k];
      return Promise.resolve(out);
    },
    set(payload) {
      sessionCalls.push({ op: 'set', payload });
      if (sessionRejects) return Promise.reject(new Error('denied'));
      Object.assign(sessionData, payload);
      return Promise.resolve();
    },
  };
  const localStorageStub = {
    get(keys) {
      localCalls.push({ op: 'get', keys });
      const arr = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of arr) if (k in localData) out[k] = localData[k];
      return Promise.resolve(out);
    },
    set(payload) {
      localCalls.push({ op: 'set', payload });
      Object.assign(localData, payload);
      return Promise.resolve();
    },
  };
  const sandbox = { Promise, console };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.EXT = { storage: { local: localStorageStub } };
  sandbox.self.EXT_SESSION_STORAGE = opts.hasSession === false ? undefined : sessionStorageStub;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: 'fastpath-storage.js' });
  const T = sandbox.window.__qkv1FastpathStorage;
  T._sessionCalls = sessionCalls;
  T._localCalls = localCalls;
  T._localData = localData;
  T._sessionData = sessionData;
  return T;
}

(async () => {
  console.log('== 1. Baseline: session works fine AND already has the data (e.g. Chrome, same session as a prior visit) — no local read needed ==');
  {
    const T = makeSandbox({ sessionRejects: false, sessionData: { x: 1 } });
    const got = await T.get('x');
    check('get() returns session\'s own value untouched', got.x === 1, got);
    check('get() never reads .local when session already had the key', T._localCalls.filter(c => c.op === 'get').length === 0,
      T._localCalls);
    await T.set({ x: 2 });
    check('set() still mirrors into .local even though session itself is healthy (see section 5)', T._localData.x === 2, T._localData);
  }

  console.log('\n== 1b. Session resolves fine but is EMPTY for the key (2026-09-24: models a fresh browser restart — storage.session is wiped on close even though the grant itself still works) ==');
  {
    const T = makeSandbox({ sessionRejects: false, sessionData: {} });
    const got = await T.get('x');
    check('get() falls back to reading .local when session resolved with nothing for this key',
      T._localCalls.some(c => c.op === 'get'), T._localCalls);
    check('result is an empty object (nothing in .local either, in this scenario)', Object.keys(got).length === 0, got);
  }

  console.log('\n== 2. Regression (2026-09-15): session rejecting every call (Firefox) — first call falls back AND latches, every later call skips session entirely ==');
  {
    const T = makeSandbox({ sessionRejects: true });
    await T.get('a');
    check('first get(): attempted session (and it was rejected)', T._sessionCalls.length === 1, T._sessionCalls);
    check('first get(): fell back to local and got a real (empty) result', T._localCalls.length === 1, T._localCalls);

    await T.set({ a: 1 });
    check('first set() (2nd call overall): still latched from the get() above — does NOT retry session',
      T._sessionCalls.length === 1, T._sessionCalls);
    check('first set(): went straight to local', T._localCalls.length === 2 && T._localData.a === 1, T._localCalls);

    await T.get('a');
    await T.get('b');
    check('two MORE get() calls after the latch: zero additional session attempts',
      T._sessionCalls.length === 1, T._sessionCalls);
    check('two MORE get() calls after the latch: each still reaches local (3 local calls total from get() + set() + get() + get())',
      T._localCalls.length === 4, T._localCalls);
    check('a genuinely-written value is still correctly read back through the latched (local-only) path',
      (await T.get('a')).a === 1);
  }

  console.log('\n== 3. session API object doesn\'t exist at all (not a rejection — a different, pre-existing code path) — goes straight to local from the start, no latch needed ==');
  {
    const T = makeSandbox({ hasSession: false });
    await T.get('x');
    await T.set({ x: 1 });
    check('no session calls at all (there is no session object to call)', T._sessionCalls.length === 0, T._sessionCalls);
    check('everything went to local', T._localCalls.length === 2 && T._localData.x === 1, T._localCalls);
  }

  console.log('\n== 4. usingSession/lruLimit still reflect API-object presence, unaffected by the latch ==');
  {
    const T = makeSandbox({ sessionRejects: true });
    check('usingSession is true (the API object exists) even though every call will reject', T.usingSession === true);
    check('lruLimit is the session-sized cap (50) — set once at load, not re-derived after latching', T.lruLimit === 50);
  }

  console.log('\n== 5. Full browser restart survives (2026-09-24 fix): a value set() in a PRIOR session is still readable after .session comes back empty ==');
  {
    // "Prior session": session healthy, writes a real value — set() should
    // mirror it into .local at the same time (this is the fix: .local used
    // to only ever be touched on a denied grant, never as a standing shadow
    // copy of a healthy session).
    const before = makeSandbox({ sessionRejects: false, sessionData: {} });
    await before.set({ directCssFastPath: { 'example.com': { sel: ['.ad'] } } });
    check('set() wrote to session', before._sessionData.directCssFastPath !== undefined, before._sessionData);
    check('set() ALSO mirrored the exact same payload into .local', before._localData.directCssFastPath !== undefined, before._localData);

    // "New session" (browser reopened): a FRESH sandbox — new, empty
    // sessionData (exactly what storage.session looks like after a real
    // browser restart) — but .local carries over the mirrored copy, as it
    // would across a real restart (chrome.storage.local persists to disk).
    const after = makeSandbox({ sessionRejects: false, sessionData: {}, localData: before._localData });
    const got = await after.get(['directCssFastPath']);
    check('get() recovers the pre-restart value from .local even though .session is empty this session',
      got.directCssFastPath && got.directCssFastPath['example.com'] && got.directCssFastPath['example.com'].sel[0] === '.ad',
      got);
  }

  console.log('\n== 6. A key session DOES have data for is never clobbered by a possibly-older .local copy ==');
  {
    const T = makeSandbox({
      sessionRejects: false,
      sessionData: { directCssFastPath: { 'a.com': { sel: ['.fresh'] } } },
      localData: { directCssFastPath: { 'a.com': { sel: ['.stale'] } } },
    });
    const got = await T.get(['directCssFastPath']);
    check('session\'s own (fresher) value wins over .local\'s', got.directCssFastPath['a.com'].sel[0] === '.fresh', got);
  }

  console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
})();
