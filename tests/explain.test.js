import test from 'node:test';
import assert from 'node:assert/strict';
import { getDataset, getBaseline, simulate, validateScenario } from '../src/core/simulator.js';
import { buildExplanationFacts, explainScenario } from '../src/ai/explain.js';

// All provider interactions in this file are mocked; no real key or network is used.
const TEST_KEY = 'test-only-not-a-real-key';
const MODEL = 'test-model';
const example = () => ({ decisions: [
  { measureId: 'M7', districtId: 'nura' },
  { measureId: 'M8', districtId: 'nura' },
  { measureId: 'M10', districtId: 'nura' },
  { measureId: 'M12' },
  { measureId: 'M5', districtId: 'saryarka' },
] });
const analysis = () => ({
  summary: 'Социальные меры устраняют критические показатели Нуры.',
  strengths: ['Школа и поликлиника улучшают социальную инфраструктуру.'],
  risks: ['В транспорте сохраняются нерешённые проблемы.'],
  recommendations: ['Сравните проверенную замену одного решения.'],
});
const completed = (value = analysis()) => ({
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
});
const mockOptions = (fetchImpl, more = {}) => ({
  apiKey: TEST_KEY, model: MODEL, fetchImpl, ...more,
});
const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });

function close(actual, expected) {
  assert.ok(Number.isFinite(actual));
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
}

function assertFallback(output, reason) {
  assert.equal(output.mode, 'deterministic');
  assert.equal(output.available, false);
  assert.equal(output.reason, reason);
  assert.match(output.summary, /LLM-анализ не выполнен/);
  assert.match(output.summary, /52\.56 → 56\.54/);
  for (const field of ['strengths', 'risks', 'recommendations']) {
    assert.ok(Array.isArray(output[field]) && output[field].length > 0);
    assert.ok(output[field].every((item) => typeof item === 'string' && item.trim()));
  }
}

test('missing or whitespace key explicitly returns an unavailable deterministic explanation without fetching', async () => {
  const scenario = example();
  const result = simulate(scenario);
  let calls = 0;
  for (const apiKey of ['', '   ']) {
    const output = await explainScenario(scenario, result, {
      apiKey,
      fetchImpl: async () => { calls += 1; throw new Error('Network must not be used'); },
    });
    assertFallback(output, 'not_configured');
    assert.match(output.recommendations.join(' '), /шестое решение добавлять нельзя/);
  }
  assert.equal(calls, 0);
});

test('facts contain official computed numbers, district effects, catalogue costs and synergy', () => {
  const scenario = example();
  const result = simulate(scenario);
  const facts = buildExplanationFacts(scenario, result);
  assert.equal(facts.synthetic, true);
  assert.equal(facts.horizonQuarters, 8);
  assert.equal(facts.budget, 100);
  assert.equal(facts.totalCost, 95);
  assert.equal(facts.remainingBudget, 5);
  close(facts.score, 56.54307);
  close(facts.baselineScore, 52.55768);
  close(facts.deltaScore, 3.98539);
  close(facts.weightedAverage, 58.0776);
  close(facts.worstDistrictScore, 52.9625);
  assert.equal(facts.weakestDistrict, 'Нура');
  assert.equal(facts.criticalCount, 0);
  assert.deepEqual(facts.critical, []);
  assert.deepEqual(facts.districts, result.districts);
  assert.deepEqual(facts.contributions, result.contributions);
  assert.deepEqual(facts.synergies, [{ pair: ['M10', 'M12'], districtId: 'nura', effects: { B1: 2 } }]);
  assert.equal(facts.decisions.find((item) => item.id === 'M7').cost, 24);
  assert.equal(facts.decisions.find((item) => item.id === 'M12').target, 'Все районы');
});

test('critical facts and deterministic risks preserve a remaining social deficit and negative transport effect', async () => {
  const scenario = { decisions: [
    { measureId: 'M9', districtId: 'nura' },
    { measureId: 'M11', districtId: 'almaty' },
    { measureId: 'M10', districtId: 'esil' },
    { measureId: 'M12' },
    { measureId: 'M4', districtId: 'esil' },
  ] };
  const result = simulate(scenario);
  const facts = buildExplanationFacts(scenario, result);
  assert.equal(facts.criticalCount, 2);
  assert.deepEqual(facts.critical.map((item) => [item.district, item.value]), [
    ['Алматы', 38.25], ['Нура', 37.625],
  ]);
  const output = await explainScenario(scenario, result, { apiKey: '' });
  assert.equal(output.available, false);
  assert.match(output.risks.join(' '), /M11: T1 -1\.75/);
  assert.match(output.risks.join(' '), /Алматы.*38\.25/);
  assert.match(output.risks.join(' '), /Нура.*37\.63/);
});

test('bestSingleReplacement is valid, changes one decision and is best among all allowed single replacements', () => {
  const scenario = example();
  const result = simulate(scenario);
  const best = buildExplanationFacts(scenario, result).bestSingleReplacement;
  assert.ok(best, 'The official example has an improving one-decision replacement');
  assert.equal(validateScenario(best.scenario).valid, true);
  const calculated = simulate(best.scenario);
  close(best.score, calculated.score);
  assert.equal(best.totalCost, calculated.totalCost);
  assert.ok(best.totalCost <= 100);
  assert.ok(best.score > result.score);
  const changed = scenario.decisions.map((decision, index) =>
    JSON.stringify(decision) !== JSON.stringify(best.scenario.decisions[index]) ? index : -1)
    .filter((index) => index >= 0);
  assert.equal(changed.length, 1);
  assert.deepEqual(best.removed, scenario.decisions[changed[0]]);
  assert.deepEqual(best.added, best.scenario.decisions[changed[0]]);

  // Enumerate the public contract's one-decision neighbourhood independently.
  const dataset = getDataset();
  for (let index = 0; index < 5; index += 1) {
    for (const measure of dataset.measures) {
      const choices = measure.scope === 'city' ? [{ measureId: measure.id }]
        : dataset.districts.map((district) => ({ measureId: measure.id, districtId: district.id }));
      for (const replacement of choices) {
        const candidate = structuredClone(scenario);
        candidate.decisions[index] = replacement;
        const checked = simulate(candidate);
        if (checked.valid) assert.ok(checked.score <= best.score + 1e-8);
      }
    }
  }
});

test('invalid calculated scenarios fail before any API call', async () => {
  const scenario = { decisions: [] };
  const result = simulate(scenario);
  let called = false;
  await assert.rejects(explainScenario(scenario, result, mockOptions(async () => {
    called = true;
    return jsonResponse(completed());
  })), /valid calculated scenario/);
  assert.equal(called, false);
});

test('server-side simulation rejects client budget, score, cost and effects before explanation', async () => {
  const attempts = [
    { ...example(), budget: 999 },
    { ...example(), score: 999 },
    { decisions: example().decisions.map((decision, index) =>
      index === 0 ? { ...decision, cost: 0 } : decision) },
    { decisions: example().decisions.map((decision, index) =>
      index === 0 ? { ...decision, effects: { S1: 999 } } : decision) },
  ];
  let calls = 0;
  for (const scenario of attempts) {
    // Mirrors the server boundary: compute the result locally, never accept a client result.
    const result = simulate(scenario);
    assert.equal(result.valid, false);
    await assert.rejects(explainScenario(scenario, result, mockOptions(async () => {
      calls += 1;
      return jsonResponse(completed());
    })), /valid calculated scenario/);
  }
  assert.equal(calls, 0);
});

test('successful mocked Responses request contains trusted simulator facts and returns the structured analysis', async () => {
  const scenario = example();
  const result = simulate(scenario);
  const scenarioBefore = structuredClone(scenario);
  const resultBefore = structuredClone(result);
  let calls = 0;
  const output = await explainScenario(scenario, result, mockOptions(async (url, init) => {
    calls += 1;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, `Bearer ${TEST_KEY}`);
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.ok(init.signal instanceof AbortSignal);
    const request = JSON.parse(init.body);
    assert.equal(request.model, MODEL);
    assert.equal(request.store, false);
    assert.equal(request.text.format.type, 'json_schema');
    assert.equal(request.text.format.strict, true);
    assert.deepEqual(request.text.format.schema.required, ['summary', 'strengths', 'risks', 'recommendations']);
    assert.equal(request.text.format.schema.additionalProperties, false);
    assert.equal(request.input[0].role, 'developer');
    assert.match(request.input[0].content, /Не рассчитывай новые числа/);
    assert.equal(request.input[1].role, 'user');
    const sentFacts = JSON.parse(request.input[1].content);
    assert.deepEqual(sentFacts, JSON.parse(JSON.stringify(buildExplanationFacts(scenario, result))));
    close(sentFacts.score, 56.54307);
    assert.equal(sentFacts.budget, 100);
    assert.equal(sentFacts.totalCost, 95);
    assert.equal(sentFacts.decisions.find((item) => item.id === 'M7').cost, 24);
    assert.equal(simulate(sentFacts.bestSingleReplacement.scenario).valid, true);
    return jsonResponse(completed());
  }));
  assert.equal(calls, 1);
  assert.deepEqual(output, { mode: 'ai', available: true, model: MODEL, ...analysis() });
  assert.deepEqual(scenario, scenarioBefore);
  assert.deepEqual(result, resultBefore);
});

for (const status of [401, 403, 429, 500]) {
  test(`mocked HTTP ${status} is explicitly unavailable and never parsed as AI success`, async () => {
    const scenario = example();
    let jsonCalled = false;
    const output = await explainScenario(scenario, simulate(scenario), mockOptions(async () => ({
      ok: false, status,
      json: async () => { jsonCalled = true; return completed(); },
    })));
    assertFallback(output, status === 429 ? 'rate_limited' : 'provider_error');
    assert.equal(jsonCalled, false);
  });
}

const rejectedResponses = [
  ['refusal', { status: 'completed', output: [{ content: [
    { type: 'output_text', text: JSON.stringify(analysis()) },
    { type: 'refusal', refusal: 'I cannot help.' },
  ] }] }],
  ['incomplete response with otherwise valid JSON', { ...completed(), status: 'incomplete' }],
  ['failed response with otherwise valid JSON', { ...completed(), status: 'failed' }],
  ['missing status', { output: completed().output }],
  ['empty output', { status: 'completed', output: [] }],
  ['non-JSON output', { status: 'completed', output: [{ content: [{ type: 'output_text', text: 'invalid json' }] }] }],
  ['null response body', null],
  ['missing recommendations', completed({ summary: 'Summary', strengths: ['S'], risks: ['R'] })],
  ['blank summary', completed({ ...analysis(), summary: '   ' })],
  ['numeric risk', completed({ ...analysis(), risks: [123] })],
  ['empty strengths', completed({ ...analysis(), strengths: [] })],
  ['unexpected numeric score', completed({ ...analysis(), score: 999 })],
  ['unexpected available flag', completed({ ...analysis(), available: true })],
];
for (const [label, body] of rejectedResponses) {
  test(`mocked ${label} cannot produce a successful AI analysis`, async () => {
    const scenario = example();
    const output = await explainScenario(scenario, simulate(scenario),
      mockOptions(async () => jsonResponse(body)));
    assertFallback(output, 'provider_error');
  });
}

test('mocked response.json failure and network rejection fall back without changing calculation', async () => {
  const scenario = example();
  const result = simulate(scenario);
  const snapshot = structuredClone(result);
  for (const fetchImpl of [
    async () => { throw new TypeError('Mock transport failed'); },
    async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Invalid body'); } }),
  ]) {
    assertFallback(await explainScenario(scenario, result, mockOptions(fetchImpl)), 'provider_error');
    assert.deepEqual(result, snapshot);
    assert.deepEqual(simulate(scenario), snapshot);
  }
});

test('timeout aborts an in-flight mocked fetch and preserves the usable calculator result', async () => {
  const scenario = example();
  const result = simulate(scenario);
  const baseline = getBaseline();
  let aborted = false;
  const output = await explainScenario(scenario, result, mockOptions((_url, { signal }) =>
    new Promise((resolve, reject) => {
      // This timer also keeps the event loop alive while AbortSignal.timeout is unref'ed.
      const guard = setTimeout(() => resolve(jsonResponse(completed())), 1000);
      const onAbort = () => {
        aborted = true;
        clearTimeout(guard);
        reject(signal.reason);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }), { timeoutMs: 10 }));
  assert.equal(aborted, true);
  assertFallback(output, 'timeout');
  close(result.score, 56.54307);
  assert.deepEqual(simulate(scenario), result);
  assert.deepEqual(getBaseline(), baseline);
});

test('injected fetches do not reuse cached success when the next provider call fails', async () => {
  const scenario = example();
  const result = simulate(scenario);
  const first = await explainScenario(scenario, result,
    mockOptions(async () => jsonResponse(completed())));
  assert.equal(first.available, true);
  let calls = 0;
  const second = await explainScenario(scenario, result, mockOptions(async () => {
    calls += 1;
    return { ok: false, status: 500 };
  }));
  assert.equal(calls, 1);
  assertFallback(second, 'provider_error');
});
