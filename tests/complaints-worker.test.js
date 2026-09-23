import test from 'node:test';
import assert from 'node:assert/strict';
import { createComplaintRuntime } from '../src/complaints-worker/runtime.js';
import { routeComplaintRequest } from '../src/complaints-worker/http.js';

class Storage {
  constructor() { this.data = new Map(); this.alarmAt = null; }
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, value) {
    if (typeof key === 'object') for (const [k, v] of Object.entries(key)) this.data.set(k, structuredClone(v));
    else this.data.set(key, structuredClone(value));
  }
  async list({ prefix = '' } = {}) { return new Map([...this.data].filter(([key]) => key.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])); }
  async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) this.data.delete(key); }
  async transaction(fn) {
    const saved = structuredClone(this.data);
    try { return await fn(this); } catch (error) { this.data = saved; throw error; }
  }
  async getAlarm() { return this.alarmAt; }
  async setAlarm(time) { this.alarmAt = time; }
}
const origin = 'https://city.example';
const env = { ADMIN_TOKEN: 'admin-test-only', TELEGRAM_BOT_TOKEN: '123456:' + 'a'.repeat(25),
  TELEGRAM_WEBHOOK_SECRET: 'webhook-test-only', TELEGRAM_BOT_USERNAME: 'Example_city_bot', PUBLIC_BASE_URL: origin };
const request = (path, method = 'GET', body, headers = {}) => new Request(origin + path, { method,
  headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const admin = { 'x-admin-token': env.ADMIN_TOKEN };
const update = (id, text) => ({ update_id: id, message: { chat: { id: 888, type: 'private' }, text } });
const webhook = body => request('/api/telegram/webhook', 'POST', body, { 'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET });

async function deliverAfterEviction(storage, transport, id, text) {
  return createComplaintRuntime({ storage, env, transport }).fetch(webhook(update(id, text)));
}

function failReceiptCheckpointOnce(storage, updateId) {
  const put = storage.put.bind(storage);
  storage.put = async (key, value) => {
    if (key === `telegram-update:${updateId}` && value.entry?.prepared?.result?.submitted) {
      storage.put = put;
      // This fails after the complaint commit and session write, exercising
      // rollback of the session+delivery checkpoint without losing the receipt.
      throw new Error('Injected receipt checkpoint failure');
    }
    return put(key, value);
  };
}

test('Worker intake persists across eviction, protects admin and tracking projections', async () => {
  const storage = new Storage(); const transport = { sendMessage: async () => {} };
  let runtime = createComplaintRuntime({ storage, env, transport });
  const created = await runtime.fetch(request('/api/complaints', 'POST', { text: 'Тест: не горит фонарь возле дома', address: 'Тестовая улица 1', consent: true, telegramChatId: 'spoof' }));
  assert.equal(created.status, 201); const receipt = await created.json();
  assert.equal(receipt.complaint.text, undefined); assert.equal(receipt.complaint.address, undefined);
  runtime = createComplaintRuntime({ storage, env, transport });
  assert.equal((await runtime.fetch(request('/api/complaints'))).status, 401);
  assert.equal((await runtime.fetch(request('/api/complaints', 'GET', undefined, { ...admin, origin: 'https://attacker.example' }))).status, 403);
  const list = await (await runtime.fetch(request('/api/complaints', 'GET', undefined, admin))).json();
  assert.equal(list.complaints.length, 1); assert.equal(list.complaints[0].source, 'web');
  assert.equal(list.complaints[0].trackingToken, undefined);
  const change = await runtime.fetch(request('/api/complaints/' + receipt.complaint.id, 'PATCH', {
    status: 'resolved', resolution: 'Тест: фонарь исправлен', expectedUpdatedAt: receipt.complaint.updatedAt }, admin));
  assert.equal(change.status, 200);
  assert.equal((await runtime.fetch(request('/api/complaints/track', 'POST', { id: receipt.complaint.id, trackingToken: 'wrong' }))).status, 404);
  const tracked = await (await runtime.fetch(request('/api/complaints/track', 'POST', { id: receipt.complaint.id, trackingToken: receipt.trackingToken }))).json();
  assert.equal(tracked.complaint.status, 'resolved'); assert.equal(tracked.complaint.text, undefined);
});

test('Telegram dialogue survives eviction between every message and retries without duplicate records', async () => {
  const storage = new Storage(); const sent = [];
  const transport = { sendMessage: async (chat, text) => sent.push({ chat, text }) };
  for (const [id, text] of [[1, '/start'], [2, '/agree'], [3, 'Тестовая жалоба: во дворе не работает фонарь'], [4, '/address Тестовая 1'], [5, '/send']]) {
    const runtime = createComplaintRuntime({ storage, env, transport });
    assert.equal((await runtime.fetch(webhook(update(id, text)))).status, 200);
  }
  assert.match(sent.at(-1).text, /Обращение принято/);
  const beforeRetry = sent.length;
  const runtime = createComplaintRuntime({ storage, env, transport });
  assert.equal((await runtime.fetch(webhook(update(5, '/send')))).status, 200);
  assert.equal(sent.length, beforeRetry);
  const list = await (await runtime.fetch(request('/api/complaints', 'GET', undefined, admin))).json();
  assert.equal(list.complaints.length, 1); assert.equal(list.complaints[0].address, 'Тестовая 1');
  assert.equal(list.complaints[0].source, 'telegram');
});

test('Telegram prepared reply persists before transport failure; retry cannot append text twice', async () => {
  const storage = new Storage(); let reject = false; const sent = [];
  const transport = { sendMessage: async (_chat, text) => { if (reject) throw new Error('offline'); sent.push(text); } };
  for (const [id, text] of [[10, '/agree'], [11, 'Тест: разбитая дорога возле школы']]) {
    if (id === 11) reject = true;
    const runtime = createComplaintRuntime({ storage, env, transport });
    assert.equal((await runtime.fetch(webhook(update(id, text)))).status, id === 11 ? 500 : 200);
  }
  reject = false;
  const runtime = createComplaintRuntime({ storage, env, transport });
  assert.equal((await runtime.fetch(webhook(update(11, 'Тест: разбитая дорога возле школы')))).status, 200);
  await runtime.fetch(webhook(update(12, '/send')));
  const list = await (await runtime.fetch(request('/api/complaints', 'GET', undefined, admin))).json();
  assert.equal(list.complaints[0].text, 'Тест: разбитая дорога возле школы');
});

test('Worker denies forged webhook, body overflow, cross-origin intake and missing deployment binding', async () => {
  const runtime = createComplaintRuntime({ storage: new Storage(), env, transport: {} });
  assert.equal((await runtime.fetch(request('/api/telegram/webhook', 'POST', update(1, '/start')))).status, 401);
  assert.equal((await runtime.fetch(webhook({ text: 'x'.repeat(33000) }))).status, 413);
  assert.equal((await runtime.fetch(request('/api/complaints', 'POST', {}, { origin: 'https://attacker.example' }))).status, 403);
  assert.equal((await routeComplaintRequest(request('/api/complaints'), {})).status, 503);
  assert.equal(await routeComplaintRequest(request('/api/health'), {}), null);
  assert.equal((await runtime.fetch(request('/api/complaints', 'DELETE'))).status, 405);
});

test('Intake limit persists over runtime eviction; expired private draft is cleaned by alarm', async () => {
  const storage = new Storage(); let time = Date.now(); const transport = { sendMessage: async () => {} };
  for (let i = 0; i < 60; i++) {
    const runtime = createComplaintRuntime({ storage, env, transport, now: () => time });
    assert.equal((await runtime.fetch(request('/api/complaints/track', 'POST', {}))).status, 404);
  }
  const runtime = createComplaintRuntime({ storage, env, transport, now: () => time });
  assert.equal((await runtime.fetch(request('/api/complaints/track', 'POST', {}))).status, 429);
  await runtime.fetch(webhook(update(100, '/agree')));
  assert.equal((await storage.list({ prefix: 'telegram-session:' })).size, 1);
  time += 31 * 60000;
  await runtime.alarm();
  assert.equal((await storage.list({ prefix: 'telegram-session:' })).size, 0);
});

test('receipt recovery clears the submitted draft after checkpoint rollback and cannot create it twice', async () => {
  const storage = new Storage(); const sent = [];
  const transport = { sendMessage: async (_chat, text) => sent.push(text) };
  for (const [id, text] of [[201, '/agree'], [202, 'Первая жалоба: возле дома не горит фонарь']]) {
    assert.equal((await deliverAfterEviction(storage, transport, id, text)).status, 200);
  }
  failReceiptCheckpointOnce(storage, 203);
  assert.equal((await deliverAfterEviction(storage, transport, 203, '/send')).status, 500);
  const complaints = await storage.list({ prefix: 'complaints:record:' });
  assert.equal(complaints.size, 1, 'the complaint committed before the injected checkpoint failure');
  const savedComplaint = [...complaints.values()][0].complaint;
  assert.equal((await storage.get('telegram-session:888')).state.drafts[0][1].submittingUpdateId, 203);
  assert.equal(await storage.get('telegram-update:203'), undefined, 'the failed checkpoint did not partially commit');
  assert.equal((await deliverAfterEviction(storage, transport, 203, '/send')).status, 200);
  assert.deepEqual((await storage.get('telegram-session:888')).state.drafts, []);
  assert.equal((await storage.get('telegram-update:203')).entry.complete, true);
  assert.ok(sent.at(-1).includes(savedComplaint.id));
  assert.ok(sent.at(-1).includes(savedComplaint.trackingToken), 'recovery returns the original durable receipt');
  assert.equal((await deliverAfterEviction(storage, transport, 204, '/send')).status, 200);
  assert.equal((await storage.list({ prefix: 'complaints:record:' })).size, 1);
});

test('the delivery ledger deduplicates completed and pending text after it leaves the recent session window', async t => {
  for (const failFirstReply of [false, true]) {
    await t.test(failFirstReply ? 'pending reply' : 'completed reply', async () => {
      const storage = new Storage(); const sent = []; let reject = false;
      const transport = { sendMessage: async (_chat, text) => {
        if (reject) { reject = false; throw new Error('Injected transport failure'); }
        sent.push(text);
      } };
      const description = 'Тестовая жалоба: возле школы повреждён тротуар';
      assert.equal((await deliverAfterEviction(storage, transport, 301, '/agree')).status, 200);
      reject = failFirstReply;
      assert.equal((await deliverAfterEviction(storage, transport, 302, description)).status, failFirstReply ? 500 : 200);
      for (let id = 303; id <= 311; id += 1) {
        assert.equal((await deliverAfterEviction(storage, transport, id, '/photo')).status, 200);
      }
      const before = (await storage.get('telegram-session:888')).state;
      assert.equal(before.updates.some(([id]) => id === 302), false, 'retry must use the separate delivery ledger');
      assert.equal(before.drafts[0][1].text, description);
      assert.equal((await storage.get('telegram-update:302')).entry.complete, !failFirstReply);
      const replyCount = sent.length;
      assert.equal((await deliverAfterEviction(storage, transport, 302, description)).status, 200);
      assert.equal(sent.length, replyCount + (failFirstReply ? 1 : 0));
      assert.equal((await storage.get('telegram-session:888')).state.drafts[0][1].text, description);
      assert.equal((await storage.get('telegram-update:302')).entry.complete, true);
      assert.equal((await deliverAfterEviction(storage, transport, 312, '/send')).status, 200);
      const complaints = await storage.list({ prefix: 'complaints:record:' });
      assert.equal(complaints.size, 1);
      assert.equal([...complaints.values()][0].complaint.text, description);
    });
  }
});

test('recovering an older submitted receipt preserves a later replacement draft', async () => {
  const storage = new Storage(); const sent = [];
  const transport = { sendMessage: async (_chat, text) => sent.push(text) };
  const original = 'Первое обращение: требуется ремонт дороги';
  const replacement = 'Новое обращение: переполнен мусорный контейнер';
  await deliverAfterEviction(storage, transport, 401, '/agree');
  await deliverAfterEviction(storage, transport, 402, original);
  failReceiptCheckpointOnce(storage, 403);
  assert.equal((await deliverAfterEviction(storage, transport, 403, '/send')).status, 500);
  const originalComplaint = [...(await storage.list({ prefix: 'complaints:record:' })).values()][0].complaint;
  for (const [id, text] of [[404, '/cancel'], [405, '/agree'], [406, replacement]]) {
    assert.equal((await deliverAfterEviction(storage, transport, id, text)).status, 200);
  }
  const before = (await storage.get('telegram-session:888')).state.drafts;
  assert.equal(before[0][1].text, replacement);
  assert.equal(before[0][1].submittingUpdateId, undefined);
  assert.equal((await deliverAfterEviction(storage, transport, 403, '/send')).status, 200);
  assert.deepEqual((await storage.get('telegram-session:888')).state.drafts, before);
  assert.ok(sent.at(-1).includes(originalComplaint.id));
  assert.ok(sent.at(-1).includes(originalComplaint.trackingToken));
  assert.equal((await deliverAfterEviction(storage, transport, 407, '/send')).status, 200);
  const complaints = [...(await storage.list({ prefix: 'complaints:record:' })).values()].map(value => value.complaint);
  assert.equal(complaints.length, 2);
  assert.deepEqual(new Set(complaints.map(record => record.text)), new Set([original, replacement]));
  assert.deepEqual((await storage.get('telegram-session:888')).state.drafts, []);
});
