import test from 'node:test';
import assert from 'node:assert/strict';
import { mountActionRegister, registerCsv } from '../public/action-register.js';
import { getDataset, simulate } from '../src/core/simulator.js';

const KEY = 'akim-action-register-v1';
const dataset = getDataset();
const city = { id: 'astana', name: 'Астана', hasScenarioData: true };
const scenario = { decisions: [
  { measureId: 'M7', districtId: 'nura' }, { measureId: 'M8', districtId: 'nura' },
  { measureId: 'M10', districtId: 'nura' }, { measureId: 'M12' },
  { measureId: 'M5', districtId: 'saryarka' },
] };
const result = simulate(scenario);
assert.equal(result.valid, true);
const emptyPassport = () => ({
  siteAddress: '', siteBasis: '', siteSourceUrl: '',
  kpi: { name: '', unit: '', baseline: null, target: null, source: '' },
  budget: { capexKzt: null, opexKzt: null, estimateSource: '', estimateDate: '' },
  prerequisites: '', nextStep: '',
});

// No real browser globals, network or storage are involved in these contract tests.
class Element extends EventTarget {
  constructor(tagName, document) {
    super();
    Object.assign(this, { tagName, ownerDocument: document, children: [], className: '', attributes: {},
      value: '', ownText: '', disabled: false, hidden: false, open: false, dataset: {}, style: {} });
  }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { this.children = []; this.ownText = ''; this.append(...nodes); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((node) => node !== this); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  get textContent() { return this.ownText + this.children.map((node) => node.textContent).join(' '); }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  set innerHTML(_value) { throw new Error('Manual passport input must not reach innerHTML'); }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  focus() { this.ownerDocument.activeElement = this; }
}
const all = (node) => [node, ...node.children.flatMap(all)];
const matches = (node, name) => all(node).filter((element) => element.className.split(/\s+/).includes(`action-register-${name}`));
function field(node, name) {
  const control = matches(node, name)[0];
  assert.ok(control, `Missing action-register-${name}`);
  return control;
}
function edit(node, name, value, event = 'input') {
  const control = field(node, name);
  control.value = value;
  control.dispatchEvent(new Event(event));
  return control;
}
function storageWith(raw) {
  const values = new Map(raw === undefined ? [] : [[KEY, raw]]);
  return {
    writes: 0,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { this.writes += 1; values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}
function setup(storage = storageWith()) {
  const window = new EventTarget();
  Object.assign(window, { localStorage: storage, CustomEvent, setTimeout, clearTimeout });
  const document = { defaultView: window, createElement: (tag) => new Element(tag, document) };
  document.body = new Element('body', document);
  const container = new Element('div', document);
  const mount = mountActionRegister(container, { dataset: structuredClone(dataset), city: structuredClone(city) });
  return {
    window, container, storage, mount,
    cards: () => matches(container, 'card'),
    saved: () => JSON.parse(storage.getItem(KEY)),
    emit: (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail })),
  };
}
function create(ui) {
  ui.emit('scenario:calculated', structuredClone({ scenario, result }));
  field(ui.container, 'create').click();
  assert.equal(ui.cards().length, 5);
}
function legacyDocument() {
  const labels = scenario.decisions.map((decision) => ({ ...decision,
    measureName: dataset.measures.find(({ id }) => id === decision.measureId).name,
    districtName: dataset.districts.find(({ id }) => id === decision.districtId)?.name ?? 'Весь город',
  }));
  const actions = labels.map((label, index) => ({
    id: `legacy-action-${index}`, ...label, owner: index < 2 ? `Ручной ответственный ${index}` : '',
    dueDate: index < 2 ? '2026-09-30' : '', criterion: `Старый критерий ${index}`,
    status: ['completed', 'in_progress', 'deferred', 'draft', 'draft'][index],
    evidence: index === 0 ? 'Сохранённое подтверждение: документ от пользователя' : '',
  }));
  return { schemaVersion: 1, registers: [{
    id: 'legacy-register', sourceKey: JSON.stringify([city.id, scenario.decisions.map(({ measureId, districtId }) => [measureId, districtId ?? null]).sort((a, b) => a[0].localeCompare(b[0]))]),
    createdAt: '2026-09-23T10:10:00.000Z', source: {
      city: { id: city.id, name: city.name }, scenario: structuredClone(scenario),
      result: Object.fromEntries(['valid', 'score', 'totalCost', 'remainingBudget', 'criticalCount'].map((key) => [key, result[key]])),
      calculatedAt: '2026-09-23T10:09:59.000Z', labels,
    }, actions,
  }] };
}
const filledPassport = {
  siteAddress: 'Адрес, введённый человеком', siteBasis: 'Основание выбора площадки из обследования',
  siteSourceUrl: 'https://example.invalid/source?place=1',
  kpi: { name: 'Показатель из ручного источника', unit: 'единиц', baseline: -2.5, target: 0, source: 'Ручной источник KPI' },
  budget: { capexKzt: 0, opexKzt: 1250.5, estimateSource: 'Введённая смета', estimateDate: '2028-02-29' },
  prerequisites: 'Зависимость, определённая человеком', nextStep: 'Проверить исходные документы',
};
const passportInputs = [
  ['site-address', 'siteAddress'], ['site-basis', 'siteBasis'], ['site-source', 'siteSourceUrl'],
  ['kpi-name', 'kpi.name'], ['kpi-unit', 'kpi.unit'], ['kpi-baseline', 'kpi.baseline'],
  ['kpi-target', 'kpi.target'], ['kpi-source', 'kpi.source'], ['capex', 'budget.capexKzt'],
  ['opex', 'budget.opexKzt'], ['estimate-source', 'budget.estimateSource'],
  ['estimate-date', 'budget.estimateDate'], ['prerequisites', 'prerequisites'], ['next-step', 'nextStep'],
];
const atPath = (value, path) => path.split('.').reduce((entry, key) => entry[key], value);
function fillPassport(card, passport = filledPassport) {
  passportInputs.forEach(([name, path], index) => {
    const value = atPath(passport, path);
    edit(card, name, value === null ? '' : String(value), index % 2 === 0 ? 'input' : 'change');
  });
}

test('new actions have empty optional passports and never infer KZT or KPIs from model values', () => {
  const ui = setup();
  create(ui);
  assert.equal(ui.saved().schemaVersion, 2);
  assert.ok(ui.saved().registers[0].source.result.totalCost > 0);
  for (const [index, action] of ui.saved().registers[0].actions.entries()) {
    assert.deepEqual(action.implementation, emptyPassport());
    const section = field(ui.cards()[index], 'implementation');
    assert.equal(section.tagName, 'details');
    assert.equal(section.open, false);
    for (const [name] of passportInputs) {
      const control = field(section, name);
      assert.equal(control.value, '');
      assert.ok(control.getAttribute('aria-label')?.trim(), `Accessible label for ${name}`);
    }
    assert.equal(action.status, 'draft');
  }
  ui.mount.dispose();
});

test('v1 migration preserves complete manual records and source snapshots without writing until an edit', () => {
  const legacy = legacyDocument();
  const raw = JSON.stringify(legacy);
  const storage = storageWith(raw);
  const ui = setup(storage);
  assert.equal(ui.cards().length, 5);
  assert.equal(storage.getItem(KEY), raw);
  assert.equal(storage.writes, 0);
  assert.equal(field(ui.cards()[0], 'state').value, 'completed');
  assert.equal(field(ui.cards()[0], 'evidence').value, legacy.registers[0].actions[0].evidence);
  for (const card of ui.cards()) for (const [name] of passportInputs) assert.equal(field(card, name).value, '');
  edit(ui.cards()[2], 'next-step', 'Добавлено после миграции');
  const migrated = ui.saved();
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(storage.writes, 1);
  const withoutPassports = structuredClone(migrated);
  withoutPassports.schemaVersion = 1;
  for (const action of withoutPassports.registers[0].actions) delete action.implementation;
  assert.deepEqual(withoutPassports, legacy);
  for (const [index, action] of migrated.registers[0].actions.entries()) {
    assert.deepEqual(action.implementation, { ...emptyPassport(), nextStep: index === 2 ? 'Добавлено после миграции' : '' });
  }
  ui.mount.dispose();
});

test('every passport field persists through input or change without replacing controls and reloads in v2', () => {
  const storage = storageWith();
  const ui = setup(storage);
  create(ui);
  const card = ui.cards()[0];
  const section = field(card, 'implementation');
  section.open = true;
  const baselineControl = field(card, 'kpi-baseline');
  baselineControl.focus();
  fillPassport(card);
  assert.deepEqual(ui.saved().registers[0].actions[0].implementation, filledPassport);
  assert.equal(ui.cards()[0], card);
  assert.equal(field(card, 'implementation'), section);
  assert.equal(section.open, true);
  assert.equal(field(card, 'kpi-baseline'), baselineControl);
  assert.equal(ui.container.ownerDocument.activeElement, baselineControl);
  assert.deepEqual(ui.saved().registers[0].actions[1].implementation, emptyPassport(), 'each action owns an independent passport');
  const snapshot = ui.saved();
  ui.mount.dispose();
  const restored = setup(storage);
  assert.deepEqual(restored.saved(), snapshot);
  for (const [name, path] of passportInputs) assert.equal(field(restored.cards()[0], name).value, String(atPath(filledPassport, path)));
  assert.equal(field(restored.container, 'create').disabled, true);
  restored.mount.dispose();
});

test('empty numbers remain null while an explicitly entered zero survives storage and reload', () => {
  const storage = storageWith();
  const ui = setup(storage);
  create(ui);
  const card = ui.cards()[0];
  for (const [name, path] of passportInputs.filter(([name]) => ['kpi-baseline', 'kpi-target', 'capex', 'opex'].includes(name))) {
    assert.equal(atPath(ui.saved().registers[0].actions[0].implementation, path), null);
    edit(card, name, '0');
    assert.equal(atPath(ui.saved().registers[0].actions[0].implementation, path), 0);
    edit(card, name, '');
    assert.equal(atPath(ui.saved().registers[0].actions[0].implementation, path), null);
    edit(card, name, '0', 'change');
  }
  ui.mount.dispose();
  const restored = setup(storage);
  for (const name of ['kpi-baseline', 'kpi-target', 'capex', 'opex']) assert.equal(field(restored.cards()[0], name).value, '0');
  restored.mount.dispose();
});

test('numeric edits reject non-finite, unsafe and negative KZT values without changing saved values', () => {
  const ui = setup();
  create(ui);
  const card = ui.cards()[0];
  for (const [name, path] of passportInputs.filter(([name]) => ['kpi-baseline', 'kpi-target', 'capex', 'opex'].includes(name))) {
    edit(card, name, '12.5');
    const invalid = ['NaN', 'Infinity', '-Infinity', '1e309', 'not a number', '9007199254740992', '-9007199254740992'];
    if (name === 'capex' || name === 'opex') invalid.push('-1', '-0.25');
    for (const value of invalid) {
      edit(card, name, value, 'change');
      assert.equal(atPath(ui.saved().registers[0].actions[0].implementation, path), 12.5, `${name}: ${value}`);
      assert.equal(field(card, name).value, '12.5', `${name}: invalid input visibly restored`);
    }
    edit(card, name, String(Number.MAX_SAFE_INTEGER));
    assert.equal(atPath(ui.saved().registers[0].actions[0].implementation, path), Number.MAX_SAFE_INTEGER);
  }
  edit(card, 'kpi-baseline', '-123.5');
  edit(card, 'kpi-target', '-10');
  assert.equal(ui.saved().registers[0].actions[0].implementation.kpi.baseline, -123.5);
  assert.equal(ui.saved().registers[0].actions[0].implementation.kpi.target, -10);
  ui.mount.dispose();
});

test('source URL and estimate date accept only allowed values and are never fetched or navigated', () => {
  const ui = setup();
  let requests = 0;
  let navigations = 0;
  ui.window.fetch = () => { requests += 1; throw new Error('No network is allowed'); };
  ui.window.open = () => { navigations += 1; throw new Error('No navigation is allowed'); };
  create(ui);
  const card = ui.cards()[0];
  for (const accepted of ['https://example.invalid/document', 'http://example.invalid/source']) {
    edit(card, 'site-source', accepted);
    assert.equal(ui.saved().registers[0].actions[0].implementation.siteSourceUrl, accepted);
  }
  for (const rejected of ['javascript:alert(1)', 'data:text/html,test', 'file:///C:/secret', '//example.invalid', 'not a URL']) {
    edit(card, 'site-source', rejected, 'change');
    assert.equal(field(card, 'site-source').value, 'http://example.invalid/source');
    assert.equal(ui.saved().registers[0].actions[0].implementation.siteSourceUrl, 'http://example.invalid/source');
  }
  edit(card, 'estimate-date', '2028-02-29');
  for (const rejected of ['2026-02-29', '2026-02-30', '2026-13-01', '0000-01-01', '2026-9-1', '23.09.2026']) {
    edit(card, 'estimate-date', rejected, 'change');
    assert.equal(field(card, 'estimate-date').value, '2028-02-29');
  }
  edit(card, 'site-source', '');
  edit(card, 'estimate-date', '');
  assert.equal(ui.saved().registers[0].actions[0].implementation.siteSourceUrl, '');
  assert.equal(ui.saved().registers[0].actions[0].implementation.budget.estimateDate, '');
  assert.equal(requests, 0);
  assert.equal(navigations, 0);
  ui.mount.dispose();
});

test('partially typed URLs remain editable but are not saved until valid or committed', () => {
  const ui = setup();
  create(ui);
  const card = ui.cards()[0];
  const input = field(card, 'site-source');
  input.focus();
  for (const partial of ['h', 'ht', 'htt', 'https', 'https:', 'https:/', 'https://']) {
    edit(card, 'site-source', partial);
    assert.equal(input.value, partial);
    assert.equal(ui.saved().registers[0].actions[0].implementation.siteSourceUrl, '');
    assert.equal(field(card, 'site-source'), input);
    assert.equal(ui.container.ownerDocument.activeElement, input);
  }
  edit(card, 'site-source', 'https://example.invalid/source');
  assert.equal(ui.saved().registers[0].actions[0].implementation.siteSourceUrl, 'https://example.invalid/source');
  edit(card, 'site-source', 'https://');
  assert.equal(input.value, 'https://');
  assert.equal(ui.saved().registers[0].actions[0].implementation.siteSourceUrl, 'https://example.invalid/source');
  edit(card, 'site-source', 'https://', 'change');
  assert.equal(input.value, 'https://example.invalid/source');
  ui.mount.dispose();
});

test('malformed v2 passports reject the stored document without silently migrating or overwriting it', () => {
  const seed = setup();
  create(seed);
  const valid = seed.saved();
  seed.mount.dispose();
  for (const mutate of [
    (action) => { delete action.implementation; },
    (action) => { action.implementation = null; },
    (action) => { action.implementation = []; },
    (action) => { delete action.implementation.kpi; },
    (action) => { action.implementation.kpi.baseline = '0'; },
    (action) => { action.implementation.kpi.target = Number.MAX_SAFE_INTEGER + 1; },
    (action) => { action.implementation.budget.capexKzt = -1; },
    (action) => { action.implementation.budget.opexKzt = '10'; },
    (action) => { action.implementation.siteAddress = {}; },
    (action) => { action.implementation.siteSourceUrl = 'javascript:alert(1)'; },
    (action) => { action.implementation.budget.estimateDate = '2026-02-30'; },
    (action) => { delete action.implementation.nextStep; },
  ]) {
    const corrupted = structuredClone(valid);
    mutate(corrupted.registers[0].actions[0]);
    const raw = JSON.stringify(corrupted);
    const storage = storageWith(raw);
    const ui = setup(storage);
    assert.equal(ui.cards().length, 0);
    assert.match(field(ui.container, 'storage').textContent, /поврежд|формат|неизвестн/i);
    create(ui);
    edit(ui.cards()[0], 'site-address', 'Локальная правка после повреждения');
    assert.equal(storage.getItem(KEY), raw);
    assert.equal(storage.writes, 0);
    ui.mount.dispose();
  }
});

test('readiness lists missing manual inputs and updates without blocking statuses or proving completion', () => {
  const ui = setup();
  create(ui);
  const card = ui.cards()[0];
  const before = field(card, 'readiness').textContent;
  assert.match(before, /адрес|площад/i);
  assert.match(before, /KPI/i);
  assert.match(before, /CAPEX/i);
  assert.match(before, /OPEX/i);
  edit(card, 'site-address', filledPassport.siteAddress);
  assert.notEqual(field(card, 'readiness').textContent, before);
  edit(card, 'owner', 'Ответственный вручную');
  edit(card, 'due', '2026-10-01');
  edit(card, 'criterion', 'Критерий, указанный вручную');
  edit(card, 'state', 'in_progress', 'change');
  assert.equal(field(card, 'state').value, 'in_progress', 'an incomplete optional passport is advisory');
  fillPassport(card);
  const complete = field(card, 'readiness').textContent;
  assert.notEqual(complete, before);
  assert.match(complete, /заполн|готов|достаточ|нет недостающ/i);
  assert.equal(field(card, 'state').value, 'in_progress', 'filling a passport must not claim work is completed');
  edit(card, 'state', 'completed', 'change');
  assert.equal(field(card, 'state').value, 'in_progress');
  edit(card, 'evidence', 'Результат, подтверждённый пользователем');
  edit(card, 'state', 'completed', 'change');
  assert.equal(field(card, 'state').value, 'completed');
  edit(card, 'capex', '');
  assert.equal(ui.saved().registers[0].actions[0].implementation.budget.capexKzt, null);
  assert.match(field(card, 'readiness').textContent, /CAPEX/i);
  assert.equal(field(card, 'state').value, 'completed', 'optional passport values do not change manual status');
  ui.mount.dispose();
});

test('passport data and source references remain independent across recalculation and city changes', () => {
  const ui = setup();
  create(ui);
  fillPassport(ui.cards()[0]);
  const original = ui.saved().registers[0];
  ui.emit('scenario:invalidated');
  ui.emit('city:changed', { id: 'almaty', name: 'Алматы', hasScenarioData: false });
  assert.equal(field(ui.container, 'create').disabled, true);
  assert.deepEqual(ui.saved().registers[0], original);
  ui.emit('city:changed', structuredClone(city));
  const changed = structuredClone(scenario);
  changed.decisions[0].districtId = 'esil';
  ui.emit('scenario:calculated', { scenario: changed, result: simulate(changed) });
  field(ui.container, 'create').click();
  assert.equal(ui.saved().registers.length, 2);
  const savedOriginal = ui.saved().registers.find(({ id }) => id === original.id);
  const newlyCreated = ui.saved().registers.find(({ id }) => id !== original.id);
  assert.deepEqual(savedOriginal, original);
  assert.deepEqual(newlyCreated.actions[0].implementation, emptyPassport());
  ui.mount.dispose();
});

function parseCsv(csv) {
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let index = csv.charCodeAt(0) === 0xFEFF ? 1 : 0; index < csv.length; index += 1) {
    const char = csv[index];
    if (char === '"') {
      if (quoted && csv[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(value); value = ''; }
    else if (char === '\r' && !quoted && csv[index + 1] === '\n') {
      row.push(value); rows.push(row); row = []; value = ''; index += 1;
    } else value += char;
  }
  row.push(value); rows.push(row);
  return rows;
}

test('CSV exports all 14 passport fields, preserves zero/null and escapes multiline text and formulas', () => {
  const ui = setup();
  create(ui);
  const exported = structuredClone(filledPassport);
  exported.siteAddress = '=WEBSERVICE("https://example.invalid")';
  exported.siteBasis = 'Первая строка, с запятой\nВторая "строка"';
  exported.kpi.name = '@formula';
  exported.kpi.baseline = null;
  exported.budget.opexKzt = null;
  exported.nextStep = '+formula';
  fillPassport(ui.cards()[0], exported);
  const rows = parseCsv(registerCsv(ui.saved().registers));
  assert.equal(rows.length, 6);
  assert.ok(rows.every((row) => row.length === 25));
  assert.deepEqual(rows[1].slice(11), [
    `'${exported.siteAddress}`, exported.siteBasis, exported.siteSourceUrl,
    `'${exported.kpi.name}`, exported.kpi.unit, '', '0', exported.kpi.source,
    '0', '', exported.budget.estimateSource, exported.budget.estimateDate,
    exported.prerequisites, `'${exported.nextStep}`,
  ]);
  assert.deepEqual(rows[2].slice(11), Array(14).fill(''));
  assert.deepEqual(JSON.parse(rows[1][10]), scenario);
  ui.mount.dispose();
});

test('manual passport markup stays inert on editing, serialization and reload', () => {
  const ui = setup();
  create(ui);
  const hostile = '<img src=x onerror=alert(1)>';
  for (const name of ['site-address', 'site-basis', 'kpi-name', 'kpi-unit', 'kpi-source', 'estimate-source', 'prerequisites', 'next-step']) {
    edit(ui.cards()[0], name, hostile);
    assert.equal(field(ui.cards()[0], name).value, hostile);
  }
  const storage = ui.storage;
  ui.mount.dispose();
  const restored = setup(storage);
  assert.equal(field(restored.cards()[0], 'site-address').value, hostile);
  assert.equal(field(restored.cards()[0], 'next-step').value, hostile);
  assert.equal(all(restored.container).some(({ tagName }) => tagName === 'img'), false);
  restored.mount.dispose();
});
