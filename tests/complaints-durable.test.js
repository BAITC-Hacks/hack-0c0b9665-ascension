import test from 'node:test';
import assert from 'node:assert/strict';
import { createDurableComplaintStore } from '../src/complaints/durable-store.js';

const input = { text: 'Тестовое обращение: яма на дороге возле остановки.', address: 'Тестовая улица, 5', consent: true };

class MemoryStorage {
  entries = new Map();
  writes = [];
  failCommit = false;
  async list({ prefix }) {
    return structuredClone(new Map([...this.entries].filter(([key]) => key.startsWith(prefix))));
  }
  async transaction(operation) {
    const pending = structuredClone(this.entries);
    const writes = [];
    const result = await operation({
      list: async ({ prefix }) => structuredClone(new Map([...pending].filter(([key]) => key.startsWith(prefix)))),
      put: async (key, value) => {
        // Keep the test strict enough for the older, smaller per-value storage limit too.
        assert.ok(Buffer.byteLength(JSON.stringify(value)) < 128 * 1024);
        pending.set(key, structuredClone(value));
        writes.push(key);
      },
      delete: async key => { pending.delete(key); writes.push(key); },
    });
    if (this.failCommit) throw new Error('synthetic storage outage with private upstream details');
    this.entries = pending;
    this.writes.push(...writes);
    return result;
  }
}

test('durable complaints survive restart and keep private tracking and Telegram replay protection', async () => {
  const storage = new MemoryStorage();
  const store = createDurableComplaintStore({ storage });
  const receipt = await store.create({ ...input, source: 'telegram', telegramChatId: '123456', telegramUpdateId: 77,
    attachments: [{ type: 'photo', fileId: 'private-photo-file' }] });
  const restarted = createDurableComplaintStore({ storage });
  const replay = await restarted.create({ source: 'telegram', telegramUpdateId: 77 });
  assert.equal(replay.duplicateUpdate, true);
  assert.equal(replay.complaint.id, receipt.complaint.id);
  assert.equal(replay.trackingToken, receipt.trackingToken);
  assert.equal((await restarted.list()).stats.total, 1);
  await restarted.update(receipt.complaint.id, { status: 'resolved', resolution: 'Дорога восстановлена.' });
  const publicRecord = await store.track(receipt.complaint.id, receipt.trackingToken);
  assert.equal(publicRecord.status, 'resolved');
  assert.doesNotMatch(JSON.stringify(publicRecord), /private-photo-file|123456|Тестовая улица/u);
  await assert.rejects(store.track(receipt.complaint.id, 'wrong'), { status: 404 });
});

test('multiple durable adapters serialize concurrent creations and stale edits', async () => {
  const storage = new MemoryStorage();
  const first = createDurableComplaintStore({ storage });
  const second = createDurableComplaintStore({ storage });
  const receipts = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    (index % 2 ? first : second).create({ ...input, text: `${input.text} Номер теста ${index}.` })));
  assert.equal((await first.list()).stats.total, 20);
  assert.equal(new Set(receipts.map(receipt => receipt.complaint.id)).size, 20);
  const record = receipts[0].complaint;
  const changes = await Promise.allSettled([
    first.update(record.id, { expectedUpdatedAt: record.updatedAt, status: 'in_progress', assignee: 'Первая служба' }),
    second.update(record.id, { expectedUpdatedAt: record.updatedAt, status: 'in_progress', assignee: 'Вторая служба' }),
  ]);
  assert.equal(changes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(changes.find(result => result.status === 'rejected').reason.code, 'COMPLAINT_CHANGED');
});

test('durable data uses separate record keys and writes only changed records', async () => {
  const storage = new MemoryStorage();
  storage.entries.set('telegram:session:123456', { draft: 'unrelated state' });
  const store = createDurableComplaintStore({ storage });
  const receipts = [];
  for (let index = 0; index < 35; index++) {
    receipts.push(await store.create({ ...input, text: `Тест ${index}: ${'дорожная проблема '.repeat(220)}` }));
  }
  assert.ok(Buffer.byteLength(JSON.stringify([...storage.entries.values()])) > 128 * 1024);
  assert.equal(storage.entries.size, 36);
  assert.equal(storage.writes.length, 35);
  assert.ok(storage.writes.every(key => /^complaint:C-[A-F0-9]{16}$/u.test(key)));
  storage.writes.length = 0;
  await store.update(receipts[0].complaint.id, { assignee: 'Тестовая служба' });
  assert.deepEqual(storage.writes, [`complaint:${receipts[0].complaint.id}`]);
  assert.deepEqual(storage.entries.get('telegram:session:123456'), { draft: 'unrelated state' });
});

test('durable transaction failure preserves existing data and permits later retry', async () => {
  const storage = new MemoryStorage();
  const store = createDurableComplaintStore({ storage });
  const receipt = await store.create(input);
  const before = structuredClone(storage.entries);
  storage.failCommit = true;
  await assert.rejects(store.update(receipt.complaint.id, { status: 'resolved', resolution: 'Исправлено.' }), error => {
    assert.equal(error.code, 'COMPLAINT_STORAGE_ERROR');
    assert.doesNotMatch(error.message, /private upstream/u);
    return true;
  });
  assert.deepEqual(storage.entries, before);
  storage.failCommit = false;
  await store.update(receipt.complaint.id, { assignee: 'Повторная попытка' });
  assert.equal((await store.get(receipt.complaint.id)).assignee, 'Повторная попытка');
});

test('corrupt records, duplicate Telegram updates and mismatched keys are rejected before writes', async () => {
  const storage = new MemoryStorage();
  const store = createDurableComplaintStore({ storage });
  const receipt = await store.create({ ...input, source: 'telegram', telegramChatId: '123456', telegramUpdateId: 90 });
  const original = structuredClone(storage.entries);
  const corruptionCases = [
    entries => { entries.get(`complaint:${receipt.complaint.id}`).location = { lat: 200, lon: 0 }; },
    entries => { entries.set('complaint:C-0000000000000000', structuredClone(receipt.complaint)); },
    entries => { entries.set('complaint:C-0000000000000000', { ...structuredClone(receipt.complaint), id: 'C-0000000000000000' }); },
    entries => { entries.delete(`complaint:${receipt.complaint.id}`); entries.set('complaint:wrong-key', receipt.complaint); },
  ];
  for (const corrupt of corruptionCases) {
    storage.entries = structuredClone(original);
    corrupt(storage.entries);
    const before = structuredClone(storage.entries);
    await assert.rejects(store.create(input), { code: 'COMPLAINT_STORAGE_CORRUPT' });
    assert.deepEqual(storage.entries, before);
  }
});
