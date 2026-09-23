import test from 'node:test';
import assert from 'node:assert/strict';
import { getDataset, getBaseline, simulate, validateScenario } from '../src/core/simulator.js';

// Independent transcription of the hackathon attachment «Аким на 5 часов»,
// sections 1–4. Never derive these fixtures from the application dataset.
const INDICATORS = ['T1', 'T2', 'E1', 'E2', 'S1', 'S2', 'B1', 'B2', 'C1', 'C2'];
const WEIGHT_PERCENT = [10, 10, 9, 11, 11, 11, 9, 9, 10, 10];
const INDICATOR_DIRECTIONS = [
  'transport', 'transport', 'ecology', 'ecology', 'social', 'social',
  'safety', 'safety', 'services', 'services',
];
const DISTRICTS = [
  ['esil', 'Есиль', 27, [45, 62, 68, 72, 48, 55, 78, 60, 75, 70]],
  ['almaty', 'Алматы', 24, [40, 75, 50, 55, 60, 65, 62, 52, 50, 60]],
  ['saryarka', 'Сарыарка', 20, [50, 70, 42, 40, 62, 68, 58, 55, 45, 55]],
  ['baikonur', 'Байконур', 13, [52, 68, 55, 50, 58, 60, 52, 58, 55, 58]],
  ['nura', 'Нура', 16, [55, 40, 45, 65, 38, 35, 55, 50, 60, 50]],
];
// id, direction, scope, cost, lag, full effects (before the lag).
const MEASURES = [
  ['M1', 'transport', 'district', 18, 2, { T1: 6, T2: 9 }],
  ['M2', 'transport', 'city', 22, 2, { T1: 4, B2: 3 }],
  ['M3', 'transport', 'district', 30, 4, { T1: 16, T2: 20, E2: 4 }],
  ['M4', 'ecology', 'district', 15, 2, { E1: 12, E2: 3, B1: 2 }],
  ['M5', 'ecology', 'district', 25, 3, { E2: 14, C1: 4 }],
  ['M6', 'ecology', 'city', 20, 4, { E1: 5, E2: 3 }],
  ['M7', 'social', 'district', 24, 3, { S1: 16 }],
  ['M8', 'social', 'district', 20, 3, { S2: 14 }],
  ['M9', 'social', 'district', 10, 1, { S1: 3, S2: 3, B1: 3 }],
  ['M10', 'safety', 'district', 12, 1, { B1: 12, B2: 2 }],
  ['M11', 'safety', 'district', 10, 1, { B2: 12, T1: -2 }],
  ['M12', 'services', 'city', 14, 1, { C2: 5 }],
  ['M13', 'services', 'district', 28, 4, { C1: 18, E2: 2 }],
  ['M14', 'services', 'city', 16, 1, { C1: 5, C2: 2 }],
];
const SYNERGIES = [
  { pair: ['M1', 'M2'], districtFrom: 'M1', effects: { T1: 2 } },
  { pair: ['M10', 'M12'], districtFrom: 'M10', effects: { B1: 2 } },
  { pair: ['M5', 'M6'], districtFrom: 'M5', effects: { E2: 2 } },
];

function close(actual, expected, label) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9,
    `${label}: expected ${expected}, received ${actual}`);
}

test('dataset exactly preserves the official budget, horizon, weights, districts and 14 measures', () => {
  const actual = getDataset();
  assert.equal(actual.budget, 100);
  assert.equal(actual.horizon, 8);
  assert.deepEqual(actual.indicators.map(({ id, direction, weight }) => [id, direction, weight]),
    INDICATORS.map((id, index) => [id, INDICATOR_DIRECTIONS[index], WEIGHT_PERCENT[index] / 100]));
  assert.deepEqual(actual.districts.map(({ id, name, populationShare, indicators }) =>
    [id, name, populationShare, indicators]), DISTRICTS.map(([id, name, population, row]) =>
    [id, name, population / 100, Object.fromEntries(INDICATORS.map((key, index) => [key, row[index]]))]));
  assert.deepEqual(actual.measures.map(({ id, direction, scope, cost, lag, effects }) =>
    [id, direction, scope, cost, lag, effects]), MEASURES);
  assert.deepEqual(actual.synergies, SYNERGIES);
});

// Use integer eighths for all indicator arithmetic, and integer percentages for
// weights/population. This oracle does not use the production floating-point
// calculation, production validation or the production JSON to derive answers.
function oracle(decisions) {
  const values8 = DISTRICTS.map(([, , , row]) => row.map(value => value * 8));
  for (const { measureId, districtId } of decisions) {
    const [, , scope, , lag, effects] = MEASURES.find(([id]) => id === measureId);
    for (let row = 0; row < DISTRICTS.length; row++) {
      if (scope === 'district' && DISTRICTS[row][0] !== districtId) continue;
      for (const [indicator, effect] of Object.entries(effects)) {
        values8[row][INDICATORS.indexOf(indicator)] += effect * (8 - lag);
      }
    }
  }
  for (const { pair, districtFrom, effects } of SYNERGIES) {
    if (!pair.every(id => decisions.some(decision => decision.measureId === id))) continue;
    const districtId = decisions.find(decision => decision.measureId === districtFrom).districtId;
    const row = DISTRICTS.findIndex(([id]) => id === districtId);
    for (const [indicator, effect] of Object.entries(effects)) {
      values8[row][INDICATORS.indexOf(indicator)] += effect * 8;
    }
  }
  const clipped = values8.map(row => row.map(value => Math.max(0, Math.min(800, value))));
  const scores800 = clipped.map(row => row.reduce((sum, value, index) =>
    sum + value * WEIGHT_PERCENT[index], 0));
  const average80000 = scores800.reduce((sum, value, index) => sum + value * DISTRICTS[index][2], 0);
  const min800 = Math.min(...scores800);
  const criticalCount = clipped.flat().filter(value => value < 320).length;
  return {
    rows: clipped.map(row => row.map(value => value / 8)),
    districtScores: scores800.map(value => value / 800),
    weightedAverage: average80000 / 80000,
    worstDistrictScore: min800 / 800,
    criticalCount,
    score: (7 * average80000 + 300 * min800 - criticalCount * 800000) / 800000,
  };
}

function checkCalculation(actual, expected, label) {
  for (const key of ['score', 'weightedAverage', 'worstDistrictScore']) {
    close(actual[key], expected[key], `${label}.${key}`);
  }
  assert.equal(actual.criticalCount, expected.criticalCount, `${label}.criticalCount`);
  assert.equal(actual.districts.length, 5, `${label}.districts`);
  for (let row = 0; row < DISTRICTS.length; row++) {
    const district = actual.districts.find(item => item.id === DISTRICTS[row][0]);
    assert.ok(district, `${label}: missing ${DISTRICTS[row][0]}`);
    close(district.afterScore, expected.districtScores[row], `${label}.${district.id}.score`);
    INDICATORS.forEach((key, column) => {
      close(district.after[key], expected.rows[row][column], `${label}.${district.id}.${key}`);
      close(district.delta[key], expected.rows[row][column] - DISTRICTS[row][3][column],
        `${label}.${district.id}.delta.${key}`);
    });
  }
}

test('integer oracle independently reproduces the official baseline and example', () => {
  const baseline = oracle([]);
  assert.equal(baseline.score, 52.55768);
  assert.equal(baseline.weightedAverage, 56.8624);
  assert.deepEqual(baseline.districtScores, [62.99, 57.06, 54.65, 56.63, 49.18]);
  checkCalculation(getBaseline(), baseline, 'baseline');
  const decisions = [
    { measureId: 'M7', districtId: 'nura' },
    { measureId: 'M8', districtId: 'nura' },
    { measureId: 'M10', districtId: 'nura' },
    { measureId: 'M12' },
    { measureId: 'M5', districtId: 'saryarka' },
  ];
  const expected = oracle(decisions);
  assert.equal(expected.score, 56.54307);
  assert.equal(expected.weightedAverage, 58.0776);
  assert.equal(expected.criticalCount, 0);
  checkCalculation(simulate({ decisions }), expected, 'official example');
});

function* fiveMeasureSets(start = 0, selected = []) {
  if (selected.length === 5) { yield selected; return; }
  for (let index = start; index <= MEASURES.length - (5 - selected.length); index++) {
    yield* fiveMeasureSets(index + 1, [...selected, MEASURES[index]]);
  }
}

// The scenarios in this sweep are already five unique known measures with valid
// scopes. Independently assess the remaining document rules: budget, directions
// and the three forbidden pairs. The acceptance suite covers malformed inputs.
function expectedErrors(selected, decisions) {
  const errors = [];
  if (selected.reduce((sum, measure) => sum + measure[3], 0) > 100) errors.push('BUDGET_EXCEEDED');
  if (INDICATOR_DIRECTIONS.some(direction => selected.filter(measure => measure[1] === direction).length > 2)) {
    errors.push('DIRECTION_LIMIT');
  }
  const has = id => decisions.find(decision => decision.measureId === id);
  if ((has('M1') && has('M3'))
    || (has('M4') && has('M7') && has('M4').districtId === has('M7').districtId)
    || (has('M5') && has('M13') && has('M5').districtId === has('M13').districtId)) {
    errors.push('INCOMPATIBLE_MEASURES');
  }
  return errors.sort();
}

test('all 2002 measure sets agree with the document oracle across ten district layouts', () => {
  const coveredMeasures = new Set();
  let sets = 0;
  let validScenarios = 0;
  let invalidScenarios = 0;
  for (const selected of fiveMeasureSets()) {
    sets++;
    // Each measure is tried in every district, both colocated (local conflicts)
    // and distributed (local conflicts allowed; citywide effects unchanged).
    for (const distribute of [false, true]) {
      for (let offset = 0; offset < DISTRICTS.length; offset++) {
        const decisions = selected.map(([measureId, , scope], index) => scope === 'city'
          ? { measureId }
          : { measureId, districtId: DISTRICTS[(offset + (distribute ? index : 0)) % 5][0] });
        const label = decisions.map(({ measureId, districtId }) => `${measureId}:${districtId ?? 'city'}`).join(',');
        const errors = expectedErrors(selected, decisions);
        const validation = validateScenario({ decisions });
        assert.deepEqual([...new Set(validation.errors.map(error => error.code))].sort(), errors, label);
        assert.equal(validation.valid, errors.length === 0, label);
        const actual = simulate({ decisions });
        assert.equal(actual.valid, errors.length === 0, label);
        const cost = selected.reduce((sum, measure) => sum + measure[3], 0);
        assert.equal(actual.totalCost, cost, `${label}.cost`);
        if (errors.length) {
          invalidScenarios++;
          assert.equal(actual.score, undefined, `${label}: invalid scenarios have no score`);
          continue;
        }
        validScenarios++;
        decisions.forEach(({ measureId, districtId }) => coveredMeasures.add(`${measureId}:${districtId ?? 'city'}`));
        const expected = oracle(decisions);
        assert.equal(actual.remainingBudget, 100 - cost, `${label}.remainingBudget`);
        close(actual.deltaScore, expected.score - 52.55768, `${label}.deltaScore`);
        checkCalculation(actual, expected, label);
      }
    }
  }
  assert.equal(sets, 2002);
  assert.equal(validScenarios, 10860);
  assert.equal(invalidScenarios, 9160);
  assert.equal(validScenarios + invalidScenarios, 20020);
  for (const [id, , scope] of MEASURES) {
    for (const location of scope === 'city' ? ['city'] : DISTRICTS.map(([districtId]) => districtId)) {
      assert.ok(coveredMeasures.has(`${id}:${location}`), `Missing valid coverage of ${id}:${location}`);
    }
  }
});
