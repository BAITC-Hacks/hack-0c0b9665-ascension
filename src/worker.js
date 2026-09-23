import { getBaseline, getDataset, simulate, validateScenario } from './core/simulator.js';
import { explainScenario } from './ai/explain.js';

const MAX_JSON_BYTES = 32 * 1024;
const API_METHODS = new Map([
  ['/api/health', 'GET'], ['/api/dataset', 'GET'], ['/api/baseline', 'GET'],
  ['/api/validate', 'POST'], ['/api/simulate', 'POST'], ['/api/explain', 'POST'],
]);
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(self)',
  'Content-Security-Policy': [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://tiles.openfreemap.org",
    "font-src 'self' https://tiles.openfreemap.org",
    "connect-src 'self' https://tiles.openfreemap.org https://photon.komoot.io",
    "worker-src 'self' blob:", "object-src 'none'", "base-uri 'self'",
    "frame-ancestors 'none'", "form-action 'self'",
  ].join('; '),
};

class RequestError extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
}

function json(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers: {
    ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...headers,
  } });
}

function bounded(value, fallback, max) {
  const number = Number(value);
  return value !== undefined && value !== '' && Number.isInteger(number) && number >= 0 && number <= max
    ? number : fallback;
}

export async function readJson(request) {
  const mediaType = (request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  const encoding = request.headers.get('Content-Encoding');
  if (mediaType !== 'application/json' || (encoding && encoding !== 'identity')) {
    throw new RequestError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Ожидается тело application/json без сжатия.');
  }
  if (Number(request.headers.get('Content-Length')) > MAX_JSON_BYTES) {
    throw new RequestError(413, 'BODY_TOO_LARGE', 'Размер JSON не должен превышать 32 KiB.');
  }
  const reader = request.body?.getReader();
  let bytes = 0;
  const chunks = [];
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_JSON_BYTES) {
          await reader.cancel();
          throw new RequestError(413, 'BODY_TOO_LARGE', 'Размер JSON не должен превышать 32 KiB.');
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError(400, 'INVALID_BODY', 'Не удалось прочитать тело запроса.');
    } finally { reader.releaseLock(); }
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(body)); }
  catch { throw new RequestError(400, 'INVALID_JSON', 'Не удалось прочитать JSON запроса.'); }
}

/** One handler per isolate. Counters are a local backstop, not a durable spending cap. */
export function createWorker({ explain = explainScenario, now = Date.now } = {}) {
  let total = 0;
  let active = 0;
  let recent = [];
  return {
    async fetch(request, env) {
      try {
        let path;
        try { path = decodeURIComponent(new URL(request.url).pathname); }
        catch { throw new RequestError(400, 'INVALID_PATH', 'Некорректный адрес запроса.'); }
        if (/[\\:\u0000-\u001f\u007f]/u.test(path) || path.split('/').some(part => part.startsWith('.'))) {
          throw new RequestError(404, 'NOT_FOUND', 'Ресурс не найден.');
        }
        if (path === '/api/citizen/config' || path === '/api/telegram/webhook'
          || path === '/api/complaints' || path.startsWith('/api/complaints/')) {
          if (typeof env.COMPLAINTS?.getByName !== 'function') throw new RequestError(503, 'COMPLAINTS_UNAVAILABLE', 'Хранилище обращений не подключено.');
          const complaints = env.COMPLAINTS.getByName('city');
          if (typeof complaints?.fetch !== 'function') throw new RequestError(503, 'COMPLAINTS_UNAVAILABLE', 'Хранилище обращений не подключено.');
          const result = await complaints.fetch(request);
          const headers = new Headers(result.headers);
          for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
          return new Response(result.body, { status: result.status, headers });
        }
        const expected = API_METHODS.get(path);
        if (!expected) {
          if (path === '/api' || path.startsWith('/api/')) {
            throw new RequestError(404, 'NOT_FOUND', 'Маршрут API не найден.');
          }
          if (!['GET', 'HEAD'].includes(request.method)) {
            return json({ valid: false, errors: [{ code: 'METHOD_NOT_ALLOWED', message: 'Метод запроса не поддерживается.' }] }, 405, { Allow: 'GET, HEAD' });
          }
          const asset = await env.ASSETS.fetch(request);
          const headers = new Headers(asset.headers);
          for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
          return new Response(asset.body, { status: asset.status, headers });
        }
        if (request.method !== expected) {
          return json({ valid: false, errors: [{ code: 'METHOD_NOT_ALLOWED', message: 'Метод запроса не поддерживается.' }] }, 405, { Allow: expected });
        }
        const aiConfigured = Boolean(env.OPENAI_API_KEY?.trim());
        if (path === '/api/health') return json({ ok: true, aiConfigured });
        if (path === '/api/dataset') return json(getDataset());
        if (path === '/api/baseline') return json(getBaseline());
        const scenario = await readJson(request);
        if (path === '/api/validate') return json(validateScenario(scenario));
        const result = simulate(scenario);
        if (!result.valid) return json(result, 422);
        if (path === '/api/simulate') return json(result);

        // Never search hundreds of replacement scenarios inside a 10 ms free Worker request.
        const options = { apiKey: env.OPENAI_API_KEY ?? '', model: env.OPENAI_MODEL,
          skipReplacementSearch: true };
        let reason;
        let localReserved = false;
        let budget;
        let leaseId;
        let retryAfter;
        if (aiConfigured) {
          const time = now();
          recent = recent.filter(started => time - started < 60_000);
          if (total >= bounded(env.AI_MAX_REQUESTS, 100, 10_000)) reason = 'server_request_limit';
          else if (active >= bounded(env.AI_MAX_CONCURRENT, 2, 10)) reason = 'server_busy';
          else if (recent.length >= bounded(env.AI_REQUESTS_PER_MINUTE, 10, 120)) reason = 'server_rate_limited';
          else {
            // Cloudflare shares this counter per location; it is not a global dollar budget.
            try {
              if (!env.AI_RATE_LIMITER || !(await env.AI_RATE_LIMITER.limit({ key: 'ascension-city-map:explain' })).success) {
                reason = 'server_rate_limited';
              }
            } catch { reason = 'server_rate_limited'; }
          }
          // Another request may have acquired a local permit while the binding was awaited.
          const checkedAt = now();
          recent = recent.filter(started => checkedAt - started < 60_000);
          if (!reason && total >= bounded(env.AI_MAX_REQUESTS, 100, 10_000)) reason = 'server_request_limit';
          if (!reason && active >= bounded(env.AI_MAX_CONCURRENT, 2, 10)) reason = 'server_busy';
          if (!reason && recent.length >= bounded(env.AI_REQUESTS_PER_MINUTE, 10, 120)) reason = 'server_rate_limited';
          if (!reason) {
            total++; active++; recent.push(checkedAt); localReserved = true;
            try {
              budget = env.AI_BUDGET?.getByName('global');
              const permit = budget && await budget.acquire();
              if (permit?.allowed === true && typeof permit.leaseId === 'string' && permit.leaseId) {
                leaseId = permit.leaseId;
              } else {
                reason = permit?.reason ?? 'budget_guard_unavailable';
                retryAfter = permit?.retryAfter;
              }
            } catch { reason = 'budget_guard_unavailable'; }
          }
        }
        try {
          if (reason) {
            const retry = retryAfter ?? (reason === 'server_request_limit' ? undefined : reason === 'server_busy' ? 5 : 60);
            return json({ ...await explain(scenario, result, { ...options, apiKey: '' }), reason },
              200, retry ? { 'Retry-After': String(retry) } : {});
          }
          return json(await explain(scenario, result, options));
        } finally {
          if (localReserved) active--;
          if (leaseId) {
            // A failed release remains reserved until the durable lease expires.
            try { await budget.release(leaseId); } catch { /* Fail closed; never retry a provider call. */ }
          }
        }
      } catch (error) {
        const known = error instanceof RequestError;
        return json({ valid: false, errors: [{ code: known ? error.code : 'INTERNAL_ERROR',
          message: known ? error.message : 'Не удалось обработать запрос.' }] }, known ? error.status : 500);
      }
    },
  };
}

export default createWorker();
