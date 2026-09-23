import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run a separate, clean copy of the real entry point; never load the operator's .env.
const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'ascension-self-host-'));
const checkout = join(scratch, 'checkout');
const complaintsFile = join(scratch, 'state', 'complaints.json');
const adminToken = randomBytes(24).toString('hex');
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|COMSPEC|PATHEXT)$/i.test(key)));
Object.assign(environment, { HOST: '127.0.0.1', PORT: '0', COMPLAINTS_FILE: complaintsFile,
  ADMIN_TOKEN: adminToken, OPENAI_API_KEY: '', TELEGRAM_BOT_TOKEN: '', TELEGRAM_WEBHOOK_SECRET: '' });
const children = new Set();
const checks = [];
const startedAt = new Date().toISOString();

async function start() {
  const child = spawn(process.execPath, ['--env-file-if-exists=.env.local', 'src/server.js'], {
    cwd: checkout, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  children.add(child);
  let output = '';
  const base = await new Promise((accept, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start within 15 seconds.')), 15000);
    const finish = (error, url) => {
      clearTimeout(timeout);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      child.stdout.removeListener('data', onOutput);
      if (error) reject(error); else accept(url);
    };
    const onError = error => finish(error);
    const onExit = code => finish(new Error(`Server exited during startup (${code}).`));
    const onOutput = chunk => {
      output += chunk.toString();
      const url = /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0];
      if (url) finish(null, url);
    };
    child.once('error', onError);
    child.once('exit', onExit);
    child.stdout.on('data', onOutput);
    child.stderr.resume();
  });
  return { child, base };
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const force = setTimeout(() => child.kill('SIGKILL'), 5000);
  child.kill('SIGTERM');
  try { await exited; } finally { clearTimeout(force); children.delete(child); }
}

async function json(base, path, { method = 'GET', body, admin = false, status = 200 } = {}) {
  const response = await fetch(base + path, { method, signal: AbortSignal.timeout(30000),
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(admin ? { 'X-Admin-Token': adminToken } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal(response.status, status, `${method} ${path}`);
  return response.json();
}

try {
  for (const entry of ['package.json', 'src', 'data', 'public']) {
    await cp(join(root, entry), join(checkout, entry), { recursive: true });
  }
  let server = await start();
  assert.deepEqual(await json(server.base, '/api/health'), { ok: true, aiConfigured: false });
  for (const path of ['/', '/citizens.html', '/mayor.html']) {
    const response = await fetch(server.base + path, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, path);
    assert.match(await response.text(), /<!doctype html>/i);
  }
  checks.push('clean Node entry point, no npm install, no credentials, all three pages');

  const baseline = await json(server.base, '/api/baseline');
  assert.ok(Math.abs(baseline.score - 52.55768) < 1e-8);
  const scenario = { decisions: [{ measureId: 'M7', districtId: 'nura' },
    { measureId: 'M8', districtId: 'nura' }, { measureId: 'M10', districtId: 'nura' },
    { measureId: 'M12' }, { measureId: 'M5', districtId: 'saryarka' }] };
  const calculation = await json(server.base, '/api/simulate', { method: 'POST', body: scenario });
  assert.equal(calculation.valid, true);
  assert.equal(calculation.totalCost, 95);
  assert.ok(Math.abs(calculation.score - 56.54307) < 1e-8);
  const explanation = await json(server.base, '/api/explain', { method: 'POST', body: scenario });
  assert.equal(explanation.mode, 'deterministic');
  assert.equal(explanation.available, false);
  assert.equal(explanation.reason, 'not_configured');
  const invalid = await json(server.base, '/api/simulate', { method: 'POST', body: { decisions: [] }, status: 422 });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.score, undefined);
  checks.push('official calculation: cost 95, baseline 52.55768, score 56.54307; explicit offline explanation');

  const receipt = await json(server.base, '/api/complaints', { method: 'POST', status: 201,
    body: { text: 'Синтетическая проверка: яма возле учебной остановки.',
      address: 'Учебная улица 42', districtId: 'nura', consent: true } });
  assert.ok(receipt.trackingToken.length >= 24);
  assert.equal(receipt.complaint.status, 'new');
  await json(server.base, '/api/complaints', { status: 401 });
  const list = await json(server.base, '/api/complaints', { admin: true });
  assert.equal(list.complaints.length, 1);
  const tracking = { id: receipt.complaint.id, trackingToken: receipt.trackingToken };
  await json(server.base, '/api/complaints/track', { method: 'POST',
    body: { ...tracking, trackingToken: 'incorrect-synthetic-code' }, status: 404 });
  await json(server.base, `/api/complaints/${tracking.id}`, { method: 'PATCH', admin: true,
    body: { status: 'resolved', assignee: 'Учебная служба', resolution: 'Учебная проверка завершена.' } });
  const tracked = await json(server.base, '/api/complaints/track', { method: 'POST', body: tracking });
  assert.equal(tracked.complaint.status, 'resolved');
  assert.equal(tracked.complaint.text, undefined);
  assert.equal(tracked.complaint.address, undefined);
  assert.equal(tracked.complaint.trackingToken, undefined);
  const stored = JSON.parse(await readFile(complaintsFile, 'utf8'));
  assert.equal(stored.complaints.length, 1);
  checks.push('web complaint → receipt → protected staff resolution → private status; data saved outside public');

  await stop(server.child);
  server = await start();
  const afterRestart = await json(server.base, '/api/complaints/track', { method: 'POST', body: tracking });
  assert.deepEqual(afterRestart, tracked);
  assert.equal((await json(server.base, '/api/complaints', { admin: true })).complaints.length, 1);
  assert.equal((await json(server.base, '/api/health')).aiConfigured, false);
  checks.push('real process restart preserves complaint, resolution and the original receipt');
  await stop(server.child);
  console.log(JSON.stringify({ ok: true, startedAt, node: process.version, checks,
    externalRequests: false, data: 'synthetic temporary data; removed after check' }, null, 2));
} finally {
  await Promise.all([...children].map(stop));
  // Delete only the directory created above directly under the OS temporary directory.
  assert.equal(resolve(dirname(scratch)), resolve(tmpdir()));
  assert.match(relative(tmpdir(), scratch), /^ascension-self-host-[^/\\]+$/);
  await rm(scratch, { recursive: true, force: true });
}
