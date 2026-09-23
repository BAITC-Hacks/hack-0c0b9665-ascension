import { DatabaseSync } from 'node:sqlite';
import { createRepository } from './repository.js';

// Operator chooses a persistent path outside public/. No database is opened on module import.
export function createSqliteRepository(path) {
  if (typeof path !== 'string' || !path) throw new TypeError('An explicit database path is required.');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  const port = {
    rows: (query, ...args) => db.prepare(query).all(...args),
    run: (query, ...args) => db.prepare(query).run(...args),
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const value = fn(); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  const repository = createRepository(port);
  return { ...repository, close: () => db.close() };
}
