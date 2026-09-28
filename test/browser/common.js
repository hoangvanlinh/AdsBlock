'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
async function prepare(target) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'adblock-smoke-'));
  const extension = path.join(temporary, 'extension');
  fs.cpSync(path.resolve('build', target), extension, { recursive: true });
  const state = { offline: false };
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url.startsWith('/smoke-block.js')) { res.setHeader('Content-Type', 'application/javascript'); return res.end('window.smokeAdLoaded = true;'); }
    if (req.url.startsWith('/rules')) {
      if (state.offline) { res.statusCode = 503; return res.end('temporarily unavailable'); }
      res.setHeader('Content-Type', 'text/plain');
      return res.end('[host_patterns]\n127.0.0.1 = smoke\n[smoke]\ndirect_hide_selectors = .smoke-ad');
    }
    if (req.url.startsWith('/meta')) { res.setHeader('Content-Type', 'application/json'); return res.end('{"version":"1.0.65"}'); }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><body><p id="legit">Article content</p><div class="smoke-ad">Sponsored</div></body></html>');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  // Only source endpoints are changed in this temporary copy. Runtime code is the release build.
  fs.appendFileSync(path.join(extension, 'shared/config.js'), `\nself.ADBLOCK_CONFIG.RULES_REMOTE_URL = [];\nself.ADBLOCK_CONFIG.EXTENSION_META_REMOTE_URL = '${origin}/meta';\nself.ADBLOCK_CONFIG.EXTENSION_META_REMOTE_URL_FIREFOX = '${origin}/meta';\n`);
  return { temporary, extension, origin, setSourceOffline() { state.offline = true; }, async cleanup() { await new Promise(resolve => server.close(resolve)); fs.rmSync(temporary, { recursive: true, force: true }); } };
}
async function until(fn, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error(`Timed out: ${label}`);
}
async function exercise({ dashboard, page, origin, setSourceOffline }) {
  const send = message => dashboard.evaluate(async msg => {
    const result = await (globalThis.browser || chrome).runtime.sendMessage(msg);
    if (!result?.ok) throw Error(result?.error || 'Message failed');
    return result;
  }, message);
  await dashboard.evaluate(async origin => {
    const api = globalThis.browser || chrome;
    await api.storage.local.set({ enabled: true, defaultRuleSourceEnabled: false,
      customRulesText: '', ruleSources: [{ type: 'url', enabled: true, url: origin + '/rules' }],
      rules: [{ active: true, action: 'block', type: 'keyword', pattern: '/smoke-block.js' }] });
  }, origin);
  await send({ type: 'RULES_CHANGED' });
  await page.goto(origin);
  const adHidden = () => page.evaluate(() => { const ad = document.querySelector('.smoke-ad'); return !ad || getComputedStyle(ad).display === 'none'; });
  await until(adHidden, 'initial cosmetic filtering');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('legit')).display !== 'none'), true);
  const blocked = () => page.evaluate(async () => { try { await fetch('/smoke-block.js?time=' + Date.now()); return false; } catch { return true; } });
  assert.equal(await blocked(), true, 'network rule blocks a real request');
  await page.evaluate(() => { history.pushState({}, '', '/spa'); const ad = document.createElement('div'); ad.className = 'smoke-ad'; ad.textContent = 'SPA sponsored'; document.body.appendChild(ad); });
  await until(() => page.evaluate(() => [...document.querySelectorAll('.smoke-ad')].every(ad => getComputedStyle(ad).display === 'none')), 'SPA cosmetic filtering');
  await send({ type: 'PAUSE_DOMAIN', domain: '127.0.0.1', paused: true });
  await page.goto(origin + '/paused');
  assert.equal(await blocked(), false, 'pause allows real requests');
  await send({ type: 'PAUSE_DOMAIN', domain: '127.0.0.1', paused: false });
  await page.goto(origin + '/resumed');
  assert.equal(await blocked(), true);
  await send({ type: 'TOGGLE', enabled: false });
  assert.equal(await blocked(), false);
  await send({ type: 'TOGGLE', enabled: true });
  assert.equal(await blocked(), true);
  await send({ type: 'SET_PRIVACY', setting: 'gpcSignal', value: true });
  await send({ type: 'TOGGLE', enabled: false });
  await send({ type: 'TOGGLE', enabled: true });
  assert.equal(await dashboard.evaluate(async () => (await (globalThis.browser || chrome).declarativeNetRequest.getDynamicRules()).some(rule => rule.id === 400001)), true, 'privacy survives a complete rule rebuild');
  await send({ type: 'SET_PRIVACY', setting: 'gpcSignal', value: false });
  setSourceOffline();
  await send({ type: 'RULES_CHANGED' });
  const staleConfig = await dashboard.evaluate(() => (globalThis.browser || chrome).runtime.sendMessage({ type: 'GET_SITE_CONFIG', host: '127.0.0.1' }));
  assert.equal(staleConfig.siteKey, 'smoke', 'failed source retains last successful rules from CacheStorage');
  await dashboard.evaluate(async () => { const api = globalThis.browser || chrome; const { ruleSources } = await api.storage.local.get('ruleSources'); ruleSources[0].enabled = false; await api.storage.local.set({ ruleSources }); });
  await send({ type: 'RULES_CHANGED' });
  const disabledConfig = await dashboard.evaluate(() => (globalThis.browser || chrome).runtime.sendMessage({ type: 'GET_SITE_CONFIG', host: '127.0.0.1' }));
  assert.equal(disabledConfig.siteKey, '', 'disabled source does not reappear from its cache');
  const invalid = await dashboard.evaluate(() => (globalThis.browser || chrome).runtime.sendMessage({ type: 'SET_BLOCKING', setting: 'blockAds', value: 'false' }));
  assert.equal(invalid.ok, false);
  console.log('PASS browser: startup, real DNR, per-site pause/resume, toggle, privacy, CSS, SPA, cached source fallback, source disable, message errors');
  return { send, blocked };
}
module.exports = { prepare, exercise, until };
