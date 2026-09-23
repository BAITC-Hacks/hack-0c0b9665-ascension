import { createComplaintStoreCore, validateComplaintState } from '../complaints/store-core.js';

export { toAdminComplaint, toPublicComplaint } from '../complaints/store-core.js';

const RECORD_PREFIX = 'complaints:record:';
const queues = new WeakMap();

function serialized(storage, operation) {
  const result = (queues.get(storage) ?? Promise.resolve()).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  queues.set(storage, tail);
  void tail.then(() => { if (queues.get(storage) === tail) queues.delete(storage); });
  return result;
}

function storageFailure() {
  return Object.assign(new Error('Не удалось прочитать или сохранить хранилище обращений. Повторите запрос.'),
    { status: 500, code: 'COMPLAINT_STORAGE_ERROR' });
}

function decode(entries) {
  const positions = new Set();
  const ordered = [];
  for (const [key, entry] of entries) {
    if (!entry || entry.version !== 1 || !Number.isSafeInteger(entry.position) || entry.position < 0
      || positions.has(entry.position) || key !== `${RECORD_PREFIX}${entry.complaint?.id}`) {
      // Use the same fail-closed error contract as the local JSON store.
      return validateComplaintState(null);
    }
    positions.add(entry.position);
    ordered.push(entry);
  }
  ordered.sort((a, b) => a.position - b.position);
  if (ordered.some((entry, index) => entry.position !== index)) return validateComplaintState(null);
  return validateComplaintState({ version: 1, complaints: ordered.map(entry => entry.complaint) });
}

/**
 * Use Durable Object storage (SQLite-backed deployments also support this KV API).
 * Each record has its own key; the complete dataset is never a single KV value.
 * The original insertion order is retained for deterministic duplicate suggestions.
 * Every operation reloads state inside a transaction: no in-memory receipt can
 * survive a failed commit, and a restarted object sees the same durable receipts.
 */
export function createDurableComplaintStore({ storage }) {
  if (!storage || typeof storage.transaction !== 'function') {
    throw new TypeError('Durable Object storage with transaction() is required.');
  }
  return createComplaintStoreCore({
    run: operation => serialized(storage, async () => {
      try {
        return await storage.transaction(async transaction => {
          const entries = await transaction.list({ prefix: RECORD_PREFIX });
          const records = decode(entries);
          return operation(records, async next => {
            // Domain operations only append or update. Never silently drop a record.
            validateComplaintState({ version: 1, complaints: next });
            const nextIds = new Set(next.map(record => record.id));
            if (records.some(record => !nextIds.has(record.id))) throw storageFailure();
            const previous = new Map(records.map(record => [record.id, JSON.stringify(record)]));
            for (let index = 0; index < next.length; index += 1) {
              const record = next[index];
              if (previous.get(record.id) !== JSON.stringify(record)) {
                await transaction.put(`${RECORD_PREFIX}${record.id}`,
                  { version: 1, position: index, complaint: record });
              }
            }
          });
        });
      } catch (error) {
        if (error?.status && error?.code) throw error;
        throw storageFailure();
      }
    }),
  });
}
