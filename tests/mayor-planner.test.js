import test from 'node:test';
import assert from 'node:assert/strict';
import { mountMayorPlanner } from '../public/mayor-planner.js';
import { getDataset, getBaseline, validateScenario, simulate } from '../src/core/simulator.js';

const demo = [{ measureId: 'M7', districtId: 'nura' }, { measureId: 'M8', districtId: 'nura' }, { measureId: 'M10', districtId: 'nura' }, { measureId: 'M12' }, { measureId: 'M5', districtId: 'saryarka' }];
const tick = () => new Promise(resolve => setImmediate(resolve));
class Element extends EventTarget {
  constructor(document) { super(); this.ownerDocument = document; this.nodes = new Map(); this.innerHTML = ''; this.textContent = ''; this.disabled = false; this.hidden = false; }
  querySelector(selector) { if (!this.nodes.has(selector)) this.nodes.set(selector, new Element(this.ownerDocument)); return this.nodes.get(selector); }
  querySelectorAll() { return []; }
  focus() {}
  append() {}
}
function setup({ fetcher, draft } = {}) {
  const view = new EventTarget();
  view.CustomEvent = class extends Event { constructor(type, options) { super(type); this.detail = options.detail; } };
  const stored = new Map(draft ? [['mayor-workspace-draft-v1', JSON.stringify(draft)]] : []);
  view.sessionStorage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) };
  const calls = [];
  view.fetch = async (path, init) => { const input = JSON.parse(init.body); calls.push(path); if (fetcher) { const answer = await fetcher(path, input, init); if (answer) return answer; } return { ok: true, json: async () => path === '/api/validate' ? validateScenario(input) : path === '/api/simulate' ? simulate(input) : { mode: 'deterministic', available: false, summary: 'Рассчитанное объяснение', strengths: [], risks: [], recommendations: [] } }; };
  const document = { defaultView: view, createElement: () => new Element(document) };
  const container = new Element(document); const results = new Element(document);
  const calculated = []; let invalidated = 0; let opened = 0;
  const api = mountMayorPlanner(container, { dataset: getDataset(), baseline: getBaseline(), resultContainer: results, onCalculated: detail => calculated.push(detail), onInvalidated: () => invalidated++, onOpenResults: () => opened++ });
  const click = (name, result = false) => { const event = new Event('click'); const button = { disabled: false, hasAttribute: attr => attr === `data-mp-${name}`, closest: () => button, dataset: {} }; Object.defineProperty(event, 'target', { value: button }); (result ? results : container).dispatchEvent(event); };
  return { api, container, results, calls, stored, calculated, click, view, get invalidated() { return invalidated; }, get opened() { return opened; } };
}

test('official demo uses server results and explanation requires its own click', async () => {
  const ui = setup();
  assert.equal(await ui.api.load(demo), true);
  ui.click('calculate'); await tick();
  assert.equal(ui.calculated.length, 1);
  assert.ok(Math.abs(ui.calculated[0].result.score - 56.54307) < 1e-8);
  assert.equal(ui.opened, 1);
  assert.deepEqual(ui.calls, ['/api/validate', '/api/simulate']);
  assert.match(ui.results.innerHTML, /56,54/);
  assert.deepEqual(JSON.parse(ui.stored.get('mayor-workspace-draft-v1')), demo);
  ui.click('explain', true); await tick();
  assert.equal(ui.calls.at(-1), '/api/explain');
  assert.match(ui.results.querySelector('[data-mp-ai-mode]').textContent, /без AI/);
  ui.api.destroy();
});

test('rejected mutation preserves valid plan and result; same plan does not invalidate', async () => {
  const ui = setup(); await ui.api.load(demo); ui.click('calculate'); await tick();
  const result = ui.results.innerHTML;
  assert.equal(await ui.api.load(demo), true);
  assert.equal(ui.invalidated, 1);
  assert.equal(await ui.api.load([...demo.slice(0, 4), demo[0]]), false);
  assert.equal(ui.invalidated, 1);
  assert.equal(ui.results.innerHTML, result);
  assert.deepEqual(JSON.parse(ui.stored.get('mayor-workspace-draft-v1')), demo);
  ui.api.destroy();
});

test('city change blocks load and ignores late calculation even when transport ignores abort', async () => {
  let resolveSimulation;
  const ui = setup({ fetcher: (path, input) => path === '/api/simulate' ? new Promise(resolve => { resolveSimulation = () => resolve({ ok: true, json: async () => simulate(input) }); }) : undefined });
  await ui.api.load(demo); ui.click('calculate'); await tick();
  ui.api.setCity({ id: 'almaty', hasScenarioData: false });
  assert.equal(await ui.api.load(demo), false);
  resolveSimulation(); await tick();
  assert.equal(ui.calculated.length, 0);
  assert.match(ui.results.innerHTML, /Сначала/);
  assert.equal(ui.container.querySelector('[data-mp-calculate]').disabled, true);
  ui.api.destroy();
});

test('latest validation wins, and session draft is restored through validation only', async () => {
  let first;
  const ui = setup({ fetcher: (path, input) => path === '/api/validate' && input.decisions.length === 5 ? new Promise(resolve => { first = () => resolve({ ok: true, json: async () => validateScenario(input) }); }) : undefined });
  const loading = ui.api.load(demo); await tick();
  assert.equal(await ui.api.load([{ measureId: 'M12' }]), true);
  first(); assert.equal(await loading, false);
  assert.deepEqual(JSON.parse(ui.stored.get('mayor-workspace-draft-v1')), [{ measureId: 'M12' }]);
  ui.api.destroy();
  const restored = setup({ draft: demo }); await tick();
  assert.deepEqual(restored.calls, ['/api/validate']);
  assert.equal(restored.container.querySelector('[data-mp-count]').textContent, '5 / 5');
  assert.match(restored.results.innerHTML, /Сначала/);
  restored.api.destroy();
});

test('destroy prevents late callbacks and removes scenario-load listener', async () => {
  const ui = setup(); await ui.api.load(demo); ui.api.destroy();
  const count = ui.calls.length;
  ui.view.dispatchEvent(new ui.view.CustomEvent('scenario:load', { detail: { scenario: { decisions: demo } } }));
  assert.equal(await ui.api.load(demo), false);
  ui.click('calculate'); await tick();
  assert.equal(ui.calls.length, count);
});

test('late explanation cannot replace the placeholder after a scenario mutation', async () => {
  let finishExplanation;
  const ui = setup({ fetcher: path => path === '/api/explain' ? new Promise(resolve => { finishExplanation = () => resolve({ ok: true, json: async () => ({ mode: 'ai', available: true, summary: 'STALE RESPONSE' }) }); }) : undefined });
  await ui.api.load(demo); ui.click('calculate'); await tick();
  ui.click('explain', true); await tick();
  await ui.api.load([]);
  finishExplanation(); await tick();
  assert.match(ui.results.innerHTML, /Сначала/);
  assert.equal(ui.results.querySelector('[data-mp-ai-body]').innerHTML.includes('STALE RESPONSE'), false);
  ui.api.destroy();
});

test('district focus changes only future measure targets, preserving scenario and calculated result', async () => {
  const ui = setup(); await ui.api.load(demo); ui.click('calculate'); await tick();
  const renderedResult = ui.results.innerHTML; const calls = ui.calls.length;
  assert.equal(ui.api.focusDistrict('esil'), true);
  assert.equal(ui.calls.length, calls);
  assert.equal(ui.invalidated, 1);
  assert.equal(ui.results.innerHTML, renderedResult);
  assert.deepEqual(JSON.parse(ui.stored.get('mayor-workspace-draft-v1')), demo);
  const catalog = ui.container.querySelector('[data-mp-catalog]').innerHTML;
  assert.match(catalog, /data-mp-pick="M1"[^>]*><option value=""[^]*?<option value="esil" selected>/);
  assert.match(catalog, /data-mp-pick="M7"[^>]*>[^]*?<option value="nura" selected>/);
  assert.equal(ui.api.focusDistrict('unknown'), false);
  ui.api.setCity('almaty'); assert.equal(ui.api.focusDistrict('nura'), false);
  ui.api.destroy(); assert.equal(ui.api.focusDistrict('nura'), false);
});

test('initial city synchronization cancels pending session draft restoration', async () => {
  let complete;
  const ui = setup({ draft: demo, fetcher: (path, input) => path === '/api/validate' ? new Promise(resolve => { complete = () => resolve({ ok: true, json: async () => validateScenario(input) }); }) : undefined });
  ui.api.setCity({ id: 'almaty', hasScenarioData: false });
  complete(); await tick();
  assert.equal(ui.container.querySelector('[data-mp-count]').textContent, '0 / 5');
  assert.equal(ui.container.querySelector('[data-mp-calculate]').disabled, true);
  assert.equal(ui.calculated.length, 0);
  ui.api.destroy();
});
