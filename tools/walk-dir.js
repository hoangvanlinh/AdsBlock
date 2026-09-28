'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Recursively lists every file (not directory) under dir, absolute paths.
// Shared by patch-build.js and validate-build.js.
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}
module.exports = { walk };
