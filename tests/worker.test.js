import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../src/worker.js';

const scenario = { decisions: [
  { measureId: 'M7', districtId: 'nura' }, { measureId: 'M8', districtId: 'nura' },
  { measureId: 'M10', districtId: 'nura' }, { measureId: 'M12' },
  { measureId: 'M5', districtId: 'saryarka' },
] };
const req = (path, body, headers = {}) => new Request(`https://example.test${path}`, body === undefined
  ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const env = (overrides = {}) => ({
  ASSETS: { fetch: async () => new Response('asset', { status: 200 }) },
  AI_RATE_LIMITER: { limit: async () => ({ success: true }) },
  AI_BUDGET: { getByName: () => ({
    acquire: async () => ({ allowed: true, leaseId: 'test-lease' }), release: async () => {},
  }) },
  ...overrides,
});

test('Worker serves the same official calculation with no provider key', async () => {
  const worker = createWorker();
  const health = await worker.fetch(req('/api/health'), env());
  assert.deepEqual(await health.json(), { ok: true, aiConfigured: false });
  const response = await worker.fetch(req('/api/simulate', scenario), env());
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.valid, true);
  assert.equal(result.totalCost, 95);
  assert.ok(Math.abs(result.score - 56.54307) < 1e-8);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('Worker rejects invalid routes, methods, media types, JSON and oversized bodies', async () => {
  const worker = createWorker();
  for (const [request, status] of [
    [req('/api/missing'), 404], [req('/.env.local'), 404],
    [req('/api/simulate'), 405], [req('/api/health', {}), 405],
    [req('/api/simulate', scenario, { 'Content-Type': 'text/plain' }), 415],
    [req('/api/simulate', { text: 'x'.repeat(33 * 1024) }), 413],
    [new Request('https://example.test/api/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }), 400],
  ]) assert.equal((await worker.fetch(request, env())).status, status);
  assert.equal((await worker.fetch(req('/api/simulate', { decisions: [] }), env())).status, 422);
});

test('AI key remains server-side, API options skip expensive replacement search', async () => {
  const calls = [];
  const worker = createWorker({ explain: async (_scenario, _result, options) => {
    calls.push(options);
    return { mode: options.apiKey ? 'ai' : 'deterministic', available: Boolean(options.apiKey) };
  } });
  const response = await worker.fetch(req('/api/explain', scenario), env({ OPENAI_API_KEY: 'test-server-key' }));
  assert.deepEqual(await response.json(), { mode: 'ai', available: true });
  assert.equal(calls[0].apiKey, 'test-server-key');
  assert.equal(calls[0].skipReplacementSearch, true);
});

test('missing or rejecting platform rate binding blocks paid calls and gives fallback', async () => {
  for (const binding of [undefined, { limit: async () => ({ success: false }) }, { limit: async () => { throw new Error('offline'); } }]) {
    const worker = createWorker({ explain: async (_scenario, _result, options) => {
      assert.equal(options.apiKey, '');
      return { mode: 'deterministic', available: false };
    } });
    const response = await worker.fetch(req('/api/explain', scenario), env({ OPENAI_API_KEY: 'test-key', AI_RATE_LIMITER: binding }));
    assert.equal((await response.json()).reason, 'server_rate_limited');
  }
});

test('concurrent rate-binding checks cannot race through the local paid-call cap', async () => {
  let calls = 0;
  let finishProvider;
  const providerWait = new Promise(resolve => { finishProvider = resolve; });
  const worker = createWorker({ explain: async (_scenario, _result, options) => {
    if (options.apiKey) { calls++; await providerWait; }
    return { mode: options.apiKey ? 'ai' : 'deterministic' };
  } });
  const runtime = env({ OPENAI_API_KEY: 'test-key', AI_MAX_CONCURRENT: '1' });
  const first = worker.fetch(req('/api/explain', scenario), runtime);
  const second = worker.fetch(req('/api/explain', scenario), runtime);
  // Let both requests reach the asynchronous rate binding without serializing dispatch.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  finishProvider();
  const results = await Promise.all([first, second]);
  const bodies = await Promise.all(results.map(result => result.json()));
  assert.equal(bodies.filter(body => body.mode === 'ai').length, 1);
  assert.equal(bodies.filter(body => body.reason === 'server_busy').length, 1);
});

test('local total dispatch limit survives across requests in the same isolate', async () => {
  let calls = 0;
  const worker = createWorker({ explain: async (_scenario, _result, options) => {
    if (options.apiKey) calls++;
    return { mode: options.apiKey ? 'ai' : 'deterministic' };
  } });
  const runtime = env({ OPENAI_API_KEY: 'test-key', AI_MAX_REQUESTS: '1' });
  await worker.fetch(req('/api/explain', scenario), runtime);
  const response = await worker.fetch(req('/api/explain', scenario), runtime);
  assert.equal(calls, 1);
  assert.equal((await response.json()).reason, 'server_request_limit');
});

test('persistent budget denial and storage failure never dispatch a paid request', async () => {
  for (const binding of [undefined,
    { getByName: () => ({ acquire: async () => ({ allowed: false, reason: 'server_request_limit' }) }) },
    { getByName: () => ({ acquire: async () => { throw new Error('storage unavailable'); } }) },
  ]) {
    const worker = createWorker({ explain: async (_scenario, _result, options) => {
      assert.equal(options.apiKey, '');
      return { mode: 'deterministic', available: false };
    } });
    const response = await worker.fetch(req('/api/explain', scenario), env({ OPENAI_API_KEY: 'test-key', AI_BUDGET: binding }));
    const body = await response.json();
    assert.equal(body.mode, 'deterministic');
    assert.ok(['server_request_limit', 'budget_guard_unavailable'].includes(body.reason));
    if (body.reason === 'server_request_limit') assert.equal(response.headers.get('Retry-After'), null);
  }
});

test('durable concurrency lease is released even when provider explanation fails', async () => {
  let released;
  const worker = createWorker({ explain: async () => { throw new Error('transport error'); } });
  const runtime = env({ OPENAI_API_KEY: 'test-key', AI_BUDGET: { getByName: name => {
    assert.equal(name, 'global');
    return { acquire: async () => ({ allowed: true, leaseId: 'lease-to-release' }),
      release: async id => { released = id; } };
  } } });
  assert.equal((await worker.fetch(req('/api/explain', scenario), runtime)).status, 500);
  assert.equal(released, 'lease-to-release');
});
