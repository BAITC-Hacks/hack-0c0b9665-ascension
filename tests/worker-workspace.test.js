import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWorkerWorkspace } from '../src/runtime/worker-workspace.js';
import { WORKSPACE_RESPONSE_HEADERS } from '../src/http/workspace.js';

const ORIGIN = 'https://workspace.example';
const POLICY = [{ id: 'operator', name: 'Test operator', role: 'editor', tokenHash: 'a'.repeat(64) }];
const configuration = overrides => ({
  WORKSPACE_ORIGIN: ORIGIN,
  WORKSPACE_SESSION_SECRET: 'synthetic-session-secret-for-local-tests-only',
  WORKSPACE_ACCESS_POLICY: JSON.stringify(POLICY),
  ...overrides,
});
const getRequest = (method = 'GET') => new Request(`${ORIGIN}/api/workspace/session`, { method });

function assertSecured(response) {
  for (const [name, value] of Object.entries(WORKSPACE_RESPONSE_HEADERS)) {
    assert.equal(response.headers.get(name), value, name);
  }
}

test('exact disabled configuration preflight touches neither the DO nor the request body', async () => {
  let bindingCalls = 0;
  const binding = { getByName() { bindingCalls++; throw new Error('must not open storage'); } };
  for (const config of [
    {}, configuration({ WORKSPACE_SESSION_SECRET: 'short' }),
    configuration({ WORKSPACE_ORIGIN: `${ORIGIN}/` }),
    configuration({ WORKSPACE_ORIGIN: 'http://remote.example' }),
    configuration({ WORKSPACE_ACCESS_POLICY: 'not json' }),
    configuration({ WORKSPACE_ACCESS_POLICY: '[]' }),
    configuration({ WORKSPACE_ACCESS_POLICY: JSON.stringify([{ ...POLICY[0], role: 'administrator' }]) }),
    configuration({ WORKSPACE_ACCESS_POLICY: JSON.stringify([POLICY[0], POLICY[0]]) }),
  ]) {
    let pulls = 0;
    const body = new ReadableStream({ pull() { pulls++; } }, { highWaterMark: 0 });
    const request = new Request(`${ORIGIN}/api/workspace/session`, {
      method: 'POST', body, duplex: 'half', headers: { 'Content-Type': 'application/json' },
    });
    const response = await handleWorkerWorkspace(request, { ...config, TEAM_WORKSPACE: binding });
    assert.equal(response.status, 503);
    assertSecured(response);
    assert.equal((await response.json()).error.code, 'WORKSPACE_DISABLED');
    assert.equal(pulls, 0);
    assert.equal(request.bodyUsed, false);
    await request.body.cancel();
  }
  assert.equal(bindingCalls, 0);
});

test('forwarding preserves actual URL, method, body, Origin and cookies while replacing private address metadata', async () => {
  const originalUrl = 'https://actual-request.example/api/workspace/register?revision=3&value=a%2Bb';
  const originalBody = '{"expectedRevision":3,"document":{"schemaVersion":2,"registers":[]}}';
  const request = new Request(originalUrl, {
    method: 'PUT', body: originalBody, headers: {
      Origin: 'https://actual-origin.example', Cookie: 'akim_workspace_session=actual; other=retained',
      'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7',
      'X-Forwarded-For': '198.51.100.99', 'X-Workspace-Client-Address': 'forged-private-address',
    },
  });
  const cookies = ['one=first; HttpOnly; SameSite=Strict', 'two=second; HttpOnly; SameSite=Strict'];
  const response = await handleWorkerWorkspace(request, configuration({
    TEAM_WORKSPACE: { getByName(name) {
      assert.equal(name, 'team');
      return { async fetch(forwarded) {
        assert.equal(forwarded.url, originalUrl);
        assert.equal(forwarded.method, 'PUT');
        assert.equal(forwarded.headers.get('Origin'), 'https://actual-origin.example');
        assert.equal(forwarded.headers.get('Cookie'), 'akim_workspace_session=actual; other=retained');
        assert.equal(forwarded.headers.get('X-Workspace-Client-Address'), '203.0.113.7');
        assert.equal(await forwarded.text(), originalBody);
        const headers = new Headers({ 'Cache-Control': 'public', 'Content-Security-Policy': '*',
          Allow: 'GET, PUT', 'Retry-After': '19' });
        for (const cookie of cookies) headers.append('Set-Cookie', cookie);
        return Response.json({ error: { code: 'CONFLICT', revision: 4 } }, { status: 409, headers });
      } };
    } },
  }));
  assert.equal(request.headers.get('X-Workspace-Client-Address'), 'forged-private-address');
  assert.equal(response.status, 409);
  assertSecured(response);
  assert.equal(response.headers.get('Allow'), 'GET, PUT');
  assert.equal(response.headers.get('Retry-After'), '19');
  assert.deepEqual(response.headers.getSetCookie(), cookies);
  assert.deepEqual(await response.json(), { error: { code: 'CONFLICT', revision: 4 } });
});

test('authentication can reject a forwarded request without reading its body', async () => {
  let pulls = 0;
  const body = new ReadableStream({ pull() { pulls++; } }, { highWaterMark: 0 });
  let forwardedRequest;
  const request = new Request(`${ORIGIN}/api/workspace/register`, {
    method: 'PUT', body, duplex: 'half', headers: { Origin: ORIGIN },
  });
  const response = await handleWorkerWorkspace(request, configuration({
    TEAM_WORKSPACE: { getByName: () => ({ fetch: async forwarded => {
      forwardedRequest = forwarded;
      assert.equal(forwarded.bodyUsed, false);
      return Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 });
    } }) },
  }));
  assert.equal(response.status, 401);
  assert.equal(pulls, 0);
  assertSecured(response);
  await forwardedRequest.body.cancel();
});

test('missing platform address ignores XFF and caller-supplied private address values', async () => {
  for (const platformAddress of [undefined, '']) {
    const request = new Request(`${ORIGIN}/api/workspace/session`, { headers: {
      'X-Forwarded-For': '198.51.100.4', 'X-Workspace-Client-Address': '198.51.100.5',
      ...(platformAddress === undefined ? {} : { 'CF-Connecting-IP': platformAddress }),
    } });
    const response = await handleWorkerWorkspace(request, configuration({
      TEAM_WORKSPACE: { getByName: () => ({ fetch: async forwarded => {
        assert.equal(forwarded.headers.get('X-Workspace-Client-Address'), 'unknown');
        return new Response(null, { status: 204 });
      } }) },
    }));
    assert.equal(response.status, 204);
    assertSecured(response);
  }
});

test('missing, broken and malformed bindings return a safe unavailable response', async () => {
  for (const binding of [undefined, {},
    { getByName() { throw new Error('private binding identifier'); } },
    { getByName: () => ({ fetch: async () => { throw new Error('private database detail'); } }) },
    { getByName: () => ({ fetch: async () => undefined }) },
  ]) {
    const response = await handleWorkerWorkspace(getRequest(), configuration({ TEAM_WORKSPACE: binding }));
    assert.equal(response.status, 503);
    assertSecured(response);
    const value = await response.json();
    assert.equal(value.error.code, 'WORKSPACE_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(value), /private|synthetic-session|tokenHash|WORKSPACE_ACCESS_POLICY/);
  }
});

test('HEAD preserves status and response metadata while omitting every body', async () => {
  let cancelled = false;
  const configurations = [
    { env: {}, status: 503 },
    { env: configuration(), status: 503 },
    { env: configuration({ TEAM_WORKSPACE: { getByName: () => ({ fetch: async () => new Response(
      new ReadableStream({ cancel() { cancelled = true; } }, { highWaterMark: 0 }),
      { status: 405, headers: { Allow: 'GET, PUT', 'Retry-After': '7', 'Set-Cookie': 'session=; Max-Age=0' } },
    ) }) } }), status: 405 },
  ];
  for (const { env, status } of configurations) {
    const response = await handleWorkerWorkspace(getRequest('HEAD'), env);
    assert.equal(response.status, status);
    assert.equal(await response.text(), '');
    assertSecured(response);
    if (status === 405) {
      assert.equal(response.headers.get('Allow'), 'GET, PUT');
      assert.equal(response.headers.get('Retry-After'), '7');
      assert.deepEqual(response.headers.getSetCookie(), ['session=; Max-Age=0']);
    }
  }
  assert.equal(cancelled, true);
});
