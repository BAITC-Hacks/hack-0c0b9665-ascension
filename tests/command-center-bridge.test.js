import test from 'node:test';
import assert from 'node:assert/strict';
import { mountCommandCenterBridge } from '../public/command-center-bridge.js';
import { getDataset, getBaseline, simulate } from '../src/core/simulator.js';
import { simulateTrajectory } from '../src/core/trajectory.js';

const scenario = { decisions: [
  { measureId: 'M7', districtId: 'nura' }, { measureId: 'M8', districtId: 'nura' },
  { measureId: 'M10', districtId: 'nura' }, { measureId: 'M12' },
  { measureId: 'M5', districtId: 'saryarka' },
] };
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(options = {}) {
  const events = new EventTarget();
  const context = { hasScenarioData: true, version: 0, resultValid: false, decisions: [] };
  const mapResults = [];
  const bridge = mountCommandCenterBridge({ dataset: getDataset(), baseline: getBaseline(),
    map: { setResult: frame => mapResults.push(frame) }, eventTarget: events,
    getContext: () => structuredClone(context), mount: () => ({ destroy() {} }),
    applyDecisions: async decisions => { context.decisions = decisions; return true; },
    calculate: async () => { context.resultValid = true; },
    fetcher: async () => ({ ok: true, json: async () => simulateTrajectory(scenario) }),
    ...options,
  });
  return { events, context, mapResults, bridge,
    emit: (type, detail) => events.dispatchEvent(new CustomEvent(type, { detail })) };
}
test('bridge applies a proposed plan through validation before calculating', async () => {
  const calls = [];
  const harness = setup({ applyDecisions: async decisions => {
    calls.push('validate'); harness.context.decisions = decisions; return true;
  }, calculate: async () => { calls.push('calculate'); harness.context.resultValid = true; } });
  let outcome;
  harness.events.addEventListener('ascension:plan-applied', e => { outcome = e.detail; });
  harness.emit('ascension:apply-plan', scenario);
  await tick();
  assert.deepEqual(calls, ['validate', 'calculate']);
  assert.equal(outcome.applied, true);
  harness.bridge.destroy();
});
test('bridge never calculates rejected or off-city plans', async () => {
  let calculations = 0;
  let validations = 0;
  const harness = setup({ applyDecisions: async () => { validations++; return false; },
    calculate: async () => { calculations++; } });
  harness.emit('ascension:apply-plan', scenario);
  await tick();
  harness.context.hasScenarioData = false;
  harness.emit('ascension:apply-plan', scenario);
  await tick();
  assert.equal(validations, 1);
  assert.equal(calculations, 0);
  harness.bridge.destroy();
});
test('bridge uses server frames and ignores forged frame numbers and values', async () => {
  const harness = setup();
  harness.emit('scenario:calculated', { scenario, result: simulate(scenario) });
  await tick();
  harness.emit('ascension:frame', { quarter: 4, frame: { quarter: 4, score: 999999 } });
  assert.equal(harness.mapResults.length, 1);
  assert.equal(harness.mapResults[0].score, simulateTrajectory(scenario).frames[4].score);
  harness.emit('ascension:frame', { quarter: 900 });
  assert.equal(harness.mapResults.length, 1);
  harness.emit('scenario:invalidated');
  harness.emit('ascension:frame', { quarter: 4 });
  assert.equal(harness.mapResults.length, 1);
  harness.bridge.destroy();
});
for (const invalidator of ['scenario:invalidated', 'scenario:load', 'city:changed']) {
  test(`bridge discards delayed trajectories after ${invalidator}`, async () => {
    let resolveRequest;
    let signal;
    const harness = setup({ fetcher: (_url, options) => {
      signal = options.signal;
      return new Promise(resolve => { resolveRequest = resolve; });
    } });
    let delivered = 0;
    harness.events.addEventListener('ascension:trajectory', () => { delivered++; });
    harness.emit('scenario:calculated', { scenario, result: simulate(scenario) });
    harness.emit(invalidator, { scenario });
    assert.equal(signal.aborted, true);
    resolveRequest({ ok: true, json: async () => simulateTrajectory(scenario) });
    await tick();
    assert.equal(delivered, 0);
    harness.bridge.destroy();
  });
}
test('bridge disposal cancels pending work and removes all handlers', async () => {
  let resolveRequest;
  let signal;
  const harness = setup({ fetcher: (_url, options) => {
    signal = options.signal;
    return new Promise(resolve => { resolveRequest = resolve; });
  } });
  let delivered = 0;
  harness.events.addEventListener('ascension:trajectory', () => { delivered++; });
  harness.emit('scenario:calculated', { scenario });
  harness.bridge.destroy();
  assert.equal(signal.aborted, true);
  resolveRequest({ ok: true, json: async () => simulateTrajectory(scenario) });
  await tick();
  assert.equal(delivered, 0);
  harness.emit('ascension:apply-plan', scenario);
  await tick();
  assert.deepEqual(harness.context.decisions, []);
});

test('bridge does not auto-calculate when a city changes away and back during validation', async () => {
  let resolveValidation;
  let calculated = 0;
  const harness = setup({ applyDecisions: () => new Promise(resolve => { resolveValidation = resolve; }),
    calculate: async () => { calculated++; } });
  harness.emit('ascension:apply-plan', scenario);
  harness.context.hasScenarioData = false;
  harness.emit('city:changed', { id: 'almaty', hasScenarioData: false });
  harness.context.hasScenarioData = true;
  harness.emit('city:changed', { id: 'astana', hasScenarioData: true });
  resolveValidation(true);
  await tick();
  assert.equal(calculated, 0);
  harness.bridge.destroy();
});
