import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../src/server.js';
import { openStore, passwordHash } from '../src/desk/store.js';

const day = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const offsetDate = (value, offset) => new Date(Date.parse(`${value}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'akim-api-'));
  const path = join(directory, 'desk.sqlite');
  const db = openStore(path);
  for (const [login, role] of [['mayor', 'admin'], ['worker', 'operator'], ['other', 'operator']]) {
    db.prepare('INSERT INTO users(login,password,role) VALUES(?,?,?)').run(login, passwordHash('test-password-123'), role);
  }
  const today = day(new Date());
  const seed = (values = {}) => {
    const inserted = db.prepare('INSERT INTO complaints(submission,fingerprint,data) VALUES(?,?,?)').run(`seed-${Math.random()}`, 'test', '{}');
    const id = Number(inserted.lastInsertRowid);
    const item = { id, text: `Не работает светофор №${id}`, address: 'Улица Достык, 1', districtId: 'nura', category: 'safety', source: 'demo',
      status: 'new', priority: 'normal', assignee: '', version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      history: [], replies: [], attachments: [], ...values };
    db.prepare('UPDATE complaints SET data=? WHERE id=?').run(JSON.stringify(item), id);
    return item;
  };
  const complaints = [seed({ priority: 'high' }), seed(), seed({ districtId: 'esil' })];
  const server = createAppServer({ deskOptions: { path } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections(); await closed; db.close(); await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(route, { method = 'GET', body, cookie, headers = {} } = {}) {
    const response = await fetch(`${origin}${route}`, { method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json', 'x-desk-request': '1' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  async function login(user) {
    const result = await request('/api/desk/login', { method: 'POST', body: { login: user, password: 'test-password-123' } });
    assert.equal(result.status, 200);
    return result.headers.get('set-cookie').split(';')[0];
  }
  const admin = await login('mayor'), worker = await login('worker'), other = await login('other');
  const api = (route, options = {}) => request(`/api/desk/akim/${route}`, { cookie: admin, ...options });
  const taskBody = (values = {}) => ({ title: 'Восстановить светофор', complaintIds: [complaints[0].id], assignee: 'worker', dueDate: today,
    expectedResult: 'Светофор работает; фото и проверка на месте', requestId: 'task-1', ...values });
  return { db, server, origin, today, complaints, seed, request, api, admin, worker, other, taskBody };
}

test('akim state requires authentication, preserves complaints and starts without seeded tasks', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/desk/akim/state')).status, 401);
  const { status, data } = await f.api('state');
  assert.equal(status, 200);
  assert.equal(data.today, f.today);
  assert.deepEqual(data.tasks, []);
  assert.deepEqual(data.groups, []);
  assert.equal(data.complaints.length, 3);
  assert.equal(data.summary.urgent, 1);
  assert.equal(data.summary.newToday, 3);
  assert.equal(data.bot, 'not_connected');
  assert.ok(data.users.every(user => Object.keys(user).sort().join(',') === 'login,role'));
  assert.deepEqual(data.preferences, { filter: 'all', districtId: '', category: '', query: '', lang: 'ru' });
});

test('task lifecycle checks roles, preserves original complaint status and logs verification/return', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('tasks', { method: 'POST', cookie: f.worker, body: f.taskBody() })).status, 403);
  let result = await f.api('tasks', { method: 'POST', body: f.taskBody() });
  assert.equal(result.status, 201);
  let task = result.data;
  const patch = (body, cookie = f.admin) => f.api(`tasks/${task.id}`, { method: 'PATCH', cookie, body: { version: task.version, ...body } });
  assert.equal((await patch({ action: 'verify', note: 'Проверено' })).status, 422);
  task = (await patch({ action: 'watch', watch: true })).data;
  assert.deepEqual(task.watchers, ['mayor']);
  task = (await patch({ action: 'request_report', note: 'Нужны результаты осмотра' })).data;
  assert.equal(task.reportRequests[0].note, 'Нужны результаты осмотра');
  assert.equal((await patch({ action: 'report', text: 'Работа завершена' }, f.other)).status, 403);
  assert.equal((await patch({ action: 'report', text: ' ' }, f.worker)).status, 422);
  task = (await patch({ action: 'report', text: 'Заменён контроллер, выездная проверка выполнена' }, f.worker)).data;
  assert.equal(task.status, 'reported');
  assert.equal((await patch({ action: 'verify', note: 'Проверено' }, f.worker)).status, 403);
  assert.equal((await patch({ action: 'edit', title: 'Другой результат' })).status, 422);
  task = (await patch({ action: 'verify', note: 'Проверил на месте, все фазы работают' })).data;
  assert.equal(task.status, 'verified');
  assert.equal(task.verification.actor, 'mayor');
  assert.equal((await f.request(`/api/desk/complaints/${f.complaints[0].id}`, { cookie: f.admin })).data.status, 'new');
  const verifiedState = (await f.api('state')).data;
  assert.equal(verifiedState.summary.watching, 0);
  task = (await patch({ action: 'return', note: 'Повторный сбой вечером', dueDate: offsetDate(f.today, 2) })).data;
  assert.equal(task.status, 'assigned');
  assert.equal(task.verification, null);
  assert.equal(task.dueDate, offsetDate(f.today, 2));
  assert.equal(task.history.at(-1).action, 'return');
  assert.equal(task.reports.length, 1);
  const report = await f.api(`report?from=${f.today}&to=${f.today}`);
  assert.equal(report.status, 200);
  assert.equal(report.data.verified.length, 1, 'Historical verification survives return for rework');
  assert.equal(report.data.verified[0].verificationEvents.length, 1);
  assert.equal(report.data.verified[0].status, 'assigned');
});

test('creation retries are idempotent even after edits and reject changed payloads', async t => {
  const f = await fixture(t);
  const first = await f.api('tasks', { method: 'POST', body: f.taskBody() });
  const replay = await f.api('tasks', { method: 'POST', body: f.taskBody() });
  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.id, first.data.id);
  assert.equal((await f.api('tasks', { method: 'POST', body: f.taskBody({ title: 'Другие данные' }) })).status, 409);
  const edited = await f.api(`tasks/${first.data.id}`, { method: 'PATCH', body: { version: 1, action: 'edit', assignee: 'other', dueDate: offsetDate(f.today, 1) } });
  assert.equal(edited.status, 200);
  const afterEditReplay = await f.api('tasks', { method: 'POST', body: f.taskBody() });
  assert.equal(afterEditReplay.status, 200);
  assert.equal(afterEditReplay.data.assignee, 'other');
  assert.equal((await f.api('state')).data.tasks.length, 1);
  assert.equal((await f.api(`tasks/${first.data.id}`, { method: 'PATCH', body: { version: 1, action: 'watch', watch: true } })).data.code, 'VERSION_CONFLICT');
});

test('version is re-read after a delayed body, preventing concurrent lost updates', async t => {
  const f = await fixture(t);
  const task = (await f.api('tasks', { method: 'POST', body: f.taskBody() })).data;
  const reachedHandler = once(f.server, 'request');
  let slow;
  const delayedResponse = new Promise((resolve, reject) => {
    slow = httpRequest(`${f.origin}/api/desk/akim/tasks/${task.id}`, { method: 'PATCH',
      headers: { Cookie: f.admin, 'Content-Type': 'application/json', 'x-desk-request': '1' } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    slow.once('error', reject);
    slow.write('{"version":1,');
  });
  await reachedHandler;
  const fast = await f.api(`tasks/${task.id}`, { method: 'PATCH', body: { version: 1, action: 'edit', title: 'Уже изменено другим участником' } });
  assert.equal(fast.status, 200);
  slow.end('"action":"watch","watch":true}');
  const result = await delayedResponse;
  assert.equal(result.status, 409);
  assert.equal(result.data.code, 'VERSION_CONFLICT');
  const final = (await f.api('state')).data.tasks[0];
  assert.equal(final.title, 'Уже изменено другим участником');
  assert.deepEqual(final.watchers, []);
});

test('task validation rejects malformed dates, unknown keys, missing records and invalid report photos', async t => {
  const f = await fixture(t);
  for (const update of [{ dueDate: '2026-02-30' }, { dueDate: offsetDate(f.today, -1) }, { expectedResult: '' },
    { complaintIds: [] }, { complaintIds: [9999] }, { complaintIds: [1, 1] }, { assignee: 'missing' }, { status: 'verified' }, { requestId: '' }]) {
    assert.equal((await f.api('tasks', { method: 'POST', body: f.taskBody(update) })).status, 422, JSON.stringify(update));
  }
  const task = (await f.api('tasks', { method: 'POST', body: f.taskBody() })).data;
  const addAttachment = complaint => Number(f.db.prepare('INSERT INTO attachments(complaint,name,mime,bytes) VALUES(?,?,?,?)').run(complaint, 'Фото.png', 'image/png', Buffer.from([137, 80, 78, 71])).lastInsertRowid);
  const validPhoto = addAttachment(f.complaints[0].id), otherPhoto = addAttachment(f.complaints[1].id);
  const patch = body => f.api(`tasks/${task.id}`, { method: 'PATCH', body: { version: task.version, action: 'report', text: 'Готово', ...body } });
  for (const body of [{ beforeAttachmentIds: [otherPhoto] }, { afterAttachmentIds: [99999] },
    { beforeAttachmentIds: [validPhoto], afterAttachmentIds: [validPhoto] }, { action: 'toString' }, { action: 'watch', watch: true, text: 'unexpected' }]) {
    assert.equal((await patch(body)).status, 422, JSON.stringify(body));
  }
  const valid = await patch({ afterAttachmentIds: [validPhoto] });
  assert.equal(valid.status, 200);
  assert.deepEqual(valid.data.reports[0].afterAttachmentIds, [validPhoto]);
  assert.equal((await f.api('tasks/99999', { method: 'PATCH', body: { version: 1, action: 'watch', watch: true } })).status, 404);
});

test('confirmed groups enforce common district/category, idempotency, membership, and preserve originals', async t => {
  const f = await fixture(t);
  const body = { title: 'Светофор на Достык', complaintIds: [1, 2], requestId: 'group-1' };
  assert.equal((await f.api('groups', { method: 'POST', cookie: f.worker, body })).status, 403);
  assert.equal((await f.api('groups', { method: 'POST', body: { ...body, complaintIds: [1, 3] } })).status, 422);
  const first = await f.api('groups', { method: 'POST', body });
  assert.equal(first.status, 201);
  assert.equal((await f.api('groups', { method: 'POST', body: { ...body, complaintIds: [2, 1] } })).status, 200);
  assert.equal((await f.api('groups', { method: 'POST', body: { ...body, requestId: 'group-other' } })).status, 409);
  const afterGrouping = (await f.api('state')).data;
  assert.equal(afterGrouping.groups.length, 1);
  assert.deepEqual(afterGrouping.complaints.slice().sort((a, b) => a.id - b.id), f.complaints);
  const ungroup = await f.api(`groups/${first.data.id}`, { method: 'PATCH', body: { version: 1, action: 'ungroup' } });
  assert.equal(ungroup.status, 200);
  assert.equal((await f.api('state')).data.groups.length, 0);
  assert.equal((await f.api('state')).data.complaints.length, 3);
  assert.equal((await f.api('groups', { method: 'POST', body: { ...body, requestId: 'group-new' } })).status, 201);
});

test('preferences persist per user, merge partial changes and reject unsupported values', async t => {
  const f = await fixture(t);
  const result = await f.api('preferences', { method: 'PATCH', body: { lang: 'kk', filter: 'watching', districtId: 'nura', category: 'safety', query: 'Светофор' } });
  assert.equal(result.status, 200);
  assert.equal(result.data.lang, 'kk');
  const partial = await f.api('preferences', { method: 'PATCH', body: { query: '' } });
  assert.equal(partial.data.filter, 'watching');
  assert.equal(partial.data.lang, 'kk');
  assert.equal((await f.api('state')).data.preferences.query, '');
  assert.equal((await f.api('state', { cookie: f.worker })).data.preferences.lang, 'ru');
  const unknownDistrict = await f.api('preferences', { method: 'PATCH', body: { districtId: 'none', filter: 'open' } });
  assert.equal(unknownDistrict.status, 200);
  assert.equal(unknownDistrict.data.districtId, 'none');
  assert.equal(unknownDistrict.data.filter, 'open');
  const persisted = (await f.api('state')).data.preferences;
  assert.equal(persisted.districtId, 'none');
  assert.equal(persisted.filter, 'open');
  assert.equal(persisted.lang, 'kk');
  assert.deepEqual((await f.api('state')).data.complaints.slice().sort((a, b) => a.id - b.id), f.complaints);
  for (const body of [{ lang: 'en' }, { filter: 'anything' }, { districtId: 'unknown' }, { category: 'unknown' }, { secret: 'value' }]) {
    assert.equal((await f.api('preferences', { method: 'PATCH', body })).status, 422);
  }
});

test('reports use inclusive Almaty dates and clearly separate event counts from the current snapshot', async t => {
  const f = await fixture(t);
  const atStart = f.seed({ createdAt: `${f.today}T00:00:00+05:00`, priority: 'normal' });
  const atEnd = f.seed({ createdAt: `${f.today}T23:59:59+05:00`, priority: 'normal' });
  const previous = f.seed({ createdAt: `${offsetDate(f.today, -1)}T23:59:59+05:00` });
  const next = f.seed({ createdAt: `${offsetDate(f.today, 1)}T00:00:00+05:00` });
  let task = (await f.api('tasks', { method: 'POST', body: f.taskBody() })).data;
  task = (await f.api(`tasks/${task.id}`, { method: 'PATCH', body: { version: task.version, action: 'watch', watch: true } })).data;
  task = (await f.api(`tasks/${task.id}`, { method: 'PATCH', body: { version: task.version, action: 'report', text: 'Выполнено' } })).data;
  const rawTask = JSON.parse(f.db.prepare('SELECT data FROM akim_tasks WHERE id=?').get(task.id).data);
  rawTask.dueDate = offsetDate(f.today, -1);
  f.db.prepare('UPDATE akim_tasks SET data=? WHERE id=?').run(JSON.stringify(rawTask), task.id);
  const report = (await f.api(`report?from=${f.today}&to=${f.today}`)).data;
  const ids = report.received.map(item => item.id);
  assert.ok(ids.includes(atStart.id)); assert.ok(ids.includes(atEnd.id));
  assert.ok(!ids.includes(previous.id)); assert.ok(!ids.includes(next.id));
  assert.equal(report.overdue.length, 1);
  assert.equal(report.pendingReview.length, 1);
  assert.equal(report.scope.timezone, 'Asia/Almaty');
  const summary = (await f.api('state')).data.summary;
  assert.equal(summary.overdue, 1); assert.equal(summary.pendingReview, 1); assert.equal(summary.watching, 1);
  assert.equal(summary.newToday, 5);
  for (const query of ['from=2026-02-30&to=2026-03-01', `from=${f.today}&to=${offsetDate(f.today, -1)}`, 'from=2025-01-01&to=2026-01-02', 'from=&to=']) {
    assert.equal((await f.api(`report?${query}`)).status, 422, query);
  }
  assert.equal((await f.api('report?from=2025-01-01&to=2026-01-01')).status, 200, '366 inclusive dates permitted');
});
