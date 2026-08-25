// inspect-rule-cache-size.js — diagnostic script, NOT run via Node.
//
// How to run:
//   1. chrome://extensions → enable Developer mode → find this extension →
//      click "service worker" (Chrome) or "Inspect" (Firefox: about:debugging
//      → This Firefox → Inspect on this extension → Console).
//   2. Paste this whole file into the DevTools Console that opens and press
//      Enter. It only reads chrome.storage.local — no writes, safe to run
//      anytime.
//
// Reports the byte size of every rule-related storage key (the merged rules
// cache, per-source ETag/hash maps, custom rules, malware domain list,
// element-picker rules, etc.), plus total chrome.storage.local usage vs the
// ~10MB default quota (no unlimitedStorage permission in this extension's
// manifest.json).
(async () => {
  const KEYS = [
    'siteRulesCacheText', 'siteRulesCacheTime',
    'siteRulesRemoteEtag', 'siteRulesRemoteHash',
    'dnrRulesAppliedHash',
    'ruleSourceErrors', 'ruleSourceStats',
    'ruleSources', 'customRulesUrl', 'customRulesText',
    'defaultRuleSourceEnabled', 'defaultRuleSourceOverrides',
    'remoteMalwareDomains', 'remoteMalwareRules',
    'elementRules', 'rules', 'distractionDomains',
    'pausedDomains', 'allowedDomains',
  ];

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
  function summarize(key, value) {
    if (value === undefined) return '(not set)';
    if (key === 'siteRulesCacheText' || key === 'customRulesText') {
      const lines = String(value).split('\n').length;
      return `${lines} lines`;
    }
    if (key === 'siteRulesCacheTime') {
      const ageMs = Date.now() - Number(value || 0);
      const ttlMs = 6 * 60 * 60 * 1000;
      return `age ${(ageMs / 60000).toFixed(1)}min, ${ageMs < ttlMs ? 'FRESH' : 'STALE (past 6h TTL)'}`;
    }
    if (Array.isArray(value)) return `${value.length} entries`;
    if (value && typeof value === 'object') return `${Object.keys(value).length} keys`;
    return String(value);
  }

  const stored = await chrome.storage.local.get(KEYS);
  const rows = [];
  for (const key of KEYS) {
    const value = stored[key];
    let bytes = 0;
    // Prefer the real per-key API when available (Chrome; Firefox's
    // storage.local currently has no getBytesInUse) — falls back to a
    // JSON-size estimate otherwise, which is close enough for comparison.
    if (chrome.storage.local.getBytesInUse) {
      try { bytes = await chrome.storage.local.getBytesInUse(key); } catch { bytes = bytesOf(value); }
    } else {
      bytes = bytesOf(value);
    }
    rows.push({ key, bytes, size: fmt(bytes), summary: summarize(key, value) });
  }
  rows.sort((a, b) => b.bytes - a.bytes);

  console.log('=== Rule-related chrome.storage.local key sizes ===');
  console.table(rows.map(r => ({ key: r.key, size: r.size, summary: r.summary })));

  const trackedTotal = rows.reduce((sum, r) => sum + r.bytes, 0);
  console.log(`Tracked keys total: ${fmt(trackedTotal)}`);

  if (chrome.storage.local.getBytesInUse) {
    const grandTotal = await chrome.storage.local.getBytesInUse(null);
    const quota = chrome.storage.local.QUOTA_BYTES || 10485760;
    console.log(`chrome.storage.local TOTAL (all keys, this extension): ${fmt(grandTotal)} / ${fmt(quota)} quota (${((grandTotal / quota) * 100).toFixed(1)}%)`);
  } else {
    console.log('chrome.storage.local.getBytesInUse not available in this browser — totals above are JSON-size estimates only.');
  }
})();
