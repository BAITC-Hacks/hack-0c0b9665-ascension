import assert from 'node:assert/strict';

// This intentionally makes up to three live AI requests to the selected installation.
const base = new URL(process.argv[2] || 'http://127.0.0.1:3000');
if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname)))
  || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
  throw new Error('Use an HTTPS origin or http://127.0.0.1:PORT, without credentials or a path.');
}

const startedAt = new Date().toISOString();
const scenario = { decisions: [
  { measureId: 'M7', districtId: 'nura' }, { measureId: 'M8', districtId: 'nura' },
  { measureId: 'M10', districtId: 'nura' }, { measureId: 'M12' },
  { measureId: 'M5', districtId: 'saryarka' },
] };
async function request(path, body) {
  const response = await fetch(new URL(path, base), {
    signal: AbortSignal.timeout(35000),
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base.origin },
      body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
  return value;
}
function requireNvidia(value) {
  assert.equal(value.mode, 'ai', `Real AI required, received ${value.mode} (${value.reason || 'no reason'})`);
  assert.equal(value.available, true);
  assert.equal(value.provider, 'nvidia', 'The active provider must be NVIDIA; another provider does not pass this check.');
  assert.match(value.model, /^(?:@cf\/)?nvidia\//);
}
const health = await request('/api/health');
assert.equal(health.aiConfigured, true, 'Configure AI_PROVIDER=nvidia-cloudflare with the AI binding, or AI_PROVIDER=nvidia with NVIDIA_API_KEY.');
const resultA = await request('/api/simulate', scenario);
assert.equal(resultA.totalCost, 95);
assert.ok(Math.abs(resultA.score - 56.54307) < 1e-8);
const explanationA = await request('/api/explain', scenario);
requireNvidia(explanationA);
const alternate = structuredClone(scenario);
alternate.decisions[0].districtId = 'esil';
const resultB = await request('/api/simulate', alternate);
assert.ok(Math.abs(resultB.score - 55.29777) < 1e-8);
const explanationB = await request('/api/explain', alternate);
requireNvidia(explanationB);
assert.notDeepEqual([explanationA.strengths, explanationA.risks], [explanationB.strengths, explanationB.risks],
  'Review required: the two different scenarios received identical qualitative analysis.');
const plan = await request('/api/plan', { prompt: 'В Нуре построить школу с детсадом, открыть поликлинику и добавить освещение с камерами; во всём городе внедрить единую цифровую платформу обращений; в Сарыарке перевести частный сектор на чистое топливо. Используй только эти пять мер и оцени последствия.' });
requireNvidia(plan);
assert.equal(plan.valid, true, 'NVIDIA returned a draft that did not pass the case constraints.');
assert.equal(plan.unsupported.length, 0);
const decisions = items => items.map(item => `${item.measureId}:${item.districtId || ''}`).sort();
assert.deepEqual(decisions(plan.decisions), decisions(scenario.decisions));
console.log(JSON.stringify({ ok: true, startedAt, completedAt: new Date().toISOString(), origin: base.origin,
  provider: 'nvidia', model: explanationA.model,
  examples: [{ score: resultA.score, explanation: explanationA }, { score: resultB.score, explanation: explanationB }],
  plan, checks: ['live NVIDIA analysis of two different calculated scenarios',
    'official cost and score', 'live NVIDIA plan from Russian text passes server validation'],
}, null, 2));
