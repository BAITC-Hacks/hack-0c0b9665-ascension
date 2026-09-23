import test from 'node:test';
import assert from 'node:assert/strict';
import { proposePlan } from '../src/ai/plan.js';
import { explainScenario } from '../src/ai/explain.js';
import { DEFAULT_CLOUDFLARE_NVIDIA_MODEL, DEFAULT_NVIDIA_MODEL, resolveAIConfiguration } from '../src/ai/provider.js';
import { simulate } from '../src/core/simulator.js';

const TEST_KEY = 'synthetic-nvidia-test-key';
const scenario = { decisions: [
  { measureId: 'M7', districtId: 'nura' }, { measureId: 'M8', districtId: 'nura' },
  { measureId: 'M10', districtId: 'nura' }, { measureId: 'M12' },
  { measureId: 'M5', districtId: 'saryarka' },
] };
const result = simulate(scenario);
const input = { prompt: 'Школа, поликлиника и освещение в Нуре, чистое топливо в Сарыарке и цифровая платформа обращений.' };
const plan = () => ({
  summary: 'Меры соответствуют социальным и экологическим приоритетам запроса.',
  decisions: scenario.decisions.map(decision => ({ ...decision, districtId: decision.districtId ?? null,
    source: 'requested', rationale: 'Мера указана пользователем.' })),
  unsupported: [], assumptions: [],
});
const analysis = () => ({ summary: 'План улучшает социальную инфраструктуру и качество воздуха.',
  strengths: ['Меры сочетают социальную поддержку и цифровые услуги.'],
  risks: ['Остаются дефициты в остальных районах.'], recommendations: ['COMPARE_SCENARIOS'] });
const completion = value => ({ choices: [{ index: 0, finish_reason: 'stop',
  message: { role: 'assistant', content: JSON.stringify(value) } }] });
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const options = fetchImpl => ({ provider: 'nvidia', apiKey: TEST_KEY, fetchImpl, skipReplacementSearch: true });

test('provider configuration selects NVIDIA credentials without falling through to OpenAI', () => {
  const env = { AI_PROVIDER: 'nvidia', NVIDIA_API_KEY: TEST_KEY, OPENAI_API_KEY: 'other-synthetic-key',
    OPENAI_MODEL: 'other-model' };
  assert.deepEqual(resolveAIConfiguration({}, env), {
    provider: 'nvidia', apiKey: TEST_KEY, model: DEFAULT_NVIDIA_MODEL, configured: true,
  });
  assert.equal(resolveAIConfiguration({}, { ...env, NVIDIA_API_KEY: '' }).configured, false);
  const typo = resolveAIConfiguration({}, { ...env, AI_PROVIDER: 'nvdiia' });
  assert.equal(typo.configured, false);
  assert.equal(typo.apiKey, '');
  assert.equal(resolveAIConfiguration({ provider: 'nvidia', apiKey: TEST_KEY, model: 'nvidia/custom' }, {}).model, 'nvidia/custom');
  assert.equal(resolveAIConfiguration({}, { OPENAI_API_KEY: TEST_KEY }).provider, 'openai');
});

test('NVIDIA plan request uses bounded JSON chat completions and authoritative simulator results', async () => {
  let calls = 0;
  const value = await proposePlan(input, options(async (url, init) => {
    calls++;
    assert.equal(url, 'https://integrate.api.nvidia.com/v1/chat/completions');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Authorization, `Bearer ${TEST_KEY}`);
    const body = JSON.parse(init.body);
    assert.equal(body.model, DEFAULT_NVIDIA_MODEL);
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 3000);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[0].content, /JSON Schema/);
    assert.match(body.messages[0].content, /"additionalProperties":false/);
    assert.match(body.messages[0].content, /"source"/);
    assert.match(body.messages[0].content, /"M7"/);
    assert.deepEqual(body.messages[1], { role: 'user', content: input.prompt });
    assert.equal(body.input, undefined);
    assert.equal(body.reasoning, undefined);
    return jsonResponse(completion(plan()));
  }));
  assert.equal(calls, 1);
  assert.equal(value.mode, 'ai');
  assert.equal(value.provider, 'nvidia');
  assert.equal(value.model, DEFAULT_NVIDIA_MODEL);
  assert.equal(value.valid, true);
  assert.deepEqual(value.result, result);
  assert.equal(value.result.totalCost, 95);
});

test('NVIDIA explanation uses the same evidence contract and server-rendered figures', async () => {
  const value = await explainScenario(scenario, result, options(async (url, init) => {
    assert.equal(url, 'https://integrate.api.nvidia.com/v1/chat/completions');
    const body = JSON.parse(init.body);
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[0].content, /COMPARE_SCENARIOS/);
    assert.equal(JSON.parse(body.messages[1].content).score, result.score);
    return jsonResponse(completion(analysis()));
  }));
  assert.equal(value.mode, 'ai');
  assert.equal(value.provider, 'nvidia');
  assert.equal(value.model, DEFAULT_NVIDIA_MODEL);
  assert.match(value.summary, /56\.54/);
  assert.match(value.recommendations[0], /Сравните альтернативные наборы/);
});

test('NVIDIA output cannot supply invented IDs, extra fields or calculated numbers', async () => {
  for (const mutate of [
    value => { value.decisions[0].measureId = 'INVENTED'; },
    value => { value.summary = 'Бюджет равен 999.'; },
    value => { value.score = 999; },
  ]) {
    const proposal = plan();
    mutate(proposal);
    const value = await proposePlan(input, options(async () => jsonResponse(completion(proposal))));
    assert.equal(value.mode, 'unavailable');
    assert.equal(value.reason, 'invalid_model_plan');
    assert.equal(value.result, undefined);
    assert.equal(value.provider, undefined);
  }
  const unsafeAnalysis = analysis();
  unsafeAnalysis.summary = 'Score равен 999.';
  const value = await explainScenario(scenario, result, options(async () => jsonResponse(completion(unsafeAnalysis))));
  assert.equal(value.mode, 'deterministic');
  assert.equal(value.reason, 'invalid_model_analysis');
  assert.equal(value.provider, undefined);
});

test('NVIDIA prose resolves exact catalogue IDs without allowing invented IDs or numeric claims', async () => {
  const proposal = plan();
  proposal.summary = 'Приоритеты плана: M7, M8 и M10.';
  proposal.decisions[0].rationale = 'Пользователь запросил M7.';
  proposal.assumptions = ['M12 применяется по всему городу, M5 — в Сарыарке.'];
  const value = await proposePlan(input, options(async () => jsonResponse(completion(proposal))));
  assert.equal(value.mode, 'ai');
  assert.equal(value.valid, true);
  assert.doesNotMatch(value.modelComment.text, /M\d/u);
  assert.doesNotMatch(value.decisionOrigins[0].modelRationale, /M\d/u);
  assert.doesNotMatch(value.assumptions.join(' '), /M\d/u);
  assert.deepEqual(value.result, result);
  for (const summary of ['M999 улучшает город.', 'M7 стоит 95.', 'M7M999 улучшают город.']) {
    const unsafe = { ...proposal, summary };
    const rejected = await proposePlan(input, options(async () => jsonResponse(completion(unsafe))));
    assert.equal(rejected.mode, 'unavailable');
    assert.equal(rejected.reason, 'invalid_model_plan');
  }
});

test('incomplete, tool, multiple-choice and non-JSON NVIDIA responses cannot be labeled AI', async () => {
  for (const change of [
    value => { value.choices[0].finish_reason = 'length'; },
    value => { value.choices[0].finish_reason = 'content_filter'; },
    value => { value.choices[0].message.tool_calls = [{ id: 'unused' }]; },
    value => { value.choices.push(structuredClone(value.choices[0])); },
    value => { value.choices[0].message.content = '```json\n{}\n```'; },
    value => { value.choices[0].message.content = '<think>reasoning</think>{}'; },
    value => { value.choices[0].message.role = 'user'; },
  ]) {
    const envelope = completion(plan());
    change(envelope);
    const value = await proposePlan(input, options(async () => jsonResponse(envelope)));
    assert.equal(value.mode, 'unavailable');
    assert.equal(value.available, false);
    assert.equal(value.result, undefined);
  }
  const refusal = completion(plan());
  refusal.choices[0].message.refusal = 'Declined';
  assert.equal((await proposePlan(input, options(async () => jsonResponse(refusal)))).reason, 'refused');
});

test('oversized NVIDIA envelopes are bounded and never interpreted as successful responses', async () => {
  const oversized = () => new Response('x'.repeat(65537));
  const value = await proposePlan(input, options(async () => oversized()));
  assert.equal(value.mode, 'unavailable');
  assert.equal(value.reason, 'invalid_model_plan');
  const explanation = await explainScenario(scenario, result, options(async () => oversized()));
  assert.equal(explanation.mode, 'deterministic');
  assert.equal(explanation.reason, 'invalid_model_analysis');
});

test('NVIDIA HTTP errors do not retry, expose credentials or masquerade as AI', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(TEST_KEY, { status: 429 }); };
  const value = await proposePlan(input, options(fetchImpl));
  assert.equal(calls, 1);
  assert.equal(value.mode, 'unavailable');
  assert.equal(value.reason, 'rate_limited');
  assert.equal(JSON.stringify(value).includes(TEST_KEY), false);
});

test('NVIDIA timeout bounds transports that ignore cancellation', async () => {
  let signal;
  const value = await proposePlan(input, { ...options(async (_url, init) => {
    signal = init.signal;
    return new Promise(() => {});
  }), timeoutMs: 5 });
  assert.equal(value.mode, 'unavailable');
  assert.equal(value.reason, 'timeout');
  assert.equal(signal.aborted, true);
});

test('missing NVIDIA key or misspelled provider never dispatches a request', async () => {
  let calls = 0;
  const opts = options(async () => { calls++; throw new Error('Must not dispatch'); });
  assert.equal((await proposePlan(input, { ...opts, apiKey: '' })).reason, 'not_configured');
  assert.equal((await proposePlan(input, { ...opts, provider: 'nvdiia' })).reason, 'not_configured');
  assert.equal((await explainScenario(scenario, result, { ...opts, apiKey: '' })).reason, 'not_configured');
  assert.equal(calls, 0);
});

test('Cloudflare NVIDIA configuration uses a real binding and survives resolution twice without fake keys', () => {
  const aiBinding = { run() {} };
  const config = resolveAIConfiguration({}, { AI_PROVIDER: 'nvidia-cloudflare', AI: aiBinding, NVIDIA_MODEL: DEFAULT_NVIDIA_MODEL });
  assert.equal(config.provider, 'nvidia');
  assert.equal(config.backend, 'cloudflare');
  assert.equal(config.model, DEFAULT_CLOUDFLARE_NVIDIA_MODEL);
  assert.equal(config.apiKey, '');
  assert.equal(config.configured, true);
  assert.deepEqual(resolveAIConfiguration(config, {}), config);
  assert.equal(resolveAIConfiguration({ ...config, aiBinding: undefined }, { AI: aiBinding }).configured, false);
  assert.equal(resolveAIConfiguration({}, { AI_PROVIDER: 'nvidia-cloudflare', NVIDIA_API_KEY: TEST_KEY }).configured, false);
});

test('Cloudflare NVIDIA runs real chat input through the same plan and explanation validation', async () => {
  let calls = 0;
  const aiBinding = { async run(model, body, runOptions) {
    assert.equal(model, DEFAULT_CLOUDFLARE_NVIDIA_MODEL);
    assert.equal(body.model, undefined);
    assert.equal(body.stream, false);
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.response_format.json_schema.strict, true);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(runOptions.returnRawResponse, true);
    assert.ok(runOptions.signal instanceof AbortSignal);
    calls++;
    return jsonResponse(completion(calls === 1 ? plan() : analysis()));
  } };
  const opts = { provider: 'nvidia-cloudflare', aiBinding, skipReplacementSearch: true,
    fetchImpl: async () => { throw new Error('HTTP provider must not be called'); } };
  const value = await proposePlan(input, opts);
  assert.equal(value.mode, 'ai');
  assert.equal(value.provider, 'nvidia');
  assert.equal(value.backend, 'cloudflare');
  assert.deepEqual(value.result, result);
  const explanation = await explainScenario(scenario, result, opts);
  assert.equal(explanation.mode, 'ai');
  assert.equal(explanation.provider, 'nvidia');
  assert.equal(explanation.backend, 'cloudflare');
  assert.equal(calls, 2);
});

test('Cloudflare missing binding, failures, oversized bodies and stalled inference fail honestly', async () => {
  const opts = { provider: 'nvidia-cloudflare', aiBinding: undefined };
  assert.equal((await proposePlan(input, opts)).reason, 'not_configured');
  assert.equal((await proposePlan(input, { ...opts, aiBinding: { run: async () => new Response('fail', { status: 429 }) } })).reason, 'rate_limited');
  assert.equal((await proposePlan(input, { ...opts, aiBinding: { run: async () => new Response('x'.repeat(65537)) } })).reason, 'invalid_model_plan');
  const timed = await proposePlan(input, { ...opts, timeoutMs: 5,
    aiBinding: { run: async () => new Promise(() => {}) } });
  assert.equal(timed.mode, 'unavailable');
  assert.equal(timed.reason, 'timeout');
});
