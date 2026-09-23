import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { RequestError } from '../http/errors.js';

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.geojson', 'application/geo+json; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'], ['.woff2', 'font/woff2'],
]);

function notFound() { return new RequestError(404, 'NOT_FOUND', 'Ресурс не найден.'); }

function isInside(root, target) {
  const localPath = relative(root, target);
  return localPath !== '' && localPath !== '..' && !localPath.startsWith('..\\')
    && !localPath.startsWith('../') && !isAbsolute(localPath);
}

/** Only known public file types; resolve symlinks before enforcing the directory boundary. */
export async function sendNodeStatic(request, response, pathname, publicDir) {
  const candidate = resolve(publicDir, pathname === '/' ? 'index.html' : pathname.slice(1));
  if (!isInside(publicDir, candidate)) throw notFound();
  try {
    const [root, target] = await Promise.all([realpath(publicDir), realpath(candidate)]);
    const resolvedSegments = relative(root, target).split(/[\\/]/u);
    if (!isInside(root, target) || resolvedSegments.some(segment => segment.startsWith('.'))
      || !(await stat(target)).isFile()) throw notFound();
    const contentType = MIME_TYPES.get(extname(target).toLowerCase());
    if (!contentType) throw notFound();
    const body = await readFile(target);
    response.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw notFound();
    throw error;
  }
}
