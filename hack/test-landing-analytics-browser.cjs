// Local-only browser contract. Every URL is fulfilled from disk or aborted.
// No real Google endpoint receives data; this is not GA DebugView validation.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '../ui/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '../landing');
const origin = 'https://paprikacd.github.io';
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? {channel: process.env.PLAYWRIGHT_CHANNEL} : {}) });
  try {
    for (const width of [390, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      let vendors = 0;
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) {
          if (url.hostname === 'www.googletagmanager.com') vendors++;
          return route.abort();
        }
        if (url.pathname === '/paprika/analytics-config.js') return route.fulfill({contentType: 'text/javascript', body: 'window.PAPRIKA_ANALYTICS={enabled:true,origin:"https://paprikacd.github.io",gaMeasurementId:"G-TEST123",gaPrivacyReviewed:true}'});
        if (!url.pathname.startsWith('/paprika/')) return route.abort();
        const relative = url.pathname.slice('/paprika/'.length) || 'index.html';
        if (relative.includes('..')) return route.abort();
        const file = path.join(root, relative);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.abort();
        const contentType = relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.html') ? 'text/html' : 'application/octet-stream';
        return route.fulfill({contentType, body: fs.readFileSync(file)});
      });
      await page.goto(origin + '/paprika/');
      assert.equal(vendors, 0);
      await page.getByRole('button', {name:'Keep Google Analytics off'}).click();
      assert.equal(vendors, 0);
      await page.getByRole('button', {name:'Allow Google Analytics'}).click();
      await page.waitForTimeout(50);
      assert.equal(vendors, 1);
      assert.equal(await page.evaluate(() => window.dataLayer.filter(e => e[0] === 'event').length), 1);
      await page.getByRole('button', {name:'Turn Google Analytics off'}).click();
      await page.waitForLoadState();
      assert.equal(vendors, 1);
      await page.locator('#paprika-analytics-choice').scrollIntoViewIfNeeded();
      if (process.env.SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR, `paprika-analytics-${width}.png`)});
      await page.close();
    }
    console.log('Browser PASS: mobile/desktop consent, denial, withdrawal/reload; vendor requests blocked.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
