'use strict';
const assert = require('node:assert/strict');
const { create } = require('../shared/rule-fetcher');
function memoryCache(fault = {}) {
  const entries = new Map();
  return { async open() { return {
    async match(url) { return entries.get(url)?.clone(); },
    async put(url, response) { if (fault.failWrites) throw Error('cache quota'); entries.set(url, response.clone()); },
    async delete(url) { return entries.delete(url); },
    async keys() { return [...entries.keys()]; },
  }; } };
}
(async () => {
  let active = 0, peak = 0;
  const cacheStorage = memoryCache();
  let fail = false;
  const fetch = async () => {
    if (fail) throw Error('offline');
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return new Response('||ads.example^');
  };
  const loader = create({ fetch, cacheStorage, concurrency: 2 });
  await Promise.all(Array.from({ length: 9 }, (_, i) => loader.load(`https://list.test/${i}`)));
  assert.equal(peak, 2);
  fail = true;
  const restarted = create({ fetch, cacheStorage });
  const stale = await restarted.load('https://list.test/0');
  assert.equal(stale.text, '||ads.example^'); assert.equal(stale.stale, true); assert.match(stale.error, /offline/);
  await assert.rejects(restarted.load('https://missing.test'), /offline/);
  const limited = create({ fetch: async () => new Response('x'.repeat(32)), maxBytes: 8 });
  await assert.rejects(limited.download('https://large.test'), /size limit/);
  const stalled = create({ fetch: async () => new Response(new ReadableStream({ start() {} })), timeoutMs: 10 });
  await assert.rejects(stalled.download('https://stalled.test'), /timed out/);
  const hang = create({ fetch: () => new Promise(() => {}), timeoutMs: 10 });
  await assert.rejects(hang.download('https://hang.test'), /timed out/);
  const html = create({ fetch: async () => new Response('<!doctype html><html>error</html>') });
  await assert.rejects(html.load('https://html.test'), /HTML/);
  const empty = create({ fetch: async () => new Response(''), cacheStorage });
  assert.equal((await empty.load('https://list.test/0')).stale, true, 'empty response keeps last good source');
  const evictCache = memoryCache();
  const evict = create({ fetch: async () => new Response('1234'), cacheStorage: evictCache, cacheBytes: 6 });
  await evict.load('https://a.test'); await evict.load('https://b.test');
  assert.equal(await (await evictCache.open()).match('https://a.test'), undefined);
  const unavailable = create({ fetch: async () => new Response('valid'), cacheStorage: { open: async () => { throw Error('quota'); } } });
  assert.equal((await unavailable.load('https://cache-failed.test')).text, 'valid');
  const fault = {};
  const retainedCache = memoryCache(fault);
  let responseText = 'old rules';
  const retained = create({ fetch: async () => { if (responseText === null) throw Error('offline'); return new Response(responseText); }, cacheStorage: retainedCache });
  await retained.load('https://retained.test/');
  fault.failWrites = true; responseText = 'new rules';
  assert.equal((await retained.load('https://retained.test/')).text, 'new rules');
  responseText = null;
  assert.equal((await retained.load('https://retained.test/')).text, 'old rules', 'failed cache replacement preserves the previous response');
  console.log('PASS source loading: concurrency, restart fallback, size/timeout/HTML/empty, eviction, cache failure');
})().catch(error => { console.error(error); process.exitCode = 1; });
