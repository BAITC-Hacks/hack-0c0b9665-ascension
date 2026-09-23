import test from 'node:test';
import assert from 'node:assert/strict';
import { createDurableComplaintStore, runWithComplaintStorageLock } from '../src/complaints/durable-store.js';
import { createComplaintMigrationService, createComplaintMigrationHandler, summarizeSnapshot,
  MIGRATION_PATH, MIGRATION_MAX_BYTES } from '../src/complaints/migration.js';
import { createComplaintFetchHandler } from '../src/complaints/worker-routes.js';
import { createWorker } from '../src/worker.js';

const ADMIN = 'synthetic-migration-admin';
const SECRET = 'synthetic_migration_secret_1234567890';
const BASE = 'https://city.example';
const INPUT = { text: 'Тест: яма на дороге у остановки.', consent: true, address: 'Тестовый адрес' };
const JPEG = Uint8Array.from([255, 216, 255, 217]);

class MemoryStorage {
  entries = new Map();
  writes = 0;
  failCommit = false;
  async list({ prefix }) { return structuredClone(new Map([...this.entries].filter(([key]) => key.startsWith(prefix)))); }
  async get(key) { return structuredClone(this.entries.get(key)); }
  async put(key, value) { this.entries.set(key, structuredClone(value)); this.writes++; }
  async delete(key) { this.entries.delete(key); }
  async transaction(operation) {
    const staged = new MemoryStorage();
    staged.entries = structuredClone(this.entries);
    const result = await operation(staged);
    if (this.failCommit) throw new Error('secret-storage-diagnostic');
    this.entries = staged.entries;
    this.writes += staged.writes;
    return result;
  }
}

function service(storage) {
  return createComplaintMigrationService({ storage, runExclusive: operation => runWithComplaintStorageLock(storage, operation) });
}

async function snapshot() {
  const store = createDurableComplaintStore({ storage: new MemoryStorage() });
  const first = await store.create({ ...INPUT, source: 'telegram', telegramChatId: '123456', telegramUpdateId: 17,
    telegramDraftId: '11111111-1111-4111-8111-111111111111',
    attachments: [{ type: 'photo', fileId: 'private-file-id', fileUniqueId: 'private-unique-id' }] });
  await store.update(first.complaint.id, { status: 'in_progress', assignee: 'Тестовая служба' });
  const second = await store.create({ ...INPUT, text: 'Тест: освещение возле остановки не работает.' });
  return { version: 1, complaints: [await store.get(first.complaint.id), await store.get(second.complaint.id)] };
}

test('plan is read-only; commit preserves full records, photos, receipts and draft/update dedup across restart', async () => {
  const source = await snapshot();
  const storage = new MemoryStorage();
  const unrelated = { privateSession: true };
  storage.entries.set('telegram:session:123456', unrelated);
  const migrate = service(storage);
  const plan = await migrate({ action: 'plan', snapshot: source });
  assert.equal(storage.writes, 0);
  assert.equal(plan.sourceCount, 2);
  assert.equal(plan.photoCount, 1);
  assert.equal(plan.insertCount, 2);
  const committed = await migrate({ action: 'commit', snapshot: source, planDigest: plan.planDigest });
  assert.equal(committed.targetCount, 2);
  assert.equal(storage.writes, 3);
  assert.equal(storage.entries.get(`complaints:migration:${plan.sourceDigest}`).sourceCount, 2);
  assert.deepEqual(storage.entries.get('telegram:session:123456'), unrelated);
  const restarted = createDurableComplaintStore({ storage });
  for (const record of source.complaints) {
    assert.deepEqual(await restarted.get(record.id), record);
    assert.equal((await restarted.track(record.id, record.trackingToken)).status, record.status);
  }
  const telegram = source.complaints[0];
  assert.equal((await restarted.create({ source: 'telegram', telegramUpdateId: 17 })).complaint.id, telegram.id);
  assert.equal((await restarted.create({ ...INPUT, source: 'telegram', telegramUpdateId: 18,
    telegramChatId: telegram.telegramChatId, telegramDraftId: telegram.telegramDraftId })).complaint.id, telegram.id);
  assert.equal((await service(storage)({ action: 'verify', snapshot: source })).verified, true);
});

test('lost commit response retry and reordered snapshot are idempotent without extra writes', async () => {
  const source = await snapshot();
  const storage = new MemoryStorage();
  const migrate = service(storage);
  const plan = await migrate({ action: 'plan', snapshot: source });
  await migrate({ action: 'commit', snapshot: source, planDigest: plan.planDigest });
  const reordered = { complaints: [...source.complaints].reverse().map(record => Object.fromEntries(Object.entries(record).reverse())), version: 1 };
  assert.deepEqual(summarizeSnapshot(reordered), summarizeSnapshot(source));
  const retry = await service(storage)({ action: 'commit', snapshot: reordered, planDigest: plan.planDigest });
  assert.equal(retry.insertCount, 0);
  assert.equal(retry.unchangedCount, 2);
  assert.equal(storage.writes, 3);
});

test('all conflicts reject before any write: changed ID, repeated Telegram update and draft identity', async () => {
  for (const change of [
    record => { record.text += ' изменено'; },
    record => { record.id = 'C-0000000000000000'; record.telegramDraftId = '22222222-2222-4222-8222-222222222222'; },
    record => { record.id = 'C-0000000000000000'; record.telegramUpdateId = 999; },
  ]) {
    const source = await snapshot();
    const storage = new MemoryStorage();
    storage.entries.set(`complaint:${source.complaints[0].id}`, structuredClone(source.complaints[0]));
    change(source.complaints[0]);
    const before = structuredClone(storage.entries);
    await assert.rejects(service(storage)({ action: 'commit', snapshot: source, planDigest: 'a'.repeat(64) }), { code: 'MIGRATION_CONFLICT' });
    assert.deepEqual(storage.entries, before);
    assert.equal(storage.writes, 0);
  }
});

test('changed target invalidates plan; existing unrelated records survive import', async () => {
  const source = await snapshot();
  const storage = new MemoryStorage();
  const migrate = service(storage);
  const plan = await migrate({ action: 'plan', snapshot: source });
  const extra = await createDurableComplaintStore({ storage }).create(INPUT);
  await assert.rejects(migrate({ action: 'commit', snapshot: source, planDigest: plan.planDigest }), { code: 'MIGRATION_PLAN_CHANGED' });
  const fresh = await migrate({ action: 'plan', snapshot: source });
  await migrate({ action: 'commit', snapshot: source, planDigest: fresh.planDigest });
  assert.deepEqual(await createDurableComplaintStore({ storage }).get(extra.complaint.id), extra.complaint);
});

test('storage failure rolls back the full import and exposes no original error', async () => {
  const source = await snapshot();
  const storage = new MemoryStorage();
  const migrate = service(storage);
  const plan = await migrate({ action: 'plan', snapshot: source });
  storage.failCommit = true;
  await assert.rejects(migrate({ action: 'commit', snapshot: source, planDigest: plan.planDigest }), error =>
    error.code === 'MIGRATION_STORAGE_ERROR' && !error.message.includes('secret-storage-diagnostic'));
  assert.equal(storage.entries.size, 0);
  storage.failCommit = false;
  assert.equal((await migrate({ action: 'commit', snapshot: source, planDigest: plan.planDigest })).insertCount, 2);
});

test('shared lock prevents a concurrent normal save from deleting imported records', async () => {
  const source = await snapshot();
  const storage = new MemoryStorage();
  const migrate = service(storage);
  const plan = await migrate({ action: 'plan', snapshot: source });
  const store = createDurableComplaintStore({ storage });
  const [imported, created] = await Promise.all([
    migrate({ action: 'commit', snapshot: source, planDigest: plan.planDigest }), store.create(INPUT),
  ]);
  assert.equal(imported.insertCount, 2);
  assert.equal((await store.list()).stats.total, 3);
  assert.equal((await store.get(created.complaint.id)).id, created.complaint.id);
  assert.equal((await migrate({ action: 'verify', snapshot: source })).verified, true);
});

test('invalid source, corrupt target, changed source and incomplete verify fail without writes', async () => {
  const source = await snapshot();
  const storage = new MemoryStorage();
  const migrate = service(storage);
  for (const invalid of [{ version: 2, complaints: [] }, { version: 1, complaints: [{}] },
    { ...source, unknown: true }, { version: 1, complaints: [source.complaints[0], source.complaints[0]] }]) {
    await assert.rejects(migrate({ action: 'plan', snapshot: invalid }), { code: 'MIGRATION_SNAPSHOT_INVALID' });
  }
  await assert.rejects(migrate({ action: 'verify', snapshot: source }), { code: 'MIGRATION_INCOMPLETE' });
  const plan = await migrate({ action: 'plan', snapshot: source });
  source.complaints[0].text += ' новый снимок';
  await assert.rejects(migrate({ action: 'commit', snapshot: source, planDigest: plan.planDigest }), { code: 'MIGRATION_PLAN_CHANGED' });
  storage.entries.set('complaint:wrong-key', source.complaints[0]);
  await assert.rejects(migrate({ action: 'plan', snapshot: source }), { code: 'MIGRATION_STORAGE_ERROR' });
  assert.equal(storage.writes, 0);
});

function request(body, { headers = {}, method = 'POST' } = {}) {
  return new Request(BASE + MIGRATION_PATH, { method, headers: { 'Content-Type': 'application/json',
    'X-Admin-Token': ADMIN, 'X-Complaints-Migration-Token': SECRET, ...headers },
  ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
}

test('maintenance route is default-off, requires two distinct secrets and authorizes before reading body', async () => {
  let called = false;
  const migrate = () => { called = true; return {}; };
  for (const options of [{}, { adminToken: ADMIN }, { migrationToken: SECRET }, { adminToken: SECRET, migrationToken: SECRET }]) {
    assert.equal((await createComplaintMigrationHandler({ migrate, ...options })(request('invalid-json'))).status, 404);
  }
  const handle = createComplaintMigrationHandler({ migrate, adminToken: ADMIN, migrationToken: SECRET });
  for (const headers of [{ 'X-Admin-Token': 'wrong' }, { 'X-Complaints-Migration-Token': 'wrong' }]) {
    const input = request('invalid-json', { headers });
    input.body.getReader = () => { throw new Error('unauthorized body must not be read'); };
    assert.equal((await handle(input)).status, 401);
    assert.equal(input.bodyUsed, false);
  }
  assert.equal((await handle(request({}, { headers: { Origin: BASE } }))).status, 403);
  assert.equal((await handle(request({}, { method: 'GET' }))).status, 405);
  assert.equal(await handle(new Request(BASE + '/api/complaints')), null);
  assert.equal(called, false);
});

test('route rejects oversized, malformed and compressed input without leaking request data', async () => {
  const handle = createComplaintMigrationHandler({ migrate: service(new MemoryStorage()), adminToken: ADMIN, migrationToken: SECRET });
  for (const [input, status] of [
    [request('private-invalid-json'), 400],
    [request({}, { headers: { 'Content-Length': String(MIGRATION_MAX_BYTES + 2048) } }), 413],
    [request('x'.repeat(MIGRATION_MAX_BYTES + 1025)), 413],
    [request({}, { headers: { 'Content-Encoding': 'gzip' } }), 415],
  ]) {
    const response = await handle(input);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.doesNotMatch(await response.text(), /private-invalid-json|synthetic_migration_secret/u);
  }
});

test('Worker forwarding imports privately, then exposes old receipts and protected photo bytes', async () => {
  const source = await snapshot();
  const storage = new MemoryStorage();
  const handleMigration = createComplaintMigrationHandler({ migrate: service(storage), adminToken: ADMIN, migrationToken: SECRET });
  const handle = createComplaintFetchHandler({ store: createDurableComplaintStore({ storage }), adminToken: ADMIN,
    transport: { sendMessage: () => { throw new Error('import must not send Telegram messages'); },
      getPhoto: async fileId => { assert.equal(fileId, 'private-file-id'); return { data: JPEG, contentType: 'image/jpeg' }; } } });
  const worker = createWorker();
  const env = { COMPLAINTS: { getByName: name => {
    assert.equal(name, 'city'); return { fetch: async input => (await handleMigration(input)) ?? handle(input) };
  } } };
  const call = input => worker.fetch(input, env);
  const plan = await (await call(request({ action: 'plan', snapshot: source }))).json();
  const response = await call(request({ action: 'commit', snapshot: source, planDigest: plan.planDigest }));
  assert.equal(response.status, 200);
  const output = await response.text();
  for (const record of source.complaints) {
    assert.ok(!output.includes(record.id));
    assert.ok(!output.includes(record.trackingToken));
    const tracked = await call(new Request(BASE + '/api/complaints/track', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: record.id, trackingToken: record.trackingToken }) }));
    assert.equal(tracked.status, 200);
    assert.equal((await tracked.json()).complaint.id, record.id);
  }
  const path = `${BASE}/api/complaints/${source.complaints[0].id}/photos/0`;
  assert.equal((await call(new Request(path))).status, 401);
  const photo = await call(new Request(path, { headers: { 'X-Admin-Token': ADMIN } }));
  assert.equal(photo.headers.get('Content-Type'), 'image/jpeg');
  assert.deepEqual(new Uint8Array(await photo.arrayBuffer()), JPEG);
});
