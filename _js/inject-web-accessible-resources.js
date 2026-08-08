#!/usr/bin/env node
// _js/inject-web-accessible-resources.js — merges a single
// "web_accessible_resources/*" wildcard into the FIRST web_accessible_resources[]
// entry of a build's manifest.json (same entry that already lists
// rule/site-rules.txt / blocked/blocked.html). A wildcard (Chrome MV3 supports
// '*' in the resources list) keeps individual stub filenames — which reveal
// exactly which ad/tracker vendors are being spoofed (doubleclick, google-
// analytics, googlesyndication...) — out of the manifest, unlike enumerating
// every file by name. Called by _build-lib.sh's copy_static_files, once the
// folder has already been copied into the dist dir and the manifest already
// copied to its destination path.
//
// Usage: node _js/inject-web-accessible-resources.js <dest-manifest.json>

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RESOURCES_DIR = path.join(ROOT, 'web_accessible_resources');

const destManifestPath = process.argv[2];
if (!destManifestPath) {
  console.error('Usage: node _js/inject-web-accessible-resources.js <dest-manifest.json>');
  process.exit(1);
}

if (!fs.existsSync(RESOURCES_DIR)) {
  console.error(`web_accessible_resources/ not found at ${RESOURCES_DIR} — nothing to inject.`);
  process.exit(0);
}

const WILDCARD = 'web_accessible_resources/*';

const manifest = JSON.parse(fs.readFileSync(destManifestPath, 'utf8'));
if (!Array.isArray(manifest.web_accessible_resources) || !manifest.web_accessible_resources.length) {
  manifest.web_accessible_resources = [{ resources: [], matches: ['http://*/*', 'https://*/*'], use_dynamic_url: true }];
}
const entry = manifest.web_accessible_resources[0];
// Drop any previously-enumerated per-file entries from older builds — the
// wildcard alone covers them.
const kept = (entry.resources || []).filter(r => !r.startsWith('web_accessible_resources/'));
entry.resources = [...kept, WILDCARD].sort();

fs.writeFileSync(destManifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`  Injected ${WILDCARD} into ${path.relative(ROOT, destManifestPath)}`);
