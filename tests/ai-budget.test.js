import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIBudgetState, AI_BUDGET_LIMITS } from '../src/ai-budget.js';

// Exercise real SQLite queries with a small adapter for Cloudflare's synchronous storage API.
function createStorage(path = ':memory:') {
  const database = new DatabaseSync(path);
  return {
    database,
    storage: {
      sql: {
        exec(query, ...parameters) {
          const rows = database.prepare(query).all(...parameters).map(row => ({ ...row }));
          return {
            one() { assert.equal(rows.length, 1); return rows[0]; },
            toArray() { return rows; },
          };
        },
      },
      transactionSync(callback) {
        database.exec('BEGIN');
        try {
          const result = callback();
          assert.equal(typeof result?.then, 'undefined', 'SQLite transaction must stay synchronous');
          database.exec('COMMIT');
          return result;
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      },
    },
  };
}

function setup(t) {
  const ctx = createStorage();
  t.after(() => ctx.database.close());
  let time = 100_000;
  const budget = new AIBudgetState(ctx, { now: () => time });
  return { ctx, budget, advance: milliseconds => { time += milliseconds; } };
}

test('persistent budget admits only two concurrent acquisitions and release is idempotent', async t => {
  const { budget, ctx } = setup(t);
  const responses = await Promise.all(Array.from({ length: 20 }, () => Promise.resolve().then(() => budget.acquire())));
  const allowed = responses.filter(result => result.allowed);
  assert.equal(allowed.length, 2);
  assert.notEqual(allowed[0].leaseId, allowed[1].leaseId);
  for (const denied of responses.filter(result => !result.allowed)) {
    assert.equal(denied.reason, 'server_busy');
    assert.equal(denied.retryAfter, 65);
  }
  assert.deepEqual(budget.release(allowed[0].leaseId), { released: true });
  assert.deepEqual(budget.release(allowed[0].leaseId), { released: false });
  assert.deepEqual(budget.release('unknown'), { released: false });
  assert.deepEqual(budget.release({}), { released: false });
  assert.equal(budget.acquire().allowed, true);
  assert.equal(budget.acquire().reason, 'server_busy');
  assert.equal(ctx.storage.sql.exec('SELECT COUNT(*) AS total FROM ai_budget_attempts').one().total, 3);
});

test('released calls still consume ten-per-minute allowance, which expires on the exact boundary', t => {
  const { budget, advance } = setup(t);
  for (let index = 0; index < 10; index++) {
    const permit = budget.acquire();
    assert.equal(permit.allowed, true);
    budget.release(permit.leaseId);
  }
  assert.deepEqual(budget.acquire(), { allowed: false, reason: 'server_rate_limited', retryAfter: 60 });
  advance(59_999);
  assert.deepEqual(budget.acquire(), { allowed: false, reason: 'server_rate_limited', retryAfter: 1 });
  advance(1);
  assert.equal(budget.acquire().allowed, true);
});

test('interrupted callers cannot leak concurrency slots past the 65-second lease', t => {
  const { budget, advance, ctx } = setup(t);
  const first = budget.acquire();
  budget.acquire();
  advance(AI_BUDGET_LIMITS.leaseMs - 1);
  assert.deepEqual(budget.acquire(), { allowed: false, reason: 'server_busy', retryAfter: 1 });
  advance(1);
  const restarted = new AIBudgetState(ctx, { now: () => 100_000 + AI_BUDGET_LIMITS.leaseMs });
  assert.equal(restarted.acquire().allowed, true);
  assert.equal(restarted.acquire().allowed, true);
  assert.deepEqual(restarted.release(first.leaseId), { released: true });
  assert.equal(restarted.acquire().reason, 'server_busy', 'Releasing an expired lease must not free a newer one');
  assert.equal(ctx.storage.sql.exec('SELECT COUNT(*) AS total FROM ai_budget_attempts').one().total, 4);
});

test('100 total attempts remain exhausted after closing and reopening the SQLite database', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ascension-ai-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'budget.sqlite');
  let ctx = createStorage(path);
  let time = 100_000;
  let budget = new AIBudgetState(ctx, { now: () => time });
  try {
    for (let index = 0; index < AI_BUDGET_LIMITS.total; index++) {
      const permit = budget.acquire();
      assert.equal(permit.allowed, true, `attempt ${index + 1}`);
      budget.release(permit.leaseId);
      time += 60_000;
      if (index === 49) {
        ctx.database.close();
        ctx = createStorage(path);
        budget = new AIBudgetState(ctx, { now: () => time });
      }
    }
    const expected = { allowed: false, reason: 'server_request_limit' };
    assert.deepEqual(budget.acquire(), expected);
    ctx.database.close();
    ctx = createStorage(path);
    budget = new AIBudgetState(ctx, { now: () => time + 86_400_000 });
    assert.deepEqual(budget.acquire(), expected);
    assert.equal(ctx.storage.sql.exec('SELECT COUNT(*) AS total FROM ai_budget_attempts').one().total, 100);
  } finally {
    ctx.database.close();
  }
});

test('storage failure never returns an allowed lease or creates an uncounted admission', t => {
  const { budget, ctx } = setup(t);
  const execute = ctx.storage.sql.exec;
  ctx.storage.sql.exec = (query, ...parameters) => {
    if (query.startsWith('INSERT INTO')) throw new Error('Injected storage failure');
    return execute(query, ...parameters);
  };
  assert.throws(() => budget.acquire(), /Injected storage failure/);
  ctx.storage.sql.exec = execute;
  assert.equal(ctx.storage.sql.exec('SELECT COUNT(*) AS total FROM ai_budget_attempts').one().total, 0);
  assert.equal(budget.acquire().allowed, true);
});
