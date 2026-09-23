import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../src/core/simulator.js';
import { explainScenario } from '../src/ai/explain.js';

const scenario = { decisions: [
  { measureId: 'M7', districtId: 'nura' }, { measureId: 'M8', districtId: 'nura' },
  { measureId: 'M10', districtId: 'nura' }, { measureId: 'M12' },
  { measureId: 'M5', districtId: 'saryarka' },
] };
const valid = () => ({ summary: 'План поддерживает социальные потребности Нуры.',
  strengths: ['Школа и поликлиника сокращают социальные дефициты.'],
  risks: ['Транспорт не получает прямого улучшения.'], recommendations: ['FOCUS_WEAKEST'] });
async function explain(value, extra = {}, observe = () => {}) {
  const result = simulate(scenario);
  const output = await explainScenario(scenario, result, {
    apiKey: 'mock-only-grounding-test', model: 'mock-model', skipReplacementSearch: true,
    fetchImpl: async (_url, init) => {
      observe(JSON.parse(init.body));
      return { ok: true, json: async () => ({ status: 'completed', output: [
        { content: [{ type: 'output_text', text: JSON.stringify(value) }] },
      ] }) };
    }, ...extra,
  });
  assert.equal(result.totalCost, 95);
  assert.ok(Math.abs(result.score - 56.54307) < 1e-8);
  return output;
}

test('server renders numbers and resolves advisory codes; empty recommendations remain valid AI', async () => {
  const output = await explain(valid(), {}, request => {
    const codes = request.text.format.schema.properties.recommendations.items.enum;
    assert.ok(codes.includes('FOCUS_WEAKEST'));
    assert.ok(!codes.includes('VERIFIED_SINGLE_REPLACEMENT'));
    assert.ok(!codes.includes('REVIEW_CRITICAL'));
  });
  assert.equal(output.mode, 'ai');
  assert.equal(output.available, true);
  assert.match(output.summary, /52\.56 → 56\.54.*стоимость 95 из 100/);
  assert.match(output.recommendations[0], /Нура, оценка 52\.96/);
  assert.match(output.recommendations[1], /Поиск замены не выполнялся/);
  assert.match(output.risks.at(-1), /Качественное объяснение модели может содержать неточности/);
  const empty = await explain({ ...valid(), recommendations: [] });
  assert.equal(empty.mode, 'ai');
  assert.match(empty.recommendations[0], /Сравните альтернативные наборы/);
});

for (const summary of ['Score равен 999, бюджет 999.', 'Score равен 100.',
  'Оценка 56,54.', 'Score ９９９.', 'Улучшение на Ⅳ балла.',
  'Это подтверждённый прогноз для Астаны.', 'Глобальный оптимум найден.']) {
  test(`rejects unsupported provider prose: ${summary}`, async () => {
    const output = await explain({ ...valid(), summary });
    assert.equal(output.mode, 'deterministic');
    assert.equal(output.available, false);
    assert.equal(output.reason, 'invalid_model_analysis');
    assert.match(output.summary, /52\.56 → 56\.54/);
    assert.ok(!output.summary.includes(summary));
  });
}

for (const recommendation of ['Добавьте шестое решение', 'UNKNOWN', '__proto__',
  'M3:esil', 'VERIFIED_SINGLE_REPLACEMENT', 'REVIEW_CRITICAL']) {
  test(`rejects non-evidenced action ${recommendation}`, async () => {
    const output = await explain({ ...valid(), recommendations: [recommendation] });
    assert.equal(output.mode, 'deterministic');
    assert.equal(output.reason, 'invalid_model_analysis');
    assert.ok(!output.recommendations.includes(recommendation));
  });
}

test('numbers in strengths or risks also fail; only an actually computed replacement renders', async () => {
  for (const field of ['strengths', 'risks']) {
    const output = await explain({ ...valid(), [field]: ['Score 95 — допустимый бюджет, но ложная оценка.'] });
    assert.equal(output.reason, 'invalid_model_analysis');
  }
  const output = await explain({ ...valid(), recommendations: ['VERIFIED_SINGLE_REPLACEMENT'] },
    { skipReplacementSearch: false }, request => {
      assert.ok(request.text.format.schema.properties.recommendations.items.enum.includes('VERIFIED_SINGLE_REPLACEMENT'));
    });
  assert.equal(output.mode, 'ai');
  assert.match(output.recommendations[0], /M5.*M3.*57\.21.*стоимость 100/);
  assert.match(output.recommendations[0], /не глобальный оптимум/);
});

test('a rejected injected response never poisons the next valid response', async () => {
  assert.equal((await explain({ ...valid(), summary: 'Score 999.' })).mode, 'deterministic');
  assert.equal((await explain(valid())).mode, 'ai');
});
