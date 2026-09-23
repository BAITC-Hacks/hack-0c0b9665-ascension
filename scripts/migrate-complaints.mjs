import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { summarizeSnapshot } from '../src/complaints/migration.js';

const TARGET = 'https://ascension-city-map.azamatbreach.workers.dev';
const MIGRATION_PATH = '/api/complaints/_migration';
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/u;
const ACTIONS = new Set(['plan', 'commit', 'verify']);
const MESSAGES = {
  MIGRATION_ARGUMENTS: 'Используйте plan|commit|verify --file PATH; commit также требует --plan-digest HASH и --writers-stopped.',
  MIGRATION_TARGET: 'Перенос разрешён только на согласованный адрес ascension-city-map.azamatbreach.workers.dev.',
  MIGRATION_CREDENTIALS: 'Задайте ADMIN_TOKEN и COMPLAINTS_MIGRATION_TOKEN в приватном окружении.',
  MIGRATION_FILE: 'Не удалось безопасно прочитать файл снимка. Укажите существующий приватный JSON-файл.',
  MIGRATION_SNAPSHOT_INVALID: 'Снимок обращений не прошёл проверку. Никакие данные не отправлены.',
  MIGRATION_TOO_LARGE: 'Снимок или ответ превышает допустимый размер. Перенос не подтверждён.',
  MIGRATION_NETWORK: 'Сервер не подтвердил запрос. Проверьте доступность сайта; при неопределённом результате повторите проверку.',
  MIGRATION_AUTH: 'Сервер не подтвердил ключи доступа к миграции.',
  MIGRATION_UNAVAILABLE: 'Закрытая миграция на согласованном сайте пока недоступна.',
  MIGRATION_CONFLICT: 'Сервер обнаружил конфликт или изменение плана. Перенос не подтверждён; получите новый план.',
  MIGRATION_RESPONSE: 'Сервер вернул неподтверждённый результат миграции.',
  MIGRATION_RECEIPT: 'Проверка старых квитанций не завершена. Не переключайте бота.',
  MIGRATION_PHOTO: 'Проверка сохранённых фотографий не завершена. Не переключайте бота.',
};

class MigrationCommandError extends Error {
  constructor(code) { super(MESSAGES[code]); this.code = code; }
}
function fail(code) { throw new MigrationCommandError(code); }

function parseArguments(argv, env) {
  if (!Array.isArray(argv) || !ACTIONS.has(argv[0])) fail('MIGRATION_ARGUMENTS');
  const action = argv[0];
  const values = {};
  for (let index = 1; index < argv.length; index++) {
    const option = argv[index];
    if (!['--file', '--plan-digest', '--writers-stopped'].includes(option) || option in values) fail('MIGRATION_ARGUMENTS');
    if (option === '--writers-stopped') values[option] = true;
    else {
      const value = argv[++index];
      if (typeof value !== 'string' || !value || value.startsWith('--')) fail('MIGRATION_ARGUMENTS');
      values[option] = value;
    }
  }
  const file = values['--file'] ?? env.COMPLAINTS_FILE;
  if (typeof file !== 'string' || !file.trim() || file.includes('\0')) fail('MIGRATION_ARGUMENTS');
  if (action === 'commit') {
    if (!values['--writers-stopped'] || !DIGEST.test(values['--plan-digest'] ?? '')) fail('MIGRATION_ARGUMENTS');
  } else if ('--writers-stopped' in values || '--plan-digest' in values) fail('MIGRATION_ARGUMENTS');
  return { action, file, planDigest: values['--plan-digest'] };
}

function checkEnvironment(env) {
  if (env.TELEGRAM_HOSTED_URL !== undefined && env.TELEGRAM_HOSTED_URL !== '') {
    try {
      const configured = new URL(env.TELEGRAM_HOSTED_URL);
      if (configured.origin !== TARGET || configured.pathname !== '/' || configured.search || configured.hash
        || configured.username || configured.password) fail('MIGRATION_TARGET');
    } catch { fail('MIGRATION_TARGET'); }
  }
  for (const name of ['ADMIN_TOKEN', 'COMPLAINTS_MIGRATION_TOKEN']) {
    const value = env[name];
    if (typeof value !== 'string' || !value || value.length > 1024 || /[^\x21-\x7e]/u.test(value)) fail('MIGRATION_CREDENTIALS');
  }
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(env.COMPLAINTS_MIGRATION_TOKEN)
    || env.COMPLAINTS_MIGRATION_TOKEN === env.ADMIN_TOKEN) fail('MIGRATION_CREDENTIALS');
}

/** Limit allocation as well as parsing, including a file growing after stat(). */
async function readSnapshotFile(path) {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail('MIGRATION_FILE');
    if (stat.size > MAX_SNAPSHOT_BYTES) fail('MIGRATION_TOO_LARGE');
    const buffer = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await handle.read(buffer, bytes, buffer.length - bytes, null);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
    }
    if (bytes > MAX_SNAPSHOT_BYTES) fail('MIGRATION_TOO_LARGE');
    return buffer.subarray(0, bytes);
  } finally { await handle.close(); }
}

async function limitedBytes(response, limit, errorCode) {
  if (Number(response.headers.get('content-length')) > limit) {
    try { await response.body?.cancel(); } catch { /* Never expose upstream details. */ }
    fail(errorCode);
  }
  const reader = response.body?.getReader();
  if (!reader) fail(errorCode);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => {}); fail(errorCode); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof MigrationCommandError) throw error;
    fail(errorCode);
  } finally { reader.releaseLock(); }
}

async function jsonResponse(response, limit, errorCode) {
  if ((response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    try { await response.body?.cancel(); } catch { /* Only static diagnostics are reported. */ }
    fail(errorCode);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await limitedBytes(response, limit, errorCode))); }
  catch (error) { if (error instanceof MigrationCommandError) throw error; fail(errorCode); }
}

async function request(fetchImpl, path, options, errorCode = 'MIGRATION_NETWORK') {
  let response;
  try {
    response = await fetchImpl(`${TARGET}${path}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) });
  } catch { fail(errorCode); }
  if (response.redirected || response.status >= 300 && response.status < 400) {
    try { await response.body?.cancel(); } catch { /* Redirects never receive credentials. */ }
    fail(errorCode);
  }
  return response;
}

function checkedSummary(body, action, local) {
  if (!body || body.ok !== true || body.action !== action || body.sourceDigest !== local.sourceDigest
    || body.sourceCount !== local.sourceCount || body.photoCount !== local.photoCount
    || !DIGEST.test(body.planDigest ?? '')
    || !['sourceCount', 'photoCount', 'targetCount', 'insertCount', 'unchangedCount']
      .every(name => Number.isSafeInteger(body[name]) && body[name] >= 0)
    || body.insertCount + body.unchangedCount !== local.sourceCount
    || action === 'verify' && body.verified !== true) fail('MIGRATION_RESPONSE');
  return { action, sourceDigest: body.sourceDigest, sourceCount: body.sourceCount, photoCount: body.photoCount,
    targetCount: body.targetCount, insertCount: body.insertCount, unchangedCount: body.unchangedCount,
    planDigest: body.planDigest, ...(action === 'verify' ? { verified: true } : {}) };
}

function photoType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function verifyReceiptsAndPhotos(snapshot, { fetchImpl, adminToken, sleep }) {
  let receiptsVerified = 0;
  let photosVerified = 0;
  for (const record of snapshot.complaints) {
    // Public tracking allows 30 requests/minute per IP. Do not skip larger snapshots.
    if (receiptsVerified) await sleep(2100);
    const response = await request(fetchImpl, '/api/complaints/track', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: record.id, trackingToken: record.trackingToken }),
    }, 'MIGRATION_RECEIPT');
    if (!response.ok) { await response.body?.cancel().catch(() => {}); fail('MIGRATION_RECEIPT'); }
    const body = await jsonResponse(response, MAX_SNAPSHOT_BYTES, 'MIGRATION_RECEIPT');
    if (body?.complaint?.id !== record.id || body.complaint.status !== record.status) fail('MIGRATION_RECEIPT');
    receiptsVerified++;
    for (let index = 0; index < record.attachments.length; index++) {
      const photo = await request(fetchImpl, `/api/complaints/${record.id}/photos/${index}`, {
        method: 'GET', headers: { 'X-Admin-Token': adminToken },
      }, 'MIGRATION_PHOTO');
      if (!photo.ok) { await photo.body?.cancel().catch(() => {}); fail('MIGRATION_PHOTO'); }
      const bytes = await limitedBytes(photo, MAX_PHOTO_BYTES, 'MIGRATION_PHOTO');
      const contentType = (photo.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!photoType(bytes) || photoType(bytes) !== contentType) fail('MIGRATION_PHOTO');
      photosVerified++;
    }
  }
  return { receiptsVerified, photosVerified };
}

/** Private operator command; never sends Telegram messages or changes delivery mode. */
export async function runMigrationCommand({ argv = process.argv.slice(2), env = process.env,
  readFile = readSnapshotFile, fetchImpl = globalThis.fetch, log = console.log, sleep = delay } = {}) {
  try {
    const { action, file, planDigest } = parseArguments(argv, env);
    checkEnvironment(env);
    let bytes;
    try { bytes = await readFile(file); }
    catch (error) { if (error instanceof MigrationCommandError) throw error; fail('MIGRATION_FILE'); }
    if (typeof bytes !== 'string' && !(bytes instanceof Uint8Array)) fail('MIGRATION_FILE');
    if (Buffer.byteLength(bytes) > MAX_SNAPSHOT_BYTES) fail('MIGRATION_TOO_LARGE');
    let snapshot;
    let local;
    try {
      snapshot = JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      local = await summarizeSnapshot(snapshot);
    } catch { fail('MIGRATION_SNAPSHOT_INVALID'); }
    const response = await request(fetchImpl, MIGRATION_PATH, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': env.ADMIN_TOKEN,
        'X-Complaints-Migration-Token': env.COMPLAINTS_MIGRATION_TOKEN },
      body: JSON.stringify({ action, snapshot, ...(planDigest ? { planDigest } : {}) }),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if ([401, 403].includes(response.status)) fail('MIGRATION_AUTH');
      if ([404, 503].includes(response.status)) fail('MIGRATION_UNAVAILABLE');
      if (response.status === 409) fail('MIGRATION_CONFLICT');
      if (response.status === 413) fail('MIGRATION_TOO_LARGE');
      fail('MIGRATION_RESPONSE');
    }
    const result = checkedSummary(await jsonResponse(response, 16384, 'MIGRATION_RESPONSE'), action, local);
    if (action === 'verify') Object.assign(result, await verifyReceiptsAndPhotos(snapshot,
      { fetchImpl, adminToken: env.ADMIN_TOKEN, sleep }));
    log(JSON.stringify(result));
    if (action === 'commit') log('Импорт подтверждён. Выполните verify перед согласованным переключением бота.');
    if (action === 'verify') log('Проверены импортированные записи, старые квитанции и имеющиеся фото. Переключение бота и новая Telegram-заявка с фото проверяются отдельно.');
    return result;
  } catch (error) {
    if (error instanceof MigrationCommandError) throw error;
    fail('MIGRATION_RESPONSE');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMigrationCommand().catch(error => {
    console.error(`${error.code}: ${error.message}`);
    process.exitCode = 1;
  });
}
