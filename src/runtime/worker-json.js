import { RequestError } from '../http/errors.js';
import { createJsonBodyParser, validateJsonHeaders } from '../http/json.js';

/** Adapt the Web stream to the shared bounded, strict JSON parser. */
export async function readWorkerJson(request) {
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
