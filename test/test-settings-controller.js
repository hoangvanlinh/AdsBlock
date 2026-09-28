'use strict';
const assert = require('node:assert/strict');
const { create } = require('../shared/settings-controller');
(async () => {
  const data = { enabled: true };
  let writeError = false, readError = false, rejectApply = false, applied = 0, notified = 0;
  const storage = {
    async get(keys) { if (readError) throw Error('read failed'); return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in data).map(k => [k, structuredClone(data[k])])); },
    async set(patch) { if (writeError) throw Error('quota'); Object.assign(data, structuredClone(patch)); },
    async remove(keys) { keys.forEach(k => delete data[k]); },
  };
  const controller = create({ storage,
    domainPatternRe: /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i,
    async applyNetworkRules() { applied++; if (rejectApply) { rejectApply = false; return { ok: false, error: 'DNR rejected' }; } },
    async applyPrivacy() { if (rejectApply) { rejectApply = false; throw Error('privacy rejected'); } },
    async notify() { notified++; },
  });
  writeError = true;
  await assert.rejects(controller.handle({ type: 'TOGGLE', enabled: false }), /quota/);
  assert.equal(applied, 0); assert.equal(notified, 0); assert.equal(data.enabled, true);
  writeError = false; readError = true;
  await assert.rejects(controller.handle({ type: 'TOGGLE', enabled: false }), /read failed/);
  assert.equal(applied, 0); readError = false;
  rejectApply = true;
  await assert.rejects(controller.handle({ type: 'TOGGLE', enabled: false }), /DNR rejected/);
  assert.equal(data.enabled, true); assert.equal(notified, 0);
  rejectApply = true;
  await assert.rejects(controller.handle({ type: 'SET_PRIVACY', setting: 'gpcSignal', value: false }), /privacy rejected/);
  assert.equal('gpcSignal' in data, false, 'rollback restores an absent key, not a guessed default');
  assert.deepEqual(await controller.handle({ type: 'TOGGLE', enabled: false }), { ok: true });
  assert.equal(data.enabled, false); assert.equal(notified, 1);
  await Promise.all(['one.test', 'two.test'].map(domain => controller.handle({ type: 'PAUSE_DOMAIN', domain, paused: true })));
  assert.deepEqual(data.pausedDomains, ['one.test', 'two.test']);
  await assert.rejects(controller.handle({ type: 'SET_BLOCKING', setting: 'blockAds', value: 'false' }), /Invalid/);
  await assert.rejects(controller.handle({ type: 'SET_PRIVACY', setting: '__proto__', value: true }), /Invalid/);
  // TOGGLE + domain: one combined storage write/apply that both re-enables
  // protection AND clears that domain's pause (popup's "resume + turn on").
  const appliedBefore = applied;
  assert.deepEqual(await controller.handle({ type: 'TOGGLE', enabled: true, domain: 'one.test' }), { ok: true });
  assert.equal(data.enabled, true);
  assert.deepEqual(data.pausedDomains, ['two.test']);
  assert.equal(applied, appliedBefore + 1, 'one applyNetworkRules() call, not two');
  await assert.rejects(controller.handle({ type: 'TOGGLE', enabled: true, domain: 'not a domain' }), /Invalid domain/);
  console.log('PASS settings: storage/read failures, DNR/privacy rollback, retry, concurrent edits, validation, combined toggle+unpause');
})().catch(error => { console.error(error); process.exitCode = 1; });
