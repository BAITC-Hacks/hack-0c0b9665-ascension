import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createComplaintStoreCore, validateComplaintState } from './store-core.js';

export { toAdminComplaint, toPublicComplaint } from './store-core.js';

const queues = new Map();

function failure(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function serialized(filePath, operation) {
  const previous = queues.get(filePath) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(() => undefined, () => undefined);
  queues.set(filePath, tail);
  void tail.then(() => { if (queues.get(filePath) === tail) queues.delete(filePath); });
  return result;
}

async function load(filePath) {
  let content;
  try { content = await readFile(filePath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw failure(500, 'COMPLAINT_STORAGE_ERROR', 'Не удалось прочитать хранилище обращений.');
  }
  let state;
  try { state = JSON.parse(content); }
  catch { return validateComplaintState(null); }
  return validateComplaintState(state);
}

async function save(filePath, complaints) {
  const temporary = `${filePath}.${randomBytes(12).toString('hex')}.tmp`;
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(temporary, `${JSON.stringify({ version: 1, complaints }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx', flush: true });
    await rename(temporary, filePath);
  } catch {
    throw failure(500, 'COMPLAINT_STORAGE_ERROR', 'Не удалось сохранить обращение. Предыдущие данные сохранены.');
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/** All instances using one path serialize operations, reload fresh data, and commit by atomic rename. */
export function createComplaintStore({ filePath = fileURLToPath(new URL('../../var/complaints.json', import.meta.url)) } = {}) {
  const path = resolve(filePath);
  return createComplaintStoreCore({
    run: operation => serialized(path, async () => operation(await load(path), records => save(path, records))),
  });
}
