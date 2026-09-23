import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkComplaintBackup, MAX_BACKUP_BYTES, runBackupCheck } from '../scripts/check-complaint-backup.js';
import { createComplaintStore } from '../src/complaints/store.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'complaint-backup-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'private-backup.json');
  return { directory, filePath };
}

test('canonical backup produces aggregate counts and exact byte checksum without changing the source', async t => {
  const { filePath } = await fixture(t);
  const store = createComplaintStore({ filePath });
  const input = { text: 'Синтетическая приватная жалоба о яме', consent: true };
  const web = await store.create(input);
  const telegram = await store.create({ ...input, source: 'telegram', telegramChatId: '123456', telegramUpdateId: 42 });
  const before = await readFile(filePath);
  const metadata = await stat(filePath);
  const result = await checkComplaintBackup(filePath);
  assert.deepEqual(result, { schema: 'complaints/version-1', count: 2, bySource: { web: 1, telegram: 1 }, sha256: createHash('sha256').update(before).digest('hex') });
  for (const secret of [input.text, web.complaint.id, telegram.complaint.id, web.trackingToken, '123456', filePath]) {
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.deepEqual(await readFile(filePath), before);
  assert.equal((await stat(filePath)).mtimeMs, metadata.mtimeMs);
});

test('empty valid backup is accepted and malformed or wrong-schema backups are rejected', async t => {
  const { filePath } = await fixture(t);
  await writeFile(filePath, JSON.stringify({ version: 1, complaints: [] }));
  assert.equal((await checkComplaintBackup(filePath)).count, 0);
  for (const content of ['{secret malformed', '{}', '[]', '{"version":2,"complaints":[]}', '{"version":1,"complaints":[{"text":"private"}]}', Buffer.from([0xff])]) {
    await writeFile(filePath, content);
    await assert.rejects(checkComplaintBackup(filePath), error => error.exitCode === 4 && !error.message.includes('private'));
  }
});

test('canonical record validator rejects duplicate persisted complaint IDs', async t => {
  const { filePath } = await fixture(t);
  const store = createComplaintStore({ filePath });
  await store.create({ text: 'Тестовая яма на дороге у дома', consent: true });
  const state = JSON.parse(await readFile(filePath, 'utf8'));
  state.complaints.push(structuredClone(state.complaints[0]));
  await writeFile(filePath, JSON.stringify(state));
  await assert.rejects(checkComplaintBackup(filePath), error => error.exitCode === 4);
});

test('size limit and missing/non-file errors produce fixed codes without paths', async t => {
  const { filePath, directory } = await fixture(t);
  await writeFile(filePath, Buffer.alloc(MAX_BACKUP_BYTES + 1, 32));
  await assert.rejects(checkComplaintBackup(filePath), error => error.exitCode === 4);
  for (const [path, code] of [[join(directory, 'missing-private.json'), 3], [directory, 5]]) {
    await assert.rejects(checkComplaintBackup(path), error => error.exitCode === code && !error.message.includes(directory));
  }
});

test('CLI requires an explicit single path, prints no raw failures and exposes the exit code', async t => {
  const { filePath } = await fixture(t);
  const output = [];
  const errors = [];
  for (const args of [[], [filePath, 'extra-private-value']]) {
    assert.equal(await runBackupCheck({ args, log: value => output.push(value), error: value => errors.push(value) }), 2);
  }
  assert.equal(await runBackupCheck({ args: [filePath], log: value => output.push(value), error: value => errors.push(value) }), 3);
  assert.deepEqual(output, []);
  assert.equal(errors.join('').includes(filePath), false);
  const script = fileURLToPath(new URL('../scripts/check-complaint-backup.js', import.meta.url));
  const missing = spawnSync(process.execPath, [script, filePath], { encoding: 'utf8' });
  assert.equal(missing.status, 3);
  assert.equal(missing.stdout, '');
  assert.equal(missing.stderr.includes(filePath), false);
  await writeFile(filePath, '{"version":1,"complaints":[]}');
  const success = spawnSync(process.execPath, [script, filePath], { encoding: 'utf8' });
  assert.equal(success.status, 0);
  assert.equal(success.stderr, '');
  assert.equal(JSON.parse(success.stdout).count, 0);
});
