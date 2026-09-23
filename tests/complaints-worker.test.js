import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../src/worker.js';
import { createComplaintFetchHandler } from '../src/complaints/worker-routes.js';
import { createDurableComplaintStore } from '../src/complaints/durable-store.js';

const ADMIN = 'synthetic-worker-admin';
const HOOK = 'synthetic-worker-hook';
const BASE = 'https://city.example';
const INPUT = { text: 'Тестовая яма возле остановки, требуется ремонт.', address: 'Закрытый адрес, 10', consent: true };
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);

class MemoryStorage {
  entries = new Map();
  async get(key) { return structuredClone(this.entries.get(key)); }
  async put(key, value) { this.entries.set(key, structuredClone(value)); }
  async list({ prefix }) { return structuredClone(new Map([...this.entries].filter(([key]) => key.startsWith(prefix)))); }
  async transaction(operation) {
    const staged = new MemoryStorage();
    staged.entries = structuredClone(this.entries);
    staged.delete = async key => staged.entries.delete(key);
    const result = await operation(staged);
    this.entries = staged.entries;
    return result;
  }
}

function fixture(options = {}) {
  const storage = new MemoryStorage();
  const messages = [];
  const bindingNames = [];
  const transport = {
    sendMessage: async (chatId, text, extras) => { messages.push({ chatId, text, extras }); return { message_id: messages.length }; },
    getPhoto: async fileId => {
      assert.equal(fileId, 'synthetic-worker-photo');
      return { data: JPEG, contentType: 'image/jpeg' };
    },
  };
  let store;
  let handle;
  let worker;
  function restart() {
    store = createDurableComplaintStore({ storage });
    handle = createComplaintFetchHandler({ store, sessionStorage: storage, adminToken: ADMIN, webhookSecret: HOOK,
      telegramUsername: 'SyntheticWorkerBot', publicBaseUrl: BASE, transport, ...options });
    worker = createWorker();
  }
  restart();
  const env = {
    ASSETS: { fetch: async () => new Response('asset') },
    COMPLAINTS: { getByName(name) {
      bindingNames.push(name);
      return { fetch: request => handle(request) };
    } },
  };
  const fetchRequest = request => worker.fetch(request, env);
  const call = async (path, { method = 'GET', body, admin = false, headers = {}, base = BASE } = {}) => {
    const response = await fetchRequest(new Request(base + path, { method,
      headers: { 'CF-Connecting-IP': '192.0.2.10', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(admin ? { 'X-Admin-Token': ADMIN } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: response.status, headers: response.headers, json: await response.json() };
  };
  const webhook = update => call('/api/telegram/webhook', { method: 'POST', body: update,
    headers: { 'X-Telegram-Bot-Api-Secret-Token': HOOK } });
  return { storage, messages, bindingNames, transport, call, webhook, fetchRequest, restart, getStore: () => store };
}

function update(update_id, data, chatId = 123456) {
  return { update_id, message: { message_id: update_id, chat: { id: chatId, type: 'private' }, from: { id: chatId },
    ...(typeof data === 'string' ? { text: data } : data) } };
}

test('Worker complaint form, admin changes and private tracking persist after full handler restart', async () => {
  const f = fixture();
  const created = await f.call('/api/complaints', { method: 'POST', body: { ...INPUT,
    source: 'telegram', telegramChatId: 777, status: 'resolved', trackingToken: 'forged' } });
  assert.equal(created.status, 201);
  const { complaint, trackingToken } = created.json;
  assert.equal(complaint.status, 'new');
  assert.equal(complaint.text, undefined);
  assert.match(trackingToken, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal((await f.getStore().get(complaint.id)).source, 'web');
  assert.equal((await f.call('/api/complaints')).status, 401);
  assert.equal((await f.call('/api/complaints', { headers: { 'X-Admin-Token': 'wrong' } })).status, 401);
  const listed = await f.call('/api/complaints', { admin: true });
  assert.equal(listed.json.complaints[0].text, INPUT.text);
  assert.equal(listed.json.complaints[0].trackingToken, undefined);
  const resolved = await f.call(`/api/complaints/${complaint.id}`, { method: 'PATCH', admin: true,
    body: { expectedUpdatedAt: complaint.updatedAt, status: 'resolved', resolution: 'Тест: покрытие восстановлено.' } });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.json.notification.state, 'not_applicable');
  f.restart();
  const tracked = await f.call('/api/complaints/track', { method: 'POST', body: { id: complaint.id, trackingToken } });
  assert.equal(tracked.json.complaint.status, 'resolved');
  assert.doesNotMatch(JSON.stringify(tracked.json), /Закрытый адрес|Тестовая яма|trackingToken/u);
  assert.equal((await f.call('/api/complaints/track', { method: 'POST', body: { id: complaint.id, trackingToken: 'wrong' } })).status, 404);
  const stale = await f.call(`/api/complaints/${complaint.id}`, { method: 'PATCH', admin: true,
    body: { expectedUpdatedAt: complaint.updatedAt, status: 'in_progress' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.errors[0].code, 'COMPLAINT_CHANGED');
  assert.ok(f.bindingNames.every(name => name === 'city'));
  for (const result of [created, listed, resolved, tracked, stale]) {
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
    assert.equal(result.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(result.headers.get('Referrer-Policy'), 'no-referrer');
    assert.match(result.headers.get('Content-Security-Policy'), /default-src 'self'/u);
  }
});

test('Worker config accurately reports credentials and never enables localhost admin access', async () => {
  const enabled = fixture();
  assert.deepEqual((await enabled.call('/api/citizen/config')).json, {
    telegramUrl: 'https://t.me/SyntheticWorkerBot', analysisMode: 'rules', adminConfigured: true,
    telegramConfigured: true, webhookConfigured: true, demoMode: false,
  });
  const disabled = fixture({ transport: undefined, adminToken: '', webhookSecret: '', telegramUsername: '' });
  for (const base of [BASE, 'http://localhost:8787', 'http://127.0.0.1:8787']) {
    const config = await disabled.call('/api/citizen/config', { base, headers: { 'CF-Connecting-IP': '127.0.0.1' } });
    assert.deepEqual(config.json, { telegramUrl: null, analysisMode: 'rules', adminConfigured: false,
      telegramConfigured: false, webhookConfigured: false, demoMode: false });
    assert.equal((await disabled.call('/api/complaints', { base, headers: { 'CF-Connecting-IP': '127.0.0.1' } })).status, 401);
  }
});

test('a stalled public POST body does not block config or authenticated admin requests', async () => {
  const f = fixture();
  let bodyController;
  const body = new ReadableStream({ start(controller) {
    bodyController = controller;
    controller.enqueue(new TextEncoder().encode('{'));
  } });
  let postSettled = false;
  const pendingPost = f.fetchRequest(new Request(`${BASE}/api/complaints`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.30' },
    body, duplex: 'half',
  })).then(response => { postSettled = true; return response; });
  let timer;
  try {
    const [config, admin] = await Promise.race([
      Promise.all([f.call('/api/citizen/config'), f.call('/api/complaints', { admin: true })]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('A stalled body blocked unrelated requests.')), 1000); }),
    ]);
    assert.equal(config.status, 200);
    assert.equal(admin.status, 200);
    assert.equal(admin.json.stats.total, 0);
    assert.equal(postSettled, false, 'other requests must finish before the incomplete POST');
  } finally {
    clearTimeout(timer);
    bodyController.close();
  }
  const post = await pendingPost;
  assert.equal(post.status, 400);
  assert.equal((await post.json()).errors[0].code, 'INVALID_JSON');
});

test('Worker rejects cross-origin writes, spoofed Host, invalid JSON/media/size and wrong methods', async () => {
  const f = fixture();
  for (const headers of [
    { Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' },
    { Host: 'evil.example', Origin: 'https://evil.example' },
  ]) {
    assert.equal((await f.call('/api/complaints', { method: 'POST', body: INPUT, headers })).status, 403);
    assert.equal((await f.call('/api/complaints', { admin: true, headers })).status, 403);
  }
  assert.equal((await f.call('/api/complaints', { method: 'POST', body: INPUT, headers: { Origin: BASE } })).status, 201);
  const cases = [
    { headers: { 'Content-Type': 'text/plain' }, body: '{}', status: 415 },
    { headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: '{}', status: 415 },
    { headers: { 'Content-Type': 'application/json' }, body: '{broken', status: 400 },
    { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(33 * 1024) }), status: 413 },
    { headers: { 'Content-Type': 'application/json', 'Content-Length': String(33 * 1024) }, body: '{}', status: 413 },
  ];
  for (const item of cases) {
    const response = await f.fetchRequest(new Request(`${BASE}/api/complaints`, { method: 'POST', headers: item.headers, body: item.body }));
    assert.equal(response.status, item.status);
  }
  const wrongMethod = await f.call('/api/complaints', { method: 'DELETE', admin: true });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('Allow'), 'GET, POST');
  assert.equal((await f.call('/api/complaints/track', { admin: true })).status, 405);
  assert.equal((await f.call('/api/complaints/a/photos/no')).status, 404);
  assert.equal((await f.call('/api/complaints/%ZZ')).status, 400);
  assert.equal((await f.call('/api/complaints/%3Asecret')).status, 404);
});

test('Worker webhook authenticates before JSON parsing or sending and disables missing configuration', async () => {
  const f = fixture();
  for (const secret of [undefined, 'wrong']) {
    const response = await f.fetchRequest(new Request(`${BASE}/api/telegram/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Telegram-Bot-Api-Secret-Token': secret } : {}) },
      body: '{broken',
    }));
    assert.equal(response.status, 401);
    assert.equal((await response.json()).errors[0].code, 'WEBHOOK_SECRET');
  }
  assert.equal(f.messages.length, 0);
  assert.equal((await f.webhook(update(1, '/start'))).status, 200);
  assert.equal(f.messages.length, 1);
  assert.equal((await fixture({ webhookSecret: '' }).webhook(update(1, '/start'))).status, 503);
  const disabled = await fixture({ transport: undefined }).webhook(update(1, '/start'));
  assert.equal(disabled.status, 503);
  assert.equal(disabled.json.errors[0].code, 'TELEGRAM_DISABLED');
});

test('Worker webhook draft, photo, receipt and status notification survive handler restarts', async () => {
  const f = fixture();
  for (const payload of [update(10, '/agree'), update(11, 'Тест: возле остановки не работает фонарь.')]) {
    assert.equal((await f.webhook(payload)).status, 200);
  }
  f.restart();
  for (const payload of [update(12, { location: { latitude: 51.13, longitude: 71.42 } }),
    update(13, { photo: [{ file_id: 'synthetic-worker-photo', file_unique_id: 'synthetic-unique' }] }), update(14, '/send')]) {
    assert.equal((await f.webhook(payload)).status, 200);
  }
  const listed = await f.call('/api/complaints', { admin: true });
  assert.equal(listed.json.complaints.length, 1);
  const complaint = listed.json.complaints[0];
  assert.equal(complaint.location.lat, 51.13);
  assert.deepEqual(complaint.attachments, [{ type: 'photo', index: 0 }]);
  const receiptText = f.messages.at(-1).text;
  assert.match(receiptText, new RegExp(complaint.id));
  assert.match(receiptText, /https:\/\/city\.example\/citizens\.html#id=/u);
  const sentCount = f.messages.length;
  f.restart();
  assert.equal((await f.webhook(update(14, '/send'))).status, 200);
  assert.equal(f.messages.length, sentCount);
  assert.equal((await f.getStore().list()).stats.total, 1);
  assert.equal((await f.call(`/api/complaints/${complaint.id}/photos/0`)).status, 401);
  const photo = await f.fetchRequest(new Request(`${BASE}/api/complaints/${complaint.id}/photos/0`, { headers: { 'X-Admin-Token': ADMIN } }));
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('Content-Type'), 'image/jpeg');
  assert.deepEqual(new Uint8Array(await photo.arrayBuffer()), JPEG);
  const resolved = await f.call(`/api/complaints/${complaint.id}`, { method: 'PATCH', admin: true,
    body: { status: 'resolved', resolution: 'Тест: фонарь заменён.' } });
  assert.equal(resolved.json.notification.state, 'sent');
  assert.equal(f.messages.at(-1).chatId, '123456');
  assert.match(f.messages.at(-1).text, /фонарь заменён/u);
  assert.doesNotMatch(f.messages.at(-1).text, /synthetic-worker-photo|trackingToken|возле остановки/u);
});

test('Worker webhook retries a prepared response after transport failure without repeating draft text', async () => {
  const f = fixture();
  await f.webhook(update(20, '/agree'));
  const normalSend = f.transport.sendMessage;
  f.transport.sendMessage = async () => { throw new Error('synthetic transport outage'); };
  f.restart();
  const description = update(21, 'Тест: проблема с водоснабжением возле дома.');
  assert.equal((await f.webhook(description)).status, 500);
  f.transport.sendMessage = normalSend;
  f.restart();
  assert.equal((await f.webhook(description)).status, 200);
  assert.equal((await f.webhook(update(22, '/send'))).status, 200);
  const listed = await f.getStore().list();
  assert.equal(listed.stats.total, 1);
  assert.equal(listed.complaints[0].text, description.message.text);
});

test('Worker intake rate limits use client IP and never share one global unknown address when IP exists', async () => {
  const f = fixture();
  for (let index = 0; index < 30; index++) {
    assert.equal((await f.call('/api/complaints/track', { method: 'POST', body: { id: 'missing', trackingToken: 'wrong' } })).status, 404);
  }
  const blocked = await f.call('/api/complaints/track', { method: 'POST', body: { id: 'missing', trackingToken: 'wrong' } });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.errors[0].code, 'RATE_LIMITED');
  assert.equal((await f.call('/api/complaints/track', { method: 'POST', body: { id: 'missing', trackingToken: 'wrong' },
    headers: { 'CF-Connecting-IP': '192.0.2.20' } })).status, 404);
});

test('Worker fails closed when durable binding is absent or invalid without leaking internal errors', async () => {
  for (const binding of [undefined, null, {}, { getByName: () => ({}) }]) {
    for (const path of ['/api/citizen/config', '/api/complaints', '/api/telegram/webhook']) {
      const response = await createWorker().fetch(new Request(BASE + path), { COMPLAINTS: binding });
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.errors[0].code, 'COMPLAINTS_UNAVAILABLE');
      assert.doesNotMatch(JSON.stringify(body), /TypeError|getByName|stack/u);
    }
  }
});
