import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256 } from '../src/workspace/auth.js';

// Optional local workerd harness; no deployment, accounts, network APIs or real credentials.
// Set WORKSPACE_RUNTIME_DIR to a temporary npm prefix containing miniflare + esbuild.
test('real local workerd: authenticated DO, atomic 409/audit, persisted restart, policy revocation', { skip: !process.env.WORKSPACE_RUNTIME_DIR }, async () => {
  const prefix = process.env.WORKSPACE_RUNTIME_DIR;
  const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(join(prefix, 'node_modules/miniflare/dist/src/index.js')));
  const { build } = await import(pathToFileURL(join(prefix, 'node_modules/esbuild/lib/main.js')));
  const result = await build({ stdin: { contents: `import { TeamWorkspaceDurableObject } from './src/workspace/cloudflare.js'; export { TeamWorkspaceDurableObject }; export default { fetch(request, env) { const headers = new Headers(request.headers); headers.set('X-Workspace-Client-Address', request.headers.get('CF-Connecting-IP') || 'unknown'); return env.TEAM_WORKSPACE.getByName('test-team').fetch(new Request(request, { headers })); } };`, resolveDir: resolve('.') }, bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], write: false });
  const dir = mkdtempSync(join(tmpdir(), 'workspace-workerd-'));
  const token = crypto.randomUUID() + crypto.randomUUID();
  const policy = [{ id: 'fixture-editor', name: 'Test editor', role: 'editor', tokenHash: await sha256(token) }];
  const bindings = { WORKSPACE_ORIGIN: 'https://city.example', WORKSPACE_SESSION_SECRET: crypto.randomUUID() + crypto.randomUUID(), WORKSPACE_ACCESS_POLICY: JSON.stringify(policy) };
  const options = { modules: true, script: result.outputFiles[0].text, compatibilityDate: '2026-09-23', durableObjects: { TEAM_WORKSPACE: { className: 'TeamWorkspaceDurableObject', useSQLite: true } }, resourcePersistencePath: dir, bindings };
  let mf;
  const send = (path, method = 'GET', body, cookie) => mf.dispatchFetch(`https://city.example/api/workspace/${path}`, { method, headers: { ...(method !== 'GET' ? { origin: 'https://city.example', 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  try {
    mf = new Miniflare(convertV4MiniflareOptions(options));
    assert.equal((await send('register')).status, 401);
    const login = await send('session', 'POST', { accessKey: token }); assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0]; assert.match(login.headers.get('set-cookie'), /Secure/);
    const document = { schemaVersion: 2, registers: [] };
    const writes = await Promise.all([send('register', 'PUT', { expectedRevision: 0, document }, cookie), send('register', 'PUT', { expectedRevision: 0, document }, cookie)]);
    assert.deepEqual(writes.map((r) => r.status).sort(), [200, 409]);
    const audit = await (await send('audit', 'GET', undefined, cookie)).json(); assert.equal(audit.entries.length, 1); assert.equal(audit.entries[0].actor.id, 'fixture-editor');
    await mf.dispose(); mf = new Miniflare(convertV4MiniflareOptions(options));
    const reopened = await send('register', 'GET', undefined, cookie); assert.equal(reopened.status, 200); assert.equal((await reopened.json()).revision, 1);
    assert.equal((await (await send('audit', 'GET', undefined, cookie)).json()).entries.length, 1);
    await mf.setOptions(convertV4MiniflareOptions({ ...options, bindings: { ...bindings, WORKSPACE_ACCESS_POLICY: JSON.stringify([{ ...policy[0], role: 'viewer' }]) } }));
    assert.equal((await send('register', 'GET', undefined, cookie)).status, 401);
    const viewerLogin = await send('session', 'POST', { accessKey: token }); assert.equal(viewerLogin.status, 200);
    const viewer = viewerLogin.headers.get('set-cookie').split(';')[0]; assert.equal((await send('register', 'PUT', { expectedRevision: 1, document }, viewer)).status, 403);
    assert.equal((await send('session', 'DELETE', undefined, viewer)).status, 200); assert.equal((await send('register', 'GET', undefined, viewer)).status, 401);
    // One editor + one viewer login already used 2 attempts. Untrusted internal-header values
    // cannot split the remaining attempts into separate buckets in this bridge fixture.
    for (let i = 0; i < 10; i++) {
      const bad = await mf.dispatchFetch('https://city.example/api/workspace/session', { method: 'POST', headers: { origin: 'https://city.example', 'content-type': 'application/json', 'X-Workspace-Client-Address': `spoof-${i}` }, body: JSON.stringify({ accessKey: crypto.randomUUID() + crypto.randomUUID() }) });
      assert.equal(bad.status, 401);
    }
    assert.equal((await send('session', 'POST', { accessKey: token })).status, 429);
  } finally { await mf?.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
