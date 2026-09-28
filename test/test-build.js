'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const validate = require('../tools/validate-build');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'adblock-build-test-'));
const buildRoot = path.join(temporary, 'build');
function build(...args) {
  const result = spawnSync('bash', ['build-chrome.sh', ...args], { cwd: root, env: { ...process.env, ADBLOCK_BUILD_ROOT: buildRoot }, encoding: 'utf8', timeout: 60000 });
  if (result.status !== 0) throw Error(result.stderr || result.stdout || result.error);
}
try {
  const obfuscatedDirectory = path.join(temporary, 'src-obfuscated');
  fs.mkdirSync(obfuscatedDirectory);
  const probe = path.join(obfuscatedDirectory, 'probe.js');
  fs.writeFileSync(probe, 'globalThis.answer = 6 * 7;');
  execFileSync(process.execPath, [path.join(root, 'tools/obfuscate-file.js'), probe]);
  const sandbox = {};
  require('node:vm').runInNewContext(fs.readFileSync(probe, 'utf8'), sandbox);
  assert.equal(sandbox.answer, 42, 'obfuscation supports paths containing -obfuscated');
  build('false', 'true', 'true');
  const directory = path.join(buildRoot, 'dist');
  const source = fs.readFileSync(path.join(directory, 'content/scriptlets.js'), 'utf8');
  assert.equal(source.includes('__QKV1_BUILD_TOKEN__'), false);
  assert.equal(fs.readFileSync(path.join(buildRoot, 'src-obfuscated/content/scriptlets.js'), 'utf8'), source, 'export and artifact share the same bridge token');
  validate(directory, true);
  fs.writeFileSync(path.join(directory, 'obsolete.txt'), 'old build');
  execFileSync('zip', ['-q', path.join(buildRoot, 'adblock-extension.zip'), 'obsolete.txt'], { cwd: directory });
  build('false', 'false', 'true');
  const entries = execFileSync('unzip', ['-Z1', path.join(buildRoot, 'adblock-extension.zip')], { encoding: 'utf8' });
  assert.equal(entries.includes('obsolete.txt'), false, 'ZIP must not retain removed files from older builds');
  const invalid = spawnSync('bash', ['build-chrome.sh', 'invalid'], { cwd: root, env: { ...process.env, ADBLOCK_BUILD_ROOT: buildRoot } });
  assert.notEqual(invalid.status, 0);
  assert.ok(fs.existsSync(path.join(directory, 'manifest.json')), 'invalid args must not remove previous output');
  fs.unlinkSync(path.join(directory, 'shared/settings-ui.js'));
  assert.throws(() => validate(directory, true), /Missing artifact/);
  console.log('PASS build: portable patches, matching export token, clean ZIP, early argument validation, missing asset rejection');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
