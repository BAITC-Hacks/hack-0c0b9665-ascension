import test from 'node:test';
import assert from 'node:assert/strict';
import { runMigrationCommand } from '../scripts/migrate-complaints.mjs';
import { createComplaintMigrationHandler, createComplaintMigrationService, summarizeSnapshot } from '../src/complaints/migration.js';
import { createComplaintStoreCore } from '../src/complaints/store-core.js';
import { createDurableComplaintStore } from '../src/complaints/durable-store.js';
import { createComplaintFetchHandler } from '../src/complaints/worker-routes.js';

const TARGET = 'https://ascension-city-map.azamatbreach.workers.dev';
const ENV = { ADMIN_TOKEN: 'synthetic-admin-secret', COMPLAINTS_MIGRATION_TOKEN: 'synthetic-import-secret-not-a-real-credential' };
const FILE = 'private-synthetic-snapshot.json';
const PLAN = 'a'.repeat(64);
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);

async function snapshotOf(count = 1, photo = false) {
  let records = [];
  const store = createComplaintStoreCore({ run: operation => operation(records), save: value => { records = value; } });
  for (let index = 0; index < count; index++) {
    await store.create({ consent: true, source: 'telegram', telegramChatId: String(123456 + index),
      telegramUpdateId: 1000 + index, text: `Синтетическая закрытая запись для проверки дороги ${index}.`,
      address: 'Синтетический адрес', attachments: photo && !index ? [{ type: 'photo', fileId: 'private-synthetic-file-id' }] : [] });
  }
  return { version: 1, complaints: records };
}

function resultFor(snapshot, action = 'plan', overrides = {}) {
  const summary = summarizeSnapshot(snapshot);
  return { ok: true, action, ...summary, targetCount: action === 'plan' ? 0 : summary.sourceCount,
    insertCount: action === 'verify' ? 0 : summary.sourceCount,
    unchangedCount: action === 'verify' ? summary.sourceCount : 0, planDigest: PLAN,
    ...(action === 'verify' ? { verified: true } : {}), ...overrides };
}

function harness(snapshot, options = {}) {
  const calls = [];
  const logs = [];
  const files = [];
  const sleeps = [];
  return {
    calls, logs, files, sleeps,
    run: changes => runMigrationCommand({ argv: ['plan', '--file', FILE], env: ENV,
      readFile: async path => { files.push(path); return JSON.stringify(snapshot); },
      fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json(resultFor(snapshot)); },
      log: value => logs.push(value), sleep: async milliseconds => { sleeps.push(milliseconds); },
      ...options, ...changes }),
  };
}

function privateValues(snapshot) {
  return [FILE, ...Object.values(ENV), ...snapshot.complaints.flatMap(record =>
    [record.id, record.trackingToken, record.telegramChatId, record.text, record.address,
      ...record.attachments.map(item => item.fileId)])];
}

test('plan sends validated snapshot only to the fixed endpoint and prints a whitelisted summary', async () => {
  const snapshot = await snapshotOf();
  const run = harness(snapshot);
  const result = await run.run({ fetchImpl: async (url, init) => {
    run.calls.push({ url, init });
    return Response.json({ ...resultFor(snapshot), privateUnexpected: snapshot.complaints });
  } });
  assert.equal(run.calls.length, 1);
  const { url, init } = run.calls[0];
  assert.equal(url, `${TARGET}/api/complaints/_migration`);
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(init.headers, { 'Content-Type': 'application/json', 'X-Admin-Token': ENV.ADMIN_TOKEN,
    'X-Complaints-Migration-Token': ENV.COMPLAINTS_MIGRATION_TOKEN });
  assert.deepEqual(JSON.parse(init.body), { action: 'plan', snapshot });
  assert.equal(result.sourceCount, 1);
  assert.equal(result.planDigest, PLAN);
  assert.equal(result.privateUnexpected, undefined);
  for (const value of privateValues(snapshot)) assert.ok(!run.logs.join('\n').includes(value));
});

test('commit requires a valid plan and explicit stopped-writers attestation before reading or sending', async () => {
  const snapshot = await snapshotOf();
  for (const argv of [
    ['commit', '--file', FILE],
    ['commit', '--file', FILE, '--plan-digest', PLAN],
    ['commit', '--file', FILE, '--writers-stopped'],
    ['commit', '--file', FILE, '--writers-stopped', '--plan-digest', 'bad-digest'],
  ]) {
    const run = harness(snapshot);
    await assert.rejects(run.run({ argv }), { code: 'MIGRATION_ARGUMENTS' });
    assert.deepEqual(run.calls, []);
    assert.deepEqual(run.files, []);
  }
  const run = harness(snapshot);
  const result = await run.run({ argv: ['commit', '--file', FILE, '--plan-digest', PLAN, '--writers-stopped'],
    fetchImpl: async (url, init) => { run.calls.push({ url, init }); return Response.json(resultFor(snapshot, 'commit')); } });
  assert.equal(result.action, 'commit');
  assert.deepEqual(JSON.parse(run.calls[0].init.body), { action: 'commit', snapshot, planDigest: PLAN });
  assert.equal(run.calls.length, 1);
  assert.match(run.logs.at(-1), /verify/u);
});

test('unknown, repeated, and misplaced options are rejected without network work', async () => {
  const snapshot = await snapshotOf();
  for (const argv of [
    [], ['status', '--file', FILE], ['plan'], ['plan', '--file'],
    ['plan', '--file', FILE, '--file', FILE], ['plan', '--file', FILE, '--token', ENV.ADMIN_TOKEN],
    ['plan', '--file', FILE, '--writers-stopped'], ['verify', '--file', FILE, '--plan-digest', PLAN],
  ]) {
    const run = harness(snapshot);
    await assert.rejects(run.run({ argv }), { code: 'MIGRATION_ARGUMENTS' });
    assert.equal(run.calls.length, 0);
    assert.equal(run.files.length, 0);
  }
});

test('explicit COMPLAINTS_FILE is supported but no default real-data path is assumed', async () => {
  const snapshot = await snapshotOf();
  const run = harness(snapshot);
  await run.run({ argv: ['plan'], env: { ...ENV, COMPLAINTS_FILE: FILE } });
  assert.deepEqual(run.files, [FILE]);
  const missing = harness(snapshot);
  await assert.rejects(missing.run({ argv: ['plan'] }), { code: 'MIGRATION_ARGUMENTS' });
  assert.equal(missing.files.length, 0);
});

test('wrong destination and malformed credentials fail before private file reads', async () => {
  const snapshot = await snapshotOf();
  for (const env of [
    { ...ENV, TELEGRAM_HOSTED_URL: 'https://example.invalid' },
    { ...ENV, TELEGRAM_HOSTED_URL: `${TARGET}/other` },
    { ...ENV, TELEGRAM_HOSTED_URL: `${TARGET}/?secret=private` },
    { ...ENV, TELEGRAM_HOSTED_URL: `https://user:password@${new URL(TARGET).host}` },
    { ...ENV, TELEGRAM_HOSTED_URL: TARGET.replace('https:', 'http:') },
    { ...ENV, ADMIN_TOKEN: '' }, { ...ENV, COMPLAINTS_MIGRATION_TOKEN: 'bad\nheader' },
    { ...ENV, COMPLAINTS_MIGRATION_TOKEN: 'too-short' },
    { ...ENV, COMPLAINTS_MIGRATION_TOKEN: 'x'.repeat(257) },
    { ...ENV, COMPLAINTS_MIGRATION_TOKEN: `${'x'.repeat(32)}!` },
    { ADMIN_TOKEN: ENV.COMPLAINTS_MIGRATION_TOKEN, COMPLAINTS_MIGRATION_TOKEN: ENV.COMPLAINTS_MIGRATION_TOKEN },
  ]) {
    const run = harness(snapshot);
    await assert.rejects(run.run({ env }), error => ['MIGRATION_TARGET', 'MIGRATION_CREDENTIALS'].includes(error.code));
    assert.equal(run.files.length, 0);
    assert.equal(run.calls.length, 0);
  }
  await harness(snapshot).run({ env: { ...ENV, TELEGRAM_HOSTED_URL: `${TARGET}/` } });
});

test('bad, unsupported, oversized, or unreadable snapshots never reach the network', async () => {
  const snapshot = await snapshotOf();
  for (const [readFile, code] of [
    [async () => '{private malformed data', 'MIGRATION_SNAPSHOT_INVALID'],
    [async () => JSON.stringify({ ...snapshot, version: 2 }), 'MIGRATION_SNAPSHOT_INVALID'],
    [async () => JSON.stringify({ version: 1, complaints: [{ privateValue: 'do not print' }] }), 'MIGRATION_SNAPSHOT_INVALID'],
    [async () => Buffer.from([0xc3, 0x28]), 'MIGRATION_SNAPSHOT_INVALID'],
    [async () => Buffer.alloc(5 * 1024 * 1024 + 1), 'MIGRATION_TOO_LARGE'],
    [async () => { throw new Error(`${FILE} ${ENV.ADMIN_TOKEN}`); }, 'MIGRATION_FILE'],
  ]) {
    const run = harness(snapshot);
    await assert.rejects(run.run({ readFile }), error => {
      assert.equal(error.code, code);
      assert.ok(!error.message.includes(FILE));
      assert.ok(!error.message.includes(ENV.ADMIN_TOKEN));
      return true;
    });
    assert.equal(run.calls.length, 0);
    assert.equal(run.logs.length, 0);
  }
});

test('redirects and token-bearing transport failures produce only static diagnostics', async () => {
  const snapshot = await snapshotOf();
  for (const fetchImpl of [
    async (_url, init) => { assert.equal(init.redirect, 'error'); return new Response(null, { status: 302, headers: { Location: 'https://example.invalid' } }); },
    async () => { throw new Error(`upstream request ${ENV.ADMIN_TOKEN} ${snapshot.complaints[0].trackingToken}`); },
  ]) {
    const run = harness(snapshot);
    await assert.rejects(run.run({ fetchImpl }), error => {
      assert.equal(error.code, 'MIGRATION_NETWORK');
      for (const value of privateValues(snapshot)) assert.ok(!error.message.includes(value));
      return true;
    });
    assert.equal(run.logs.length, 0);
  }
});

test('upstream errors, oversized streams, and unexpected summaries never leak response bodies', async () => {
  const snapshot = await snapshotOf();
  const privateBody = JSON.stringify(snapshot);
  for (const [response, code] of [
    [new Response(privateBody, { status: 401 }), 'MIGRATION_AUTH'],
    [new Response(privateBody, { status: 404 }), 'MIGRATION_UNAVAILABLE'],
    [new Response(privateBody, { status: 409 }), 'MIGRATION_CONFLICT'],
    [new Response(privateBody, { status: 413 }), 'MIGRATION_TOO_LARGE'],
    [new Response(privateBody, { status: 500 }), 'MIGRATION_RESPONSE'],
    [new Response('<html>private</html>', { headers: { 'Content-Type': 'text/html' } }), 'MIGRATION_RESPONSE'],
    [new Response('x'.repeat(16385), { headers: { 'Content-Type': 'application/json' } }), 'MIGRATION_RESPONSE'],
    [new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '16385' } }), 'MIGRATION_RESPONSE'],
    [Response.json(resultFor(snapshot, 'plan', { sourceDigest: 'b'.repeat(64) })), 'MIGRATION_RESPONSE'],
    [Response.json(resultFor(snapshot, 'commit')), 'MIGRATION_RESPONSE'],
    [Response.json(resultFor(snapshot, 'plan', { insertCount: 0 })), 'MIGRATION_RESPONSE'],
    [Response.json(resultFor(snapshot, 'plan', { planDigest: privateBody })), 'MIGRATION_RESPONSE'],
  ]) {
    const run = harness(snapshot);
    await assert.rejects(run.run({ fetchImpl: async () => response }), error => {
      assert.equal(error.code, code);
      for (const value of privateValues(snapshot)) assert.ok(!error.message.includes(value));
      return true;
    });
    assert.equal(run.logs.length, 0);
  }
});

test('verify checks every old receipt and authenticated photo without leaking migration credentials', async () => {
  const snapshot = await snapshotOf(2, true);
  const run = harness(snapshot);
  const result = await run.run({ argv: ['verify', '--file', FILE], fetchImpl: async (url, init) => {
    run.calls.push({ url, init });
    assert.equal(init.redirect, 'error');
    if (url.endsWith('/_migration')) return Response.json(resultFor(snapshot, 'verify'));
    if (url.endsWith('/track')) {
      assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
      const body = JSON.parse(init.body);
      const record = snapshot.complaints.find(item => item.id === body.id);
      assert.equal(body.trackingToken, record.trackingToken);
      return Response.json({ complaint: { id: record.id, status: record.status } });
    }
    assert.equal(url, `${TARGET}/api/complaints/${snapshot.complaints[0].id}/photos/0`);
    assert.deepEqual(init.headers, { 'X-Admin-Token': ENV.ADMIN_TOKEN });
    assert.equal(init.method, 'GET');
    return new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
  } });
  assert.equal(result.receiptsVerified, 2);
  assert.equal(result.photosVerified, 1);
  assert.equal(run.calls.length, 4);
  assert.deepEqual(run.sleeps, [2100]);
  for (const value of privateValues(snapshot)) assert.ok(!run.logs.join('\n').includes(value));
  assert.match(run.logs.at(-1), /проверяются отдельно/u);
});

test('verify does not skip receipts above twenty and paces tracking under the rate limit', async () => {
  const snapshot = await snapshotOf(22);
  const run = harness(snapshot);
  let receiptCount = 0;
  const result = await run.run({ argv: ['verify', '--file', FILE], fetchImpl: async (url, init) => {
    if (url.endsWith('/_migration')) return Response.json(resultFor(snapshot, 'verify'));
    assert.equal(url, `${TARGET}/api/complaints/track`);
    const { id, trackingToken } = JSON.parse(init.body);
    const record = snapshot.complaints.find(item => item.id === id && item.trackingToken === trackingToken);
    assert.ok(record);
    receiptCount++;
    return Response.json({ complaint: { id, status: record.status } });
  } });
  assert.equal(receiptCount, 22);
  assert.equal(result.receiptsVerified, 22);
  assert.deepEqual(run.sleeps, Array(21).fill(2100));
});

test('verify fails closed on missing, mismatched, rate-limited, or redirected old receipts', async () => {
  const snapshot = await snapshotOf();
  for (const receiptResponse of [
    new Response(null, { status: 404 }), new Response(null, { status: 429 }),
    new Response(null, { status: 302, headers: { Location: 'https://example.invalid' } }),
    Response.json({ complaint: { id: 'C-0000000000000000', status: 'new' } }),
    Response.json({ complaint: { id: snapshot.complaints[0].id, status: 'resolved' } }),
  ]) {
    const run = harness(snapshot);
    await assert.rejects(run.run({ argv: ['verify', '--file', FILE], fetchImpl: async url =>
      url.endsWith('/_migration') ? Response.json(resultFor(snapshot, 'verify')) : receiptResponse }), { code: 'MIGRATION_RECEIPT' });
    assert.equal(run.logs.length, 0);
  }
});

test('verify rejects unconfirmed migration and missing, oversized, or non-image photo bytes', async () => {
  const snapshot = await snapshotOf(1, true);
  const unconfirmed = harness(snapshot);
  await assert.rejects(unconfirmed.run({ argv: ['verify', '--file', FILE], fetchImpl: async () =>
    Response.json(resultFor(snapshot, 'verify', { verified: false })) }), { code: 'MIGRATION_RESPONSE' });
  for (const photoResponse of [
    new Response(null, { status: 401 }),
    new Response(null, { status: 302, headers: { Location: 'https://example.invalid' } }),
    new Response('<html>private</html>', { headers: { 'Content-Type': 'image/png' } }),
    new Response(PNG, { headers: { 'Content-Type': 'image/jpeg' } }),
    new Response(PNG, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(10 * 1024 * 1024 + 1) } }),
  ]) {
    const run = harness(snapshot);
    await assert.rejects(run.run({ argv: ['verify', '--file', FILE], fetchImpl: async url => {
      if (url.endsWith('/_migration')) return Response.json(resultFor(snapshot, 'verify'));
      if (url.endsWith('/track')) return Response.json({ complaint: { id: snapshot.complaints[0].id, status: 'new' } });
      return photoResponse;
    } }), { code: 'MIGRATION_PHOTO' });
    assert.equal(run.logs.length, 0);
  }
});

test('CLI plan, commit, identical retry and receipt verification work against the actual private handlers', async () => {
  const snapshot = await snapshotOf(2);
  let entries = new Map();
  const storage = {
    list: async ({ prefix }) => structuredClone(new Map([...entries].filter(([key]) => key.startsWith(prefix)))),
    transaction: async operation => {
      const pending = structuredClone(entries);
      const result = await operation({
        list: async ({ prefix }) => structuredClone(new Map([...pending].filter(([key]) => key.startsWith(prefix)))),
        get: async key => structuredClone(pending.get(key)),
        put: async (key, value) => { pending.set(key, structuredClone(value)); },
      });
      entries = pending;
      return result;
    },
  };
  const migrate = createComplaintMigrationService({ storage, runExclusive: operation => operation() });
  const handleMigration = createComplaintMigrationHandler({ migrate, adminToken: ENV.ADMIN_TOKEN,
    migrationToken: ENV.COMPLAINTS_MIGRATION_TOKEN });
  let telegramSends = 0;
  const handleComplaints = createComplaintFetchHandler({ store: createDurableComplaintStore({ storage }),
    adminToken: ENV.ADMIN_TOKEN, transport: { sendMessage: async () => { telegramSends++; } } });
  const run = harness(snapshot, { fetchImpl: async (url, init) => {
    const request = new Request(url, init);
    return await handleMigration(request) ?? handleComplaints(request);
  } });
  const plan = await run.run();
  assert.equal(plan.insertCount, 2);
  assert.equal(entries.size, 0);
  const argv = ['commit', '--file', FILE, '--plan-digest', plan.planDigest, '--writers-stopped'];
  const committed = await run.run({ argv });
  assert.equal(committed.targetCount, 2);
  assert.equal([...entries.keys()].filter(key => key.startsWith('complaint:')).length, 2);
  assert.equal([...entries.keys()].filter(key => key.startsWith('complaints:migration:')).length, 1);
  const retry = await run.run({ argv });
  assert.equal(retry.insertCount, 0);
  assert.equal(retry.unchangedCount, 2);
  const verified = await run.run({ argv: ['verify', '--file', FILE] });
  assert.equal(verified.verified, true);
  assert.equal(verified.receiptsVerified, 2);
  assert.equal(telegramSends, 0);
  for (const record of snapshot.complaints) assert.deepEqual(entries.get(`complaint:${record.id}`), record);
});
