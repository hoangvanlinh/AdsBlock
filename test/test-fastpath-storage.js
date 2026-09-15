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
  const localData = {};
  const sessionRejects = opts.sessionRejects !== false;
  const sessionStorageStub = {
    get(keys) {
      sessionCalls.push({ op: 'get', keys });
      return sessionRejects ? Promise.reject(new Error('denied')) : Promise.resolve({});
    },
    set(payload) {
      sessionCalls.push({ op: 'set', payload });
      return sessionRejects ? Promise.reject(new Error('denied')) : Promise.resolve();
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
  return T;
}

(async () => {
  console.log('== 1. Baseline: session works fine (e.g. Chrome) — never falls back, never latches ==');
  {
    const T = makeSandbox({ sessionRejects: false });
    await T.get('x');
    await T.set({ x: 1 });
    check('get() went to session only, no local fallback attempted', T._sessionCalls.length === 2 && T._localCalls.length === 0,
      { session: T._sessionCalls.length, local: T._localCalls.length });
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

  console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
})();
