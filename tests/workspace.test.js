import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteRepository } from '../src/workspace/node-sqlite.js';
import { createDurableRepository } from '../src/workspace/durable-repository.js';
import { createWorkspaceHandler } from '../src/workspace/handler.js';
import { sha256, SESSION_TTL_MS } from '../src/workspace/auth.js';
import { validateDocument } from '../src/workspace/schema.js';

// Only generated ephemeral fixture credentials. Never used by a deployment.
const access = () => crypto.randomUUID() + crypto.randomUUID();
export function fixtureDocument() {
  const decisions = [1, 2, 3, 4, 5].map((i) => ({ measureId: `M${i}`, districtId: 'nura' }));
  const labels = decisions.map((d) => ({ ...d, measureName: `Мера ${d.measureId}`, districtName: 'Нура' }));
  const source = { city: { id: 'astana', name: 'Астана' }, scenario: { decisions }, result: { valid: true, score: 56.54, totalCost: 95, remainingBudget: 5, criticalCount: 1 }, calculatedAt: '2026-09-23T11:00:00.000Z', labels };
  return { schemaVersion: 2, registers: [{ id: 'register-1', sourceKey: JSON.stringify(['astana', decisions.map((d) => [d.measureId, d.districtId])]), createdAt: source.calculatedAt, source,
    actions: labels.map((l, i) => ({ id: `action-${i}`, ...l, owner: '', dueDate: '', criterion: '', status: 'draft', evidence: '', implementation: { siteAddress: '', siteBasis: '', siteSourceUrl: '', kpi: { name: '', unit: '', baseline: null, target: null, source: '' }, budget: { capexKzt: null, opexKzt: null, estimateSource: '', estimateDate: '' }, prerequisites: '', nextStep: '' } })) }] };
}
async function setup(t, { origin = 'https://city.example', repository: supplied } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-test-'));
  const repository = supplied ?? createSqliteRepository(join(directory, 'register.sqlite'));
  t.after(() => { repository.close?.(); rmSync(directory, { recursive: true, force: true }); });
  const tokens = Object.fromEntries(['owner', 'editor', 'viewer'].map((role) => [role, access()]));
  let policy = await Promise.all(Object.entries(tokens).map(async ([role, token]) => ({ id: role, name: `${role} fixture`, role, tokenHash: await sha256(token) })));
  let config = { WORKSPACE_ORIGIN: origin, WORKSPACE_SESSION_SECRET: access(), WORKSPACE_ACCESS_POLICY: JSON.stringify(policy) };
  let clock = Date.parse('2026-09-23T11:00:00Z');
  const handler = createWorkspaceHandler({ repository, getConfig: () => config, now: () => clock });
  const req = (path, method = 'GET', body, cookie, extra = {}) => new Request(`http://internal-proxy/api/workspace/${path}`, { method, headers: { ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...extra }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const login = async (role = 'editor') => { const r = await handler(req('session', 'POST', { accessKey: tokens[role] })); assert.equal(r.status, 200); return r.headers.get('set-cookie').split(';')[0]; };
  return { repository, directory, handler, req, login, tokens, setClock: (v) => { clock = v; }, clock: () => clock, config: () => config, setConfig: (v) => { config = v; }, policy: () => policy, setPolicy: (v) => { policy = v; config.WORKSPACE_ACCESS_POLICY = JSON.stringify(v); } };
}

test('disabled config never exposes data; unknown roles and insecure origins fail closed', async (t) => {
  const s = await setup(t);
  for (const config of [{}, { ...s.config(), WORKSPACE_SESSION_SECRET: '' }, { ...s.config(), WORKSPACE_ORIGIN: 'http://public.example' }, { ...s.config(), WORKSPACE_ACCESS_POLICY: '[{"role":"admin"}]' }]) {
    s.setConfig(config); assert.equal((await s.handler(s.req('register'))).status, 503);
  }
});
test('anonymous reads/writes/audit fail and login metadata excludes hashes/credentials', async (t) => {
  const s = await setup(t);
  for (const [path, method] of [['register', 'GET'], ['audit', 'GET'], ['session', 'GET'], ['register', 'PUT']]) assert.equal((await s.handler(s.req(path, method, method === 'PUT' ? {} : undefined))).status, 401);
  const r = await s.handler(s.req('session', 'POST', { accessKey: s.tokens.editor }));
  assert.equal(r.status, 200); assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=900; Secure/);
  assert.match(r.headers.get('cache-control'), /no-store/);
  const serialized = await r.text(); assert.ok(!serialized.includes(s.tokens.editor)); assert.ok(!serialized.includes('tokenHash')); assert.ok(serialized.includes('editor fixture'));
});
test('viewer reads audit but cannot publish; client role never escalates', async (t) => {
  const s = await setup(t), cookie = await s.login('viewer');
  assert.equal((await s.handler(s.req('register', 'GET', undefined, cookie))).status, 200);
  assert.equal((await s.handler(s.req('audit', 'GET', undefined, cookie))).status, 200);
  assert.equal((await s.handler(s.req('register', 'PUT', { role: 'owner', expectedRevision: 0, document: fixtureDocument() }, cookie))).status, 403);
  assert.equal(s.repository.read().revision, 0);
});
test('successful publish stores server actor and atomic revision audit; concurrent stale request is 409', async (t) => {
  const s = await setup(t), editor = await s.login(), owner = await s.login('owner');
  const body = { expectedRevision: 0, document: fixtureDocument() };
  const responses = await Promise.all([s.handler(s.req('register', 'PUT', body, editor)), s.handler(s.req('register', 'PUT', body, owner))]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const audit = s.repository.audit(); assert.equal(audit.length, 1); assert.equal(audit[0].revision, 1); assert.ok(['owner', 'editor'].includes(audit[0].actor.id));
  assert.deepEqual(audit[0].summary, { registers: 1, actions: 5 });
  const conflict = await responses.find((r) => r.status === 409).json(); assert.equal(conflict.error.currentRevision, 1);
  body.document.registers[0].actions[0].owner = 'later mutation'; assert.equal(s.repository.read().document.registers[0].actions[0].owner, '');
});
test('SQLite document and append-only audit survive independent connection and restart', async (t) => {
  const s = await setup(t), path = join(s.directory, 'register.sqlite');
  const other = createSqliteRepository(path);
  other.write({ expectedRevision: 0, document: fixtureDocument(), actor: { id: 'server-id', name: 'Operator', role: 'editor' }, at: '2026-09-23T11:00:00Z' });
  assert.equal(s.repository.read().revision, 1); other.close();
  const reopened = createSqliteRepository(path); assert.equal(reopened.read().document.registers.length, 1); assert.equal(reopened.audit()[0].actor.id, 'server-id'); reopened.close();
});
test('failed audit insertion rolls back document and revision', () => {
  const db = new DatabaseSync(':memory:');
  const storage = { sql: { exec(query, ...args) { if (query.startsWith('INSERT INTO workspace_audit')) throw new Error('disk-full fixture'); const stmt = db.prepare(query); return { toArray: () => stmt.all(...args), ...(!query.startsWith('SELECT') ? (stmt.run(...args), {}) : {}) }; } }, transactionSync(fn) { db.exec('BEGIN'); try { const v = fn(); db.exec('COMMIT'); return v; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
  const repository = createDurableRepository(storage);
  assert.throws(() => repository.write({ expectedRevision: 0, document: fixtureDocument(), actor: {}, at: '' }), /disk-full/);
  assert.equal(repository.read().revision, 0); assert.deepEqual(repository.audit(), []); db.close();
});
test('strict schema rejects extra data, missing passports, duplicates, status abuse and invalid numbers', () => {
  assert.deepEqual(validateDocument(fixtureDocument()), fixtureDocument());
  const mutations = [
    (d) => { d.role = 'owner'; }, (d) => { d.schemaVersion = 1; }, (d) => { d.registers[0].actions[0].role = 'owner'; },
    (d) => { delete d.registers[0].actions[0].implementation; }, (d) => { d.registers.push(structuredClone(d.registers[0])); },
    (d) => { d.registers[0].actions[0].status = 'completed'; }, (d) => { d.registers[0].actions[0].dueDate = '2026-02-30'; },
    (d) => { d.registers[0].actions[0].implementation.budget.capexKzt = -1; }, (d) => { d.registers[0].source.result.score = Infinity; },
    (d) => { d.registers[0].actions[0].implementation.siteSourceUrl = 'javascript:alert(1)'; },
  ];
  for (const mutate of mutations) { const d = fixtureDocument(); mutate(d); assert.throws(() => validateDocument(d), (e) => e.status === 422); }
  const d = fixtureDocument(); d.registers[0].actions[0].implementation.budget.capexKzt = 0;
  assert.equal(validateDocument(d).registers[0].actions[0].implementation.budget.capexKzt, 0);
});
test('CSRF and method validation run before reading body; TLS proxy uses configured origin for Secure', async (t) => {
  const s = await setup(t), cookie = await s.login();
  for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { origin: 'https://city.example', 'sec-fetch-site': 'cross-site' }]) {
    const request = s.req('register', 'PUT', { expectedRevision: 0, document: fixtureDocument() }, cookie, headers);
    assert.equal((await s.handler(request)).status, 403); assert.equal(request.bodyUsed, false);
  }
  const missing = s.req('session', 'DELETE', undefined, cookie); missing.headers.delete('origin'); assert.equal((await s.handler(missing)).status, 403);
  assert.equal((await s.handler(s.req('register', 'POST', {}, cookie))).status, 405);
  const r = await s.handler(s.req('session', 'POST', { accessKey: s.tokens.editor })); assert.match(r.headers.get('set-cookie'), /Secure/);
});
test('localhost dev cookie allowed without Secure; untrusted Host does not set origin policy', async (t) => {
  const s = await setup(t, { origin: 'http://127.0.0.1:3123' });
  const r = await s.handler(s.req('session', 'POST', { accessKey: s.tokens.editor }, undefined, { host: 'evil.example', 'x-forwarded-proto': 'https' }));
  assert.equal(r.status, 200); assert.ok(!r.headers.get('set-cookie').includes('Secure'));
});
test('session expires, changed/revoked policy invalidates issued cookie, logout revokes replay', async (t) => {
  const s = await setup(t); let cookie = await s.login();
  const original = s.policy(); s.setPolicy(original.filter((p) => p.id !== 'editor'));
  assert.equal((await s.handler(s.req('register', 'GET', undefined, cookie))).status, 401);
  s.setPolicy(original.map((p) => p.id === 'editor' ? { ...p, role: 'viewer' } : p));
  assert.equal((await s.handler(s.req('register', 'GET', undefined, cookie))).status, 401);
  s.setPolicy(original); s.setClock(s.clock() + SESSION_TTL_MS);
  assert.equal((await s.handler(s.req('register', 'GET', undefined, cookie))).status, 401);
  cookie = await s.login(); const out = await s.handler(s.req('session', 'DELETE', undefined, cookie)); assert.equal(out.status, 200); assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await s.handler(s.req('register', 'GET', undefined, cookie))).status, 401);
});
test('tampered session and duplicate cookies cannot authenticate', async (t) => {
  const s = await setup(t), cookie = await s.login();
  for (const value of [cookie.slice(0, -8) + 'xxxxxxxx', `${cookie}; ${cookie}`]) assert.equal((await s.handler(s.req('register', 'GET', undefined, value))).status, 401);
});
test('login limiter persists across handlers; 60 seconds resets the window', async (t) => {
  const s = await setup(t);
  for (let i = 0; i < 12; i++) assert.equal((await s.handler(s.req('session', 'POST', { accessKey: access() }))).status, 401);
  const again = createWorkspaceHandler({ repository: s.repository, getConfig: s.config, now: s.clock });
  const r = await again(s.req('session', 'POST', { accessKey: s.tokens.editor })); assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), '60');
  s.setClock(s.clock() + 60_000); assert.equal((await again(s.req('session', 'POST', { accessKey: s.tokens.editor }))).status, 200);
});
test('trusted per-client limits isolate one noisy client; spoofed request headers cannot select a bucket', async (t) => {
  const s = await setup(t);
  for (let i = 0; i < 12; i++) assert.equal((await s.handler(s.req('session', 'POST', { accessKey: access() }), { clientAddress: '198.51.100.1' })).status, 401);
  const noisy = await s.handler(s.req('session', 'POST', { accessKey: s.tokens.editor }, undefined, { 'x-forwarded-for': '198.51.100.2', 'x-workspace-client-address': '198.51.100.2' }), { clientAddress: '198.51.100.1' });
  assert.equal(noisy.status, 429);
  assert.equal((await s.handler(s.req('session', 'POST', { accessKey: s.tokens.editor }), { clientAddress: '198.51.100.2' })).status, 200);
  assert.equal(s.repository.audit().length, 0);
});
test('quota failures retain 413 even when stream cancel rejects; JSON media type is exact', async (t) => {
  const s = await setup(t), cookie = await s.login();
  const malformed = s.req('register', 'PUT', {}, cookie, { 'content-type': 'application/json-malicious' });
  assert.equal((await s.handler(malformed)).status, 415); assert.equal(malformed.bodyUsed, false);
  const request = new Request('https://city.example/api/workspace/register', { method: 'PUT', duplex: 'half', headers: { origin: 'https://city.example', cookie, 'content-type': 'application/json; charset=utf-8' }, body: new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(131073)); }, cancel() { throw new Error('cancel fixture'); } }) });
  assert.equal((await s.handler(request)).status, 413);
});
test('declared and streamed body limits reject before mutation; no leaked parser error', async (t) => {
  const s = await setup(t), cookie = await s.login();
  const declared = s.req('register', 'PUT', {}, cookie, { 'content-length': '131073' });
  assert.equal((await s.handler(declared)).status, 413); assert.equal(declared.bodyUsed, false);
  let canceled = false;
  const request = new Request('https://city.example/api/workspace/register', { method: 'PUT', duplex: 'half', headers: { origin: 'https://city.example', cookie, 'content-type': 'application/json' }, body: new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(70_000)); }, cancel() { canceled = true; } }) });
  assert.equal((await s.handler(request)).status, 413); assert.equal(canceled, true); assert.equal(s.repository.read().revision, 0);
  const malformed = new Request('https://city.example/api/workspace/register', { method: 'PUT', headers: { origin: 'https://city.example', cookie, 'content-type': 'application/json' }, body: '{bad' });
  const response = await s.handler(malformed); assert.equal(response.status, 400); assert.ok(!(await response.text()).includes('SyntaxError'));
});
test('unauthenticated, role-forbidden and CSRF requests never consume the document body', async (t) => {
  const s = await setup(t), viewer = await s.login('viewer');
  for (const cookie of [undefined, viewer]) { const request = s.req('register', 'PUT', { document: fixtureDocument() }, cookie); assert.ok([401, 403].includes((await s.handler(request)).status)); assert.equal(request.bodyUsed, false); }
});
