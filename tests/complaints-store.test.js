import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createComplaintStore, toAdminComplaint, toPublicComplaint } from '../src/complaints/store.js';
import { classifyComplaint } from '../src/complaints/classify.js';

const input = { text: 'Большая яма на дороге возле дома', address: 'Тестовая улица, 10', districtId: 'nura', consent: true };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'citizen-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'complaints.json');
  return { directory, filePath, store: createComplaintStore({ filePath }) };
}
function fails(status, code) {
  return error => error.status === status && (!code || error.code === code);
}

test('complaints persist across store restart with unpredictable per-record receipts', async t => {
  const { store, filePath, directory } = await fixture(t);
  const first = await store.create(input);
  const second = await store.create({ ...input, text: 'Не горит фонарь около остановки' });
  assert.match(first.complaint.id, /^C-[A-F0-9]{16}$/u);
  assert.match(first.trackingToken, /^[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(first.trackingToken, second.trackingToken);
  assert.notEqual(first.complaint.id, second.complaint.id);
  assert.equal(first.duplicateUpdate, false);
  const restarted = createComplaintStore({ filePath });
  assert.deepEqual(await restarted.get(first.complaint.id), first.complaint);
  assert.equal((await restarted.track(first.complaint.id, first.trackingToken)).status, 'new');
  assert.equal((await restarted.list()).stats.total, 2);
  assert.deepEqual(await readdir(directory), ['complaints.json']);
  first.complaint.text = 'Caller mutation';
  assert.equal((await restarted.get(first.complaint.id)).text, input.text);
});

test('admin and public projections hide tokens, Telegram identifiers and resident details', async t => {
  const { store } = await fixture(t);
  const receipt = await store.create({ ...input, text: 'Житель TestPrivateName сообщает о яме на дороге',
    source: 'telegram', telegramChatId: '-123456789', telegramUpdateId: 52,
    location: { lat: 51.12822, lon: 71.43071 },
    attachments: [{ type: 'photo', fileId: 'private-photo-file', fileUniqueId: 'private-unique-file' }] });
  const admin = toAdminComplaint(receipt.complaint);
  assert.deepEqual(admin.attachments, [{ type: 'photo', index: 0 }]);
  for (const secret of [receipt.trackingToken, '-123456789', 'private-photo-file', 'private-unique-file']) {
    assert.equal(JSON.stringify(admin).includes(secret), false);
  }
  const publicRecord = await store.track(receipt.complaint.id, receipt.trackingToken);
  assert.deepEqual(publicRecord, toPublicComplaint(receipt.complaint));
  for (const secret of [receipt.trackingToken, '-123456789', 'private-photo-file', 'TestPrivateName', input.address, '51.12822', '71.43071']) {
    assert.equal(JSON.stringify(publicRecord).includes(secret), false);
  }
  for (const key of ['text', 'address', 'location', 'attachments', 'trackingToken', 'telegramChatId', 'telegramUpdateId']) {
    assert.equal(key in publicRecord, false);
  }
  admin.analysis.summary = 'external mutation';
  assert.notEqual((await store.get(receipt.complaint.id)).analysis.summary, 'external mutation');
});

test('tracking rejects missing, wrong, malformed, and another complaint token with one 404 shape', async t => {
  const { store } = await fixture(t);
  const a = await store.create(input);
  const b = await store.create(input);
  for (const token of ['', null, undefined, {}, 'x'.repeat(43), b.trackingToken]) {
    await assert.rejects(store.track(a.complaint.id, token), fails(404, 'COMPLAINT_NOT_FOUND'));
  }
  await assert.rejects(store.track('unknown', a.trackingToken), fails(404, 'COMPLAINT_NOT_FOUND'));
  assert.equal(await store.get('unknown'), null);
});

test('concurrent writers including separate store instances preserve every record', async t => {
  const { store, filePath } = await fixture(t);
  const other = createComplaintStore({ filePath });
  const receipts = await Promise.all(Array.from({ length: 24 }, (_, index) => (index % 2 ? store : other)
    .create({ ...input, text: `Большая яма на тестовой дороге номер ${index}` })));
  assert.equal(new Set(receipts.map(value => value.complaint.id)).size, 24);
  assert.equal((await store.list()).stats.total, 24);
  const id = receipts[0].complaint.id;
  await Promise.all([store.update(id, { status: 'in_progress' }), other.update(id, { assignee: 'Тестовый оператор' })]);
  const record = await createComplaintStore({ filePath }).get(id);
  assert.equal(record.status, 'in_progress');
  assert.equal(record.assignee, 'Тестовый оператор');
  assert.equal(record.history.length, 3);
});

test('Telegram update replay is durable and concurrent replay returns one original receipt', async t => {
  const { store, filePath } = await fixture(t);
  const telegram = { ...input, source: 'telegram', telegramChatId: 123456789, telegramUpdateId: 91 };
  const receipts = await Promise.all([store.create(telegram), store.create(telegram), store.create(telegram)]);
  assert.equal(receipts.filter(receipt => !receipt.duplicateUpdate).length, 1);
  assert.equal(new Set(receipts.map(receipt => receipt.trackingToken)).size, 1);
  assert.equal(new Set(receipts.map(receipt => receipt.complaint.id)).size, 1);
  assert.equal(receipts[0].complaint.telegramChatId, '123456789');
  const replay = await createComplaintStore({ filePath }).create({ source: 'telegram', telegramUpdateId: 91, text: '' });
  assert.equal(replay.duplicateUpdate, true);
  assert.deepEqual(replay.complaint, receipts[0].complaint);
  assert.equal((await store.list()).stats.total, 1);
  await assert.rejects(store.create({ ...telegram, telegramUpdateId: 92, text: '' }), fails(400));
});

test('status workflow records assignment and public resolution, requires closure reason and supports reopening', async t => {
  const { store, filePath } = await fixture(t);
  const receipt = await store.create(input);
  const id = receipt.complaint.id;
  await assert.rejects(store.update(id, { status: 'resolved' }), fails(400));
  assert.equal((await store.get(id)).history.length, 1);
  await store.update(id, { status: 'in_progress', assignee: 'Дорожная служба' });
  const closed = await store.update(id, { status: 'resolved', resolution: 'Яма отремонтирована, покрытие восстановлено.' });
  assert.equal(closed.history.length, 3);
  assert.equal(closed.history[1].changes.assignee.after, 'Дорожная служба');
  const publicRecord = await store.track(id, receipt.trackingToken);
  assert.equal(publicRecord.resolution, 'Яма отремонтирована, покрытие восстановлено.');
  assert.equal(publicRecord.history.length, 3);
  assert.equal('changes' in publicRecord.history[1], false);
  await assert.rejects(store.update(id, { status: 'new' }), fails(409, 'INVALID_STATUS_TRANSITION'));
  const reopened = await store.update(id, { status: 'in_progress' });
  assert.equal(reopened.resolution, '');
  assert.equal(reopened.history.at(-1).changes.resolution.before, closed.resolution);
  const rejected = await store.update(id, { status: 'rejected', resolution: 'Адрес относится к другой территории.' });
  assert.equal(rejected.status, 'rejected');
  assert.deepEqual(await createComplaintStore({ filePath }).get(id), rejected);
});

test('operator corrections are auditable without merging or leaking private summary into tracking', async t => {
  const { store } = await fixture(t);
  const first = await store.create(input);
  const second = await store.create({ ...input, address: 'Другая улица, 20' });
  const record = await store.update(second.complaint.id, { category: 'safety', priority: 'high',
    summary: 'PrivateResidentName сообщил подробности', reason: 'Проверил PrivateOperatorNote', duplicateOf: first.complaint.id });
  assert.equal(record.analysis.reviewed, true);
  assert.equal(record.analysis.mode, 'rules');
  assert.equal(record.history.at(-1).changes.category.before, 'roads');
  assert.equal(record.analysis.duplicateOf, first.complaint.id);
  const tracked = await store.track(second.complaint.id, second.trackingToken);
  assert.equal(tracked.analysis.category, 'safety');
  assert.equal(tracked.analysis.priority, 'high');
  assert.doesNotMatch(JSON.stringify(tracked), /PrivateResidentName|PrivateOperatorNote/u);
  assert.equal((await store.list()).stats.total, 2);
  await store.update(second.complaint.id, { duplicateOf: null });
  assert.equal((await store.get(second.complaint.id)).analysis.duplicateOf, null);
  await assert.rejects(store.update(second.complaint.id, { duplicateOf: second.complaint.id }), fails(400));
  await assert.rejects(store.update(second.complaint.id, { duplicateOf: 'missing' }), fails(400));
});

test('rules distinguish urgency and disclose local rules rather than AI', () => {
  const high = classifyComplaint({ text: 'На улице открытый люк, рядом школа' });
  const low = classifyComplaint({ text: 'Предлагаю поставить скамейки во дворе' });
  const normal = classifyComplaint({ text: 'Переполнен мусорный контейнер' });
  assert.equal(high.priority, 'high');
  assert.equal(low.priority, 'low');
  assert.equal(normal.priority, 'normal');
  assert.equal(normal.category, 'waste');
  assert.equal(classifyComplaint({ text: 'На улице не горит фонарь' }).category, 'lighting');
  assert.equal(classifyComplaint({ text: 'В доме снова нет воды' }).category, 'utilities');
  for (const analysis of [high, low, normal]) {
    assert.equal(analysis.mode, 'rules');
    assert.match(analysis.reason, /Локальные правила/u);
    assert.equal(analysis.reviewed, false);
  }
});

test('duplicate suggestions require similar text and place, preserve records and ignore closed cases', async t => {
  const { store } = await fixture(t);
  const first = await store.create(input);
  const exact = await store.create(input);
  assert.equal(exact.complaint.analysis.duplicateOf, first.complaint.id);
  const elsewhere = await store.create({ ...input, address: 'Иная улица, 55' });
  assert.equal(elsewhere.complaint.analysis.duplicateOf, null);
  const different = await store.create({ ...input, text: 'Мусорный контейнер заполнен и не вывозится' });
  assert.equal(different.complaint.analysis.duplicateOf, null);
  const vague = await store.create({ ...input, address: '' });
  assert.equal(vague.complaint.analysis.duplicateOf, null);
  const point = await store.create({ ...input, address: '', location: { lat: 51.12, lon: 71.43 } });
  const nearby = await store.create({ ...input, address: '', location: { lat: 51.1201, lon: 71.4301 } });
  assert.equal(nearby.complaint.analysis.duplicateOf, point.complaint.id);
  assert.equal((await store.list()).stats.total, 7);
  const closed = { ...first.complaint, status: 'resolved' };
  assert.equal(classifyComplaint(input, [closed]).duplicateOf, null);
});

test('filters combine and stats include all records with administrative safe projections', async t => {
  const { store } = await fixture(t);
  const first = await store.create(input);
  await store.create({ ...input, text: 'На улице запах газа, необходима проверка', districtId: 'esil' });
  await store.update(first.complaint.id, { status: 'in_progress', assignee: 'Тестовая служба' });
  const result = await store.list({ status: 'in_progress', districtId: 'nura', category: 'roads', priority: 'normal', q: 'СЛУЖБА' });
  assert.deepEqual(result.complaints.map(record => record.id), [first.complaint.id]);
  assert.deepEqual(result.stats, { total: 2, new: 1, in_progress: 1, resolved: 0, rejected: 0, high: 1, normal: 1, low: 0 });
  assert.equal('trackingToken' in result.complaints[0], false);
  assert.equal((await store.list({ q: 'not-found' })).complaints.length, 0);
  await assert.rejects(store.list({ status: 'anything' }), fails(400));
});

test('invalid input and unauthorized data fields do not create or modify records', async t => {
  const { store } = await fixture(t);
  const bad = [null, [], {}, { ...input, consent: false }, { ...input, consent: 'true' },
    { ...input, text: 'short' }, { ...input, text: 'x'.repeat(5001) }, { ...input, address: 'x'.repeat(301) },
    { ...input, districtId: 'fake' }, { ...input, location: { lat: 91, lon: 70 } },
    { ...input, location: { lat: '51', lon: 70 } }, { ...input, location: { lat: 51, lon: 70, extra: 1 } },
    { ...input, trackingToken: 'chosen-by-client' }, { ...input, telegramChatId: '123' },
    { ...input, source: 'telegram', telegramChatId: 'name', telegramUpdateId: 1 },
    { ...input, source: 'telegram', telegramChatId: '123', telegramUpdateId: -1 },
    { ...input, source: 'telegram', telegramChatId: '123', telegramUpdateId: 1, attachments: [{ type: 'video', fileId: 'test' }] }];
  for (const value of bad) await assert.rejects(store.create(value), fails(400));
  assert.equal((await store.list()).stats.total, 0);
  const receipt = await store.create(input);
  for (const patch of [{}, { status: 'bad' }, { assignee: 'x'.repeat(121) }, { resolution: 'x'.repeat(2001) },
    { priority: 'urgent' }, { category: 'fake' }, { summary: '' }, { reason: 'x'.repeat(1001) }, { trackingToken: 'stolen' }]) {
    await assert.rejects(store.update(receipt.complaint.id, patch), fails(400));
  }
  assert.deepEqual(await store.get(receipt.complaint.id), receipt.complaint);
  await assert.rejects(store.update('absent', { status: 'in_progress' }), fails(404));
});

test('malformed persisted JSON fails explicitly and is never overwritten', async t => {
  const { store, filePath } = await fixture(t);
  const original = '{"version":1,"complaints": [';
  await writeFile(filePath, original, 'utf8');
  await assert.rejects(store.create(input), fails(500, 'COMPLAINT_STORAGE_CORRUPT'));
  await assert.rejects(store.list(), fails(500, 'COMPLAINT_STORAGE_CORRUPT'));
  assert.equal(await readFile(filePath, 'utf8'), original);
  await writeFile(filePath, JSON.stringify({ version: 1, complaints: [{ id: 'invalid' }] }), 'utf8');
  await assert.rejects(store.create(input), fails(500, 'COMPLAINT_STORAGE_CORRUPT'));
});

test('duplicate persistence keys are rejected instead of silently dropping data', async t => {
  const { store, filePath } = await fixture(t);
  const receipt = await store.create(input);
  const original = JSON.stringify({ version: 1, complaints: [receipt.complaint, receipt.complaint] });
  await writeFile(filePath, original, 'utf8');
  await assert.rejects(store.update(receipt.complaint.id, { status: 'in_progress' }), fails(500, 'COMPLAINT_STORAGE_CORRUPT'));
  assert.equal(await readFile(filePath, 'utf8'), original);
});

test('corrupted nested coordinates, attachments and state history fail clearly before mutation', async t => {
  const { store, filePath } = await fixture(t);
  const receipt = await store.create({ ...input, source: 'telegram', telegramChatId: '123', telegramUpdateId: 4 });
  for (const change of [
    record => { record.location = { lat: 200, lon: 70 }; },
    record => { record.attachments = [{ type: 'photo', fileId: null }]; },
    record => { record.status = 'in_progress'; },
  ]) {
    const record = structuredClone(receipt.complaint);
    change(record);
    const original = JSON.stringify({ version: 1, complaints: [record] });
    await writeFile(filePath, original, 'utf8');
    await assert.rejects(store.create(input), fails(500, 'COMPLAINT_STORAGE_CORRUPT'));
    assert.equal(await readFile(filePath, 'utf8'), original);
  }
});
