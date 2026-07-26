#!/usr/bin/env node
// _js/inject-web-accessible-resources.js — lists every file in
// web_accessible_resources/ and merges "web_accessible_resources/<file>"
// into the FIRST web_accessible_resources[] entry of a build's manifest.json
// (same entry that already lists rule/site-rules.txt / blocked/blocked.html),
// so nobody has to hand-maintain that list as files are added/removed from
// the folder. Called by _build-lib.sh's copy_static_files, once the folder
// has already been copied into the dist dir and the manifest already copied
// to its destination path.
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

// README.txt is documentation, not a servable resource.
const files = fs.readdirSync(RESOURCES_DIR)
  .filter(f => f !== 'README.txt' && fs.statSync(path.join(RESOURCES_DIR, f)).isFile())
  .sort()
  .map(f => `web_accessible_resources/${f}`);

const manifest = JSON.parse(fs.readFileSync(destManifestPath, 'utf8'));
if (!Array.isArray(manifest.web_accessible_resources) || !manifest.web_accessible_resources.length) {
  manifest.web_accessible_resources = [{ resources: [], matches: ['http://*/*', 'https://*/*'], use_dynamic_url: true }];
}
const entry = manifest.web_accessible_resources[0];
const merged = new Set([...(entry.resources || []), ...files]);
entry.resources = [...merged].sort();

fs.writeFileSync(destManifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`  Injected ${files.length} web_accessible_resources/* file(s) into ${path.relative(ROOT, destManifestPath)}`);
