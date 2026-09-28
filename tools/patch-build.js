'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { walk } = require('./walk-dir');
const [directory, mode, providedToken] = process.argv.slice(2);
if (!directory || !['token', 'debug'].includes(mode)) throw Error('Usage: patch-build.js <directory> token|debug [token]');
if (mode === 'token') {
  const token = providedToken || crypto.randomBytes(12).toString('hex');
  let count = 0;
  for (const file of walk(directory).filter(file => file.endsWith('.js'))) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('__QKV1_BUILD_TOKEN__')) continue;
    fs.writeFileSync(file, text.replaceAll('__QKV1_BUILD_TOKEN__', token)); count++;
  }
  if (!count) throw Error('Build token placeholder missing: refusing to package an unpatched build');
} else {
  const file = path.join(directory, 'shared/config.js');
  const text = fs.readFileSync(file, 'utf8');
  if (!/DEBUG_LOCAL:\s*false/.test(text)) throw Error('DEBUG_LOCAL flag missing');
  fs.writeFileSync(file, text.replace(/DEBUG_LOCAL:\s*false/, 'DEBUG_LOCAL: true'));
}
