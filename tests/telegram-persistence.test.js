import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramProcessor, TELEGRAM_BUTTONS as B } from '../src/complaints/telegram.js';
import { createDurableComplaintStore } from '../src/complaints/durable-store.js';

function memoryStorage() {
  const values = new Map();
  const reads = [];
  const writes = [];
  return {
    values, reads, writes,
    async get(key) { reads.push(key); return structuredClone(values.get(key)); },
    async put(key, value) {
      writes.push({ key, value: structuredClone(value) });
      const entries = typeof key === 'string' ? [[key, value]] : Object.entries(key);
      for (const [name, data] of entries) values.set(name, structuredClone(data));
    },
    async list({ prefix }) { return structuredClone(new Map([...values].filter(([key]) => key.startsWith(prefix)))); },
    async transaction(operation) {
      const pending = structuredClone(values);
      const result = await operation({
        list: async ({ prefix }) => structuredClone(new Map([...pending].filter(([key]) => key.startsWith(prefix)))),
        put: async (key, value) => { pending.set(key, structuredClone(value)); },
        delete: async key => { pending.delete(key); },
      });
      values.clear();
      for (const [key, value] of pending) values.set(key, value);
      return result;
    },
  };
}

function complaintStore() {
  const records = [];
  return {
    records,
    async create(input) {
      const existing = records.find(record => record.telegramUpdateId === input.telegramUpdateId);
      if (existing) return { complaint: existing, trackingToken: 'private-test-code', duplicateUpdate: true };
      if (!input.consent || input.text.length < 10) throw Object.assign(new Error('invalid'), { status: 400 });
      const record = { ...structuredClone(input), id: `C-${records.length + 1}`, status: 'new' };
      records.push(record);
      return { complaint: record, trackingToken: 'private-test-code' };
    },
    async get(id) { return records.find(record => record.id === id); },
    async track() { throw Object.assign(new Error('missing'), { status: 404 }); },
  };
}

function update(id, text, chat = 100) {
  return { update_id: id, message: { chat: { id: chat, type: 'private' }, from: { id: chat }, text } };
}

function setup(sessionStorage = memoryStorage(), store = complaintStore(), sendMessage) {
  const sent = [];
  return {
    sessionStorage, store, sent,
    process: createTelegramProcessor({ store, sessionStorage, sendMessage: sendMessage ?? (async (chat, text, options) => { sent.push({ chat, text, options }); }) }),
  };
}

test('durable draft, address screen and sent-update deduplication survive processor recreation', async () => {
  const first = setup();
  await first.process(update(1, B.agree));
  await first.process(update(2, 'На улице не работает освещение.'));
  await first.process(update(3, B.address));
  const next = setup(first.sessionStorage, first.store);
  assert.equal((await next.process(update(2, 'На улице не работает освещение.'))).duplicateUpdate, true);
  assert.equal(next.sent.length, 0);
  await next.process(update(4, 'Тестовая улица, 12'));
  await next.process(update(5, B.send));
  assert.equal(next.store.records.length, 1);
  assert.equal(next.store.records[0].text, 'На улице не работает освещение.');
  assert.equal(next.store.records[0].address, 'Тестовая улица, 12');
  const third = setup(first.sessionStorage, first.store);
  assert.equal((await third.process(update(5, B.send))).duplicateUpdate, true);
  assert.equal(third.store.records.length, 1);
  assert.equal(third.sent.length, 0);
  await third.process(update(6, B.menu));
  assert.ok(!third.sent.at(-1).options.replyMarkup.keyboard.flat().some(button => button.text === B.resume));
});

test('prepared draft mutation and reply are durable before delivery and completion is saved afterward', async () => {
  const storage = memoryStorage();
  const store = complaintStore();
  let captured;
  const first = setup(storage, store, async () => {
    captured = structuredClone(storage.values.get('telegram:session:100'));
    throw new Error('transport unavailable');
  });
  const message = update(1, 'Возле остановки не работает светофор.');
  await assert.rejects(first.process(message), /transport unavailable/u);
  assert.equal(captured.draft.text, message.message.text);
  assert.equal(captured.updates[0].complete, false);
  const next = setup(storage, store);
  await Promise.all([next.process(message), next.process(message)]);
  assert.equal(next.sent.length, 1);
  assert.equal(next.sent[0].text, captured.updates[0].prepared.text);
  assert.equal(storage.values.get('telegram:session:100').updates[0].complete, true);
  await next.process(update(2, B.agree));
  await next.process(update(3, B.send));
  assert.equal(store.records[0].text, message.message.text);
});

test('failed receipt delivery retries after recreation without creating another complaint', async () => {
  const first = setup();
  await first.process(update(1, B.agree));
  await first.process(update(2, 'На детской площадке сломана скамейка.'));
  const failing = setup(first.sessionStorage, first.store, async () => { throw new Error('offline'); });
  await assert.rejects(failing.process(update(3, B.send)), /offline/u);
  assert.equal(first.store.records.length, 1);
  const next = setup(first.sessionStorage, first.store);
  const result = await next.process(update(3, B.send));
  assert.equal(result.complaintId, 'C-1');
  assert.equal(next.sent.length, 1);
  assert.match(next.sent[0].text, /Обращение принято/u);
  assert.equal(first.store.records.length, 1);
});

test('crash after complaint commit clears the submitted generation on replay but preserves a newer draft', async () => {
  const storage = memoryStorage();
  const store = complaintStore();
  const first = setup(storage, store);
  await first.process(update(1, B.agree));
  await first.process(update(2, 'Возле школы повреждён тротуар.'));
  const generation = storage.values.get('telegram:session:100').draft.generation;
  const realPut = storage.put.bind(storage);
  storage.put = async (key, value) => {
    if (store.records.length) throw new Error('crash after complaint commit');
    await realPut(key, value);
  };
  await assert.rejects(first.process(update(3, B.send)), /crash after complaint commit/u);
  assert.equal(store.records[0].telegramDraftId, generation);
  assert.equal(storage.values.get('telegram:session:100').draft.generation, generation);
  storage.put = realPut;
  const recovered = setup(storage, store);
  assert.equal((await recovered.process(update(3, B.send))).duplicateUpdate, true);
  assert.equal(storage.values.get('telegram:session:100').draft, null);
  await recovered.process(update(4, B.send));
  assert.equal(store.records.length, 1, 'a subsequent send must not resubmit the stale draft');
  await recovered.process(update(5, B.agree));
  await recovered.process(update(6, 'Новое обращение о повреждённом фонаре.'));
  const newerGeneration = storage.values.get('telegram:session:100').draft.generation;
  assert.notEqual(newerGeneration, generation);
  for (let id = 7; id <= 40; id++) await recovered.process(update(id, B.help));
  const restarted = setup(storage, store);
  assert.equal((await restarted.process(update(3, B.send))).duplicateUpdate, true);
  assert.equal(storage.values.get('telegram:session:100').draft.generation, newerGeneration);
  await restarted.process(update(41, B.send));
  assert.equal(store.records.length, 2);
  assert.equal(store.records[1].text, 'Новое обращение о повреждённом фонаре.');
});

test('new send after a post-commit crash returns the same durable receipt before the original update is retried', async () => {
  const storage = memoryStorage();
  const first = setup(storage, createDurableComplaintStore({ storage }));
  await first.process(update(1, B.agree));
  await first.process(update(2, 'Возле школы повреждён тротуар.'));
  const realPut = storage.put.bind(storage);
  storage.put = async (key, value) => {
    if ([...storage.values.keys()].some(key => key.startsWith('complaint:'))) {
      throw new Error('crash after complaint commit');
    }
    await realPut(key, value);
  };
  await assert.rejects(first.process(update(3, B.send)), /crash after complaint commit/u);
  const original = [...storage.values].find(([key]) => key.startsWith('complaint:'))[1];
  assert.equal(storage.values.get('telegram:session:100').draft.generation, original.telegramDraftId);

  storage.put = realPut;
  const recovered = setup(storage, createDurableComplaintStore({ storage }));
  const result = await recovered.process(update(4, B.send));
  assert.equal(result.complaintId, original.id);
  assert.equal(result.duplicateUpdate, true);
  assert.equal((await recovered.store.list()).stats.total, 1);
  assert.equal(storage.values.get('telegram:session:100').draft, null);
  assert.ok(recovered.sent.at(-1).text.includes(original.trackingToken));
  assert.equal((await recovered.process(update(3, B.send))).complaintId, original.id);

  await recovered.process(update(5, B.agree));
  await recovered.process(update(6, 'Новое обращение о повреждённом фонаре.'));
  const next = await recovered.process(update(7, B.send));
  assert.notEqual(next.complaintId, original.id);
  assert.equal((await recovered.store.list()).stats.total, 2);
});

test('durable draft deduplication serializes concurrent sends and is scoped to the Telegram chat', async () => {
  const storage = memoryStorage();
  const store = createDurableComplaintStore({ storage });
  const input = { text: 'Возле школы повреждён тротуар.', consent: true, source: 'telegram',
    telegramChatId: '100', telegramDraftId: '1df832fc-f38e-4f96-888f-292952b5c274' };
  const [first, replay] = await Promise.all([
    store.create({ ...input, telegramUpdateId: 10 }),
    store.create({ ...input, telegramUpdateId: 11 }),
  ]);
  assert.equal(replay.complaint.id, first.complaint.id);
  assert.equal(replay.trackingToken, first.trackingToken);
  assert.equal(replay.duplicateUpdate, true);
  const other = await store.create({ ...input, telegramChatId: '200', telegramUpdateId: 12 });
  assert.notEqual(other.complaint.id, first.complaint.id);
  assert.equal((await store.list()).stats.total, 2);
});

test('storage failures propagate and preparation writes must succeed before delivery', async () => {
  const storage = memoryStorage();
  const realPut = storage.put.bind(storage);
  storage.put = async () => { throw new Error('storage unavailable'); };
  const first = setup(storage);
  const message = update(1, 'На улице не работает освещение.');
  await assert.rejects(first.process(message), /storage unavailable/u);
  assert.equal(first.sent.length, 0);
  storage.put = realPut;
  await first.process(message);
  assert.equal(first.sent.length, 1);
  assert.equal(storage.values.get('telegram:session:100').draft.text, message.message.text);
  const readFailure = setup({ get: async () => { throw new Error('read unavailable'); }, put: realPut });
  await assert.rejects(readFailure.process(update(2, B.menu)), /read unavailable/u);
  assert.equal(readFailure.sent.length, 0);
});

test('completion write failure is retried without resending in the same processor', async () => {
  const storage = memoryStorage();
  const realPut = storage.put.bind(storage);
  let writes = 0;
  storage.put = async (key, value) => {
    if (++writes === 2) throw new Error('completion unavailable');
    await realPut(key, value);
  };
  const first = setup(storage);
  const message = update(1, B.menu);
  await assert.rejects(first.process(message), /completion unavailable/u);
  assert.equal(first.sent.length, 1);
  assert.equal((await first.process(message)).duplicateUpdate, true);
  assert.equal(first.sent.length, 1);
  assert.equal(storage.values.get('telegram:session:100').updates[0].complete, true);
});

test('chat snapshots are independent and retain at most 32 replies', async () => {
  const first = setup();
  for (let id = 1; id <= 40; id++) await first.process(update(id, B.menu));
  await first.process(update(41, B.agree, 200));
  const main = first.sessionStorage.values.get('telegram:session:100');
  assert.equal(main.updates.length, 32);
  assert.deepEqual(main.updates.map(entry => entry.id), Array.from({ length: 32 }, (_, index) => index + 9));
  assert.equal([...first.sessionStorage.values.keys()].filter(key => key.startsWith('telegram:session:')).length, 2);
  assert.equal([...first.sessionStorage.values.keys()].filter(key => key.startsWith('telegram:update:')).length, 41);
  assert.equal(first.sessionStorage.values.get('telegram:session:200').draft.consent, true);
  assert.equal(main.draft, null);
  assert.ok(Buffer.byteLength(JSON.stringify(main)) < 2 * 1024 * 1024);
});

test('draft and screen TTL cleanup preserves recent deduplication and expires old reply history', async () => {
  const first = setup();
  await first.process(update(1, B.agree));
  await first.process(update(2, 'Возле школы повреждён пешеходный переход.'));
  await first.process(update(3, B.address));
  const saved = first.sessionStorage.values.get('telegram:session:100');
  saved.draft.updatedAt -= 31 * 60 * 1000;
  saved.screen.updatedAt -= 31 * 60 * 1000;
  saved.updates[0].createdAt -= 25 * 60 * 60 * 1000;
  const next = setup(first.sessionStorage, first.store);
  assert.equal((await next.process(update(2, 'Возле школы повреждён пешеходный переход.'))).duplicateUpdate, true);
  const cleaned = first.sessionStorage.values.get('telegram:session:100');
  assert.equal(cleaned.draft, null);
  assert.equal(cleaned.screen, null);
  assert.deepEqual(cleaned.updates.map(entry => entry.id), [2, 3]);
  await next.process(update(4, B.resume));
  assert.match(next.sent.at(-1).text, /Незавершённого обращения нет/u);
});

test('reply history expires while the processor remains alive', async (t) => {
  const first = setup();
  await first.process(update(1, B.menu));
  const later = Date.now() + 25 * 60 * 60 * 1000;
  t.mock.method(Date, 'now', () => later);
  const result = await first.process(update(1, B.menu));
  assert.equal(result.duplicateUpdate, undefined);
  assert.equal(first.sent.length, 2);
  assert.equal(first.sessionStorage.values.get('telegram:session:100').updates[0].createdAt, later);
});

test('sessions reload lazily after the bounded in-memory chat cache evicts a chat', async () => {
  const first = setup();
  await first.process(update(1, B.agree));
  await first.process(update(2, 'Во дворе не убран строительный мусор.'));
  for (let id = 3; id <= 1002; id++) await first.process(update(id, B.menu, id + 1000));
  await first.process(update(1003, B.send));
  assert.equal(first.store.records[0].text, 'Во дворе не убран строительный мусор.');
  assert.equal(first.sessionStorage.reads.filter(key => key === 'telegram:session:100').length, 2);
});
