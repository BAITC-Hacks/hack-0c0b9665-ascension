import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createScenarioViewTransfer, scenarioViewDestination } from '../public/scenario-view-transfer.js';
import { validateScenario } from '../src/core/simulator.js';

const origin = 'https://example.test';
const demo = [
  { measureId: 'M7', districtId: 'nura' }, { measureId: 'M8', districtId: 'nura' },
  { measureId: 'M10', districtId: 'nura' }, { measureId: 'M12' },
  { measureId: 'M5', districtId: 'saryarka' },
];
const city = { cityId: 'astana', hasScenarioData: true };
function setup() {
  const items = new Map();
  const storage = { getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value), removeItem: key => items.delete(key) };
  let time = 100000;
  return { items, storage, transfer: createScenarioViewTransfer({ storage: () => storage, now: () => time }), setTime(value) { time = value; } };
}
const link = (href, extra = {}) => ({ href, target: '', hasAttribute: () => false, ...extra });

test('only same-tab same-origin simulator view changes qualify', () => {
  for (const path of ['/index.html', '/command-center.html', '/classic.html']) {
    assert.equal(scenarioViewDestination(link(origin + path), origin + '/'), path);
    assert.equal(scenarioViewDestination(link(origin + '/'), origin + path), '/');
  }
  for (const href of [origin + '/#workspace', origin + '/citizens.html', origin + '/mayor.html', 'https://other.test/classic.html']) {
    assert.equal(scenarioViewDestination(link(href), origin + '/'), null);
  }
  for (const event of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) {
    assert.equal(scenarioViewDestination(link(origin + '/classic.html'), origin + '/', event), null);
  }
  assert.equal(scenarioViewDestination(link(origin + '/classic.html', { target: '_blank' }), origin + '/'), null);
  assert.equal(scenarioViewDestination(link(origin + '/classic.html', { hasAttribute: () => true }), origin + '/'), null);
});

test('one-shot transfer copies only decisions and revalidates both partial and complete plans', async () => {
  for (const decisions of [demo.slice(0, 1), demo]) {
    const { transfer, items } = setup();
    transfer.save({ ...city, destination: '/classic.html', decisions: decisions.map(d => ({ ...d, score: 999, ai: 'untrusted text' })), score: 999 });
    assert.doesNotMatch([...items.values()][0], /score|999|untrusted/);
    let applied;
    const restore = () => transfer.restore({ ...city, currentHref: origin + '/classic.html', applyDecisions: async input => {
      const validation = validateScenario({ decisions: input });
      assert.equal(validation.totalCost, decisions.length === 5 ? 95 : 24);
      assert.equal(validation.errors.filter(error => error.code !== 'DECISION_COUNT').length, 0);
      applied = input;
      return true;
    } });
    assert.equal((await restore()).status, 'imported');
    assert.deepEqual(applied, decisions);
    assert.equal(items.size, 0);
    assert.equal((await restore()).status, 'none');
  }
});

test('empty pages, other cities and other destination routes do not overwrite or consume a handoff', async () => {
  const { transfer, items } = setup();
  transfer.save({ ...city, destination: '/classic.html', decisions: demo });
  const saved = [...items.values()][0];
  assert.equal(transfer.save({ ...city, destination: '/', decisions: [] }), false);
  assert.equal(transfer.save({ ...city, cityId: 'almaty-city', destination: '/', decisions: demo }), false);
  assert.equal(transfer.save({ ...city, hasScenarioData: false, destination: '/', decisions: demo }), false);
  const applyDecisions = () => assert.fail('Must not apply to another route or city');
  assert.equal((await transfer.restore({ ...city, currentHref: origin + '/', applyDecisions })).status, 'none');
  assert.equal((await transfer.restore({ ...city, cityId: 'almaty-city', currentHref: origin + '/classic.html', applyDecisions })).status, 'none');
  assert.equal([...items.values()][0], saved);
});

test('malformed, excessive, future and expired handoffs are removed without application', async () => {
  for (const corrupt of [
    () => '{', () => 'x'.repeat(2049),
    p => JSON.stringify({ ...p, decisions: [...demo, demo[0]] }),
    p => JSON.stringify({ ...p, createdAt: 100001 }),
    p => JSON.stringify({ ...p, createdAt: 100000 - 1800001 }),
    p => JSON.stringify({ ...p, cityId: 'almaty-city' }),
    p => JSON.stringify({ ...p, decisions: [{ measureId: '<script>' }] }),
  ]) {
    const { transfer, items } = setup();
    transfer.save({ ...city, destination: '/classic.html', decisions: demo });
    const [key, raw] = [...items][0];
    items.set(key, corrupt(JSON.parse(raw)));
    const outcome = await transfer.restore({ ...city, currentHref: origin + '/classic.html', applyDecisions: () => assert.fail('Invalid payload applied') });
    assert.equal(outcome.status, 'error');
    assert.equal(items.size, 0);
  }
});

test('server validation rejects unknown measures, incompatibilities and budget excess after transfer', async () => {
  for (const decisions of [
    [{ measureId: 'UNKNOWN' }, ...demo.slice(1)],
    [{ measureId: 'M1', districtId: 'nura' }, { measureId: 'M3', districtId: 'esil' }, ...demo.slice(2)],
    demo.map(d => d.measureId === 'M10' ? { measureId: 'M13', districtId: 'nura' } : d),
  ]) {
    const { transfer } = setup();
    transfer.save({ ...city, destination: '/classic.html', decisions });
    let committed = false;
    const outcome = await transfer.restore({ ...city, currentHref: origin + '/classic.html', applyDecisions: async input => {
      const validation = validateScenario({ decisions: input });
      if (!validation.valid) return false;
      committed = true;
      return true;
    } });
    assert.equal(outcome.status, 'rejected');
    assert.equal(committed, false);
  }
});

test('storage write failure throws and a failed cleanup warns after a successful transfer', async () => {
  const { transfer, storage } = setup();
  const save = () => transfer.save({ ...city, destination: '/classic.html', decisions: demo });
  const set = storage.setItem;
  storage.setItem = () => { throw new Error('quota'); };
  assert.throws(save, /quota/);
  storage.setItem = set;
  save();
  storage.removeItem = () => { throw new Error('denied'); };
  const outcome = await transfer.restore({ ...city, currentHref: origin + '/classic.html', applyDecisions: async () => true });
  assert.equal(outcome.status, 'imported');
  assert.match(outcome.warning, /копию удалить не удалось/);
});

test('temporary validation failure keeps the handoff for an explicit reload retry', async () => {
  const { transfer, items } = setup();
  transfer.save({ ...city, destination: '/classic.html', decisions: demo });
  const input = { ...city, currentHref: origin + '/classic.html' };
  assert.equal((await transfer.restore({ ...input, applyDecisions: async () => false })).status, 'rejected');
  assert.equal(items.size, 1);
  let retried;
  assert.equal((await transfer.restore({ ...input, applyDecisions: async decisions => { retried = decisions; return true; } })).status, 'imported');
  assert.deepEqual(retried, demo);
  assert.equal(items.size, 0);
});

test('the app cancels navigation visibly when storage fails or validation is pending', async () => {
  const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const start = source.indexOf("document.addEventListener('click', (event) => {\n  const destination");
  const end = source.indexOf('\nfunction renderResult', start);
  assert.ok(start >= 0 && end > start);
  for (const busy of [false, true]) {
    let handler, prevented = false, opened = false, message;
    runInNewContext(source.slice(start, end), {
      document: { addEventListener: (_, listener) => { handler = listener; } },
      scenarioViewDestination, location: { href: origin + '/' },
      state: { dataset: {}, decisions: demo, busy, hasScenarioData: true }, currentCity: { id: 'astana' },
      viewTransfer: { save() { throw new Error('Storage denied'); } },
      commandCenter: { openPanel(name) { opened = name === 'workspace'; } },
      showErrors: errors => { message = errors.join(' '); },
    });
    handler({ button: 0, target: { closest: () => link(origin + '/classic.html') }, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(opened, true);
    assert.match(message, /Переход отменён/);
  }
});
