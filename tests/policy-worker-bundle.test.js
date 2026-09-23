import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { simulate } from '../src/core/simulator.js';
import { buildPolicyOptions } from '../src/core/policy-options.js';

const root = new URL('../', import.meta.url);
const example = { decisions: [
  { measureId: 'M7', districtId: 'nura' }, { measureId: 'M8', districtId: 'nura' },
  { measureId: 'M10', districtId: 'nura' }, { measureId: 'M12' },
  { measureId: 'M5', districtId: 'saryarka' },
] };
const hash = text => createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex');

test('committed browser bundle matches the current shared source hashes without installing dev packages', async () => {
  const manifest = JSON.parse(await readFile(new URL('docs/evidence/policy-worker-build.json', root), 'utf8'));
  assert.equal(manifest.builder, 'esbuild@0.28.2');
  assert.deepEqual(Object.keys(manifest.inputs), [
    'data/city.json', 'src/browser/policy-options-worker.js',
    'src/core/policy-options.js', 'src/core/simulator.js',
  ]);
  for (const [path, expected] of Object.entries(manifest.inputs)) {
    assert.equal(hash(await readFile(new URL(path, root), 'utf8')), expected, `${path} requires a rebuild`);
  }
  assert.equal(hash(await readFile(new URL(manifest.output.path, root), 'utf8')), manifest.output.sha256);
});

function search(data) {
  // Execute the actual committed bundle in an isolated JS thread with the browser messaging API.
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
    import { parentPort } from 'node:worker_threads';
    globalThis.self = {
      addEventListener(type, listener) { parentPort.on(type, data => listener({ data })); },
      postMessage(data) { parentPort.postMessage(data); }
    };
    await import(${JSON.stringify(new URL('../public/policy-options-worker.js', import.meta.url).href)});
  `)}`));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('Worker timed out')); }, 3000);
    worker.once('error', error => { clearTimeout(timer); worker.terminate(); reject(error); });
    worker.once('message', value => { clearTimeout(timer); worker.terminate(); resolve(value); });
    worker.postMessage(data);
  });
}

test('real browser bundle produces the shared one-decision frontier and server-valid choices', async () => {
  const response = await search({ requestId: 'official-A', scenario: example, limit: 6 });
  assert.equal(response.requestId, 'official-A');
  assert.deepEqual(response.data, buildPolicyOptions(example));
  assert.equal(response.data.explored, 181);
  assert.equal(response.data.validCandidates, 117);
  assert.equal(response.data.options.length, 5);
  for (const option of response.data.options) assert.deepEqual(option.result, simulate(option.scenario));
});

test('real bundle rejects an invalid input instead of proposing alternatives', async () => {
  const response = await search({ requestId: 'invalid', scenario: { decisions: example.decisions.slice(0, 4) } });
  assert.equal(response.data.valid, false);
  assert.equal(response.data.explored, 0);
  assert.deepEqual(response.data.options, []);
});
