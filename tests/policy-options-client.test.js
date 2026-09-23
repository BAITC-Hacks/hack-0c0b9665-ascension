import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createPolicyOptionsFetcher } from '../public/policy-options-client.js';

const endpoint = '/api/policy-options';
const scenario = { decisions: [{ measureId: 'M7', districtId: 'nura' }] };
const request = (signal) => ({ method: 'POST', body: JSON.stringify(scenario), signal });

function fakeWorkers({ construct, post } = {}) {
  return class FakeWorker extends EventTarget {
    static instances = [];
    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      this.messages = [];
      this.terminateCount = 0;
      this.constructor.instances.push(this);
      construct?.(this);
    }
    postMessage(message) {
      this.messages.push(structuredClone(message));
      post?.(this, message);
    }
    terminate() { this.terminateCount++; }
    emit(type, data) {
      const event = new Event(type, { cancelable: true });
      Object.defineProperty(event, 'data', { value: data });
      this.dispatchEvent(event);
      return event;
    }
    reply(data) { this.emit('message', { requestId: this.messages[0].requestId, data }); }
  };
}

function trackTimers(t) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const pending = new Set();
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    const handle = originalSetTimeout(() => { pending.delete(handle); callback(...args); }, delay);
    pending.add(handle);
    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', (handle) => {
    pending.delete(handle);
    return originalClearTimeout(handle);
  });
  t.after(() => { for (const handle of pending) originalClearTimeout(handle); });
  return pending;
}

function assertClean(worker, signal, timers) {
  assert.equal(worker.terminateCount, 1, 'worker must be terminated exactly once');
  for (const type of ['message', 'error', 'messageerror']) assert.equal(getEventListeners(worker, type).length, 0, `${type} listeners must be removed`);
  if (signal) assert.equal(getEventListeners(signal, 'abort').length, 0, 'abort listener must be removed');
  if (timers) assert.equal(timers.size, 0, 'timeout must be cleared');
}

test('successful result is a genuine JSON Response and the scenario reaches a module worker unchanged', async (t) => {
  const timers = trackTimers(t);
  const WorkerClass = fakeWorkers();
  const controller = new AbortController();
  const workerUrl = new URL('https://example.test/local/policy-worker.js');
  const fetcher = createPolicyOptionsFetcher({ WorkerClass, workerUrl });
  const pending = fetcher(endpoint, request(controller.signal));
  const worker = WorkerClass.instances[0];
  assert.equal(worker.url, workerUrl);
  assert.deepEqual(worker.options, { type: 'module' });
  assert.deepEqual(worker.messages[0], { requestId: worker.messages[0].requestId, scenario, limit: 6 });
  assert.equal(typeof worker.messages[0].requestId, 'string');
  const data = { valid: true, options: [{ decisions: scenario.decisions, score: 54.8 }] };
  worker.reply(data);
  const response = await pending;
  assert.ok(response instanceof Response);
  assert.equal(response.status, 200);
  assert.equal(response.ok, true);
  assert.match(response.headers.get('Content-Type'), /application\/json/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), data);
  assertClean(worker, controller.signal, timers);
  controller.abort();
  worker.reply({ valid: false });
  assert.equal(worker.terminateCount, 1);
});

test('solver validation failures resolve as HTTP 422 without client-side scenario validation', async () => {
  const WorkerClass = fakeWorkers();
  const fetcher = createPolicyOptionsFetcher({ WorkerClass });
  const pending = fetcher(endpoint, { method: 'post', body: 'null' });
  const worker = WorkerClass.instances[0];
  assert.equal(worker.messages[0].scenario, null);
  const data = { valid: false, errors: [{ code: 'INVALID_SCENARIO', message: 'Нужен сценарий.' }] };
  worker.reply(data);
  const response = await pending;
  assert.equal(response.status, 422);
  assert.equal(response.ok, false);
  assert.deepEqual(await response.json(), data);
  assertClean(worker);
});

test('default URL points at the adjacent browser module, and requests each own a worker and ID', async () => {
  const WorkerClass = fakeWorkers();
  const fetcher = createPolicyOptionsFetcher({ WorkerClass });
  const first = fetcher(endpoint, request());
  const second = fetcher(endpoint, request());
  const [a, b] = WorkerClass.instances;
  assert.equal(a.url.href, new URL('../public/policy-options-worker.js', import.meta.url).href);
  assert.notEqual(a, b);
  assert.notEqual(a.messages[0].requestId, b.messages[0].requestId);
  let settled = false;
  first.then(() => { settled = true; });
  a.emit('message', { requestId: b.messages[0].requestId, data: { valid: true, options: ['wrong request'] } });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(a.terminateCount, 0);
  b.reply({ valid: true, options: ['second'] });
  a.reply({ valid: true, options: ['first'] });
  assert.deepEqual((await (await first).json()).options, ['first']);
  assert.deepEqual((await (await second).json()).options, ['second']);
  assertClean(a);
  assertClean(b);
});

test('already-aborted requests reject before creating a worker', async () => {
  const WorkerClass = fakeWorkers();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createPolicyOptionsFetcher({ WorkerClass })(endpoint, request(controller.signal)), { name: 'AbortError' });
  assert.equal(WorkerClass.instances.length, 0);
});

test('abort during worker construction is noticed and prevents dispatch', async (t) => {
  const timers = trackTimers(t);
  const controller = new AbortController();
  const WorkerClass = fakeWorkers({ construct: () => controller.abort() });
  await assert.rejects(createPolicyOptionsFetcher({ WorkerClass })(endpoint, request(controller.signal)), { name: 'AbortError' });
  const worker = WorkerClass.instances[0];
  assert.equal(worker.messages.length, 0);
  assertClean(worker, controller.signal, timers);
});

test('abort after dispatch terminates work and removes every listener and timeout', async (t) => {
  const timers = trackTimers(t);
  const WorkerClass = fakeWorkers();
  const controller = new AbortController();
  const pending = createPolicyOptionsFetcher({ WorkerClass })(endpoint, request(controller.signal));
  const worker = WorkerClass.instances[0];
  assert.equal(timers.size, 1);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  await rejected;
  assertClean(worker, controller.signal, timers);
  worker.reply({ valid: true });
  assert.equal(worker.terminateCount, 1);
});

test('timeout rejects promptly and cleans up a worker that never replies', async (t) => {
  const timers = trackTimers(t);
  const WorkerClass = fakeWorkers();
  const controller = new AbortController();
  const pending = createPolicyOptionsFetcher({ WorkerClass, timeoutMs: 5 })(endpoint, request(controller.signal));
  await assert.rejects(pending, { name: 'PolicyOptionsError', code: 'WORKER_TIMEOUT' });
  assertClean(WorkerClass.instances[0], controller.signal, timers);
});

test('worker error and unreadable message reject and clean up instead of waiting for timeout', async (t) => {
  const timers = trackTimers(t);
  for (const [eventType, code] of [['error', 'WORKER_ERROR'], ['messageerror', 'WORKER_MESSAGE_ERROR']]) {
    const WorkerClass = fakeWorkers();
    const controller = new AbortController();
    const pending = createPolicyOptionsFetcher({ WorkerClass })(endpoint, request(controller.signal));
    const worker = WorkerClass.instances[0];
    const rejected = assert.rejects(pending, { code });
    const event = worker.emit(eventType);
    await rejected;
    if (eventType === 'error') assert.equal(event.defaultPrevented, true);
    assertClean(worker, controller.signal, timers);
  }
});

test('structured worker error preserves its code and readable message', async (t) => {
  const timers = trackTimers(t);
  const WorkerClass = fakeWorkers();
  const pending = createPolicyOptionsFetcher({ WorkerClass })(endpoint, request());
  const worker = WorkerClass.instances[0];
  worker.emit('message', { requestId: worker.messages[0].requestId, error: { code: 'SEARCH_FAILED', message: 'Не удалось найти допустимые варианты.' } });
  await assert.rejects(pending, { name: 'PolicyOptionsError', code: 'SEARCH_FAILED', message: 'Не удалось найти допустимые варианты.' });
  assertClean(worker, null, timers);
});

test('malformed worker messages reject, including ambiguous and non-JSON payloads', async (t) => {
  const timers = trackTimers(t);
  const invalidMessages = [
    () => null,
    () => ({}),
    () => ({ requestId: null, data: { valid: true } }),
    () => ({ requestId: '', data: { valid: true } }),
    (requestId) => ({ requestId }),
    (requestId) => ({ requestId, data: null }),
    (requestId) => ({ requestId, data: [] }),
    (requestId) => ({ requestId, data: { valid: 'false' } }),
    (requestId) => ({ requestId, data: { valid: true }, error: { code: 'E', message: 'Ошибка.' } }),
    (requestId) => ({ requestId, error: { code: 'E' } }),
    (requestId) => ({ requestId, data: { value: 1n } }),
  ];
  for (const makeMessage of invalidMessages) {
    const WorkerClass = fakeWorkers();
    const controller = new AbortController();
    const pending = createPolicyOptionsFetcher({ WorkerClass })(endpoint, request(controller.signal));
    const worker = WorkerClass.instances[0];
    worker.emit('message', makeMessage(worker.messages[0].requestId));
    await assert.rejects(pending, { code: 'INVALID_WORKER_MESSAGE' });
    assertClean(worker, controller.signal, timers);
  }
});

test('worker creation and postMessage failures are actionable and leave no resources behind', async (t) => {
  const timers = trackTimers(t);
  const brokenConstructor = class { constructor() { throw new Error('Blocked by CSP'); } };
  await assert.rejects(createPolicyOptionsFetcher({ WorkerClass: brokenConstructor })(endpoint, request()), { code: 'WORKER_START_FAILED' });
  assert.equal(timers.size, 0);
  const WorkerClass = fakeWorkers({ post: () => { throw new Error('Cannot clone'); } });
  const controller = new AbortController();
  await assert.rejects(createPolicyOptionsFetcher({ WorkerClass })(endpoint, request(controller.signal)), { code: 'WORKER_START_FAILED' });
  assertClean(WorkerClass.instances[0], controller.signal, timers);
  await assert.rejects(createPolicyOptionsFetcher({ WorkerClass: null })(endpoint, request()), { code: 'WORKER_UNAVAILABLE' });
});

test('unsupported routes, methods and JSON never create a worker or invoke network fetch', async (t) => {
  const WorkerClass = fakeWorkers();
  const fetcher = createPolicyOptionsFetcher({ WorkerClass });
  const network = t.mock.method(globalThis, 'fetch', () => { throw new Error('Network must not be used'); });
  for (const [path, options, code] of [
    ['/api/explain', request(), 'UNSUPPORTED_REQUEST'],
    ['https://example.test/api/policy-options', request(), 'UNSUPPORTED_REQUEST'],
    [`${endpoint}?limit=6`, request(), 'UNSUPPORTED_REQUEST'],
    [endpoint, { method: 'GET' }, 'UNSUPPORTED_REQUEST'],
    [endpoint, {}, 'UNSUPPORTED_REQUEST'],
    [endpoint, { method: 'POST', body: {} }, 'INVALID_JSON'],
    [endpoint, { method: 'POST', body: '{' }, 'INVALID_JSON'],
  ]) await assert.rejects(fetcher(path, options), { code });
  assert.equal(WorkerClass.instances.length, 0);
  assert.equal(network.mock.callCount(), 0);
});

test('invalid timeout configuration is rejected synchronously', () => {
  for (const timeoutMs of [0, -1, NaN, Infinity, '12000']) assert.throws(() => createPolicyOptionsFetcher({ timeoutMs }), RangeError);
});
