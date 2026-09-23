import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAIConfigured } from './ai/explain.js';
import { handleApiRequest } from './http/api.js';
import { errorResult } from './http/errors.js';
import { getPath, requireMethod, SECURITY_HEADERS } from './http/policy.js';
import { createNodeExplanation } from './runtime/node-explanation.js';
import { readNodeJson } from './runtime/node-json.js';
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

/** Node composition root. Construct once so admission counters survive across requests. */
export function createRequestHandler({ aiConfigured = isAIConfigured,
  publicDir = DEFAULT_PUBLIC_DIR, ...options } = {}) {
  const staticRoot = resolve(publicDir);
  const explain = createNodeExplanation({ ...options, aiConfigured });
  return async (request, response) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
    try {
      const pathname = getPath(request.url);
      const headers = { get: name => request.headers[name.toLowerCase()] ?? null };
      const protocol = request.socket.encrypted ? 'https' : 'http';
      // Forwarded headers are client-controlled unless a trusted proxy policy is configured.
      const origin = `${protocol}://${request.headers.host}`;
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
