import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateComplaintRecords } from '../src/complaints/store-core.js';

export const MAX_BACKUP_BYTES = 16 * 1024 * 1024;
const MESSAGES = {
  2: 'Укажите ровно один путь: node scripts/check-complaint-backup.js /path/to/complaints.json',
  3: 'Файл резервной копии не найден.',
  4: 'Резервная копия повреждена, не соответствует схеме version 1 или превышает 16 MiB.',
  5: 'Не удалось прочитать обычный файл резервной копии.',
};

class BackupError extends Error {
  constructor(exitCode) { super(MESSAGES[exitCode]); this.exitCode = exitCode; }
}

/** Reads only the explicitly supplied file; never imports records or writes to storage. */
export async function checkComplaintBackup(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new BackupError(2);
  let handle;
  let bytes;
  try {
    // Avoid opening devices, directories or named pipes as a backup.
    if (!(await stat(filePath)).isFile()) throw new BackupError(5);
    handle = await open(filePath, 'r');
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new BackupError(5);
    if (metadata.size > MAX_BACKUP_BYTES) throw new BackupError(4);
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_BACKUP_BYTES - total + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_BACKUP_BYTES) throw new BackupError(4);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    bytes = Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError(error.code === 'ENOENT' ? 3 : 5);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
  try {
    const state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!state || typeof state !== 'object' || Array.isArray(state) || state.version !== 1) throw new Error();
    const records = validateComplaintRecords(state.complaints);
    const bySource = { web: 0, telegram: 0 };
    for (const record of records) bySource[record.source] += 1;
    return { schema: 'complaints/version-1', count: records.length, bySource, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch {
    throw new BackupError(4);
  }
}

export async function runBackupCheck({ args = process.argv.slice(2), log = console.log, error = console.error } = {}) {
  try {
    if (args.length !== 1) throw new BackupError(2);
    log(JSON.stringify(await checkComplaintBackup(args[0]), null, 2));
    return 0;
  } catch (failure) {
    const exitCode = failure instanceof BackupError ? failure.exitCode : 5;
    error(MESSAGES[exitCode]);
    return exitCode;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runBackupCheck();
}
