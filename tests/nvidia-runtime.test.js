import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createAppServer } from '../src/server.js';
import { createWorker } from '../src/worker.js';

const scenario = { decisions: [
  { measureId: 'M7', districtId: 'nura' }, { measureId: 'M8', districtId: 'nura' },
  { measureId: 'M10', districtId: 'nura' }, { measureId: 'M12' },
  { measureId: 'M5', districtId: 'saryarka' },
] };

async function client(t, runtime, patch = {}) {
  const calls = [];
  const env = { AI_PROVIDER: 'nvidia', NVIDIA_API_KEY: 'synthetic-nvidia-key',
    OPENAI_API_KEY: 'synthetic-unselected-key', AI_MAX_REQUESTS: '2',
    AI_RATE_LIMITER: { limit: async () => ({ success: true }) },
    AI_BUDGET: { getByName: () => ({ acquire: async () => ({ allowed: true, leaseId: 'test-lease' }),
      release: async () => {} }) }, ...patch };
  const dependencies = {
    plan: async (input, options) => {
      calls.push({ type: 'plan', options });
      return { mode: 'ai', available: true, provider: options.provider, model: options.model };
    },
    explain: async (input, result, options) => {
      assert.equal(result.totalCost, 95);
      assert.ok(Math.abs(result.score - 56.54307) < 1e-8);
      if (options.apiKey) calls.push({ type: 'explain', options });
      return { mode: options.apiKey ? 'ai' : 'deterministic', available: Boolean(options.apiKey),
        ...(options.apiKey ? { provider: options.provider, model: options.model } : {}) };
    },
  };
  let base;
  let request;
  if (runtime === 'Node') {
    const server = createAppServer({ env, ...dependencies });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    });
    base = `http://127.0.0.1:${server.address().port}`;
    request = (path, init) => fetch(base + path, init);
  } else {
    const worker = createWorker(dependencies);
    base = 'https://nvidia-runtime.example';
    request = (path, init) => worker.fetch(new Request(base + path, init), env);
  }
  return { calls, async json(path, body) {
    const response = await request(path, body ? { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) } : {});
    const text = await response.text();
    assert.ok(!text.includes('synthetic-nvidia-key') && !text.includes('synthetic-unselected-key'));
    return { status: response.status, body: JSON.parse(text) };
  } };
}

for (const runtime of ['Node', 'Worker']) {
  test(`${runtime}: Cloudflare NVIDIA binding is selected without any API key and stripped on denial`, async t => {
    let bindingCalls = 0;
    const app = await client(t, runtime, { AI_PROVIDER: 'nvidia-cloudflare', NVIDIA_API_KEY: '', OPENAI_API_KEY: '',
      AI_MAX_REQUESTS: '1', AI: { run: async () => { bindingCalls++; throw new Error('Denied binding must never be called'); } } });
    assert.equal((await app.json('/api/health')).body.aiConfigured, true);
    assert.equal((await app.json('/api/plan', { prompt: 'Школа в Нуре' })).body.provider, 'nvidia');
    assert.equal(app.calls[0].options.backend, 'cloudflare');
    assert.equal(app.calls[0].options.apiKey, '');
    const denied = await app.json('/api/plan', { prompt: 'Парк' });
    assert.equal(denied.body.available, false);
    assert.equal(denied.body.reason, 'server_request_limit');
    assert.equal(bindingCalls, 0);
  });

  test(`${runtime}: NVIDIA-only configuration serves both AI operations under the shared budget`, async t => {
    const app = await client(t, runtime, { OPENAI_API_KEY: '' });
    assert.deepEqual((await app.json('/api/health')).body, { ok: true, aiConfigured: true });
    assert.equal((await app.json('/api/plan', { prompt: 'Школа в Нуре' })).body.provider, 'nvidia');
    assert.equal((await app.json('/api/explain', scenario)).body.provider, 'nvidia');
    assert.deepEqual(app.calls.map(call => call.type), ['plan', 'explain']);
    for (const { options } of app.calls) {
      assert.equal(options.apiKey, 'synthetic-nvidia-key');
      assert.equal(options.provider, 'nvidia');
      assert.match(options.model, /^nvidia\//);
    }
    const denied = await app.json('/api/plan', { prompt: 'Парк в Сарыарке' });
    assert.equal(denied.body.available, false);
    assert.equal(denied.body.reason, 'server_request_limit');
    assert.equal(app.calls.length, 2);
  });

  test(`${runtime}: missing NVIDIA key cannot spend the existing OpenAI key`, async t => {
    const app = await client(t, runtime, { NVIDIA_API_KEY: '' });
    assert.equal((await app.json('/api/health')).body.aiConfigured, false);
    const result = await app.json('/api/plan', { prompt: 'Школа в Нуре' });
    assert.equal(result.body.available, false);
    assert.equal(app.calls.length, 0);
    assert.equal((await app.json('/api/explain', scenario)).body.mode, 'deterministic');
    assert.equal(app.calls.length, 0);
  });

  test(`${runtime}: over-budget scenario is rejected before a NVIDIA call`, async t => {
    const app = await client(t, runtime);
    const invalid = structuredClone(scenario);
    invalid.decisions[2] = { measureId: 'M2' };
    const result = await app.json('/api/explain', invalid);
    assert.equal(result.status, 422);
    assert.equal(result.body.score, undefined);
    assert.ok(result.body.errors.some(error => error.code === 'BUDGET_EXCEEDED'));
    assert.equal(app.calls.length, 0);
  });
}
