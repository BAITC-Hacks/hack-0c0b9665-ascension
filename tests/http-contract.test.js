import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../src/server.js';
import { createWorker } from '../src/worker.js';

// Expected totals come from the official case example, independently of the implementation.
const officialScenario = { decisions: [
  { measureId: 'M7', districtId: 'nura' },
  { measureId: 'M8', districtId: 'nura' },
  { measureId: 'M10', districtId: 'nura' },
  { measureId: 'M12' },
  { measureId: 'M5', districtId: 'saryarka' },
] };
const explanation = { mode: 'deterministic', available: false,
  summary: 'Проверенный сценарий.', strengths: [], risks: [], recommendations: [] };
const assets = new Map([
  ['/', { body: '<h1>Город</h1>', type: 'text/html; charset=utf-8', file: 'index.html' }],
  ['/app.js', { body: 'export const ready = true;', type: 'text/javascript; charset=utf-8', file: 'app.js' }],
]);

function responseView(status, headers, text) {
  return { status, headers: new Headers(headers), text, json: () => JSON.parse(text) };
}

function nodeRequest(origin, path, { method = 'GET', headers = {}, body, chunks } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}${path}`, { method, headers }, response => {
      const received = [];
      response.on('data', chunk => received.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve(responseView(response.statusCode, response.headers,
        Buffer.concat(received).toString('utf8'))));
    });
    request.once('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('HTTP contract request timed out')));
    if (chunks) for (const chunk of chunks) request.write(chunk);
    request.end(body);
  });
}

async function startRuntime(t, runtime, explain = async () => explanation) {
  if (runtime === 'Node') {
    const publicDir = await mkdtemp(join(tmpdir(), 'ascension-contract-'));
    await Promise.all([...assets.values()].map(asset => writeFile(join(publicDir, asset.file), asset.body)));
    const server = createAppServer({ env: {}, publicDir, aiConfigured: () => false, explain });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
      await rm(publicDir, { recursive: true, force: true });
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    return { origin, request: (path, options) => nodeRequest(origin, path, options) };
  }

  const worker = createWorker({ explain });
  const origin = 'https://contract.example';
  const env = { ASSETS: { fetch: async request => {
    const asset = assets.get(new URL(request.url).pathname);
    if (!asset) return new Response('Not found', { status: 404 });
    return new Response(request.method === 'HEAD' ? null : asset.body, { headers: {
      'Content-Type': asset.type, 'Content-Length': String(Buffer.byteLength(asset.body)),
      'Cache-Control': 'no-cache',
      // The application must apply its policy even if the asset binding supplies a weaker one.
      'Content-Security-Policy': "default-src *", 'X-Frame-Options': 'ALLOWALL',
    } });
  } } };
  return { origin, async request(path, { method = 'GET', headers = {}, body, chunks } = {}) {
    const init = { method, headers };
    if (chunks) {
      init.body = new ReadableStream({ start(controller) {
        for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
        controller.close();
      } });
      init.duplex = 'half';
    } else if (body !== undefined) init.body = body;
    const response = await worker.fetch(new Request(`${origin}${path}`, init), env);
    return responseView(response.status, response.headers, await response.text());
  } };
}

function post(client, path, scenario = officialScenario, headers = {}) {
  return client.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(scenario) });
}

function assertSecurityHeaders(response) {
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const policy = response.headers.get('content-security-policy');
  assert.match(policy, /(?:^|;\s*)script-src 'self'(?:;|$)/);
  assert.match(policy, /(?:^|;\s*)object-src 'none'(?:;|$)/);
  assert.match(policy, /(?:^|;\s*)frame-ancestors 'none'(?:;|$)/);
  assert.match(policy, /(?:^|;\s*)worker-src 'self' blob:(?:;|$)/);
  assert.match(policy, /connect-src 'self' https:\/\/tiles\.openfreemap\.org https:\/\/photon\.komoot\.io/);
}

function assertApiError(response, status, code) {
  assert.equal(response.status, status, response.text);
  assert.match(response.headers.get('content-type'), /^application\/json(?:;\s*charset=utf-8)?$/i);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assertSecurityHeaders(response);
  const body = response.json();
  assert.equal(body.valid, false);
  assert.ok(body.errors.some(error => error.code === code), response.text);
  assert.ok(body.errors.every(error => typeof error.code === 'string' && typeof error.message === 'string'));
  assert.equal(body.stack, undefined);
  return body;
}

for (const runtime of ['Node', 'Worker']) {
  test(`${runtime}: public HTTP methods, error envelopes and security headers`, async t => {
    const client = await startRuntime(t, runtime);
    const health = await client.request('/api/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.json(), { ok: true, aiConfigured: false });
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assertSecurityHeaders(health);
    for (const [path, method, status, code, allow] of [
      ['/api/simulate', 'GET', 405, 'METHOD_NOT_ALLOWED', 'POST'],
      ['/api/health', 'PUT', 405, 'METHOD_NOT_ALLOWED', 'GET'],
      ['/api/explain', 'OPTIONS', 405, 'METHOD_NOT_ALLOWED', 'POST'],
      ['/api/missing', 'GET', 404, 'NOT_FOUND', null],
      ['/app.js', 'POST', 405, 'METHOD_NOT_ALLOWED', 'GET, HEAD'],
      ['/%ZZ', 'GET', 400, 'INVALID_PATH', null],
      ['/.env.local', 'GET', 404, 'NOT_FOUND', null],
    ]) {
      const response = await client.request(path, { method });
      assertApiError(response, status, code);
      assert.equal(response.headers.get('allow'), allow);
    }
  });

  test(`${runtime}: rejected client numbers cannot change official calculations`, async t => {
    let explanationCalls = 0;
    const client = await startRuntime(t, runtime, async () => { explanationCalls++; return explanation; });
    const alteredDecision = structuredClone(officialScenario);
    alteredDecision.decisions[0].cost = -1000;
    alteredDecision.decisions[0].effect = { I1: 1000 };
    for (const forged of [
      { ...officialScenario, budget: 100000, score: 100, totalCost: 0 },
      { ...officialScenario, dataset: { budget: 100000 } },
      alteredDecision,
    ]) {
      for (const path of ['/api/simulate', '/api/explain']) {
        const result = assertApiError(await post(client, path, forged), 422, 'UNKNOWN_FIELD');
        assert.equal(result.score, undefined);
        assert.equal(result.totalCost, 95);
      }
    }
    assert.equal(explanationCalls, 0);
    const accepted = await post(client, '/api/simulate');
    assert.equal(accepted.status, 200);
    const result = accepted.json();
    assert.equal(result.valid, true);
    assert.equal(result.totalCost, 95);
    assert.equal(result.remainingBudget, 5);
    assert.ok(Math.abs(result.score - 56.54307) < 1e-8);
    const baseline = await client.request('/api/baseline');
    assert.ok(Math.abs(baseline.json().score - 52.55768) < 1e-8);
  });

  test(`${runtime}: cross-site writes stop before explanation; same-origin and CLI writes work`, async t => {
    let explanationCalls = 0;
    const client = await startRuntime(t, runtime, async () => { explanationCalls++; return explanation; });
    for (const headers of [
      { 'Sec-Fetch-Site': 'cross-site' },
      { Origin: 'https://untrusted.example' },
      { Origin: 'null' },
      { Origin: 'https://untrusted.example', 'Sec-Fetch-Site': 'same-origin' },
    ]) {
      for (const path of ['/api/validate', '/api/simulate', '/api/explain']) {
        assertApiError(await post(client, path, officialScenario, headers), 403, 'CROSS_ORIGIN_REQUEST');
      }
    }
    assert.equal(explanationCalls, 0);
    for (const headers of [{}, { Origin: client.origin, 'Sec-Fetch-Site': 'same-origin' }]) {
      assert.equal((await post(client, '/api/explain', officialScenario, headers)).status, 200);
    }
    assert.equal(explanationCalls, 2);
    assert.equal((await client.request('/api/health', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200);
  });

  test(`${runtime}: JSON parsing distinguishes malformed bytes from invalid scenarios`, async t => {
    const client = await startRuntime(t, runtime);
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    for (const body of ['', '{', Buffer.concat([
      Buffer.from('{"decisions":[],"note":"'), Buffer.from([0xc0, 0xaf]), Buffer.from('"}'),
    ])]) {
      assertApiError(await client.request('/api/validate', { method: 'POST', headers, body }), 400, 'INVALID_JSON');
    }
    const unicode = Buffer.from(JSON.stringify({ ...officialScenario, 'я': true }));
    const split = unicode.indexOf(Buffer.from('я')) + 1;
    const response = await client.request('/api/simulate', { method: 'POST', headers,
      chunks: [unicode.subarray(0, split), unicode.subarray(split)] });
    const result = assertApiError(response, 422, 'UNKNOWN_FIELD');
    assert.ok(result.errors.some(error => error.message.includes('я')));
    for (const badHeaders of [{ 'Content-Type': 'text/plain' },
      { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }]) {
      assertApiError(await client.request('/api/simulate', { method: 'POST', headers: badHeaders,
        body: JSON.stringify(officialScenario) }), 415, 'UNSUPPORTED_MEDIA_TYPE');
    }
  });

  test(`${runtime}: body limits count streamed bytes and accept the exact 32 KiB boundary`, async t => {
    const client = await startRuntime(t, runtime);
    const headers = { 'Content-Type': 'application/json' };
    const exact = JSON.stringify(officialScenario).padEnd(32 * 1024, ' ');
    const accepted = await client.request('/api/simulate', { method: 'POST', headers,
      chunks: [exact.slice(0, 100), exact.slice(100)] });
    assert.equal(accepted.status, 200);
    for (const chunks of [[exact, ' '], ['я'.repeat(8 * 1024), 'я'.repeat(8 * 1024), 'я']]) {
      assertApiError(await client.request('/api/simulate', { method: 'POST', headers, chunks }), 413, 'BODY_TOO_LARGE');
    }
    assertApiError(await client.request('/api/simulate', { method: 'POST',
      headers: { ...headers, 'Content-Length': String(32 * 1024 + 1) }, body: `${exact} ` }), 413, 'BODY_TOO_LARGE');
    assert.equal((await post(client, '/api/simulate')).status, 200);
  });

  test(`${runtime}: internal explanation errors conceal provider secrets and stack traces`, async t => {
    const client = await startRuntime(t, runtime, async () => {
      throw new Error('Bearer secret-contract-key at C:\\private\\.env.local');
    });
    const response = await post(client, '/api/explain');
    const body = assertApiError(response, 500, 'INTERNAL_ERROR');
    assert.deepEqual(body, { valid: false,
      errors: [{ code: 'INTERNAL_ERROR', message: 'Не удалось обработать запрос.' }] });
    assert.doesNotMatch(response.text, /secret-contract-key|Bearer|private|\.env|stack/i);
    assert.equal((await post(client, '/api/simulate')).status, 200);
  });

  test(`${runtime}: static GET and HEAD retain the map and browser-worker security policy`, async t => {
    const client = await startRuntime(t, runtime);
    for (const [path, asset] of assets) {
      for (const method of ['GET', 'HEAD']) {
        const response = await client.request(path, { method });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), asset.type);
        assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(asset.body));
        assert.equal(response.text, method === 'HEAD' ? '' : asset.body);
        assertSecurityHeaders(response);
      }
    }
  });
}
