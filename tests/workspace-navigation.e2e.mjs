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
let simulationRequests = 0;
page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/simulate') simulationRequests++; });
const sectionLinks = ['#map-section', '#workspace', '#city', '#results', '#policy-options-panel', '#comparison-panel', '#scenario-library', '#method', '#decision-brief', '#action-register-panel', '#evidence-register-panel'];
const pageLinks = ['/citizens.html', '/mayor.html', '/desk.html', '/akim.html', '/demo.html', '/resident.html', '/results.html'];
const visible = selector => page.locator(`${selector}:not([hidden])`).waitFor();
const count = value => page.waitForFunction(value => document.querySelector('#decision-count').textContent === String(value), value);
const savedCard = () => page.locator('#scenario-library .library-item').filter({ has: page.getByRole('heading', { name: 'Нура <вариант>', exact: true }) });
async function downloadText(selector) {
  const pending = page.waitForEvent('download'); await page.locator(selector).click();
  const file = await pending; return readFile(await file.path(), 'utf8');
}
async function widthCheck() { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Horizontal page overflow'); }
try {
  await page.goto(origin + '/#city'); await visible('#app'); await page.locator('#explorer-district').waitFor();
  const navigation = await page.locator('.sidebar nav .nav-item').evaluateAll(links => links.map(link => link.getAttribute('href')));
  assert.deepEqual(navigation.sort(), [...sectionLinks, ...pageLinks].sort(), 'Every release section and page must have one sidebar entry');
  for (const target of sectionLinks) assert.equal(await page.locator(target).count(), 1, `One section must exist for ${target}`);
  assert.equal(await page.locator('.sidebar a[href="#city"]').getAttribute('aria-current'), 'location');
  for (const path of ['/', ...pageLinks]) {
    const response = await context.request.get(origin + path);
    assert.equal(response.status(), 200, path);
    assert.match(response.headers()['content-type'], /^text\/html\b/, path);
    assert.match(await response.text(), /<title>[^<]+<\/title>/, `${path} must serve a titled page`);
  }
  assert.equal(await page.locator('#scenario-library .scenario-library-root').count(), 1, 'The scenario library must mount once');
  assert.equal(await page.locator('#local-scenario-form').count(), 1, 'There must be one local save form');
  await page.locator('#catalog-search').fill('M12'); assert.equal(await page.locator('.measure-card').count(), 1);
  await page.locator('#catalog-search').fill('does-not-exist'); assert.equal(await page.locator('.measure-card').count(), 0);
  await page.locator('#catalog-clear').click(); assert.equal(await page.locator('.measure-card').count(), 14);
  await page.locator('#catalog-sort').selectOption('cost'); assert.equal(await page.locator('.measure-cost').first().innerText(), '10у. е.');
  const beforeDemo = simulationRequests;
  await page.getByRole('button', { name: 'Запустить демо', exact: true }).click(); await count(5); await visible('#result-actions');
  await page.waitForFunction(() => !document.getElementById('demo-button').disabled);
  assert.equal(simulationRequests - beforeDemo, 1, 'One demo click must produce exactly one calculation');
  assert.equal(await page.locator('.score-value').innerText(), '56,54');
  assert.match(await page.locator('#scenario-action-status').innerText(), /Демо рассчитано/);
  await page.locator('#catalog-affordable').check(); assert.equal(await page.locator('.measure-card').count(), 0);
  await page.locator('#catalog-clear').click();
  await page.locator('[data-remove="M7"]').click(); await count(4);
  await page.locator('#undo-plan').click(); await count(5);
  await page.locator('#local-scenario-name').fill('Нура <вариант>'); await page.locator('#save-local-scenario').click();
  assert.equal(await page.locator('#scenario-library .library-item').count(), 1);
  assert.equal(await savedCard().count(), 1);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('akim-scenario-library-v1')));
  assert.equal(stored.schemaVersion, 1); assert.equal(stored.entries[0].modelId, 'official-astana-v1');
  assert.equal(stored.entries[0].snapshot, null, 'The edited plan must not retain a stale calculated snapshot');
  await page.reload(); await count(5); assert.equal(await savedCard().getByRole('heading').innerText(), 'Нура <вариант>');
  assert.equal(await page.locator('#scenario-library .scenario-library-root').count(), 1);
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
  await page.route('**/api/validate', route => route.abort());
  await page.locator('#reset-button').click(); await count(0);
  assert.equal(await page.locator('#error-box').isHidden(), true, 'Reset must work without server validation');
  assert.equal(await page.locator('#result-actions').isHidden(), true);
  assert.equal(await page.locator('#save-scenario').isDisabled(), true);
  assert.equal(await savedCard().count(), 1, 'Reset must preserve the saved library');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('ascension.workspace.draft.v1')).decisions), [], 'Reset must clear the persisted draft');
  await page.unroute('**/api/validate');
  await savedCard().getByRole('button', { name: 'Загрузить в план', exact: true }).click(); await count(5);
  assert.equal(await page.locator('#result-actions').isHidden(), true, 'A loaded plan requires a fresh calculation');
  await page.locator('#reset-button').click(); await count(0);
  await page.locator('[data-recommend-measure="M7"]').click();
  assert.equal(await page.locator('#district-M7').inputValue(), 'nura');
  await page.locator('[data-add="M7"]').click(); await count(1);
  await page.locator('[data-district-reset]').click();
  await page.locator('#explorer-mode').selectOption('baseline');
  for (const width of [320, 390, 645]) {
    await page.setViewportSize({ width, height: 844 }); await widthCheck();
    await page.locator('.method-calculation-details summary').click(); await widthCheck();
    await page.locator('#city .table-scroll').evaluate(element => { element.scrollLeft = element.scrollWidth; }); await widthCheck();
    await page.locator('.method-calculation-details summary').click(); await widthCheck();
  }
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
  console.log('PASS: all 18 navigation links and 8 pages, one-click demo calculation, catalog filters/sort, undo, draft restore, single scenario library, exact calculation, JSON/CSV/share/print, district filters/recommendations, methodology, failed mutation recovery, offline reset preserving saved plans, stale-result invalidation and mobile layout.');
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(temp, { recursive: true, force: true });
}
