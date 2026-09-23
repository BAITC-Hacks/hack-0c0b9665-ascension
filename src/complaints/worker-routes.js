import { createComplaintRouteCore } from './route-core.js';
import { readJson } from '../worker.js';

/** Fetch adapter keeps validation and access rules identical to the Node server. */
export function createComplaintFetchHandler(options) {
  const route = createComplaintRouteCore(options);
  return async function fetchComplaint(request) {
    const url = new URL(request.url);
    const headers = new Headers({ 'Cache-Control': 'no-store' });
    let status = 200;
    let body;
    const response = {
      destroyed: false, writableEnded: false,
      setHeader(name, value) { headers.set(name, String(value)); },
      writeHead(code, values) {
        status = code;
        for (const [name, value] of Object.entries(values)) headers.set(name, String(value));
      },
      end(value) { body = value; this.writableEnded = true; },
    };
    const incoming = {
      method: request.method, url: request.url,
      headers: { ...Object.fromEntries(request.headers), host: url.host },
      // Never permit the Node loopback admin bypass, even under wrangler dev.
      socket: { remoteAddress: `cloudflare:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}` },
      resume() {},
    };
    const recognized = await route(incoming, response, decodeURIComponent(url.pathname), {
      readJson: () => readJson(request),
      sendJson(res, code, value) {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(value));
      },
    });
    if (!recognized) return Response.json({ valid: false, errors: [{ code: 'NOT_FOUND', message: 'Маршрут API не найден.' }] }, { status: 404 });
    return new Response(body, { status, headers });
  };
}
