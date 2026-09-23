import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../src/server.js';
import { createWorker } from '../src/worker.js';

const ACCESS = 'synthetic-workspace-http-access-key-only';
const SECRET = 'synthetic-workspace-http-session-secret-only';
const IDENTITY = { id: 'operator', name: 'Local fixture operator', role: 'editor' };
const DOCUMENT = { schemaVersion: 2, registers: [] };
function configuration(origin) {
  return { WORKSPACE_ORIGIN: origin, WORKSPACE_SESSION_SECRET: SECRET,
    WORKSPACE_ACCESS_POLICY: JSON.stringify([{ ...IDENTITY,
      tokenHash: createHash('sha256').update(ACCESS).digest('hex') }]) };
}

function privateResponse(response) {
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
}

function resources(t) {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-http-'));
  const servers = [];
  t.after(async () => {
    for (const server of servers) await server.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, async start(options) {
    const server = createAppServer(options);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let stopped = false;
    const client = {
      origin: `http://127.0.0.1:${server.address().port}`,
      async stop() {
        if (stopped) return;
        stopped = true;
        const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        server.closeAllConnections();
        await closed;
      },
      request(path, { method = 'GET', headers = {}, body } = {}) {
        return fetch(client.origin + path, { method, signal: AbortSignal.timeout(5000),
          headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      },
    };
    servers.push(client);
    return client;
  } };
}

for (const kind of ['Node', 'Worker']) {
  test(`${kind} root owns only the workspace route boundary and fails closed when disabled`, async t => {
    let request;
    if (kind === 'Node') {
      const client = await resources(t).start({ env: {} });
      request = path => client.request(path);
    } else {
      const worker = createWorker();
      request = path => worker.fetch(new Request(`https://workspace.example${path}`), {});
    }
    for (const path of ['/api/workspace', '/api/workspace/session']) {
      const response = await request(path);
      assert.equal(response.status, 503);
      privateResponse(response);
      assert.equal((await response.json()).error.code, 'WORKSPACE_DISABLED');
    }
    for (const path of ['/api/workspaces', '/api/workspace-export']) {
      const response = await request(path);
      assert.equal(response.status, 404, path);
      privateResponse(response);
      assert.equal((await response.json()).errors[0].code, 'NOT_FOUND');
    }
    const health = await request('/api/health');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, aiConfigured: false });
  });
}

test('Node root persists a workspace session/publication at the supplied path and closes SQLite with the server', async t => {
  const fixture = resources(t);
  const database = join(fixture.directory, 'workspace.sqlite');
  const env = configuration('http://127.0.0.1');
  const first = await fixture.start({ env, workspaceDbPath: database });
  env.WORKSPACE_ORIGIN = first.origin;
  assert.equal(existsSync(database), false, 'storage stays lazy until an authenticated operation needs it');
  const login = await first.request('/api/workspace/session', { method: 'POST',
    headers: { Origin: env.WORKSPACE_ORIGIN }, body: { accessKey: ACCESS } });
  assert.equal(login.status, 200);
  privateResponse(login);
  const cookies = login.headers.getSetCookie();
  assert.equal(cookies.length, 1);
  assert.match(cookies[0], /^akim_workspace_session=.+; Path=\/api\/workspace; HttpOnly; SameSite=Strict; Max-Age=900$/);
  const cookie = cookies[0].split(';')[0];
  const session = await login.json();
  assert.deepEqual(session.identity, IDENTITY);
  assert.doesNotMatch(JSON.stringify(session), /synthetic-workspace|tokenHash/);
  const published = await first.request('/api/workspace/register', { method: 'PUT',
    headers: { Origin: env.WORKSPACE_ORIGIN, Cookie: cookie },
    body: { expectedRevision: 0, document: DOCUMENT } });
  assert.equal(published.status, 200);
  privateResponse(published);
  assert.deepEqual(await published.json(), { revision: 1, document: DOCUMENT });
  assert.equal(existsSync(database), true);
  assert.equal(existsSync(`${database}-wal`), true, 'the live SQLite connection uses WAL');
  await first.stop();
  assert.equal(existsSync(`${database}-wal`), false, 'server.close closes the final SQLite connection');

  const second = await fixture.start({ env, workspaceDbPath: database });
  const restored = await second.request('/api/workspace/register', { headers: { Cookie: cookie } });
  assert.equal(restored.status, 200);
  privateResponse(restored);
  assert.deepEqual(await restored.json(), { revision: 1, document: DOCUMENT });
  const audit = await second.request('/api/workspace/audit', { headers: { Cookie: cookie } });
  assert.equal(audit.status, 200);
  const { entries } = await audit.json();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].revision, 1);
  assert.deepEqual(entries[0].actor, IDENTITY);
  await second.stop();
  assert.equal(existsSync(`${database}-wal`), false);
});

test('Node root passes its custom static directory to the workspace database guard', async t => {
  const fixture = resources(t);
  const publicDir = join(fixture.directory, 'served-files');
  const database = join(publicDir, 'private.sqlite');
  const env = configuration('http://127.0.0.1');
  const client = await fixture.start({ env, publicDir, workspaceDbPath: database });
  env.WORKSPACE_ORIGIN = client.origin;
  const response = await client.request('/api/workspace/session', { method: 'POST',
    headers: { Origin: client.origin }, body: { accessKey: ACCESS } });
  assert.equal(response.status, 503);
  privateResponse(response);
  const text = await response.text();
  assert.equal(JSON.parse(text).error.code, 'WORKSPACE_UNAVAILABLE');
  assert.ok(!text.includes(database) && !text.includes(ACCESS));
  assert.equal(existsSync(publicDir), false, 'no database can be created under the served root');
});

test('Worker root forwards trusted client metadata and preserves workspace response status and secure cookies', async () => {
  const origin = 'https://workspace.example';
  const cookie = 'akim_workspace_session=synthetic; Path=/api/workspace; HttpOnly; SameSite=Strict; Secure';
  const payload = { error: { code: 'REVISION_CONFLICT', currentRevision: 7 } };
  let calls = 0;
  const env = { ...configuration(origin), TEAM_WORKSPACE: { getByName(name) {
    assert.equal(name, 'team');
    return { async fetch(forwarded) {
      calls++;
      assert.equal(forwarded.url, `${origin}/api/workspace/register`);
      assert.equal(forwarded.method, 'PUT');
      assert.equal(forwarded.headers.get('Origin'), origin);
      assert.equal(forwarded.headers.get('Cookie'), 'akim_workspace_session=incoming');
      assert.equal(forwarded.headers.get('X-Workspace-Client-Address'), '203.0.113.8');
      assert.deepEqual(await forwarded.json(), { expectedRevision: 6, document: DOCUMENT });
      return Response.json(payload, { status: 409, headers: { 'Set-Cookie': cookie,
        'Retry-After': '17', 'Cache-Control': 'public', 'X-Frame-Options': 'ALLOWALL',
        'Content-Security-Policy': '*' } });
    } };
  } } };
  const worker = createWorker();
  const response = await worker.fetch(new Request(`${origin}/api/workspace/register`, {
    method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json',
      Cookie: 'akim_workspace_session=incoming', 'CF-Connecting-IP': '203.0.113.8',
      'X-Forwarded-For': '198.51.100.7', 'X-Workspace-Client-Address': 'spoofed-address' },
    body: JSON.stringify({ expectedRevision: 6, document: DOCUMENT }),
  }), env);
  assert.equal(response.status, 409);
  privateResponse(response);
  assert.equal(response.headers.get('Retry-After'), '17');
  assert.deepEqual(response.headers.getSetCookie(), [cookie]);
  assert.deepEqual(await response.json(), payload);
  for (const path of ['/api/workspaces', '/api/workspace-export']) {
    const sibling = await worker.fetch(new Request(origin + path), env);
    assert.equal(sibling.status, 404);
    await sibling.arrayBuffer();
  }
  assert.equal(calls, 1, 'neighboring routes must never touch workspace storage');
});
