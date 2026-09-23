import { RequestError } from '../http/errors.js';
import { createJsonBodyParser, validateJsonHeaders } from '../http/json.js';

/** Drain rejected Node bodies so the JSON error can still reach the client. */
export function readNodeJson(request, headers) {
  try { validateJsonHeaders(headers); }
  catch (error) { request.resume(); throw error; }
  const parser = createJsonBodyParser();
  return new Promise((resolveBody, reject) => {
    let failed = false;
    function fail(error) {
      if (failed) return;
      failed = true;
      reject(error);
    }
    request.on('data', chunk => {
      if (failed) return;
      try { parser.push(chunk); }
      catch (error) { fail(error); }
    });
    request.once('end', () => {
      if (failed) return;
      try { resolveBody(parser.finish()); }
      catch (error) { fail(error); }
    });
    request.once('error', () => fail(new RequestError(400, 'INVALID_BODY', 'Не удалось прочитать тело запроса.')));
    request.once('aborted', () => fail(new RequestError(400, 'INVALID_BODY', 'Передача запроса прервана.')));
  });
}
