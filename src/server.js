import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBaseline, getDataset, simulate, validateScenario } from './core/simulator.js';
import { explainScenario, isAIConfigured } from './ai/explain.js';

const MAX_JSON_BYTES = 32 * 1024;
const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const API_METHODS = new Map([
  ['/api/health', 'GET'], ['/api/dataset', 'GET'], ['/api/baseline', 'GET'],
  ['/api/validate', 'POST'], ['/api/simulate', 'POST'], ['/api/explain', 'POST'],
]);
const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.geojson', 'application/geo+json; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'], ['.woff2', 'font/woff2'],
]);
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://tiles.openfreemap.org",
  "font-src 'self' https://tiles.openfreemap.org",
  "connect-src 'self' https://tiles.openfreemap.org https://photon.komoot.io",
  "worker-src 'self' blob:", "object-src 'none'", "base-uri 'self'",
  "frame-ancestors 'none'", "form-action 'self'",
].join('; ');

function boundedInteger(value, fallback, maximum) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= maximum ? parsed : fallback;
}

// These conservative, process-local limits protect a public demo without trusting client IP headers.
// They count all dispatches (including provider failures and cache hits), and reset on process restart.
function createAIGuard(limits, now) {
  const maxRequests = boundedInteger(limits.maxRequests ?? process.env.AI_MAX_REQUESTS, 100, 10_000);
  const perMinute = boundedInteger(limits.requestsPerMinute ?? process.env.AI_REQUESTS_PER_MINUTE, 10, 120);
  const maxConcurrent = boundedInteger(limits.maxConcurrent ?? process.env.AI_MAX_CONCURRENT, 2, 10);
  let total = 0;
  let active = 0;
  let recent = [];
  return () => {
    const time = now();
    recent = recent.filter(started => time - started < 60_000);
    if (total >= maxRequests) return { reason: 'server_request_limit' };
    if (active >= maxConcurrent) return { reason: 'server_busy', retryAfter: 5 };
    if (recent.length >= perMinute) {
      return { reason: 'server_rate_limited',
        retryAfter: recent.length ? Math.max(1, Math.ceil((60_000 - time + recent[0]) / 1000)) : 60 };
    }
    total++;
    active++;
    recent.push(time);
    return { release: () => { active--; } };
  };
}

class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function getPath(request) {
  const target = request.url ?? '/';
  let pathname;
  try {
    pathname = decodeURIComponent(target.split('?')[0]);
  } catch {
    throw new RequestError(400, 'INVALID_PATH', 'Некорректный адрес запроса.');
  }
  // Check before URL/path normalization, including Windows separators and alternate streams.
  if (!pathname.startsWith('/') || /[\\:\u0000-\u001f\u007f]/u.test(pathname)
    || pathname.split('/').some((segment) => segment.startsWith('.'))) {
    throw new RequestError(404, 'NOT_FOUND', 'Ресурс не найден.');
  }
  return pathname;
}

function readJson(request) {
  const mediaType = (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/json'
    || (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')) {
    request.resume();
    throw new RequestError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Ожидается тело application/json без сжатия.');
  }
  if (Number(request.headers['content-length']) > MAX_JSON_BYTES) {
    request.resume();
    throw new RequestError(413, 'BODY_TOO_LARGE', 'Размер JSON не должен превышать 32 KiB.');
  }
  return new Promise((resolveBody, reject) => {
    let bytes = 0;
    let failed = false;
    const chunks = [];
    request.on('data', (chunk) => {
      if (failed) return;
      bytes += chunk.length;
      if (bytes > MAX_JSON_BYTES) {
        failed = true;
        chunks.length = 0;
        reject(new RequestError(413, 'BODY_TOO_LARGE', 'Размер JSON не должен превышать 32 KiB.'));
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => {
      if (failed) return;
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new RequestError(400, 'INVALID_JSON', 'Не удалось прочитать JSON запроса.'));
      }
    });
    request.once('error', () => reject(new RequestError(400, 'INVALID_BODY', 'Не удалось прочитать тело запроса.')));
    request.once('aborted', () => reject(new RequestError(400, 'INVALID_BODY', 'Передача запроса прервана.')));
  });
}

function isInside(root, target) {
  const localPath = relative(root, target);
  return localPath !== '' && localPath !== '..' && !localPath.startsWith('..\\')
    && !localPath.startsWith('../') && !isAbsolute(localPath);
}

async function sendStatic(request, response, pathname, publicDir) {
  const localPath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const candidate = resolve(publicDir, localPath);
  if (!isInside(publicDir, candidate)) {
    throw new RequestError(404, 'NOT_FOUND', 'Ресурс не найден.');
  }
  try {
    const [root, target] = await Promise.all([realpath(publicDir), realpath(candidate)]);
    const resolvedSegments = relative(root, target).split(/[\\/]/u);
    if (!isInside(root, target) || resolvedSegments.some(segment => segment.startsWith('.'))
      || !(await stat(target)).isFile()) {
      throw new RequestError(404, 'NOT_FOUND', 'Ресурс не найден.');
    }
    const contentType = MIME_TYPES.get(extname(target).toLowerCase());
    if (!contentType) throw new RequestError(404, 'NOT_FOUND', 'Ресурс не найден.');
    const body = await readFile(target);
    response.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) {
      throw new RequestError(404, 'NOT_FOUND', 'Ресурс не найден.');
    }
    throw error;
  }
}

/** Create once per process to retain AI limits between requests, including in serverless adapters. */
export function createRequestHandler({ explain = explainScenario, aiConfigured = isAIConfigured,
  publicDir = DEFAULT_PUBLIC_DIR, aiLimits = {}, now = Date.now } = {}) {
  const staticRoot = resolve(publicDir);
  const enterAI = createAIGuard(aiLimits, now);
  return async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    try {
      const pathname = getPath(request);
      const expectedMethod = API_METHODS.get(pathname);
      if (expectedMethod) {
        if (request.method !== expectedMethod) {
          request.resume();
          response.setHeader('Allow', expectedMethod);
          throw new RequestError(405, 'METHOD_NOT_ALLOWED', 'Метод запроса не поддерживается.');
        }
        if (pathname === '/api/health') return sendJson(response, 200, { ok: true, aiConfigured: Boolean(aiConfigured()) });
        if (pathname === '/api/dataset') return sendJson(response, 200, getDataset());
        if (pathname === '/api/baseline') return sendJson(response, 200, getBaseline());
        const scenario = await readJson(request);
        if (pathname === '/api/validate') return sendJson(response, 200, validateScenario(scenario));
        const result = simulate(scenario);
        if (!result.valid) return sendJson(response, 422, result);
        if (pathname === '/api/simulate') return sendJson(response, 200, result);
        const permit = aiConfigured() ? enterAI() : {};
        if (permit.reason) {
          if (permit.retryAfter) response.setHeader('Retry-After', permit.retryAfter);
          const fallback = await explainScenario(scenario, result, { apiKey: '' });
          return sendJson(response, 200, { ...fallback, reason: permit.reason });
        }
        try {
          return sendJson(response, 200, await explain(scenario, result));
        } finally {
          permit.release?.();
        }
      }
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        throw new RequestError(404, 'NOT_FOUND', 'Маршрут API не найден.');
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        request.resume();
        response.setHeader('Allow', 'GET, HEAD');
        throw new RequestError(405, 'METHOD_NOT_ALLOWED', 'Метод запроса не поддерживается.');
      }
      await sendStatic(request, response, pathname, staticRoot);
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) return response.destroy();
      const known = error instanceof RequestError;
      sendJson(response, known ? error.status : 500, {
        valid: false,
        errors: [{ code: known ? error.code : 'INTERNAL_ERROR',
          message: known ? error.message : 'Не удалось обработать запрос.' }],
      });
    }
  };
}

/** Returns an unbound Node HTTP server. Options are forwarded to createRequestHandler. */
export function createAppServer(options = {}) {
  return createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, createRequestHandler(options));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('PORT должен быть целым числом от 0 до 65535.');
    process.exitCode = 1;
  } else {
    const server = createAppServer();
    server.once('error', () => {
      console.error('Не удалось запустить сервер: проверьте адрес и доступность порта.');
      process.exitCode = 1;
    });
    server.listen(port, host, () => {
      console.log(`Приложение запущено: http://${host}:${server.address().port}`);
    });
  }
}
