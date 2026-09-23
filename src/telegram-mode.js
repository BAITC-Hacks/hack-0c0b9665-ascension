import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function modeError(code, message) {
  return Object.assign(new Error(message), { code });
}

function requireSecret(value) {
  if (typeof value !== 'string' || !SECRET_PATTERN.test(value)) {
    throw modeError('TELEGRAM_MODE_SECRET', 'Задайте корректный TELEGRAM_WEBHOOK_SECRET, одинаковый на сервере и в .env.local.');
  }
}

export function telegramServerUrl(value, { hosted = false, localOnly = false } = {}) {
  try {
    const url = new URL(value);
    const local = LOOPBACK.has(url.hostname);
    if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
      || (hosted && (url.protocol !== 'https:' || local)) || (localOnly && !local)) throw new Error('invalid');
    return url.origin;
  } catch {
    throw modeError('TELEGRAM_MODE_URL', hosted
      ? 'Задайте TELEGRAM_HOSTED_URL или PUBLIC_BASE_URL: публичный HTTPS-адрес сайта без пути, пароля и параметров.'
      : 'BOT_SERVER_URL должен указывать на локальный сервер (localhost, 127.0.0.1 или [::1]) без пути, пароля и параметров.');
  }
}

async function readJsonLimited(response) {
  if (Number(response.headers.get('content-length')) > 32768) throw new Error('response too large');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty response');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32768) { await reader.cancel(); throw new Error('response too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Only mode-management methods; upstream errors and token-bearing URLs never escape. */
export function createTelegramModeApi({ token = '', fetchImpl = globalThis.fetch } = {}) {
  if (typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]{20,}$/u.test(token)) {
    throw modeError('TELEGRAM_MODE_TOKEN', 'Задайте корректный TELEGRAM_BOT_TOKEN в .env.local.');
  }
  async function call(method, body = {}) {
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!response.ok || response.redirected) { await response.body?.cancel(); throw new Error('upstream'); }
      const envelope = await readJsonLimited(response);
      if (envelope?.ok !== true) throw new Error('upstream');
      return envelope.result;
    } catch {
      throw modeError('TELEGRAM_MODE_API', 'Telegram не подтвердил запрос. Проверьте токен и доступ к api.telegram.org; затем выполните npm run bot:status.');
    }
  }
  return {
    async getMe() {
      const result = await call('getMe');
      if (!result || result.is_bot !== true || !Number.isSafeInteger(result.id)) {
        throw modeError('TELEGRAM_MODE_RESPONSE', 'Telegram вернул некорректные сведения о боте.');
      }
      return result;
    },
    async getWebhookInfo() {
      const result = await call('getWebhookInfo');
      if (!result || typeof result.url !== 'string') {
        throw modeError('TELEGRAM_MODE_RESPONSE', 'Telegram вернул некорректные сведения о webhook.');
      }
      return result;
    },
    async setWebhook({ serverUrl, webhookSecret }) {
      const url = `${telegramServerUrl(serverUrl, { hosted: true })}/api/telegram/webhook`;
      requireSecret(webhookSecret);
      const result = await call('setWebhook', { url, secret_token: webhookSecret,
        max_connections: 1, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
      if (result !== true) throw modeError('TELEGRAM_MODE_RESPONSE', 'Telegram не подтвердил включение webhook.');
      return result;
    },
    async deleteWebhook() {
      const result = await call('deleteWebhook', { drop_pending_updates: false });
      if (result !== true) throw modeError('TELEGRAM_MODE_RESPONSE', 'Telegram не подтвердил отключение webhook.');
      return result;
    },
  };
}

/** Verify the actual server and matching secret before moving delivery away from its current destination. */
export async function checkTelegramServer({ serverUrl, webhookSecret, hosted = false, localOnly = false, fetchImpl = globalThis.fetch }) {
  const base = telegramServerUrl(serverUrl, { hosted, localOnly });
  requireSecret(webhookSecret);
  try {
    const configResponse = await fetchImpl(`${base}/api/citizen/config`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!configResponse.ok || configResponse.redirected) { await configResponse.body?.cancel(); throw new Error('unavailable'); }
    const config = await readJsonLimited(configResponse);
    if (config?.telegramConfigured !== true || config.webhookConfigured !== true) throw new Error('not configured');
    // No update_id or chat is supplied: the processor ignores this without sending messages.
    const probe = await fetchImpl(`${base}/api/telegram/webhook`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': webhookSecret },
      body: '{}',
    });
    if (!probe.ok || probe.redirected) { await probe.body?.cancel(); throw new Error('rejected'); }
    if ((await readJsonLimited(probe))?.ok !== true) throw new Error('invalid response');
  } catch {
    throw modeError('TELEGRAM_MODE_SERVER', hosted
      ? 'Хостинг не готов: проверьте адрес, развёртывание, TELEGRAM_BOT_TOKEN и совпадение TELEGRAM_WEBHOOK_SECRET на сервере и в .env.local. Режим бота не изменён.'
      : 'Локальный сервер не готов: сначала выполните npm start и проверьте BOT_SERVER_URL, TELEGRAM_BOT_TOKEN и TELEGRAM_WEBHOOK_SECRET. Режим бота не изменён.');
  }
  return base;
}

export async function assertTelegramPollingAllowed(api) {
  const info = await api.getWebhookInfo();
  if (typeof info?.url !== 'string') throw modeError('TELEGRAM_MODE_RESPONSE', 'Не удалось проверить режим Telegram.');
  if (info.url) throw modeError('TELEGRAM_WEBHOOK_ACTIVE', 'Бот работает через webhook. Для перехода на локальный сервер запустите npm start, затем npm run bot:local. Для хостинга используйте npm run bot:hosted.');
}

export async function switchTelegramToHosted({ api, serverUrl, webhookSecret, fetchImpl = globalThis.fetch }) {
  const base = await checkTelegramServer({ serverUrl, webhookSecret, hosted: true, fetchImpl });
  await api.setWebhook({ serverUrl: base, webhookSecret });
  return { mode: 'hosted', serverUrl: base };
}

export async function switchTelegramToLocal({ api, serverUrl, webhookSecret, fetchImpl = globalThis.fetch }) {
  const base = await checkTelegramServer({ serverUrl, webhookSecret, localOnly: true, fetchImpl });
  await api.deleteWebhook();
  await assertTelegramPollingAllowed(api);
  return { mode: 'local', serverUrl: base };
}

export function formatTelegramModeStatus(info, { token = '', webhookSecret = '' } = {}) {
  let destination = 'webhook отключён; для локальной работы нужен запущенный polling';
  if (info.url) {
    destination = 'webhook включён';
    try {
      const url = new URL(info.url);
      if (url.protocol === 'https:') destination += `: ${url.origin}${url.pathname === '/api/telegram/webhook' ? url.pathname : '/[скрытый путь]'}`;
    } catch { /* Never echo an untrusted URL. */ }
  }
  const pending = Number.isSafeInteger(info.pending_update_count) && info.pending_update_count >= 0 ? info.pending_update_count : 'неизвестно';
  let result = `Telegram: ${destination}.\nОжидающих обновлений: ${pending}.`;
  if (info.last_error_date) result += '\nTelegram сообщает об ошибке доставки; проверьте доступность хостинга и настройки webhook.';
  for (const secret of [token, webhookSecret]) if (secret) result = result.replaceAll(secret, '[скрыто]');
  return result;
}

export async function runTelegramModeCommand({ command, env = process.env, fetchImpl = globalThis.fetch,
  log = console.log, startPolling } = {}) {
  if (!['hosted', 'local', 'status'].includes(command)) throw modeError('TELEGRAM_MODE_COMMAND', 'Используйте npm run bot:hosted, npm run bot:local или npm run bot:status.');
  const token = env.TELEGRAM_BOT_TOKEN ?? '';
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET ?? '';
  const api = createTelegramModeApi({ token, fetchImpl });
  if (command === 'status') {
    log(formatTelegramModeStatus(await api.getWebhookInfo(), { token, webhookSecret }));
    return;
  }
  if (command === 'hosted') {
    await switchTelegramToHosted({ api, serverUrl: env.TELEGRAM_HOSTED_URL || env.PUBLIC_BASE_URL,
      webhookSecret, fetchImpl });
    log('Хостинг включён: Telegram доставляет обновления на сервер. Компьютер можно выключить. Для возврата используйте npm run bot:local.');
    return;
  }
  const serverUrl = env.BOT_SERVER_URL || `http://127.0.0.1:${env.PORT || 3000}`;
  await switchTelegramToLocal({ api, serverUrl, webhookSecret, fetchImpl });
  log('Локальный режим включён. Для возврата на хостинг остановите polling и выполните npm run bot:hosted.');
  const poll = startPolling ?? (await import('./telegram-poll.js')).startTelegramPolling;
  await poll({ env, fetchImpl, log });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runTelegramModeCommand({ command: process.argv[2] }).catch(error => {
    console.error(error?.code?.startsWith('TELEGRAM_MODE_') || error?.code === 'TELEGRAM_WEBHOOK_ACTIVE'
      ? error.message : 'Не удалось переключить Telegram. Проверьте настройки и выполните npm run bot:status.');
    process.exitCode = 1;
  });
}
