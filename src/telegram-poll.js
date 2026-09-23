import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createTelegramTransport } from './complaints/telegram.js';
import { assertTelegramPollingAllowed, createTelegramModeApi } from './telegram-mode.js';

export function createTelegramForwarder({ serverUrl = 'http://127.0.0.1:3000', webhookSecret, fetchImpl = globalThis.fetch }) {
  if (typeof webhookSecret !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(webhookSecret)) throw new Error('Задайте корректный TELEGRAM_WEBHOOK_SECRET.');
  let endpoint;
  try {
    const url = new URL(serverUrl);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new Error('invalid');
    endpoint = new URL('/api/telegram/webhook', url).href;
  } catch {
    throw new Error('BOT_SERVER_URL должен быть HTTPS-адресом или локальным HTTP-адресом без пароля и параметров.');
  }
  return async function forwardUpdate(update) {
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': webhookSecret },
        body: JSON.stringify(update),
      });
      await response.body?.cancel();
      if (!response.ok || response.redirected) throw new Error('not accepted');
    } catch {
      // Neither the configured URL nor response/error bodies enter application logs.
      throw new Error('Сервер не подтвердил обработку обновления Telegram.');
    }
  };
}

export async function runTelegramPolling({ transport, forwardUpdate, signal, onError = () => {}, retryDelayMs = 3000 }) {
  if (typeof forwardUpdate !== 'function') throw new TypeError('Нужен обработчик передачи обновлений серверу.');
  let offset = 0;
  while (!signal?.aborted) {
    try {
      const updates = await transport.getUpdates(offset);
      for (const update of [...updates].sort((a, b) => a.update_id - b.update_id)) {
        if (signal?.aborted) break;
        if (!Number.isSafeInteger(update?.update_id) || update.update_id < offset) continue;
        await forwardUpdate(update);
        offset = update.update_id + 1;
      }
      if (!updates.length) await delay(200, undefined, { signal });
    } catch (error) {
      if (signal?.aborted) break;
      onError(error);
      await delay(retryDelayMs, undefined, { signal }).catch(() => {});
    }
  }
}

export async function startTelegramPolling({ env = process.env, fetchImpl = globalThis.fetch,
  log = console.log, logError = console.error } = {}) {
  const token = env.TELEGRAM_BOT_TOKEN ?? '';
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET ?? '';
  if (!token || !webhookSecret) {
    throw Object.assign(new Error('Polling не запущен: задайте TELEGRAM_BOT_TOKEN и TELEGRAM_WEBHOOK_SECRET в локальном окружении и запустите основной сервер.'), { code: 'TELEGRAM_MODE_CONFIG' });
  }
  const transport = createTelegramTransport({ token, fetchImpl });
  const serverUrl = env.BOT_SERVER_URL || `http://127.0.0.1:${env.PORT || 3000}`;
  const forwardUpdate = createTelegramForwarder({ serverUrl, webhookSecret, fetchImpl });
  await assertTelegramPollingAllowed(createTelegramModeApi({ token, fetchImpl }));
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    log('Telegram polling запущен: обновления передаются основному серверу. Используйте один процесс polling. Для хостинга остановите polling и выполните npm run bot:hosted.');
    await runTelegramPolling({ transport, forwardUpdate, signal: controller.signal, onError: () => logError('Не удалось обработать обновление Telegram; повтор через 3 секунды.') });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startTelegramPolling().catch(error => {
    console.error(error?.code?.startsWith('TELEGRAM_MODE_') || error?.code === 'TELEGRAM_WEBHOOK_ACTIVE'
      ? error.message : 'Не удалось запустить Telegram polling. Проверьте локальные настройки и доступ к хранилищу.');
    process.exitCode = 1;
  });
}
