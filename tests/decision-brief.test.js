import test from 'node:test';
import assert from 'node:assert/strict';
import { captureDecisionBrief, renderDecisionBriefHTML, mountDecisionBrief } from '../public/decision-brief.js';
import { MODEL_ID } from '../public/scenario-library.js';
import { getDataset, simulate } from '../src/core/simulator.js';

const city = { id: 'astana', name: 'Астана', hasScenarioData: true };
const createdAt = '2026-09-23T10:50:00.000Z';
const scenario = () => ({ decisions: [
  { measureId: 'M7', districtId: 'nura' }, { measureId: 'M8', districtId: 'nura' },
  { measureId: 'M10', districtId: 'nura' }, { measureId: 'M12' }, { measureId: 'M5', districtId: 'saryarka' },
] });
const detail = () => { const plan = scenario(); return { scenario: plan, result: simulate(plan) }; };
const capture = (value = detail(), options = {}) => captureDecisionBrief(value, { dataset: getDataset(), city, createdAt, ...options });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('official example is a named display projection of the server result, without recomputing score', () => {
  const brief = capture();
  assert.equal(brief.modelId, MODEL_ID);
  assert.equal(brief.createdAt, createdAt);
  assert.equal(brief.metrics.totalCost, 95);
  assert.equal(brief.metrics.remainingBudget, 5);
  close(brief.metrics.baselineScore, 52.55768);
  close(brief.metrics.score, 56.54307);
  close(brief.metrics.deltaScore, 3.98539);
  assert.deepEqual(brief.worst, ['Нура']);
  close(brief.metrics.worstDistrictScore, 52.9625);
  assert.equal(brief.criticalBefore.length, 2);
  assert.equal(brief.criticalAfter.length, 0);
  assert.equal(brief.worsened.length, 0);
  assert.equal(brief.decisions.length, 5);
  assert.equal(brief.decisions[0].name, 'Школа + детсад (модульное строительство)');
  assert.equal(brief.decisions[3].area, 'Все районы модели');
  assert.equal(brief.horizon, 8);
  assert.equal(brief.decisions[0].lag, 3);
  assert.equal(brief.synergies.length, 1);
  const sentinel = detail(); sentinel.result.score = 51.123; sentinel.result.deltaScore = -1.43468;
  assert.equal(capture(sentinel).metrics.score, 51.123, 'must use supplied result, not recreate formula');
});

test('negative side effect, critical improvement and exact threshold remain distinct', () => {
  const plan = { decisions: [
    { measureId: 'M9', districtId: 'nura' }, { measureId: 'M11', districtId: 'almaty' },
    { measureId: 'M10', districtId: 'esil' }, { measureId: 'M12' }, { measureId: 'M4', districtId: 'esil' },
  ] };
  const brief = capture({ scenario: plan, result: simulate(plan) });
  assert.equal(brief.worsened.length, 1);
  assert.deepEqual(brief.worsened[0], { district: 'Алматы', name: 'Разгрузка дорог', before: 40, after: 38.25, delta: -1.75 });
  assert.equal(brief.criticalAfter.length, 2);
  assert.ok(brief.criticalAfter.some((row) => row.district === 'Нура' && row.after === 37.625 && row.delta > 0));
  assert.ok(brief.criticalAfter.every((row) => row.after < 40));
  assert.match(renderDecisionBriefHTML(brief), /Разгрузка дорог: 40 → 38,25 \(-1,75\)/);
});

test('snapshots copy allowlisted fields and never mutate source objects or retain hidden text', () => {
  const source = detail();
  source.result.aiText = 'PRIVATE_AI_PROSE'; source.result.apiKey = 'SECRET_SENTINEL';
  source.scenario.decisions[0].extra = 'UNEXPECTED_DECISION';
  const dataset = getDataset();
  const before = structuredClone({ source, dataset });
  const brief = capture(source, { dataset });
  assert.deepEqual({ source, dataset }, before);
  source.result.score = -999;
  source.result.districts[0].after.T1 = -999;
  source.scenario.decisions[0].districtId = 'esil';
  dataset.measures.find((row) => row.id === 'M7').name = 'CHANGED';
  close(brief.metrics.score, 56.54307);
  assert.equal(brief.decisions[0].area, 'Район Нура');
  assert.ok(brief.districts[0].indicators[0].after >= 0);
  assert.doesNotMatch(JSON.stringify(brief), /PRIVATE_AI_PROSE|SECRET_SENTINEL|UNEXPECTED_DECISION|CHANGED/);
  const html = renderDecisionBriefHTML(brief);
  assert.doesNotMatch(html, /PRIVATE_AI_PROSE|SECRET_SENTINEL|UNEXPECTED_DECISION/);
});

test('malformed results fail closed and city must explicitly provide model data', () => {
  for (const change of [
    (value) => { value.result.valid = false; },
    (value) => { value.result.score = Infinity; },
    (value) => { value.result.totalCost = '95'; },
    (value) => { value.result.criticalCount = 0.5; },
    (value) => { value.result.criticalCount = 1; },
    (value) => { value.result.districts[0].delta.T1 = undefined; },
    (value) => { value.result.districts[1].id = value.result.districts[0].id; },
    (value) => { value.result.worstDistrictScore = -999; },
    (value) => { value.scenario.decisions.pop(); },
    (value) => { value.scenario.decisions[0].districtId = 'unknown'; },
  ]) { const value = detail(); change(value); assert.throws(() => capture(value)); }
  for (const selected of [undefined, {}, { hasScenarioData: false }, { hasScenarioData: 'true' }]) {
    assert.throws(() => capture(detail(), { city: selected }));
  }
});

test('standalone export safely escapes manual text and names, bounds fields and preserves evidence', () => {
  const dataset = getDataset();
  dataset.measures[6].name = '<img src=x onerror="alert(1)">';
  const brief = capture(detail(), { dataset });
  const title = '<script>alert("x")</script>';
  const goal = '<img src=x onerror=alert(1)> & \'quoted\'';
  const html = renderDecisionBriefHTML(brief, { title, goal, exportedAt: '2026-09-23T10:55:00Z' });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<html lang="ru">/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html, /<script|<img|<iframe|<link|src=\"https?:/i);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /Учебная модель\. Не прогноз для реальной Астаны/);
  assert.match(html, /2026-09-23 10:50:00 UTC/);
  assert.match(html, /2026-09-23 10:55:00 UTC/);
  assert.match(html, /дата реальных измерений/i);
  assert.match(html, /official-astana-v1/);
  assert.match(html, /https:\/\/drive.google.com\/file\/d\/1Uc-GdGoKhDY-spu8V50-ZMm33t2CjYLP\/view/);
  assert.equal((html.match(/<table>/g) || []).length, 3);
  assert.match(html, /Нура \/ Поликлиники и первичная медпомощь/);
  assert.match(html, /@media print/);
  const bounded = renderDecisionBriefHTML(brief, { title: 'x'.repeat(150), goal: 'y'.repeat(600) });
  assert.ok(bounded.includes('x'.repeat(100))); assert.ok(!bounded.includes('x'.repeat(101)));
  assert.ok(bounded.includes('y'.repeat(500))); assert.ok(!bounded.includes('y'.repeat(501)));
});

// Small DOM/event harness for lifecycle and explicit download behavior; browser QA is separate.
class Element extends EventTarget {
  constructor(tag, ownerDocument) { super(); this.tagName = tag; this.ownerDocument = ownerDocument; this.children = []; this.attributes = {}; this.ownText = ''; this.disabled = false; }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.ownText = ''; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this); }
  setAttribute(key, value) { this.attributes[key] = value; }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map((node) => node.textContent).join(' '); }
  click() { if (this.disabled) return; if (this.tagName === 'a') this.ownerDocument.downloads.push({ url: this.href, name: this.download }); this.dispatchEvent(new Event('click')); }
}
const all = (node) => [node, ...node.children.flatMap(all)];
function setup(selected = city) {
  const win = new EventTarget(); const blobs = []; const revoked = []; const timers = new Map();
  win.Blob = Blob; win.URL = { createObjectURL(blob) { blobs.push(blob); return `blob:${blobs.length}`; }, revokeObjectURL(url) { revoked.push(url); } };
  win.setTimeout = (fn) => { timers.set(timers.size + 1, fn); return timers.size; }; win.clearTimeout = (key) => timers.delete(key);
  const doc = { defaultView: win, downloads: [], createElement(tag) { return new Element(tag, doc); } };
  const container = doc.createElement('section');
  const dispose = mountDecisionBrief(container, { dataset: getDataset(), city: selected });
  const find = (suffix) => all(container).find((row) => row.className === `decision-brief-${suffix}`);
  return { container, doc, win, blobs, revoked, timers, dispose, find, emit(type, value) { win.dispatchEvent(new CustomEvent(type, { detail: value })); } };
}

test('mount is import-safe, download is explicit, and exported snapshot is independent', async () => {
  assert.equal(typeof globalThis.document, 'undefined');
  const ui = setup(); assert.equal(ui.find('download').disabled, true);
  const value = detail(); ui.emit('scenario:calculated', value);
  assert.equal(ui.find('download').disabled, false); assert.equal(ui.blobs.length, 0);
  value.result.score = -999;
  ui.find('input').value = '<script>title</script>'; ui.find('input').dispatchEvent(new Event('input'));
  assert.match(ui.find('preview-title').textContent, /<script>title<\/script>/);
  assert.ok(!all(ui.container).some((node) => node.tagName === 'script'));
  ui.find('download').click();
  assert.equal(ui.doc.downloads.length, 1);
  assert.match(await ui.blobs[0].text(), /56,54/);
  assert.doesNotMatch(await ui.blobs[0].text(), /-999/);
  ui.dispose(); assert.deepEqual(ui.revoked, ['blob:1']); assert.equal(ui.timers.size, 0);
});

test('plan changes, loading, invalid results, and city changes remove stale export; success restores it', () => {
  const ui = setup();
  for (const [event, value] of [['scenario:invalidated'], ['scenario:load', { scenario: scenario() }],
    ['city:changed', city], ['scenario:calculated', { result: { valid: false } }]]) {
    ui.emit('scenario:calculated', detail()); assert.equal(ui.find('download').disabled, false);
    ui.emit(event, value);
    assert.equal(ui.find('download').disabled, true); assert.equal(ui.find('preview').children.length, 0);
    ui.find('download').click(); assert.equal(ui.blobs.length, 0);
  }
  ui.emit('city:changed', { id: 'almaty', name: 'Алматы', hasScenarioData: false });
  ui.emit('scenario:calculated', detail()); assert.equal(ui.find('download').disabled, true);
  ui.emit('city:changed', city); assert.equal(ui.find('download').disabled, true);
  ui.emit('scenario:calculated', detail()); assert.equal(ui.find('download').disabled, false);
  ui.dispose(); ui.emit('scenario:calculated', detail()); assert.equal(ui.container.children.length, 0); ui.dispose();
});

test('late mount respects current city, duplicate mount detaches old controls, export failure is recoverable', () => {
  const ui = setup({ name: 'Алматы', hasScenarioData: false });
  ui.emit('scenario:calculated', detail()); assert.equal(ui.find('download').disabled, true);
  const oldButton = ui.find('download');
  const dispose = mountDecisionBrief(ui.container, { dataset: getDataset(), city });
  assert.equal(ui.container.children.length, 1);
  ui.emit('scenario:calculated', detail());
  oldButton.click(); assert.equal(ui.blobs.length, 0);
  ui.win.URL.createObjectURL = () => { throw new Error('download unavailable'); };
  ui.find('download').click(); assert.match(ui.find('status').textContent, /Не удалось/);
  assert.equal(ui.find('download').disabled, false);
  dispose();
});
