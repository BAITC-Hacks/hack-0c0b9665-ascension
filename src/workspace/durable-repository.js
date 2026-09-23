import { createRepository } from './repository.js';

export function createDurableRepository(storage) {
  return createRepository({
    rows: (query, ...args) => storage.sql.exec(query, ...args).toArray(),
    run: (query, ...args) => { storage.sql.exec(query, ...args); },
    transaction: (fn) => storage.transactionSync(fn),
  });
}
