import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { getDataset, getBaseline, simulate, validateScenario } from '../src/core/simulator.js';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function mountApp() {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      hidden: ['error-box', 'result-content', 'scenario-action-status'].includes(id),
      disabled: false, textContent: '', innerHTML: '', dataset: {}, style: {},
      listeners: new Map(), attributes: new Map(), scrolls: [],
      classList: { toggle() {}, add() {}, remove() {} },
      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener); this.listeners.set(type, listeners);
      },
      setAttribute(name, value) { this.attributes.set(name, String(value)); },
      removeAttribute(name) { this.attributes.delete(name); },
      focus() {}, querySelector() { return null; },
      scrollIntoView(options) { this.scrolls.push(options); },
    });
    return elements.get(id);
  };
  const events = [];
  const listeners = new Map();
  const window = {
    addEventListener(type, listener) {
      const handlers = listeners.get(type) ?? [];
      handlers.push(listener); listeners.set(type, handlers);
    },
    dispatchEvent(event) {
      events.push(event);
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    },
  };
  const requests = [];
  const request = (path, body) => new Promise((resolve, reject) => {
    requests.push({ path, body: structuredClone(body), resolve, reject, settled: false });
  });
  let app;
  const map = {
    results: [], focused: [],
    setResult(result) { this.results.push(result); },
    focusDistrict(id, move) {
      this.focused.push({ id, move });
      // Match the real map's callback, which also preselects catalog districts.
      app.selectDistrict(id);
    },
  };
  const context = {
    document: {
      getElementById: element,
      querySelector: element,
      querySelectorAll: (selector) => selector === '.model-only' ? [element('model-only')] : [],
    },
    window,
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    matchMedia: () => ({ matches: true }),
    location: { pathname: '/', search: '', hash: '' },
    history: { replaceState() {} },
    HashChangeEvent: class { constructor(type) { this.type = type; } },
    URLSearchParams,
    PLACES: [{ id: 'astana', name: 'Астана', hasScenarioData: true }],
    structuredClone, dataset: getDataset(), baseline: getBaseline(), request, map,
  };
  // Run the actual handlers and renderers, replacing only imports, bootstrap and API transport.
  const script = source.replace(/^import .*;\s*$/gm, '')
    .replace(/\bvoid initialize\(\);\s*$/, '') + `
      api = request;
      cityMap = map;
      state.dataset = dataset;
      state.baseline = baseline;
      globalThis.app = { state, demo, selectDistrict, renderPlan, renderFilters, renderCatalog, renderResult };
      renderPlan(); renderFilters(); renderCatalog(); renderDistricts(baseline, false); renderDistrictFocus();
    `;
  runInNewContext(script, context);
  app = context.app;
  return {
    app, element, events, requests, map,
    fire(id, type = 'click', event = {}) {
      for (const listener of element(id).listeners.get(type) ?? []) listener(event);
    },
    reply(path, value, reject = false) {
      const pending = requests.find((item) => item.path === path && !item.settled);
      assert.ok(pending, `No pending request for ${path}`);
      pending.settled = true;
      pending[reject ? 'reject' : 'resolve'](value);
      return pending;
    },
    changeCity(city) { window.dispatchEvent(new context.CustomEvent('city:changed', { detail: city })); },
    loadScenario(scenario) {
      window.dispatchEvent(new context.CustomEvent('scenario:load', { detail: { scenario } }));
    },
  };
}

async function validateDemo(harness) {
  harness.reply('/api/validate', validateScenario({ decisions: harness.app.demo }));
  await flush();
}

function assertEmpty(harness) {
  const { app, element } = harness;
  assert.equal(app.state.decisions.length, 0);
  assert.equal(app.state.totalCost, 0);
  assert.equal(app.state.result, null);
  assert.equal(app.state.busy, false);
  assert.equal(app.state.simulating, false);
  assert.equal(app.state.demoRunning, false);
  assert.equal(element('result-content').hidden, true);
  assert.equal(element('result-placeholder').hidden, false);
  assert.equal(Number(element('budget-left').textContent), 100);
  assert.equal(element('simulate-button').disabled, true);
  assert.equal(element('demo-button').disabled, false);
}

test('one demo click validates and calculates the official scenario, suppressing repeated clicks', async () => {
  const harness = mountApp();
  harness.fire('demo-button');
  harness.fire('demo-button');
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.element('demo-button').disabled, true);
  assert.equal(harness.element('reset-button').disabled, false);

  await validateDemo(harness);
  assert.deepEqual(harness.requests.map(({ path }) => path), ['/api/validate', '/api/simulate']);
  assert.deepEqual(harness.requests[1].body, { decisions: structuredClone(harness.app.demo) });
  assert.equal(harness.app.state.decisions.length, 5);
  assert.equal(harness.app.state.totalCost, 95);
  harness.fire('demo-button');
  assert.equal(harness.requests.length, 2, 'a second click during calculation must not restart demo');

  harness.reply('/api/simulate', simulate(harness.requests[1].body));
  await flush();
  assert.equal(harness.app.state.result.score.toFixed(2), '56.54');
  assert.equal(harness.element('result-content').hidden, false);
  assert.match(harness.element('result-content').innerHTML, /56,54/);
  assert.equal(harness.element('results').scrolls.length, 1);
  assert.equal(harness.events.filter(({ type }) => type === 'scenario:calculated').length, 1);
  assert.equal(harness.requests.filter(({ path }) => path === '/api/explain').length, 1);
  assert.equal(harness.app.state.demoRunning, false);
  assert.equal(harness.element('demo-button').disabled, false);
  assert.equal(harness.element('scenario-action-status').hidden, false);
  assert.ok(harness.element('scenario-action-status').textContent);
});

test('reset clears the current result and draft controls immediately without contacting the server', () => {
  const harness = mountApp();
  const { app, element } = harness;
  app.state.decisions = structuredClone(app.demo);
  app.state.totalCost = 95;
  app.state.result = simulate({ decisions: app.demo });
  app.renderResult(app.state.result);
  app.selectDistrict('esil');
  app.state.filter = 'social';
  app.state.search = 'поликлиника';
  app.state.sort = 'cost';
  app.state.affordable = true;
  app.renderPlan(); app.renderFilters(); app.renderCatalog();

  harness.fire('reset-button');
  assert.equal(harness.requests.length, 0, 'reset must work with no available API');
  assertEmpty(harness);
  assert.equal(app.state.filter, 'all');
  assert.equal(app.state.search, '');
  assert.equal(app.state.sort, 'catalog');
  assert.equal(app.state.affordable, false);
  assert.equal(app.state.history.length, 1, 'the previous plan remains available to Undo');
  const changed = harness.events.filter(({ type }) => type === 'scenario:changed');
  assert.deepEqual(structuredClone(changed.at(-1).detail.scenario), { decisions: [] }, 'autosave and the unified library receive the cleared plan');
  assert.deepEqual(structuredClone(app.state.picks), {});
  assert.equal(app.state.focusedDistrict, 'nura');
  assert.deepEqual(harness.map.focused.at(-1), { id: 'nura', move: false });
  assert.doesNotMatch(element('planning-district').textContent, /Есиль/);
  assert.equal(element('error-box').hidden, true);
  assert.equal(harness.map.results.at(-1), null);
  assert.ok(harness.events.some(({ type }) => type === 'scenario:invalidated'));
  assert.equal(element('scenario-action-status').hidden, false);
  assert.ok(element('scenario-action-status').textContent);
});

test('reset cancels pending validation and its late response cannot overwrite a newer demo run', async () => {
  const harness = mountApp();
  harness.fire('demo-button');
  assert.equal(harness.element('reset-button').disabled, false);
  harness.fire('reset-button');
  assertEmpty(harness);

  harness.fire('demo-button');
  assert.equal(harness.requests.length, 2);
  await validateDemo(harness); // Resolves the older request first.
  assert.equal(harness.app.state.decisions.length, 0);
  assert.equal(harness.app.state.busy, true);
  assert.equal(harness.app.state.demoRunning, true);
  assert.equal(harness.requests.filter(({ path }) => path === '/api/simulate').length, 0);

  await validateDemo(harness);
  assert.equal(harness.app.state.decisions.length, 5);
  assert.equal(harness.requests.filter(({ path }) => path === '/api/simulate').length, 1);
  harness.reply('/api/simulate', simulate({ decisions: harness.app.demo }));
  await flush();
  assert.equal(harness.app.state.result.score.toFixed(2), '56.54');
});

test('reset during calculation ignores the late result, explanation and result scroll', async () => {
  const harness = mountApp();
  harness.fire('demo-button');
  await validateDemo(harness);
  assert.equal(harness.app.state.simulating, true);
  harness.fire('reset-button');
  assertEmpty(harness);
  const resetStatus = harness.element('scenario-action-status').textContent;

  harness.reply('/api/simulate', simulate({ decisions: harness.app.demo }));
  await flush();
  assertEmpty(harness);
  assert.equal(harness.element('scenario-action-status').textContent, resetStatus);
  assert.equal(harness.events.filter(({ type }) => type === 'scenario:calculated').length, 0);
  assert.equal(harness.requests.filter(({ path }) => path === '/api/explain').length, 0);
  assert.equal(harness.element('results').scrolls.length, 0);
});

test('failed demo validation shows the error and never starts a calculation', async () => {
  const harness = mountApp();
  harness.fire('demo-button');
  harness.reply('/api/validate', {
    valid: false, totalCost: 95,
    errors: [{ code: 'INCOMPATIBLE_MEASURES', message: 'Меры несовместимы.' }],
  });
  await flush();
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.app.state.decisions.length, 0);
  assert.equal(harness.app.state.demoRunning, false);
  assert.equal(harness.app.state.busy, false);
  assert.equal(harness.element('demo-button').disabled, false);
  assert.equal(harness.element('error-box').hidden, false);
  assert.match(harness.element('error-box').innerHTML, /Меры несовместимы/);
});

test('a late explanation after reset cannot restore the previous result or status', async () => {
  const harness = mountApp();
  harness.fire('demo-button');
  await validateDemo(harness);
  harness.reply('/api/simulate', simulate({ decisions: harness.app.demo }));
  await flush();
  const pendingBody = harness.element('ai-body').innerHTML;
  harness.fire('reset-button');
  const resetStatus = harness.element('scenario-action-status').textContent;
  const serviceStatus = harness.element('service-status').textContent;

  harness.reply('/api/explain', { valid: true, mode: 'ai', available: true, summary: 'Устаревшее объяснение.' });
  await flush();
  assertEmpty(harness);
  assert.equal(harness.element('ai-body').innerHTML, pendingBody);
  assert.equal(harness.element('service-status').textContent, serviceStatus);
  assert.equal(harness.element('scenario-action-status').textContent, resetStatus);
});

test('leaving Astana during demo validation prevents automatic calculation', async () => {
  const harness = mountApp();
  harness.fire('demo-button');
  harness.changeCity({ id: 'almaty-city', name: 'Алматы', hasScenarioData: false });
  await validateDemo(harness);
  assert.equal(harness.requests.filter(({ path }) => path === '/api/simulate').length, 0);
  assert.equal(harness.app.state.result, null);
  assert.equal(harness.app.state.demoRunning, false);
  assert.equal(harness.app.state.busy, false);
  assert.equal(harness.events.filter(({ type }) => type === 'scenario:calculated').length, 0);
});

for (const stage of ['validation', 'calculation']) {
  test(`loading a saved plan during demo ${stage} cancels demo without waiting for its old response`, async () => {
    const harness = mountApp();
    harness.fire('demo-button');
    if (stage === 'calculation') await validateDemo(harness);
    const saved = { decisions: structuredClone(harness.app.demo) };
    saved.decisions[0].districtId = 'esil';

    harness.loadScenario(saved);
    const savedValidation = harness.requests.at(-1);
    assert.equal(savedValidation.path, '/api/validate');
    assert.deepEqual(savedValidation.body, saved);
    // The saved plan completes while the earlier demo request is still pending.
    savedValidation.settled = true;
    savedValidation.resolve(validateScenario(saved));
    await flush();
    assert.deepEqual(structuredClone(harness.app.state.decisions), saved.decisions);
    assert.equal(harness.app.state.demoRunning, false);
    assert.equal(harness.app.state.busy, false);
    assert.equal(harness.app.state.simulating, false);
    assert.equal(harness.element('simulate-button').disabled, false);
    assert.equal(harness.element('demo-button').disabled, false);
    const savedStatus = harness.element('scenario-action-status').textContent;

    if (stage === 'validation') {
      harness.reply('/api/validate', validateScenario({ decisions: harness.app.demo }));
    } else {
      harness.reply('/api/simulate', simulate({ decisions: harness.app.demo }));
    }
    await flush();
    assert.deepEqual(structuredClone(harness.app.state.decisions), saved.decisions);
    assert.equal(harness.app.state.result, null);
    assert.equal(harness.element('scenario-action-status').textContent, savedStatus);
    assert.equal(harness.element('simulate-button').disabled, false);
    assert.equal(harness.requests.filter(({ path }) => path === '/api/simulate').length,
      stage === 'validation' ? 0 : 1);
    assert.equal(harness.requests.filter(({ path }) => path === '/api/explain').length, 0);
    assert.equal(harness.events.filter(({ type }) => type === 'scenario:calculated').length, 0);
    assert.equal(harness.element('results').scrolls.length, 0);
  });
}
