import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeWorkspace } from '../src/runtime/node-workspace.js';
import { sha256 } from '../src/workspace/auth.js';

const ORIGIN = 'https://workspace.example';
const EMPTY_DOCUMENT = { schemaVersion: 2, registers: [] };
const serverClosers = new WeakMap();

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'node-workspace-'));
  serverClosers.set(t, []);
  t.after(async () => {
    for (const stop of serverClosers.get(t)) await stop();
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

async function configuration() {
  const accessKey = crypto.randomUUID() + crypto.randomUUID();
  return {
    accessKey,
    env: {
      WORKSPACE_ORIGIN: ORIGIN,
      WORKSPACE_SESSION_SECRET: crypto.randomUUID() + crypto.randomUUID(),
      WORKSPACE_ACCESS_POLICY: JSON.stringify([
        { id: 'operator', name: 'Fixture operator', role: 'editor', tokenHash: await sha256(accessKey) },
      ]),
    },
  };
}

async function startServer(t, workspace) {
  const server = createServer((request, response) => {
    workspace.handle(request, response).catch(() => {
      response.writeHead(500);
      response.end('Unexpected adapter rejection');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
    workspace.close();
  };
  serverClosers.get(t).push(stop);
  return {
    stop,
    request(path = 'session', { method = 'GET', headers = {}, body } = {}) {
      return fetch(`http://127.0.0.1:${server.address().port}/api/workspace/${path}`, {
        method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
  };
}

function assertPrivateHeaders(response) {
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
}

test('Node workspace validates exact configuration before bridging or creating storage', async t => {
  const directory = temporaryDirectory(t);
  const { env: valid } = await configuration();
  const configurations = [
    {},
    { ...valid, WORKSPACE_ORIGIN: `${ORIGIN}/` },
    { ...valid, WORKSPACE_ORIGIN: 'http://public.example' },
    { ...valid, WORKSPACE_SESSION_SECRET: 'too-short' },
    { ...valid, WORKSPACE_ACCESS_POLICY: '[{"role":"admin"}]' },
  ];
  for (const [index, env] of configurations.entries()) {
    const parent = join(directory, String(index));
    const workspace = createNodeWorkspace({ env, dbPath: join(parent, 'workspace.sqlite') });
    assert.equal(existsSync(parent), false);
    const server = await startServer(t, workspace);
    const response = await server.request('session', { method: 'POST', body: {}, headers: { Origin: 'https://evil.example' } });
    assert.equal(response.status, 503);
    assertPrivateHeaders(response);
    assert.equal((await response.json()).error.code, 'WORKSPACE_DISABLED');
    assert.equal(existsSync(parent), false);
    await server.stop();
    workspace.close();
  }
});

test('configured anonymous and cross-origin requests leave the lazy database unopened', async t => {
  const directory = temporaryDirectory(t);
  const { env, accessKey } = await configuration();
  const path = join(directory, 'new-directory', 'workspace.sqlite');
  const server = await startServer(t, createNodeWorkspace({ env, dbPath: path }));
  const anonymous = await server.request('register');
  assert.equal(anonymous.status, 401);
  await anonymous.arrayBuffer();
  for (const origin of [undefined, 'null', 'https://evil.example']) {
    const response = await server.request('session', { method: 'POST', body: { accessKey },
      headers: { ...(origin === undefined ? {} : { Origin: origin }), 'X-Forwarded-Host': 'workspace.example', 'X-Forwarded-Proto': 'https' } });
    assert.equal(response.status, 403);
    assertPrivateHeaders(response);
    await response.arrayBuffer();
  }
  assert.equal(existsSync(path), false);
});

test('Node workspace preserves Secure cookie, Origin, SQLite document, audit and revocation across restart', async t => {
  const directory = temporaryDirectory(t);
  const { env, accessKey } = await configuration();
  const path = join(directory, 'persisted', 'workspace.sqlite');
  const ignored = join(directory, 'unused.sqlite');
  env.WORKSPACE_DB_PATH = path;
  const first = await startServer(t, createNodeWorkspace({ env, dbPath: ignored }));
  const login = await first.request('session', { method: 'POST', body: { accessKey },
    headers: { Origin: ORIGIN, Host: 'untrusted-host.example' } });
  assert.equal(login.status, 200);
  assertPrivateHeaders(login);
  const setCookie = login.headers.get('Set-Cookie');
  assert.match(setCookie, /HttpOnly; SameSite=Strict; Max-Age=900; Secure/);
  const cookie = setCookie.split(';')[0];
  assert.equal((await login.json()).identity.id, 'operator');
  assert.equal(existsSync(path), true);
  assert.equal(existsSync(ignored), false);

  const rejected = await first.request('register', { method: 'PUT', body: { expectedRevision: 0, document: EMPTY_DOCUMENT },
    headers: { Cookie: cookie, Origin: 'https://evil.example' } });
  assert.equal(rejected.status, 403);
  await rejected.arrayBuffer();
  const published = await first.request('register', { method: 'PUT', body: { expectedRevision: 0, document: EMPTY_DOCUMENT },
    headers: { Cookie: cookie, Origin: ORIGIN } });
  assert.equal(published.status, 200);
  assert.equal((await published.json()).revision, 1);
  await first.stop();

  const second = await startServer(t, createNodeWorkspace({ env }));
  const read = await second.request('register', { headers: { Cookie: cookie } });
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { revision: 1, document: EMPTY_DOCUMENT });
  const audit = await second.request('audit', { headers: { Cookie: cookie } });
  assert.equal(audit.status, 200);
  const { entries } = await audit.json();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].actor.id, 'operator');
  const logout = await second.request('session', { method: 'DELETE', headers: { Cookie: cookie, Origin: ORIGIN } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('Set-Cookie'), /Max-Age=0/);
  await logout.arrayBuffer();
  await second.stop();
  const third = await startServer(t, createNodeWorkspace({ env }));
  const revoked = await third.request('session', { headers: { Cookie: cookie } });
  assert.equal(revoked.status, 401);
  await revoked.arrayBuffer();
});

test('Node workspace login limit uses the connection address rather than spoofed proxy headers', async t => {
  const directory = temporaryDirectory(t);
  const { env } = await configuration();
  const server = await startServer(t, createNodeWorkspace({ env, dbPath: join(directory, 'workspace.sqlite') }));
  for (let attempt = 0; attempt < 13; attempt++) {
    const response = await server.request('session', { method: 'POST', body: { accessKey: 'x'.repeat(40) },
      headers: { Origin: ORIGIN, 'X-Forwarded-For': `192.0.2.${attempt}`, Forwarded: `for=192.0.2.${attempt}`,
        'X-Workspace-Client-Address': `192.0.2.${attempt}` } });
    assert.equal(response.status, attempt < 12 ? 401 : 429);
    if (attempt === 12) assert.ok(Number(response.headers.get('Retry-After')) > 0);
    await response.arrayBuffer();
  }
});

test('storage failures and public database paths are masked, and close never reopens the database', async t => {
  const directory = temporaryDirectory(t);
  const { env, accessKey } = await configuration();
  const parentFile = join(directory, 'not-a-directory');
  writeFileSync(parentFile, 'fixture');
  const publicPath = fileURLToPath(new URL(`../public/workspace-test-${crypto.randomUUID()}.sqlite`, import.meta.url));
  for (const path of [join(parentFile, 'workspace.sqlite'), publicPath]) {
    const workspace = createNodeWorkspace({ env, dbPath: path });
    const server = await startServer(t, workspace);
    const response = await server.request('session', { method: 'POST', body: { accessKey }, headers: { Origin: ORIGIN } });
    assert.equal(response.status, 503);
    assertPrivateHeaders(response);
    const body = await response.text();
    assert.equal(JSON.parse(body).error.code, 'WORKSPACE_UNAVAILABLE');
    assert.ok(!body.includes(path));
    assert.ok(!body.includes(accessKey));
    assert.equal(existsSync(path), false);
    workspace.close();
    workspace.close();
    const closed = await server.request('session', { method: 'POST', body: { accessKey }, headers: { Origin: ORIGIN } });
    assert.equal(closed.status, 503);
    await closed.arrayBuffer();
    assert.equal(existsSync(path), false);
    await server.stop();
  }
});

test('Node workspace rejects a database inside the server custom static root without creating it', async t => {
  const directory = temporaryDirectory(t);
  const { env, accessKey } = await configuration();
  const publicDir = join(directory, 'custom-static');
  const path = join(publicDir, 'nested', 'workspace.sqlite');
  const server = await startServer(t, createNodeWorkspace({ env, dbPath: path, publicDir }));
  const response = await server.request('session', { method: 'POST', body: { accessKey }, headers: { Origin: ORIGIN } });
  assert.equal(response.status, 503);
  assertPrivateHeaders(response);
  assert.equal((await response.json()).error.code, 'WORKSPACE_UNAVAILABLE');
  assert.equal(existsSync(publicDir), false);
  assert.equal(existsSync(path), false);
});
