import test from 'node:test';
import assert from 'node:assert/strict';
import { mountActionRegister, localDate, isOverdue, registerCsv } from '../public/action-register.js';
import { getDataset, simulate } from '../src/core/simulator.js';

const STORAGE_KEY = 'akim-action-register-v1';
const dataset = getDataset();
const city = { id: 'astana', name: 'Астана', hasScenarioData: true };
const scenario = { decisions: [
  { measureId: 'M7', districtId: 'nura' }, { measureId: 'M8', districtId: 'nura' },
  { measureId: 'M10', districtId: 'nura' }, { measureId: 'M12' },
  { measureId: 'M5', districtId: 'saryarka' },
] };
const calculation = { scenario, result: simulate(scenario) };
assert.equal(calculation.result.valid, true);

class TrackedTarget extends EventTarget {
  constructor() { super(); this.listeners = new Map(); }
  addEventListener(type, listener, options) {
    super.addEventListener(type, listener, options);
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener, options) {
    super.removeEventListener(type, listener, options);
    this.listeners.get(type)?.delete(listener);
  }
  get listenerCount() { return [...this.listeners.values()].reduce((count, set) => count + set.size, 0); }
}

// A small DOM surface: deliberately disallow HTML sinks for all fixture text.
class Element extends TrackedTarget {
  constructor(tag, document) {
    super();
    this.tagName = tag;
    this.ownerDocument = document;
    this.children = [];
    this.attributes = {};
    this.className = '';
    this.disabled = false;
    this.hidden = false;
    this.value = '';
    this.ownText = '';
    this.dataset = {};
    this.style = {};
  }
  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === 'string') this.children.push({ textContent: node, children: [], className: '' });
      else { node.parentNode = this; this.children.push(node); }
    }
  }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { this.children = []; this.ownText = ''; this.append(...nodes); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((node) => node !== this); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
  get textContent() { return this.ownText + this.children.map((node) => node.textContent).join(' '); }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  set innerHTML(_value) { throw new Error('Action register must not use innerHTML'); }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  focus() { this.ownerDocument.activeElement = this; }
}

function all(node) { return [node, ...node.children.flatMap(all)]; }
function byClass(node, className) { return all(node).filter((item) => item.className.split(/\s+/).includes(className)); }
function field(card, name) {
  const element = byClass(card, `action-register-${name}`)[0];
  assert.ok(element, `Missing ${name} field`);
  return element;
}
function edit(element, value, event = 'input') {
  element.value = value;
  element.dispatchEvent(new Event(event));
}
function select(card, status) { edit(field(card, 'state'), status, 'change'); }
function memoryStorage(initial) {
  const values = new Map(initial === undefined ? [] : [[STORAGE_KEY, initial]]);
  return {
    writes: 0,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { this.writes += 1; values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}
function setup(options = {}) {
  const storage = options.storage ?? memoryStorage();
  const window = new TrackedTarget();
  window.CustomEvent = CustomEvent;
  window.localStorage = storage;
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  if (options.storageGetter) Object.defineProperty(window, 'localStorage', { get: options.storageGetter });
  const document = { defaultView: window, createElement: (tag) => new Element(tag, document) };
  const container = new Element('div', document);
  document.body = new Element('body', document);
  const mount = mountActionRegister(container, {
    dataset: options.dataset ?? structuredClone(dataset),
    city: Object.hasOwn(options, 'city') ? options.city : structuredClone(city),
  });
  const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
  return {
    container, window, storage, mount, emit,
    button: () => byClass(container, 'action-register-create')[0],
    cards: () => byClass(container, 'action-register-card'),
    summary: () => byClass(container, 'action-register-summary')[0].textContent,
    message: () => byClass(container, 'action-register-message')[0].textContent,
    storageMessage: () => byClass(container, 'action-register-storage')[0].textContent,
    saved: () => JSON.parse(storage.getItem(STORAGE_KEY)),
  };
}
function create(ui, detail = calculation) {
  ui.emit('scenario:calculated', structuredClone(detail));
  assert.equal(ui.button().disabled, false, 'valid current result should enable explicit creation');
  ui.button().click();
}

test('only an explicit action after a valid current calculation creates five manual drafts', () => {
  assert.equal(typeof globalThis.document, 'undefined');
  const ui = setup();
  assert.equal(ui.button().disabled, true);
  assert.equal(ui.cards().length, 0);
  ui.emit('scenario:calculated', structuredClone(calculation));
  assert.equal(ui.button().disabled, false);
  assert.equal(ui.cards().length, 0);
  ui.button().click();
  assert.equal(ui.cards().length, 5);
  const saved = ui.saved();
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.registers.length, 1);
  const [register] = saved.registers;
  assert.deepEqual(register.source.scenario, scenario);
  assert.deepEqual(register.source.city, { id: 'astana', name: 'Астана' });
  assert.ok(Number.isFinite(Date.parse(register.createdAt)));
  assert.ok(Number.isFinite(Date.parse(register.source.calculatedAt)));
  assert.equal(register.source.result.score, calculation.result.score);
  assert.equal(register.source.result.totalCost, calculation.result.totalCost);
  assert.equal(register.actions.length, 5);
  assert.equal(new Set(register.actions.map((action) => action.id)).size, 5);
  for (const decision of scenario.decisions) {
    const action = register.actions.find(({ measureId }) => measureId === decision.measureId);
    assert.ok(action);
    assert.equal(action.measureName, dataset.measures.find(({ id }) => id === decision.measureId).name);
    assert.equal(action.districtId, decision.districtId);
    if (decision.districtId) assert.equal(action.districtName, dataset.districts.find(({ id }) => id === decision.districtId).name);
    assert.equal(action.owner, '');
    assert.equal(action.dueDate, '');
    assert.equal(action.criterion, '');
    assert.equal(action.evidence, '');
    assert.equal(action.status, 'draft');
    assert.ok(ui.container.textContent.includes(action.measureName));
  }
  assert.match(ui.container.textContent, /Локальный черновик в этом браузере/);
  assert.match(ui.container.textContent, /Не отправлено исполнителям/);
  assert.match(ui.container.textContent, /Нет синхронизации и официального согласования/);
  ui.mount.dispose();
});

test('late mount requires explicit city availability and a fresh calculation', () => {
  for (const unavailableCity of [undefined, null, {}, { ...city, hasScenarioData: false }, { ...city, hasScenarioData: 'true' }]) {
    const ui = setup({ city: unavailableCity });
    ui.emit('scenario:calculated', structuredClone(calculation));
    assert.equal(ui.button().disabled, true);
    ui.button().click();
    assert.equal(ui.cards().length, 0);
    ui.emit('city:changed', structuredClone(city));
    assert.equal(ui.button().disabled, true, 'a city event alone must not restore an old result');
    create(ui);
    assert.equal(ui.cards().length, 5);
    ui.mount.dispose();
  }
});

test('malformed or unsuccessful events cannot authorize draft generation', () => {
  const malformed = [
    null, {}, { scenario, result: { valid: false } },
    { scenario, result: { ...calculation.result, score: NaN } },
    { scenario, result: { ...calculation.result, totalCost: '99' } },
    { scenario: { decisions: scenario.decisions.slice(1) }, result: calculation.result },
    { scenario: { decisions: [...scenario.decisions.slice(1), scenario.decisions[1]] }, result: calculation.result },
    { scenario: { decisions: [{ measureId: 'unknown', districtId: 'nura' }, ...scenario.decisions.slice(1)] }, result: calculation.result },
  ];
  for (const detail of malformed) {
    const ui = setup();
    ui.emit('scenario:calculated', structuredClone(calculation));
    ui.emit('scenario:calculated', structuredClone(detail));
    assert.equal(ui.button().disabled, true, JSON.stringify(detail));
    assert.equal(ui.cards().length, 0);
    ui.mount.dispose();
  }
});

test('calculation and city snapshots remain independent of caller mutations', () => {
  const mutableCity = structuredClone(city);
  const detail = structuredClone(calculation);
  const ui = setup({ city: mutableCity });
  ui.emit('scenario:calculated', detail);
  detail.scenario.decisions[0].measureId = 'M1';
  detail.result.score = 999;
  mutableCity.name = 'CHANGED CITY';
  ui.button().click();
  const [register] = ui.saved().registers;
  assert.deepEqual(register.source.scenario, scenario);
  assert.equal(register.source.result.score, calculation.result.score);
  assert.equal(register.source.city.name, 'Астана');
  ui.mount.dispose();
});

test('double clicks and reordered identical decisions cannot create duplicate registers', () => {
  const ui = setup();
  ui.emit('scenario:calculated', structuredClone(calculation));
  const button = ui.button();
  button.click();
  button.click();
  assert.equal(ui.saved().registers.length, 1);
  const reordered = structuredClone(calculation);
  reordered.scenario.decisions.reverse();
  ui.emit('scenario:calculated', reordered);
  ui.button().click();
  assert.equal(ui.saved().registers.length, 1);
  assert.equal(ui.cards().length, 5);
  ui.mount.dispose();
});

test('manual transitions require a responsible person, real calendar deadline and completion evidence', () => {
  const ui = setup();
  create(ui);
  const card = ui.cards()[0];
  const state = field(card, 'state');
  select(card, 'in_progress');
  assert.equal(state.value, 'draft');
  assert.match(field(card, 'validation').textContent, /ответственн|срок/i);
  edit(field(card, 'owner'), '   ');
  edit(field(card, 'due'), '2026-09-25');
  select(card, 'in_progress');
  assert.equal(state.value, 'draft');
  edit(field(card, 'owner'), 'Ответственный, указанный пользователем');
  for (const invalidDate of ['2026-02-30', '2026-13-01', '2026-00-10', '23.09.2026']) {
    edit(field(card, 'due'), '');
    edit(field(card, 'due'), invalidDate);
    select(card, 'in_progress');
    assert.equal(state.value, 'draft', invalidDate);
  }
  edit(field(card, 'due'), '2028-02-29');
  edit(field(card, 'criterion'), 'Проверить акт приёмки');
  select(card, 'in_progress');
  assert.equal(state.value, 'in_progress');
  select(card, 'completed');
  assert.equal(state.value, 'in_progress');
  edit(field(card, 'evidence'), '  ');
  select(card, 'completed');
  assert.equal(state.value, 'in_progress');
  edit(field(card, 'evidence'), 'Вручную указан результат и ссылка на проверку');
  select(card, 'completed');
  assert.equal(state.value, 'completed');
  assert.equal(ui.saved().registers[0].actions[0].status, 'completed');
  assert.equal(ui.saved().registers[0].actions[0].criterion, 'Проверить акт приёмки');
  for (const name of ['owner', 'due', 'evidence']) {
    const previous = field(card, name).value;
    edit(field(card, name), '');
    assert.equal(field(card, name).value, previous, `completed ${name} must retain its required value`);
    assert.equal(state.value, 'completed');
    assert.match(field(card, 'validation').textContent, /Черновик/);
  }
  select(card, 'deferred');
  assert.equal(state.value, 'deferred');
  select(card, 'draft');
  assert.equal(state.value, 'draft');
  ui.mount.dispose();
});

test('editing saves immediately without replacing the focused input or its card', () => {
  const ui = setup();
  create(ui);
  const card = ui.cards()[0];
  const owner = field(card, 'owner');
  owner.focus();
  edit(owner, 'Ручной ответственный');
  assert.equal(ui.cards()[0], card);
  assert.equal(field(ui.cards()[0], 'owner'), owner);
  assert.equal(ui.container.ownerDocument.activeElement, owner);
  assert.equal(ui.saved().registers[0].actions[0].owner, 'Ручной ответственный');
  ui.mount.dispose();
});

test('invalidation and city changes preserve manual edits but require another current calculation', () => {
  const ui = setup();
  create(ui);
  edit(field(ui.cards()[0], 'owner'), 'Сохранить это имя');
  edit(field(ui.cards()[0], 'criterion'), 'Сохранить этот критерий');
  const initial = ui.saved();
  ui.emit('scenario:invalidated');
  assert.equal(ui.button().disabled, true);
  assert.equal(ui.cards().length, 5);
  assert.equal(field(ui.cards()[0], 'owner').value, 'Сохранить это имя');
  ui.emit('city:changed', { id: 'almaty', name: 'Алматы', hasScenarioData: false });
  ui.emit('scenario:calculated', structuredClone(calculation));
  assert.equal(ui.button().disabled, true);
  assert.deepEqual(ui.saved(), initial);
  ui.emit('city:changed', structuredClone(city));
  assert.equal(ui.button().disabled, true);
  const changed = structuredClone(scenario);
  changed.decisions[0].districtId = 'esil';
  create(ui, { scenario: changed, result: simulate(changed) });
  assert.equal(ui.saved().registers.length, 2);
  assert.deepEqual(ui.saved().registers.find(({ id }) => id === initial.registers[0].id), initial.registers[0]);
  ui.mount.dispose();
});

test('reload restores the register and manual values without making a source result current', () => {
  const storage = memoryStorage();
  const first = setup({ storage });
  create(first);
  const card = first.cards()[1];
  edit(field(card, 'owner'), 'Пользовательский ввод');
  edit(field(card, 'due'), '2027-01-01');
  edit(field(card, 'criterion'), 'Проверяемый результат');
  select(card, 'in_progress');
  const snapshot = first.saved();
  first.mount.dispose();
  const second = setup({ storage });
  assert.equal(second.cards().length, 5);
  assert.equal(second.button().disabled, true);
  assert.equal(field(second.cards()[1], 'owner').value, 'Пользовательский ввод');
  assert.equal(field(second.cards()[1], 'due').value, '2027-01-01');
  assert.equal(field(second.cards()[1], 'state').value, 'in_progress');
  assert.deepEqual(second.saved(), snapshot);
  second.emit('scenario:calculated', structuredClone(calculation));
  second.button().click();
  assert.equal(second.saved().registers.length, 1);
  second.mount.dispose();
});

test('corrupt or unsupported stored documents are surfaced and never silently overwritten', () => {
  for (const raw of ['{broken', 'null', '[]', '{"schemaVersion":99,"registers":[]}', '{"schemaVersion":1,"registers":[{}]}']) {
    const storage = memoryStorage(raw);
    const ui = setup({ storage });
    assert.equal(ui.cards().length, 0);
    assert.match(ui.storageMessage(), /поврежд|формат|прочит|некоррект|неподдерж/i);
    ui.emit('scenario:calculated', structuredClone(calculation));
    ui.button().click();
    assert.equal(storage.getItem(STORAGE_KEY), raw);
    assert.equal(storage.writes, 0);
    ui.mount.dispose();
  }
});

test('structural corruption inside a stored register is rejected without losing the original document', () => {
  const seed = setup();
  create(seed);
  const valid = seed.saved();
  seed.mount.dispose();
  for (const mutate of [
    (data) => { data.registers[0].actions[0].status = 'completed'; },
    (data) => { data.registers[0].actions[0].dueDate = '2026-02-30'; },
    (data) => { data.registers[0].actions[0].owner = 'x'.repeat(161); },
    (data) => { data.registers[0].actions[0].measureId = 'M1'; },
    (data) => { data.registers[0].actions[0].id = data.registers[0].actions[1].id; },
    (data) => { data.registers[0].sourceKey = 'different scenario'; },
    (data) => { data.registers[0].source.result.score = null; },
    (data) => { data.registers[0].source.scenario.decisions.pop(); },
    (data) => { data.registers.push(structuredClone(data.registers[0])); },
  ]) {
    const corrupted = structuredClone(valid);
    mutate(corrupted);
    const raw = JSON.stringify(corrupted);
    const storage = memoryStorage(raw);
    const ui = setup({ storage });
    assert.equal(ui.cards().length, 0);
    assert.match(ui.storageMessage(), /поврежд|формат|прочит|некоррект|неподдерж/i);
    ui.emit('scenario:calculated', structuredClone(calculation));
    ui.button().click();
    assert.equal(storage.getItem(STORAGE_KEY), raw);
    assert.equal(storage.writes, 0);
    ui.mount.dispose();
  }
});

test('another tab cannot be overwritten by an edit from a stale register', () => {
  const storage = memoryStorage();
  const ui = setup({ storage });
  create(ui);
  const remote = ui.saved();
  remote.registers[0].actions[1].owner = 'Имя из другой вкладки';
  const remoteRaw = JSON.stringify(remote);
  storage.setItem(STORAGE_KEY, remoteRaw);
  edit(field(ui.cards()[0], 'owner'), 'Моя несохранённая правка');
  assert.equal(storage.getItem(STORAGE_KEY), remoteRaw);
  assert.equal(field(ui.cards()[0], 'owner').value, 'Моя несохранённая правка');
  assert.match(ui.storageMessage(), /другой вкладке/);
  assert.match(ui.storageMessage(), /памяти|экспорт/i);
  edit(field(ui.cards()[0], 'criterion'), 'Ещё одна правка после конфликта');
  assert.equal(storage.getItem(STORAGE_KEY), remoteRaw);
  ui.mount.dispose();
});

test('localStorage access failures and quota failures keep useful in-memory drafts and explain the loss of persistence', () => {
  const inaccessible = setup({ storageGetter: () => { throw new DOMException('Blocked', 'SecurityError'); } });
  assert.match(inaccessible.storageMessage(), /недоступ|запрещ|не сохран/i);
  create(inaccessible);
  assert.equal(inaccessible.cards().length, 5);
  edit(field(inaccessible.cards()[0], 'owner'), 'Не терять в текущем сеансе');
  assert.equal(field(inaccessible.cards()[0], 'owner').value, 'Не терять в текущем сеансе');
  inaccessible.mount.dispose();

  const storage = memoryStorage();
  storage.setItem = () => { throw new DOMException('Full', 'QuotaExceededError'); };
  const full = setup({ storage });
  create(full);
  assert.equal(full.cards().length, 5);
  assert.match(full.storageMessage(), /мест|квот|переполн|не сохран/i);
  assert.equal(storage.getItem(STORAGE_KEY), null);
  full.mount.dispose();
});

test('overdue totals compare local calendar dates and exclude completed actions', () => {
  const ui = setup();
  create(ui);
  const localDate = new Date();
  const today = [localDate.getFullYear(), String(localDate.getMonth() + 1).padStart(2, '0'), String(localDate.getDate()).padStart(2, '0')].join('-');
  for (const card of ui.cards()) edit(field(card, 'owner'), 'Ответственный');
  edit(field(ui.cards()[0], 'due'), '2000-01-01');
  select(ui.cards()[0], 'in_progress');
  edit(field(ui.cards()[1], 'due'), today);
  select(ui.cards()[1], 'in_progress');
  edit(field(ui.cards()[2], 'due'), '2000-01-01');
  edit(field(ui.cards()[2], 'evidence'), 'Подтверждено вручную');
  select(ui.cards()[2], 'completed');
  assert.match(ui.summary(), /Просрочен[^:]*:\s*1/i);
  ui.mount.dispose();
});

test('calendar day boundaries use local dates in both positive and negative UTC offsets', () => {
  const previousTimezone = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    const westernToday = localDate(new Date('2026-09-23T01:00:00Z'));
    assert.equal(westernToday, '2026-09-22');
    assert.equal(isOverdue({ status: 'in_progress', dueDate: '2026-09-22' }, westernToday), false);
    assert.equal(isOverdue({ status: 'in_progress', dueDate: '2026-09-21' }, westernToday), true);
    process.env.TZ = 'Pacific/Kiritimati';
    const easternToday = localDate(new Date('2026-09-23T23:00:00Z'));
    assert.equal(easternToday, '2026-09-24');
    assert.equal(isOverdue({ status: 'in_progress', dueDate: '2026-09-23' }, easternToday), true);
    assert.equal(isOverdue({ status: 'completed', dueDate: '2026-09-23' }, easternToday), false);
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test('CSV keeps multiline manual text and quotes intact while neutralizing spreadsheet formulas', () => {
  const ui = setup();
  create(ui);
  edit(field(ui.cards()[0], 'owner'), '=HYPERLINK("https://example.invalid","test")');
  edit(field(ui.cards()[0], 'criterion'), 'Первый пункт, с запятой\nВторой "пункт"');
  edit(field(ui.cards()[0], 'evidence'), '@formula');
  const output = registerCsv(ui.saved().registers);
  assert.equal(output[0], '\uFEFF');
  const rows = [];
  let row = [], value = '', quoted = false;
  const csv = output.slice(1);
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (character === '"') {
      if (quoted && csv[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) { row.push(value); value = ''; }
    else if (character === '\r' && !quoted && csv[index + 1] === '\n') {
      row.push(value); rows.push(row); row = []; value = ''; index += 1;
    } else value += character;
  }
  row.push(value); rows.push(row);
  assert.equal(rows.length, 6);
  assert.ok(rows.every((item) => item.length === 11));
  assert.equal(rows[1][5], '\'=HYPERLINK("https://example.invalid","test")');
  assert.equal(rows[1][7], 'Первый пункт, с запятой\nВторой "пункт"');
  assert.equal(rows[1][9], "'@formula");
  assert.deepEqual(JSON.parse(rows[1][10]), scenario);
  ui.mount.dispose();
});

test('one register deletion requires a second explicit confirmation and can be cancelled', () => {
  const ui = setup();
  create(ui);
  edit(field(ui.cards()[0], 'owner'), 'Неслучайные данные');
  byClass(ui.container, 'action-register-delete')[0].click();
  assert.equal(ui.cards().length, 5);
  assert.equal(ui.saved().registers.length, 1);
  byClass(ui.container, 'action-register-delete-cancel')[0].click();
  assert.equal(ui.cards().length, 5);
  assert.equal(field(ui.cards()[0], 'owner').value, 'Неслучайные данные');
  byClass(ui.container, 'action-register-delete')[0].click();
  byClass(ui.container, 'action-register-delete-confirm')[0].click();
  assert.equal(ui.cards().length, 0);
  assert.equal(ui.saved().registers.length, 0);
  ui.mount.dispose();
});

test('dataset labels and stored manual input stay inert text after reload', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const modifiedDataset = structuredClone(dataset);
  modifiedDataset.measures.find(({ id }) => id === 'M7').name = hostile;
  const storage = memoryStorage();
  const ui = setup({ dataset: modifiedDataset, storage });
  create(ui);
  assert.ok(ui.container.textContent.includes(hostile));
  for (const name of ['owner', 'criterion', 'evidence']) edit(field(ui.cards()[0], name), hostile);
  ui.mount.dispose();
  const restored = setup({ dataset: modifiedDataset, storage });
  assert.equal(field(restored.cards()[0], 'owner').value, hostile);
  assert.equal(field(restored.cards()[0], 'criterion').value, hostile);
  assert.equal(field(restored.cards()[0], 'evidence').value, hostile);
  assert.equal(all(restored.container).some(({ tagName }) => tagName === 'img'), false);
  restored.mount.dispose();
});

test('ten-register limit preserves all existing entries and disables further generation', () => {
  const ui = setup();
  let count = 0;
  for (const first of dataset.districts) {
    for (const second of dataset.districts) {
      const next = structuredClone(scenario);
      next.decisions[0].districtId = first.id;
      next.decisions[1].districtId = second.id;
      const result = simulate(next);
      assert.equal(result.valid, true);
      if (count === 10) {
        const before = ui.saved();
        ui.emit('scenario:calculated', { scenario: next, result });
        assert.equal(ui.button().disabled, true);
        ui.button().click();
        assert.deepEqual(ui.saved(), before);
        assert.equal(ui.cards().length, 50);
        ui.mount.dispose();
        return;
      }
      create(ui, { scenario: next, result });
      count += 1;
      assert.equal(ui.saved().registers.length, count);
    }
  }
  assert.fail('fixture did not produce enough distinct valid scenarios');
});

test('dispose detaches scenario and city listeners and stays idempotent', () => {
  const ui = setup();
  create(ui);
  assert.ok(ui.window.listenerCount >= 3);
  const before = ui.saved();
  ui.mount.dispose();
  assert.equal(ui.window.listenerCount, 0);
  const renderedAfterDispose = ui.container.textContent;
  ui.emit('scenario:calculated', structuredClone(calculation));
  ui.emit('scenario:invalidated');
  ui.emit('city:changed', structuredClone(city));
  assert.equal(ui.container.textContent, renderedAfterDispose);
  assert.deepEqual(ui.saved(), before);
  assert.doesNotThrow(() => ui.mount.dispose());
});
