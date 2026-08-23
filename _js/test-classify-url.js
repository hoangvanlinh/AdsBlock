// Harness: extracts the REAL classification block (_splitPatterns through
// classifyUrl) directly out of content/content.js by source markers, rather
// than stubbing the whole file's document/MutationObserver dependencies —
// this still exercises the actual shipped code, just without the DOM setup
// content.js doesn't need for this specific logic.
//
// Verifies the 2026-08-24 fix: classifyUrl() used to run up to 3 full
// Array.some() linear scans per resource (malware/tracker/ad pattern lists)
// — a real per-request hot path that grows into the thousands once several
// large Rule Sources are enabled (a real user's merged config measured this
// scale). Every ABP-converted network-domain entry is a bare domain, so the
// dominant case now uses a Set + domain-suffix walk (mirrors
// resolveSiteKey()'s technique in background.js) instead of a linear scan.
// This test proves: (1) output is IDENTICAL to the old linear-scan logic
// across many URL shapes (domain/subdomain/path/keyword matches and
// non-matches), and (2) it's meaningfully faster at real-world scale.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'content/content.js'), 'utf8');

const startMarker = 'function _splitPatterns(list) {';
const endMarker = "\n// Batch counter";
const startIdx = src.indexOf(startMarker);
const endIdx = src.indexOf(endMarker, startIdx);
if (startIdx === -1 || endIdx === -1) {
  console.error('HARNESS ERROR: could not locate the classification block markers in content.js — did it move/get renamed?');
  process.exit(2);
}
const block = src.slice(startIdx, endIdx);

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); }
}

const sandbox = { console, URL, Set, Array, String, location: { href: 'https://test.example/' } };
sandbox.self = sandbox;
sandbox.window = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(
  block + '\nself.__test = { _splitPatterns, applyGlobalConfig, classifyUrl };',
  ctx,
  { filename: 'content.js (classification block)' }
);
const T = sandbox.__test;

// ── Reference (OLD) implementation — exactly what shipped before this fix,
// kept here ONLY as a correctness oracle for this test, not used in prod.
function oldPatternMatches(pattern, fullUrl, host) {
  if (pattern.includes('/')) return fullUrl.includes(pattern);
  if (pattern.includes('.')) return host === pattern || host.endsWith('.' + pattern);
  return fullUrl.includes(pattern);
}
function oldClassify(adPatterns, trackerPatterns, malwarePatterns, url) {
  let host, full;
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    full = u.href.toLowerCase();
  } catch { return null; }
  if (malwarePatterns.some(p => oldPatternMatches(p, full, host))) return 'malware';
  if (trackerPatterns.some(p => oldPatternMatches(p, full, host))) return 'tracker';
  if (adPatterns.some(p => oldPatternMatches(p, full, host))) return 'ad';
  return null;
}

console.log('== 1. Correctness: NEW split-based classifyUrl matches OLD linear-scan output ==');
const adPatterns = ['doubleclick.net', 'googlesyndication.com', 'ads.example.com', 'trk/pixel'];
const trackerPatterns = ['google-analytics.com', 'facebook.com/tr', 'segment'];
const malwarePatterns = ['coinhive.com', 'evil.example'];
T.applyGlobalConfig({
  ad_network_patterns: adPatterns,
  tracker_network_patterns: trackerPatterns,
  malware_network_domains: malwarePatterns,
});

const cases = [
  ['https://doubleclick.net/ad.js', 'ad'],                       // exact domain match
  ['https://sub.doubleclick.net/ad.js', 'ad'],                    // subdomain match
  ['https://notdoubleclick.net/ad.js', null],                     // must NOT match a different domain sharing a suffix
  ['https://example.com/trk/pixel.gif', 'ad'],                    // path-based ("other") pattern (trk/pixel is in adPatterns)
  ['https://google-analytics.com/collect', 'tracker'],
  ['https://coinhive.com/miner.js', 'malware'],                   // malware wins priority over ad/tracker
  ['https://ads.example.com/x', 'ad'],
  ['https://safe-site.example/page', null],                       // no match at all
  ['https://cdn.example/segmenttracking.js', 'tracker'],          // bare-keyword ("other") substring match
  ['not a url at all', null],                                     // malformed URL must not throw
];
for (const [url, expected] of cases) {
  const oldResult = oldClassify(adPatterns, trackerPatterns, malwarePatterns, url);
  const newResult = T.classifyUrl(url);
  check(`classifyUrl(${JSON.stringify(url)}) === ${JSON.stringify(expected)} (old: ${JSON.stringify(oldResult)}, new: ${JSON.stringify(newResult)})`,
    newResult === expected && newResult === oldResult);
}

console.log('\n== 2. Performance: NEW is meaningfully faster than OLD at real-world scale ==');
// Simulate a large merged ad_network_patterns list (thousands of bare
// domains, matching the real shape ABP-converted sources produce).
const bigPatterns = [];
for (let i = 0; i < 20000; i++) bigPatterns.push(`ad-domain-${i}.example${i % 50}.com`);
const testUrl = 'https://ad-domain-19999.example49.com/pixel.gif'; // worst case: matches the LAST entry
T.applyGlobalConfig({ ad_network_patterns: bigPatterns, tracker_network_patterns: [], malware_network_domains: [] });

function bench(fn, n) {
  for (let i = 0; i < 3; i++) fn();
  const start = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn();
  return Number(process.hrtime.bigint() - start) / 1e6 / n;
}
const oldMs = bench(() => oldClassify(bigPatterns, [], [], testUrl), 200);
const newMs = bench(() => T.classifyUrl(testUrl), 200);
console.log(`  OLD (linear .some() scan): ${oldMs.toFixed(4)}ms/call`);
console.log(`  NEW (Set + domain-suffix walk): ${newMs.toFixed(4)}ms/call`);
console.log(`  Speedup: ${(oldMs / newMs).toFixed(1)}x`);
check('NEW is at least 10x faster than OLD at 20,000-pattern scale', newMs > 0 && (oldMs / newMs) > 10,
  { oldMs, newMs });

console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
process.exit(fail ? 1 : 0);
