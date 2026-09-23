import { createComplaintStoreCore, validateComplaintRecords } from './store-core.js';

const PREFIX = 'complaint:';
const queues = new WeakMap();

function storageError() {
  return Object.assign(new Error('Не удалось сохранить или прочитать хранилище обращений. Предыдущие данные сохранены.'),
    { status: 500, code: 'COMPLAINT_STORAGE_ERROR' });
}

function corruptStorage() {
  return Object.assign(new Error('Хранилище обращений повреждено. Данные не перезаписаны; требуется восстановление.'),
    { status: 500, code: 'COMPLAINT_STORAGE_CORRUPT' });
}

function serialized(storage, operation) {
  const previous = queues.get(storage) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(() => undefined, () => undefined);
  queues.set(storage, tail);
  void tail.then(() => { if (queues.get(storage) === tail) queues.delete(storage); });
  return result;
}

async function load(storage) {
  let entries;
  try { entries = await storage.list({ prefix: PREFIX }); }
  catch { throw storageError(); }
  if (!(entries instanceof Map)) throw corruptStorage();
  const records = validateComplaintRecords([...entries.values()]);
  if ([...entries].some(([key, value]) => key !== `${PREFIX}${value.id}`)) throw corruptStorage();
  return records;
}

/** One durable key per complaint, sharing all validation and privacy rules with local storage. */
export function createDurableComplaintStore({ storage }) {
  if (!storage?.list || !storage?.transaction) throw new TypeError('Нужно постоянное хранилище Durable Object.');
  return createComplaintStoreCore({
    run: operation => serialized(storage, async () => operation(await load(storage))),
    async save(records) {
      validateComplaintRecords(records);
      try {
        await storage.transaction(async transaction => {
          const previous = new Map((await load(transaction)).map(record => [record.id, record]));
          const nextIds = new Set(records.map(record => record.id));
          for (const record of records) {
            // Unchanged records are never rewritten when another complaint changes.
            if (JSON.stringify(previous.get(record.id)) !== JSON.stringify(record)) {
              await transaction.put(`${PREFIX}${record.id}`, record);
            }
          }
          for (const id of previous.keys()) {
            if (!nextIds.has(id)) await transaction.delete(`${PREFIX}${id}`);
          }
        });
      } catch (error) {
        if (error.code === 'COMPLAINT_STORAGE_CORRUPT') throw error;
        throw storageError();
      }
    },
  });
}
