/**
 * Browser acceptance for the akim cabinet.
 * Runs against an ephemeral HTTP port and an isolated, disposable SQLite DB.
 * Run: node tests/akim-ui.e2e.mjs
 * Optional: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_EXECUTABLE=/path/to/chrome
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createAppServer } from '../src/server.js';
import { openStore, passwordHash } from '../src/desk/store.js';
import { getDataset } from '../src/core/simulator.js';

const bundledPlaywright = '/Users/mira/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const playwrightModule = process.env.PLAYWRIGHT_MODULE || (existsSync(bundledPlaywright) ? pathToFileURL(bundledPlaywright).href : 'playwright');
const { chromium } = await import(playwrightModule);
const temp = await mkdtemp(join(tmpdir(), 'akim-ui-'));
const screenshots = process.env.AKIM_SCREENSHOTS || join(temp, 'screenshots');
await mkdir(screenshots, { recursive: true });
const databasePath = join(temp, 'fixture.sqlite');
const db = openStore(databasePath);
const password = 'Acceptance-only-password-2026';
for (const [login, role] of [['mayor', 'admin'], ['operator', 'operator']]) db.prepare('INSERT INTO users VALUES(?,?,?)').run(login, passwordHash(password), role);
const today = new Date();
const ago = days => new Date(today.getTime() - days * 86400000).toISOString();
const futureDate = days => new Date(today.getTime() + days * 86400000).toISOString().slice(0, 10);
const districtId = getDataset().districts[0].id;
const complaints = [
  { id: 1, text: 'Не работает светофор у школы № 17', address: 'улица Достык, 10', category: 'safety', districtId, priority: 'high', days: 4 },
  { id: 2, text: 'У школы № 17 не работает тот же светофор', address: 'улица Достык, 10', category: 'safety', districtId, priority: 'normal', days: 2 },
  { id: 3, text: 'Открытый люк рядом с детской площадкой', address: 'улица Кунаева, 8', category: 'safety', districtId: getDataset().districts[1].id, priority: 'high', days: 0 },
  { id: 4, text: '<img src=x onerror="window.__akimXss=true"> Не горит уличный фонарь', address: 'Адрес требует уточнения', category: 'services', districtId: null, priority: 'normal', days: 1 },
  { id: 5, text: 'Контейнерная площадка очищена', address: 'улица Сауран, 3', category: 'ecology', districtId, priority: 'normal', days: 3, status: 'resolved' },
];
for (const seed of complaints) {
  const { days, ...fields } = seed;
  const item = { ...fields, status: fields.status || 'new', source: 'demo', version: 1, assignee: '', createdAt: ago(days), updatedAt: ago(days), history: [{ at: ago(days), actor: 'operator', text: 'Демонстрационное обращение' }], replies: [], attachments: [] };
  db.prepare('INSERT INTO complaints(id,submission,fingerprint,data) VALUES(?,?,?,?)').run(item.id, `qa-${item.id}`, `fixture-${item.id}`, JSON.stringify(item));
}
db.exec('CREATE TABLE IF NOT EXISTS akim_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)');
const seedTasks = [
  { id: 1, title: 'Обезопасить открытый люк', complaintIds: [3], dueDate: ago(1).slice(0, 10), status: 'assigned', watchers: ['mayor'], reports: [] },
  { id: 2, title: 'Проверить восстановление освещения', complaintIds: [4], dueDate: futureDate(2), status: 'reported', watchers: [], reports: [{ at: ago(0), actor: 'operator', text: 'Освещение восстановлено; требуется проверка на месте.', beforeAttachmentIds: [], afterAttachmentIds: [] }] },
];
for (const seed of seedTasks) {
  const task = { ...seed, assignee: 'operator', expectedResult: 'Устранить угрозу безопасности и приложить подтверждение.', version: 1, createdBy: 'mayor', createdAt: ago(4), updatedAt: ago(0), verification: null, reportRequests: [], history: [{ at: ago(4), actor: 'mayor', action: 'create', text: 'Поручение создано' }] };
  db.prepare('INSERT INTO akim_tasks(id,data) VALUES(?,?)').run(task.id, JSON.stringify(task));
}
db.close();
const server = createAppServer({ deskOptions: { path: databasePath, secure: false } });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const baseURL = `http://127.0.0.1:${server.address().port}`;
const chrome = process.env.CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 }, locale: 'ru-RU' });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('dialog', dialog => dialog.accept());
let failures = 0;
async function step(name, callback) {
  try { await callback(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.stack || error}`); await page.screenshot({ path: join(screenshots, `failure-${failures}.png`), fullPage: true }).catch(() => {}); }
}
async function api(path, body, method = body === undefined ? 'GET' : 'POST', client = context.request) {
  const response = await client.fetch(path, { method, headers: { 'X-Desk-Request': '1' }, ...(body === undefined ? {} : { data: body }) });
  const result = await response.json();
  assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${JSON.stringify(result)}`);
  return result;
}
async function login(targetPage = page, loginName = 'mayor', cabinet = true) {
  await targetPage.goto(cabinet ? '/akim.html' : '/desk.html');
  await targetPage.locator('#login-form input[name="login"]').fill(loginName);
  await targetPage.locator('#login-form input[name="password"]').fill(password);
  await targetPage.locator('#login-form button').click();
  await targetPage.locator(cabinet ? '.layout' : '#workspace').waitFor({ state: 'visible' });
}


const gotoTab = (name, targetPage = page) => targetPage.locator(`.nav [data-action="tab"][data-tab="${name}"]`).click();
async function reloadCabinet(targetPage = page) { await targetPage.reload(); await targetPage.locator('.layout').waitFor(); }
async function screenshot(name, targetPage = page) { await targetPage.screenshot({ path: join(screenshots, `${name}.png`), fullPage: false }); }
async function assertNoOverflow(targetPage = page) {
  const sizes = await targetPage.evaluate(() => ({ document: document.documentElement.scrollWidth, body: document.body.scrollWidth, viewport: innerWidth }));
  assert.ok(Math.max(sizes.document, sizes.body) <= sizes.viewport + 1, `Horizontal overflow: ${JSON.stringify(sizes)}`);
}
async function closeDialog(targetPage = page) {
  if (await targetPage.locator('#action-dialog').isVisible()) await targetPage.locator('#action-dialog [data-action="close-dialog"]').first().click();
}
async function submitAction(targetPage = page) {
  await targetPage.locator('#action-form button[type="submit"]').click();
}

async function decisionsAcceptance() {
  const workbench = page.locator('.ad-workbench');
  await workbench.waitFor();
  await workbench.locator('[data-complaint]').selectOption('1');
  for (const [index, measure] of ['M7', 'M8', 'M10', 'M12', 'M5'].entries()) {
    if (measure !== 'M12') await workbench.locator(`[data-pick="${measure}"]`).selectOption(measure === 'M5' ? 'saryarka' : 'nura');
    await workbench.locator(`[data-add="${measure}"]`).click();
    await workbench.locator('.ad-plan ol li').nth(index).waitFor();
  }
  await workbench.locator('[data-calculate]').click();
  await workbench.locator('.ad-result').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-calculate')), true);
  await workbench.locator('[data-name]').fill('Безопасный школьный маршрут');
  await workbench.locator('[data-save]').click();
  await workbench.locator('.ad-scenario-list article').filter({ hasText: 'Безопасный школьный маршрут' }).waitFor();
  const savedA = (await api('/api/desk/scenarios'))[0];
  assert.ok(Math.abs(savedA.result.score - 56.54307) < 1e-8);
  assert.equal(savedA.complaintId, 1);
  assert.equal(savedA.result.totalCost, 95);
  await workbench.locator('[data-remove="M5"]').click();
  await workbench.locator('[data-add="M6"]').click();
  await workbench.locator('[data-calculate]').click();
  await workbench.locator('.ad-result').waitFor();
  await workbench.locator('[data-name]').fill('Озеленение и безопасность');
  await workbench.locator('[data-save]').click();
  await workbench.locator('.ad-scenario-list article').filter({ hasText: 'Озеленение и безопасность' }).waitFor();
  const savedB = (await api('/api/desk/scenarios'))[0];
  assert.equal(savedB.result.totalCost, 90);
  await workbench.locator('[data-pair="0"]').selectOption(String(savedA.id));
  await workbench.locator('[data-pair="1"]').selectOption(String(savedB.id));
  await workbench.locator('[data-compare]').click();
  await workbench.locator('.ad-comparison tbody tr').nth(8).waitFor();
  assert.match(await workbench.locator('.ad-comparison').innerText(), /0,22/);
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-compare')), true);
  await workbench.locator(`[data-load="${savedA.id}"]`).click();
  await workbench.locator('[data-remove="M5"]').waitFor();
  assert.equal(await workbench.locator('.ad-plan ol li').count(), 5);
  assert.equal(await workbench.locator('[data-pick="M7"]').inputValue(), 'nura');
  assert.equal(await page.evaluate(() => Boolean(window.__akimXss)), false);
}

async function mountDecisionFixture() {
  await page.route('**/__qa_decisions', route => route.fulfill({ contentType: 'text/html', body: '<link rel="icon" href="data:,"><link rel="stylesheet" href="/akim-decisions.css"><main id="decision-fixture"></main>' }));
  await page.goto('/__qa_decisions');
  await page.evaluate(async () => {
    const request = async (path, options = {}) => {
      const result = await fetch(path, { method: options.method || 'GET', headers: { 'Content-Type': 'application/json', 'X-Desk-Request': '1' }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
      const value = await result.json();
      if (!result.ok) throw new Error(value.message || value.errors?.[0]?.message || 'Request failed');
      return value;
    };
    const { renderDecisions } = await import('/akim-decisions.js');
    await renderDecisions({ container: document.getElementById('decision-fixture'), state: { complaints: (await request('/api/desk/complaints')).items, scenarios: await request('/api/desk/scenarios') }, request });
  });
}

try {
  if (process.env.AKIM_DECISIONS_ONLY) {
    await step('decision workbench calculate, save, load and compare', async () => {
      await login(page, 'mayor', false);
      await mountDecisionFixture();
      await decisionsAcceptance();
    });
    await step('saved decision scenarios survive page reload', async () => {
      await page.reload();
      await mountDecisionFixture();
      assert.equal(await page.locator('.ad-scenario-list article').count(), 2);
      await page.locator('[data-load]').last().click();
      await page.locator('.ad-plan ol li').nth(4).waitFor();
    });
  } else {
  await step('admin browser login and cabinet initial load', async () => {
    await login();
    await page.getByRole('heading', { name: 'Кабинет акима', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => Boolean(window.__akimXss)), false);
  });
  await step('daily summary counters drill into their exact records', async () => {
    for (const [filter, count] of [['urgent', 2], ['new', 1], ['overdue', 1], ['review', 1]]) {
      assert.equal(await page.locator(`.metric[data-filter="${filter}"] .metric-value`).innerText(), String(count));
    }
    await screenshot('summary-desktop');
    await page.locator('.metric[data-filter="urgent"]').click();
    assert.equal(await page.locator('[data-select-complaint]').count(), 2);
    assert.equal(await page.locator('[data-select-complaint="1"]').count(), 1);
    assert.equal(await page.locator('[data-select-complaint="3"]').count(), 1);
    await gotoTab('summary');
    await page.locator('.metric[data-filter="overdue"]').click();
    assert.equal(await page.locator('.task-card').count(), 1);
    assert.match(await page.locator('.task-card').innerText(), /Обезопасить открытый люк/);
    await page.locator('[data-action="clear-filters"]').click();
  });
  await step('unknown district remains accessible and hostile text is escaped', async () => {
    await gotoTab('problems');
    const savedUnknownDistrict = page.waitForResponse(response => response.url().endsWith('/akim/preferences') && response.request().method() === 'PATCH');
    await page.locator('[data-action="district"][data-district="none"]').click();
    assert.equal(await page.locator('[data-select-complaint]').count(), 1);
    assert.equal(await page.locator('[data-select-complaint="4"]').count(), 1);
    assert.match(await page.locator('[data-action="complaint-detail"][data-id="4"]').first().innerText(), /<img src=x/);
    assert.equal(await page.locator('img[src="x"]').count(), 0);
    assert.equal(await page.evaluate(() => Boolean(window.__akimXss)), false);
    await savedUnknownDistrict;
    await reloadCabinet();
    assert.equal(await page.locator('#filters-form select[name="districtId"]').inputValue(), 'none');
    await page.locator('[data-action="clear-filters"]').click();
    await screenshot('districts-desktop');
  });
  await step('language and saved filters persist across reload', async () => {
    const prefSave = page.waitForResponse(response => response.url().endsWith('/akim/preferences') && response.request().method() === 'PATCH');
    await page.locator('[data-action="language"][data-lang="kk"]').click();
    await prefSave;
    await reloadCabinet();
    assert.equal(await page.locator('html').getAttribute('lang'), 'kk');
    assert.match(await page.locator('.breadcrumb').innerText(), /Әкім кабинеті/);
    const ruSave = page.waitForResponse(response => response.url().endsWith('/akim/preferences') && response.request().method() === 'PATCH');
    await page.locator('[data-action="language"][data-lang="ru"]').click();
    await ruSave;
    const filterSave = page.waitForResponse(response => response.url().endsWith('/akim/preferences') && response.request().method() === 'PATCH');
    await page.locator('[data-action="filter"][data-filter="overdue"]').click();
    await filterSave;
    await reloadCabinet();
    assert.equal(await page.locator('[data-action="filter"][data-filter="overdue"]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-action="clear-filters"]').click();
  });
  // Workflow, report and mobile cases follow below.
  }
} finally {
  await page.screenshot({ path: join(screenshots, 'desktop.png'), fullPage: true }).catch(() => {});
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(screenshots, 'mobile.png'), fullPage: true }).catch(() => {});
  console.log(JSON.stringify({ baseURL, screenshots, failures, pageErrors, consoleErrors }, null, 2));
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  // Retain screenshots as acceptance artifacts; remove only the disposable DB files.
  await Promise.all(['fixture.sqlite', 'fixture.sqlite-wal', 'fixture.sqlite-shm'].map(name => rm(join(temp, name), { force: true })));
  process.exitCode = failures || pageErrors.length ? 1 : 0;
}
