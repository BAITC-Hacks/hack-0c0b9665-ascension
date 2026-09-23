import test from 'node:test';
import assert from 'node:assert/strict';
import { createDurableComplaintStore } from '../src/complaints-worker/store.js';

const input = { text: 'Большая яма на дороге возле дома', address: 'Тестовая улица, 10', districtId: 'nura', consent: true };
const prefix = 'complaints:record:';
const fails = (status, code) => error => error.status === status && error.code === code;

// Deliberately does not serialize transactions: the adapter must coordinate its
// own instances. Clone-on-write models persistence, rollback, and process restart.
class MemoryStorage {
  constructor(data = new Map()) { this.data = data; this.writes = []; }
  async transaction(operation) {
    const working = structuredClone(this.data);
    const writes = [];
    const result = await operation({
      list: async ({ prefix: requested }) => {
        if (this.failRead) { this.failRead = false; throw new Error('private database failure'); }
        return new Map([...working].filter(([key]) => key.startsWith(requested)).sort(([a], [b]) => a.localeCompare(b)));
      },
      put: async (key, value) => {
        if (this.failWrite) { this.failWrite = false; throw new Error('private database failure'); }
        assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 128 * 1024, 'individual KV value stays bounded');
        working.set(key, structuredClone(value));
        writes.push(key);
      },
    });
    if (this.failCommit) { this.failCommit = false; throw new Error('private commit failure'); }
    this.data.clear();
    for (const [key, value] of working) this.data.set(key, value);
    this.writes.push(...writes);
    return result;
  }
  restart() { return new MemoryStorage(this.data); }
}

test('durable receipts, private data and changes survive new storage/store instances', async () => {
  const storage = new MemoryStorage();
  const store = createDurableComplaintStore({ storage });
  const receipt = await store.create({ ...input, source: 'telegram', telegramChatId: '123456789', telegramUpdateId: 71,
    attachments: [{ type: 'photo', fileId: 'private-photo-file', fileUniqueId: 'private-unique-file' }] });
  const restarted = createDurableComplaintStore({ storage: storage.restart() });
  assert.deepEqual(await restarted.get(receipt.complaint.id), receipt.complaint);
  const replay = await restarted.create({ source: 'telegram', telegramUpdateId: 71 });
  assert.equal(replay.duplicateUpdate, true);
  assert.equal(replay.trackingToken, receipt.trackingToken);
  const changed = await restarted.update(receipt.complaint.id, { status: 'in_progress', assignee: 'Дорожная служба',
    summary: 'PrivateResidentName передал сведения', expectedUpdatedAt: receipt.complaint.updatedAt });
  const again = createDurableComplaintStore({ storage: storage.restart() });
  assert.deepEqual(await again.get(receipt.complaint.id), changed);
  const tracked = await again.track(receipt.complaint.id, receipt.trackingToken);
  assert.equal(tracked.status, 'in_progress');
  assert.equal(tracked.history.length, 2);
  for (const secret of [receipt.trackingToken, '123456789', 'private-photo-file', 'PrivateResidentName']) {
    assert.equal(JSON.stringify(tracked).includes(secret), false);
  }
  const listed = await again.list({ status: 'in_progress' });
  assert.equal(listed.stats.total, 1);
  assert.deepEqual(listed.complaints[0].attachments, [{ type: 'photo', index: 0 }]);
  assert.equal('trackingToken' in listed.complaints[0], false);
  await assert.rejects(again.track(receipt.complaint.id, 'x'.repeat(43)), fails(404, 'COMPLAINT_NOT_FOUND'));
});

test('concurrent stores preserve every record and concurrent Telegram replay keeps one receipt', async () => {
  const storage = new MemoryStorage();
  const one = createDurableComplaintStore({ storage });
  const two = createDurableComplaintStore({ storage });
  const receipts = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? one : two)
    .create({ ...input, text: `Большая яма на тестовой дороге номер ${index}` })));
  assert.equal(new Set(receipts.map(receipt => receipt.complaint.id)).size, 20);
  const telegram = { ...input, source: 'telegram', telegramChatId: '123', telegramUpdateId: 80 };
  const replays = await Promise.all([one.create(telegram), two.create(telegram), one.create(telegram)]);
  assert.equal(replays.filter(receipt => !receipt.duplicateUpdate).length, 1);
  assert.equal(new Set(replays.map(receipt => receipt.trackingToken)).size, 1);
  assert.equal((await two.list()).stats.total, 21);
  const id = receipts[0].complaint.id;
  await Promise.all([one.update(id, { status: 'in_progress' }), two.update(id, { assignee: 'Служба' })]);
  const record = await createDurableComplaintStore({ storage: storage.restart() }).get(id);
  assert.equal(record.status, 'in_progress');
  assert.equal(record.assignee, 'Служба');
  assert.equal(record.history.length, 3);
});

test('durable storage uses separate record keys above the aggregate KV value limit', async () => {
  const storage = new MemoryStorage();
  storage.data.set('telegram:draft:123', { unrelated: true });
  const store = createDurableComplaintStore({ storage });
  const receipts = await Promise.all(Array.from({ length: 36 }, (_, index) =>
    store.create({ ...input, text: `${index} ${'x'.repeat(4990)}`, address: '' })));
  assert.ok(Buffer.byteLength(JSON.stringify([...storage.data.values()])) > 128 * 1024);
  assert.equal([...storage.data.keys()].filter(key => key.startsWith(prefix)).length, 36);
  assert.deepEqual(storage.data.get('telegram:draft:123'), { unrelated: true });
  const before = storage.writes.length;
  await store.update(receipts[0].complaint.id, { assignee: 'Дорожная служба' });
  assert.equal(storage.writes.length - before, 1, 'changing one complaint writes only that record');
  assert.equal((await createDurableComplaintStore({ storage: storage.restart() }).list()).stats.total, 36);
});

test('duplicate suggestions retain insertion order after restart and ignore closed cases', async () => {
  const storage = new MemoryStorage();
  const store = createDurableComplaintStore({ storage });
  const first = await store.create(input);
  const second = await store.create(input);
  const restarted = createDurableComplaintStore({ storage: storage.restart() });
  const third = await restarted.create(input);
  assert.equal(second.complaint.analysis.duplicateOf, first.complaint.id);
  assert.equal(third.complaint.analysis.duplicateOf, first.complaint.id);
  await restarted.update(first.complaint.id, { status: 'resolved', resolution: 'Яма отремонтирована.' });
  const fourth = await restarted.create(input);
  assert.equal(fourth.complaint.analysis.duplicateOf, second.complaint.id);
  assert.equal((await restarted.list()).stats.total, 4);
});

test('failed reads, writes and commits expose no false receipt or cached mutation and permit retry', async () => {
  for (const fault of ['failRead', 'failWrite', 'failCommit']) {
    const storage = new MemoryStorage();
    const store = createDurableComplaintStore({ storage });
    const existing = await store.create(input);
    const before = structuredClone(storage.data);
    storage[fault] = true;
    await assert.rejects(store.update(existing.complaint.id, { status: 'in_progress' }), fails(500, 'COMPLAINT_STORAGE_ERROR'));
    assert.deepEqual(storage.data, before);
    assert.deepEqual(await store.get(existing.complaint.id), existing.complaint);
    const telegram = { ...input, source: 'telegram', telegramChatId: '123', telegramUpdateId: 80 };
    storage[fault] = true;
    await assert.rejects(store.create(telegram), fails(500, 'COMPLAINT_STORAGE_ERROR'));
    assert.deepEqual(storage.data, before);
    const retried = await store.create(telegram);
    assert.equal(retried.duplicateUpdate, false);
    assert.equal((await createDurableComplaintStore({ storage: storage.restart() }).create(telegram)).trackingToken, retried.trackingToken);
    assert.equal((await store.list()).stats.total, 2);
  }
});

test('durable invalid input, optimistic conflicts and closure rules match the local domain', async () => {
  const storage = new MemoryStorage();
  const store = createDurableComplaintStore({ storage });
  await assert.rejects(store.create({ ...input, consent: false }), fails(400, 'INVALID_COMPLAINT'));
  assert.equal(storage.data.size, 0);
  const receipt = await store.create(input);
  const id = receipt.complaint.id;
  await assert.rejects(store.update(id, { status: 'resolved' }), fails(400, 'INVALID_COMPLAINT'));
  const results = await Promise.allSettled([
    store.update(id, { assignee: 'Первая служба', expectedUpdatedAt: receipt.complaint.updatedAt }),
    store.update(id, { assignee: 'Другая служба', expectedUpdatedAt: receipt.complaint.updatedAt }),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'COMPLAINT_CHANGED');
  const closed = await store.update(id, { status: 'resolved', resolution: 'Ремонт закончен.' });
  assert.equal(closed.history.length, 3);
  await assert.rejects(store.update(id, { status: 'new' }), fails(409, 'INVALID_STATUS_TRANSITION'));
  const reopened = await store.update(id, { status: 'in_progress' });
  assert.equal(reopened.resolution, '');
  assert.equal((await store.track(id, receipt.trackingToken)).status, 'in_progress');
});

test('corrupted envelopes, nested records and duplicate Telegram updates fail before any write', async () => {
  const mutations = [
    entries => { entries[0][1].version = 2; },
    entries => { entries[0][1].complaint.location = { lat: 200, lon: 70 }; },
    entries => { entries[1][1].position = entries[0][1].position; },
    entries => { entries[0][1].position = 50; },
    entries => { entries[1][1].complaint.telegramUpdateId = entries[0][1].complaint.telegramUpdateId; },
    entries => { entries[0][0] = `${prefix}wrong-id`; },
  ];
  for (const mutate of mutations) {
    const storage = new MemoryStorage();
    const store = createDurableComplaintStore({ storage });
    await store.create({ ...input, source: 'telegram', telegramChatId: '123', telegramUpdateId: 1 });
    await store.create({ ...input, source: 'telegram', telegramChatId: '123', telegramUpdateId: 2 });
    const entries = structuredClone([...storage.data]);
    mutate(entries);
    storage.data = new Map(entries);
    const before = structuredClone(storage.data);
    await assert.rejects(store.create(input), fails(500, 'COMPLAINT_STORAGE_CORRUPT'));
    await assert.rejects(store.list(), fails(500, 'COMPLAINT_STORAGE_CORRUPT'));
    assert.deepEqual(storage.data, before);
  }
});
