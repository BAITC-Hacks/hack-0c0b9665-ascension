import { createDesk } from './desk/api.js';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAIConfigured } from './ai/explain.js';
import { createComplaintRoutes } from './complaints/http.js';
import { handleApiRequest } from './http/api.js';
import { RequestError, errorResult } from './http/errors.js';
import { getPath, requireMethod, SECURITY_HEADERS, MAX_JSON_BYTES } from './http/policy.js';
import { createNodeExplanation } from './runtime/node-explanation.js';
import { readNodeJson } from './runtime/node-json.js';
import { configuredPublicOrigin } from './runtime/node-origin.js';
import { sendNodeStatic } from './runtime/node-static.js';

const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

function sendJson(response, { status, body: value, headers = {} }) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(body);
}

/** Photo endpoints opt into a larger bound; the shared simulator contract stays at 32 KiB. */
function readDeskJson(request, maxBytes = MAX_JSON_BYTES) {
  const headers = { get: name => request.headers[name.toLowerCase()] ?? null };
  if (maxBytes === MAX_JSON_BYTES) return readNodeJson(request, headers);
  const mediaType = (headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  const encoding = headers.get('Content-Encoding');
  if (mediaType !== 'application/json' || (encoding && encoding !== 'identity')) {
    request.resume();
    throw new RequestError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Ожидается тело application/json без сжатия.');
  }
  const tooLarge = () => new RequestError(413, 'BODY_TOO_LARGE', 'Превышен допустимый размер запроса.');
  if (Number(headers.get('Content-Length')) > maxBytes) {
    request.resume();
    throw tooLarge();
  }
  return new Promise((resolveBody, reject) => {
    let bytes = 0;
    let failed = false;
    const chunks = [];
    function fail(error) {
      if (failed) return;
      failed = true;
      chunks.length = 0;
      reject(error);
    }
    request.on('data', chunk => {
      if (failed) return;
      bytes += chunk.byteLength;
      if (bytes > maxBytes) return fail(tooLarge());
      chunks.push(chunk);
    });
    request.once('end', () => {
      if (failed) return;
      try { resolveBody(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { fail(new RequestError(400, 'INVALID_JSON', 'Не удалось прочитать JSON запроса.')); }
    });
    request.once('error', () => fail(new RequestError(400, 'INVALID_BODY', 'Не удалось прочитать тело запроса.')));
    request.once('aborted', () => fail(new RequestError(400, 'INVALID_BODY', 'Передача запроса прервана.')));
  });
}

/** Node composition root. Construct once so admission counters survive across requests. */
export function createRequestHandler({ aiConfigured = isAIConfigured,
  publicDir = DEFAULT_PUBLIC_DIR, publicOrigin, env = process.env, complaints = {}, deskOptions = {}, ...options } = {}) {
  const desk = createDesk(deskOptions);
  const staticRoot = resolve(publicDir);
  const handleComplaints = createComplaintRoutes(complaints);
  const trustedOrigin = configuredPublicOrigin(publicOrigin, env);
  const explain = createNodeExplanation({ ...options, aiConfigured, env });
  const handler = async (request, response) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
    try {
      const pathname = getPath(request.url);
      const headers = { get: name => request.headers[name.toLowerCase()] ?? null };
      const protocol = request.socket.encrypted ? 'https' : 'http';
      // Forwarded headers are client-controlled unless a trusted proxy policy is configured.
      const origin = trustedOrigin ?? `${protocol}://${request.headers.host}`;
      // Real citizen intake keeps its authoritative store and existing authentication.
      if (await handleComplaints(request, response, pathname, {
        readJson: () => readNodeJson(request, headers),
        sendJson: (target, status, body) => sendJson(target, { status, body }),
      })) {
        request.resume();
        return;
      }
      // Demo workspaces own separate routes and never replace real citizen intake.
      if (await desk.handle(request, response, pathname, readDeskJson,
        (target, status, body) => sendJson(target, { status, body }))) {
        request.resume();
        return;
      }
      const result = await handleApiRequest({ pathname, method: request.method, headers, origin,
        readJson: () => readNodeJson(request, headers), aiConfigured: aiConfigured(), explain });
      request.resume();
      if (result) return sendJson(response, result);
      requireMethod(request.method, ['GET', 'HEAD']);
      await sendNodeStatic(request, response, pathname, staticRoot);
    } catch (error) {
      request.resume();
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) return response.destroy();
      sendJson(response, errorResult(error));
    }
  };
  handler.close = () => desk.close();
  return handler;
}

/** Returns an unbound Node HTTP server. Options are forwarded to createRequestHandler. */
export function createAppServer(options = {}) {
  const handler = createRequestHandler(options);
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, handler);
  server.once('close', () => handler.close());
  return server;
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
