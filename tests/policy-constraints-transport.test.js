import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import { createPolicyOptionsFetcher } from '../public/policy-options-client.js';
import { buildPolicyOptions } from '../src/core/policy-options.js';
import { simulate } from '../src/core/simulator.js';

const scenario = { decisions: [
  { measureId: 'M7', districtId: 'nura' }, { measureId: 'M8', districtId: 'nura' },
  { measureId: 'M10', districtId: 'nura' }, { measureId: 'M12' },
  { measureId: 'M5', districtId: 'saryarka' },
] };
const constraints = {
  lockedDecisions: [{ measureId: 'M5', districtId: 'saryarka' }],
  protectedIndicator: { indicatorId: 'E2', districtId: 'saryarka' },
};
const request = (payload, signal) => ({ method: 'POST', body: JSON.stringify(payload), signal });
const endpoint = '/api/policy-options';

// Run the committed browser artifact, preserving its actual message boundary.
// This verifies transport in Node threads; it does not claim browser UI coverage.
class BrowserWorkerBridge extends EventTarget {
  constructor(url, options) {
    super();
    assert.deepEqual(options, { type: 'module' });
    this.worker = new NodeWorker(new URL(`data:text/javascript,${encodeURIComponent(`
      import { parentPort } from 'node:worker_threads';
      globalThis.self = {
        addEventListener(type, listener) { parentPort.on(type, data => listener({ data })); },
        postMessage(data) { parentPort.postMessage(data); }
      };
      await import(${JSON.stringify(url.href)});
    `)}`));
    this.worker.on('message', data => this.dispatchEvent(new MessageEvent('message', { data })));
    this.worker.on('error', () => this.dispatchEvent(new Event('error', { cancelable: true })));
  }
  postMessage(data) { this.worker.postMessage(data); }
  terminate() { return this.worker.terminate(); }
}
const realFetcher = createPolicyOptionsFetcher({ WorkerClass: BrowserWorkerBridge, timeoutMs: 5000 });

test('client and committed worker preserve legacy and empty-constraint defaults', async () => {
  const expected = buildPolicyOptions(scenario);
  for (const payload of [scenario, { scenario }, { scenario, constraints: {} }]) {
    const response = await realFetcher(endpoint, request(payload));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected);
  }
});

test('locked decision and protected district reach the real core through the client and bundle', async () => {
  const response = await realFetcher(endpoint, request({ scenario, constraints }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result, buildPolicyOptions(scenario, { constraints }));
  assert.deepEqual([result.explored, result.validCandidates, result.paretoCandidates, result.options.length], [144, 86, 7, 6]);
  const baseline = simulate(scenario).districts.find(district => district.id === 'saryarka').after.E2;
  for (const option of result.options) {
    assert.ok(option.scenario.decisions.some(decision => decision.measureId === 'M5' && decision.districtId === 'saryarka'));
    const verified = simulate(option.scenario);
    assert.equal(verified.valid, true);
    assert.ok(verified.districts.find(district => district.id === 'saryarka').after.E2 >= baseline);
    assert.deepEqual(option.result, verified);
  }
});

test('citywide indicator protection and all-locked empty state survive transport', async () => {
  const response = await realFetcher(endpoint, request({ scenario, constraints: { protectedIndicator: { indicatorId: 'E2' } } }));
  const result = await response.json();
  assert.equal(result.valid, true);
  assert.ok(result.rejectedByConstraints > 0);
  for (const option of result.options) {
    for (const district of result.baseline.result.districts) {
      assert.ok(option.result.districts.find(other => other.id === district.id).after.E2 >= district.after.E2);
    }
  }
  const locked = await realFetcher(endpoint, request({ scenario, constraints: { lockedDecisions: scenario.decisions } }));
  const empty = await locked.json();
  assert.equal(locked.status, 200);
  assert.equal(empty.emptyReason.code, 'ALL_DECISIONS_LOCKED');
  assert.equal(empty.explored, 0);
  assert.deepEqual(empty.options, []);
});

test('invalid and unknown constraints are rejected by the real core without broadening search', async () => {
  for (const invalid of [null, [], { unexpected: true },
    { lockedDecisions: [{ measureId: 'M5', districtId: 'nura' }] },
    { protectedIndicator: { indicatorId: 'E2', minimum: 0 } },
    JSON.parse('{"__proto__":{"lockedDecisions":[]}}')]) {
    const response = await realFetcher(endpoint, request({ scenario, constraints: invalid }));
    assert.equal(response.status, 422);
    const result = await response.json();
    assert.equal(result.valid, false);
    assert.equal(result.errors[0].code, 'INVALID_CONSTRAINTS');
    assert.equal(result.explored, 0);
    assert.deepEqual(result.options, []);
  }
});

class ControlledWorker extends EventTarget {
  static instances = [];
  constructor() { super(); this.constructor.instances.push(this); this.terminateCount = 0; }
  postMessage(data) { this.message = structuredClone(data); }
  terminate() { this.terminateCount++; }
  emit(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
}

test('ambiguous envelopes reject before creating a worker; fields are never silently discarded', async () => {
  const fetcher = createPolicyOptionsFetcher({ WorkerClass: ControlledWorker });
  const count = ControlledWorker.instances.length;
  for (const payload of [{ constraints }, { scenario, constraints, decisions: scenario.decisions },
    { scenario, constraints, limit: 12 }]) {
    await assert.rejects(fetcher(endpoint, request(payload)), { code: 'INVALID_REQUEST' });
  }
  assert.equal(ControlledWorker.instances.length, count);
});

test('changed constraints remain request-local and stale replies cannot complete the new request', async () => {
  const fetcher = createPolicyOptionsFetcher({ WorkerClass: ControlledWorker });
  const first = fetcher(endpoint, request({ scenario, constraints }));
  const oldWorker = ControlledWorker.instances.at(-1);
  const changed = { lockedDecisions: scenario.decisions };
  const second = fetcher(endpoint, request({ scenario, constraints: changed }));
  const newWorker = ControlledWorker.instances.at(-1);
  assert.deepEqual(oldWorker.message.constraints, constraints);
  assert.deepEqual(newWorker.message.constraints, changed);
  assert.notEqual(oldWorker.message.requestId, newWorker.message.requestId);
  let settled = false;
  second.then(() => { settled = true; });
  newWorker.emit({ requestId: oldWorker.message.requestId, data: { valid: true, stale: true } });
  await Promise.resolve();
  assert.equal(settled, false);
  oldWorker.emit({ requestId: oldWorker.message.requestId, data: { valid: true, constraints } });
  newWorker.emit({ requestId: newWorker.message.requestId, data: { valid: true, constraints: changed } });
  assert.deepEqual((await (await first).json()).constraints, constraints);
  assert.deepEqual((await (await second).json()).constraints, changed);
});

test('aborting a constrained request terminates its worker and preserves subsequent error semantics', async () => {
  const fetcher = createPolicyOptionsFetcher({ WorkerClass: ControlledWorker });
  const controller = new AbortController();
  const pending = fetcher(endpoint, request({ scenario, constraints }, controller.signal));
  const worker = ControlledWorker.instances.at(-1);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  worker.emit({ requestId: worker.message.requestId, data: { valid: true } });
  assert.equal(worker.terminateCount, 1);
  const next = fetcher(endpoint, request({ scenario, constraints }));
  const nextWorker = ControlledWorker.instances.at(-1);
  nextWorker.emit({ requestId: nextWorker.message.requestId,
    error: { code: 'POLICY_SEARCH_FAILED', message: 'Test search failure' } });
  await assert.rejects(next, { code: 'POLICY_SEARCH_FAILED', message: 'Test search failure' });
  assert.equal(nextWorker.terminateCount, 1);
});
