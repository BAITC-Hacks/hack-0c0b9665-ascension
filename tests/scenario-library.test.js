import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeScenario,
  captureCalculated,
  parseComparisonImport,
  createLibraryRepository,
} from '../public/scenario-library.js';
import { simulate } from '../src/core/simulator.js';

const STORAGE_KEY = 'akim-scenario-library-v1';
const DATE = '2026-09-23T11:00:00.000Z';
const example = () => ({ decisions: [
  { measureId: 'M7', districtId: 'nura' },
  { measureId: 'M8', districtId: 'nura' },
  { measureId: 'M10', districtId: 'nura' },
  { measureId: 'M12' },
  { measureId: 'M5', districtId: 'saryarka' },
] });
const payload = () => ({
  schemaVersion: 1,
  exportedAt: DATE,
  slots: {
    A: { scenario: example(), result: simulate(example()) },
    B: { scenario: example(), result: simulate(example()) },
  },
});

test('comparison import accepts a single non-empty slot and rejects an empty export', () => {
  for (const slot of ['A', 'B']) {
    const other = slot === 'A' ? 'B' : 'A';
    for (const slots of [
      { [slot]: { scenario: example(), result: { score: 999 } } },
      { [slot]: { scenario: example() }, [other]: null },
    ]) {
      assert.deepEqual(parseComparisonImport(JSON.stringify({ ...payload(), slots })),
        [{ slot, scenario: example() }]);
    }
  }
  for (const slots of [{}, { A: null, B: null }]) {
    assert.throws(() => parseComparisonImport(JSON.stringify({ ...payload(), slots })));
  }
});

test('calculated snapshot stores only allowed numbers and independent decisions', () => {
  const scenario = example();
  const result = { ...simulate(scenario), aiText: 'private prose', apiKey: 'not-a-real-secret' };
  const saved = captureCalculated({ scenario, result, unexpected: 'ignored' });
  assert.ok(saved);
  assert.deepEqual(saved.scenario, example());
  assert.deepEqual(Object.keys(saved.snapshot).sort(),
    ['criticalCount', 'remainingBudget', 'score', 'totalCost']);
  assert.equal(saved.snapshot.score, result.score);
  assert.equal(JSON.stringify(saved).includes('private prose'), false);
  assert.equal(JSON.stringify(saved).includes('not-a-real-secret'), false);
  scenario.decisions[0].districtId = 'esil';
  result.score = -999;
  assert.equal(saved.scenario.decisions[0].districtId, 'nura');
  assert.ok(Math.abs(saved.snapshot.score - 56.54307) < 1e-8);
});

test('unsuccessful or malformed calculation does not become a saved result', () => {
  const valid = { scenario: example(), result: simulate(example()) };
  for (const detail of [null, {}, { ...valid, result: { ...valid.result, valid: false } },
    { ...valid, scenario: { decisions: example().decisions.slice(0, 4) } },
    { ...valid, result: { ...valid.result, score: Infinity } },
    { ...valid, result: { ...valid.result, score: '56.54' } },
    { ...valid, result: { ...valid.result, criticalCount: 0.5 } }]) {
    assert.equal(captureCalculated(detail), null);
  }
});

test('decision normalization rejects unsafe structures and bounded identifiers', () => {
  const invalid = [
    null, [], {}, { decisions: [] }, { decisions: 'M7' },
    { decisions: [...example().decisions, { measureId: 'M1', districtId: 'esil' }] },
    { decisions: [{ measureId: 'M7' }, { measureId: 'M7' }] },
    { decisions: [null] }, { decisions: [[]] },
    { decisions: [{ measureId: 7 }] },
    { decisions: [{ measureId: '' }] },
    { decisions: [{ measureId: ' M7' }] },
    { decisions: [{ measureId: '<script>' }] },
    { decisions: [{ measureId: 'M'.repeat(41) }] },
    { decisions: [{ measureId: 'M7', districtId: null }] },
    { decisions: [{ measureId: 'M7', districtId: '' }] },
    { decisions: [{ measureId: 'M7', districtId: 'n'.repeat(41) }] },
    { decisions: [{ measureId: 'M7', cost: 0 }] },
    { decisions: example().decisions, aiText: 'unexpected' },
    JSON.parse('{"decisions":[{"measureId":"M7","__proto__":{"polluted":true}}]}'),
    JSON.parse('{"decisions":[{"measureId":"M7","constructor":{"prototype":{"polluted":true}}}]}'),
  ];
  for (const scenario of invalid) assert.throws(() => normalizeScenario(scenario));
  assert.equal({}.polluted, undefined);
  const source = example();
  const normalized = normalizeScenario(source);
  normalized.decisions[0].districtId = 'esil';
  assert.equal(source.decisions[0].districtId, 'nura');
  assert.equal(Object.hasOwn(normalized.decisions[3], 'districtId'), false);
});

test('partial imports preserve safe decisions and leave semantic validation to server', () => {
  assert.deepEqual(normalizeScenario({ decisions: [{ measureId: 'future-id_1' }] }),
    { decisions: [{ measureId: 'future-id_1' }] });
  assert.equal(simulate({ decisions: [{ measureId: 'future-id_1' }] }).valid, false);
});

test('comparison import drops all supplied results and round-trips official decisions', () => {
  const input = payload();
  input.slots.A.result = { valid: true, score: 999, aiText: 'untrusted explanation' };
  input.slots.B.result = '<img src=x onerror=alert(1)>';
  const imported = parseComparisonImport(JSON.stringify(input));
  assert.deepEqual(imported, [
    { slot: 'A', scenario: example() },
    { slot: 'B', scenario: example() },
  ]);
  assert.equal(JSON.stringify(imported).includes('untrusted explanation'), false);
  const result = simulate(imported[0].scenario);
  assert.equal(result.valid, true);
  assert.ok(Math.abs(result.score - 56.54307) < 1e-8);
  assert.equal(result.totalCost, 95);
  assert.equal(Object.hasOwn(imported[0].scenario.decisions[3], 'districtId'), false);
});

test('comparison import rejects unknown versions, invalid metadata and broken slots', () => {
  for (const value of [null, [], {}, { ...payload(), schemaVersion: 2 },
    { ...payload(), schemaVersion: '1' }, { ...payload(), exportedAt: 'not a date' },
    { ...payload(), slots: [] },
    { ...payload(), slots: { A: { scenario: example() }, B: { scenario: { decisions: [null] } } } }]) {
    assert.throws(() => parseComparisonImport(JSON.stringify(value)));
  }
  assert.throws(() => parseComparisonImport('{broken'));
});

test('comparison import enforces 128 KiB by UTF-8 bytes before accepting content', () => {
  const valid = JSON.stringify(payload());
  const boundary = valid + ' '.repeat(128 * 1024 - Buffer.byteLength(valid));
  assert.equal(Buffer.byteLength(boundary), 128 * 1024);
  assert.equal(parseComparisonImport(boundary).length, 2);
  assert.throws(() => parseComparisonImport(boundary + ' '));
  const wide = payload();
  wide.slots.A.result = { ignored: 'я'.repeat(66_000) };
  const text = JSON.stringify(wide);
  assert.ok(text.length < 128 * 1024);
  assert.ok(Buffer.byteLength(text) > 128 * 1024);
  assert.throws(() => parseComparisonImport(text));
});

function memoryStorage() {
  const values = new Map();
  let writeError = null;
  let removeError = null;
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) { if (writeError) throw writeError; values.set(key, String(value)); },
    removeItem(key) { if (removeError) throw removeError; values.delete(key); },
    failWrites(error) { writeError = error; },
    failRemoves(error) { removeError = error; },
  };
}
const entry = (id, overrides = {}) => ({
  id: `saved-${id}`,
  name: `Сценарий ${id}`,
  createdAt: DATE,
  modelId: 'official-astana-v1',
  source: 'calculated',
  ...captureCalculated({ scenario: example(), result: simulate(example()) }),
  ...overrides,
});

test('library survives a new repository instance and isolates loaded decisions', () => {
  const storage = memoryStorage();
  const repo = createLibraryRepository(() => storage);
  assert.deepEqual(repo.read(), []);
  const source = entry(1, { name: '  План Нуры  ' });
  const result = repo.add([source]);
  assert.equal(result[0].name, 'План Нуры');
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).schemaVersion, 1);
  source.scenario.decisions[0].districtId = 'esil';
  result[0].scenario.decisions[1].districtId = 'almaty';
  const restored = createLibraryRepository(() => storage).read();
  assert.deepEqual(restored[0].scenario, example());
  assert.equal(restored[0].snapshot.score, simulate(example()).score);
  restored[0].name = 'mutated copy';
  assert.equal(repo.read()[0].name, 'План Нуры');
});

test('imported records never persist an imported score or AI text', () => {
  const storage = memoryStorage();
  const repo = createLibraryRepository(() => storage);
  repo.add([entry(1, {
    source: 'imported',
    snapshot: { score: 999, aiText: 'untrusted prose', apiKey: 'not-a-real-secret' },
  })]);
  assert.equal(repo.read()[0].snapshot, null);
  assert.equal(storage.getItem(STORAGE_KEY).includes('untrusted prose'), false);
  assert.equal(storage.getItem(STORAGE_KEY).includes('not-a-real-secret'), false);
  assert.equal(storage.getItem(STORAGE_KEY).includes('999'), false);
});

test('damaged storage remains untouched until an explicit reset', () => {
  const storage = memoryStorage();
  const repo = createLibraryRepository(() => storage);
  const invalid = [
    '{broken',
    JSON.stringify({ schemaVersion: 2, entries: [] }),
    JSON.stringify({ schemaVersion: 1, entries: [entry(1), entry(1)] }),
    JSON.stringify({ schemaVersion: 1, entries: [entry(1, { name: '' })] }),
    JSON.stringify({ schemaVersion: 1, entries: [entry(1, { modelId: 'other-city-v1' })] }),
    JSON.stringify({ schemaVersion: 1, entries: [entry(1, { scenario: { decisions: [null] } })] }),
  ];
  for (const raw of invalid) {
    storage.setItem(STORAGE_KEY, raw);
    assert.throws(() => repo.read());
    assert.throws(() => repo.add([entry(2)]));
    assert.throws(() => repo.remove('saved-1'));
    assert.equal(storage.getItem(STORAGE_KEY), raw);
  }
  assert.deepEqual(repo.reset(), []);
  assert.equal(storage.getItem(STORAGE_KEY), null);
  assert.deepEqual(repo.read(), []);
});

test('20-entry limit rejects a two-slot import atomically without evicting saves', () => {
  const storage = memoryStorage();
  const repo = createLibraryRepository(() => storage);
  repo.add(Array.from({ length: 19 }, (_, index) => entry(index)));
  const original = storage.getItem(STORAGE_KEY);
  assert.throws(() => repo.add([entry(19, { source: 'imported' }), entry(20, { source: 'imported' })]));
  assert.equal(storage.getItem(STORAGE_KEY), original);
  assert.equal(repo.add([entry(19)]).length, 20);
  const full = storage.getItem(STORAGE_KEY);
  assert.throws(() => repo.add([entry(20)]));
  assert.equal(storage.getItem(STORAGE_KEY), full);
  assert.equal(repo.remove('saved-7').length, 19);
  assert.equal(repo.add([entry(20)]).length, 20);
  assert.equal(repo.read().some((item) => item.id === 'saved-7'), false);
});

test('invalid names and a broken second entry cannot partially save a batch', () => {
  const storage = memoryStorage();
  const repo = createLibraryRepository(() => storage);
  repo.add([entry(0, { name: 'A'.repeat(80) })]);
  const original = storage.getItem(STORAGE_KEY);
  for (const name of ['', '   ', 'A'.repeat(81), 'Two\nlines', 'Control\u0000char']) {
    assert.throws(() => repo.add([entry(1), entry(2, { name })]));
    assert.equal(storage.getItem(STORAGE_KEY), original);
  }
  assert.throws(() => repo.add([entry(1), entry(0)]));
  assert.equal(storage.getItem(STORAGE_KEY), original);
  repo.add([entry(1, { name: '<img src=x onerror=alert(1)>' })]);
  assert.equal(repo.read()[1].name, '<img src=x onerror=alert(1)>');
});

test('quota errors preserve prior storage and allow retry of the same data', () => {
  const storage = memoryStorage();
  const repo = createLibraryRepository(() => storage);
  repo.add([entry(1)]);
  const original = storage.getItem(STORAGE_KEY);
  const pending = entry(2);
  const quota = Object.assign(new Error('No storage space'), { name: 'QuotaExceededError' });
  storage.failWrites(quota);
  assert.throws(() => repo.add([pending]), { name: 'QuotaExceededError' });
  assert.throws(() => repo.remove('saved-1'), { name: 'QuotaExceededError' });
  assert.equal(storage.getItem(STORAGE_KEY), original);
  assert.deepEqual(pending, entry(2));
  assert.equal(repo.read().length, 1);
  storage.failWrites(null);
  assert.equal(repo.add([pending]).length, 2);
});

test('denied storage access and failed reset propagate without claiming success', () => {
  const denied = Object.assign(new Error('Storage denied'), { name: 'SecurityError' });
  const inaccessible = createLibraryRepository(() => { throw denied; });
  for (const operation of [() => inaccessible.read(), () => inaccessible.add([entry(1)]),
    () => inaccessible.remove('saved-1'), () => inaccessible.reset()]) {
    assert.throws(operation, { name: 'SecurityError' });
  }
  const storage = memoryStorage();
  const repo = createLibraryRepository(() => storage);
  repo.add([entry(1)]);
  const original = storage.getItem(STORAGE_KEY);
  storage.failRemoves(denied);
  assert.throws(() => repo.reset(), { name: 'SecurityError' });
  assert.equal(storage.getItem(STORAGE_KEY), original);
});

test('mutations read the current list so another tab save is preserved', () => {
  const storage = memoryStorage();
  const first = createLibraryRepository(() => storage);
  const second = createLibraryRepository(() => storage);
  first.add([entry(1)]);
  second.read();
  first.add([entry(2)]);
  assert.deepEqual(second.add([entry(3)]).map((item) => item.id), ['saved-1', 'saved-2', 'saved-3']);
  first.remove('saved-1');
  assert.deepEqual(second.read().map((item) => item.id), ['saved-2', 'saved-3']);
});
