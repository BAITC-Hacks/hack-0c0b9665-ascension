import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_RESPONSE_BYTES = 64 * 1024;
const HELP = 'Использование: npm run bot:webhook -- info|set|delete. Токен задаётся только через TELEGRAM_BOT_TOKEN.';

class WebhookSetupError extends Error {}

function fail(message) { throw new WebhookSetupError(message); }

export function telegramWebhookEndpoint(publicBaseUrl) {
  try {
    if (typeof publicBaseUrl !== 'string' || !publicBaseUrl.trim()) throw new Error();
    const url = new URL(publicBaseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || !['', '80', '88', '8443'].includes(url.port)) throw new Error();
    return new URL('/api/telegram/webhook', url).href;
  } catch {
    fail('PUBLIC_BASE_URL должен содержать HTTPS origin без пути, логина, параметров и фрагмента; порты Telegram: 443, 80, 88, 8443.');
  }
}

async function readJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error();
  }
  if (!response.body) throw new Error();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error(); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } finally {
    reader.releaseLock();
  }
}

function webhookSummary(result) {
  if (typeof result?.url !== 'string' || !Number.isSafeInteger(result.pending_update_count) || result.pending_update_count < 0) {
    fail('Telegram вернул некорректное состояние webhook.');
  }
  return {
    webhookConfigured: result.url.length > 0,
    pendingUpdateCount: result.pending_update_count,
    maxConnections: Number.isSafeInteger(result.max_connections) ? result.max_connections : null,
    hasDeliveryError: Boolean(result.last_error_date || result.last_error_message),
  };
}

/** Operator-only API: responses and errors never expose the bot token or stored webhook URL. */
export function createTelegramWebhookClient({ token = '', fetchImpl = globalThis.fetch } = {}) {
  if (typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]{20,}$/u.test(token)) {
    fail('Задайте корректный TELEGRAM_BOT_TOKEN в окружении.');
  }

  async function request(url, options, failureMessage) {
    try {
      const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!response.ok || response.redirected) { await response.body?.cancel(); throw new Error(); }
      return await readJson(response);
    } catch {
      // Fetch errors, HTTP bodies and Telegram descriptions may contain credentials or private URLs.
      fail(failureMessage);
    }
  }

  async function call(method, body = {}) {
    const envelope = await request(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, 'Не удалось выполнить запрос Telegram. Проверьте токен, доступ к сети и повторите info.');
    if (envelope?.ok !== true) fail('Telegram отклонил запрос. Проверьте токен и настройки бота.');
    return envelope.result;
  }

  async function botInfo() {
    const bot = await call('getMe');
    if (bot?.is_bot !== true || !Number.isSafeInteger(bot.id) || bot.id <= 0 || !/^[A-Za-z0-9_]{5,32}$/u.test(bot.username ?? '')) {
      fail('Telegram вернул некорректную информацию о боте.');
    }
    return { botId: bot.id, botUsername: bot.username };
  }

  return {
    async info() {
      const bot = await botInfo();
      return { ...bot, ...webhookSummary(await call('getWebhookInfo')) };
    },
    async assertPollingAvailable() {
      const status = webhookSummary(await call('getWebhookInfo'));
      if (status.webhookConfigured) fail('Polling не запущен: у бота включён webhook. Для перехода на polling выполните npm run bot:webhook -- delete; затем запустите npm run bot.');
      return status;
    },
    async set({ publicBaseUrl, webhookSecret } = {}) {
      const endpoint = telegramWebhookEndpoint(publicBaseUrl);
      if (typeof webhookSecret !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(webhookSecret)) {
        fail('TELEGRAM_WEBHOOK_SECRET должен содержать 1–256 символов A–Z, a–z, 0–9, _ или -.');
      }
      const bot = await botInfo();
      const health = await request(new URL('/api/health', endpoint).href, { method: 'GET' }, 'Публичный сервер недоступен. Сначала разверните приложение и проверьте /api/health.');
      if (health?.ok !== true) fail('Публичный сервер не подтвердил готовность; webhook не изменён.');
      const config = await request(new URL('/api/citizen/config', endpoint).href, { method: 'GET' }, 'На публичном сервере недоступен модуль обращений; webhook не изменён.');
      if (config?.adminConfigured !== true || config.telegramUrl !== `https://t.me/${bot.botUsername}`) {
        fail('Настройте на публичном сервере ADMIN_TOKEN, TELEGRAM_BOT_TOKEN и TELEGRAM_BOT_USERNAME для этого бота; webhook не изменён.');
      }
      // An empty update is ignored by the processor; this checks the deployed secret without sending a message.
      const probe = await request(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': webhookSecret }, body: '{}',
      }, 'Сервер не принял проверку webhook. Проверьте TELEGRAM_WEBHOOK_SECRET и настройки Telegram на сервере; webhook не изменён.');
      if (probe?.ok !== true) fail('Сервер не подтвердил проверку webhook; webhook не изменён.');
      if (await call('setWebhook', { url: endpoint, secret_token: webhookSecret, max_connections: 1, allowed_updates: ['message'], drop_pending_updates: false }) !== true) {
        fail('Telegram не подтвердил настройку webhook. Проверьте состояние командой info.');
      }
      const state = await call('getWebhookInfo');
      const summary = webhookSummary(state);
      if (state.url !== endpoint || state.max_connections !== 1 || !Array.isArray(state.allowed_updates)
        || state.allowed_updates.length !== 1 || state.allowed_updates[0] !== 'message') {
        fail('Telegram не подтвердил ожидаемую конфигурацию webhook. Проверьте состояние командой info.');
      }
      return { ...bot, ...summary, configured: true };
    },
    async delete() {
      if (await call('deleteWebhook', { drop_pending_updates: false }) !== true) fail('Telegram не подтвердил отключение webhook. Проверьте состояние командой info.');
      const summary = webhookSummary(await call('getWebhookInfo'));
      if (summary.webhookConfigured) fail('Webhook остаётся включённым; polling запускать нельзя. Проверьте состояние командой info.');
      return { ...summary, deleted: true };
    },
  };
}

export async function runTelegramWebhookCommand({ args = process.argv.slice(2), env = process.env, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  if (args.length !== 1 || !['info', 'set', 'delete'].includes(args[0])) fail(HELP);
  const client = createTelegramWebhookClient({ token: env.TELEGRAM_BOT_TOKEN, fetchImpl });
  const result = args[0] === 'set'
    ? await client.set({ publicBaseUrl: env.PUBLIC_BASE_URL, webhookSecret: env.TELEGRAM_WEBHOOK_SECRET })
    : await client[args[0]]();
  log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runTelegramWebhookCommand().catch(error => {
    console.error(error instanceof WebhookSetupError ? error.message : 'Не удалось настроить webhook Telegram. Проверьте локальные настройки.');
    process.exitCode = 1;
  });
}
