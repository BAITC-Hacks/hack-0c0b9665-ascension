import { timingSafeEqual } from 'node:crypto';
import { toAdminComplaint, toPublicComplaint } from '../complaints/store-core.js';
import { createTelegramTransport, formatTelegramStatusNotification } from '../complaints/telegram.js';

const MAX_BODY = 32 * 1024;
const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
export const complaintJson = (value, status = 200, headers = {}) => Response.json(value, { status, headers: { ...HEADERS, ...headers } });

function secretEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isComplaintPath(path) {
  return ['/api/citizen/config', '/api/complaints', '/api/complaints/track', '/api/telegram/webhook'].includes(path)
    || /^\/api\/complaints\/[^/]+(?:\/photos\/\d+)?$/u.test(path);
}

function checkOrigin(request) {
  const origin = request.headers.get('origin');
  if (request.headers.get('sec-fetch-site') === 'cross-site'
    || (origin && origin !== new URL(request.url).origin)) {
    fail(403, 'CROSS_ORIGIN', 'Откройте форму на этом сайте.');
  }
}

async function readJson(request) {
  if ((request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json'
    || ![null, 'identity'].includes(request.headers.get('content-encoding'))) {
    fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Ожидается application/json без сжатия.');
  }
  if (Number(request.headers.get('content-length')) > MAX_BODY) fail(413, 'BODY_TOO_LARGE', 'Размер JSON не должен превышать 32 KiB.');
  const reader = request.body?.getReader();
  let size = 0; const chunks = [];
  if (reader) {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY) { await reader.cancel(); fail(413, 'BODY_TOO_LARGE', 'Размер JSON не должен превышать 32 KiB.'); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'INVALID_JSON', 'Не удалось прочитать JSON.'); }
}

/** Same public contract as the Node adapter; every staff route fails closed. */
export function createComplaintWorkerHandler({ store, env = {}, processUpdate, transport = createTelegramTransport({ token: env.TELEGRAM_BOT_TOKEN ?? '' }), limitIntake = async () => true }) {
  const configured = Boolean(env.TELEGRAM_BOT_TOKEN);
  function admin(request) {
    checkOrigin(request);
    if (!secretEqual(request.headers.get('x-admin-token'), env.ADMIN_TOKEN)) fail(401, 'ADMIN_REQUIRED', 'Для панели акима нужен ключ доступа администратора.');
  }
  return async function handle(request) {
    try {
      const url = new URL(request.url); const path = url.pathname;
      const photo = /^\/api\/complaints\/([^/]+)\/photos\/(\d+)$/u.exec(path);
      const item = /^\/api\/complaints\/([^/]+)$/u.exec(path);
      if (!isComplaintPath(path)) return complaintJson({ valid: false, errors: [{ code: 'NOT_FOUND', message: 'Маршрут не найден.' }] }, 404);
      const allowed = path === '/api/complaints' ? ['GET', 'POST']
        : path === '/api/citizen/config' || photo ? ['GET']
          : path === '/api/complaints/track' || path === '/api/telegram/webhook' ? ['POST'] : ['PATCH'];
      if (!allowed.includes(request.method)) return complaintJson({ valid: false, errors: [{ code: 'METHOD_NOT_ALLOWED', message: 'Метод не поддерживается.' }] }, 405, { Allow: allowed.join(', ') });
      if (path === '/api/citizen/config') return complaintJson({ telegramUrl: configured && /^[A-Za-z0-9_]{5,32}$/u.test(env.TELEGRAM_BOT_USERNAME ?? '')
        ? `https://t.me/${env.TELEGRAM_BOT_USERNAME}` : null, analysisMode: 'rules', adminConfigured: Boolean(env.ADMIN_TOKEN), demoMode: false });
      if (path === '/api/telegram/webhook') {
        if (!env.TELEGRAM_WEBHOOK_SECRET) fail(503, 'WEBHOOK_DISABLED', 'Telegram webhook не настроен.');
        if (!secretEqual(request.headers.get('x-telegram-bot-api-secret-token'), env.TELEGRAM_WEBHOOK_SECRET)) fail(401, 'WEBHOOK_SECRET', 'Неверный секрет webhook.');
        if (!configured) fail(503, 'TELEGRAM_DISABLED', 'Telegram-бот не настроен.');
        await processUpdate(await readJson(request));
        return complaintJson({ ok: true });
      }
      if (request.method === 'POST') {
        checkOrigin(request);
        if (!await limitIntake(request)) fail(429, 'RATE_LIMITED', 'Слишком много запросов. Попробуйте через минуту.');
        const body = await readJson(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'INVALID_BODY', 'Ожидается объект обращения.');
        if (path === '/api/complaints/track') return complaintJson({ complaint: await store.track(body.id, body.trackingToken) });
        const receipt = await store.create({ text: body.text, address: body.address, districtId: body.districtId,
          location: body.location, consent: body.consent, source: 'web' });
        return complaintJson({ complaint: toPublicComplaint(receipt.complaint), trackingToken: receipt.trackingToken }, 201);
      }
      admin(request);
      if (path === '/api/complaints') return complaintJson(await store.list(Object.fromEntries(
        ['status', 'priority', 'districtId', 'category', 'q'].map(key => [key, url.searchParams.get(key) ?? '']))));
      if (photo) {
        const record = await store.get(photo[1]); const attachment = record?.attachments?.[Number(photo[2])];
        if (!attachment?.fileId) fail(404, 'NOT_FOUND', 'Фото не найдено.');
        if (!configured) fail(503, 'TELEGRAM_DISABLED', 'Для загрузки фото подключите Telegram-бота.');
        const result = await transport.getPhoto(attachment.fileId);
        return new Response(result.data, { headers: { ...HEADERS, 'Content-Type': result.contentType, 'Content-Disposition': 'inline' } });
      }
      const body = await readJson(request); const previous = await store.get(item[1]);
      const record = await store.update(item[1], body);
      let notification = { state: 'not_applicable' };
      if (record.telegramChatId && ['status', 'assignee', 'resolution'].some(key => previous?.[key] !== record[key])) {
        notification = { state: configured ? 'sent' : 'not_configured' };
        if (configured) {
          try { await transport.sendMessage(record.telegramChatId, formatTelegramStatusNotification(toPublicComplaint(record))); }
          catch { notification = { state: 'failed' }; }
        }
      }
      return complaintJson({ complaint: toAdminComplaint(record), notification });
    } catch (error) {
      const known = Number.isInteger(error.status) && error.status >= 400 && error.status <= 499 && typeof error.code === 'string';
      const unavailable = error.status === 503;
      return complaintJson({ valid: false, errors: [{ code: known || unavailable ? error.code : 'INTERNAL_ERROR',
        message: known || unavailable ? error.message : 'Не удалось обработать обращение. Попробуйте ещё раз.' }] }, known ? error.status : unavailable ? 503 : 500);
    }
  };
}

/** Called from the site's existing Worker before its generic /api/* 404. */
export async function routeComplaintRequest(request, env) {
  if (!isComplaintPath(new URL(request.url).pathname)) return null;
  if (!env.COMPLAINTS) return complaintJson({ valid: false, errors: [{ code: 'COMPLAINTS_UNAVAILABLE', message: 'Хранилище обращений не подключено.' }] }, 503);
  return env.COMPLAINTS.getByName('city-complaints').fetch(request);
}
