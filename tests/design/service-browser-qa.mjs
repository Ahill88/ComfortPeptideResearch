import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const temp = '/var/folders/v9/840n4c810px9_kxb2ntl2xt00000gn/T/opencode';
const { chromium } = createRequire(`${process.env.QA_TOOLS || `${temp}/browser-qa-tools`}/package.json`)('playwright');
const output = `${temp}/service-browser-qa-${Date.now()}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.QA_BROWSER || undefined });
const results = [];
try {
  for (const [name, url] of [['api-docs', 'http://localhost:3001/docs'], ['admin', 'http://localhost:3002']]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const response = await page.goto(url, { waitUntil: 'networkidle' });
    await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
    const text = await page.locator('body').innerText();
    const accessDenied = name === 'admin' && text.includes('Access denied') && text.includes('Operational dashboard access is not configured');
    const rendered = name === 'api-docs' ? text.includes('Helix & Field API') : /sign in/i.test(text) || accessDenied;
    results.push({ name, status: response.status(), finalURL: page.url(), rendered, accessDenied, errors, text });
    await page.close();
  }
} finally {
  await browser.close();
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ output, results }, null, 2));
  if (results.some(r => r.status >= 400 || !r.rendered || r.errors.length)) process.exitCode = 1;
}
