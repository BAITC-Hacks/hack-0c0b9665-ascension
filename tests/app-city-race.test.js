import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { getDataset, getBaseline, simulate } from '../src/core/simulator.js';

test('leaving Astana during a pending calculation restores the button and ignores the stale response', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const section = (from, to) => {
    const start = source.indexOf(from);
    const end = source.indexOf(to, start + from.length);
    assert.ok(start >= 0 && end > start, `Missing actual app section: ${from}`);
    return source.slice(start, end);
  };
  const decisions = [
    { measureId: 'M7', districtId: 'nura' }, { measureId: 'M8', districtId: 'nura' },
    { measureId: 'M10', districtId: 'nura' }, { measureId: 'M12' },
    { measureId: 'M5', districtId: 'saryarka' },
  ];
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { style: {}, scrollIntoView() {}, textContent: '', innerHTML: '', disabled: false });
    return elements.get(id);
  };
  const state = { dataset: getDataset(), baseline: getBaseline(), decisions, totalCost: 95,
    hasScenarioData: true, busy: false, simulating: false, demoRunId: 0, mutationId: 0, version: 0, simulationId: 0,
    explanationId: 0, result: null };
  const requests = [];
  const listeners = new Map();
  const events = [];
  const modelPanel = { hidden: false };
  let rendered = 0;
  let explained = 0;
  const context = {
    state, $: element, currentCity: { id: 'astana', hasScenarioData: true },
    document: { querySelectorAll: () => [modelPanel] },
    window: {
      addEventListener: (name, handler) => listeners.set(name, handler),
      dispatchEvent: event => { events.push(event); return true; },
    },
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    structuredClone, preferredScrollBehavior: () => 'instant',
    cityMap: { setResult() {} }, renderDistricts() {}, renderDistrictFocus() {},
    clearErrors() {}, setActionStatus() {}, renderCatalog() {}, showErrors: errors => assert.fail(JSON.stringify(errors)), announce() {},
    measureById: id => state.dataset.measures.find(measure => measure.id === id),
    districtOptions: () => '', escapeHtml: String, number: value => String(value), signed: value => String(value),
    scenario: () => structuredClone({ decisions: state.decisions }),
    api: path => {
      assert.equal(path, '/api/simulate');
      return new Promise(resolve => requests.push(resolve));
    },
    renderResult: () => { rendered++; }, explain: () => { explained++; },
  };
  // Exercise the real event handler, renderPlan, invalidation and async calculate functions.
  runInNewContext([
    section('function renderPlan()', 'function invalidateResult()'),
    section('function invalidateResult()', 'async function applyDecisions'),
    section('async function calculate()', 'async function explain('),
    section("window.addEventListener('city:changed'", "document.querySelector('nav').addEventListener"),
  ].join('\n'), context);

  const first = context.calculate();
  assert.equal(state.simulating, true);
  assert.equal(element('simulate-button').disabled, true);
  const changeCity = city => listeners.get('city:changed')({ detail: city });
  changeCity({ id: 'almaty-city', name: 'Алматы', hasScenarioData: false });
  changeCity({ id: 'astana', name: 'Астана', hasScenarioData: true });
  assert.equal(state.simulating, false);
  assert.equal(modelPanel.hidden, false);
  assert.equal(element('simulate-button').disabled, false);
  assert.doesNotMatch(element('simulate-button').innerHTML, /Рассчитываем/);

  requests.shift()(simulate({ decisions }));
  await first;
  assert.equal(state.result, null);
  assert.equal(rendered, 0);
  assert.equal(explained, 0);
  assert.equal(events.filter(event => event.type === 'scenario:calculated').length, 0);

  const second = context.calculate();
  assert.equal(element('simulate-button').disabled, true);
  requests.shift()(simulate({ decisions }));
  await second;
  assert.equal(rendered, 1);
  assert.equal(explained, 1);
  assert.equal(events.filter(event => event.type === 'scenario:calculated').length, 1);
  assert.equal(element('simulate-button').disabled, false);
});
