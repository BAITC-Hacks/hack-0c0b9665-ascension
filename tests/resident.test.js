import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../src/server.js';
import { openStore, passwordHash } from '../src/desk/store.js';

const PNG = { name: 'result.png', mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=' };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'resident-api-')), path = join(directory, 'desk.sqlite');
  const db = openStore(path);
  for (const [login, role] of [['mayor', 'akim'], ['worker', 'operator'], ['reader', 'viewer']]) db.prepare('INSERT INTO users VALUES(?,?,?)').run(login, passwordHash('test-password-123'), role);
  const save = item => db.prepare('UPDATE complaints SET data=? WHERE id=?').run(JSON.stringify(item), item.id);
  const get = id => JSON.parse(db.prepare('SELECT data FROM complaints WHERE id=?').get(id).data);
  const seed = (values = {}) => {
    const id = Number(db.prepare('INSERT INTO complaints(submission,fingerprint,data) VALUES(?,?,?)').run(`seed-${Math.random()}`, 'seed', '{}').lastInsertRowid);
    const item = { id, text: 'Не работает освещение у дома', address: 'Улица жителя, 12', districtId: 'nura', category: 'safety', source: 'demo',
      status: 'resolved', priority: 'normal', assignee: 'private-assignee', version: 1, createdAt: '2026-01-01T12:00:00.000Z', updatedAt: '2026-01-03T12:00:00.000Z',
      history: [{ at: '2026-01-02T12:00:00.000Z', actor: 'private-operator', text: 'private-note@example.com' },
        { at: '2026-01-03T12:00:00.000Z', actor: 'private-operator', text: 'status: work → resolved\nprivate-internal-note' }],
      replies: [{ at: '2026-01-03T12:00:00.000Z', text: 'Освещение восстановлено (демо)', actor: 'private-operator', delivery: 'not_connected' }], attachments: [], ...values };
    save(item); return item;
  };
  const item = seed(), other = seed({ districtId: 'esil', text: 'private-other-complaint' });
  let server;
  async function start() { server = createAppServer({ deskOptions: { path } }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
  async function stop() { const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; }
  await start();
  t.after(async () => { await stop(); db.close(); await rm(directory, { recursive: true, force: true }); });
  const origin = () => `http://127.0.0.1:${server.address().port}`;
  async function request(route, { method = 'GET', body, cookie, token, headers = {} } = {}) {
    const response = await fetch(`${origin()}${route}`, { method, headers: {
      ...(cookie ? { Cookie: cookie } : {}), ...(token ? { 'X-Resident-Token': token } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-Desk-Request': '1', 'X-Resident-Request': '1' } : {}), ...headers,
    }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, headers: response.headers, data: response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
  }
  async function login(login) {
    const response = await request('/api/desk/login', { method: 'POST', body: { login, password: 'test-password-123' } });
    assert.equal(response.status, 200); return response.headers.get('set-cookie').split(';')[0];
  }
  const admin = await login('mayor'), worker = await login('worker'), reader = await login('reader');
  const staff = (suffix = '', options = {}) => request(`/api/desk/resident/complaints/${item.id}${suffix}`, { cookie: admin, ...options });
  async function link(id = item.id) {
    const response = await request(`/api/desk/resident/complaints/${id}/link`, { cookie: admin, method: 'POST', body: { version: get(id).version } });
    assert.equal(response.status, 201); return response.data.token;
  }
  function attachment(id = item.id) {
    const attachmentId = Number(db.prepare('INSERT INTO attachments(complaint,name,mime,bytes) VALUES(?,?,?,?)').run(id, PNG.name, PNG.mime, Buffer.from(PNG.base64, 'base64')).lastInsertRowid);
    const complaint = get(id); complaint.attachments.push({ id: attachmentId, name: PNG.name }); save(complaint); return attachmentId;
  }
  function task(values = {}) {
    db.exec('CREATE TABLE IF NOT EXISTS akim_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT,data TEXT NOT NULL)');
    const id = Number(db.prepare('INSERT INTO akim_tasks(data) VALUES(?)').run('{}').lastInsertRowid);
    const value = { id, complaintIds: [item.id], title: 'private-task-title', status: 'reported', dueDate: '2026-01-03',
      reports: [{ at: '2026-01-03T11:00:00.000Z', actor: 'private-worker', text: 'private-work-report' }], ...values };
    db.prepare('UPDATE akim_tasks SET data=? WHERE id=?').run(JSON.stringify(value), id); return value;
  }
  const feedback = (token, body, options = {}) => request('/api/resident/feedback', { token, method: 'POST', body, ...options });
  return { db, get, save, seed, item, other, server, origin, request, admin, worker, reader, staff, link, attachment, task, feedback,
    restart: async () => { await stop(); await start(); } };
}

test('resident tokens are hashed, scoped, rotated, expired and survive restart without exposing internal fields', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(`/api/desk/resident/complaints/${f.item.id}`)).status, 401);
  assert.equal((await f.staff('/link', { method: 'POST', body: { version: 1 }, cookie: f.reader })).status, 403);
  assert.equal((await f.staff('/link', { method: 'POST', body: { version: 2 } })).status, 409);
  const token = await f.link();
  assert.match(token, /^[a-f0-9]{64}$/);
  const stored = f.db.prepare('SELECT * FROM resident_links WHERE complaint=?').get(f.item.id);
  assert.notEqual(stored.token_hash, token); assert.ok(stored.expires > Date.now() + 89 * 86400000);
  assert.equal(JSON.stringify((await f.staff()).data).includes(token), false);
  f.task();
  assert.equal((await f.request(`/api/resident/complaint?token=${token}`)).status, 401);
  const result = await f.request('/api/resident/complaint', { token });
  assert.equal(result.status, 200); assert.equal(result.data.id, f.item.id); assert.equal(result.data.canRespond, true); assert.equal(result.data.source, 'demo');
  assert.equal(JSON.stringify(result.data).includes('private-'), false);
  assert.deepEqual(Object.keys(result.data.replies[0]).sort(), ['at', 'text']);
  assert.deepEqual(result.data.tasks[0], { title: 'Работы по обращению', dueDate: '2026-01-03', status: 'reported' });
  assert.equal(result.headers.get('cache-control'), 'no-store');
  await f.restart();
  assert.equal((await f.request('/api/resident/complaint', { token })).status, 200);
  const rotated = await f.link();
  assert.notEqual(rotated, token); assert.equal((await f.request('/api/resident/complaint', { token })).status, 401);
  f.db.prepare('UPDATE resident_links SET expires=? WHERE complaint=?').run(Date.now() - 1, f.item.id);
  assert.equal((await f.request('/api/resident/complaint', { token: rotated })).status, 401);
  assert.equal((await f.staff()).data.hasLink, false);
});

test('feedback validates origin and version, persists optional photo, reopens complaint and is idempotent', async t => {
  const f = await fixture(t), token = await f.link(), task = f.task();
  const body = { version: 1, outcome: 'unresolved', comment: 'Свет по-прежнему не работает', requestId: 'resident-check', photo: PNG };
  assert.equal((await f.feedback(token, body, { headers: { 'X-Resident-Request': '0' } })).status, 403);
  assert.equal((await f.feedback(token, body, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.feedback(token, body, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await f.feedback(token, { ...body, comment: ' ' })).status, 422);
  assert.equal((await f.feedback(token, { ...body, version: 99 })).status, 409);
  assert.equal((await f.feedback(token, { ...body, photo: { ...PNG, base64: Buffer.from('<svg />').toString('base64') } })).status, 422);
  const first = await f.feedback(token, body, { headers: { Origin: f.origin() } });
  assert.equal(first.status, 201); assert.equal(first.data.complaint.status, 'review'); assert.equal(first.data.complaint.version, 2);
  assert.equal(first.data.feedback.hasPhoto, true); assert.equal(first.data.complaint.canRespond, false);
  const original = f.get(f.item.id);
  assert.equal(original.residentFeedback.outcome, 'unresolved'); assert.equal(original.attachments.length, 1);
  assert.match(original.history.at(-1).text, /status: resolved → review/);
  assert.equal(JSON.parse(f.db.prepare('SELECT data FROM akim_tasks WHERE id=?').get(task.id).data).status, 'reported');
  const retry = await f.feedback(token, body);
  assert.equal(retry.status, 200); assert.equal(retry.data.feedback.id, first.data.feedback.id); assert.equal(f.get(f.item.id).version, 2);
  assert.equal((await f.feedback(token, { ...body, comment: 'Другой текст' })).data.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await f.feedback(token, { version: 2, outcome: 'confirmed', comment: '', requestId: 'toggle' })).data.code, 'RESPONSE_NOT_AVAILABLE');
  const details = (await f.staff()).data;
  assert.equal(details.feedback.length, 1); assert.equal(details.feedback[0].photo.id, original.attachments[0].id);
  assert.equal((await f.request(`/api/desk/attachments/${original.attachments[0].id}`)).status, 401);
});

test('confirmation is available once per resolution; staff notes, link rotation and task verification do not reset it', async t => {
  const f = await fixture(t); let token = await f.link(); const task = f.task();
  const first = await f.feedback(token, { version: 1, outcome: 'confirmed', comment: '', requestId: 'first' });
  assert.equal(first.status, 201); assert.equal(first.data.complaint.canRespond, false);
  let item = f.get(f.item.id); item.version++; item.updatedAt = new Date().toISOString(); item.history.push({ at: item.updatedAt, actor: 'mayor', text: 'Обычный внутренний комментарий' }); f.save(item);
  task.status = 'verified'; task.version = 8; f.db.prepare('UPDATE akim_tasks SET data=? WHERE id=?').run(JSON.stringify(task), task.id);
  token = await f.link();
  assert.equal((await f.request('/api/resident/complaint', { token })).data.canRespond, false);
  assert.equal((await f.feedback(token, { version: item.version, outcome: 'unresolved', comment: 'Попытка изменить оценку', requestId: 'toggle' })).status, 409);
  task.status = 'reported'; task.reports.push({ at: new Date().toISOString(), text: 'Новый результат после повторного выезда' });
  f.db.prepare('UPDATE akim_tasks SET data=? WHERE id=?').run(JSON.stringify(task), task.id);
  assert.equal((await f.request('/api/resident/complaint', { token })).data.canRespond, true);
  assert.equal((await f.feedback(token, { version: item.version, outcome: 'unresolved', comment: 'Осталось замечание', requestId: 'second-result' })).status, 201);
  item = f.get(f.item.id); item.status = 'resolved'; item.version++; item.updatedAt = new Date().toISOString(); item.history.push({ at: item.updatedAt, text: 'status: work → resolved' }); f.save(item);
  assert.equal((await f.request('/api/resident/complaint', { token })).data.canRespond, true);
  assert.equal((await f.feedback(token, { version: item.version, outcome: 'confirmed', comment: '', requestId: 'third-result' })).status, 201);
});

test('latest task controls resident response when complaint is open; missing task tables work safely', async t => {
  const f = await fixture(t); const item = f.get(f.item.id); item.status = 'work'; f.save(item);
  const token = await f.link();
  assert.equal((await f.request('/api/resident/complaint', { token })).data.canRespond, false);
  f.task({ status: 'verified' });
  assert.equal((await f.request('/api/resident/complaint', { token })).data.canRespond, true);
  f.task({ status: 'assigned', reports: [] });
  assert.equal((await f.request('/api/resident/complaint', { token })).data.canRespond, false);
  assert.equal((await f.feedback(token, { version: 1, outcome: 'confirmed', requestId: 'not-ready' })).status, 409);
});

test('public results require explicit curation and manager role; photos are scoped and hidden immediately on reopening', async t => {
  const f = await fixture(t), photo = f.attachment(), unselected = f.attachment(), otherPhoto = f.attachment(f.other.id);
  const body = { version: 1, title: 'Восстановлено освещение', summary: 'Заменены светильники в районе Нура. Демонстрация.', beforeAttachmentIds: [], afterAttachmentIds: [photo] };
  assert.deepEqual((await f.request('/api/public/results')).data.items, []);
  assert.equal((await f.staff('/publication', { method: 'POST', body, cookie: f.worker })).status, 403);
  assert.equal((await f.staff('/publication', { method: 'POST', body: { ...body, afterAttachmentIds: [otherPhoto] } })).status, 422);
  assert.equal((await f.staff('/publication', { method: 'POST', body: { ...body, beforeAttachmentIds: [photo] } })).status, 422);
  assert.equal((await f.staff('/publication', { method: 'POST', body: { ...body, internal: 'injected' } })).status, 422);
  const published = await f.staff('/publication', { method: 'POST', body });
  assert.equal(published.status, 200); assert.equal(published.data.active, true); assert.equal(f.get(f.item.id).version, 1);
  const result = (await f.request('/api/public/results?districtId=nura')).data;
  assert.equal(result.items.length, 1); assert.equal(result.items[0].durationDays, 2); assert.equal(result.items[0].source, 'demo');
  assert.equal(JSON.stringify(result).includes('private-'), false); assert.equal(JSON.stringify(result).includes(f.item.address), false);
  assert.equal((await f.request('/api/public/results?districtId=esil')).data.items.length, 0);
  assert.equal((await f.request('/api/public/results?districtId=unknown')).status, 422);
  const photoUrl = result.items[0].after[0].url;
  assert.equal((await f.request(photoUrl)).status, 200);
  assert.equal((await f.request(`/api/public/results/${published.data.id}/photos/${otherPhoto}`)).status, 404);
  assert.equal((await f.request(`/api/public/results/${published.data.id}/photos/${unselected}`)).status, 404);
  const token = await f.link();
  await f.feedback(token, { version: 1, outcome: 'unresolved', requestId: 'reopen', comment: 'Не работает' });
  assert.equal((await f.request('/api/public/results')).data.items.length, 0);
  assert.equal((await f.request(photoUrl)).status, 404);
  assert.equal((await f.staff('/publication', { method: 'POST', body: { ...body, version: 2 } })).status, 422);
  const item = f.get(f.item.id); item.status = 'resolved'; item.version++; item.history.push({ at: new Date().toISOString(), text: 'status: work → resolved' }); f.save(item);
  assert.equal((await f.staff('/publication', { method: 'POST', body: { ...body, version: 3 } })).status, 422, 'Unresolved resident feedback still blocks publication after staff resolution');
  await f.feedback(token, { version: 3, outcome: 'confirmed', requestId: 'confirmed', comment: '' });
  assert.equal((await f.request('/api/public/results')).data.items.length, 0, 'New completion requires explicit republication');
  assert.equal((await f.staff()).data.publication.effectiveVisible, false);
  assert.equal((await f.staff('/publication', { method: 'POST', body: { ...body, version: 4 } })).status, 200);
  assert.equal((await f.request('/api/public/results')).data.items[0].residentConfirmed, true);
  assert.equal((await f.staff('/publication', { method: 'DELETE', body: { version: 4 } })).status, 200);
  assert.equal((await f.staff()).data.publication.active, false);
  assert.equal((await f.request(photoUrl)).status, 404); assert.equal((await f.request('/api/public/results')).data.items.length, 0);
});

test('reopening and resolving again never republishes a previous result or its photos automatically', async t => {
  const f = await fixture(t), photo = f.attachment();
  const body = { version: 1, title: 'Работы завершены', summary: 'Проверенный результат', beforeAttachmentIds: [], afterAttachmentIds: [photo] };
  await f.staff('/publication', { method: 'POST', body });
  const url = (await f.request('/api/public/results')).data.items[0].after[0].url;
  let item = f.get(f.item.id); item.status = 'review'; item.version++; f.save(item);
  assert.equal((await f.request(url)).status, 404);
  item = f.get(f.item.id); item.status = 'resolved'; item.version++; item.updatedAt = new Date().toISOString();
  item.history.push({ at: item.updatedAt, text: 'status: work → resolved' }); f.save(item);
  assert.equal((await f.request('/api/public/results')).data.items.length, 0);
  assert.equal((await f.request(url)).status, 404);
  const metadata = (await f.staff()).data.publication;
  assert.equal(metadata.active, true); assert.equal(metadata.effectiveVisible, false); assert.equal(metadata.title, body.title);
  await f.staff('/publication', { method: 'POST', body: { ...body, version: 3, summary: 'Проверенный новый результат' } });
  const updated = (await f.request('/api/public/results')).data.items[0];
  assert.equal(updated.summary, 'Проверенный новый результат'); assert.equal(updated.completedAt, item.updatedAt);
  assert.equal((await f.request(url)).status, 200);
});

test('feedback rechecks version after a delayed body and preserves the concurrent staff change', async t => {
  const f = await fixture(t), token = await f.link();
  let slow;
  const reachedHandler = once(f.server, 'request');
  const response = new Promise((resolve, reject) => {
    slow = httpRequest(`${f.origin()}/api/resident/feedback`, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Resident-Token': token, 'X-Resident-Request': '1',
    } }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.once('end', () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) })); });
    slow.once('error', reject); slow.write('{"version":1,');
  });
  await reachedHandler;
  const changed = await f.request(`/api/desk/complaints/${f.item.id}`, { cookie: f.admin, method: 'PATCH', body: {
    version: 1, status: 'resolved', category: 'safety', districtId: 'nura', priority: 'normal', assignee: '', note: 'Одновременное изменение сотрудником',
  } });
  assert.equal(changed.status, 200);
  slow.end('"outcome":"unresolved","requestId":"delayed","comment":"Не решено"}');
  const result = await response;
  assert.equal(result.status, 409); assert.equal(result.data.code, 'VERSION_CONFLICT');
  assert.equal(f.get(f.item.id).status, 'resolved'); assert.equal((await f.staff()).data.feedback.length, 0);
});

test('a rotated token is rejected even when feedback began before rotation', async t => {
  const f = await fixture(t), token = await f.link(); let slow;
  const reachedHandler = once(f.server, 'request');
  const response = new Promise((resolve, reject) => {
    slow = httpRequest(`${f.origin()}/api/resident/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Resident-Token': token, 'X-Resident-Request': '1' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.once('end', () => resolve(res.statusCode));
    });
    slow.once('error', reject); slow.write('{"version":1,');
  });
  await reachedHandler; await f.link();
  slow.end('"outcome":"confirmed","requestId":"rotated"}');
  assert.equal(await response, 401); assert.equal((await f.staff()).data.feedback.length, 0);
});

test('resident feedback attempts are rate-limited without creating duplicate records', async t => {
  const f = await fixture(t), token = await f.link();
  const body = { version: 1, outcome: 'confirmed', requestId: 'retry' };
  assert.equal((await f.feedback(token, body)).status, 201);
  for (let i = 1; i < 30; i++) assert.equal((await f.feedback(token, body)).status, 200);
  assert.equal((await f.feedback(token, body)).status, 429);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM resident_feedback').get().count, 1);
});
