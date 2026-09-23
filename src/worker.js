import { handleApiRequest } from './http/api.js';
import { RequestError, errorResult } from './http/errors.js';
import { SECURITY_HEADERS, getPath, requireMethod } from './http/policy.js';
import { createWorkerExplanation } from './runtime/worker-explanation.js';
import { readWorkerJson } from './runtime/worker-json.js';

function json({ body, status = 200, headers = {} }) {
  return Response.json(body, { status, headers: {
    ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...headers,
  } });
}

/** One handler per isolate; bindings and request data stay scoped to each fetch. */
export function createWorker(options = {}) {
  const explain = createWorkerExplanation(options);
  return {
    async fetch(request, env) {
      try {
        const url = new URL(request.url);
        const pathname = getPath(url.pathname + url.search);
        if (pathname === '/api/citizen/config' || pathname === '/api/telegram/webhook'
          || pathname === '/api/complaints' || pathname.startsWith('/api/complaints/')) {
          if (typeof env.COMPLAINTS?.getByName !== 'function') {
            throw new RequestError(503, 'COMPLAINTS_UNAVAILABLE', 'Хранилище обращений не подключено.');
          }
          const complaints = env.COMPLAINTS.getByName('city');
          if (typeof complaints?.fetch !== 'function') {
            throw new RequestError(503, 'COMPLAINTS_UNAVAILABLE', 'Хранилище обращений не подключено.');
          }
          const response = await complaints.fetch(request);
          const headers = new Headers(response.headers);
          for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
          return new Response(request.method === 'HEAD' ? null : response.body, {
            status: response.status, statusText: response.statusText, headers,
          });
        }
        const result = await handleApiRequest({
          pathname,
          method: request.method,
          readJson: () => readWorkerJson(request),
          aiConfigured: Boolean(env.OPENAI_API_KEY?.trim()),
          explain: (scenario, simulation) => explain(scenario, simulation, env),
          headers: request.headers,
          origin: url.origin,
        });
        if (result) return json(result);

        requireMethod(request.method, ['GET', 'HEAD']);
        const asset = await env.ASSETS.fetch(request);
        const headers = new Headers(asset.headers);
        for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
        return new Response(request.method === 'HEAD' ? null : asset.body, {
          status: asset.status, statusText: asset.statusText, headers,
        });
      } catch (error) {
        return json(errorResult(error));
      }
    },
  };
}

export default createWorker();
