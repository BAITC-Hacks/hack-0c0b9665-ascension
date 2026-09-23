import test from 'node:test';
import assert from 'node:assert/strict';
import { getDataset } from '../src/core/simulator.js';
import {
  MODEL_ID, STORAGE_KEY, MAX_FILE_BYTES,
  normalizeObservation, parseEvidenceBundle, serializeEvidenceBundle, mergeEvidence,
  assessObservation, createEvidenceRepository,
} from '../public/evidence-register.js';

const dataset = getDataset();
const today = '2026-09-23';
const exportedAt = '2026-09-23T10:00:00.000Z';
const record = (overrides = {}) => ({
  indicatorId: 'S1', districtId: 'nura', metricLabel: 'Residents awaiting appointments',
  observedValue: 1250, unit: 'people', periodStart: '2026-08-01', periodEnd: '2026-08-31',
  sourceTitle: 'Department monthly report', sourceUrl: 'https://example.org/report?month=2026-08',
  custodian: 'Health department', coverage: 'All registered residents in the district',
  method: 'Deduplicated count from the reporting register', reviewNote: '',
  reviewStatus: 'draft', reviewer: '', reviewedOn: '', ...overrides,
});
const reviewed = (overrides = {}) => record({
  reviewStatus: 'reviewed', reviewer: 'Local reviewer', reviewedOn: '2026-09-20', ...overrides,
});
const bundle = (records, overrides = {}) => ({
  schemaVersion: 1, modelId: MODEL_ID, exportedAt, records, ...overrides,
});
const parse = (records, overrides = {}, data = dataset) =>
  parseEvidenceBundle(JSON.stringify(bundle(records, overrides)), data);
const identities = (data = dataset) => data.indicators.flatMap(indicator =>
  [...data.districts.map(district => district.id), 'city'].map(districtId =>
    ({ indicatorId: indicator.id, districtId })));
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
function memoryStorage(initial = null) {
  let raw = initial;
  let writes = 0;
  return {
    getItem(key) { assert.equal(key, STORAGE_KEY); return raw; },
    setItem(key, value) { assert.equal(key, STORAGE_KEY); raw = value; writes++; },
    get raw() { return raw; },
    get writes() { return writes; },
  };
}

test('normalization creates independent defaults, trims text, and preserves zero measurements', () => {
  assert.equal(MODEL_ID, 'official-astana-v1');
  assert.equal(STORAGE_KEY, 'akim-evidence-register-v1');
  assert.equal(MAX_FILE_BYTES, 128 * 1024);
  const source = freeze({ indicatorId: 'S1', districtId: 'city' });
  const normalized = normalizeObservation(source, dataset);
  assert.equal(normalized.observedValue, null);
  assert.equal(normalized.reviewStatus, 'draft');
  for (const key of ['metricLabel', 'unit', 'periodStart', 'periodEnd', 'sourceTitle',
    'sourceUrl', 'custodian', 'coverage', 'method', 'reviewNote', 'reviewer', 'reviewedOn']) {
    assert.equal(normalized[key], '');
  }
  normalized.metricLabel = 'Independent edit';
  assert.deepEqual(source, { indicatorId: 'S1', districtId: 'city' });
  const zero = normalizeObservation(record({ observedValue: 0, metricLabel: '  Waiting residents  ' }), dataset);
  assert.equal(zero.observedValue, 0);
  assert.equal(zero.metricLabel, 'Waiting residents');
  assert.equal(assessObservation(zero, dataset, { today }).complete, true);
});

test('unknown identities, numeric coercion, malformed records, and injected metadata are rejected', () => {
  for (const invalid of [null, [], 'record', {},
    record({ indicatorId: 'NOT-IN-DATASET' }), record({ districtId: 'another-city' }),
    record({ indicatorId: ' S1' }), record({ observedValue: '1250' }),
    record({ observedValue: NaN }), record({ observedValue: Infinity }),
    record({ observedValue: false }), record({ reviewStatus: 'official' }),
    record({ apiKey: 'fixture-not-a-secret' }), record({ result: { score: 999 } }),
    record({ aiText: 'Verified forecast' }),
    JSON.parse(JSON.stringify(record()).replace('"indicatorId":', '"__proto__":{"polluted":true},"indicatorId":')),
    record({ constructor: { prototype: { polluted: true } } }),
  ]) assert.throws(() => normalizeObservation(invalid, dataset));
  assert.equal({}.polluted, undefined);
});

test('bounded text and source links reject controls, scripts, embedded credentials, and oversized values', () => {
  const limits = { metricLabel: 160, unit: 80, sourceTitle: 200, sourceUrl: 1000,
    custodian: 160, coverage: 300, method: 600, reviewNote: 600, reviewer: 120 };
  for (const [key, max] of Object.entries(limits)) {
    assert.throws(() => normalizeObservation(record({ [key]: 'x'.repeat(max + 1) }), dataset), key);
  }
  for (const sourceUrl of ['javascript:alert(1)', 'data:text/plain,report', 'file:///report',
    '//example.org/report', 'https://alice:password@example.org/report', 'https://alice@example.org/report',
    'https://example.org/\nreport', 'not a URL']) {
    assert.throws(() => normalizeObservation(record({ sourceUrl }), dataset), sourceUrl);
  }
  for (const [key, value] of [['metricLabel', 'line\nbreak'], ['sourceTitle', 'bad\u0000text'],
    ['method', 'bad\u0007text'], ['method', 'bad\ttext'], ['coverage', 'bad\u007ftext'], ['custodian', null]]) {
    assert.throws(() => normalizeObservation(record({ [key]: value }), dataset), key);
  }
  assert.equal(normalizeObservation(record({ method: 'First line\nSecond line' }), dataset).method,
    'First line\nSecond line');
  assert.equal(normalizeObservation(record({ sourceUrl: '  http://example.org/report  ' }), dataset).sourceUrl,
    'http://example.org/report');
});

test('measurement and review dates use real calendar days and ordered periods', () => {
  for (const invalid of [
    record({ periodStart: '2026-02-29' }), record({ periodEnd: '2026-09-31' }),
    record({ periodEnd: '2026-13-01' }), record({ periodEnd: '2026-9-01' }),
    record({ periodEnd: '2026-08-31T00:00:00Z' }), record({ reviewedOn: '2100-02-29' }),
    record({ periodStart: '2026-09-01', periodEnd: '2026-08-31' }),
  ]) assert.throws(() => normalizeObservation(invalid, dataset));
  assert.equal(normalizeObservation(record({ periodStart: '2000-02-29', periodEnd: '2000-02-29' }), dataset).periodStart,
    '2000-02-29');
  assert.equal(normalizeObservation(record({ periodStart: '2024-02-29', periodEnd: '2024-03-01' }), dataset).periodStart,
    '2024-02-29');
});

test('review requires a complete evidence passport and a named dated manual check', () => {
  const required = ['metricLabel', 'observedValue', 'unit', 'periodStart', 'periodEnd',
    'sourceTitle', 'sourceUrl', 'custodian', 'coverage', 'method'];
  for (const key of required) {
    const incomplete = record({ [key]: key === 'observedValue' ? null : '' });
    const assessment = assessObservation(incomplete, dataset, { today });
    assert.equal(assessment.complete, false, key);
    assert.equal(assessment.reviewed, false, key);
    assert.ok(assessment.missing.length > 0, key);
    assert.throws(() => normalizeObservation({ ...incomplete,
      reviewStatus: 'reviewed', reviewer: 'Reviewer', reviewedOn: today }, dataset), key);
  }
  assert.throws(() => normalizeObservation(reviewed({ reviewer: '' }), dataset));
  assert.throws(() => normalizeObservation(reviewed({ reviewedOn: '' }), dataset));
  assert.equal(assessObservation(reviewed(), dataset, { today }).reviewed, true);
  assert.equal(assessObservation(record(), dataset, { today }).reviewed, false);
});

test('freshness is explicit at 365 days and future measurements or checks do not count as reviewed', () => {
  const boundary = record({ periodStart: '2025-09-01', periodEnd: '2025-09-23' });
  assert.equal(assessObservation(boundary, dataset, { today }).stale, false);
  const old = assessObservation({ ...boundary, periodEnd: '2025-09-22' }, dataset, { today });
  assert.equal(old.stale, true);
  assert.equal(old.complete, true);
  for (const future of [reviewed({ periodStart: today, periodEnd: '2026-09-24' }),
    reviewed({ reviewedOn: '2026-09-24' })]) {
    // Structural normalization is time-independent; assessment uses the explicit clock.
    normalizeObservation(future, dataset);
    const assessment = assessObservation(future, dataset, { today });
    assert.equal(assessment.complete, false);
    assert.equal(assessment.reviewed, false);
    assert.ok(assessment.missing.length > 0);
  }
});

test('external import preserves evidence while clearing all claimed review authority', () => {
  const source = freeze(reviewed({ reviewNote: 'See page 4' }));
  const imported = parse([source]);
  assert.equal(imported.length, 1);
  assert.deepEqual(imported[0], { ...source, reviewStatus: 'draft', reviewer: '', reviewedOn: '' });
  assert.equal(source.reviewStatus, 'reviewed');
  assert.equal(assessObservation(imported[0], dataset, { today }).complete, true);
  assert.equal(assessObservation(imported[0], dataset, { today }).reviewed, false);
});

test('bundle validation is atomic and rejects unknown schema, model, metadata, or malformed entries', () => {
  for (const value of [null, [], {}, bundle([record()], { schemaVersion: 2 }),
    bundle([record()], { modelId: 'other-model' }), bundle([record()], { exportedAt: 'yesterday' }),
    bundle([record()], { exportedAt: '2026-02-30T10:00:00.000Z' }),
    bundle([record()], { apiKey: 'fixture-not-a-secret' }), bundle([record()], { result: { score: 999 } }),
    bundle('records'), bundle([record(), record({ indicatorId: 'unknown' })])]) {
    assert.throws(() => parseEvidenceBundle(JSON.stringify(value), dataset));
  }
  assert.throws(() => parseEvidenceBundle('{broken', dataset));
  const existing = freeze([record()]);
  const snapshot = JSON.stringify(existing);
  assert.throws(() => mergeEvidence(existing, [record({ districtId: 'city' }), record({ districtId: 'bad' })], dataset));
  assert.equal(JSON.stringify(existing), snapshot);
});

test('imports reject repeated identities and permit at most sixty distinct observations', () => {
  assert.throws(() => parse([record(), record({ observedValue: 999 })]));
  const sixty = identities().map(identity => record(identity));
  assert.equal(sixty.length, 60);
  assert.equal(parse(sixty).length, 60);
  const expanded = { ...dataset, districts: [...dataset.districts, { id: 'extra-district' }] };
  const sixtyOne = [...sixty, record({ districtId: 'extra-district' })];
  assert.throws(() => parse(sixtyOne, {}, expanded));
  assert.throws(() => mergeEvidence(sixty, [sixtyOne.at(-1)], expanded));
});

test('file limits count UTF-8 bytes rather than JavaScript character count', () => {
  const records = identities().map(identity => record({ ...identity,
    method: 'я'.repeat(600), reviewNote: 'я'.repeat(600), coverage: 'я'.repeat(300) }));
  const text = JSON.stringify(bundle(records));
  assert.ok(text.length < MAX_FILE_BYTES, 'fixture fits by character count');
  assert.ok(Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES, 'fixture exceeds the byte limit');
  assert.throws(() => parseEvidenceBundle(text, dataset));
  assert.equal(parse([record()]).length, 1);
});

test('a saved near-limit register exports to a file that can be imported without losing any record', () => {
  const records = identities().map(identity => normalizeObservation({ ...identity,
    method: 'я'.repeat(445), reviewNote: 'я'.repeat(445) }, dataset));
  const formattedBytes = Buffer.byteLength(JSON.stringify(bundle(records), null, 2), 'utf8');
  assert.ok(formattedBytes > MAX_FILE_BYTES, 'formatted JSON reproduces the rejected-export regression');
  const exported = serializeEvidenceBundle(freeze(records), dataset);
  const exportedBytes = Buffer.byteLength(exported, 'utf8');
  assert.ok(exportedBytes > MAX_FILE_BYTES * 0.9, 'fixture exercises the size boundary');
  assert.ok(exportedBytes <= MAX_FILE_BYTES, 'downloaded file fits its own import limit');
  const imported = parseEvidenceBundle(exported, dataset);
  assert.equal(imported.length, 60);
  assert.deepEqual(imported, records);
  const storage = memoryStorage();
  createEvidenceRepository(() => storage, dataset).save(records);
  assert.deepEqual(parseEvidenceBundle(storage.raw, dataset), imported);
});

test('merge upserts by indicator and district without losing other districts or mutating either input', () => {
  const existing = freeze([record(), record({ districtId: 'city', observedValue: 5000 })]);
  const incoming = freeze([record({ observedValue: 1400 }), record({ indicatorId: 'T1', observedValue: 23 })]);
  const merged = mergeEvidence(existing, incoming, dataset);
  assert.equal(merged.length, 3);
  assert.equal(merged.find(item => item.indicatorId === 'S1' && item.districtId === 'nura').observedValue, 1400);
  assert.equal(merged.find(item => item.districtId === 'city').observedValue, 5000);
  merged[0].metricLabel = 'Edited merged copy';
  assert.equal(existing[0].metricLabel, 'Residents awaiting appointments');
  assert.equal(incoming[0].metricLabel, 'Residents awaiting appointments');
});

test('repository round-trips local reviews and returns independent records without implicit writes', () => {
  const storage = memoryStorage();
  const repository = createEvidenceRepository(() => storage, dataset);
  assert.deepEqual(repository.read(), []);
  assert.equal(storage.writes, 0);
  repository.save([reviewed()]);
  assert.equal(storage.writes, 1);
  const persisted = JSON.parse(storage.raw);
  assert.equal(persisted.schemaVersion, 1);
  assert.equal(persisted.modelId, MODEL_ID);
  assert.ok(Number.isFinite(Date.parse(persisted.exportedAt)));
  assert.equal(persisted.records[0].reviewStatus, 'reviewed');
  const first = repository.read();
  assert.equal(first[0].reviewer, 'Local reviewer');
  first[0].observedValue = 999;
  assert.equal(repository.read()[0].observedValue, 1250);
  assert.equal(storage.writes, 1);
});

test('corrupt local data and malformed saves raise errors without deleting valid or broken stored bytes', () => {
  for (const raw of ['{broken', JSON.stringify(bundle([record({ districtId: 'bad' })])),
    JSON.stringify(bundle([record()], { modelId: 'other-model' }))]) {
    const storage = memoryStorage(raw);
    const repository = createEvidenceRepository(() => storage, dataset);
    assert.throws(() => repository.read());
    assert.equal(storage.raw, raw);
    assert.equal(storage.writes, 0);
  }
  const previous = JSON.stringify(bundle([reviewed()]));
  const storage = memoryStorage(previous);
  const repository = createEvidenceRepository(() => storage, dataset);
  assert.throws(() => repository.save([record(), record({ districtId: 'bad' })]));
  assert.equal(storage.raw, previous);
  assert.equal(storage.writes, 0);
});

test('storage access and quota errors propagate rather than claiming a successful save', () => {
  const blocked = new Error('Storage blocked');
  assert.throws(() => createEvidenceRepository(() => { throw blocked; }, dataset).read(),
    error => error === blocked);
  const previous = JSON.stringify(bundle([reviewed()]));
  const quota = new Error('Quota exceeded');
  const storage = {
    getItem() { return previous; },
    setItem() { throw quota; },
  };
  const repository = createEvidenceRepository(() => storage, dataset);
  assert.throws(() => repository.save([record({ observedValue: 1500 })]), error => error === quota);
  assert.equal(storage.getItem(STORAGE_KEY), previous);
  assert.equal(repository.read()[0].observedValue, 1250);
});
