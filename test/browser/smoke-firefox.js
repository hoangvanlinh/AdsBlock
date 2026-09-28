'use strict';
const { Builder } = require('selenium-webdriver');
const firefox = require('selenium-webdriver/firefox');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { prepare, exercise } = require('./common');
(async () => {
  const fixture = await prepare('dist-firefox');
  let driver;
  try {
    const uuid = 'fea67e14-8544-45c9-9f09-a05c7928635c';
    const options = new firefox.Options().addArguments('-headless')
      .setPreference('extensions.webextensions.uuids', JSON.stringify({ 'adblock-ads-trackers@gitadblock': uuid }));
    if (process.env.FIREFOX_BINARY) options.setBinary(process.env.FIREFOX_BINARY);
    driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(new firefox.ServiceBuilder().addArguments('--allow-system-access')).build();
    await driver.manage().setTimeouts({ script: 30000, pageLoad: 30000 });
    const archive = path.join(fixture.temporary, 'extension.zip');
    execFileSync('zip', ['-qr', archive, '.'], { cwd: fixture.extension });
    await driver.installAddon(archive, true);
    const dashboardHandle = await driver.getWindowHandle();
    function adapter(handle) { return {
      async goto(url) {
        await driver.switchTo().window(handle);
        if (url.startsWith('moz-extension:')) {
          await driver.setContext(firefox.Context.CHROME);
          try {
            await driver.executeScript('gBrowser.selectedBrowser.loadURI(Services.io.newURI(arguments[0]), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });', url);
          } finally { await driver.setContext(firefox.Context.CONTENT); }
          await driver.wait(async () => (await driver.getCurrentUrl()) === url, 15000);
        } else await driver.get(url);
      },
      async evaluate(fn, arg) {
        await driver.switchTo().window(handle);
        const result = await driver.executeAsyncScript(`const done = arguments[arguments.length - 1]; Promise.resolve((${fn.toString()})(arguments[0])).then(value => done({value}), error => done({error: error.message}));`, arg === undefined ? null : arg);
        if (result.error) throw Error(result.error);
        return result.value;
      },
    }; }
    const dashboard = adapter(dashboardHandle);
    await dashboard.goto(`moz-extension://${uuid}/dashboard/dashboard.html`);
    await driver.switchTo().newWindow('tab');
    const page = adapter(await driver.getWindowHandle());
    await exercise({ dashboard, page, origin: fixture.origin, setSourceOffline: fixture.setSourceOffline });
  } finally { if (driver) await driver.quit(); await fixture.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
