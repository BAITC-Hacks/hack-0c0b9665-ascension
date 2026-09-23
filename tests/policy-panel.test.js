import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPolicyOptionsPanel } from '../public/policy-options-panel.js';
import { getDataset, simulate } from '../src/core/simulator.js';

// Minimal DOM surface, kept local to this test file; no browser globals or packages.
class Element extends EventTarget {
  constructor(tag, document) {
    super();
    this.tagName = tag;
    this.ownerDocument = document;
    this.children = [];
    this.attributes = {};
    this.className = '';
    this.disabled = false;
    this.ownText = '';
  }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.ownText = ''; this.append(...nodes); }
  remove() { this.parent.children = this.parent.children.filter((node) => node !== this); }
  setAttribute(key, value) { this.attributes[key] = value; }
  get textContent() { return this.ownText + this.children.map((node) => node.textContent).join(' '); }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}

function all(node) { return [node, ...node.children.flatMap(all)]; }
function byClass(node, className) { return all(node).filter((item) => item.className.split(' ').includes(className)); }
const wait = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const dataset = getDataset();
const scenario = { decisions: [
  { measureId: 'M7', districtId: 'nura' }, { measureId: 'M8', districtId: 'nura' },
  { measureId: 'M10', districtId: 'nura' }, { measureId: 'M12' }, { measureId: 'M5', districtId: 'saryarka' },
] };
const baseline = { scenario, result: simulate(scenario) };
const alternativeScenario = structuredClone(scenario);
alternativeScenario.decisions[4] = { measureId: 'M3', districtId: 'nura' };
const result = simulate(alternativeScenario);
assert.equal(result.valid, true);
const fixture = {
  valid: true, scope: 'single-decision-neighborhood', exhaustiveWithinScope: true,
  baseline, explored: 181, validCandidates: 117, paretoCandidates: 5, limit: 1, truncated: true,
  options: [{
    id: 'replace-m5-m3', scenario: alternativeScenario, result,
    delta: Object.fromEntries(['score', 'worstDistrictScore', 'totalCost', 'criticalCount']
      .map((key) => [key, result[key] - baseline.result[key]])),
    changed: { removed: scenario.decisions[4], added: alternativeScenario.decisions[4] },
    objectives: { maximizeScore: 'improved', maximizeWorst: 'improved', minimizeCost: 'worse' },
    selectedFor: ['maximizeScore', 'maximizeWorst'],
  }], errors: [], emptyReason: null,
};
const response = (data = fixture) => ({ ok: true, status: 200, json: async () => structuredClone(data) });

function setup(options = {}) {
  const window = new EventTarget();
  window.CustomEvent = CustomEvent;
  const document = { defaultView: window, createElement: (tag) => new Element(tag, document) };
  const container = new Element('div', document);
  const calls = [];
  const mount = mountPolicyOptionsPanel(container, {
    dataset, city: { hasScenarioData: true },
    fetcher: async (...args) => { calls.push(args); return response(); }, ...options,
  });
  const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
  return { container, window, calls, mount, emit,
    button: () => byClass(container, 'policy-options-find')[0],
    status: () => byClass(container, 'policy-options-status')[0].textContent,
    cards: () => byClass(container, 'policy-options-card'),
  };
}

test('import is safe without DOM and a valid calculation enables only an explicit request', async () => {
  assert.equal(typeof globalThis.document, 'undefined');
  const ui = setup();
  assert.equal(ui.button().disabled, true);
  ui.emit('scenario:calculated', structuredClone(baseline));
  assert.equal(ui.button().disabled, false);
  assert.equal(ui.calls.length, 0);
  ui.button().click();
  assert.equal(ui.button().disabled, true);
  await wait();
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0][0], '/api/policy-options');
  assert.equal(ui.calls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(ui.calls[0][1].body), scenario);
  assert.equal(ui.cards().length, 1);
  assert.match(ui.container.textContent, /Показано 1 из 5/);
  assert.match(ui.container.textContent, /56,54/);
  assert.match(ui.container.textContent, /57,21/);
  assert.match(ui.container.textContent, /\+0,66 к вашему плану/);
  assert.ok(ui.container.textContent.includes(dataset.measures.find(({ id }) => id === 'M3').name));
  assert.match(ui.container.textContent, /Нура/);
  ui.mount.destroy();
});

test('city guard requires explicit hasScenarioData and clears results when leaving model city', async () => {
  const ui = setup({ city: null });
  ui.emit('scenario:calculated', baseline);
  assert.equal(ui.button().disabled, true);
  ui.emit('city:changed', { id: 'astana', hasScenarioData: 'true' });
  ui.emit('scenario:calculated', baseline);
  assert.equal(ui.button().disabled, true);
  ui.emit('city:changed', { id: 'astana', hasScenarioData: true });
  ui.emit('scenario:calculated', baseline);
  ui.button().click();
  await wait();
  assert.equal(ui.cards().length, 1);
  ui.emit('city:changed', { id: 'other', hasScenarioData: false });
  assert.equal(ui.cards().length, 0);
  assert.equal(ui.button().disabled, true);
  assert.match(ui.status(), /нет данных модели/);
  ui.mount.destroy();
});

test('malformed calculation clears previous data instead of enabling a request', () => {
  const ui = setup();
  ui.emit('scenario:calculated', baseline);
  ui.emit('scenario:calculated', { scenario, result: { ...baseline.result, score: NaN } });
  assert.equal(ui.button().disabled, true);
  assert.equal(byClass(ui.container, 'policy-options-baseline')[0].textContent, '');
  ui.mount.destroy();
});

test('an outgoing selection is only a scenario load, with copied decisions', async () => {
  const ui = setup();
  let loaded;
  ui.window.addEventListener('scenario:load', (event) => { loaded = event.detail; });
  ui.emit('scenario:calculated', baseline);
  ui.button().click();
  await wait();
  byClass(ui.container, 'policy-options-load')[0].click();
  assert.deepEqual(loaded, { scenario: alternativeScenario });
  loaded.scenario.decisions[4].measureId = 'CHANGED';
  assert.equal(fixture.options[0].scenario.decisions[4].measureId, 'M3');
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.cards().length, 0);
  assert.equal(ui.button().disabled, true);
  assert.match(ui.status(), /Запустите расчёт/);
  ui.mount.destroy();
});

for (const [event, detail] of [
  ['scenario:invalidated', undefined], ['scenario:load', { scenario }],
  ['city:changed', { hasScenarioData: false }], ['scenario:calculated', baseline],
]) {
  test(`${event} aborts a pending request and ignores a response even when fetch ignores abort`, async () => {
    const pending = deferred();
    let signal;
    const ui = setup({ fetcher: async (_url, options) => { signal = options.signal; return pending.promise; } });
    ui.emit('scenario:calculated', baseline);
    ui.button().click();
    ui.emit(event, detail);
    assert.equal(signal.aborted, true);
    pending.resolve(response());
    await wait();
    assert.equal(ui.cards().length, 0);
    assert.doesNotMatch(ui.status(), /Найдено вариантов/);
    ui.mount.destroy();
  });
}

for (const [status, expected] of [[404, /пока не подключён/], [503, /временно недоступен/], [422, /не приняла/], [500, /HTTP 500/]]) {
  test(`HTTP ${status} is explicit and supports retry`, async () => {
    const ui = setup({ fetcher: async () => ({ ok: false, status }) });
    ui.emit('scenario:calculated', baseline);
    ui.button().click();
    await wait();
    assert.match(ui.status(), expected);
    assert.equal(ui.button().disabled, false);
    assert.equal(ui.cards().length, 0);
    ui.mount.destroy();
  });
}

test('network failures show a recoverable error', async () => {
  const ui = setup({ fetcher: async () => { throw new TypeError('Failed to fetch'); } });
  ui.emit('scenario:calculated', baseline);
  ui.button().click();
  await wait();
  assert.match(ui.status(), /соединение/);
  assert.equal(ui.button().disabled, false);
  ui.mount.destroy();
});

test('timeout recovers even if the fetcher never rejects on abort', async () => {
  let signal;
  const ui = setup({ timeoutMs: 5, fetcher: async (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  ui.emit('scenario:calculated', baseline);
  ui.button().click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(signal.aborted, true);
  assert.match(ui.status(), /слишком много времени/);
  assert.equal(ui.button().disabled, false);
  ui.mount.destroy();
});

test('server-provided empty reason and coverage are shown without inventing an optimum', async () => {
  const empty = { ...fixture, options: [], paretoCandidates: 0, truncated: false,
    emptyReason: { code: 'NO_IMPROVEMENT', message: 'Ни одна замена не улучшает план.' } };
  const ui = setup({ fetcher: async () => response(empty) });
  ui.emit('scenario:calculated', baseline);
  ui.button().click();
  await wait();
  assert.match(ui.status(), /Ни одна замена/);
  assert.match(ui.container.textContent, /Проверено: 181/);
  assert.equal(ui.cards().length, 0);
  ui.mount.destroy();
});

test('a response for a different baseline or with invalid numeric metrics is rejected', async () => {
  for (const mutate of [
    (data) => { data.baseline.scenario.decisions[0].districtId = 'esil'; },
    (data) => { data.options[0].delta.score = '999'; },
    (data) => { data.options[0].result.score = null; },
  ]) {
    const data = structuredClone(fixture);
    mutate(data);
    const ui = setup({ fetcher: async () => response(data) });
    ui.emit('scenario:calculated', baseline);
    ui.button().click();
    await wait();
    assert.match(ui.status(), /неполные или устаревшие/);
    assert.equal(ui.cards().length, 0);
    ui.mount.destroy();
  }
});

test('dataset names are text and do not create markup; destroy detaches listeners and aborts', async () => {
  const names = structuredClone(dataset);
  names.measures.find(({ id }) => id === 'M3').name = '<img src=x onerror=alert(1)>';
  const ui = setup({ dataset: names });
  ui.emit('scenario:calculated', baseline);
  ui.button().click();
  await wait();
  assert.match(ui.container.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(all(ui.container).some(({ tagName }) => tagName === 'img'), false);
  ui.mount.destroy();
  ui.emit('scenario:calculated', baseline);
  assert.equal(ui.container.children.length, 0);
  ui.mount.destroy();
});

test('a late response cannot replace a newer completed request', async () => {
  const old = deferred();
  let count = 0;
  const ui = setup({ fetcher: async () => ++count === 1 ? old.promise : response() });
  ui.emit('scenario:calculated', baseline);
  ui.button().click();
  ui.emit('scenario:invalidated');
  ui.emit('scenario:calculated', baseline);
  ui.button().click();
  await wait();
  assert.equal(ui.cards().length, 1);
  old.resolve(response({ ...fixture, options: [], emptyReason: { message: 'СТАРЫЙ ОТВЕТ' } }));
  await wait();
  assert.equal(ui.cards().length, 1);
  assert.doesNotMatch(ui.status(), /СТАРЫЙ/);
  ui.mount.destroy();
});

test('destroy aborts pending work and does not remount when it resolves', async () => {
  const old = deferred();
  let signal;
  const ui = setup({ fetcher: async (_url, options) => { signal = options.signal; return old.promise; } });
  ui.emit('scenario:calculated', baseline);
  ui.button().click();
  ui.mount.destroy();
  assert.equal(signal.aborted, true);
  old.resolve(response());
  await wait();
  assert.equal(ui.container.children.length, 0);
});

test('calculation events are copied before an explicit request', async () => {
  const ui = setup();
  const detail = structuredClone(baseline);
  ui.emit('scenario:calculated', detail);
  detail.scenario.decisions[0].measureId = 'MODIFIED';
  ui.button().click();
  await wait();
  assert.deepEqual(JSON.parse(ui.calls[0][1].body), scenario);
  assert.match(ui.container.textContent, /Предварительный расчёт на вашем устройстве/);
  ui.mount.destroy();
});
