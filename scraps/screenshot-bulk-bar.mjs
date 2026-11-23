import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';

const HTML = `file:///home/user/NUEVA-EPS/Editor_RIPS.html`;
const RIPS = '/root/.claude/uploads/d4b34822-0380-517a-ab4d-ae681926a7b6/55724d74-860035992_11492424_rips.json';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newContext({ viewport: { width: 1600, height: 900 } }).then(c => c.newPage());
await page.addInitScript(() => {
  const fp = function () { return { destroy(){}, setDate(){}, clear(){} }; };
  fp.l10ns = { es: {} };
  window.flatpickr = fp;
});
await page.goto(HTML, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__bulkAuth, null, { timeout: 10000 });

const raw = JSON.parse(readFileSync(RIPS, 'utf-8'));
await page.evaluate((f) => {
  const api = window.__bulkAuth;
  api.editorState.files['qa-0'] = {
    name: f.name, raw: f.raw, rows: api.buildRows(f.raw), modified: false,
  };
  api.editorState.activeFile = 'qa-0';
  api.renderSidebar();
  api.renderMain();
  // Seleccionamos todo lo visible
  const cb = document.getElementById('checkAll');
  if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
}, { name: '11492424_rips.json', raw });

await page.waitForTimeout(600);
// Localizamos el bulk-panel y le tomamos una foto directa.
const panel = await page.locator('#bulkPanel').first();
await panel.scrollIntoViewIfNeeded();
await panel.screenshot({ path: '/home/user/NUEVA-EPS/screenshots/bulk-bar-nuevo.png' });
await browser.close();
console.log('ok');
