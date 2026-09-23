import { createHash, timingSafeEqual } from 'node:crypto';
import { validateComplaintRecords } from './store-core.js';

export const MIGRATION_PATH = '/api/complaints/_migration';
export const MIGRATION_MAX_BYTES = 5 * 1024 * 1024;
const PREFIX = 'complaint:';
const MAX_RECORDS = 1000;
const MAX_RECORD_BYTES = 100 * 1024;
const CODES = new Set(['MIGRATION_SNAPSHOT_INVALID', 'MIGRATION_CONFLICT', 'MIGRATION_PLAN_CHANGED',
  'MIGRATION_INCOMPLETE', 'MIGRATION_STORAGE_ERROR', 'MIGRATION_BODY_TOO_LARGE', 'MIGRATION_REQUEST_INVALID']);

function failure(status, code, message) { return Object.assign(new Error(message), { status, code }); }
const invalid = () => failure(400, 'MIGRATION_SNAPSHOT_INVALID', 'Некорректный снимок обращений.');
const conflict = () => failure(409, 'MIGRATION_CONFLICT', 'Снимок конфликтует с существующими записями. Ничего не перезаписано.');
const storageError = () => failure(500, 'MIGRATION_STORAGE_ERROR', 'Не удалось проверить или сохранить целевое хранилище.');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** Order-independent full-record comparison; no normalization or reclassification. */
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  throw invalid();
}
const hash = value => createHash('sha256').update(value).digest('hex');
const recordDigest = records => hash(canonical({ version: 1, complaints: [...records].sort((a, b) => a.id.localeCompare(b.id)) }));

function validateRecords(records) {
  validateComplaintRecords(records);
  const drafts = new Set();
  for (const record of records) {
    if (Buffer.byteLength(canonical(record)) > MAX_RECORD_BYTES) throw invalid();
    if (record.source === 'telegram' && record.telegramDraftId) {
      const key = `${record.telegramChatId}:${record.telegramDraftId}`;
      if (drafts.has(key)) throw invalid();
      drafts.add(key);
    }
  }
  return records;
}

function snapshotRecords(snapshot) {
  try {
    if (!plain(snapshot) || snapshot.version !== 1 || Object.keys(snapshot).some(key => !['version', 'complaints'].includes(key))
      || !Array.isArray(snapshot.complaints) || snapshot.complaints.length > MAX_RECORDS
      || Buffer.byteLength(canonical(snapshot)) > MIGRATION_MAX_BYTES) throw invalid();
    return structuredClone(validateRecords(snapshot.complaints));
  } catch { throw invalid(); }
}

export function summarizeSnapshot(snapshot) {
  const records = snapshotRecords(snapshot);
  return { sourceDigest: recordDigest(records), sourceCount: records.length,
    photoCount: records.reduce((count, record) => count + record.attachments.length, 0) };
}

async function loadTarget(storage) {
  try {
    const entries = await storage.list({ prefix: PREFIX });
    if (!(entries instanceof Map) || [...entries].some(([key, record]) => key !== `${PREFIX}${record?.id}`)) throw storageError();
    return validateRecords([...entries.values()]);
  } catch { throw storageError(); }
}

function makePlan(records, target) {
  const existing = new Map(target.map(record => [record.id, record]));
  const insert = [];
  for (const record of records) {
    const previous = existing.get(record.id);
    if (previous && canonical(previous) !== canonical(record)) throw conflict();
    if (!previous) insert.push(record);
  }
  try { validateRecords([...target, ...insert]); } catch { throw conflict(); }
  const sourceDigest = recordDigest(records);
  const targetDigest = recordDigest(target);
  return { insert, summary: { sourceDigest, targetDigest, sourceCount: records.length,
    photoCount: records.reduce((count, record) => count + record.attachments.length, 0),
    targetCount: target.length, insertCount: insert.length, unchangedCount: records.length - insert.length,
    planDigest: hash(`${sourceDigest}:${targetDigest}`) } };
}

/** runExclusive MUST be the same lock used by all complaint writers for this storage. */
export function createComplaintMigrationService({ storage, runExclusive }) {
  if (!storage?.list || !storage?.transaction || typeof runExclusive !== 'function') {
    throw new TypeError('Migration requires durable storage and the shared complaint write lock.');
  }
  return async function migrate({ action, snapshot, planDigest } = {}) {
    if (!['plan', 'commit', 'verify'].includes(action)
      || (action === 'commit' && !/^[a-f0-9]{64}$/u.test(planDigest ?? ''))) {
      throw failure(400, 'MIGRATION_REQUEST_INVALID', 'Нужны корректное действие и хеш плана для commit.');
    }
    const records = snapshotRecords(snapshot);
    try {
      return await runExclusive(async () => {
        const apply = async targetStorage => {
          const target = await loadTarget(targetStorage);
          const { insert, summary } = makePlan(records, target);
          if (action === 'verify' && insert.length) {
            throw failure(409, 'MIGRATION_INCOMPLETE', 'Не все записи снимка найдены в целевом хранилище.');
          }
          if (action === 'commit') {
            // An identical retry after a lost response is safe even with the original pre-import plan.
            if (insert.length && planDigest !== summary.planDigest) {
              throw failure(409, 'MIGRATION_PLAN_CHANGED', 'Снимок или целевое хранилище изменились. Выполните plan снова.');
            }
            for (const record of insert) await targetStorage.put(`${PREFIX}${record.id}`, record);
            const receiptKey = `complaints:migration:${summary.sourceDigest}`;
            if (!await targetStorage.get(receiptKey)) {
              await targetStorage.put(receiptKey, { version: 1, sourceDigest: summary.sourceDigest,
                sourceCount: summary.sourceCount, photoCount: summary.photoCount, insertedCount: insert.length,
                targetDigestBefore: summary.targetDigest, planDigest: summary.planDigest, importedAt: new Date().toISOString() });
            }
          }
          return { ok: true, action, ...summary,
            targetCount: target.length + (action === 'commit' ? insert.length : 0),
            ...(action === 'verify' ? { verified: true } : {}) };
        };
        return action === 'commit' ? storage.transaction(apply) : apply(storage);
      });
    } catch (error) {
      if (CODES.has(error?.code)) throw error;
      throw storageError();
    }
  };
}

function sameSecret(actual, expected) {
  if (typeof actual !== 'string' || actual.length > 4096 || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readRequest(request) {
  if ((request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json'
    || !['', 'identity'].includes(request.headers.get('Content-Encoding') ?? '')) {
    throw failure(415, 'MIGRATION_REQUEST_INVALID', 'Ожидается JSON без сжатия.');
  }
  const tooLarge = () => failure(413, 'MIGRATION_BODY_TOO_LARGE', 'Снимок превышает допустимый размер переноса.');
  // The transport envelope also contains the action and plan hash.
  const limit = MIGRATION_MAX_BYTES + 1024;
  if (Number(request.headers.get('Content-Length')) > limit) throw tooLarge();
  const reader = request.body?.getReader();
  let size = 0;
  const chunks = [];
  try {
    if (reader) while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw tooLarge();
      chunks.push(value);
    }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
    if (!plain(body) || Object.keys(body).some(key => !['action', 'snapshot', 'planDigest'].includes(key))) {
      throw failure(400, 'MIGRATION_REQUEST_INVALID', 'Некорректный запрос переноса.');
    }
    return body;
  } catch (error) {
    try { await reader?.cancel(); } catch { /* Keep the bounded parser error private. */ }
    if (CODES.has(error?.code)) throw error;
    throw failure(400, 'MIGRATION_REQUEST_INVALID', 'Не удалось прочитать запрос переноса.');
  } finally { reader?.releaseLock(); }
}

/** CLI-only maintenance route. No configured independent secret means no route. */
export function createComplaintMigrationHandler({ migrate, adminToken = '', migrationToken = '' }) {
  const enabled = typeof migrate === 'function' && Boolean(adminToken)
    && /^[A-Za-z0-9_-]{32,256}$/u.test(migrationToken) && migrationToken !== adminToken;
  const reply = (body, status = 200, extra = {}) => Response.json(body, { status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra } });
  return async request => {
    if (new URL(request.url).pathname !== MIGRATION_PATH) return null;
    // A bodyless rejection avoids workerd's unread forwarded-request lifecycle
    // error (cloudflare/workerd#918), without reading an unauthorized upload.
    const reject = (body, status, extra = {}) => new Response(null, { status, headers: {
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Migration-Error': body.code, ...extra,
    } });
    if (!enabled) return reject({ ok: false, code: 'NOT_FOUND', message: 'Маршрут не найден.' }, 404);
    if (request.method !== 'POST') return reject({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Нужен POST.' }, 405, { Allow: 'POST' });
    if (!sameSecret(request.headers.get('X-Admin-Token'), adminToken)
      || !sameSecret(request.headers.get('X-Complaints-Migration-Token'), migrationToken)) {
      return reject({ ok: false, code: 'MIGRATION_AUTH_REQUIRED', message: 'Нужны ключи администратора и переноса.' }, 401);
    }
    if (request.headers.has('Origin') || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
      return reject({ ok: false, code: 'MIGRATION_ORIGIN_REJECTED', message: 'Используйте приватный CLI переноса.' }, 403);
    }
    try { return reply(await migrate(await readRequest(request))); }
    catch (error) {
      const safe = CODES.has(error?.code) ? error : storageError();
      return reject({ ok: false, code: safe.code, message: safe.message }, safe.status);
    }
  };
}
