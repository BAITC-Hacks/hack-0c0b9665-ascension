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

test('Worker rejects cross-origin explanations before touching paid-call guards', async () => {
  let calls = 0;
  const worker = createWorker({ explain: async () => { calls++; return {}; } });
  const runtime = env({ OPENAI_API_KEY: 'test-key',
    AI_RATE_LIMITER: { limit: async () => { calls++; return { success: true }; } } });
  for (const headers of [{ Origin: 'https://untrusted.test' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const response = await worker.fetch(req('/api/explain', scenario, headers), runtime);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).errors[0].code, 'CROSS_ORIGIN_REQUEST');
  }
  assert.equal(calls, 0);
  assert.equal((await worker.fetch(req('/api/explain', { decisions: [] }), runtime)).status, 422);
  assert.equal(calls, 0);
  assert.equal((await worker.fetch(req('/api/explain', scenario,
    { Origin: 'https://example.test' }), runtime)).status, 200);
  assert.equal(calls, 2);
});

test('Worker rejects invalid UTF-8 instead of silently replacing malformed bytes', async () => {
  const prefix = new TextEncoder().encode('{"decisions":[],"note":"');
  const suffix = new TextEncoder().encode('"}');
  const body = new Uint8Array([...prefix, 0xc3, 0x28, ...suffix]);
  const response = await createWorker().fetch(new Request('https://example.test/api/validate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  }), env());
  assert.equal(response.status, 400);
  assert.equal((await response.json()).errors[0].code, 'INVALID_JSON');
});

test('stream overflow cancels consumption and preserves 413 when cancellation fails', async () => {
  let cancelled = 0;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(32 * 1024 + 1)); },
    cancel() { cancelled++; throw new Error('source cancellation failed'); },
  });
  const request = new Request('https://example.test/api/simulate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body, duplex: 'half',
  });
  const response = await createWorker().fetch(request, env());
  assert.equal(response.status, 413);
  assert.equal((await response.json()).errors[0].code, 'BODY_TOO_LARGE');
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});

test('a failed request stream returns a safe body error and releases its lock', async () => {
  const body = new ReadableStream({
    pull(controller) { controller.error(new Error('internal source detail')); },
  });
  const request = new Request('https://example.test/api/simulate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body, duplex: 'half',
  });
  const response = await createWorker().fetch(request, env());
  assert.equal(response.status, 400);
  const result = await response.json();
  assert.equal(result.errors[0].code, 'INVALID_BODY');
  assert.doesNotMatch(JSON.stringify(result), /internal source detail/);
  assert.equal(body.locked, false);
});

test('malformed platform permissions cannot dispatch a paid explanation', async () => {
  for (const overrides of [
    { AI_RATE_LIMITER: { limit: async () => ({ success: 'true' }) } },
    ...[undefined, {}, { allowed: 'true', leaseId: 'lease' },
      { allowed: true, leaseId: '', reason: '' }, { allowed: true, leaseId: '   ' }]
      .map(permit => ({ AI_BUDGET: { getByName: () => ({ acquire: async () => permit }) } })),
  ]) {
    const worker = createWorker({ explain: async (_scenario, _result, options) => {
      assert.equal(options.apiKey, '');
      return { mode: 'deterministic' };
    } });
    const response = await worker.fetch(req('/api/explain', scenario),
      env({ OPENAI_API_KEY: 'test-key', ...overrides }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).mode, 'deterministic');
  }
});

test('durable release failure does not retry the provider or leak the local permit', async () => {
  let providerCalls = 0;
  let releaseCalls = 0;
  const worker = createWorker({ explain: async (_scenario, _result, options) => {
    assert.equal(options.apiKey, 'test-key');
    providerCalls++;
    return { mode: 'ai' };
  } });
  const runtime = env({ OPENAI_API_KEY: 'test-key', AI_MAX_CONCURRENT: '1',
    AI_BUDGET: { getByName: () => ({
      acquire: async () => ({ allowed: true, leaseId: 'lease' }),
      release: async () => { releaseCalls++; throw new Error('storage unavailable'); },
    }) } });
  for (let index = 0; index < 2; index++) {
    const response = await worker.fetch(req('/api/explain', scenario), runtime);
    assert.equal((await response.json()).mode, 'ai');
  }
  assert.equal(providerCalls, 2);
  assert.equal(releaseCalls, 2);
});

test('Worker retains durable retry guidance and local minute limits across requests', async () => {
  let time = 0;
  const worker = createWorker({ now: () => time,
    explain: async (_scenario, _result, options) => ({ mode: options.apiKey ? 'ai' : 'deterministic' }) });
  const runtime = env({ OPENAI_API_KEY: 'test-key', AI_REQUESTS_PER_MINUTE: '1' });
  await worker.fetch(req('/api/explain', scenario), runtime);
  time = 59_000;
  const limited = await worker.fetch(req('/api/explain', scenario), runtime);
  assert.equal((await limited.json()).reason, 'server_rate_limited');
  assert.equal(limited.headers.get('Retry-After'), '1');
  time = 60_000;
  assert.equal((await (await worker.fetch(req('/api/explain', scenario), runtime)).json()).mode, 'ai');

  const denied = await createWorker().fetch(req('/api/explain', scenario), env({
    OPENAI_API_KEY: 'test-key', AI_BUDGET: { getByName: () => ({
      acquire: async () => ({ allowed: false, reason: 'server_busy', retryAfter: 17 }),
    }) },
  }));
  assert.equal(denied.headers.get('Retry-After'), '17');
  assert.equal((await denied.json()).reason, 'server_busy');
});

test('Worker preserves asset metadata, adds security headers, and omits HEAD bodies', async () => {
  const worker = createWorker();
  const runtime = env({ ASSETS: { fetch: async () => new Response('asset', {
    headers: { ETag: 'asset-v1', 'Content-Security-Policy': 'unsafe-value' },
  }) } });
  for (const method of ['GET', 'HEAD']) {
    const response = await worker.fetch(new Request('https://example.test/index.html', { method }), runtime);
    assert.equal(await response.text(), method === 'HEAD' ? '' : 'asset');
    assert.equal(response.headers.get('ETag'), 'asset-v1');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.match(response.headers.get('Content-Security-Policy'), /worker-src 'self' blob:/);
  }
  const rejected = await worker.fetch(new Request('https://example.test/index.html', { method: 'DELETE' }), runtime);
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get('Allow'), 'GET, HEAD');
});
