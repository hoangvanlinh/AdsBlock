'use strict';
const fs = require('node:fs');
const obfuscator = require('javascript-obfuscator');
const file = process.argv[2];
if (!file) throw Error('Usage: obfuscate-file.js <file.js>');
// The CLI excludes any path containing "-obfuscated", including parent directories.
// The API operates on source text and supports our arbitrary build/export paths.
const source = fs.readFileSync(file, 'utf8');
const result = obfuscator.obfuscate(source, {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.2,
  stringArray: true,
  stringArrayEncoding: ['rc4'],
  stringArrayThreshold: 0.75,
  renameGlobals: false,
  selfDefending: false,
  identifierNamesGenerator: 'hexadecimal',
});
fs.writeFileSync(file, result.getObfuscatedCode());
