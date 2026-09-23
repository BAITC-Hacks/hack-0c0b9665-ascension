import test from 'node:test';
import assert from 'node:assert/strict';
import { getDataset, simulate } from '../src/core/simulator.js';
import { buildPolicyOptions } from '../src/core/policy-options.js';

const scenario = (...choices) => ({ decisions: choices.map(([measureId, districtId]) =>
  districtId === undefined ? { measureId } : { measureId, districtId }) });
const official = () => scenario(
  ['M7', 'nura'], ['M8', 'nura'], ['M10', 'nura'], ['M12'], ['M5', 'saryarka'],
);
const cheapest = () => scenario(
  ['M9', 'nura'], ['M11', 'almaty'], ['M10', 'esil'], ['M12'], ['M4', 'esil'],
);
const fullBudget = () => scenario(
  ['M1', 'nura'], ['M2'], ['M4', 'esil'], ['M5', 'saryarka'], ['M8', 'nura'],
);
const signature = input => input.decisions
  .map(({ measureId, districtId }) => JSON.stringify([measureId, districtId ?? null])).sort().join(';');
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const metrics = result => [result.score, result.worstDistrictScore, -result.totalCost];
function strictlyBetter(left, right) {
  const a = metrics(left), b = metrics(right);
  return a.every((value, index) => value >= b[index]) && a.some((value, index) => value > b[index]);
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

// Independent oracle: replace each position with every catalog/district choice, then
// reject repeated IDs as a set and ask the official validator about all other rules.
// No production neighborhood, sorting, dominance or delta helper is imported.
function enumerate(input) {
  const { measures, districts } = getDataset();
  const unique = new Map();
  for (let slot = 0; slot < input.decisions.length; slot++) {
    for (const measure of measures) {
      for (const district of measure.scope === 'city' ? [null] : districts) {
        const proposed = structuredClone(input);
        proposed.decisions[slot] = district
          ? { measureId: measure.id, districtId: district.id } : { measureId: measure.id };
        const key = signature(proposed);
        if (key === signature(input) || new Set(proposed.decisions.map(d => d.measureId)).size !== 5) continue;
        unique.set(key, { scenario: proposed, result: simulate(proposed) });
      }
    }
  }
  const valid = [...unique.values()].filter(item => item.result.valid);
  const baseline = simulate(input);
  const frontier = valid.filter(item => {
    const candidateMetrics = metrics(item.result);
    const baselineMetrics = metrics(baseline);
    return candidateMetrics.some((value, index) => value > baselineMetrics[index])
      && ![...valid.map(other => other.result), baseline].some(other => strictlyBetter(other, item.result));
  });
  return { explored: unique.size, valid, frontier };
}

test('official example retains exact simulator output and selects the verified score/worst leader', () => {
  const input = official();
  const output = buildPolicyOptions(input);
  assert.equal(output.valid, true);
  assert.equal(output.scope, 'single-decision-neighborhood');
  assert.equal(output.exhaustiveWithinScope, true);
  assert.deepEqual(output.errors, []);
  assert.equal(output.emptyReason, null);
  assert.deepEqual(output.baseline.result, simulate(input));
  close(output.baseline.result.totalCost, 95);
  close(output.baseline.result.score, 56.54307);
  assert.equal(output.explored, 181);
  assert.equal(output.validCandidates, 117);
  assert.equal(output.paretoCandidates, 5);
  assert.equal(output.options.length, 5);
  assert.equal(output.truncated, false);
  const improved = output.options[0];
  assert.deepEqual(improved.changed, {
    removed: { measureId: 'M5', districtId: 'saryarka' },
    added: { measureId: 'M3', districtId: 'nura' },
  });
  close(improved.result.score, 57.20556);
  close(improved.result.totalCost, 100);
  close(improved.delta.score, 0.66249);
  assert.equal(improved.delta.totalCost, 5);
  assert.deepEqual(improved.selectedFor, ['maximizeScore', 'maximizeWorst']);
  assert.deepEqual(improved.objectives, {
    maximizeScore: 'improved', maximizeWorst: 'improved', minimizeCost: 'worse',
  });
});

test('every returned alternative is valid, changes one decision, and preserves exact results/deltas', () => {
  for (const input of [official(), cheapest(), fullBudget()]) {
    const output = buildPolicyOptions(input, { limit: 12 });
    const originals = new Set(input.decisions.map(item => JSON.stringify([item.measureId, item.districtId ?? null])));
    assert.equal(new Set(output.options.map(item => item.id)).size, output.options.length);
    assert.equal(new Set(output.options.map(item => signature(item.scenario))).size, output.options.length);
    for (const option of output.options) {
      const actual = simulate(option.scenario);
      assert.equal(actual.valid, true);
      assert.ok(actual.totalCost <= 100);
      assert.equal(option.scenario.decisions.length, 5);
      assert.equal(new Set(option.scenario.decisions.map(item => item.measureId)).size, 5);
      assert.deepEqual(option.result, actual);
      assert.equal(option.scenario.decisions.filter(item =>
        originals.has(JSON.stringify([item.measureId, item.districtId ?? null]))).length, 4);
      const reconstructed = { decisions: input.decisions
        .filter(item => item.measureId !== option.changed.removed.measureId).concat(option.changed.added) };
      assert.equal(signature(option.scenario), signature(reconstructed));
      for (const key of ['score', 'worstDistrictScore', 'totalCost', 'criticalCount']) {
        assert.equal(option.delta[key], actual[key] - output.baseline.result[key]);
      }
      const benefits = [option.delta.score, option.delta.worstDistrictScore, -option.delta.totalCost];
      Object.values(option.objectives).forEach((label, index) => {
        assert.equal(label, benefits[index] > 0 ? 'improved' : benefits[index] < 0 ? 'worse' : 'unchanged');
      });
    }
    assert.doesNotThrow(() => JSON.stringify(output));
  }
});

test('independent exhaustive oracle confirms counts, Pareto dominance and objective leaders', () => {
  for (const input of [official(), cheapest(), fullBudget()]) {
    const expected = enumerate(input);
    const output = buildPolicyOptions(input, { limit: 12 });
    assert.equal(output.explored, expected.explored);
    assert.equal(output.validCandidates, expected.valid.length);
    assert.equal(output.paretoCandidates, expected.frontier.length);
    const expectedKeys = new Set(expected.frontier.map(item => signature(item.scenario)));
    for (const option of output.options) {
      assert.ok(expectedKeys.has(signature(option.scenario)));
      assert.equal(expected.valid.some(other => strictlyBetter(other.result, option.result)), false);
      assert.equal(strictlyBetter(output.baseline.result, option.result), false);
    }
    if (expected.frontier.length <= 12) {
      assert.deepEqual(new Set(output.options.map(item => signature(item.scenario))), expectedKeys);
    }
    for (const [objective, metric, extremum] of [
      ['maximizeScore', 'score', Math.max],
      ['maximizeWorst', 'worstDistrictScore', Math.max],
      ['minimizeCost', 'totalCost', Math.min],
    ]) {
      const leader = output.options.find(item => item.selectedFor.includes(objective));
      assert.ok(leader, objective);
      assert.equal(leader.result[metric], extremum(...expected.frontier.map(item => item.result[metric])));
    }
  }
});

test('a district-only relocation is included and city choices omit districtId', () => {
  const output = buildPolicyOptions(official());
  const relocation = output.options.find(item => item.changed.added.measureId === 'M5');
  assert.ok(relocation);
  assert.equal(relocation.changed.removed.districtId, 'saryarka');
  assert.equal(relocation.changed.added.districtId, 'nura');
  assert.equal(relocation.delta.totalCost, 0);
  const cityMeasureIds = new Set(getDataset().measures.filter(item => item.scope === 'city').map(item => item.id));
  for (const option of output.options) {
    for (const decision of option.scenario.decisions) {
      if (cityMeasureIds.has(decision.measureId)) assert.equal(Object.hasOwn(decision, 'districtId'), false);
    }
  }
});

test('cheaper alternatives honestly label a lower score when the baseline is the score leader', () => {
  const input = official();
  input.decisions[4] = { measureId: 'M3', districtId: 'nura' };
  const output = buildPolicyOptions(input);
  const tradeoff = output.options.find(item => item.delta.totalCost < 0 && item.delta.score < 0);
  assert.ok(tradeoff);
  assert.equal(tradeoff.objectives.minimizeCost, 'improved');
  assert.equal(tradeoff.objectives.maximizeScore, 'worse');
});

test('invalid cost 105 returns official errors and no numeric recommendation', () => {
  const input = scenario(['M3', 'nura'], ['M5', 'saryarka'], ['M7', 'nura'], ['M10', 'esil'], ['M12']);
  const output = buildPolicyOptions(input);
  assert.equal(output.valid, false);
  assert.equal(output.exhaustiveWithinScope, false);
  assert.equal(output.baseline.result.totalCost, 105);
  assert.equal(Object.hasOwn(output.baseline.result, 'score'), false);
  assert.deepEqual(output.baseline.result, simulate(input));
  assert.deepEqual(output.errors, simulate(input).errors);
  assert.ok(output.errors.some(item => item.code === 'BUDGET_EXCEEDED'));
  assert.equal(output.emptyReason.code, 'INVALID_BASELINE');
  assert.equal(output.explored, 0);
  assert.equal(output.validCandidates, 0);
  assert.equal(output.paretoCandidates, 0);
  assert.deepEqual(output.options, []);
});

test('malformed baseline and unknown fields are never sanitized into valid inputs', () => {
  for (const input of [null, undefined, 5, [], {}, { decisions: [] },
    { ...official(), budget: 1000 },
    { decisions: official().decisions.map(item => ({ ...item, unexpected: true })) },
  ]) {
    const output = buildPolicyOptions(input);
    assert.equal(output.valid, false);
    assert.deepEqual(output.errors, simulate(input).errors);
    assert.deepEqual(output.options, []);
    assert.equal(output.explored, 0);
    assert.equal(output.emptyReason.code, 'INVALID_BASELINE');
  }
});

test('all 120 input orders return identical canonical scenarios, IDs, results and selection', () => {
  function* permutations(items) {
    if (!items.length) { yield []; return; }
    for (const [index, item] of items.entries()) {
      for (const tail of permutations(items.filter((_, other) => other !== index))) yield [item, ...tail];
    }
  }
  const expected = buildPolicyOptions(official());
  let checked = 0;
  for (const decisions of permutations(official().decisions)) {
    assert.deepEqual(buildPolicyOptions({ decisions }), expected);
    checked++;
  }
  assert.equal(checked, 120);
});

test('input/data remain unchanged and modifying returned snapshots cannot poison a future call', () => {
  const input = freeze(official());
  const before = JSON.stringify(input);
  const dataset = getDataset();
  const expected = buildPolicyOptions(input);
  const first = buildPolicyOptions(input);
  first.baseline.scenario.decisions[0].measureId = 'M999';
  first.baseline.result.districts[0].after.T1 = -999;
  first.options[0].scenario.decisions[0].measureId = 'M999';
  first.options[0].result.districts[0].after.T1 = -999;
  first.options[0].changed.added.measureId = 'M999';
  assert.deepEqual(buildPolicyOptions(input), expected);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(getDataset(), dataset);
  const invalid = freeze({ decisions: [] });
  buildPolicyOptions(invalid);
  assert.deepEqual(invalid, { decisions: [] });
});

test('limit is bounded, deterministic and only truncates display after complete enumeration', () => {
  const baseline = buildPolicyOptions(official());
  const defaultLimited = buildPolicyOptions(cheapest());
  assert.equal(defaultLimited.limit, 6);
  assert.equal(defaultLimited.options.length, 6);
  assert.equal(defaultLimited.paretoCandidates, 9);
  assert.equal(defaultLimited.truncated, true);
  for (const [requested, normalized] of [[0, 0], [-5, 0], [1, 1], [2.9, 2], [12, 12],
    [1e9, 12], [Infinity, 6], [NaN, 6], ['2', 6], [null, 6]]) {
    const result = buildPolicyOptions(official(), { limit: requested });
    assert.equal(result.limit, normalized);
    assert.equal(result.explored, baseline.explored);
    assert.equal(result.validCandidates, baseline.validCandidates);
    assert.equal(result.paretoCandidates, baseline.paretoCandidates);
    assert.equal(result.exhaustiveWithinScope, true);
    assert.deepEqual(result.options, baseline.options.slice(0, normalized));
    assert.equal(result.truncated, normalized < baseline.options.length);
    assert.equal(result.emptyReason?.code ?? null, normalized === 0 ? 'LIMIT_ZERO' : null);
  }
});

test('exact decision locks preserve both measure and district, including city measures', () => {
  const input = official();
  const constraints = { lockedDecisions: [input.decisions[4], input.decisions[3]] };
  const output = buildPolicyOptions(input, { constraints, limit: 12 });
  assert.equal(output.constraintScope, 'constrained');
  assert.ok(output.options.length > 0);
  assert.ok(output.explored < buildPolicyOptions(input).explored);
  for (const option of output.options) {
    for (const lock of constraints.lockedDecisions) assert.ok(option.scenario.decisions.some(decision =>
      decision.measureId === lock.measureId && decision.districtId === lock.districtId));
    assert.notEqual(option.changed.removed.measureId, 'M5');
    assert.notEqual(option.changed.removed.measureId, 'M12');
  }
});

test('priority frontier matches independently filtered exhaustive candidates before ranking or display limit', () => {
  const input = official();
  const baseline = simulate(input);
  const all = enumerate(input).valid;
  for (const protectedIndicator of [{ indicatorId: 'E2' }, { indicatorId: 'E2', districtId: 'saryarka' },
    { indicatorId: 'T1', districtId: 'nura' }]) {
    for (const lockedDecisions of [[], [input.decisions[0]]]) {
      const constraints = { lockedDecisions, protectedIndicator };
      const allowed = all.filter(item => lockedDecisions.every(lock => item.scenario.decisions.some(decision =>
        JSON.stringify(decision) === JSON.stringify(lock))) && baseline.districts.every(district => {
        if (protectedIndicator.districtId && district.id !== protectedIndicator.districtId) return true;
        return item.result.districts.find(other => other.id === district.id).after[protectedIndicator.indicatorId]
          >= district.after[protectedIndicator.indicatorId];
      }));
      const frontier = allowed.filter(item => metrics(item.result).some((value, index) => value > metrics(baseline)[index])
        && ![baseline, ...allowed.map(other => other.result)].some(other => strictlyBetter(other, item.result)));
      const output = buildPolicyOptions(input, { constraints, limit: 12 });
      assert.equal(output.exhaustiveWithinScope, true);
      assert.equal(output.validCandidates, allowed.length);
      assert.equal(output.paretoCandidates, frontier.length);
      assert.deepEqual(new Set(output.options.map(item => signature(item.scenario))),
        new Set(frontier.map(item => signature(item.scenario))));
      const capped = buildPolicyOptions(input, { constraints, limit: 1 });
      assert.equal(capped.paretoCandidates, frontier.length);
      assert.equal(capped.validCandidates, allowed.length);
      assert.deepEqual(capped.options, output.options.slice(0, 1));
    }
  }
  const protectedOutput = buildPolicyOptions(input, { constraints: { protectedIndicator: { indicatorId: 'E2' } } });
  assert.ok(protectedOutput.rejectedByConstraints > 0);
  assert.notEqual(protectedOutput.options[0]?.id, buildPolicyOptions(input, { limit: 1 }).options[0]?.id);
});

test('all decisions locked returns an explicit empty allowed search, not an unrestricted recommendation', () => {
  const input = official();
  const output = buildPolicyOptions(input, { constraints: { lockedDecisions: input.decisions } });
  assert.equal(output.valid, true);
  assert.equal(output.constraintScope, 'constrained');
  assert.equal(output.exhaustiveWithinScope, true);
  assert.equal(output.emptyReason.code, 'ALL_DECISIONS_LOCKED');
  assert.equal(output.explored, 0);
  assert.deepEqual(output.options, []);
});

test('malformed constraints fail closed and never silently broaden the search', () => {
  for (const constraints of [null, [], 'E1', 1, new Date(), new Map(), { unexpected: true }, { lockedDecisions: null },
    { lockedDecisions: [{}] }, { lockedDecisions: [{ measureId: 'M7' }] },
    { lockedDecisions: [{ measureId: 'M7', districtId: 'esil' }] },
    { lockedDecisions: [{ measureId: 'M1', districtId: 'nura' }] },
    { lockedDecisions: [{ measureId: 'M12', districtId: 'nura' }] },
    { lockedDecisions: [{ measureId: 'M12', districtId: undefined }] },
    { lockedDecisions: [{ measureId: 'M12', extra: true }] },
    { lockedDecisions: [{ measureId: 'M12' }, { measureId: 'M12' }] },
    { protectedIndicator: {} }, { protectedIndicator: 'E1' },
    { protectedIndicator: { indicatorId: 'E99' } },
    { protectedIndicator: { indicatorId: 'E1', districtId: null } },
    { protectedIndicator: { indicatorId: 'E1', districtId: 'unknown' } },
    { protectedIndicator: { indicatorId: 'E1', minimum: 0 } },
  ]) {
    const output = buildPolicyOptions(official(), { constraints });
    assert.equal(output.valid, false, JSON.stringify(constraints));
    assert.equal(output.exhaustiveWithinScope, false);
    assert.equal(output.emptyReason.code, 'INVALID_CONSTRAINTS');
    assert.equal(output.errors[0].code, 'INVALID_CONSTRAINTS');
    assert.equal(output.explored, 0);
    assert.deepEqual(output.options, []);
  }
});

test('constraints are canonical, deterministic, copied and backward compatible', () => {
  const input = freeze(official());
  const constraints = freeze({ lockedDecisions: [input.decisions[3], input.decisions[0]],
    protectedIndicator: { indicatorId: 'E1', districtId: 'saryarka' } });
  const expected = buildPolicyOptions(input, { constraints });
  assert.deepEqual(buildPolicyOptions(input, { constraints: { ...constraints,
    lockedDecisions: [...constraints.lockedDecisions].reverse() } }), expected);
  const modified = buildPolicyOptions(input, { constraints });
  modified.constraints.lockedDecisions[0].measureId = 'M999';
  modified.constraints.protectedIndicator.indicatorId = 'E99';
  assert.deepEqual(buildPolicyOptions(input, { constraints }), expected);
  assert.deepEqual(buildPolicyOptions(input, { constraints: {} }), buildPolicyOptions(input));
});

test('worsened indicators name every model regression against the calculated baseline', () => {
  const output = buildPolicyOptions(official());
  assert.ok(output.options.some(option => option.worsenedIndicators.length));
  for (const option of output.options) {
    const expected = option.result.districts.flatMap(district => getDataset().indicators
      .filter(({ id }) => district.after[id] < output.baseline.result.districts.find(previous => previous.id === district.id).after[id])
      .map(({ id }) => `${district.id}:${id}`));
    assert.deepEqual(option.worsenedIndicators.map(item => `${item.districtId}:${item.indicatorId}`), expected);
    for (const item of option.worsenedIndicators) {
      assert.ok(item.indicatorName.length > item.indicatorId.length);
      assert.equal(item.delta, item.value - item.baseline);
      assert.ok(item.delta < 0);
    }
  }
});
