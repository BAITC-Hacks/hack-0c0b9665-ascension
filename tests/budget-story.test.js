import test from 'node:test';
import assert from 'node:assert/strict';
import { getDataset, simulate } from '../src/core/simulator.js';
import { buildBudgetStory } from '../public/budget-story.js';

const official = { decisions: [{ measureId: 'M7', districtId: 'nura' }, { measureId: 'M8', districtId: 'nura' }, { measureId: 'M10', districtId: 'nura' }, { measureId: 'M12' }, { measureId: 'M5', districtId: 'saryarka' }] };

test('budget narrative preserves actual beneficiaries, costs and the weakest district', () => {
  const result = simulate(official);
  const story = buildBudgetStory(getDataset(), official, result);
  assert.equal(story.cost, 95);
  assert.equal(story.remaining, 5);
  assert.equal(story.beneficiaries.length, 5);
  assert.equal(story.beneficiaries[0].id, 'nura');
  assert.equal(story.weakest.id, 'nura');
  assert.equal(story.critical.length, 0);
  assert.equal(story.measures.find(item => item.id === 'M7').realized, 62.5);
  assert.equal(story.measures.find(item => item.id === 'M12').area, 'Все районы');
});

test('moving the school to Esil retains the critical Nura school indicator in the narrative', () => {
  const alternate = structuredClone(official);
  alternate.decisions[0].districtId = 'esil';
  const story = buildBudgetStory(getDataset(), alternate, simulate(alternate));
  assert.deepEqual(story.critical, [{ district: 'Нура', name: 'Школы и детсады', value: 38 }]);
  assert.equal(story.measures[0].area, 'Есиль');
  assert.equal(story.remaining, 5);
});

test('a large budget remainder does not get described as a funding shortfall and adverse effects survive', () => {
  const scenario = { decisions: [{ measureId: 'M9', districtId: 'nura' }, { measureId: 'M11', districtId: 'almaty' }, { measureId: 'M10', districtId: 'esil' }, { measureId: 'M12' }, { measureId: 'M4', districtId: 'esil' }] };
  const story = buildBudgetStory(getDataset(), scenario, simulate(scenario));
  assert.equal(story.remaining, 39);
  assert.ok(story.remaining >= story.cheapestUnselected);
  assert.equal(story.decisionCount, 5);
  assert.deepEqual(story.negative, ['Алматы: разгрузка дорог -1,75']);
  assert.equal(story.critical.length, 2);
});

test('invalid results cannot produce a budget explanation', () => {
  assert.throws(() => buildBudgetStory(getDataset(), { decisions: [] }, simulate({ decisions: [] })), /завершённый расчёт/);
});
