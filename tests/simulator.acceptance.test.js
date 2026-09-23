import test from 'node:test';
import assert from 'node:assert/strict';
import { getDataset, validateScenario, simulate, getBaseline } from '../src/core/simulator.js';

// Independent fixture values copied from the official case attachment, not core/data exports.
const IDS = ['esil', 'almaty', 'saryarka', 'baikonur', 'nura'];
const KEYS = ['T1', 'T2', 'E1', 'E2', 'S1', 'S2', 'B1', 'B2', 'C1', 'C2'];
const BASE_ROWS = [
  [45, 62, 68, 72, 48, 55, 78, 60, 75, 70],
  [40, 75, 50, 55, 60, 65, 62, 52, 50, 60],
  [50, 70, 42, 40, 62, 68, 58, 55, 45, 55],
  [52, 68, 55, 50, 58, 60, 52, 58, 55, 58],
  [55, 40, 45, 65, 38, 35, 55, 50, 60, 50],
];
const BASE_DISTRICT_SCORES = [62.99, 57.06, 54.65, 56.63, 49.18];
const EXAMPLE_ROWS = [
  [45, 62, 68, 72, 48, 55, 78, 60, 75, 74.375],
  [40, 75, 50, 55, 60, 65, 62, 52, 50, 64.375],
  [50, 70, 42, 48.75, 62, 68, 58, 55, 47.5, 59.375],
  [52, 68, 55, 50, 58, 60, 52, 58, 55, 62.375],
  [55, 40, 45, 65, 48, 43.75, 67.5, 51.75, 60, 54.375],
];
const EXAMPLE_DISTRICT_SCORES = [63.4275, 57.4975, 56.3, 57.0675, 52.9625];
const decision = (measureId, districtId) =>
  districtId === undefined ? { measureId } : { measureId, districtId };
const scenario = (...decisions) => ({ decisions });
const example = () => scenario(
  decision('M7', 'nura'), decision('M8', 'nura'), decision('M10', 'nura'),
  decision('M12'), decision('M5', 'saryarka'),
);
const cheapest = () => scenario(
  decision('M9', 'nura'), decision('M11', 'almaty'), decision('M10', 'esil'),
  decision('M12'), decision('M4', 'esil'),
);
function close(actual, expected, label = 'number') {
  assert.equal(typeof actual, 'number', label + ' must be numeric');
  assert.ok(Number.isFinite(actual), label + ' must be finite');
  assert.ok(Math.abs(actual - expected) <= 1e-8,
    label + ': expected ' + expected + ', received ' + actual);
}
function valid(input) {
  const validation = validateScenario(input);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  const output = simulate(input);
  assert.equal(output.valid, true, JSON.stringify(output.errors));
  return output;
}
function invalid(input) {
  for (const output of [validateScenario(input), simulate(input)]) {
    assert.equal(output.valid, false);
    assert.ok(Array.isArray(output.errors) && output.errors.length > 0);
    assert.ok(output.errors.every(error =>
      typeof error.message === 'string' && error.message.trim().length > 0));
    assert.ok(output.score === undefined || output.score === null,
      'Invalid scenarios must not receive a numeric score');
  }
}
function district(output, id) {
  const row = output.districts.find(item => item.id === id);
  assert.ok(row, 'Missing district ' + id);
  return row;
}
function contribution(output, id) {
  const row = output.contributions.find(item => item.measureId === id);
  assert.ok(row, 'Missing contribution ' + id);
  return row;
}
function checkRows(output, expectedRows, expectedScores) {
  assert.equal(output.districts.length, 5);
  IDS.forEach((id, index) => {
    const row = district(output, id);
    KEYS.forEach((key, column) => {
      close(row.before[key], BASE_ROWS[index][column], id + '.before.' + key);
      close(row.after[key], expectedRows[index][column], id + '.after.' + key);
      close(row.delta[key], expectedRows[index][column] - BASE_ROWS[index][column],
        id + '.delta.' + key);
    });
    close(row.beforeScore, BASE_DISTRICT_SCORES[index], id + '.beforeScore');
    close(row.afterScore, expectedScores[index], id + '.afterScore');
  });
}
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

test('baseline: exact official starting indicators, population weighting and two critical values', () => {
  const output = getBaseline();
  assert.equal(output.valid, true);
  close(output.totalCost, 0);
  close(output.remainingBudget, 100);
  close(output.weightedAverage, 56.8624);
  close(output.worstDistrictScore, 49.18);
  close(output.score, 52.55768);
  close(output.baselineScore, 52.55768);
  close(output.deltaScore, 0);
  assert.equal(output.criticalCount, 2);
  checkRows(output, BASE_ROWS, BASE_DISTRICT_SCORES);
});

test('official five-decision example: cost 95, score 56.54307, every district and indicator', () => {
  const output = valid(example());
  close(output.totalCost, 95);
  close(output.remainingBudget, 5);
  close(output.weightedAverage, 58.0776);
  close(output.worstDistrictScore, 52.9625);
  close(output.score, 56.54307);
  close(output.baselineScore, 52.55768);
  close(output.deltaScore, 3.98539);
  assert.equal(output.criticalCount, 0);
  checkRows(output, EXAMPLE_ROWS, EXAMPLE_DISTRICT_SCORES);
});

test('documented cheapest five-measure set costs 61; unspent budget gives no score bonus', () => {
  const output = valid(cheapest());
  close(output.totalCost, 61);
  close(output.remainingBudget, 39);
  close(output.score,
    0.7 * output.weightedAverage + 0.3 * output.worstDistrictScore - output.criticalCount);
});

test('budget boundary: exactly 100 is permitted', () => {
  const output = valid(scenario(
    decision('M1', 'nura'), decision('M2'), decision('M4', 'esil'),
    decision('M5', 'saryarka'), decision('M8', 'nura'),
  ));
  close(output.totalCost, 100);
  close(output.remainingBudget, 0);
});

test('exactly five decisions are required, including rejecting the empty normal scenario', () => {
  const decisions = example().decisions;
  for (const input of [
    scenario(), scenario(...decisions.slice(0, 4)), scenario(...decisions, decision('M11', 'esil')),
  ]) invalid(input);
});

test('a measure cannot be repeated even in different districts', () => {
  invalid(scenario(
    decision('M9', 'nura'), decision('M9', 'esil'), decision('M10', 'nura'),
    decision('M12'), decision('M4', 'almaty'),
  ));
});

test('budget overflow is rejected even when all other selection rules are satisfied', () => {
  invalid(scenario(
    decision('M3', 'nura'), decision('M5', 'saryarka'), decision('M7', 'nura'),
    decision('M10', 'esil'), decision('M12'),
  )); // 105, five unique measures, no direction or incompatibility conflict.
});

test('three measures in one direction are invalid even within budget', () => {
  invalid(scenario(
    decision('M7', 'nura'), decision('M8', 'nura'), decision('M9', 'esil'),
    decision('M10', 'esil'), decision('M12'),
  ));
});

test('M1 and M3 conflict globally, including different districts', () => {
  invalid(scenario(
    decision('M1', 'esil'), decision('M3', 'nura'), decision('M9', 'almaty'),
    decision('M10', 'saryarka'), decision('M12'),
  ));
});

test('M4 and M7 conflict in the same district', () => {
  invalid(scenario(
    decision('M4', 'nura'), decision('M7', 'nura'), decision('M9', 'esil'),
    decision('M10', 'esil'), decision('M12'),
  ));
});

test('M5 and M13 conflict in the same district', () => {
  invalid(scenario(
    decision('M5', 'saryarka'), decision('M13', 'saryarka'), decision('M9', 'nura'),
    decision('M10', 'esil'), decision('M11', 'almaty'),
  ));
});

test('district-local incompatibilities are allowed when the two districts differ', () => {
  valid(scenario(
    decision('M4', 'esil'), decision('M7', 'nura'), decision('M9', 'almaty'),
    decision('M10', 'esil'), decision('M12'),
  ));
  valid(scenario(
    decision('M5', 'saryarka'), decision('M13', 'almaty'), decision('M9', 'nura'),
    decision('M10', 'esil'), decision('M11', 'baikonur'),
  ));
});

test('unknown measure IDs are rejected with an explanation', () => {
  const input = example();
  input.decisions[0].measureId = 'M999';
  invalid(input);
});

test('district measures require an existing district ID', () => {
  for (const districtId of [undefined, 'unknown-district']) {
    const input = example();
    input.decisions[0] = decision('M7', districtId);
    invalid(input);
  }
});

test('citywide measures must not specify a district', () => {
  const input = example();
  input.decisions[3] = decision('M12', 'nura');
  invalid(input);
});

test('critical threshold is strictly below 40, not below-or-equal', () => {
  const output = valid(cheapest());
  close(district(output, 'nura').after.T2, 40);
  close(district(output, 'saryarka').after.E2, 40);
  close(district(output, 'nura').after.S2, 37.625);
  close(district(output, 'almaty').after.T1, 38.25);
  assert.equal(output.criticalCount, 2);
});

test('M11 preserves its negative T1 side effect as well as its safety benefit', () => {
  const output = valid(cheapest());
  close(district(output, 'almaty').delta.T1, -1.75);
  close(district(output, 'almaty').delta.B2, 10.5);
  close(contribution(output, 'M11').realizedFactor, 0.875);
});

test('lags scale effects by (8-L)/8 across L=1,2,3,4', () => {
  const output = valid(scenario(
    decision('M3', 'nura'), decision('M4', 'esil'), decision('M9', 'nura'),
    decision('M10', 'nura'), decision('M12'),
  ));
  close(district(output, 'nura').delta.T1, 8);
  close(district(output, 'nura').delta.T2, 10);
  close(district(output, 'nura').delta.E2, 2);
  close(contribution(output, 'M3').realizedFactor, 0.5);
  close(contribution(output, 'M4').realizedFactor, 0.75);
  close(contribution(output, 'M9').realizedFactor, 0.875);
  close(contribution(valid(example()), 'M7').realizedFactor, 0.625);
});

test('citywide M12 improves C2 in all five districts and lists all affected districts', () => {
  const output = valid(example());
  IDS.forEach(id => close(district(output, id).delta.C2, 4.375));
  assert.deepEqual([...contribution(output, 'M12').districtIds].sort(), [...IDS].sort());
});

test('M10+M12 fixed synergy adds exactly 2 only in the M10 district', () => {
  const output = valid(example());
  close(district(output, 'nura').delta.B1, 12.5); // 12*7/8 + 2, not (12+2)*7/8.
  for (const id of IDS.filter(id => id !== 'nura')) close(district(output, id).delta.B1, 0);
  assert.ok(output.synergies.some(item => item.districtId === 'nura'));
});

test('M1+M2 synergy adds fixed T1=2 to the M1 district, in addition to city effects', () => {
  const output = valid(scenario(
    decision('M1', 'nura'), decision('M2'), decision('M9', 'esil'),
    decision('M10', 'nura'), decision('M12'),
  ));
  close(district(output, 'nura').delta.T1, 9.5); // 6*.75 + 4*.75 + 2.
  close(district(output, 'nura').delta.T2, 6.75);
  for (const id of IDS.filter(id => id !== 'nura')) close(district(output, id).delta.T1, 3);
});

test('M5+M6 fixed E2 synergy is local and not scaled by either measure lag', () => {
  const output = valid(scenario(
    decision('M5', 'saryarka'), decision('M6'), decision('M9', 'nura'),
    decision('M10', 'nura'), decision('M12'),
  ));
  close(district(output, 'saryarka').delta.E2, 12.25); // 14*5/8 + 3*4/8 + 2.
  close(district(output, 'saryarka').delta.C1, 2.5);
  for (const id of IDS.filter(id => id !== 'saryarka')) close(district(output, id).delta.E2, 1.5);
});

test('all 120 orders of the official example have identical outcomes', () => {
  function* permutations(items) {
    if (!items.length) { yield []; return; }
    for (let index = 0; index < items.length; index++) {
      for (const tail of permutations(items.filter((_, i) => i !== index))) {
        yield [items[index], ...tail];
      }
    }
  }
  let checked = 0;
  for (const decisions of permutations(example().decisions)) {
    const output = valid({ decisions });
    close(output.score, 56.54307);
    close(output.totalCost, 95);
    checkRows(output, EXAMPLE_ROWS, EXAMPLE_DISTRICT_SCORES);
    checked++;
  }
  assert.equal(checked, 120);
});

test('validation and simulation never mutate their input', () => {
  const input = deepFreeze(example());
  const snapshot = JSON.stringify(input);
  valid(input);
  assert.equal(JSON.stringify(input), snapshot);
  const invalidInput = deepFreeze(scenario(decision('M7', 'nura')));
  const invalidSnapshot = JSON.stringify(invalidInput);
  invalid(invalidInput);
  assert.equal(JSON.stringify(invalidInput), invalidSnapshot);
});

test('running different scenarios does not modify the base dataset or future baseline', () => {
  const datasetBefore = structuredClone(getDataset());
  const baselineBefore = structuredClone(getBaseline());
  valid(example());
  valid(cheapest());
  invalid(scenario());
  assert.deepEqual(getDataset(), datasetBefore);
  assert.deepEqual(getBaseline(), baselineBefore);
});

