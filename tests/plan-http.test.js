import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createAppServer } from '../src/server.js';
import { createWorker } from '../src/worker.js';

const KEY = 'synthetic-plan-http-key';
const prompt = { prompt: 'Построй школу в Нуре.' };
const scenario = { decisions: [
  { measureId: 'M7', districtId: 'nura' }, { measureId: 'M8', districtId: 'nura' },
  { measureId: 'M10', districtId: 'nura' }, { measureId: 'M12' },
  { measureId: 'M5', districtId: 'saryarka' },
] };
const draft = { mode: 'ai', available: true, valid: false, summary: 'Проверяемый черновик.',
  decisions: [{ measureId: 'M7', districtId: 'nura' }], decisionOrigins: [], unsupported: [], assumptions: [],
  validation: { valid: false, errors: [{ code: 'DECISION_COUNT', message: 'Дополните план.' }], totalCost: 25 } };
const explanation = { mode: 'ai', available: true, summary: 'Объяснение проверенного сценария.',
  strengths: [], risks: [], recommendations: [] };

async function start(t, kind, options = {}) {
  const observed = { plans: [], explanations: [], platform: 0, acquired: 0, released: [] };
  const env = {
    OPENAI_API_KEY: '', AI_MAX_REQUESTS: '10', AI_REQUESTS_PER_MINUTE: '10', AI_MAX_CONCURRENT: '2',
    AI_RATE_LIMITER: { limit: async () => { observed.platform++; return { success: true }; } },
    AI_BUDGET: { getByName: name => {
      assert.equal(name, 'global');
      return {
        acquire: async () => { observed.acquired++; return { allowed: true, leaseId: `lease-${observed.acquired}` }; },
        release: async id => { observed.released.push(id); },
      };
    } },
    ...options.env,
  };
  const dependencies = {
    now: options.now ?? (() => 100_000),
    plan: async (input, providerOptions) => {
      observed.plans.push({ input, options: providerOptions });
      return options.plan ? options.plan(input, providerOptions) : structuredClone(draft);
    },
    explain: async (input, result, providerOptions) => {
      observed.explanations.push({ input, result, options: providerOptions });
      if (options.explain) return options.explain(input, result, providerOptions);
      return { ...structuredClone(explanation),
        mode: providerOptions?.apiKey ? 'ai' : 'deterministic', available: Boolean(providerOptions?.apiKey) };
    },
  };
  let origin;
  let dispatch;
  if (kind === 'Node') {
    const server = createAppServer({ ...dependencies, env, aiLimits: options.aiLimits });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    dispatch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
  } else {
    const worker = createWorker(dependencies);
    origin = 'https://plan-contract.example';
    dispatch = (url, init) => worker.fetch(new Request(url, init), env);
  }
  return { observed, origin, async request(path, { method = 'GET', headers = {}, body } = {}) {
    const response = await dispatch(origin + path, { method, headers, ...(body === undefined ? {} : { body }) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: JSON.parse(text) };
  } };
}

const post = (client, path, value, headers = {}) => client.request(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value),
});
const paidCalls = client => [...client.observed.plans, ...client.observed.explanations]
  .filter(call => Boolean(call.options?.apiKey));
function error(response, status, code) {
  assert.equal(response.status, status, response.text);
  assert.equal(response.body.valid, false);
  assert.ok(response.body.errors.some(item => item.code === code), response.text);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}
function unavailable(response, reason) {
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.mode, 'unavailable');
  assert.equal(response.body.available, false);
  assert.equal(response.body.valid, false);
  assert.equal(response.body.result, undefined);
  assert.deepEqual(response.body.decisions, []);
  assert.ok(response.body.summary.trim());
  if (reason) assert.equal(response.body.reason, reason);
  assert.doesNotMatch(response.text, new RegExp(KEY));
}

for (const kind of ['Node', 'Worker']) {
  test(`${kind}: plan rejects invalid prompt fields before provider admission`, async t => {
    const client = await start(t, kind, { env: { OPENAI_API_KEY: KEY, AI_MAX_REQUESTS: '1' } });
    for (const input of [null, [], {}, { prompt: '' }, { prompt: '  ' }, { prompt: 42 },
      { prompt: 'a'.repeat(4001) }, { ...prompt, model: 'client-model' }, { ...prompt, apiKey: 'client-key' }]) {
      error(await post(client, '/api/plan', input), 400, 'INVALID_PROMPT');
    }
    assert.equal(client.observed.plans.length, 0);
    assert.equal(client.observed.platform, 0);
    assert.equal(client.observed.acquired, 0);
    const accepted = await post(client, '/api/plan', prompt);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.available, true);
    assert.equal(accepted.body.valid, false, 'an incomplete generated draft is still a successful translation');
    assert.equal(accepted.body.result, undefined);
    assert.equal(paidCalls(client).length, 1);
    assert.deepEqual(client.observed.plans[0].input, prompt);
    assert.equal(client.observed.plans[0].options.apiKey, KEY);
    assert.doesNotMatch(accepted.text, new RegExp(KEY));
  });

  test(`${kind}: plan and trajectory enforce HTTP boundaries before any provider call`, async t => {
    const client = await start(t, kind, { env: { OPENAI_API_KEY: KEY } });
    for (const [path, input] of [['/api/plan', prompt], ['/api/trajectory', scenario]]) {
      const wrongMethod = await client.request(path);
      error(wrongMethod, 405, 'METHOD_NOT_ALLOWED');
      assert.equal(wrongMethod.headers.get('allow'), 'POST');
      error(await post(client, path, input, { Origin: 'https://untrusted.example' }), 403, 'CROSS_ORIGIN_REQUEST');
      error(await post(client, path, input, { 'Sec-Fetch-Site': 'cross-site' }), 403, 'CROSS_ORIGIN_REQUEST');
      error(await post(client, path, input, { 'Content-Type': 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
      error(await client.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: ' '.repeat(32 * 1024 + 1) }), 413, 'BODY_TOO_LARGE');
    }
    assert.equal(client.observed.plans.length, 0);
    assert.equal(client.observed.explanations.length, 0);
    assert.equal(client.observed.platform, 0);
    assert.equal(client.observed.acquired, 0);
  });

  test(`${kind}: keyless planning is honestly unavailable and never invokes the injected provider`, async t => {
    const client = await start(t, kind);
    unavailable(await post(client, '/api/plan', prompt));
    assert.equal(client.observed.plans.length, 0);
    assert.equal(client.observed.platform, 0);
    assert.equal(client.observed.acquired, 0);
  });

  test(`${kind}: plan and explanation spend one shared total allowance in either order`, async t => {
    for (const firstPath of ['/api/plan', '/api/explain']) {
      const client = await start(t, kind, { env: { OPENAI_API_KEY: KEY, AI_MAX_REQUESTS: '1' } });
      const secondPath = firstPath === '/api/plan' ? '/api/explain' : '/api/plan';
      const first = await post(client, firstPath, firstPath === '/api/plan' ? prompt : scenario);
      assert.equal(first.status, 200);
      assert.equal(first.body.available, true);
      const denied = await post(client, secondPath, secondPath === '/api/plan' ? prompt : scenario);
      assert.equal(denied.status, 200);
      assert.equal(denied.body.available, false);
      assert.equal(denied.body.reason, 'server_request_limit');
      assert.equal(denied.headers.get('retry-after'), null, 'a total lifetime cap has no timed retry');
      if (secondPath === '/api/plan') unavailable(denied, 'server_request_limit');
      assert.equal(paidCalls(client).length, 1);
      if (kind === 'Worker') {
        assert.equal(client.observed.acquired, 1);
        assert.deepEqual(client.observed.released, ['lease-1']);
      }
    }
  });

  test(`${kind}: an active plan occupies explanation concurrency and releases the permit`, async t => {
    const entered = Promise.withResolvers();
    const finish = Promise.withResolvers();
    const client = await start(t, kind, { env: { OPENAI_API_KEY: KEY, AI_MAX_CONCURRENT: '1' },
      plan: async () => { entered.resolve(); await finish.promise; return structuredClone(draft); } });
    const first = post(client, '/api/plan', prompt);
    try {
      await Promise.race([entered.promise, first.then(() => { throw new Error('Plan provider was never entered'); })]);
      const denied = await post(client, '/api/explain', scenario);
      assert.equal(denied.status, 200);
      assert.equal(denied.body.available, false);
      assert.equal(denied.body.reason, 'server_busy');
      assert.equal(denied.headers.get('retry-after'), '5');
      assert.equal(paidCalls(client).length, 1);
    } finally { finish.resolve(); }
    assert.equal((await first).status, 200);
    const later = await post(client, '/api/explain', scenario);
    assert.equal(later.body.available, true);
    assert.equal(paidCalls(client).length, 2);
    assert.equal(client.observed.explanations.at(-1).result.totalCost, 95);
    if (kind === 'Worker') assert.deepEqual(client.observed.released, ['lease-1', 'lease-2']);
  });

  test(`${kind}: trajectory preserves official anchors and never enters AI admission`, async t => {
    const client = await start(t, kind, { env: { OPENAI_API_KEY: KEY, AI_MAX_REQUESTS: '0' } });
    const response = await post(client, '/api/trajectory', scenario);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.valid, true);
    assert.equal(response.body.synthetic, true);
    assert.equal(response.body.totalCost, 95);
    assert.ok(Math.abs(response.body.score - 56.54307) < 1e-8);
    assert.deepEqual(response.body.frames.map(frame => frame.quarter), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.ok(Math.abs(response.body.frames[0].score - 52.55768) < 1e-8);
    assert.ok(Math.abs(response.body.frames[8].score - 56.54307) < 1e-8);
    for (const [input, code] of [[{ decisions: [] }, 'DECISION_COUNT'], [{ ...scenario, horizon: 99 }, 'UNKNOWN_FIELD']]) {
      const rejected = await post(client, '/api/trajectory', input);
      error(rejected, 422, code);
      assert.equal(rejected.body.frames, undefined);
      assert.equal(rejected.body.score, undefined);
    }
    assert.equal(client.observed.plans.length, 0);
    assert.equal(client.observed.explanations.length, 0);
    assert.equal(client.observed.platform, 0);
    assert.equal(client.observed.acquired, 0);
  });
}

test('Worker: missing platform or durable guards fail closed for planning', async t => {
  for (const env of [{ AI_RATE_LIMITER: undefined }, { AI_BUDGET: undefined },
    { AI_BUDGET: { getByName: () => ({ acquire: async () => { throw new Error('private-storage-details'); } }) } }]) {
    const client = await start(t, 'Worker', { env: { OPENAI_API_KEY: KEY, ...env } });
    const response = await post(client, '/api/plan', prompt);
    unavailable(response);
    assert.ok(['server_rate_limited', 'budget_guard_unavailable'].includes(response.body.reason));
    assert.equal(client.observed.plans.length, 0);
    assert.deepEqual(client.observed.released, []);
    assert.doesNotMatch(response.text, /private-storage-details/);
  }
});

test('Worker: a throwing plan provider releases its durable lease exactly once', async t => {
  const client = await start(t, 'Worker', { env: { OPENAI_API_KEY: KEY, AI_MAX_CONCURRENT: '1' },
    plan: async () => { throw new Error(`private provider failure ${KEY}`); } });
  const failed = await post(client, '/api/plan', prompt);
  error(failed, 500, 'INTERNAL_ERROR');
  assert.doesNotMatch(failed.text, /private provider failure|synthetic-plan-http-key/);
  assert.deepEqual(client.observed.released, ['lease-1']);
  assert.equal((await post(client, '/api/explain', scenario)).body.available, true);
  assert.deepEqual(client.observed.released, ['lease-1', 'lease-2']);
});
