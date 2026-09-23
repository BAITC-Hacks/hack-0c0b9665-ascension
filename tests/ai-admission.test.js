import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeAIAdmission, createWorkerAIAdmission } from '../src/runtime/ai-admission.js';

const fallback = async ({ reason, options }) => {
  assert.equal(options.apiKey, '');
  return { available: false, reason };
};
function workerEnv(overrides = {}) {
  return { OPENAI_API_KEY: 'test-key',
    AI_RATE_LIMITER: { limit: async ({ key }) => {
      assert.equal(key, 'ascension-city-map:explain');
      return { success: true };
    } },
    AI_BUDGET: { getByName: (name) => {
      assert.equal(name, 'global');
      return { acquire: async () => ({ allowed: true, leaseId: 'lease' }), release: async () => {} };
    } }, ...overrides };
}
for (const runtime of ['Node', 'Worker']) {
  const make = (limits = {}) => {
    const env = workerEnv(limits);
    const admission = runtime === 'Node' ? createNodeAIAdmission({ env }) : createWorkerAIAdmission();
    return action => admission(action, env);
  };
  test(`${runtime}: plan and explain share the same request allowance`, async () => {
    const run = make({ AI_MAX_REQUESTS: '2' });
    const called = [];
    for (const name of ['plan', 'explain', 'plan']) {
      const response = await run({ operation: async options => {
        assert.equal(options.apiKey, 'test-key');
        called.push(name); return { name };
      }, fallback });
      if (called.length === 2 && name === 'plan') assert.equal(response.body.reason, 'server_request_limit');
    }
    assert.deepEqual(called, ['plan', 'explain']);
  });
  test(`${runtime}: concurrency is shared and released after provider rejection`, async () => {
    const run = make({ AI_MAX_CONCURRENT: '1' });
    let rejectFirst;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const first = run({ operation: () => { started(); return new Promise((_, reject) => { rejectFirst = reject; }); }, fallback });
    const failure = assert.rejects(first, /provider failed/);
    await ready;
    let secondCalls = 0;
    const second = await run({ operation: async () => { secondCalls++; }, fallback });
    assert.equal(second.body.reason, 'server_busy');
    assert.equal(second.headers['Retry-After'], '5');
    assert.equal(secondCalls, 0);
    rejectFirst(new Error('provider failed'));
    await failure;
    const third = await run({ operation: async () => 'released', fallback });
    assert.equal(third.body, 'released');
  });
  test(`${runtime}: missing key runs only keyless fallback`, async () => {
    const run = make({ OPENAI_API_KEY: '' });
    const result = await run({ operation: () => { throw new Error('paid operation must not run'); }, fallback });
    assert.equal(result.body.reason, 'missing_api_key');
  });
}
test('Worker: concurrent asynchronous platform approvals cannot bypass the local cap', async () => {
  let releasePlatform;
  const gate = new Promise(resolve => { releasePlatform = resolve; });
  const env = workerEnv({ AI_MAX_REQUESTS: '1', AI_RATE_LIMITER: { limit: () => gate } });
  const admission = createWorkerAIAdmission();
  let calls = 0;
  const action = { operation: async () => { calls++; return 'paid'; }, fallback };
  const first = admission(action, env);
  const second = admission(action, env);
  releasePlatform({ success: true });
  const results = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(results.filter(value => value.body.reason === 'server_request_limit').length, 1);
});
test('Worker: missing, rejecting, and failing guards all fail closed', async () => {
  for (const patch of [
    { AI_RATE_LIMITER: undefined },
    { AI_RATE_LIMITER: { limit: async () => { throw new Error('rate outage'); } } },
    { AI_BUDGET: undefined },
    { AI_BUDGET: { getByName: () => { throw new Error('budget outage'); } } },
    { AI_BUDGET: { getByName: () => ({ acquire: async () => ({ allowed: true }) }) } },
  ]) {
    const admission = createWorkerAIAdmission();
    const result = await admission({ operation: () => { throw new Error('must not call provider'); }, fallback }, workerEnv(patch));
    assert.equal(result.body.available, false);
    assert.ok(['server_rate_limited', 'budget_guard_unavailable'].includes(result.body.reason));
  }
});
test('Worker: durable lease is released once on success and errors, release failure never retries provider', async () => {
  let acquires = 0;
  let releases = 0;
  let operations = 0;
  const env = workerEnv({ AI_BUDGET: { getByName: () => ({
    acquire: async () => { acquires++; return { allowed: true, leaseId: `lease-${acquires}` }; },
    release: async () => { releases++; throw new Error('release outage'); },
  }) } });
  const admission = createWorkerAIAdmission();
  const result = await admission({ operation: async () => { operations++; return 'ok'; }, fallback }, env);
  assert.equal(result.body, 'ok');
  await assert.rejects(admission({ operation: async () => { operations++; throw new Error('provider error'); }, fallback }, env), /provider error/);
  assert.equal(acquires, 2);
  assert.equal(releases, 2);
  assert.equal(operations, 2);
});
