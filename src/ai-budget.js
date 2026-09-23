// One persistent object protects the demo's one shared API budget across Worker instances.
// The deployment adapter wraps this testable storage class in Cloudflare's DurableObject base.
export const AI_BUDGET_LIMITS = Object.freeze({ total: 100, perMinute: 10, concurrent: 2, leaseMs: 65_000 });

export class AIBudgetState {
  constructor(ctx, { now = Date.now } = {}) {
    this.storage = ctx.storage;
    this.now = now;
    // Synchronous setup finishes before this instance can handle its first RPC.
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ai_budget_attempts (
      lease_id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      released INTEGER NOT NULL DEFAULT 0 CHECK (released IN (0, 1))
    )`);
  }

  acquire() {
    // No await or external I/O: admission and persistence commit as one SQLite transaction.
    // Records are deliberately never deleted; even failed provider attempts count toward 100.
    return this.storage.transactionSync(() => {
      const time = this.now();
      const sql = this.storage.sql;
      const { total } = sql.exec('SELECT COUNT(*) AS total FROM ai_budget_attempts').one();
      if (total >= AI_BUDGET_LIMITS.total) return { allowed: false, reason: 'server_request_limit' };

      const active = sql.exec(`SELECT COUNT(*) AS count, MIN(expires_at) AS earliest
        FROM ai_budget_attempts WHERE released = 0 AND expires_at > ?`, time).one();
      if (active.count >= AI_BUDGET_LIMITS.concurrent) {
        return { allowed: false, reason: 'server_busy',
          retryAfter: Math.max(1, Math.ceil((active.earliest - time) / 1000)) };
      }
      const recent = sql.exec(`SELECT COUNT(*) AS count, MIN(started_at) AS earliest
        FROM ai_budget_attempts WHERE started_at > ?`, time - 60_000).one();
      if (recent.count >= AI_BUDGET_LIMITS.perMinute) {
        return { allowed: false, reason: 'server_rate_limited',
          retryAfter: Math.max(1, Math.ceil((recent.earliest + 60_000 - time) / 1000)) };
      }

      const leaseId = crypto.randomUUID();
      sql.exec('INSERT INTO ai_budget_attempts (lease_id, started_at, expires_at) VALUES (?, ?, ?)',
        leaseId, time, time + AI_BUDGET_LIMITS.leaseMs);
      return { allowed: true, leaseId };
    });
  }

  release(leaseId) {
    if (typeof leaseId !== 'string' || leaseId.length > 128) return { released: false };
    // Updating a lease never refunds its durable request count or its rolling-minute count.
    const updated = this.storage.sql.exec(`UPDATE ai_budget_attempts SET released = 1
      WHERE lease_id = ? AND released = 0 RETURNING lease_id`, leaseId).toArray();
    return { released: updated.length === 1 };
  }
}
