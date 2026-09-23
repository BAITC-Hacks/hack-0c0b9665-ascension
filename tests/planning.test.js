import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanning } from '../src/runtime/planning.js';
import { MAX_PLAN_PROMPT_CHARS } from '../src/ai/plan.js';
import { createNodeAIAdmission, createWorkerAIAdmission } from '../src/runtime/ai-admission.js';
import { RequestError } from '../src/http/errors.js';

const input = { prompt: 'Добавь школу и освещение в Нуре.' };

function assertUnavailable(body, reason) {
  assert.equal(body.mode, 'unavailable');
  assert.equal(body.available, false);
  assert.equal(body.reason, reason);
  assert.equal(body.valid, false);
  assert.equal(Object.hasOwn(body, 'result'), false);
  assert.deepEqual(body.decisions, []);
  assert.deepEqual(body.decisionOrigins, []);
  assert.equal(body.validation.valid, false);
  assert.equal(body.validation.errors[0].code, 'AI_UNAVAILABLE');
  assert.equal(body.validation.errors[0].message, body.summary);
  assert.match(body.summary, /[А-Яа-я]/u);
}

test('invalid prompt shapes and client provider fields are rejected before admission', async () => {
  let calls = 0;
  const plan = createPlanning({ admission: () => { calls++; throw new Error('must not run'); } });
  const hiddenProvider = Object.defineProperty({ ...input }, 'apiKey', { value: 'client-key' });
  const inheritedPrompt = Object.create(input);
  const invalid = [null, undefined, false, 123, 'prompt', [], {}, { prompt: null }, { prompt: 4 },
    { prompt: '' }, { prompt: ' \n\t ' }, { prompt: 'x'.repeat(MAX_PLAN_PROMPT_CHARS + 1) },
    { prompt: `${' '.repeat(MAX_PLAN_PROMPT_CHARS)}x` }, inheritedPrompt, hiddenProvider,
    { ...input, [Symbol('provider')]: 'client-key' },
    ...['apiKey', 'model', 'fetchImpl', 'provider', 'budget', 'result', 'score'].map(field => ({ ...input, [field]: 'injected' })),
  ];
  for (const value of invalid) {
    await assert.rejects(plan(value), error => error instanceof RequestError
      && error.status === 400 && error.code === 'INVALID_PROMPT');
  }
  assert.equal(calls, 0);
});

test('valid input and server-owned options pass exactly through the supplied admission', async () => {
  const serverOptions = { apiKey: 'synthetic-server-key', model: 'test-model', timeoutMs: 123 };
  const runtime = Object.freeze({ platform: 'worker' });
  const body = { valid: true, result: { serverCalculated: true } };
  let outer;
  let providerCalls = 0;
  const plan = createPlanning({
    admission: async ({ operation }, env) => {
      assert.equal(env, runtime);
      outer = { body: await operation(serverOptions), headers: { 'X-Admission': 'retained' } };
      return outer;
    },
    plan: async (receivedInput, options) => {
      assert.equal(receivedInput, input);
      assert.equal(options, serverOptions);
      providerCalls++;
      return body;
    },
  });
  assert.equal(await plan(input, runtime), outer);
  assert.equal(providerCalls, 1);
  assert.equal(outer.body, body);
});

test('prompt limit uses raw length and accepts a valid boundary without changing caller input', async () => {
  const boundary = { prompt: ` ${'я'.repeat(MAX_PLAN_PROMPT_CHARS - 2)} ` };
  const plan = createPlanning({
    admission: async ({ operation }) => ({ body: await operation({ apiKey: 'synthetic' }) }),
    plan: async received => {
      assert.equal(received, boundary);
      assert.equal(received.prompt.length, MAX_PLAN_PROMPT_CHARS);
      return { accepted: true };
    },
  });
  assert.deepEqual(await plan(boundary), { body: { accepted: true } });
});

test('missing key uses the known keyless fallback and preserves not_configured', async () => {
  let customCalls = 0;
  const plan = createPlanning({
    admission: async ({ fallback }) => ({ body: await fallback({ reason: 'missing_api_key', options: {
      apiKey: 'must-be-overridden', fetchImpl: () => { throw new Error('network forbidden'); },
    } }), headers: {} }),
    plan: () => { customCalls++; throw new Error('custom paid operation must not run'); },
  });
  assertUnavailable((await plan(input)).body, 'not_configured');
  assert.equal(customCalls, 0);
});

test('admission denials preserve retry headers, safe summaries, and never call an injected operation', async () => {
  let customCalls = 0;
  for (const reason of ['server_request_limit', 'server_busy', 'server_rate_limited', 'budget_guard_unavailable']) {
    const headers = reason === 'server_request_limit' ? {} : { 'Retry-After': '17' };
    const plan = createPlanning({
      admission: async ({ fallback }) => ({ body: await fallback({ reason, options: {
        apiKey: 'must-be-overridden', fetchImpl: () => { throw new Error('network forbidden'); },
      } }), headers }),
      plan: () => { customCalls++; throw new Error('custom paid operation must not run'); },
    });
    const result = await plan(input);
    assertUnavailable(result.body, reason);
    assert.equal(result.headers, headers);
    assert.doesNotMatch(JSON.stringify(result.body), /must-be-overridden|network forbidden/);
  }
  assert.equal(customCalls, 0);
});

test('unrecognized admission reasons cannot leak upstream details', async () => {
  const plan = createPlanning({ admission: async ({ fallback }) => ({
    body: await fallback({ reason: 'private upstream details', options: {} }), headers: {},
  }) });
  const result = await plan(input);
  assertUnavailable(result.body, 'budget_guard_unavailable');
  assert.doesNotMatch(JSON.stringify(result), /private upstream/);
});

for (const runtime of ['Node', 'Worker']) {
  test(`${runtime}: planning consumes the already-shared allowance and has no separate guard`, async () => {
    const env = { OPENAI_API_KEY: 'synthetic-server-key', AI_MAX_REQUESTS: '1',
      AI_RATE_LIMITER: { limit: async () => ({ success: true }) },
      AI_BUDGET: { getByName: () => ({ acquire: async () => ({ allowed: true, leaseId: 'lease' }), release: async () => {} }) },
    };
    const admission = runtime === 'Node' ? createNodeAIAdmission({ env }) : createWorkerAIAdmission();
    await admission({ operation: async () => 'explanation', fallback: () => { throw new Error('unexpected denial'); } }, env);
    let customCalls = 0;
    const plan = createPlanning({ admission, plan: () => { customCalls++; throw new Error('must not run'); } });
    const result = await plan(input, env);
    assertUnavailable(result.body, 'server_request_limit');
    assert.deepEqual(result.headers, {});
    assert.equal(customCalls, 0);
  });
}
