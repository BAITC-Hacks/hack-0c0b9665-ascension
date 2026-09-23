import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createAppServer } from '../src/server.js';
import { createComplaintStore } from '../src/complaints/store.js';

const ADMIN = 'synthetic-test-admin';
const HOOK = 'synthetic-test-hook';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ascension-citizen-http-'));
  const filePath = join(dir, 'complaints.json');
  const store = createComplaintStore({ filePath });
  const messages = [];
  const transport = {
    sendMessage: async (chatId, text, options) => { messages.push({ chatId, text, options }); return { message_id: messages.length }; },
    getPhoto: async () => ({ data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), contentType: 'image/jpeg' }),
  };
  const server = createAppServer({ aiConfigured: () => false,
    explain: async () => { throw new Error('No AI requests permitted in these tests'); },
    complaints: { store, adminToken: ADMIN, webhookSecret: HOOK, transport, telegramUsername: 'SyntheticTestBot', ...options } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, admin = false, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(admin ? { 'X-Admin-Token': ADMIN } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await response.json();
    return { status: response.status, json };
  };
  return { store, filePath, messages, transport, base, call };
}

test('webhook delivers main menu and configured support without creating a complaint', async t => {
  const { call, store, messages } = await fixture(t, { telegramSupportUrl: '@SyntheticSupport' });
  for (const [update_id, text] of [[1, '/start'], [2, '💬 Техподдержка']]) {
    const result = await call('/api/telegram/webhook', { method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': HOOK },
      body: { update_id, message: { chat: { id: 123456, type: 'private' }, from: { id: 123456 }, text } } });
    assert.equal(result.status, 200);
  }
  assert.ok(messages[0].options.replyMarkup.keyboard.flat().some(button => button.text === '📝 Новое обращение'));
  assert.match(messages[1].text, /https:\/\/t\.me\/SyntheticSupport/u);
  assert.ok(messages[1].options.replyMarkup.keyboard.flat().some(button => button.text === '🏠 Главное меню'));
  assert.equal((await store.list({})).complaints.length, 0);
});

test('web intake → staff correction and resolution → private tracking → persisted restart', async t => {
  const { call, store, filePath } = await fixture(t);
  const text = 'Тест: яма у дома, телефон +7 000 111 22 33, нужны дорожные работы.';
  const created = await call('/api/complaints', { method: 'POST', body: { text, consent: true,
    address: 'Синтетический адрес 42', districtId: 'nura', location: { lat: 51.13, lon: 71.4 },
    status: 'resolved', source: 'telegram', telegramChatId: 123, trackingToken: 'forged' } });
  assert.equal(created.status, 201);
  assert.equal(created.json.complaint.status, 'new');
  assert.ok(created.json.trackingToken.length >= 24);
  assert.equal(created.json.complaint.text, undefined);
  const { id } = created.json.complaint;
  const privateRecord = await store.get(id);
  assert.equal(privateRecord.source, 'web');
  assert.equal(privateRecord.telegramChatId, undefined);
  assert.equal((await call('/api/complaints')).status, 401);
  const listed = await call('/api/complaints', { admin: true });
  assert.equal(listed.json.complaints.length, 1);
  assert.equal(listed.json.complaints[0].text, text);
  assert.equal(listed.json.complaints[0].trackingToken, undefined);
  assert.equal((await call(`/api/complaints/${id}`, { method: 'PATCH', admin: true,
    body: { status: 'rejected', resolution: '' } })).status, 400);
  const working = await call(`/api/complaints/${id}`, { method: 'PATCH', admin: true,
    body: { status: 'in_progress', assignee: 'Тестовая дорожная служба', category: 'roads',
      summary: 'Тестовая яма', reason: 'Проверено вручную', priority: 'high' } });
  assert.equal(working.status, 200);
  assert.equal(working.json.complaint.analysis.reviewed, true);
  const resolved = await call(`/api/complaints/${id}`, { method: 'PATCH', admin: true,
    body: { status: 'resolved', resolution: 'Учебный пример: покрытие восстановлено.' } });
  assert.equal(resolved.status, 200);
  const tracked = await call('/api/complaints/track', { method: 'POST',
    body: { id, trackingToken: created.json.trackingToken } });
  assert.equal(tracked.status, 200);
  assert.equal(tracked.json.complaint.status, 'resolved');
  assert.equal(tracked.json.complaint.resolution, 'Учебный пример: покрытие восстановлено.');
  const publicText = JSON.stringify(tracked.json);
  for (const secret of ['+7 000', 'Синтетический адрес', '51.13', created.json.trackingToken]) {
    assert.equal(publicText.includes(secret), false);
  }
  assert.equal((await call('/api/complaints/track', { method: 'POST', body: { id, trackingToken: 'wrong' } })).status, 404);
  const reopened = createComplaintStore({ filePath });
  assert.equal((await reopened.track(id, created.json.trackingToken)).status, 'resolved');
});

test('webhook conversation preserves photo/location, rejects spoofing and deduplicates final update', async t => {
  const { call, store, messages, base } = await fixture(t);
  const webhook = body => call('/api/telegram/webhook', { method: 'POST', body,
    headers: { 'X-Telegram-Bot-Api-Secret-Token': HOOK } });
  const message = (update_id, data) => ({ update_id, message: { message_id: update_id,
    chat: { id: 123456, type: 'private' }, from: { id: 123456 }, ...data } });
  assert.equal((await call('/api/telegram/webhook', { method: 'POST', body: message(1, { text: '/start' }) })).status, 401);
  for (const update of [message(1, { text: '/start' }), message(2, { text: '/agree' }),
    message(3, { caption: 'Тест: на улице не работает освещение возле остановки.',
      photo: [{ file_id: 'synthetic-photo-id', file_unique_id: 'synthetic-unique', width: 100, height: 100 }] }),
    message(4, { location: { latitude: 51.13, longitude: 71.42 } }), message(5, { text: '/send' })]) {
    assert.equal((await webhook(update)).status, 200);
  }
  assert.equal((await webhook(message(5, { text: '/send' }))).status, 200);
  const list = await store.list({});
  assert.equal(list.complaints.length, 1);
  const record = await store.get(list.complaints[0].id);
  assert.equal(record.attachments.length, 1);
  assert.equal(record.location.lat, 51.13);
  assert.ok(messages.some(item => item.text.includes(record.id)));
  const unauthorizedPhoto = await fetch(`${base}/api/complaints/${record.id}/photos/0`);
  assert.equal(unauthorizedPhoto.status, 401);
  const photo = await fetch(`${base}/api/complaints/${record.id}/photos/0`, { headers: { 'X-Admin-Token': ADMIN } });
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('content-type'), 'image/jpeg');
  const result = await call(`/api/complaints/${record.id}`, { method: 'PATCH', admin: true,
    body: { status: 'resolved', resolution: 'Учебный пример: лампа заменена.' } });
  assert.equal(result.json.notification.state, 'sent');
  assert.match(messages.at(-1).text, /лампа заменена/);
});

test('notification failure does not undo a saved decision; cross-origin writes and unsafe access fail', async t => {
  const { call, store, transport } = await fixture(t);
  const receipt = await store.create({ text: 'Тестовое обращение: мусор возле остановки.', consent: true,
    source: 'telegram', telegramChatId: 123456, telegramUpdateId: 10 });
  transport.sendMessage = async () => { throw new Error('synthetic outage'); };
  const update = await call(`/api/complaints/${receipt.complaint.id}`, { method: 'PATCH', admin: true,
    body: { status: 'in_progress', assignee: 'Тестовая служба' } });
  assert.equal(update.status, 200);
  assert.equal(update.json.notification.state, 'failed');
  assert.equal((await store.get(receipt.complaint.id)).status, 'in_progress');
  assert.equal((await call('/api/complaints', { admin: true, headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await call('/api/complaints', { method: 'POST', body: { text: 'Тестовое обращение.', consent: true },
    headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await call('/api/complaints', { method: 'POST', body: { text: 'Тестовое обращение.' } })).status, 400);
  assert.equal((await call('/api/complaints', { method: 'DELETE', admin: true })).status, 405);
  assert.equal((await call('/var/complaints.json')).status, 404);
});

test('local demo rejects DNS rebinding while normal localhost remains usable', async t => {
  const { call, base } = await fixture(t, { adminToken: '' });
  assert.equal((await call('/api/complaints')).status, 200);
  // Node fetch replaces Host; raw HTTP exercises the header a browser would send after rebinding.
  const status = await new Promise((resolve, reject) => {
    const req = request(`${base}/api/complaints`, { headers: { Host: 'untrusted.example' } }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    req.once('error', reject);
    req.end();
  });
  assert.equal(status, 401);
  assert.equal((await call('/api/citizen/config')).json.demoMode, true);
});

test('corrupt storage reports a safe actionable error and keeps existing bytes', async t => {
  const { call, filePath } = await fixture(t);
  await writeFile(filePath, '{broken');
  const result = await call('/api/complaints', { admin: true });
  assert.equal(result.status, 500);
  assert.equal(result.json.errors[0].code, 'COMPLAINT_STORAGE_CORRUPT');
  assert.match(result.json.errors[0].message, /не перезаписаны/);
  assert.equal(JSON.stringify(result.json).includes(filePath), false);
  assert.equal(await readFile(filePath, 'utf8'), '{broken');
});

test('stale staff edits cannot overwrite a newer decision', async t => {
  const { call } = await fixture(t);
  const created = await call('/api/complaints', { method: 'POST', body: { text: 'Тестовая неисправность уличного фонаря.', consent: true } });
  const { id, updatedAt } = created.json.complaint;
  const resolved = await call(`/api/complaints/${id}`, { method: 'PATCH', admin: true,
    body: { expectedUpdatedAt: updatedAt, status: 'resolved', resolution: 'Учебный пример: фонарь заменён.' } });
  assert.equal(resolved.status, 200);
  assert.notEqual(resolved.json.complaint.updatedAt, updatedAt);
  const stale = await call(`/api/complaints/${id}`, { method: 'PATCH', admin: true,
    body: { expectedUpdatedAt: updatedAt, status: 'in_progress', resolution: '', assignee: 'Другая служба' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.errors[0].code, 'COMPLAINT_CHANGED');
  const list = await call('/api/complaints', { admin: true });
  assert.equal(list.json.complaints[0].status, 'resolved');
});
