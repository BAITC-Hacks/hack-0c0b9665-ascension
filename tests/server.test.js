import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../src/server.js';
import { explainScenario } from '../src/ai/explain.js';

const officialScenario = {
  decisions: [
    { measureId: 'M7', districtId: 'nura' }, { measureId: 'M8', districtId: 'nura' },
    { measureId: 'M10', districtId: 'nura' }, { measureId: 'M12' },
    { measureId: 'M5', districtId: 'saryarka' },
  ],
};
const overBudgetScenario = {
  decisions: [
    { measureId: 'M3', districtId: 'nura' }, { measureId: 'M5', districtId: 'saryarka' },
    { measureId: 'M7', districtId: 'nura' }, { measureId: 'M10', districtId: 'esil' },
    { measureId: 'M12' },
  ],
};
const fallbackExplanation = {
  mode: 'deterministic', available: false, summary: 'Объяснение по рассчитанным показателям.',
  strengths: [], risks: [], recommendations: [],
};

async function startServer(t, options = {}) {
  const server = createAppServer({ aiConfigured: () => false, explain: async () => fallbackExplanation, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  });
  return server.address().port;
}

// Raw HTTP preserves ../ and encoded separators rather than normalizing them as fetch would.
function request(port, path, { method = 'GET', body, headers = {}, chunks } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, (response) => {
      const pieces = [];
      response.on('data', chunk => pieces.push(chunk));
      response.once('error', reject);
      response.once('end', () => {
        const text = Buffer.concat(pieces).toString('utf8');
        resolve({ status: response.statusCode, headers: response.headers, text,
          json: () => JSON.parse(text) });
      });
    });
    req.once('error', reject);
    if (chunks) for (const chunk of chunks) req.write(chunk);
    req.end(body);
  });
}

function post(port, path, scenario) {
  return request(port, path, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(scenario) });
}

test('HTTP health, dataset and baseline expose the official public values', async (t) => {
  const port = await startServer(t);
  const health = await request(port, '/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.json(), { ok: true, aiConfigured: false });
  assert.match(health.headers['content-type'], /^application\/json; charset=utf-8$/);
  assert.equal(health.headers['x-content-type-options'], 'nosniff');
  assert.equal(health.headers['cache-control'], 'no-store');
  const dataset = await request(port, '/api/dataset');
  assert.equal(dataset.status, 200);
  assert.equal(dataset.json().budget, 100);
  assert.equal(dataset.json().measures.length, 14);
  const baseline = await request(port, '/api/baseline');
  assert.equal(baseline.status, 200);
  assert.ok(Math.abs(baseline.json().score - 52.55768) < 1e-8);
});

test('HTTP official scenario returns cost 95 and score 56.54307', async (t) => {
  const port = await startServer(t);
  const response = await post(port, '/api/simulate', officialScenario);
  assert.equal(response.status, 200);
  const result = response.json();
  assert.equal(result.valid, true);
  assert.equal(result.totalCost, 95);
  assert.equal(result.remainingBudget, 5);
  assert.ok(Math.abs(result.score - 56.54307) < 1e-8);
  assert.equal(result.criticalCount, 0);
  assert.equal(result.districts.length, 5);
});

test('HTTP validation is 200 for drafts and budget errors; calculation and explanation reject with 422', async (t) => {
  let explanationCalls = 0;
  const port = await startServer(t, { explain: async () => { explanationCalls++; return fallbackExplanation; } });
  const draft = await post(port, '/api/validate', { decisions: [] });
  assert.equal(draft.status, 200);
  assert.equal(draft.json().valid, false);
  assert.ok(draft.json().errors.some(error => error.code === 'DECISION_COUNT'));
  for (const path of ['/api/validate', '/api/simulate', '/api/explain']) {
    const response = await post(port, path, overBudgetScenario);
    assert.equal(response.status, path === '/api/validate' ? 200 : 422);
    const result = response.json();
    assert.equal(result.valid, false);
    assert.equal(result.totalCost, 105);
    assert.ok(result.errors.some(error => error.code === 'BUDGET_EXCEEDED'));
    assert.equal(result.score, undefined);
  }
  assert.equal(explanationCalls, 0);
});

test('HTTP rejects client budget, score and dataset overrides', async (t) => {
  const port = await startServer(t);
  for (const override of [{ budget: 999 }, { score: 100 }, { dataset: {} }]) {
    const response = await post(port, '/api/simulate', { ...officialScenario, ...override });
    assert.equal(response.status, 422);
    assert.ok(response.json().errors.some(error => error.code === 'UNKNOWN_FIELD'));
  }
});

test('HTTP explanation receives a fresh server calculation and preserves deterministic fallback labeling', async (t) => {
  let explanationCalls = 0;
  const port = await startServer(t, { explain: async (scenario, result) => {
    explanationCalls++;
    assert.deepEqual(scenario, officialScenario);
    assert.equal(result.totalCost, 95);
    assert.ok(Math.abs(result.score - 56.54307) < 1e-8);
    return fallbackExplanation;
  } });
  const response = await post(port, '/api/explain', officialScenario);
  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), fallbackExplanation);
  assert.equal(explanationCalls, 1);
});

test('HTTP real explanation module falls back without a key and after provider failure', async (t) => {
  for (const [reason, options] of [
    ['not_configured', { apiKey: '' }],
    ['provider_error', { apiKey: 'test-only-fake-key', fetchImpl: async () => ({ ok: false, status: 503 }) }],
  ]) {
    const port = await startServer(t, { explain: (scenario, result) => explainScenario(scenario, result, options) });
    const response = await post(port, '/api/explain', officialScenario);
    assert.equal(response.status, 200);
    const explanation = response.json();
    assert.equal(explanation.mode, 'deterministic');
    assert.equal(explanation.available, false);
    assert.equal(explanation.reason, reason);
    assert.ok(explanation.summary.length > 0);
    for (const field of ['strengths', 'risks', 'recommendations']) {
      assert.ok(Array.isArray(explanation[field]) && explanation[field].length > 0);
    }
    assert.doesNotMatch(response.text, /test-only-fake-key/);
  }
});

test('HTTP public AI limits preserve calculated fallback, expire the rolling window, and cap process requests', async (t) => {
  let calls = 0;
  let time = 100_000;
  const port = await startServer(t, { aiConfigured: () => true, now: () => time,
    aiLimits: { maxRequests: 2, requestsPerMinute: 1, maxConcurrent: 1 },
    explain: async () => { calls++; return { ...fallbackExplanation, mode: 'ai', available: true }; } });
  // Invalid scenarios consume no allowance and never reach the provider.
  assert.equal((await post(port, '/api/explain', overBudgetScenario)).status, 422);
  assert.equal((await post(port, '/api/explain', officialScenario)).json().mode, 'ai');
  const limited = await post(port, '/api/explain', officialScenario);
  assert.equal(limited.status, 200);
  assert.equal(limited.headers['retry-after'], '60');
  assert.equal(limited.json().mode, 'deterministic');
  assert.equal(limited.json().available, false);
  assert.equal(limited.json().reason, 'server_rate_limited');
  assert.match(limited.json().summary, /56\.54/);
  assert.equal(calls, 1);
  time += 60_000;
  assert.equal((await post(port, '/api/explain', officialScenario)).json().mode, 'ai');
  time += 60_000;
  const capped = await post(port, '/api/explain', officialScenario);
  assert.equal(capped.status, 200);
  assert.equal(capped.json().reason, 'server_request_limit');
  assert.equal(capped.headers['retry-after'], undefined);
  assert.equal(calls, 2);
  const simulation = await post(port, '/api/simulate', officialScenario);
  assert.equal(simulation.status, 200);
  assert.equal(simulation.json().totalCost, 95);
});

test('HTTP public AI concurrency releases its slot after success and provider exceptions', async (t) => {
  let release;
  let entered;
  let calls = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const port = await startServer(t, { aiConfigured: () => true,
    aiLimits: { maxRequests: 10, requestsPerMinute: 10, maxConcurrent: 1 },
    explain: async () => {
      calls++;
      if (calls === 1) { entered(); await held; }
      if (calls === 2) throw new Error('private-provider-failure');
      return fallbackExplanation;
    } });
  const first = post(port, '/api/explain', officialScenario);
  await started;
  try {
    const busy = await post(port, '/api/explain', officialScenario);
    assert.equal(busy.status, 200);
    assert.equal(busy.json().reason, 'server_busy');
    assert.equal(busy.headers['retry-after'], '5');
    assert.equal(calls, 1);
  } finally {
    release();
  }
  assert.equal((await first).status, 200);
  const failed = await post(port, '/api/explain', officialScenario);
  assert.equal(failed.status, 500);
  assert.doesNotMatch(failed.text, /private-provider-failure/);
  assert.equal((await post(port, '/api/explain', officialScenario)).status, 200);
  assert.equal(calls, 3);
});

test('HTTP zero AI allowance disables provider dispatch without breaking deterministic explanations', async (t) => {
  let calls = 0;
  const port = await startServer(t, { aiConfigured: () => true, aiLimits: { maxRequests: 0 },
    explain: async () => { calls++; return fallbackExplanation; } });
  const response = await post(port, '/api/explain', officialScenario);
  assert.equal(response.status, 200);
  assert.equal(response.json().reason, 'server_request_limit');
  assert.equal(response.json().mode, 'deterministic');
  assert.equal(calls, 0);
});

test('HTTP security headers preserve map assets and citizen geolocation with restricted external services', async (t) => {
  const port = await startServer(t);
  for (const path of ['/', '/citizens.html', '/mayor.html', '/api/health', '/api/citizen/config', '/api/missing']) {
    const response = await request(port, path);
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['permissions-policy'], 'camera=(), microphone=(), geolocation=(self)');
    const directives = new Map(response.headers['content-security-policy'].split('; ').map(value => {
      const [name, ...sources] = value.split(' ');
      return [name, sources];
    }));
    assert.deepEqual(directives.get('script-src'), ["'self'"]);
    assert.deepEqual(directives.get('worker-src'), ["'self'", 'blob:']);
    assert.deepEqual(directives.get('connect-src'), ["'self'", 'https://tiles.openfreemap.org', 'https://photon.komoot.io']);
    assert.deepEqual(directives.get('frame-ancestors'), ["'none'"]);
    assert.deepEqual(directives.get('object-src'), ["'none'"]);
  }
});

test('HTTP bad JSON and non-JSON content types produce safe JSON errors', async (t) => {
  const port = await startServer(t);
  const malformed = await request(port, '/api/simulate', { method: 'POST', body: '{"decisions":',
    headers: { 'Content-Type': 'application/json' } });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json().errors[0].code, 'INVALID_JSON');
  for (const contentType of [undefined, 'text/plain', 'application/jsonp']) {
    const headers = contentType ? { 'Content-Type': contentType } : {};
    const response = await request(port, '/api/simulate', { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 415);
    assert.match(response.headers['content-type'], /^application\/json/);
    assert.equal(response.json().errors[0].code, 'UNSUPPORTED_MEDIA_TYPE');
  }
});

test('HTTP 32 KiB limit counts bytes and rejects both declared and streamed excess', async (t) => {
  const port = await startServer(t);
  const exact = JSON.stringify(officialScenario).padEnd(32 * 1024, ' ');
  assert.equal((await request(port, '/api/simulate', { method: 'POST', body: exact,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(exact) } })).status, 200);
  const excessive = 'я'.repeat(17 * 1024);
  for (const options of [
    { body: excessive, headers: { 'Content-Length': Buffer.byteLength(excessive) } },
    { chunks: [excessive.slice(0, 1024), excessive.slice(1024)], headers: {} },
  ]) {
    const response = await request(port, '/api/simulate', { ...options, method: 'POST',
      headers: { ...options.headers, 'Content-Type': 'application/json' } });
    assert.equal(response.status, 413);
    assert.equal(response.json().errors[0].code, 'BODY_TOO_LARGE');
  }
});

test('HTTP has fixed API routes and explicit method errors', async (t) => {
  const port = await startServer(t);
  const wrongMethod = await request(port, '/api/simulate');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, 'POST');
  assert.equal(wrongMethod.json().errors[0].code, 'METHOD_NOT_ALLOWED');
  const unknown = await request(port, '/api/not-a-route');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json().errors[0].code, 'NOT_FOUND');
});

test('HTTP internal exceptions do not expose a secret, filesystem path or stack trace', async (t) => {
  const port = await startServer(t, { explain: async () => {
    throw new Error('private-token-example at C:\\private\\.env.local');
  } });
  const response = await post(port, '/api/explain', officialScenario);
  assert.equal(response.status, 500);
  assert.deepEqual(response.json(), { valid: false,
    errors: [{ code: 'INTERNAL_ERROR', message: 'Не удалось обработать запрос.' }] });
  assert.doesNotMatch(response.text, /private-token|private|\.env|stack/i);
});

test('HTTP static assets serve correct MIME types; secrets and traversal remain outside public', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ascension-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const publicDir = join(root, 'public');
  await mkdir(publicDir);
  await mkdir(join(root, 'outside'));
  await mkdir(join(publicDir, '.private'));
  await Promise.all([
    writeFile(join(publicDir, 'index.html'), '<h1>Демо</h1>'),
    writeFile(join(publicDir, 'app.js'), 'console.log("demo");'),
    writeFile(join(publicDir, 'districts.geojson'), '{"type":"FeatureCollection","features":[]}'),
    writeFile(join(publicDir, '.env.local'), 'private-token-example'),
    writeFile(join(publicDir, '.private', 'config.json'), '{"secret":"private-token-example"}'),
    writeFile(join(root, 'outside', 'secret.json'), '{"secret":"private-token-example"}'),
  ]);
  await symlink(join(root, 'outside'), join(publicDir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(join(publicDir, '.private'), join(publicDir, 'hidden-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const port = await startServer(t, { publicDir });
  const html = await request(port, '/');
  assert.equal(html.status, 200);
  assert.equal(html.text, '<h1>Демо</h1>');
  assert.match(html.headers['content-type'], /^text\/html; charset=utf-8$/);
  const script = await request(port, '/app.js?version=1');
  assert.equal(script.status, 200);
  assert.match(script.headers['content-type'], /^text\/javascript; charset=utf-8$/);
  const geography = await request(port, '/districts.geojson');
  assert.equal(geography.status, 200);
  assert.equal(geography.headers['content-type'], 'application/geo+json; charset=utf-8');
  assert.equal(geography.json().type, 'FeatureCollection');
  const head = await request(port, '/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.equal(Number(head.headers['content-length']), Buffer.byteLength(html.text));
  for (const path of ['/.env.local', '/%2eenv.local', '/../outside/secret.json',
    '/%2e%2e/outside/secret.json', '/%2e%2e%2foutside%2fsecret.json',
    '/%2e%2e%5coutside%5csecret.json', '/linked/secret.json', '/hidden-link/config.json', '/src/server.js',
    '/data/city.json', '/app.js::$DATA', '/app.js%00']) {
    const response = await request(port, path);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(response.text, /private-token-example/);
  }
  const malformed = await request(port, '/%ZZ');
  assert.equal(malformed.status, 400);
});
