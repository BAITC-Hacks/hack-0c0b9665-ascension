import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateTrajectory } from '../src/core/trajectory.js';
import { getBaseline, getDataset, simulate } from '../src/core/simulator.js';

const decision = (measureId, districtId) => districtId ? { measureId, districtId } : { measureId };
const scenario = (...decisions) => ({ decisions });
const example = () => scenario(
  decision('M7', 'nura'), decision('M8', 'nura'), decision('M10', 'nura'),
  decision('M12'), decision('M5', 'saryarka'),
);
const row = (frame, id) => frame.districts.find((district) => district.id === id);
const contribution = (frame, id) => frame.contributions.find((item) => item.measureId === id);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10,
  `Expected ${expected}, received ${actual}`);

test('trajectory has nine independent snapshots, exact official baseline and endpoint', () => {
  const input = example();
  const output = simulateTrajectory(input);
  assert.equal(output.valid, true);
  assert.equal(output.synthetic, true);
  assert.equal(output.model, 'lagged-saturation-v1');
  assert.equal(output.horizon, 8);
  assert.deepEqual(output.frames.map(({ quarter }) => quarter), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const { quarter: startQuarter, ...start } = output.frames[0];
  const { quarter: endQuarter, ...end } = output.frames[8];
  assert.equal(startQuarter, 0);
  assert.equal(endQuarter, 8);
  assert.deepEqual(start, getBaseline());
  assert.deepEqual(end, simulate(input));
  close(output.score, 56.54307);
  close(output.frames[8].score, 56.54307);
  assert.ok(output.assumptions.some((text) => text.includes('не прогноз')));
  assert.ok(output.assumptions.some((text) => text.includes('не откалибрована')));
});

test('measures wait for their own lags; city effects reach every district and taper near horizon', () => {
  const output = simulateTrajectory(scenario(
    decision('M3', 'nura'), decision('M4', 'esil'), decision('M9', 'nura'),
    decision('M10', 'nura'), decision('M12'),
  ));
  for (const [id, lag] of [['M3', 4], ['M4', 2], ['M9', 1], ['M10', 1], ['M12', 1]]) {
    for (let quarter = 1; quarter <= lag; quarter++) {
      assert.equal(contribution(output.frames[quarter], id).realizedFactor, 0);
      assert.ok(Object.values(contribution(output.frames[quarter], id).effects).every((value) => value === 0));
    }
    assert.ok(contribution(output.frames[lag + 1], id).realizedFactor > 0);
  }
  assert.equal(row(output.frames[4], 'nura').delta.T1, 0);
  close(row(output.frames[5], 'nura').delta.T1, 1.25); // 8 * smoothstep(1/4)
  for (const district of output.frames[2].districts) {
    close(district.delta.C2, 4.375 * 19 / 343); // M12, smoothstep(1/7)
  }
  const m12 = output.frames.slice(1).map((frame) => contribution(frame, 'M12').effects.C2);
  assert.ok(m12[7] - m12[6] < m12[6] - m12[5], 'growth tapers towards the bounded endpoint');
  assert.equal(output.summary.firstEffectQuarter, 2);
});

test('lag-three social measures cross critical thresholds only when calculated values reach 40', () => {
  const { frames } = simulateTrajectory(example());
  assert.deepEqual(frames.map(({ criticalCount }) => criticalCount), [2, 2, 2, 2, 2, 1, 0, 0, 0]);
  assert.equal(row(frames[3], 'nura').after.S1, 38);
  close(row(frames[4], 'nura').after.S1, 39.04);
  close(row(frames[5], 'nura').after.S1, 41.52);
  close(row(frames[5], 'nura').after.S2, 38.08);
  close(row(frames[6], 'nura').after.S2, 40.67);
  assert.equal(row(frames[3], 'saryarka').after.E2, 40); // exactly 40 is not critical
});

test('synergy waits for both measures and reaches fixed bonus without lag discount', () => {
  const { frames } = simulateTrajectory(scenario(
    decision('M5', 'saryarka'), decision('M6'), decision('M9', 'nura'),
    decision('M10', 'nura'), decision('M12'),
  ));
  const ecology = (frame) => frame.synergies.find(({ pair }) => pair.includes('M5'));
  assert.equal(ecology(frames[3]), undefined);
  assert.equal(ecology(frames[4]), undefined);
  assert.equal(ecology(frames[5]).districtId, 'saryarka');
  close(ecology(frames[5]).effects.E2, 0.3125); // fixed 2 * smoothstep(1/4)
  close(ecology(frames[8]).effects.E2, 2);
  assert.ok(frames[2].synergies.some(({ pair }) => pair.includes('M10')));
  close(row(frames[8], 'saryarka').delta.E2, 12.25);
  for (const district of frames[5].districts.filter(({ id }) => id !== 'saryarka')) {
    close(district.delta.E2, 0.234375); // city measure only, no local synergy
  }
});

test('negative side effects and a temporary critical-value increase remain visible', () => {
  const output = simulateTrajectory(scenario(
    decision('M1', 'almaty'), decision('M11', 'almaty'), decision('M9', 'nura'),
    decision('M12'), decision('M4', 'esil'),
  ));
  const early = output.frames[2];
  assert.ok(row(early, 'almaty').after.T1 < 40);
  assert.equal(early.criticalCount, 3);
  assert.ok(early.score < output.frames[0].score, 'do not force a monotonically improving Score');
  assert.ok(row(output.frames[8], 'almaty').after.T1 > 40);
  assert.equal(output.summary.peakCriticalCount, 3);
  assert.equal(output.summary.peakCriticalQuarter, 2);
  assert.equal(output.summary.minimumScoreQuarter, 2);
  assert.ok(contribution(early, 'M11').effects.T1 < 0);
});

test('every frame recomputes population weighting, weakest district, strict critical penalty and bounds', () => {
  const dataset = getDataset();
  const fixtures = [example(), scenario(
    decision('M1', 'nura'), decision('M2'), decision('M4', 'esil'),
    decision('M5', 'saryarka'), decision('M8', 'nura'),
  ), scenario(
    decision('M5', 'saryarka'), decision('M13', 'almaty'), decision('M9', 'nura'),
    decision('M10', 'esil'), decision('M11', 'baikonur'),
  ), scenario(
    decision('M14'), decision('M12'), decision('M4', 'esil'),
    decision('M9', 'nura'), decision('M11', 'almaty'),
  )];
  for (const input of fixtures) {
    const output = simulateTrajectory(input);
    assert.equal(output.valid, true);
    for (const frame of output.frames) {
      let weightedAverage = 0;
      let criticalCount = 0;
      for (const district of frame.districts) {
        let districtScore = 0;
        for (const { id, weight } of dataset.indicators) {
          const value = district.after[id];
          assert.ok(Number.isFinite(value) && value >= 0 && value <= 100);
          if (value < 40) criticalCount++;
          districtScore += value * weight;
          close(district.delta[id], value - district.before[id]);
        }
        close(district.afterScore, districtScore);
        weightedAverage += districtScore * dataset.districts.find(({ id }) => id === district.id).populationShare;
      }
      const minimum = Math.min(...frame.districts.map(({ afterScore }) => afterScore));
      close(frame.weightedAverage, weightedAverage);
      close(frame.worstDistrictScore, minimum);
      assert.equal(frame.criticalCount, criticalCount);
      close(frame.score, weightedAverage * 0.7 + minimum * 0.3 - criticalCount);
    }
    const { quarter, ...endpoint } = output.frames[8];
    assert.equal(quarter, 8);
    assert.deepEqual(endpoint, simulate(input));
  }
});

test('invalid plans preserve canonical validation failures and receive no trajectory or score', () => {
  for (const input of [null, {}, { decisions: [] }, scenario(
    decision('M3', 'nura'), decision('M5', 'saryarka'), decision('M7', 'nura'),
    decision('M10', 'esil'), decision('M12'),
  ), scenario(
    decision('M1', 'esil'), decision('M3', 'nura'), decision('M9', 'almaty'),
    decision('M10', 'saryarka'), decision('M12'),
  )]) {
    const output = simulateTrajectory(input);
    assert.deepEqual(output, simulate(input));
    assert.equal(output.valid, false);
    assert.equal(output.frames, undefined);
    assert.equal(output.score, undefined);
  }
});

test('input order and mutations of returned data cannot affect later results or other frames', () => {
  const input = example();
  for (const item of input.decisions) Object.freeze(item);
  Object.freeze(input.decisions);
  Object.freeze(input);
  const before = JSON.stringify(input);
  const expected = simulateTrajectory(input);
  assert.deepEqual(simulateTrajectory({ decisions: [...input.decisions].reverse() }), expected);
  assert.equal(JSON.stringify(input), before);
  const changed = simulateTrajectory(input);
  changed.frames[0].districts[0].before.T1 = -100;
  changed.frames[4].districts[0].after.T1 = -100;
  changed.frames[8].districts[0].after.T1 = -100;
  changed.frames[8].contributions[0].effects.S1 = -100;
  changed.assumptions[0] = 'changed';
  assert.deepEqual(changed.districts, expected.districts);
  assert.deepEqual(changed.frames[3], expected.frames[3]);
  assert.deepEqual(simulateTrajectory(input), expected);
});
