import test from 'node:test';
import assert from 'node:assert/strict';
import { getDataset, simulate } from '../src/core/simulator.js';
import { buildBudgetStory, mountBudgetStory } from '../public/budget-story.js';

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

test('budget panel discards stale requests, gates other cities and removes listeners on disposal', async () => {
  const target = new EventTarget();
  const children = [];
  const container = {
    hidden: false,
    closest() { return this.hidden ? this : null; },
    querySelector() { return children[0]; },
    contains(node) { return children.includes(node); },
    append(node) { node.isConnected = true; children.push(node); },
  };
  const ownerDocument = {
    getElementById() { return container; },
    createElement() {
      return Object.assign(new EventTarget(), {
        isConnected: false,
        setAttribute() {}, removeAttribute() {}, replaceChildren() {},
        remove() { this.isConnected = false; const index = children.indexOf(this); if (index >= 0) children.splice(index, 1); },
      });
    },
  };
  let release;
  let requests = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const rendered = [];
  const dispose = mountBudgetStory({ target, ownerDocument,
    fetcher: async () => { requests += 1; await pending; return { ok: true, json: async () => getDataset() }; },
    render: (_panel, story) => rendered.push(story),
  });
  const emit = (name, detail) => target.dispatchEvent(Object.assign(new Event(name), { detail }));
  const calculated = { scenario: official, result: simulate(official) };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  emit('scenario:calculated', calculated);
  assert.equal(children.length, 1);
  emit('scenario:invalidated');
  release();
  await settle();
  assert.equal(children.length, 0);
  assert.equal(rendered.length, 0, 'a finished stale request cannot restore the old calculation');

  emit('city:changed', { id: 'almaty', hasScenarioData: false });
  emit('scenario:calculated', calculated);
  assert.equal(children.length, 0);
  emit('city:changed', { id: 'astana', hasScenarioData: true });
  emit('scenario:calculated', calculated);
  await settle();
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].cost, 95);
  assert.equal(requests, 1, 'the immutable dataset is reused after invalidation');

  emit('city:changed', { id: 'almaty', hasScenarioData: false });
  assert.equal(children.length, 0, 'leaving Astana removes the displayed story');
  emit('city:changed', { id: 'astana', hasScenarioData: true });
  container.hidden = true;
  emit('scenario:calculated', calculated);
  assert.equal(children.length, 0, 'hidden model results do not receive a panel');
  container.hidden = false;
  dispose();
  emit('scenario:calculated', calculated);
  await settle();
  assert.equal(children.length, 0);
  assert.equal(rendered.length, 1);
});
