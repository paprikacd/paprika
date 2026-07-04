import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
mkdirSync('/Users/benebsworth/projects/paprika/docs/design', { recursive: true });

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

async function snap(url, file) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));
    await page.screenshot({ path: file, fullPage: true });
    console.log('saved:', file);
  } catch (e) {
    console.error('FAILED:', url, e.message);
  }
}

await snap('http://localhost:3333/', '/Users/benebsworth/projects/paprika/docs/design/landing-before.png');
await snap('http://localhost:3333/login', '/Users/benebsworth/projects/paprika/docs/design/login-before.png');
await snap('http://localhost:3333/dashboard', '/Users/benebsworth/projects/paprika/docs/design/dashboard-before.png');

await browser.close();
