#!/usr/bin/env node
// tools/strip-picker-only-locale-keys.js — removes ruleEditor_*/scanner_*
// keys from every NON-English _locales/<lang>/messages.json in a build's
// output. Those two key namespaces are used exclusively by
// content/rule-editor.js and content/global-scanner.js (the "Edit rules for
// this site" and "Scan page for scripts/variables" picker panels) — kept
// English-only for now per explicit request (2026-08-29), while every other
// surface (dashboard, popup, blocked, element-picker) keeps full
// multi-language support.
//
// Deliberately a BUILD-time step, not a source-tree edit: the full
// translations stay intact in the repo's own _locales/, so this is easy to
// reverse later (just stop calling this script) without re-doing any
// translation work. Chrome's own chrome.i18n.getMessage() already falls
// back to default_locale (en) for any key missing from the active locale —
// same fallback shared/i18n.js's override wrapper does when a key is absent
// from the fetched override map — so removing these keys from a non-English
// messages.json is sufficient on its own; no code change needed in
// rule-editor.js/global-scanner.js or shared/i18n.js.
//
// Called by _build-lib.sh's copy_static_files, right after _locales/ is
// copied into the dist dir.
//
// Usage: node tools/strip-picker-only-locale-keys.js <dest-locales-dir>

const fs = require('fs');
const path = require('path');

const PICKER_ONLY_PREFIXES = ['ruleEditor_', 'scanner_'];

const localesDir = process.argv[2];
if (!localesDir) {
  console.error('Usage: node tools/strip-picker-only-locale-keys.js <dest-locales-dir>');
  process.exit(1);
}

if (!fs.existsSync(localesDir)) {
  console.error(`_locales/ not found at ${localesDir} — nothing to strip.`);
  process.exit(0);
}

let totalRemoved = 0;
let langsTouched = 0;

for (const lang of fs.readdirSync(localesDir).sort()) {
  if (lang === 'en') continue; // default_locale — keep every key
  const file = path.join(localesDir, lang, 'messages.json');
  if (!fs.existsSync(file)) continue;

  const messages = JSON.parse(fs.readFileSync(file, 'utf8'));
  let removed = 0;
  for (const key of Object.keys(messages)) {
    if (PICKER_ONLY_PREFIXES.some(prefix => key.startsWith(prefix))) {
      delete messages[key];
      removed++;
    }
  }
  if (removed > 0) {
    fs.writeFileSync(file, JSON.stringify(messages, null, 2) + '\n');
    totalRemoved += removed;
    langsTouched++;
  }
}

console.log(`  Stripped ruleEditor_*/scanner_* keys from ${langsTouched} non-English locale(s) (${totalRemoved} entries total) — those two panels stay English-only for now.`);
