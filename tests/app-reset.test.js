import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { getDataset, getBaseline, simulate, validateScenario } from '../src/core/simulator.js';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const decisions = [
  { measureId: 'M7', districtId: 'nura' }, { measureId: 'M8', districtId: 'nura' },
  { measureId: 'M10', districtId: 'nura' }, { measureId: 'M12' },
  { measureId: 'M5', districtId: 'saryarka' },
];
function section(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `Missing actual app section: ${from}`);
  return source.slice(start, end);
}

function setup({ offline = false, empty = false } = {}) {
  const elements = new Map();
  const handlers = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      style: {}, textContent: '', innerHTML: '', hidden: false, disabled: false,
      scrollIntoView() {}, addEventListener: (type, handler) => handlers.set(`${id}:${type}`, handler),
    });
    return elements.get(id);
  };
  const state = { dataset: getDataset(), baseline: getBaseline(),
    decisions: empty ? [] : structuredClone(decisions), totalCost: empty ? 0 : 95,
    picks: empty ? {} : { M7: 'nura', M5: 'saryarka' }, filter: 'ecology',
    hasScenarioData: true, busy: false, simulating: false,
    version: 4, mutationId: 3, simulationId: 2, explanationId: 1,
    result: empty ? null : simulate({ decisions }),
  };
  const requests = [], events = [], mapResults = [], districtResults = [], errors = [], filterRenders = [];
  let rendered = 0;
  let explained = 0;
  const context = {
    state, $: element,
    window: { dispatchEvent: (event) => { events.push(event); return true; } },
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    cityMap: { setResult: (value) => mapResults.push(value) },
    renderDistricts: (...args) => districtResults.push(args), renderDistrictFocus() {},
    renderFilters: () => filterRenders.push(state.filter), renderCatalog() {},
    announce: (message) => { element('announcer').textContent = message; },
    showErrors: (messages) => { errors.push(messages); element('error-box').hidden = false; },
    measureById: (id) => state.dataset.measures.find((measure) => measure.id === id),
    districtOptions: () => '', escapeHtml: String, number: String, signed: String,
    scenario: () => structuredClone({ decisions: state.decisions }),
    structuredClone, preferredScrollBehavior: () => 'instant',
    api: (path, body) => {
      const request = { path, body: structuredClone(body) };
      requests.push(request);
      if (offline) return Promise.reject(new TypeError('offline'));
      return new Promise((resolve, reject) => { request.resolve = resolve; request.reject = reject; });
    },
    renderResult: () => { rendered++; }, explain: () => { explained++; },
  };
  // Exercise the real reset listener, async validation guards and result invalidation.
  runInNewContext([
    section('function clearErrors()', 'function districtOptions('),
    section('function renderPlan()', 'function renderDistricts('),
    section('async function calculate()', 'async function explain('),
    section("$('reset-button').addEventListener", "$('simulate-button').addEventListener"),
  ].join('\n'), context);
  context.renderPlan();
  return { state, context, element, requests, events, mapResults, districtResults, errors, filterRenders,
    reset: () => handlers.get('reset-button:click')(), get rendered() { return rendered; }, get explained() { return explained; } };
}

function assertEmpty(harness) {
  const { state, element } = harness;
  assert.equal(state.decisions.length, 0);
  assert.equal(state.totalCost, 0);
  assert.equal(Object.keys(state.picks).length, 0);
  assert.equal(state.result, null);
  assert.equal(state.busy, false);
  assert.equal(state.simulating, false);
  assert.equal(state.filter, 'transport');
  assert.equal(element('plan-count').textContent, '0/5');
  assert.equal(element('plan-total').textContent, 0);
  assert.equal(element('plan-left').textContent, 100);
  assert.equal(element('simulate-button').disabled, true);
  assert.equal(element('reset-button').hidden, true);
  for (const id of ['results', 'result-content', 'policy-options-details', 'decision-brief-details', 'error-box']) assert.equal(element(id).hidden, true, `${id} must be hidden`);
}

test('reset clears a calculated plan immediately while offline without any validation request', async () => {
  const harness = setup({ offline: true });
  const previous = { ...harness.state };
  harness.element('error-box').textContent = 'Old network error';
  await harness.reset();
  assertEmpty(harness);
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.state.mutationId, previous.mutationId + 1);
  assert.equal(harness.state.version, previous.version + 1);
  assert.equal(harness.state.simulationId, previous.simulationId + 1);
  assert.equal(harness.state.explanationId, previous.explanationId + 1);
  assert.equal(harness.events.filter((event) => event.type === 'scenario:invalidated').length, 1);
  assert.deepEqual(harness.mapResults, [null]);
  assert.equal(harness.districtResults[0][0], harness.state.baseline);
  assert.deepEqual(harness.filterRenders, ['transport']);
  assert.equal(harness.element('error-box').textContent, '');
  assert.equal(harness.errors.length, 0);
});

for (const empty of [false, true]) {
  test(`reset stays available during ${empty ? 'the first addition' : 'a plan replacement'} and stale validation cannot restore it`, async () => {
    const harness = setup({ empty });
    const pending = harness.context.applyDecisions(decisions, 'Load plan');
    assert.equal(harness.state.busy, true);
    assert.equal(harness.element('reset-button').disabled, false);
    assert.equal(harness.element('reset-button').hidden, false);
    harness.reset();
    assertEmpty(harness);
    assert.equal(harness.requests.length, 1, 'reset must not make a second request');
    harness.requests[0].resolve(validateScenario({ decisions }));
    assert.equal(await pending, false);
    assertEmpty(harness);
    assert.equal(harness.errors.length, 0);
    assert.equal(harness.events.filter((event) => event.type === 'scenario:invalidated').length, 1);
  });
}

test('an old validation rejection cannot show an error or unlock a newer request after reset', async () => {
  const harness = setup();
  const oldRequest = harness.context.applyDecisions(decisions, 'Old plan');
  harness.reset();
  const fresh = [{ measureId: 'M1', districtId: 'esil' }];
  const newRequest = harness.context.applyDecisions(fresh, 'New plan');
  const mutationId = harness.state.mutationId;
  harness.requests[0].reject(new TypeError('connection lost'));
  assert.equal(await oldRequest, false);
  assert.equal(harness.errors.length, 0);
  assert.equal(harness.state.busy, true);
  assert.equal(harness.state.mutationId, mutationId);
  assert.equal(harness.state.decisions.length, 0);
  harness.requests[1].resolve(validateScenario({ decisions: fresh }));
  assert.equal(await newRequest, true);
  assert.equal(harness.state.busy, false);
  assert.deepEqual(structuredClone(harness.state.decisions), fresh);
  assert.equal(harness.state.totalCost, 18);
});

test('reset invalidates a pending calculation so its late result cannot restart output or explanation', async () => {
  const harness = setup();
  const pending = harness.context.calculate();
  assert.equal(harness.state.simulating, true);
  harness.reset();
  assertEmpty(harness);
  harness.requests[0].resolve(simulate({ decisions }));
  await pending;
  assertEmpty(harness);
  assert.equal(harness.rendered, 0);
  assert.equal(harness.explained, 0);
  assert.equal(harness.events.filter((event) => event.type === 'scenario:calculated').length, 0);
});
