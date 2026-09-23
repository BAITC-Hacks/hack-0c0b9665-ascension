import { timingSafeEqual } from 'node:crypto';
import { toAdminComplaint, toPublicComplaint } from './store-core.js';
import { createTelegramProcessor, createTelegramTransport } from './telegram.js';

const STATUS_NAMES = { new: 'Новое', in_progress: 'В работе', resolved: 'Решено', rejected: 'Отклонено' };

function fail(status, code, message) {
  throw Object.assign(new Error(message), { status, code });
}

function sameSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isLocal(request) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)
    && /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(request.headers.host ?? '');
}

function checkOrigin(request) {
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    fail(403, 'CROSS_ORIGIN', 'Откройте форму на этом сайте.');
  }
  const origin = request.headers.origin;
  if (!origin) return;
  try {
    const parsed = new URL(origin);
    if (['http:', 'https:'].includes(parsed.protocol) && parsed.host === request.headers.host) return;
  } catch { /* Reject malformed origins as well. */ }
  fail(403, 'CROSS_ORIGIN', 'Откройте форму на этом сайте.');
}

/** Isolated citizen routes. Existing simulator endpoints and data remain independent. */
export function createComplaintRouteCore(options = {}) {
  const store = options.store;
  if (!store) throw new TypeError('Complaint store is required.');
  const adminToken = options.adminToken ?? '';
  const webhookSecret = options.webhookSecret ?? '';
  const token = options.telegramToken ?? '';
  const username = options.telegramUsername ?? '';
  const transport = options.transport ?? createTelegramTransport({ token });
  const processUpdate = options.processUpdate ?? createTelegramProcessor({
    store, sendMessage: transport.sendMessage,
    publicBaseUrl: options.publicBaseUrl ?? '',
    supportUrl: options.telegramSupportUrl ?? '',
    sessionStorage: options.sessionStorage,
  });
  const canSend = Boolean(token || options.transport);
  const rate = new Map();

  function requireAdmin(request) {
    checkOrigin(request);
    if (adminToken ? sameSecret(request.headers['x-admin-token'], adminToken) : isLocal(request)) return;
    fail(401, 'ADMIN_REQUIRED', 'Для панели акима нужен ключ доступа администратора.');
  }

  function limitIntake(request) {
    const now = Date.now();
    for (const [key, value] of rate) if (value.until < now) rate.delete(key);
    const key = request.socket.remoteAddress;
    const current = rate.get(key) ?? { count: 0, until: now + 60_000 };
    if (current.count >= 30 || (!rate.has(key) && rate.size >= 1000)) {
      fail(429, 'RATE_LIMITED', 'Слишком много обращений. Попробуйте через минуту.');
    }
    current.count += 1;
    rate.set(key, current);
  }

  return async function handleComplaintRequest(request, response, pathname, { readJson, sendJson }) {
    const item = /^\/api\/complaints\/([^/]+)$/.exec(pathname);
    const photo = /^\/api\/complaints\/([^/]+)\/photos\/(\d+)$/.exec(pathname);
    const recognized = ['/api/citizen/config', '/api/complaints', '/api/complaints/track', '/api/telegram/webhook'].includes(pathname)
      || Boolean(item || photo);
    if (!recognized) return false;
    try {
      const allowed = pathname === '/api/complaints' ? ['GET', 'POST']
        : pathname === '/api/citizen/config' || photo ? ['GET']
          : pathname === '/api/complaints/track' || pathname === '/api/telegram/webhook' ? ['POST'] : ['PATCH'];
      if (!allowed.includes(request.method)) {
        response.setHeader('Allow', allowed.join(', '));
        request.resume();
        fail(405, 'METHOD_NOT_ALLOWED', 'Метод запроса не поддерживается.');
      }
      if (pathname === '/api/citizen/config') {
        sendJson(response, 200, { telegramUrl: canSend && /^[a-zA-Z0-9_]{5,32}$/.test(username)
          ? `https://t.me/${username}` : null, analysisMode: 'rules', adminConfigured: Boolean(adminToken),
        telegramConfigured: canSend, webhookConfigured: Boolean(webhookSecret),
        demoMode: !adminToken && isLocal(request) });
      } else if (pathname === '/api/telegram/webhook') {
        if (!webhookSecret) fail(503, 'WEBHOOK_DISABLED', 'Telegram webhook не настроен.');
        if (!sameSecret(request.headers['x-telegram-bot-api-secret-token'], webhookSecret)) {
          request.resume();
          fail(401, 'WEBHOOK_SECRET', 'Неверный секрет webhook.');
        }
        if (!canSend) fail(503, 'TELEGRAM_DISABLED', 'Telegram-бот не настроен.');
        await processUpdate(await readJson(request));
        sendJson(response, 200, { ok: true });
      } else if (pathname === '/api/complaints/track') {
        checkOrigin(request);
        limitIntake(request);
        const body = await readJson(request);
        if (!body || typeof body !== 'object') fail(400, 'INVALID_BODY', 'Введите номер и код обращения.');
        const complaint = await store.track(body.id, body.trackingToken);
        sendJson(response, 200, { complaint });
      } else if (pathname === '/api/complaints' && request.method === 'POST') {
        checkOrigin(request);
        limitIntake(request);
        const body = await readJson(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'INVALID_BODY', 'Ожидается объект обращения.');
        // Only public intake fields are accepted: callers cannot set status, source or Telegram identity.
        const receipt = await store.create({ text: body.text, address: body.address,
          districtId: body.districtId, location: body.location, consent: body.consent, source: 'web' });
        sendJson(response, 201, { complaint: toPublicComplaint(receipt.complaint), trackingToken: receipt.trackingToken });
      } else if (pathname === '/api/complaints') {
        requireAdmin(request);
        const params = new URL(request.url, 'http://localhost').searchParams;
        const filters = Object.fromEntries(['status', 'priority', 'districtId', 'category', 'q']
          .map(key => [key, params.get(key) ?? '']));
        sendJson(response, 200, await store.list(filters));
      } else if (photo) {
        requireAdmin(request);
        const record = await store.get(photo[1]);
        const attachment = record?.attachments?.[Number(photo[2])];
        if (!attachment?.fileId) fail(404, 'NOT_FOUND', 'Фото не найдено.');
        if (!canSend) fail(503, 'TELEGRAM_DISABLED', 'Для загрузки фото подключите Telegram-бота.');
        const result = await transport.getPhoto(attachment.fileId);
        response.writeHead(200, { 'Content-Type': result.contentType, 'Content-Length': result.data.length,
          'Cache-Control': 'no-store', 'Content-Disposition': 'inline' });
        response.end(result.data);
      } else {
        requireAdmin(request);
        const body = await readJson(request);
        const previous = await store.get(item[1]);
        const record = await store.update(item[1], body);
        let notification = { state: 'not_applicable' };
        const publicChange = !previous || ['status', 'assignee', 'resolution'].some(key => previous[key] !== record[key]);
        if (record.telegramChatId && publicChange) {
          notification = { state: canSend ? 'sent' : 'not_configured' };
          if (canSend) {
            const safe = toPublicComplaint(record);
            try {
              await transport.sendMessage(record.telegramChatId,
                `Обращение ${safe.id}: ${STATUS_NAMES[safe.status] ?? safe.status}.`
                + (safe.resolution ? `\nРешение: ${safe.resolution}` : ''));
            } catch { notification = { state: 'failed' }; }
          }
        }
        sendJson(response, 200, { complaint: toAdminComplaint(record), notification });
      }
    } catch (error) {
      if (response.destroyed || response.writableEnded) return true;
      const known = Number.isInteger(error.status) && error.status >= 400 && error.status <= 499
        && typeof error.code === 'string';
      const unavailable = error.status === 503;
      const storageMessages = {
        COMPLAINT_STORAGE_CORRUPT: 'Хранилище обращений повреждено. Данные не перезаписаны; требуется проверка файла администратором.',
        COMPLAINT_STORAGE_ERROR: 'Не удалось сохранить или прочитать обращение. Проверьте доступ к хранилищу; предыдущие данные не удалялись.',
      };
      const storageMessage = error.status === 500 ? storageMessages[error.code] : undefined;
      sendJson(response, known ? error.status : unavailable ? 503 : 500, { valid: false,
        errors: [{ code: known || unavailable || storageMessage ? error.code : 'INTERNAL_ERROR',
          message: storageMessage ?? (known || unavailable ? error.message : 'Не удалось обработать обращение. Попробуйте ещё раз.') }] });
    }
    return true;
  };
}
