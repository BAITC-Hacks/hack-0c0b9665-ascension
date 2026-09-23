import test from 'node:test';
import assert from 'node:assert/strict';
import { getDataset, getBaseline, simulate } from '../src/core/simulator.js';
import { selectDistrictIndicators, districtRecommendations, districtCsv } from '../public/district-explorer.js';
import { scoreBreakdown, realizedMeasure } from '../public/method-guide.js';

const dataset = getDataset();
const baseline = getBaseline();
const result = simulate({ decisions: [
  { measureId: 'M7', districtId: 'nura' }, { measureId: 'M8', districtId: 'nura' },
  { measureId: 'M10', districtId: 'nura' }, { measureId: 'M12' }, { measureId: 'M5', districtId: 'saryarka' },
] });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('district explorer applies the strict critical threshold to the selected district and view', () => {
  const critical = selectDistrictIndicators(dataset, baseline, { criticalOnly: true });
  assert.deepEqual(critical.indicators.map(item => item.id), ['S2', 'S1']);
  assert.equal(critical.districts.length, 5);
  assert.equal(selectDistrictIndicators(dataset, baseline, { criticalOnly: true, districtId: 'almaty' }).indicators.length, 0);
  assert.equal(selectDistrictIndicators(dataset, result, { criticalOnly: true }).indicators.length, 0);
  assert.equal(selectDistrictIndicators(dataset, baseline, { districtId: 'nura', direction: 'transport', criticalOnly: true }).indicators.length, 0, 'The value 40 must not count as critical');
});

test('district explorer combines direction and normalized name/code search without mutating the source', () => {
  const snapshot = JSON.stringify({ dataset, result });
  assert.deepEqual(selectDistrictIndicators(dataset, result, { districtId: 'nura', direction: 'social', query: '  ШКОЛЫ  ' }).indicators.map(item => item.id), ['S1']);
  assert.deepEqual(selectDistrictIndicators(dataset, result, { query: 'c2' }).indicators.map(item => item.id), ['C2']);
  assert.equal(selectDistrictIndicators(dataset, result, { direction: 'safety', query: 'школы' }).indicators.length, 0);
  assert.equal(selectDistrictIndicators(dataset, result, { districtId: 'nura', sort: 'gain' }).indicators[0].id, 'B1');
  assert.equal(selectDistrictIndicators(dataset, baseline, { districtId: 'nura', sort: 'strongest' }).indicators[0].id, 'E2');
  assert.equal(JSON.stringify({ dataset, result }), snapshot);
});

test('district recommendation ranking uses actual lag and weakest indicators, with useful scope/cost data', () => {
  const recommendations = districtRecommendations(dataset, baseline.districts.find(district => district.id === 'nura'));
  assert.equal(recommendations.length, 3);
  assert.deepEqual(recommendations.map(item => item.measure.id), ['M9', 'M8', 'M7']);
  assert.equal(recommendations[1].benefits[0].effect, 8.75);
  assert.equal(recommendations[2].benefits[0].effect, 10);
  assert.ok(recommendations.every(item => item.measure.cost > 0 && item.benefits.length > 0));
});

test('district CSV exports precisely the current view and filters with BOM and safe text cells', () => {
  const csv = districtCsv(dataset, result, { districtId: 'nura', direction: 'social', query: 's2', mode: 'comparison' });
  assert.ok(csv.startsWith('\uFEFF'));
  const rows = csv.slice(1).split('\r\n');
  assert.equal(rows.length, 2);
  assert.match(rows[1], /"Учебный сценарий";"Нура";"S2"/);
  assert.match(rows[1], /;"35";"43.75";"8.75";"Нет"$/);
  const altered = structuredClone(result);
  altered.districts[0].name = '=UNTRUSTED("text")';
  altered.districts[0].delta.T1 = -1.75;
  const escaped = districtCsv(dataset, altered, { districtId: altered.districts[0].id, query: 'T1' });
  assert.ok(escaped.includes('"\'=UNTRUSTED(""text"")"'));
  assert.ok(escaped.includes('"-1.75"'), 'Numeric negative deltas stay numeric in spreadsheet imports');
  assert.ok(!escaped.includes('"\'-1.75"'));
});

test('method breakdown reconciles every displayed subtotal with the authoritative baseline and scenario', () => {
  for (const output of [baseline, result]) {
    const breakdown = scoreBreakdown(dataset, output);
    close(breakdown.averagePart + breakdown.weakestPart - breakdown.penalty, output.score);
    close(breakdown.districts.reduce((sum, district) => sum + district.populationContribution, 0), output.weightedAverage);
    for (const district of breakdown.districts) close(district.indicators.reduce((sum, indicator) => sum + indicator.contribution, 0), district.afterScore);
    assert.equal(breakdown.critical.length, output.criticalCount);
    assert.deepEqual(breakdown.weakest.map(district => district.id), ['nura']);
  }
  assert.deepEqual(scoreBreakdown(dataset, baseline).critical.map(item => item.id), ['S1', 'S2']);
  assert.equal(scoreBreakdown(dataset, result).critical.length, 0);
});

test('method lag explainer matches server contributions, including negative effects and invalid measure', () => {
  for (const contribution of result.contributions) {
    const measure = realizedMeasure(dataset, contribution.measureId);
    close(measure.factor, contribution.realizedFactor);
    for (const effect of measure.effects) close(effect.realized, contribution.effects[effect.id]);
  }
  assert.deepEqual(realizedMeasure(dataset, 'M11').effects.map(item => item.realized), [10.5, -1.75]);
  assert.equal(realizedMeasure(dataset, 'M3').factor, 0.5);
  assert.equal(realizedMeasure(dataset, 'invalid'), null);
});
