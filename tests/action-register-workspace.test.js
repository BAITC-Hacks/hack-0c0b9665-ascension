import test from 'node:test';
import assert from 'node:assert/strict';
import { mountActionRegister, normalizeActionDocument } from '../public/action-register.js';
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

function fixture() {
  const labels = scenario.decisions.map((decision) => ({ ...decision,
    measureName: dataset.measures.find(({ id }) => id === decision.measureId).name,
    districtName: dataset.districts.find(({ id }) => id === decision.districtId)?.name ?? 'Весь город',
  }));
  return { schemaVersion: 2, registers: [{
    id: 'workspace-register', sourceKey: JSON.stringify([city.id, scenario.decisions.map(({ measureId, districtId }) => [measureId, districtId ?? null]).sort((a, b) => a[0].localeCompare(b[0]))]),
    createdAt: '2026-09-23T10:10:00.000Z',
    source: { city: { id: city.id, name: city.name }, scenario: structuredClone(scenario),
      result: Object.fromEntries(['valid', 'score', 'totalCost', 'remainingBudget', 'criticalCount'].map((key) => [key, result[key]])),
      calculatedAt: '2026-09-23T10:09:59.000Z', labels },
    actions: labels.map((label, index) => ({
      id: `workspace-action-${index}`, ...label, owner: index === 0 ? 'Ручной ответственный' : '',
      dueDate: index === 0 ? '2026-09-30' : '', criterion: 'Ручной критерий проверки',
      status: index === 0 ? 'completed' : 'draft', evidence: index === 0 ? 'Подтверждение пользователя' : '',
      implementation: { siteAddress: 'Адрес, введённый человеком', siteBasis: '', siteSourceUrl: '',
        kpi: { name: '', unit: '', baseline: null, target: 0, source: '' },
        budget: { capexKzt: 0, opexKzt: null, opexPeriod: '', estimateSource: '', estimateDate: '' },
        prerequisites: '', nextStep: '' },
    })),
  }] };
}
function storageWith(raw) {
  const values = new Map(raw === undefined ? [] : [[KEY, raw]]);
  return {
    writes: 0, getFailure: null, setFailure: null,
    get raw() { return values.get(KEY) ?? null; },
    getItem(key) { if (this.getFailure) throw this.getFailure; return values.get(key) ?? null; },
    setItem(key, value) { if (this.setFailure) throw this.setFailure; this.writes += 1; values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}
class Element extends EventTarget {
  constructor(tagName, ownerDocument) {
    super();
    Object.assign(this, { tagName, ownerDocument, children: [], className: '', attributes: {},
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
  set innerHTML(_value) { throw new Error('Workspace data must not enter an HTML sink'); }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  focus() { this.ownerDocument.activeElement = this; }
}
const all = (node) => [node, ...node.children.flatMap(all)];
const matches = (node, name) => all(node).filter((element) => element.className.split(/\s+/).includes(`action-register-${name}`));
const field = (node, name) => { const element = matches(node, name)[0]; assert.ok(element, `Missing ${name}`); return element; };
function setup(storage = storageWith(), storageGetter) {
  const window = new EventTarget();
  Object.assign(window, { localStorage: storage, CustomEvent, setTimeout, clearTimeout });
  if (storageGetter) Object.defineProperty(window, 'localStorage', { get: storageGetter });
  const document = { defaultView: window, createElement: (tag) => new Element(tag, document) };
  document.body = new Element('body', document);
  const container = new Element('div', document);
  const mount = mountActionRegister(container, { dataset: structuredClone(dataset), city: structuredClone(city) });
  return { container, window, storage, mount,
    cards: () => matches(container, 'card'),
    emit: (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail })),
  };
}
function create(ui) {
  ui.emit('scenario:calculated', structuredClone({ scenario, result }));
  field(ui.container, 'create').click();
  assert.equal(ui.cards().length, 5);
}
const errorCode = (code) => (error) => error instanceof Error && error.code === code;
function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

test('normalization returns a validated independent v2 document and does not mutate frozen input', () => {
  const source = deepFreeze(fixture());
  const normalized = normalizeActionDocument(source);
  assert.deepEqual(normalized, source);
  assert.notEqual(normalized, source);
  assert.notEqual(normalized.registers, source.registers);
  normalized.registers[0].source.city.name = 'Изменённая копия';
  normalized.registers[0].actions[0].owner = 'Другой человек';
  normalized.registers[0].actions[0].implementation.kpi.target = 99;
  assert.equal(source.registers[0].source.city.name, 'Астана');
  assert.equal(source.registers[0].actions[0].owner, 'Ручной ответственный');
  assert.equal(source.registers[0].actions[0].implementation.kpi.target, 0);
  assert.deepEqual(normalizeActionDocument({ schemaVersion: 2, registers: [] }), { schemaVersion: 2, registers: [] });
});

test('historical v2 transport documents normalize a missing OPEX period without mutating input and apply successfully', () => {
  const historical = fixture();
  for (const action of historical.registers[0].actions) delete action.implementation.budget.opexPeriod;
  const rawBefore = JSON.stringify(historical);
  const normalized = normalizeActionDocument(historical);
  assert.equal(JSON.stringify(historical), rawBefore);
  assert.deepEqual(normalized, fixture());
  const historicalBytes = Buffer.byteLength(rawBefore, 'utf8');
  const normalizedBytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8');
  assert.ok(normalizedBytes > historicalBytes);
  assert.throws(() => normalizeActionDocument(historical, { maxBytes: historicalBytes }), errorCode('INVALID'), 'defaults cannot push the returned document over its size limit');
  assert.deepEqual(normalizeActionDocument(historical, { maxBytes: normalizedBytes }), normalized);
  const ui = setup();
  assert.deepEqual(ui.mount.applyDocument(historical), { savedLocally: true });
  assert.deepEqual(ui.mount.getDocument(), fixture());
  assert.deepEqual(JSON.parse(ui.storage.raw), fixture());
  assert.equal(JSON.stringify(historical), rawBefore);
  assert.equal(field(ui.cards()[0], 'opex-period').value, '');
  ui.mount.dispose();
  for (const value of [null, 0, undefined, false, {}, [], 'x'.repeat(201)]) {
    const invalid = fixture();
    invalid.registers[0].actions[0].implementation.budget.opexPeriod = value;
    assert.throws(() => normalizeActionDocument(invalid), errorCode('INVALID'));
  }
});

test('strict workspace documents reject v1, unknown fields at every level and invalid cardinalities', () => {
  for (const mutate of [
    (doc) => { doc.schemaVersion = 1; },
    (doc) => { doc.schemaVersion = 99; },
    (doc) => { doc.actors = []; },
    (doc) => { doc.registers[0].verified = true; },
    (doc) => { doc.registers[0].source.approved = true; },
    (doc) => { doc.registers[0].source.city.actor = 'someone'; },
    (doc) => { doc.registers[0].source.scenario.notes = ''; },
    (doc) => { doc.registers[0].source.scenario.decisions[0].approved = true; },
    (doc) => { doc.registers[0].source.result.verified = true; },
    (doc) => { doc.registers[0].source.labels[0].extra = ''; },
    (doc) => { doc.registers[0].actions[0].actor = 'someone'; },
    (doc) => { doc.registers[0].actions[0].implementation.approved = true; },
    (doc) => { doc.registers[0].actions[0].implementation.kpi.verified = true; },
    (doc) => { doc.registers[0].actions[0].implementation.budget.currency = 'KZT'; },
    (doc) => { doc.registers[0].actions[0][Symbol('verified')] = true; },
    (doc) => { doc.registers.actors = []; },
    (doc) => { doc.registers['4294967295'] = { unexpected: undefined }; },
    (doc) => { doc.registers[0].actions.pop(); },
    (doc) => { doc.registers[0].actions.push(structuredClone(doc.registers[0].actions[0])); },
    (doc) => { doc.registers = Array.from({ length: 11 }, () => structuredClone(doc.registers[0])); },
  ]) {
    const doc = fixture();
    mutate(doc);
    assert.throws(() => normalizeActionDocument(doc), errorCode('INVALID'));
  }
});

test('non-JSON values, non-plain records, cycles and non-finite numbers cannot be silently normalized', () => {
  for (const mutate of [
    (doc) => { doc.registers[0].source.result.score = NaN; },
    (doc) => { doc.registers[0].actions[0].implementation.kpi.baseline = NaN; },
    (doc) => { doc.registers[0].actions[0].implementation.kpi.target = Infinity; },
    (doc) => { doc.registers[0].actions[0].implementation.budget.opexKzt = -Infinity; },
    (doc) => { doc.registers[0].actions[0].implementation.budget.capexKzt = 1n; },
    (doc) => { doc.registers[0].actions[0].owner = undefined; },
    (doc) => { doc.registers[0].actions[0].owner = () => 'owner'; },
    (doc) => { doc.registers[0].actions[0].owner = Symbol('owner'); },
    (doc) => { doc.registers[0].actions[0].implementation = new Date(); },
    (doc) => { doc.registers[0].actions[0].implementation = new Map(); },
    (doc) => { Object.setPrototypeOf(doc.registers[0].actions[0], { inherited: true }); },
    (doc) => { doc.registers[0].source.labels = doc.registers; },
  ]) {
    const doc = fixture();
    mutate(doc);
    assert.throws(() => normalizeActionDocument(doc), errorCode('INVALID'));
  }
  assert.throws(() => normalizeActionDocument(new Date()), errorCode('INVALID'));
  assert.throws(() => normalizeActionDocument(null), errorCode('INVALID'));
  const accessorDocument = fixture();
  let getterCalls = 0;
  Object.defineProperty(accessorDocument.registers[0].actions[0], 'owner', {
    enumerable: true, configurable: true, get() { getterCalls += 1; return 'Изменяемое значение'; },
  });
  assert.throws(() => normalizeActionDocument(accessorDocument), errorCode('INVALID'));
  assert.equal(getterCalls, 0, 'validation must reject an accessor without executing it');
  const rootAccessor = fixture();
  Object.defineProperty(rootAccessor, 'schemaVersion', {
    enumerable: true, get() { getterCalls += 1; return 2; },
  });
  assert.throws(() => normalizeActionDocument(rootAccessor), errorCode('INVALID'));
  assert.equal(getterCalls, 0, 'root metadata must also be checked before reading accessors');
});

test('custom array prototypes are rejected before inherited serialization or iteration can execute', () => {
  for (const hook of ['toJSON', Symbol.iterator]) {
    const doc = fixture();
    let calls = 0;
    const prototype = Object.create(Array.prototype);
    if (hook === 'toJSON') {
      prototype.toJSON = function () { calls += 1; return []; };
    } else {
      Object.defineProperty(prototype, hook, {
        get() { calls += 1; return Array.prototype[Symbol.iterator]; },
      });
    }
    Object.setPrototypeOf(doc.registers, prototype);
    assert.throws(() => normalizeActionDocument(doc), errorCode('INVALID'));
    assert.equal(calls, 0, `inherited ${String(hook)} must not execute`);
  }
});

test('workspace size limits measure UTF-8 bytes and enforce the default 128 KiB bound', () => {
  const doc = fixture();
  const json = JSON.stringify(doc);
  const bytes = Buffer.byteLength(json, 'utf8');
  assert.ok(bytes > json.length, 'Cyrillic fixture must exercise byte length rather than character count');
  assert.deepEqual(normalizeActionDocument(doc, { maxBytes: bytes }), doc);
  assert.throws(() => normalizeActionDocument(doc, { maxBytes: bytes - 1 }), errorCode('INVALID'));
  assert.throws(() => normalizeActionDocument(doc, { maxBytes: json.length }), errorCode('INVALID'));
  const large = fixture();
  large.registers = Array.from({ length: 10 }, (_, index) => {
    const entry = structuredClone(doc.registers[0]);
    entry.id = `register-${index}`;
    entry.source.city.id = `city-${index}`;
    entry.sourceKey = JSON.stringify([entry.source.city.id, scenario.decisions.map(({ measureId, districtId }) => [measureId, districtId ?? null]).sort((a, b) => a[0].localeCompare(b[0]))]);
    for (const [actionIndex, action] of entry.actions.entries()) {
      action.id = `action-${index}-${actionIndex}`;
      action.criterion = 'Ж'.repeat(1500);
      action.implementation.prerequisites = 'Ж'.repeat(1500);
    }
    return entry;
  });
  const largeBytes = Buffer.byteLength(JSON.stringify(large), 'utf8');
  assert.ok(largeBytes > 128 * 1024);
  assert.throws(() => normalizeActionDocument(large), errorCode('INVALID'));
  assert.throws(() => normalizeActionDocument(large, { maxBytes: largeBytes }), errorCode('INVALID'), 'the 128 KiB transport ceiling cannot be increased');
  for (const maxBytes of [0, -1, 0.5, Infinity, NaN]) assert.throws(() => normalizeActionDocument(doc, { maxBytes }), errorCode('INVALID'));
});

test('getDocument gives independent snapshots and invalid apply validates the whole document before changing anything', () => {
  const ui = setup(storageWith(JSON.stringify(fixture())));
  const first = ui.mount.getDocument();
  first.registers[0].actions[0].owner = 'Mutation outside the register';
  first.registers[0].actions[0].implementation.kpi.target = 100;
  assert.deepEqual(ui.mount.getDocument(), fixture());
  const beforeDocument = ui.mount.getDocument();
  const beforeRaw = ui.storage.raw;
  const beforeText = ui.container.textContent;
  const beforeCard = ui.cards()[0];
  const beforeWrites = ui.storage.writes;
  const rejected = fixture();
  rejected.registers[0].actions[0].owner = 'Would otherwise be a valid change';
  rejected.registers[0].actions[4].implementation.kpi.target = NaN;
  assert.throws(() => ui.mount.applyDocument(rejected), errorCode('INVALID'));
  assert.deepEqual(ui.mount.getDocument(), beforeDocument);
  assert.equal(ui.storage.raw, beforeRaw);
  assert.equal(ui.storage.writes, beforeWrites);
  assert.equal(ui.container.textContent, beforeText);
  assert.equal(ui.cards()[0], beforeCard);
  ui.mount.dispose();
});

test('successful apply persists exactly the independent document, replaces view and invalidates current generation', () => {
  const ui = setup();
  create(ui);
  const alternative = structuredClone(scenario);
  alternative.decisions[0].districtId = 'esil';
  ui.emit('scenario:calculated', { scenario: alternative, result: simulate(alternative) });
  assert.equal(field(ui.container, 'create').disabled, false);
  const imported = fixture();
  const expected = structuredClone(imported);
  const oldCard = ui.cards()[0];
  assert.deepEqual(ui.mount.applyDocument(imported), { savedLocally: true });
  assert.deepEqual(JSON.parse(ui.storage.raw), expected);
  assert.deepEqual(ui.mount.getDocument(), expected);
  assert.notEqual(ui.cards()[0], oldCard);
  assert.equal(field(ui.cards()[0], 'owner').value, 'Ручной ответственный');
  assert.equal(field(ui.cards()[0], 'state').value, 'completed');
  assert.equal(field(ui.container, 'create').disabled, true);
  imported.registers[0].actions[0].owner = 'Caller changed its copy';
  imported.registers[0].source.city.name = 'Caller changed source';
  assert.deepEqual(ui.mount.getDocument(), expected);
  assert.deepEqual(JSON.parse(ui.storage.raw), expected);
  const empty = { schemaVersion: 2, registers: [] };
  assert.deepEqual(ui.mount.applyDocument(empty), { savedLocally: true });
  assert.equal(ui.cards().length, 0);
  assert.equal(field(ui.container, 'create').disabled, true);
  assert.deepEqual(ui.mount.getDocument(), empty);
  assert.deepEqual(JSON.parse(ui.storage.raw), empty);
  ui.mount.dispose();
});

test('quota, security, conflict, corrupted and unavailable storage failures leave the old document and view intact', () => {
  for (const mode of ['quota', 'security', 'conflict', 'corrupted', 'unavailable']) {
    const storage = storageWith(mode === 'corrupted' ? '{broken' : JSON.stringify(fixture()));
    const ui = mode === 'unavailable'
      ? setup(storage, () => { throw new DOMException('Blocked', 'SecurityError'); })
      : setup(storage);
    if (mode === 'corrupted' || mode === 'unavailable') create(ui);
    if (mode === 'quota') storage.setFailure = new DOMException('Full', 'QuotaExceededError');
    if (mode === 'security') storage.getFailure = new DOMException('Blocked', 'SecurityError');
    if (mode === 'conflict') {
      const remote = fixture();
      remote.registers[0].actions[0].owner = 'Saved by another tab';
      storage.setItem(KEY, JSON.stringify(remote));
    }
    const beforeDocument = ui.mount.getDocument();
    const beforeRaw = storage.raw;
    const beforeText = ui.container.textContent;
    const beforeCard = ui.cards()[0];
    const beforeWrites = storage.writes;
    const imported = fixture();
    imported.registers[0].actions[0].owner = 'A requested replacement';
    assert.throws(() => ui.mount.applyDocument(imported), errorCode('STORAGE'), mode);
    assert.deepEqual(ui.mount.getDocument(), beforeDocument, mode);
    assert.equal(storage.raw, beforeRaw, mode);
    assert.equal(storage.writes, beforeWrites, mode);
    assert.equal(ui.container.textContent, beforeText, mode);
    assert.equal(ui.cards()[0], beforeCard, mode);
    ui.mount.dispose();
  }
});

test('disposed workspace hooks reject application without touching persisted data', () => {
  const ui = setup(storageWith(JSON.stringify(fixture())));
  const beforeRaw = ui.storage.raw;
  const writes = ui.storage.writes;
  ui.mount.dispose();
  const beforeText = ui.container.textContent;
  assert.throws(() => ui.mount.applyDocument(fixture()), errorCode('DISPOSED'));
  assert.equal(ui.storage.raw, beforeRaw);
  assert.equal(ui.storage.writes, writes);
  assert.equal(ui.container.textContent, beforeText);
});
