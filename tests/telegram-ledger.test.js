import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramProcessor, cleanupTelegramUpdates } from '../src/complaints/telegram.js';
import { createDurableComplaintStore } from '../src/complaints/durable-store.js';

const DAY = 24 * 60 * 60 * 1000;
const update = (id, text, chatId = 100) => ({
  update_id: id, message: { chat: { id: chatId, type: 'private' }, from: { id: chatId }, text },
});

class MemoryStorage {
  values = new Map();
  alarm = null;
  tail = Promise.resolve();
  failPut = null;
  failAlarm = false;
  listCalls = [];

  run(operation) {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  select(values, options) {
    this.listCalls.push(options);
    return structuredClone(new Map([...values]
      .sort(([left], [right]) => left.localeCompare(right))
      .filter(([key]) => (!options.prefix || key.startsWith(options.prefix))
        && (!options.end || key < options.end))
      .slice(0, options.limit ?? Infinity)));
  }

  get(key) { return this.run(() => structuredClone(this.values.get(key))); }
  list(options) { return this.run(() => this.select(this.values, options)); }
  getAlarm() { return this.run(() => this.alarm); }
  setAlarm(time) { return this.run(() => { this.alarm = time; }); }
  put(key, value) {
    return this.run(() => {
      const pending = structuredClone(this.values);
      const entries = typeof key === 'string' ? [[key, value]] : Object.entries(key);
      for (const [name, data] of entries) pending.set(name, structuredClone(data));
      if (this.failPut?.(entries)) throw new Error('atomic commit unavailable');
      this.values = pending;
    });
  }

  transaction(operation) {
    return this.run(async () => {
      const pending = structuredClone(this.values);
      let alarm = this.alarm;
      const result = await operation({
        get: async key => structuredClone(pending.get(key)),
        list: async options => this.select(pending, options),
        put: async (key, value) => {
          const entries = typeof key === 'string' ? [[key, value]] : Object.entries(key);
          for (const [name, data] of entries) pending.set(name, structuredClone(data));
          if (this.failPut?.(entries)) throw new Error('atomic commit unavailable');
        },
        delete: async key => pending.delete(key),
        getAlarm: async () => alarm,
        setAlarm: async time => {
          if (this.failAlarm) throw new Error('alarm commit unavailable');
          alarm = time;
        },
      });
      this.values = pending;
      this.alarm = alarm;
      return result;
    });
  }
}

function fixture(storage = new MemoryStorage(), sendMessage) {
  const sent = [];
  const store = createDurableComplaintStore({ storage });
  return { storage, sent, store, process: createTelegramProcessor({ store, sessionStorage: storage,
    sendMessage: sendMessage ?? (async (chat, text) => { sent.push({ chat, text }); }),
  }) };
}

test('old text remains deduplicated after 34 newer updates and processor restart', async () => {
  const first = fixture();
  const text = 'x'.repeat(55);
  await first.process(update(1, '/agree'));
  await first.process(update(2, text));
  for (let id = 3; id <= 36; id++) await first.process(update(id, '/agree'));
  const saved = first.storage.values.get('telegram:session:100');
  assert.equal(saved.updates.length, 32);
  assert.equal(saved.updates.some(entry => entry.id === 2), false);
  assert.equal(saved.draft.text.length, 55);
  const sentBefore = first.sent.length;
  assert.equal((await first.process(update(2, text))).duplicateUpdate, true);
  assert.equal(first.sent.length, sentBefore);
  assert.equal(first.storage.values.get('telegram:session:100').draft.text.length, 55);

  // Evict again so the restarted processor must consult the independent ledger.
  for (let id = 37; id <= 70; id++) await first.process(update(id, '/agree'));
  const restarted = fixture(first.storage);
  assert.equal((await restarted.process(update(2, text))).duplicateUpdate, true);
  assert.equal(restarted.sent.length, 0);
  assert.equal(first.storage.values.get('telegram:session:100').draft.text, text);
});

test('evicted receipt replay sends nothing, creates nothing, and preserves a newer draft', async () => {
  const first = fixture();
  await first.process(update(1, '/agree'));
  await first.process(update(2, 'Возле школы повреждён тротуар.'));
  const receipt = await first.process(update(3, '/send'));
  await first.process(update(4, '/agree'));
  await first.process(update(5, 'Новое обращение о сломанном фонаре.'));
  for (let id = 6; id <= 40; id++) await first.process(update(id, '/agree'));
  const draft = structuredClone(first.storage.values.get('telegram:session:100').draft);
  const restarted = fixture(first.storage);
  const replay = await restarted.process(update(3, '/send'));
  assert.equal(replay.duplicateUpdate, true);
  assert.equal(replay.complaintId, receipt.complaintId);
  assert.equal(restarted.sent.length, 0);
  assert.deepEqual(first.storage.values.get('telegram:session:100').draft, draft);
  assert.equal((await restarted.store.list()).stats.total, 1);
  const next = await restarted.process(update(41, '/send'));
  assert.notEqual(next.complaintId, receipt.complaintId);
  assert.equal((await restarted.store.list()).stats.total, 2);
});

test('an evicted undelivered reply resumes once without replaying its draft mutation', async () => {
  const storage = new MemoryStorage();
  let fail = true;
  const first = fixture(storage, async () => { if (fail) throw new Error('delivery unavailable'); });
  const text = 'Возле остановки не работает светофор.';
  await assert.rejects(first.process(update(1, text)), /delivery unavailable/);
  fail = false;
  for (let id = 2; id <= 36; id++) await first.process(update(id, '/agree'));
  assert.equal(storage.values.get('telegram:update:1').complete, false);
  const restarted = fixture(storage);
  await restarted.process(update(1, text));
  assert.equal(restarted.sent.length, 1);
  assert.equal(storage.values.get('telegram:session:100').draft.text, text);
  await restarted.process(update(1, text));
  assert.equal(restarted.sent.length, 1);
});

test('one blocked chat cannot block another or expose an update result to another chat', async () => {
  const storage = new MemoryStorage();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let started;
  const sending = new Promise(resolve => { started = resolve; });
  const first = fixture(storage, async chat => {
    if (chat === '100') { started(); await held; }
  });
  const blocked = first.process(update(1, '/agree', 100));
  await sending;
  assert.deepEqual(await first.process(update(1, '/agree', 200)), { ignored: true, duplicateUpdate: true });
  await first.process(update(2, '/agree', 200));
  assert.equal(storage.values.get('telegram:session:200').draft.consent, true);
  assert.equal(storage.values.get('telegram:update:2').chatId, '200');
  release();
  await blocked;
  assert.equal(storage.values.get('telegram:update:1').chatId, '100');
  const restarted = fixture(storage);
  assert.deepEqual(await restarted.process(update(1, '/agree', 200)), { ignored: true, duplicateUpdate: true });
  assert.equal(restarted.sent.length, 0);
});

test('failed atomic preparation commit changes neither the draft nor ledger and sends no reply', async () => {
  const first = fixture();
  await first.process(update(1, '/agree'));
  const before = structuredClone(first.storage.values);
  first.storage.failPut = entries => entries.some(([key]) => key === 'telegram:update:2');
  await assert.rejects(first.process(update(2, 'Во дворе не убран строительный мусор.')), /atomic commit unavailable/);
  assert.deepEqual(first.storage.values, before);
  assert.equal(first.sent.length, 1);
  first.storage.failPut = null;
  const restarted = fixture(first.storage);
  await restarted.process(update(2, 'Во дворе не убран строительный мусор.'));
  assert.equal(first.storage.values.get('telegram:session:100').draft.text, 'Во дворе не убран строительный мусор.');
  assert.equal(first.storage.values.get('telegram:update:2').complete, true);
  assert.equal(restarted.sent.length, 1);
});

test('alarm creation and prepared state roll back together when scheduling fails', async () => {
  const first = fixture();
  first.storage.failAlarm = true;
  await assert.rejects(first.process(update(1, 'Во дворе сломана скамейка.')), /alarm commit unavailable/);
  assert.equal(first.storage.values.size, 0);
  assert.equal(first.storage.alarm, null);
  assert.equal(first.sent.length, 0);
  first.storage.failAlarm = false;
  await first.process(update(1, 'Во дворе сломана скамейка.'));
  assert.equal(first.sent.length, 1);
  assert.equal(first.storage.values.get('telegram:session:100').draft.text, 'Во дворе сломана скамейка.');
  assert.equal(first.storage.alarm, first.storage.values.get('telegram:update:1').expiresAt);
});

test('failed preparation cannot leak through a later update and duplicate after cache eviction', async () => {
  const first = fixture();
  await first.process(update(1, '/agree'));
  const original = 'Возле школы повреждён тротуар.';
  const addition = 'На месте осталась глубокая яма.';
  await first.process(update(2, original));
  first.storage.failPut = entries => entries.some(([key]) => key === 'telegram:update:3');
  await assert.rejects(first.process(update(3, addition)), /atomic commit unavailable/);
  first.storage.failPut = null;
  for (let id = 4; id <= 44; id++) await first.process(update(id, '/agree'));
  assert.equal(first.storage.values.get('telegram:session:100').draft.text, original);
  assert.equal(first.storage.values.has('telegram:update:3'), false);
  const restarted = fixture(first.storage);
  await restarted.process(update(3, addition));
  assert.equal(first.storage.values.get('telegram:session:100').draft.text, `${original}\n${addition}`);
  await restarted.process(update(3, addition));
  assert.equal(restarted.sent.length, 1);
});

test('24-hour expiry is fixed, and bounded alarm batches retain unexpired ledger entries', async t => {
  let time = 1_000_000;
  t.mock.method(Date, 'now', () => time);
  const first = fixture();
  for (let id = 1; id <= 140; id++) await first.process(update(id, '/menu'));
  const expiresAt = time + DAY;
  assert.equal(first.storage.alarm, expiresAt);
  time += 1000;
  await first.process(update(141, '/menu'));
  assert.equal(first.storage.alarm, expiresAt, 'newer updates must not postpone the earliest expiry');
  time = expiresAt - 1;
  assert.equal((await first.process(update(1, '/menu'))).duplicateUpdate, true);
  assert.equal(first.storage.values.get('telegram:update:1').expiresAt, expiresAt, 'replay does not renew retention');
  time = expiresAt;
  const firstBatch = await cleanupTelegramUpdates(first.storage);
  assert.deepEqual(firstBatch, { removed: 128, more: true });
  assert.equal(first.storage.alarm, time + 1000);
  assert.deepEqual(await cleanupTelegramUpdates(first.storage), { removed: 12, more: false });
  assert.equal(first.storage.values.has('telegram:update:141'), true);
  assert.equal([...first.storage.values.keys()].filter(key => key.startsWith('telegram:update:')).length, 1);
  assert.ok(first.storage.listCalls.filter(options => options.prefix === 'telegram:update-expiry:')
    .every(options => options.limit > 0 && options.limit <= 128));
  assert.equal((await first.process(update(1, '/menu'))).duplicateUpdate, undefined,
    'expired updates are outside the 24-hour deduplication guarantee');
});

test('expiry cleanup cannot remove a new ledger entry behind an old expiry index', async t => {
  let time = 1_000_000;
  t.mock.method(Date, 'now', () => time);
  const first = fixture();
  await first.process(update(1, '/menu'));
  time += DAY;
  await first.process(update(1, '/menu'));
  const newExpiry = time + DAY;
  assert.equal(first.storage.values.get('telegram:update:1').expiresAt, newExpiry);
  assert.deepEqual(await cleanupTelegramUpdates(first.storage), { removed: 0, more: false });
  assert.equal(first.storage.values.get('telegram:update:1').expiresAt, newExpiry);
  assert.equal(first.storage.alarm, newExpiry);
});
