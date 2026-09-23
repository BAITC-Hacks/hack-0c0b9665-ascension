import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createNodeExplanation } from '../src/runtime/node-explanation.js';
import { simulate } from '../src/core/simulator.js';

const scenario = { decisions: [
  { measureId: 'M7', districtId: 'nura' }, { measureId: 'M8', districtId: 'nura' },
  { measureId: 'M10', districtId: 'nura' }, { measureId: 'M12' },
  { measureId: 'M5', districtId: 'saryarka' },
] };
const result = simulate(scenario);
const SYNTHETIC_KEY = 'test-only-node-cache-key';

async function withMockedProvider(run) {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  const originalModel = process.env.OPENAI_MODEL;
  const model = `cache-regression-${randomUUID()}`;
  let calls = 0;
  try {
    process.env.OPENAI_API_KEY = SYNTHETIC_KEY;
    process.env.OPENAI_MODEL = model;
    globalThis.fetch = async (_url, options) => {
      calls++;
      assert.equal(options.headers.Authorization, `Bearer ${SYNTHETIC_KEY}`);
      return Response.json({ status: 'completed', output: [{ type: 'message', content: [{
        type: 'output_text', text: JSON.stringify({
          summary: 'Социальные меры устраняют критические показатели Нуры.',
          strengths: ['Школа и поликлиника улучшают социальную инфраструктуру.'],
          risks: ['В транспорте сохраняются нерешённые проблемы.'],
          recommendations: ['COMPARE_SCENARIOS'],
        }),
      }] }] });
    };
    await run({ model, calls: () => calls });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = originalModel;
  }
}

test('default Node explanation retains its successful-response cache with shared admission', { concurrency: false }, async () => {
  await withMockedProvider(async ({ model, calls }) => {
    const explain = createNodeExplanation({
      aiLimits: { maxRequests: 5, requestsPerMinute: 5, maxConcurrent: 1 },
    });
    const first = await explain(scenario, result);
    const second = await explain(scenario, result);
    assert.equal(first.body.mode, 'ai');
    assert.equal(first.body.model, model);
    assert.deepEqual(second.body, first.body);
    assert.equal(calls(), 1, 'passing an explicit apiKey to the default provider would bypass its cache');
  });
});

test('denied and explicitly keyless Node explanations never reuse a process-level provider key', { concurrency: false }, async () => {
  await withMockedProvider(async ({ calls }) => {
    const denied = createNodeExplanation({ aiLimits: { maxRequests: 0 } });
    const deniedResult = await denied(scenario, result);
    assert.equal(deniedResult.body.mode, 'deterministic');
    assert.equal(deniedResult.body.available, false);
    assert.equal(deniedResult.body.reason, 'server_request_limit');
    assert.equal(calls(), 0);

    for (const env of [{}, { OPENAI_API_KEY: '' }]) {
      const keyless = createNodeExplanation({ env });
      const response = await keyless(scenario, result);
      assert.equal(response.body.mode, 'deterministic');
      assert.equal(response.body.available, false);
      assert.equal(response.body.reason, 'not_configured');
      assert.equal(calls(), 0, 'an explicit keyless environment must not fall back to process.env');
    }
  });
});
