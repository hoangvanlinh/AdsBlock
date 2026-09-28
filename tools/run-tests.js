'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
let failed = 0;
for (const name of fs.readdirSync(path.join(root, 'test')).filter(n => /^test-.*\.js$/.test(n)).sort()) {
  const result = spawnSync(process.execPath, [path.join(root, 'test', name)], { encoding: 'utf8', timeout: 60000 });
  if (result.status !== 0) {
    failed++;
    console.error(`FAIL ${name}\n${result.stdout || ''}${result.stderr || ''}${result.error || ''}`);
  } else {
    console.log(`PASS ${name}: ${(result.stdout || '').trim().split('\n').pop()}`);
  }
}
process.exitCode = failed ? 1 : 0;
