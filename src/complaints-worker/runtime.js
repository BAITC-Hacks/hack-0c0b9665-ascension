import { createDurableComplaintStore } from './store.js';
import { createComplaintWorkerHandler } from './http.js';
import { createTelegramProcessor, createTelegramTransport } from '../complaints/telegram.js';

const SESSION_TTL = 30 * 60 * 1000;
const SESSION_PREFIX = 'telegram-session:';
const UPDATE_PREFIX = 'telegram-update:';
const UPDATE_TTL = 24 * 60 * 60 * 1000;

/** Runtime separated from the platform base class so eviction can be tested. */
export function createComplaintRuntime({ storage, env = {}, transport = createTelegramTransport({ token: env.TELEGRAM_BOT_TOKEN ?? '' }), now = Date.now }) {
  const store = createDurableComplaintStore({ storage });
  let queue = Promise.resolve();

  async function processUpdate(update) {
    if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) return;
    const message = update.message ?? update.callback_query?.message;
    const chatId = String(message?.chat?.id ?? '');
    if (message?.chat?.type !== 'private' || !/^\d{1,20}$/u.test(chatId)) return;
    if (update.callback_query && String(update.callback_query.from?.id ?? '') !== chatId) return;
    const key = `${SESSION_PREFIX}${chatId}`;
    const updateKey = `${UPDATE_PREFIX}${update.update_id}`;
    const delivery = await storage.get(updateKey);
    if (delivery?.expiresAt > now() && delivery.chatId === chatId && delivery.entry.complete) return;
    const stored = await storage.get(key);
    const initialState = stored?.expiresAt > now() ? stored.state : { drafts: [], screens: [], updates: [] };
    if (delivery?.expiresAt > now() && delivery.chatId === chatId) {
      initialState.updates = initialState.updates.filter(([id]) => id !== update.update_id);
      initialState.updates.push([update.update_id, delivery.entry]);
    }
    const processor = createTelegramProcessor({ store, sendMessage: transport.sendMessage,
      publicBaseUrl: env.PUBLIC_BASE_URL ?? '', supportUrl: env.TELEGRAM_SUPPORT_URL ?? '', initialState,
      saveState: async state => {
        // Bound each SQLite-backed KV value independently. Pending replies are
        // retained before send, so a retry after eviction does not append text twice.
        while (JSON.stringify(state).length > 24000 && state.updates.length > 1) state.updates.shift();
        await storage.transaction(async transaction => {
          await transaction.put(key, { state, expiresAt: now() + SESSION_TTL });
          const entry = state.updates.find(([id]) => id === update.update_id)?.[1];
          if (entry) await transaction.put(updateKey, { chatId, entry, expiresAt: now() + UPDATE_TTL });
        });
        if (storage.getAlarm && storage.setAlarm && !await storage.getAlarm()) await storage.setAlarm(now() + SESSION_TTL);
      } });
    await processor(update);
  }

  async function limitIntake() {
    // Global ingress ceiling is persistent and does not trust forwarded IPs.
    const key = 'intake-minute'; const minute = Math.floor(now() / 60000);
    const saved = await storage.get(key);
    const count = saved?.minute === minute ? saved.count : 0;
    if (count >= 60) return false;
    await storage.put(key, { minute, count: count + 1 });
    return true;
  }

  const handle = createComplaintWorkerHandler({ store, env, transport, processUpdate, limitIntake });
  function serial(operation) {
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }
  return {
    fetch(request) { return serial(() => handle(request)); },
    alarm() {
      return serial(async () => {
        const entries = new Map([...(await storage.list({ prefix: SESSION_PREFIX })), ...(await storage.list({ prefix: UPDATE_PREFIX }))]);
        const expired = []; let next = Infinity;
        for (const [key, value] of entries) {
          if (value.expiresAt <= now()) expired.push(key);
          else next = Math.min(next, value.expiresAt);
        }
        for (let offset = 0; offset < expired.length; offset += 128) await storage.delete(expired.slice(offset, offset + 128));
        if (Number.isFinite(next)) await storage.setAlarm(next);
      });
    },
  };
}
