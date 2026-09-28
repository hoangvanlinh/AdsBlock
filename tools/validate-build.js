'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { walk } = require('./walk-dir');
function validate(directory, debug = false) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  function exists(relative) {
    if (!relative || !fs.existsSync(path.join(directory, relative))) throw Error(`Missing artifact: ${relative}`);
  }
  const required = [manifest.background?.service_worker, ...(manifest.background?.scripts || []), manifest.action?.default_popup,
    manifest.options_ui?.page, ...Object.values(manifest.icons || {}), ...Object.values(manifest.action?.default_icon || {}),
    ...(manifest.content_scripts || []).flatMap(entry => [...(entry.js || []), ...(entry.css || [])])].filter(Boolean);
  required.forEach(exists);
  const files = walk(directory);
  const relativeFiles = files.map(file => path.relative(directory, file).split(path.sep).join('/'));
  for (const group of manifest.web_accessible_resources || []) {
    for (const resource of group.resources) {
      const regex = new RegExp('^' + resource.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      if (!relativeFiles.some(file => regex.test(file))) throw Error(`Missing web resource: ${resource}`);
    }
  }
  for (const file of files) {
    if (file.endsWith('.js')) {
      const source = fs.readFileSync(file, 'utf8');
      if (source.includes('__QKV1_BUILD_TOKEN__')) throw Error(`Unpatched token: ${file}`);
      new vm.Script(source, { filename: file });
    }
    if (file.endsWith('.html')) {
      const html = fs.readFileSync(file, 'utf8');
      for (const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["']/g)) {
        if (/^(?:https?:|data:|#)/.test(match[1])) continue;
        exists(path.relative(directory, path.resolve(path.dirname(file), match[1])));
      }
    }
  }
  const sandbox = { self: {} };
  vm.runInNewContext(fs.readFileSync(path.join(directory, 'shared/config.js'), 'utf8'), sandbox);
  if (sandbox.self.ADBLOCK_CONFIG.DEBUG_LOCAL !== debug) throw Error('Unexpected DEBUG_LOCAL value');
  const english = JSON.parse(fs.readFileSync(path.join(directory, '_locales', manifest.default_locale, 'messages.json'), 'utf8'));
  for (const [, key] of JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)) if (!english[key]) throw Error(`Missing locale key: ${key}`);
  for (const file of files.filter(file => /_locales.*messages\.json$/.test(file))) JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`Validated ${directory} (${files.length} files)`);
}
if (require.main === module) validate(path.resolve(process.argv[2]), process.argv[3] === 'true');
module.exports = validate;
