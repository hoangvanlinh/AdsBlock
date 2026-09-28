'use strict';
const { chromium } = require('playwright');
const path = require('node:path');
const assert = require('node:assert/strict');
const { prepare, exercise, until } = require('./common');
(async () => {
  const fixture = await prepare('dist');
  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(fixture.temporary, 'profile'), { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${fixture.extension}`, `--load-extension=${fixture.extension}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const dashboard = await context.newPage();
    await dashboard.goto(`chrome-extension://${id}/dashboard/dashboard.html`);
    const page = await context.newPage();
    const { blocked } = await exercise({ dashboard, page, origin: fixture.origin, setSourceOffline: fixture.setSourceOffline });
    // Real quota error through popup/dashboard bridge: no mock of the controller itself.
    await worker.evaluate(() => { self.__originalSet = chrome.storage.local.set; chrome.storage.local.set = async () => { throw Error('smoke quota'); }; });
    await dashboard.evaluate(() => document.getElementById('globalToggle').click());
    await until(() => dashboard.evaluate(() => !!document.querySelector('[role="alert"]')?.textContent), 'visible save error');
    assert.equal(await dashboard.evaluate(() => document.getElementById('globalToggle').checked), true);
    await worker.evaluate(() => { chrome.storage.local.set = self.__originalSet; delete self.__originalSet; });
    // CDP stops the extension worker; the next message must wake it with saved state intact.
    const cdp = await context.newCDPSession(dashboard);
    let versions = [];
    cdp.on('ServiceWorker.workerVersionUpdated', event => { versions = event.versions; });
    await cdp.send('ServiceWorker.enable');
    await until(() => Promise.resolve(versions.some(v => v.scriptURL.includes(id) && v.status === 'activated')), 'worker version');
    const version = versions.find(v => v.scriptURL.includes(id) && v.status === 'activated');
    await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
    await dashboard.reload();
    const result = await dashboard.evaluate(() => chrome.runtime.sendMessage({ type: 'TOGGLE', enabled: true }));
    assert.equal(result.ok, true); assert.equal(await blocked(), true);
    console.log('PASS Chromium: visible storage error, worker restart preserves blocking');
  } finally { if (context) await context.close(); await fixture.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
