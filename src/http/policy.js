import { RequestError } from './errors.js';

export const MAX_JSON_BYTES = 32 * 1024;

export const SECURITY_HEADERS = Object.freeze({
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
});

/** Validate the request target before filesystem normalization in the Node adapter. */
export function getPath(target = '/') {
  let pathname;
  try { pathname = decodeURIComponent(target.split('?')[0]); }
  catch { throw new RequestError(400, 'INVALID_PATH', 'Некорректный адрес запроса.'); }
  if (!pathname.startsWith('/') || /[\\:\u0000-\u001f\u007f]/u.test(pathname)
    || pathname.split('/').some(segment => segment.startsWith('.'))) {
    throw new RequestError(404, 'NOT_FOUND', 'Ресурс не найден.');
  }
  return pathname;
}

export function requireMethod(method, allowed) {
  if (!allowed.includes(method)) {
    throw new RequestError(405, 'METHOD_NOT_ALLOWED', 'Метод запроса не поддерживается.', {
      Allow: allowed.join(', '),
    });
  }
}

/** Browser defense in depth; requests without browser headers remain usable by CLI clients. */
export function assertSameOrigin(headers, expectedOrigin) {
  const origin = headers.get('Origin');
  if (headers.get('Sec-Fetch-Site') === 'cross-site'
    || (origin !== null && origin !== undefined && origin !== expectedOrigin)) {
    throw new RequestError(403, 'CROSS_ORIGIN_REQUEST', 'Запрос разрешён только с текущего сайта.');
  }
}
