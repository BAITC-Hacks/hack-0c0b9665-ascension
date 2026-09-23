import { WorkspaceError, validateDocument } from './schema.js';

// The port's transaction callback MUST be synchronous and isolated across all clients.
export function createRepository(sql) {
  sql.run('CREATE TABLE IF NOT EXISTS workspace_document (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL, document TEXT NOT NULL)');
  sql.run('CREATE TABLE IF NOT EXISTS workspace_audit (revision INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, summary TEXT NOT NULL)');
  sql.run('CREATE TABLE IF NOT EXISTS workspace_login_limit (singleton INTEGER PRIMARY KEY CHECK(singleton=1), window_start INTEGER NOT NULL, attempts INTEGER NOT NULL)');
  sql.run('CREATE TABLE IF NOT EXISTS workspace_revoked_sessions (id TEXT PRIMARY KEY, expires INTEGER NOT NULL)');
  sql.run("INSERT OR IGNORE INTO workspace_document VALUES (1, 0, '{\"schemaVersion\":2,\"registers\":[]}')");
  const read = () => {
    const row = sql.rows('SELECT revision, document FROM workspace_document WHERE singleton=1')[0];
    return { revision: row.revision, document: JSON.parse(row.document) };
  };
  return {
    read,
    write({ expectedRevision, document, actor, at }) {
      const copy = validateDocument(document);
      return sql.transaction(() => {
        const { revision } = read();
        if (revision !== expectedRevision) throw new WorkspaceError(409, 'REVISION_CONFLICT', 'Реестр изменён другим участником. Локальные правки сохранены; загрузите общую версию перед новой публикацией.', { currentRevision: revision });
        if (!Number.isSafeInteger(revision + 1)) throw new WorkspaceError(503, 'REVISION_LIMIT', 'Достигнут предел версий.');
        const next = revision + 1;
        const summary = { registers: copy.registers.length, actions: copy.registers.reduce((n, r) => n + r.actions.length, 0) };
        sql.run('UPDATE workspace_document SET revision=?, document=? WHERE singleton=1', next, JSON.stringify(copy));
        sql.run('INSERT INTO workspace_audit (revision, at, actor, summary) VALUES (?, ?, ?, ?)', next, at, JSON.stringify(actor), JSON.stringify(summary));
        return { revision: next, document: copy };
      });
    },
    audit() { return sql.rows('SELECT revision, at, actor, summary FROM workspace_audit ORDER BY revision DESC LIMIT 50').map((r) => ({ revision: r.revision, at: r.at, actor: JSON.parse(r.actor), summary: JSON.parse(r.summary) })); },
    consumeLogin(now) {
      return sql.transaction(() => {
        const row = sql.rows('SELECT window_start, attempts FROM workspace_login_limit WHERE singleton=1')[0];
        const sameWindow = row && now >= row.window_start && now - row.window_start < 60_000;
        if (sameWindow && row.attempts >= 12) return Math.max(1, Math.ceil((60_000 - now + row.window_start) / 1000));
        sql.run('INSERT OR REPLACE INTO workspace_login_limit VALUES (1, ?, ?)', sameWindow ? row.window_start : now, sameWindow ? row.attempts + 1 : 1);
        sql.run('DELETE FROM workspace_revoked_sessions WHERE expires <= ?', now);
        return 0;
      });
    },
    revokeSession(id, expires, now) {
      sql.transaction(() => { sql.run('DELETE FROM workspace_revoked_sessions WHERE expires <= ?', now); sql.run('INSERT OR REPLACE INTO workspace_revoked_sessions VALUES (?, ?)', id, expires); });
    },
    sessionRevoked(id) { return sql.rows('SELECT id FROM workspace_revoked_sessions WHERE id=?', id).length !== 0; },
  };
}
