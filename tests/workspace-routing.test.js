import test from 'node:test';
import assert from 'node:assert/strict';
import { isWorkspacePath, secureWorkspaceResponse, workspaceUnavailable } from '../src/http/workspace.js';

test('workspace routing owns its exact boundary without capturing sibling API or assets', () => {
  for (const path of ['/api/workspace', '/api/workspace/', '/api/workspace/session', '/api/workspace/register']) {
    assert.equal(isWorkspacePath(path), true, path);
  }
  for (const path of ['/api/workspaces', '/api/workspace-export', '/workspace', '/api/simulate', '/workspace.js']) {
    assert.equal(isWorkspacePath(path), false, path);
  }
});

test('workspace response decoration preserves cookies and errors while enforcing private response policy', async () => {
  const headers = new Headers({ 'Cache-Control': 'public, max-age=86400', 'Content-Security-Policy': '*',
    'Retry-After': '30', Allow: 'GET, PUT' });
  headers.append('Set-Cookie', 'one=first; HttpOnly; SameSite=Strict');
  headers.append('Set-Cookie', 'two=second; HttpOnly; SameSite=Strict');
  const decorated = secureWorkspaceResponse(Response.json({ error: { code: 'CONFLICT', revision: 4 } }, {
    status: 409, headers,
  }));
  assert.equal(decorated.status, 409);
  assert.equal(decorated.headers.get('Cache-Control'), 'no-store');
  assert.equal(decorated.headers.get('Retry-After'), '30');
  assert.equal(decorated.headers.get('Allow'), 'GET, PUT');
  assert.equal(decorated.headers.getSetCookie().length, 2);
  assert.equal(decorated.headers.get('X-Frame-Options'), 'DENY');
  assert.match(decorated.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.deepEqual(await decorated.json(), { error: { code: 'CONFLICT', revision: 4 } });
});

test('unconfigured and unavailable workspace responses never claim successful persistence', async () => {
  for (const disabled of [true, false]) {
    const response = workspaceUnavailable(disabled);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal((await response.json()).error.code, disabled ? 'WORKSPACE_DISABLED' : 'WORKSPACE_UNAVAILABLE');
  }
});
