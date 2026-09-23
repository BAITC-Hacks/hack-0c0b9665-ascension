/**
 * Browser acceptance for the akim cabinet.
 * Runs against an ephemeral HTTP port and an isolated, disposable SQLite DB.
 * Run: node tests/akim-ui.e2e.mjs
 * Optional: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROME_EXECUTABLE=/path/to/chrome
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
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
const { expect } = await import(playwrightModule.endsWith('/index.mjs') ? playwrightModule.replace(/index\.mjs$/, 'test.mjs') : 'playwright/test');
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


async function gotoTab(name, targetPage = page) { await targetPage.locator(`.nav [data-action="tab"][data-tab="${name}"]`).click(); await targetPage.waitForLoadState('networkidle'); }
async function reloadCabinet(targetPage = page) { await targetPage.reload(); await targetPage.locator('.layout').waitFor(); }
async function screenshot(name, targetPage = page) {
  if (!await targetPage.locator('#action-dialog').isVisible()) {
    await targetPage.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
    await targetPage.waitForFunction(() => window.scrollY === 0);
  }
  await targetPage.screenshot({ path: join(screenshots, `${name}.png`), fullPage: false });
}
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
  if (!process.env.AKIM_DECISIONS_ONLY) {
    await gotoTab('summary');
    await gotoTab('decisions');
    await workbench.locator('.ad-result').waitFor();
    await expect(workbench.locator('.ad-plan ol li')).toHaveCount(5);
    assert.equal(await workbench.locator('[data-pick="M5"]').inputValue(), 'saryarka');
  }
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
  await expect(workbench.locator('.ad-plan ol li')).toHaveCount(5);
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
  if (process.env.AKIM_SCREENSHOTS_ONLY) {
    await login();
    await screenshot('summary-desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await assertNoOverflow();
    await screenshot('summary-mobile');
  } else if (process.env.AKIM_DECISIONS_ONLY) {
    await step('decision workbench calculate, save, load and compare', async () => {
      await login(page, 'mayor', false);
      await mountDecisionFixture();
      await decisionsAcceptance();
    });
    await step('saved decision scenarios survive page reload', async () => {
      await page.reload();
      await mountDecisionFixture();
      await expect(page.locator('.ad-scenario-list article')).toHaveCount(2);
      await page.locator('[data-load]').last().click(); await page.waitForLoadState('networkidle');
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
    await page.locator('.metric[data-filter="urgent"]').click(); await page.waitForLoadState('networkidle');
    await expect(page.locator('[data-select-complaint]')).toHaveCount(2);
    await expect(page.locator('[data-select-complaint="1"]')).toHaveCount(1);
    await expect(page.locator('[data-select-complaint="3"]')).toHaveCount(1);
    await gotoTab('summary');
    await page.locator('.metric[data-filter="overdue"]').click(); await page.waitForLoadState('networkidle');
    await expect(page.locator('.task-card')).toHaveCount(1);
    assert.match(await page.locator('.task-card').innerText(), /Обезопасить открытый люк/);
    await page.locator('[data-action="clear-filters"]').first().click(); await page.waitForLoadState('networkidle');
  });
  await step('unknown district remains accessible and hostile text is escaped', async () => {
    await gotoTab('problems');
    const savedUnknownDistrict = page.waitForResponse(response => response.url().endsWith('/akim/preferences') && response.request().method() === 'PATCH');
    await page.locator('[data-action="district"][data-district="none"]').click(); await page.waitForLoadState('networkidle');
    await expect(page.locator('[data-select-complaint]')).toHaveCount(1);
    await expect(page.locator('[data-select-complaint="4"]')).toHaveCount(1);
    assert.match(await page.locator('[data-action="complaint-detail"][data-id="4"]').first().innerText(), /<img src=x/);
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    assert.equal(await page.evaluate(() => Boolean(window.__akimXss)), false);
    await savedUnknownDistrict;
    await reloadCabinet();
    assert.equal(await page.locator('#filters-form select[name="districtId"]').inputValue(), 'none');
    await page.locator('[data-action="clear-filters"]').first().click(); await page.waitForLoadState('networkidle');
    await screenshot('districts-desktop');
  });
  await step('language and saved filters persist across reload', async () => {
    const prefSave = page.waitForResponse(response => response.url().endsWith('/akim/preferences') && response.request().method() === 'PATCH');
    await page.locator('[data-action="language"][data-lang="kk"]').click(); await page.waitForLoadState('networkidle');
    await prefSave;
    await reloadCabinet();
    assert.equal(await page.locator('html').getAttribute('lang'), 'kk');
    assert.match(await page.locator('.breadcrumb').innerText(), /Әкім кабинеті/);
    const ruSave = page.waitForResponse(response => response.url().endsWith('/akim/preferences') && response.request().method() === 'PATCH');
    await page.locator('[data-action="language"][data-lang="ru"]').click(); await page.waitForLoadState('networkidle');
    await ruSave;
    const filterSave = page.waitForResponse(response => response.url().endsWith('/akim/preferences') && response.request().method() === 'PATCH');
    await page.locator('[data-action="filter"][data-filter="overdue"]').click(); await page.waitForLoadState('networkidle');
    await filterSave;
    await reloadCabinet();
    assert.equal(await page.locator('[data-action="filter"][data-filter="overdue"]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-action="clear-filters"]').first().click(); await page.waitForLoadState('networkidle');
  });
  await step('manual grouping and ungrouping preserve the original complaints', async () => {
    await gotoTab('problems');
    await page.locator('[data-action="clear-filters"]').first().click(); await page.waitForLoadState('networkidle');
    const originals = (await api('/api/desk/akim/state')).complaints;
    await page.locator('[data-select-complaint="1"]').check();
    await page.locator('[data-select-complaint="2"]').check();
    await page.locator('.selection-bar [data-action="create-group"]').click(); await page.waitForLoadState('networkidle');
    await page.locator('#action-form [name="title"]').fill('Неработающий светофор у школы № 17');
    await submitAction();
    await page.locator('#action-dialog').waitFor({ state: 'hidden' });
    let state = await api('/api/desk/akim/state');
    assert.equal(state.groups.length, 1);
    assert.deepEqual(state.groups[0].complaintIds, [1, 2]);
    assert.deepEqual(state.complaints, originals);
    const groupId = state.groups[0].id;
    await reloadCabinet();
    await page.locator(`[data-action="group-detail"][data-id="${groupId}"]`).click(); await page.waitForLoadState('networkidle');
    await page.locator('#action-dialog [data-action="ungroup"]').click(); await page.waitForLoadState('networkidle');
    await submitAction();
    await page.locator('#action-dialog').waitFor({ state: 'hidden' });
    state = await api('/api/desk/akim/state');
    assert.equal(state.groups.length, 0);
    assert.deepEqual(state.complaints, originals);
  });
  let workflowTaskId;
  await step('create task preserves form after failure and prevents duplicate submission', async () => {
    await closeDialog();
    await gotoTab('problems');
    await page.locator('[data-action="clear-filters"]').first().click(); await page.waitForLoadState('networkidle');
    await page.locator('[data-select-complaint="1"]').check();
    await page.locator('[data-select-complaint="2"]').check();
    await page.locator('.selection-bar [data-action="create-task"]').click(); await page.waitForLoadState('networkidle');
    const form = page.locator('#action-form');
    await form.locator('[name="title"]').fill('Восстановить светофор у школы № 17');
    await form.locator('[name="assignee"]').selectOption('operator');
    await form.locator('[name="dueDate"]').fill(futureDate(3));
    await form.locator('[name="expectedResult"]').fill('Светофор работает, переход безопасен. Приложить фото до и после.');
    await page.route('**/api/desk/akim/tasks', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Тестовая недоступность сервера. Повторите действие.' }) }));
    await submitAction();
    await page.locator('#action-dialog .form-error').waitFor({ state: 'visible' });
    assert.equal(await form.locator('[name="title"]').inputValue(), 'Восстановить светофор у школы № 17');
    assert.match(await form.locator('[name="expectedResult"]').inputValue(), /переход безопасен/);
    await page.unroute('**/api/desk/akim/tasks');
    await screenshot('task-dialog-desktop');
    const response = page.waitForResponse(result => result.url().endsWith('/akim/tasks') && result.request().method() === 'POST');
    await form.evaluate(element => { element.requestSubmit(); element.requestSubmit(); });
    assert.equal((await response).status(), 201);
    await page.locator('#action-dialog').waitFor({ state: 'hidden' });
    const tasks = (await api('/api/desk/akim/state')).tasks.filter(task => task.title === 'Восстановить светофор у школы № 17');
    assert.equal(tasks.length, 1);
    workflowTaskId = tasks[0].id;
    assert.equal(tasks[0].assignee, 'operator');
    assert.deepEqual(tasks[0].complaintIds, [1, 2]);
  });
  await step('task can be edited, watched and request an executor report', async () => {
    assert.ok(workflowTaskId, 'Task creation must pass before lifecycle checks');
    await closeDialog();
    await gotoTab('tasks');
    await page.locator('[data-action="clear-filters"]').first().click(); await page.waitForLoadState('networkidle');
    await page.locator(`[data-action="watch"][data-id="${workflowTaskId}"]`).click(); await page.waitForLoadState('networkidle');
    await page.locator(`[data-action="watch"][data-id="${workflowTaskId}"][aria-pressed="true"]`).waitFor();
    await page.locator(`[data-action="task-detail"][data-id="${workflowTaskId}"]`).first().click(); await page.waitForLoadState('networkidle');
    await page.locator('#action-dialog [data-kind="edit"]').click(); await page.waitForLoadState('networkidle');
    await page.locator('#action-form [name="expectedResult"]').fill('Светофор и звуковой сигнал работают. Приложить фотографии проверки.');
    await submitAction();
    await page.locator('#action-form').waitFor({ state: 'detached' });
    await closeDialog();
    await page.locator(`[data-action="task-detail"][data-id="${workflowTaskId}"]`).first().click(); await page.waitForLoadState('networkidle');
    await page.locator('#action-dialog [data-kind="request_report"]').click(); await page.waitForLoadState('networkidle');
    await page.locator('#action-form [name="note"]').fill('Проверьте звуковой сигнал и приложите фото результата.');
    await submitAction();
    await page.locator('#action-form').waitFor({ state: 'detached' });
    const task = (await api('/api/desk/akim/state')).tasks.find(task => task.id === workflowTaskId);
    assert.deepEqual(task.watchers, ['mayor']);
    assert.match(task.expectedResult, /звуковой сигнал/);
    assert.equal(task.reportRequests.length, 1);
    await closeDialog();
  });
  await step('operator can report assigned work with evidence but cannot approve it', async () => {
    assert.ok(workflowTaskId, 'Task creation must pass before executor checks');
    const operatorContext = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
    try {
      const operatorPage = await operatorContext.newPage();
      operatorPage.on('pageerror', error => pageErrors.push(`operator: ${error.message}`));
      await login(operatorPage, 'operator');
      await gotoTab('problems', operatorPage);
      await expect(operatorPage.locator('[data-select-complaint]')).toHaveCount(0);
      await gotoTab('tasks', operatorPage);
      const ownTask = (await api('/api/desk/akim/state', undefined, 'GET', operatorContext.request)).tasks.find(task => task.id === workflowTaskId);
      const forbidden = await operatorContext.request.patch(`/api/desk/akim/tasks/${workflowTaskId}`, { headers: { 'X-Desk-Request': '1' }, data: { version: ownTask.version, action: 'verify', note: 'Попытка проверки исполнителем' } });
      assert.equal(forbidden.status(), 403);
      await operatorPage.locator(`[data-action="task-action"][data-kind="report"][data-id="${workflowTaskId}"]`).click();
      const form = operatorPage.locator('#action-form');
      const reportText = 'Светофор отремонтирован; звуковой сигнал проверен на месте. Фотографии прилагаются.';
      await form.locator('[name="text"]').fill(reportText);
      await form.locator('details').filter({ has: operatorPage.locator('input[name="photo"]') }).locator('summary').click();
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64');
      for (const name of ['before.png', 'after.png']) {
        await form.locator('[name="photo"]').setInputFiles({ name, mimeType: 'image/png', buffer: png });
        const uploaded = operatorPage.waitForResponse(response => response.url().endsWith('/complaints/1/attachments') && response.request().method() === 'POST');
        await operatorPage.locator('[data-action="upload-photo"]').click();
        assert.equal((await uploaded).status(), 201);
        await expect(operatorPage.locator('#upload-message')).toContainText('Фото добавлено');
        assert.equal(await form.locator('[name="text"]').inputValue(), reportText);
      }
      await expect(form.locator('[name="beforeAttachmentIds"]')).toHaveCount(2);
      await form.locator('[name="beforeAttachmentIds"]').first().check();
      await form.locator('[name="afterAttachmentIds"]').last().check();
      await screenshot('executor-report-dialog-desktop', operatorPage);
      await submitAction(operatorPage);
      await form.waitFor({ state: 'detached' });
      await expect(operatorPage.locator('#action-dialog [data-kind="verify"]')).toHaveCount(0);
      const reported = (await api('/api/desk/akim/state')).tasks.find(task => task.id === workflowTaskId);
      assert.equal(reported.status, 'reported');
      assert.equal(reported.reports[0].text, reportText);
      assert.equal(reported.reports[0].beforeAttachmentIds.length, 1);
      assert.equal(reported.reports[0].afterAttachmentIds.length, 1);
      assert.notEqual(reported.reports[0].beforeAttachmentIds[0], reported.reports[0].afterAttachmentIds[0]);
    } finally { await operatorContext.close(); }
  });
  await step('manager verifies evidence and can return the work with its history retained', async () => {
    assert.ok(workflowTaskId);
    await closeDialog();
    await reloadCabinet();
    await gotoTab('tasks');
    await page.locator('[data-action="clear-filters"]').first().click();
    await page.locator(`[data-action="task-detail"][data-id="${workflowTaskId}"]`).first().click();
    await expect(page.locator('#action-dialog [data-kind="request_report"]')).toHaveCount(0);
    await expect(page.locator('#action-dialog [data-kind="edit"]')).toHaveCount(0);
    await page.locator('#action-dialog [data-kind="verify"]').click();
    await page.locator('#action-form [name="note"]').fill('Осмотр на месте: все сигналы работают, фотографии сверены.');
    await screenshot('verification-dialog-desktop');
    await submitAction();
    await page.locator('#action-form').waitFor({ state: 'detached' });
    assert.equal((await api('/api/desk/akim/state')).tasks.find(task => task.id === workflowTaskId).status, 'verified');
    await closeDialog();
    await page.locator('[data-action="filter"][data-filter="watching"]').click();
    await expect(page.locator('.task-card')).toHaveCount(1);
    await expect(page.locator(`[data-action="task-detail"][data-id="${workflowTaskId}"]`)).toHaveCount(0);
    await page.locator('[data-action="clear-filters"]').first().click();
    await page.locator(`[data-action="task-detail"][data-id="${workflowTaskId}"]`).first().click();
    await page.locator('#action-dialog [data-kind="return"]').click();
    await page.locator('#action-form [name="note"]').fill('После повторной проверки нужен дополнительный сигнал для пешеходов.');
    await page.locator('#action-form [name="dueDate"]').fill(futureDate(5));
    await submitAction();
    await page.locator('#action-form').waitFor({ state: 'detached' });
    const task = (await api('/api/desk/akim/state')).tasks.find(task => task.id === workflowTaskId);
    assert.equal(task.status, 'assigned');
    assert.equal(task.verification, null);
    assert.equal(task.reports.length, 1);
    assert.ok(task.history.some(event => event.action === 'verify'));
    assert.ok(task.history.some(event => event.action === 'return'));
    await closeDialog();
  });
  await step('session expiration preserves the open draft through reauthentication', async () => {
    assert.ok(workflowTaskId);
    await page.locator(`[data-action="task-detail"][data-id="${workflowTaskId}"]`).first().click();
    await page.locator('#action-dialog [data-kind="edit"]').click();
    const draft = 'Сохранённый черновик после истечения сессии.';
    await page.locator('#action-form [name="expectedResult"]').fill(draft);
    await context.clearCookies();
    await submitAction();
    await page.locator('#login-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#action-form [name="expectedResult"]').inputValue(), draft);
    await page.locator('#login-dialog [name="login"]').fill('mayor');
    await page.locator('#login-dialog [name="password"]').fill(password);
    await page.locator('#login-dialog button[type="submit"]').click();
    await page.locator('#login-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#action-form [name="expectedResult"]').inputValue(), draft);
    await submitAction();
    await page.locator('#action-form').waitFor({ state: 'detached' });
    assert.equal((await api('/api/desk/akim/state')).tasks.find(task => task.id === workflowTaskId).expectedResult, draft);
    await closeDialog();
  });
  await step('stale verification refreshes the current report while retaining the authored note', async () => {
    await gotoTab('tasks');
    await page.locator('[data-action="task-action"][data-kind="verify"][data-id="2"]').click();
    const note = 'Моя заметка к проверке сохранится при обновлении.';
    await page.locator('#action-form [name="note"]').fill(note);
    let concurrent = (await api('/api/desk/akim/state')).tasks.find(task => task.id === 2);
    concurrent = await api('/api/desk/akim/tasks/2', { version: concurrent.version, action: 'return', note: 'Нужен обновлённый отчёт' }, 'PATCH');
    concurrent = await api('/api/desk/akim/tasks/2', { version: concurrent.version, action: 'report', text: 'ОБНОВЛЁННЫЙ ОТЧЁТ Б: освещение проверено повторно.' }, 'PATCH');
    await submitAction();
    await page.locator('#action-dialog [data-action="refresh-dialog"]').waitFor();
    assert.equal((await api('/api/desk/akim/state')).tasks.find(task => task.id === 2).status, 'reported');
    await page.locator('#action-dialog [data-action="refresh-dialog"]').click();
    await expect(page.locator('#action-dialog')).toContainText('ОБНОВЛЁННЫЙ ОТЧЁТ Б');
    assert.equal(await page.locator('#action-form [name="note"]').inputValue(), note);
    assert.ok(!(await page.locator('#action-dialog').innerText()).includes('Освещение восстановлено; требуется проверка на месте.'));
    await screenshot('conflict-verification-refreshed');
    await closeDialog();
  });
  await step('stale edit keeps authored fields without overwriting concurrent assignment or deadline', async () => {
    await page.locator(`[data-action="task-detail"][data-id="${workflowTaskId}"]`).first().click();
    await page.locator('#action-dialog [data-kind="edit"]').click();
    const draft = 'Мой новый критерий: проверить переход в вечернее время.';
    await page.locator('#action-form [name="expectedResult"]').fill(draft);
    let concurrent = (await api('/api/desk/akim/state')).tasks.find(task => task.id === workflowTaskId);
    concurrent = await api(`/api/desk/akim/tasks/${workflowTaskId}`, { version: concurrent.version, action: 'edit', assignee: 'mayor', dueDate: futureDate(8) }, 'PATCH');
    await submitAction();
    await page.locator('#action-dialog [data-action="refresh-dialog"]').waitFor();
    await page.locator('#action-dialog [data-action="refresh-dialog"]').click();
    await expect(page.locator('#action-form [name="assignee"]')).toHaveValue('mayor');
    assert.equal(await page.locator('#action-form [name="dueDate"]').inputValue(), futureDate(8));
    assert.equal(await page.locator('#action-form [name="expectedResult"]').inputValue(), draft);
    await submitAction();
    await page.locator('#action-form').waitFor({ state: 'detached' });
    const saved = (await api('/api/desk/akim/state')).tasks.find(task => task.id === workflowTaskId);
    assert.equal(saved.assignee, 'mayor');
    assert.equal(saved.dueDate, futureDate(8));
    assert.equal(saved.expectedResult, draft);
    await closeDialog();
  });
  await step('decisions calculate, preserve unsaved work across tabs, save, reload and compare', async () => {
    await closeDialog();
    await gotoTab('decisions');
    await decisionsAcceptance();
    await reloadCabinet();
    await page.locator('.ad-scenario-list article').nth(1).waitFor();
    await expect(page.locator('.ad-scenario-list article')).toHaveCount(2);
    await page.locator('[data-load]').last().click();
    await page.locator('.ad-plan ol li').nth(4).waitFor();
    assert.equal(await page.locator('[data-pick="M7"]').inputValue(), 'nura');
  });
  await step('meeting report covers exactly seven days, retains verification history, prints and exports safe HTML', async () => {
    await gotoTab('meeting');
    const state = await api('/api/desk/akim/state');
    const expectedStart = new Date(`${state.today}T12:00:00Z`);
    expectedStart.setUTCDate(expectedStart.getUTCDate() - 6);
    assert.equal(await page.locator('#meeting-form [name="from"]').inputValue(), expectedStart.toISOString().slice(0, 10));
    assert.equal(await page.locator('#meeting-form [name="to"]').inputValue(), state.today);
    await page.locator('#meeting-form button[type="submit"]').click();
    await page.locator('.report-paper').waitFor();
    await expect(page.locator('.report-kpis strong').nth(0)).toHaveText('5');
    await expect(page.locator('.report-kpis strong').nth(1)).toHaveText('1');
    assert.match(await page.locator('.report-paper').innerText(), /Текущий статус: В работе/);
    assert.match(await page.locator('.report-paper').innerText(), /Просрочены сейчас/);
    await screenshot('meeting-desktop');
    const downloaded = page.waitForEvent('download');
    await page.locator('[data-action="download-report"]').click();
    const download = await downloaded;
    const downloadPath = join(screenshots, download.suggestedFilename());
    await download.saveAs(downloadPath);
    const html = await readFile(downloadPath, 'utf8');
    assert.match(html, /&lt;img src=x/);
    assert.ok(!/<script/i.test(html));
    assert.ok(html.includes(`${baseURL}/desk.html?complaint=1`));
    await page.evaluate(() => { window.__qaPrintCount = 0; window.print = () => window.__qaPrintCount++; });
    await page.locator('[data-action="print-report"]').click();
    assert.equal(await page.evaluate(() => window.__qaPrintCount), 1);
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.locator('.sidebar').isVisible(), false);
    assert.equal(await page.locator('.report-paper').isVisible(), true);
    await screenshot('meeting-print');
    await page.emulateMedia({ media: 'screen' });
    await page.locator('#meeting-form [name="from"]').fill('2000-01-01');
    await page.locator('#meeting-form [name="to"]').fill('2000-01-07');
    await page.locator('#meeting-form button[type="submit"]').click();
    await expect(page.locator('.report-kpis strong').nth(0)).toHaveText('0');
    await expect(page.locator('.report-kpis strong').nth(1)).toHaveText('0');
    await expect(page.locator('.report-kpis strong').nth(2)).toHaveText('1');
    await page.locator('[data-action="last-week"]').click();
    await expect(page.locator('.report-kpis strong').nth(0)).toHaveText('5');
  });
  await step('all five cabinet screens fit a 390px mobile viewport', async () => {
    await closeDialog();
    await page.setViewportSize({ width: 390, height: 844 });
    for (const screen of ['summary', 'problems', 'tasks', 'decisions', 'meeting']) {
      await gotoTab(screen);
      await assertNoOverflow();
      await page.evaluate(() => scrollTo(0, 0));
      await screenshot(`${screen}-mobile`);
    }
    await gotoTab('tasks');
    await page.locator(`[data-action="task-detail"][data-id="${workflowTaskId}"]`).first().click();
    await assertNoOverflow();
    await screenshot('task-dialog-mobile');
    await closeDialog();
    await gotoTab('summary');
    await screenshot('summary-mobile');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await screenshot('summary-desktop-final');
  });
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
