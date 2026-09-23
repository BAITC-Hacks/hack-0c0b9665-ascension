import { handleApiRequest } from './http/api.js';
import { RequestError, errorResult } from './http/errors.js';
import { createJsonBodyParser, validateJsonHeaders } from './http/json.js';
import { SECURITY_HEADERS, getPath, requireMethod } from './http/policy.js';
import { createWorkerExplanation } from './runtime/worker-explanation.js';

function json({ body, status = 200, headers = {} }) {
  return Response.json(body, { status, headers: {
    ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...headers,
  } });
}

/** Adapt the Web stream to the shared bounded, strict JSON parser. */
async function readJson(request) {
  validateJsonHeaders(request.headers);
  const parser = createJsonBodyParser();
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(value);
      }
    } catch (error) {
      // Preserve the original rejection even if the source fails during cancellation.
      try { await reader.cancel(); } catch { /* The stream may already be errored. */ }
      if (error instanceof RequestError) throw error;
      throw new RequestError(400, 'INVALID_BODY', 'Не удалось прочитать тело запроса.');
    } finally {
      reader.releaseLock();
    }
  }
  return parser.finish();
}

/** One handler per isolate; bindings and request data stay scoped to each fetch. */
export function createWorker(options = {}) {
  const explain = createWorkerExplanation(options);
  return {
    async fetch(request, env) {
      try {
        const url = new URL(request.url);
        const pathname = getPath(url.pathname + url.search);
        const result = await handleApiRequest({
          pathname,
          method: request.method,
          readJson: () => readJson(request),
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
