// inspect-optimization-targets.js — diagnostic script, NOT run via Node.
//
// How to run:
//   1. chrome://extensions → enable Developer mode → find this extension →
//      click "service worker" (Chrome) or "Inspect" (Firefox: about:debugging
//      → This Firefox → Inspect on this extension → Console).
//   2. Paste this whole file into the DevTools Console that opens and press
//      Enter. Read-only except one thing: it calls the real parseRuleText()
//      on the CURRENT rules text to time it live (pure function, no
//      storage/network writes, safe to run anytime — same cost the service
//      worker already pays on its own cold starts), and does ONE throwaway
//      chrome.storage.session write/read to benchmark real timing (same key
//      the real code uses — gets overwritten with real data again on the
//      next actual rules load, never left in a broken state).
//
// Unlike scripts/inspect-rule-cache-size.js (chrome.storage.local only —
// the compressed source-of-truth text), this one covers the OTHER three
// places real limits/costs actually live: chrome.storage.session (the
// parsed-object cache + this session's temporary allowlist),
// declarativeNetRequest's hard rule-count ceilings (silently drops rules
// past the limit — no error, no warning), and a live re-measurement of the
// parse-vs-cache-read timing gap background.js's own comments cite from a
// single past measurement — including whether the write even FITS in quota
// at this installation's real scale (large Rule Source configs can exceed
// chrome.storage.session's 10MB cap, at which point the cache silently never
// populates and every cold start pays the full parse cost with zero benefit).
(async () => {
  function bytesOf(value) {
    if (value === undefined) return 0;
    try { return new Blob([JSON.stringify(value)]).size; }
    catch { return new TextEncoder().encode(JSON.stringify(value)).length; }
  }
  function fmt(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  console.log('=== 1. chrome.storage.session — actual usage vs quota ===');
  const SESSION_QUOTA = (chrome.storage.session && chrome.storage.session.QUOTA_BYTES) || 10485760;
  if (chrome.storage.session) {
    const SESSION_KEYS = ['parsedRulesSessionCache', 'sessionAllowedDomains'];
    const stored = await chrome.storage.session.get(SESSION_KEYS);
    const rows = [];
    for (const key of SESSION_KEYS) {
      const value = stored[key];
      let bytes = 0;
      if (chrome.storage.session.getBytesInUse) {
        try { bytes = await chrome.storage.session.getBytesInUse(key); } catch { bytes = bytesOf(value); }
      } else {
        bytes = bytesOf(value);
      }
      let summary = '(not set)';
      if (value !== undefined) {
        if (key === 'parsedRulesSessionCache' && value.parsed) {
          summary = `${Object.keys(value.parsed).length} sections, hash ${String(value.hash).slice(0, 12)}…`;
        } else if (Array.isArray(value)) {
          summary = `${value.length} entries`;
        } else {
          summary = String(value);
        }
      }
      rows.push({ key, size: fmt(bytes), summary });
    }
    console.table(rows);
    if (chrome.storage.session.getBytesInUse) {
      const grandTotal = await chrome.storage.session.getBytesInUse(null);
      console.log(`chrome.storage.session TOTAL: ${fmt(grandTotal)} / ${fmt(SESSION_QUOTA)} quota (${((grandTotal / SESSION_QUOTA) * 100).toFixed(1)}%)`);
    }
  } else {
    console.log('chrome.storage.session not available in this browser.');
  }

  console.log('\n=== 2. declarativeNetRequest — rule-count ceilings ===');
  // These caps are silent: Chrome just drops/rejects rules past them with no
  // visible UI warning to the user — the only way to notice is checking here
  // or seeing specific sites stop being blocked with no obvious cause.
  try {
    const dynamicRules = await chrome.declarativeNetRequest.getDynamicRules();
    const dynMax = chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES
      ?? chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES ?? 30000;
    console.log(`Dynamic rules: ${dynamicRules.length} / ${dynMax} (${((dynamicRules.length / dynMax) * 100).toFixed(1)}%)`);
  } catch (e) { console.log('getDynamicRules() failed:', e.message); }
  try {
    const staticEnabled = await chrome.declarativeNetRequest.getEnabledRulesets();
    console.log(`Enabled static rulesets: ${staticEnabled.length}`);
  } catch (e) { /* not all versions expose this */ }
  try {
    const staticCount = await chrome.declarativeNetRequest.getAvailableStaticRuleCount?.();
    if (staticCount !== undefined) console.log(`Available static-rule budget remaining: ${staticCount}`);
  } catch (e) { /* Firefox / older Chrome may not have this */ }

  console.log('\n=== 3-5. parseRuleText timing + session-cache fit + compression trade-off ===');
  // Parse ONCE here and reuse the result below — re-running parseRuleText()
  // per section would multiply an already-expensive step (can be 500-700ms+
  // on a large real config) for no reason.
  let text = null, parsed = null;
  if (typeof parseRuleText === 'function' && typeof getRulesText === 'function') {
    text = await getRulesText();
    console.log(`Current rules text: ${fmt(bytesOf(text))} raw, ${text.split('\n').length} lines`);
    const t0 = performance.now();
    parsed = parseRuleText(text);
    const parseMs = performance.now() - t0;
    console.log(`parseRuleText() from scratch: ${parseMs.toFixed(1)}ms (${Object.keys(parsed).length} sections)`);

    console.log('\n--- 3. Does the uncompressed cache even fit, and how fast is it if it does? ---');
    if (chrome.storage.session && typeof _hashText === 'function') {
      const hash = _hashText(text);
      try {
        await chrome.storage.session.set({ parsedRulesSessionCache: { hash, parsed } });
        const t1 = performance.now();
        await chrome.storage.session.get('parsedRulesSessionCache');
        const readMs = performance.now() - t1;
        console.log(`chrome.storage.session.get() read-back: ${readMs.toFixed(1)}ms`);
        console.log(`Net saving per SW cold start: ${(parseMs - readMs).toFixed(1)}ms (${(((parseMs - readMs) / parseMs) * 100).toFixed(0)}% of the parse step)`);
      } catch (e) {
        console.log(`chrome.storage.session.set() FAILED: ${e.message}`);
        console.log('This means the uncompressed cache does NOT fit at this installation\'s current scale — every SW cold start pays the FULL parseRuleText() cost above with ZERO benefit from this cache (the real background.js code has the same try/catch, so this is exactly what is happening in production right now, silently).');
      }
    } else {
      console.log('chrome.storage.session or _hashText not in scope — skipping.');
    }

    console.log('\n--- 5. Would compressing it fix/improve that? (live measurement) ---');
    if (typeof _compressForStorage === 'function' && typeof _decompressFromStorage === 'function') {
      const jsonStr = JSON.stringify(parsed);
      const tStringify0 = performance.now();
      JSON.stringify(parsed);
      const stringifyMs = performance.now() - tStringify0;

      const tCompress0 = performance.now();
      const compressed = await _compressForStorage(jsonStr);
      const compressMs = performance.now() - tCompress0;
      const compressedBytes = bytesOf(compressed);
      console.log(`Uncompressed (JSON) size: ${fmt(bytesOf(jsonStr))}`);
      console.log(`Compressed size: ${fmt(compressedBytes)} (write-path cost ${(stringifyMs + compressMs).toFixed(1)}ms — happens once per rules change, not on the cold-start hot path, so this number matters far less than the read-path one below)`);
      console.log(`Compressed fits under the ${fmt(SESSION_QUOTA)} session quota by itself: ${compressedBytes < SESSION_QUOTA ? 'YES' : 'NO — still too big even compressed'}`);

      const tDecompress0 = performance.now();
      const decompressedStr = await _decompressFromStorage(compressed);
      const decompressMs = performance.now() - tDecompress0;
      const tParseBack0 = performance.now();
      JSON.parse(decompressedStr);
      const parseBackMs = performance.now() - tParseBack0;
      const compressedReadTotalMs = decompressMs + parseBackMs;
      console.log(`Read path if compressed: decompress ${decompressMs.toFixed(1)}ms + JSON.parse ${parseBackMs.toFixed(1)}ms = ${compressedReadTotalMs.toFixed(1)}ms total`);
      console.log(`Compare to parseRuleText() from scratch: ${parseMs.toFixed(1)}ms — compressed-read-then-parse is ${compressedReadTotalMs < parseMs ? `${(parseMs - compressedReadTotalMs).toFixed(1)}ms FASTER than reparsing` : `${(compressedReadTotalMs - parseMs).toFixed(1)}ms SLOWER than just reparsing (compression would make this worse, not better)`}.`);
    } else {
      console.log('_compressForStorage/_decompressFromStorage not in scope — paste this INTO the service worker console.');
    }
  } else {
    console.log('parseRuleText/getRulesText not in global scope — paste this INTO the service worker console, not a content script or page console.');
  }

  console.log('\n=== 4. chrome.storage.local — quick total (see inspect-rule-cache-size.js for the full per-key breakdown) ===');
  if (chrome.storage.local.getBytesInUse) {
    const localTotal = await chrome.storage.local.getBytesInUse(null);
    const localQuota = chrome.storage.local.QUOTA_BYTES || 10485760;
    console.log(`chrome.storage.local TOTAL: ${fmt(localTotal)} / ${fmt(localQuota)} quota (${((localTotal / localQuota) * 100).toFixed(1)}%)`);
  }
})();
