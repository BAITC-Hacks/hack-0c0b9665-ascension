/** Queue tools acceptance; uses only a disposable local fixture. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createAppServer } from '../src/server.js';
import { openStore, passwordHash } from '../src/desk/store.js';
import { csvCell, csvDocument } from '../public/staff-export.js';

assert.equal(csvCell(' =SUM(A1)'), '"\' =SUM(A1)"');
assert.equal(csvCell('Текст; "кавычки"'), '"Текст; ""кавычки"""');
assert.ok(csvDocument([['Адрес', 'Описание']]).startsWith('\uFEFF'));

const modulePath = process.env.PLAYWRIGHT_MODULE || pathToFileURL('/Users/mira/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href;
const { chromium } = await import(modulePath);
const dir = await mkdtemp(join(tmpdir(), 'staff-queue-'));
const dbPath = join(dir, 'fixture.sqlite');
const db = openStore(dbPath);
db.prepare('INSERT INTO users VALUES(?,?,?)').run('queue-admin', passwordHash('test-queue-password'), 'admin');
db.close();
const server = createAppServer({ deskOptions: { path: dbPath } });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const baseURL = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
async function request(path, body, method = 'POST') {
  const response = await page.request.fetch(baseURL + path, { method, headers: { 'X-Desk-Request': '1' }, data: body });
  assert.ok(response.ok(), await response.text());
  return response.json();
}
async function download(button) {
  const pending = page.waitForEvent('download');
  await button.click();
  const result = await pending;
  return readFile(await result.path(), 'utf8');
}
try {
  await request('/api/desk/login', { login: 'queue-admin', password: 'test-queue-password' });
  for (let n = 1; n <= 12; n++) await request('/api/desk/complaints', { submissionId: `queue-${n}`, text: n === 1 ? '=FORMULA() проверка CSV' : `Выгрузка обращения ${n}`, category: 'safety', districtId: 'nura', address: 'Тестовый адрес' });
  await request('/api/desk/complaints', { submissionId: 'excluded', text: 'Другой район', category: 'other', districtId: 'esil' });
  await page.goto(baseURL + '/desk.html?districtId=nura');
  await page.waitForFunction(() => document.querySelector('#filter-summary')?.textContent.includes('из 12'));
  const csv = await download(page.locator('#export'));
  assert.equal(csv.split('\r\n').length, 13);
  assert.ok(csv.includes("'=FORMULA() проверка CSV"));
  assert.ok(!csv.includes('Другой район'));
  await page.locator('[data-status="new"]').click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get('status') === 'new');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#filters [name="districtId"]')?.value === 'nura');
  assert.equal(await page.locator('#filters [name="status"]').inputValue(), 'new');
  await page.locator('#clear').click();
  await page.waitForFunction(() => !new URL(location.href).searchParams.has('districtId'));
  await page.goto(baseURL + '/akim.html?complaint=1#problems');
  await page.locator('#action-dialog[open]').waitFor();
  assert.match(await page.locator('#action-dialog').innerText(), /Карточка обращения #1/);
  await page.locator('#action-dialog [data-action="close-dialog"]').first().click();
  await page.locator('[data-action="clear-filters"]').click();
  await page.locator('[data-queue-sort]').selectOption('oldest');
  await page.waitForFunction(() => document.querySelector('#view .panel .complaint-check')?.dataset.selectComplaint === '1');
  const cabinetCsv = await download(page.locator('[data-action="export-queue"]'));
  assert.equal(cabinetCsv.split('\r\n').length, 14);
  assert.match(cabinetCsv.split('\r\n')[1], /^"1";/);
  await page.locator('[data-action="complaint-detail"][data-id="1"]').first().click();
  await page.locator('#action-dialog [data-action="create-task"]').click();
  await page.locator('#action-form [name="expectedResult"]').fill('Черновик, который нельзя потерять');
  page.once('dialog', prompt => prompt.dismiss());
  await page.locator('#action-dialog [data-action="close-dialog"]').first().click();
  assert.equal(await page.locator('#action-form [name="expectedResult"]').inputValue(), 'Черновик, который нельзя потерять');
  page.once('dialog', prompt => prompt.accept());
  await page.locator('#action-dialog [data-action="close-dialog"]').first().click();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/desk.html', '/akim.html#problems', '/akim.html#tasks']) {
    await page.goto(baseURL + path);
    await page.waitForFunction(() => !!document.querySelector('#workspace:not([hidden]), .queue-tools'));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), path);
  }
  assert.deepEqual(pageErrors, []);
  console.log('PASS queue exports include all pages, escape CSV formulas, preserve filter URLs, deep-link cards, sort, protect drafts and fit 390px.');
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
