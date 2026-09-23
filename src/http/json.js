import { RequestError } from './errors.js';
import { MAX_JSON_BYTES } from './policy.js';

function tooLarge() {
  return new RequestError(413, 'BODY_TOO_LARGE', 'Размер JSON не должен превышать 32 KiB.');
}

export function validateJsonHeaders(headers) {
  const mediaType = (headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  const encoding = headers.get('Content-Encoding');
  if (mediaType !== 'application/json' || (encoding && encoding !== 'identity')) {
    throw new RequestError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Ожидается тело application/json без сжатия.');
  }
  if (Number(headers.get('Content-Length')) > MAX_JSON_BYTES) throw tooLarge();
}

/** Transport-independent, byte-bounded parser. Stream ownership stays with each adapter. */
export function createJsonBodyParser() {
  let bytes = 0;
  const chunks = [];
  return {
    push(chunk) {
      bytes += chunk.byteLength;
      if (bytes > MAX_JSON_BYTES) {
        chunks.length = 0;
        throw tooLarge();
      }
      chunks.push(chunk);
    },
    finish() {
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      chunks.length = 0;
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
      catch { throw new RequestError(400, 'INVALID_JSON', 'Не удалось прочитать JSON запроса.'); }
    },
  };
}
