// Bounded downloads and last-good raw source cache, independent of rule conversion.
(function (root) {
  function create({ fetch: fetchImpl = root.fetch.bind(root), cacheStorage = root.caches,
                    timeoutMs = 15000, maxBytes = 12 * 1024 * 1024, concurrency = 4,
                    cacheBytes = 64 * 1024 * 1024, maxEntries = 80 } = {}) {
    let active = 0;
    const waiting = [];
    let cacheChain = Promise.resolve();
    async function slot(fn) {
      if (active >= concurrency) await new Promise(resolve => waiting.push(resolve));
      else active++;
      try { return await fn(); }
      finally { if (waiting.length) waiting.shift()(); else active--; }
    }
    async function map(items, fn) {
      let index = 0;
      const results = new Array(items.length);
      await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (index < items.length) { const i = index++; results[i] = await fn(items[i], i); }
      }));
      return results;
    }
    async function download(url, options = {}) {
      return slot(async () => {
        const controller = new AbortController();
        let timer;
        const work = (async () => {
          const response = await fetchImpl(url, { cache: 'no-store', ...options, signal: controller.signal });
          if (response.status === 304) return { text: '', status: 304, etag: response.headers.get('etag') || '' };
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          if (/text\/html/i.test(response.headers?.get('content-type') || '')) throw new Error('Expected a rule list, received HTML');
          if (Number(response.headers?.get('content-length')) > maxBytes) throw new Error('Rule source exceeds size limit');
          let text;
          if (response.body?.getReader) {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            const chunks = [];
            let bytes = 0;
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > maxBytes) throw new Error('Rule source exceeds size limit');
                chunks.push(decoder.decode(value, { stream: true }));
              }
              chunks.push(decoder.decode());
              text = chunks.join('');
            } catch (error) { void reader.cancel().catch(() => {}); throw error; }
            finally { reader.releaseLock(); }
          } else {
            text = await response.text();
            if (new TextEncoder().encode(text).length > maxBytes) throw new Error('Rule source exceeds size limit');
          }
          if (/^\s*(?:<!doctype html|<html\b)/i.test(text)) throw new Error('Expected a rule list, received HTML');
          return { text, status: response.status, etag: response.headers?.get('etag') || '' };
        })();
        try {
          return await Promise.race([work, new Promise((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error('Rule source timed out')); }, timeoutMs);
          })]);
        } catch (error) { controller.abort(); throw error; }
        finally { clearTimeout(timer); }
      });
    }
    async function cache() { return cacheStorage ? cacheStorage.open('adblock-rule-sources-v1') : null; }
    async function remember(url, text) {
      // CacheStorage is optional; failures must not discard a fresh download.
      const next = cacheChain.catch(() => {}).then(async () => {
        const store = await cache();
        if (!store || !/^https?:/i.test(url)) return;
        const bytes = new TextEncoder().encode(text).length;
        if (bytes > cacheBytes) return;
        // Keep this URL's previous response intact until put succeeds (e.g. quota failure).
        const canonical = new URL(url).href;
        const entries = (await store.keys()).filter(key => (typeof key === 'string' ? key : key.url) !== canonical);
        let total = bytes;
        const sizes = await Promise.all(entries.map(async key => Number((await store.match(key)).headers.get('x-rule-bytes')) || 0));
        total += sizes.reduce((sum, n) => sum + n, 0);
        while (entries.length && (total > cacheBytes || entries.length >= maxEntries)) {
          total -= sizes.shift(); await store.delete(entries.shift());
        }
        await store.put(url, new Response(text, { headers: { 'x-rule-bytes': String(bytes) } }));
      });
      cacheChain = next;
      await next.catch(() => {});
    }
    async function load(url) {
      try {
        const result = await download(url);
        if (!result.text.trim()) throw new Error('Empty rule source');
        await remember(url, result.text);
        return { ...result, stale: false };
      } catch (error) {
        try {
          const cached = await (await cache())?.match(url);
          if (cached) return { text: await cached.text(), stale: true, error: error.message };
        } catch {}
        throw error;
      }
    }
    return { download, load, map };
  }
  root.RuleFetcher = { create };
  if (typeof module !== 'undefined') module.exports = root.RuleFetcher;
})(typeof self === 'undefined' ? globalThis : self);
