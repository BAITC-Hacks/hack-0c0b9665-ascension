// Run with PLAYWRIGHT_PATH=/path/to/playwright node tests/workspace-navigation.e2e.mjs.
// Every write goes to an isolated browser profile and temporary database.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createAppServer } from '../src/server.js';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const temp = await mkdtemp(join(tmpdir(), 'workspace-navigation-'));
const server = createAppServer({ deskOptions: { path: join(temp, 'test.sqlite') }, aiConfigured: () => false,
  explain: async () => ({ mode: 'deterministic', available: false, summary: 'Расчётное объяснение.', strengths: [], risks: [], recommendations: [] }) });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(); page.setDefaultTimeout(12000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
const visible = selector => page.locator(`${selector}:not([hidden])`).waitFor();
const count = value => page.waitForFunction(value => document.querySelector('#decision-count').textContent === String(value), value);
async function downloadText(selector) {
  const pending = page.waitForEvent('download'); await page.locator(selector).click();
  const file = await pending; return readFile(await file.path(), 'utf8');
}
async function widthCheck() { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Horizontal page overflow'); }
try {
  await page.goto(origin + '/#city'); await visible('#app'); await page.locator('#explorer-district').waitFor();
  assert.equal(await page.locator('.sidebar nav .nav-item').count(), 9);
  assert.equal(await page.locator('.sidebar a[href="#city"]').getAttribute('aria-current'), 'location');
  for (const path of ['/desk.html', '/akim.html', '/demo.html', '/resident.html', '/results.html']) assert.equal((await context.request.get(origin + path)).status(), 200);
  await page.locator('#catalog-search').fill('M12'); assert.equal(await page.locator('.measure-card').count(), 1);
  await page.locator('#catalog-search').fill('does-not-exist'); assert.equal(await page.locator('.measure-card').count(), 0);
  await page.locator('#catalog-clear').click(); assert.equal(await page.locator('.measure-card').count(), 14);
  await page.locator('#catalog-sort').selectOption('cost'); assert.equal(await page.locator('.measure-cost').first().innerText(), '10у. е.');
  await page.locator('#demo-button').click(); await count(5);
  await page.locator('#catalog-affordable').check(); assert.equal(await page.locator('.measure-card').count(), 0);
  await page.locator('#catalog-clear').click();
  await page.locator('[data-remove="M7"]').click(); await count(4);
  await page.locator('#undo-plan').click(); await count(5);
  await page.locator('#local-scenario-name').fill('Нура <вариант>'); await page.locator('#save-local-scenario').click();
  assert.equal(await page.locator('.library-item').count(), 1);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('akim-scenario-library-v1')));
  assert.equal(stored.schemaVersion, 1); assert.equal(stored.entries[0].modelId, 'official-astana-v1');
  await page.reload(); await count(5); assert.equal(await page.locator('.library-item strong').innerText(), 'Нура <вариант>');
  await page.locator('#simulate-button').click(); await visible('#result-actions');
  assert.equal(await page.locator('.score-value').innerText(), '56,54');
  assert.equal(await page.locator('#explorer-mode').inputValue(), 'comparison');
  assert.equal(await page.locator('#method-source').inputValue(), 'scenario');
  const result = JSON.parse(await downloadText('#export-result'));
  assert.ok(Math.abs(result.result.score - 56.54307) < 1e-10); assert.equal(result.scenario.decisions.length, 5);
  const csv = await downloadText('#export-indicators'); assert.equal(csv.trim().split('\r\n').length, 51);
  await page.locator('#share-result').click(); await visible('#share-link-field');
  const shared = await page.locator('#share-link').inputValue(); assert.ok(new URL(shared).searchParams.has('plan'));
  const reader = await context.newPage(); reader.on('pageerror', error => errors.push(error.message));
  await reader.goto(shared); await reader.locator('#result-actions:not([hidden])').waitFor();
  assert.equal(await reader.locator('.score-value').innerText(), '56,54');
  await reader.close();
  await page.evaluate(() => { window.print = () => { window.__printCalled = true; }; });
  await page.locator('#print-result').click();
  assert.equal(await page.evaluate(() => window.__printCalled), true);
  assert.match(await page.locator('#scenario-print-report').textContent(), /56,543/);
  await page.evaluate(() => dispatchEvent(new Event('afterprint')));
  await page.locator('#explorer-district').selectOption('nura'); await page.locator('#explorer-critical').check();
  assert.match(await page.locator('#indicator-table').innerText(), /Критических показателей.*нет/);
  await page.locator('#explorer-mode').selectOption('baseline'); assert.equal(await page.locator('#indicator-table td.critical').count(), 2);
  const districtCsv = await downloadText('[data-district-export]'); assert.equal(districtCsv.trim().split('\r\n').length, 3);
  await page.locator('#method-measure').selectOption('M11'); assert.match(await page.locator('#method-lag-breakdown').innerText(), /−1,75|-1,75/);
  await page.locator('[data-method-measure="M11"]').click();
  assert.equal(new URL(page.url()).hash, '#workspace'); assert.equal(await page.locator('.measure-highlight').getAttribute('data-measure'), 'M11');
  await page.route('**/api/validate', route => route.abort());
  await page.locator('[data-remove="M7"]').click(); await visible('#error-box'); await count(5);
  await page.unroute('**/api/validate');
  await page.locator('[data-remove="M7"]').click(); await count(4);
  assert.equal(await page.locator('#result-actions').isHidden(), true);
  assert.equal(await page.locator('#save-scenario').isDisabled(), true, 'Stale server snapshot must not be saveable');
  assert.equal(await page.locator('#method-source').inputValue(), 'baseline');
  await page.locator('#reset-button').click(); await count(0);
  await page.locator('[aria-label="Загрузить сценарий Нура <вариант>"]').click(); await count(5);
  await page.locator('#reset-button').click(); await count(0);
  await page.locator('[data-recommend-measure="M7"]').click();
  assert.equal(await page.locator('#district-M7').inputValue(), 'nura');
  await page.locator('[data-add="M7"]').click(); await count(1);
  await page.setViewportSize({ width: 390, height: 844 }); await widthCheck();
  await page.locator('#catalog-clear').click();
  await page.screenshot({ path: '/tmp/ascension-workspace-mobile.png', fullPage: true });
  await page.locator('.sidebar a[href="#method"]').click(); await widthCheck();
  await page.locator('#method').screenshot({ path: '/tmp/ascension-method-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#city').screenshot({ path: '/tmp/ascension-districts-desktop.png' });
  await page.evaluate(() => localStorage.setItem('ascension.workspace.draft.v1', '{broken'));
  await page.reload(); await visible('#app'); await count(0); assert.equal(await page.locator('#fatal-error').isHidden(), true);
  assert.deepEqual(errors, []);
  console.log('PASS: all nine links, catalog filters/sort, undo, draft restore, shared scenario repository, exact calculation, JSON/CSV/share/print, district filters/recommendations, methodology, failed mutation recovery, stale-result invalidation and mobile layout.');
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(temp, { recursive: true, force: true });
}
