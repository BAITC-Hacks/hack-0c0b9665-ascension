import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

function requestHeaders(request) {
  const headers = new Headers();
  const cookies = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name.toLowerCase() === 'cookie') cookies.push(value);
    else headers.append(name, value);
  }
  if (cookies.length) headers.set('Cookie', cookies.join('; '));
  return headers;
}

/** A demand-driven body whose cancellation drains HTTP input without closing its socket. */
function requestBody(request, signal) {
  let controller;
  let finished = false;
  let wake;
  const notify = () => { wake?.(); wake = undefined; };
  const cleanup = () => {
    request.off('readable', notify);
    request.off('end', end);
    signal.removeEventListener('abort', abort);
    notify();
  };
  const end = () => {
    if (finished) return;
    finished = true;
    controller.close();
    cleanup();
  };
  const abort = () => {
    if (finished) return;
    finished = true;
    controller.error(signal.reason);
    cleanup();
  };
  const drain = () => {
    end();
    if (!request.destroyed && !request.readableEnded) request.resume();
  };
  const stream = new ReadableStream({
    start(value) {
      controller = value;
      request.on('readable', notify);
      request.once('end', end);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else if (request.readableEnded) end();
    },
    async pull() {
      while (!finished) {
        const chunk = request.read();
        if (chunk !== null) {
          controller.enqueue(chunk);
          return;
        }
        if (request.readableEnded) { end(); return; }
        await new Promise(resolve => { wake = resolve; });
      }
    },
    cancel() {
      // Readable.toWeb() would destroy IncomingMessage and lose the handler's 413 response.
      finished = true;
      cleanup();
      if (!request.destroyed && !request.readableEnded) request.resume();
    },
  }, { highWaterMark: 0 });
  return { stream, drain };
}

/** Write a Web response independently, including configuration/authentication preflight errors. */
export async function sendNodeWebResponse(request, response, result, responseHeaders = {}) {
  try {
    if (!(result instanceof Response)) throw new TypeError('The Web handler must return a Response.');
    if (response.destroyed) {
      try { await result.body?.cancel(); } catch { /* Client has already disconnected. */ }
      return;
    }
    response.statusCode = result.status;
    if (result.statusText) response.statusMessage = result.statusText;
    for (const [name, value] of result.headers) {
      if (name !== 'set-cookie') response.setHeader(name, value);
    }
    const cookies = result.headers.getSetCookie();
    if (cookies.length) response.setHeader('Set-Cookie', cookies);
    for (const [name, value] of Object.entries(responseHeaders)) response.setHeader(name, value);

    if (request.method === 'HEAD' || !result.body) {
      response.end();
      if (result.body) {
        try { await result.body.cancel(); } catch { /* Headers are already committed. */ }
      }
    } else {
      // Node's pipeline propagates response backpressure and cancels on client disconnect.
      await pipeline(Readable.fromWeb(result.body), response);
    }
  } catch (error) {
    if (response.headersSent || response.destroyed) {
      response.destroy();
    } else {
      throw error;
    }
  }
}

/** Bridge a Web handler without trusting Host/proxy headers or buffering its request body. */
export async function handleNodeWebRequest(request, response, {
  handler, origin, responseHeaders = {},
}) {
  const client = new AbortController();
  const abort = () => client.abort(new DOMException('Client disconnected.', 'AbortError'));
  const onResponseClose = () => { if (!response.writableFinished) abort(); };
  const onRequestClose = () => {
    if (!request.complete) abort();
    request.off('aborted', abort);
    request.off('error', abort);
  };
  request.once('aborted', abort);
  request.on('error', abort);
  request.once('close', onRequestClose);
  response.once('close', onResponseClose);
  if (request.destroyed && !request.complete) abort();

  let body;
  try {
    const target = request.url ?? '/';
    if (!target.startsWith('/')) throw new TypeError('Expected an origin-form request target.');
    const url = new URL(`${new URL(origin).origin}${target}`);
    const method = request.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') body = requestBody(request, client.signal);
    const webRequest = new Request(url, {
      method, headers: requestHeaders(request), signal: client.signal,
      ...(body ? { body: body.stream, duplex: 'half' } : {}),
    });
    const result = await handler(webRequest);
    await sendNodeWebResponse(request, response, result, responseHeaders);
  } finally {
    body?.drain();
    if (!body && !request.destroyed && !request.readableEnded) request.resume();
    response.off('close', onResponseClose);
  }
}
