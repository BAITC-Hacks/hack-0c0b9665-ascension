import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { handleNodeWebRequest, sendNodeWebResponse } from '../src/runtime/node-web-handler.js';

async function startServer(t, handler, options = {}) {
  const server = createServer((request, response) => {
    handleNodeWebRequest(request, response, {
      handler, origin: 'https://configured.test', ...options,
    }).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'text/plain' });
        response.end('Request failed.');
      } else response.destroy();
    }).finally(() => options.onFinished?.(request));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  return server.address().port;
}

function request(port, path = '/', { method = 'GET', headers = {}, body, agent } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ hostname: '127.0.0.1', port, path, method, headers, agent }, incoming => {
      const socket = outgoing.socket;
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.once('error', reject);
      incoming.once('end', () => resolve({
        status: incoming.statusCode, headers: incoming.headers, rawHeaders: incoming.rawHeaders,
        body: Buffer.concat(chunks), socket,
      }));
    });
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}

test('bridge uses the trusted HTTPS origin and preserves actual headers, method and query', async t => {
  const port = await startServer(t, async incoming => {
    assert.equal(incoming.url, 'https://configured.test/api/work?search=a%2Bb&search=c');
    assert.equal(incoming.method, 'PATCH');
    assert.equal(incoming.headers.get('Origin'), 'https://configured.test');
    assert.equal(incoming.headers.get('Cookie'), 'session=actual-token; csrf=actual-code');
    assert.equal(incoming.headers.get('X-Forwarded-Host'), 'untrusted.test');
    assert.equal(await incoming.text(), '{"value":1}');
    return new Response('saved', { status: 201 });
  });
  const response = await request(port, '/api/work?search=a%2Bb&search=c', {
    method: 'PATCH', body: '{"value":1}', headers: {
      Host: 'untrusted.test', Origin: 'https://configured.test',
      Cookie: 'session=actual-token; csrf=actual-code',
      'X-Forwarded-Host': 'untrusted.test', 'Content-Type': 'application/json',
    },
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.toString(), 'saved');
});

test('bridge preserves distinct cookies and authoritative security headers', async t => {
  const cookies = [
    'session=one; Path=/; HttpOnly; Secure; SameSite=Lax',
    'csrf=two; Path=/; Expires=Wed, 30 Sep 2026 12:00:00 GMT; Secure; SameSite=Lax',
  ];
  const port = await startServer(t, () => {
    const headers = new Headers({ 'Cache-Control': 'public', 'X-Handler': 'retained' });
    for (const cookie of cookies) headers.append('Set-Cookie', cookie);
    return new Response('created', { status: 202, headers });
  }, { responseHeaders: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  const response = await request(port);
  assert.equal(response.status, 202);
  assert.deepEqual(response.headers['set-cookie'], cookies);
  assert.equal(response.rawHeaders.filter(value => value.toLowerCase() === 'set-cookie').length, 2);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-handler'], 'retained');
});

test('HEAD keeps status and metadata, cancels its response stream, and sends no body', async t => {
  let cancelled = false;
  const port = await startServer(t, incoming => {
    assert.equal(incoming.method, 'HEAD');
    assert.equal(incoming.body, null);
    return new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new TextEncoder().encode('ignored')); },
      cancel() { cancelled = true; },
    }), { status: 200, headers: { ETag: 'version-1', 'Content-Length': '7' } });
  });
  const response = await request(port, '/', { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(response.body.length, 0);
  assert.equal(response.headers.etag, 'version-1');
  assert.equal(response.headers['content-length'], '7');
  assert.equal(cancelled, true);
});

test('handler can reject before the client sends any request body', { timeout: 5000 }, async t => {
  const port = await startServer(t, incoming => {
    assert.equal(incoming.bodyUsed, false);
    assert.equal(incoming.headers.get('Content-Length'), '1024');
    return new Response('unauthorized', { status: 401 });
  });
  await new Promise((resolve, reject) => {
    const outgoing = httpRequest({ hostname: '127.0.0.1', port, method: 'POST',
      headers: { 'Content-Length': '1024' } }, incoming => {
      assert.equal(incoming.statusCode, 401);
      incoming.resume();
      incoming.once('end', () => { outgoing.destroy(); resolve(); });
      incoming.once('error', reject);
    });
    outgoing.once('error', reject);
    outgoing.flushHeaders();
    t.after(() => outgoing.destroy());
  });
});

test('body cancellation on the streaming limit returns 413 and leaves the socket reusable', async t => {
  let sawCancellation = false;
  const port = await startServer(t, async incoming => {
    if (incoming.method === 'GET') return new Response('still open');
    const reader = incoming.body.getReader();
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 128 * 1024) {
          await reader.cancel();
          sawCancellation = true;
          return new Response('too large', { status: 413 });
        }
      }
      return new Response('unexpected', { status: 200 });
    } finally { reader.releaseLock(); }
  });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const rejected = await request(port, '/', {
    method: 'POST', body: Buffer.alloc(512 * 1024), agent,
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(512 * 1024) },
  });
  assert.equal(rejected.status, 413);
  assert.equal(rejected.body.toString(), 'too large');
  assert.equal(sawCancellation, true);
  const next = await request(port, '/', { agent });
  assert.equal(next.status, 200);
  assert.equal(next.socket, rejected.socket);
});

test('client upload abort rejects a pending Web body read and aborts the handler signal', { timeout: 5000 }, async t => {
  let firstRead;
  const reading = new Promise(resolve => { firstRead = resolve; });
  let finished;
  const completion = new Promise(resolve => { finished = resolve; });
  let signalAborted = false;
  let readRejected = false;
  const port = await startServer(t, async incoming => {
    const reader = incoming.body.getReader();
    await reader.read();
    firstRead();
    try { await reader.read(); }
    catch { readRejected = true; signalAborted = incoming.signal.aborted; }
    finally { reader.releaseLock(); }
    return new Response('not delivered');
  }, { onFinished: finished });
  const outgoing = httpRequest({ hostname: '127.0.0.1', port, method: 'POST' });
  outgoing.on('error', () => {});
  outgoing.write('started');
  await reading;
  outgoing.destroy();
  const nodeRequest = await completion;
  assert.equal(readRejected, true);
  assert.equal(signalAborted, true);
  assert.equal(nodeRequest.listenerCount('readable'), 0);
});

test('client response abort cancels the streamed Web response source', { timeout: 5000 }, async t => {
  let cancelled;
  const cancellation = new Promise(resolve => { cancelled = resolve; });
  const port = await startServer(t, () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)); },
    cancel() { cancelled(); },
  }, { highWaterMark: 0 })));
  const outgoing = httpRequest({ hostname: '127.0.0.1', port }, incoming => {
    incoming.once('data', () => incoming.destroy());
    incoming.on('error', () => {});
  });
  outgoing.on('error', () => {});
  outgoing.end();
  t.after(() => outgoing.destroy());
  await cancellation;
});

test('handler failures reach the outer safe catch before committing headers', async t => {
  const port = await startServer(t, () => { throw new Error('private internal detail'); });
  const response = await request(port, '/', { method: 'POST', body: 'ignored' });
  assert.equal(response.status, 500);
  assert.equal(response.body.toString(), 'Request failed.');
  assert.doesNotMatch(response.body.toString(), /private/);
});

test('response-only preflight writer works without a Web Request or configured origin', async t => {
  const server = createServer((incoming, outgoing) => {
    const response = new Response('disabled', {
      status: 503, headers: { 'Set-Cookie': 'session=; Max-Age=0; Path=/', 'Retry-After': '60' },
    });
    sendNodeWebResponse(incoming, outgoing, response, { 'Cache-Control': 'no-store' })
      .catch(() => outgoing.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  for (const method of ['GET', 'HEAD']) {
    const result = await request(server.address().port, '/', { method });
    assert.equal(result.status, 503);
    assert.deepEqual(result.headers['set-cookie'], ['session=; Max-Age=0; Path=/']);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.headers['retry-after'], '60');
    assert.equal(result.body.toString(), method === 'HEAD' ? '' : 'disabled');
  }
});
