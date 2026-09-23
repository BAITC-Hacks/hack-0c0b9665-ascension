import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const citizenSource = await readFile(new URL('../public/citizen.js', import.meta.url), 'utf8');
const mayorSource = await readFile(new URL('../public/mayor.js', import.meta.url), 'utf8');
const goodConfig = { demoMode: true, adminConfigured: false, analysisMode: 'rules', telegramUrl: null };
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness(page, configResponse, listResponse = () => ({ ok: true, json: async () => ({ complaints: [] }) })) {
  const elements = new Map();
  const created = [];
  const requests = [];
  const timers = [];
  function element(id) {
    if (!elements.has(id)) {
      const listeners = new Map();
      elements.set(id, {
        id, listeners, value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
        checked: false, dataset: {}, isConnected: true,
        addEventListener(name, listener) { listeners.set(name, listener); },
        async fire(name) { return listeners.get(name)?.({ preventDefault() {}, currentTarget: this }); },
        after(node) { this.afterNode = node; }, setAttribute() {}, focus() {}, reset() {},
        requestSubmit() { return this.fire('submit'); },
        querySelectorAll(selector) {
          if (id === 'access-form' && selector === 'input, button[type="submit"]') return [element('admin-token'), element('connect-button')];
          return [];
        },
      });
    }
    return elements.get(id);
  }
  const context = {
    document: {
      body: { dataset: { page } }, getElementById: element,
      createElement: () => { const node = element(`created-${created.length}`); created.push(node); return node; },
    },
    window: { addEventListener() {}, dispatchEvent() {}, setInterval(callback, delay) { timers.push({ callback, delay }); } },
    navigator: {}, history: { replaceState() {} }, location: { hash: '', origin: 'https://example.test' },
    URL, URLSearchParams, AbortSignal, Intl, console,
    CustomEvent: class { constructor(type, details) { this.type = type; this.detail = details?.detail; } },
    FormData: class { *[Symbol.iterator]() {} },
    fetch: async (path, options = {}) => {
      requests.push({ path, method: options.method ?? 'GET' });
      if (path === '/api/citizen/config') return configResponse();
      if (path === '/api/complaints' && options.method === 'POST') {
        return { ok: true, json: async () => ({ complaint: { id: 'test-receipt', status: 'new', history: [] }, trackingToken: 'synthetic-tracking-code' }) };
      }
      if (path.startsWith('/api/complaints?')) return listResponse(options);
      assert.fail(`Unexpected request: ${path}`);
    },
  };
  runInNewContext(citizenSource.replace(/^export /gm, ''), context);
  if (page === 'mayor') {
    // The actual imports resolve to declarations already evaluated from citizen.js above.
    runInNewContext(`const esc = escapeHTML;\n${mayorSource.replace(/^import[^\r\n]*\r?\n/, '')}`, context);
  }
  return { context, element, created, requests, timers };
}

const jsonResponse = (value, status = 200) => ({ ok: status === 200, status, json: async () => value });

test('unsupported or unreachable complaints API blocks citizen intake and tracking without sending data', async () => {
  for (const response of [
    () => jsonResponse({ error: 'missing' }, 404),
    () => jsonResponse({ error: 'unavailable' }, 503),
    () => { throw new Error('network unavailable'); },
    () => jsonResponse({ ok: true }),
  ]) {
    const { element, requests, created } = harness('citizens', response);
    assert.equal(element('submit-button').disabled, true);
    await settle();
    assert.match(element('mode-note').textContent, /Приём обращений на этом сервере ещё недоступен/u);
    assert.equal(element('submit-button').disabled, true);
    assert.equal(element('tracking-button').disabled, true);
    assert.equal(element('telegram-link').hidden, true);
    assert.equal(created[0].hidden, false);
    await element('complaint-form').fire('submit');
    await element('tracking-form').fire('submit');
    assert.deepEqual(requests.map(item => item.path), ['/api/citizen/config']);
    assert.doesNotMatch(element('telegram-note').textContent, /Используйте форму|можно отправить через форму/u);
  }
});

test('successful retry enables the existing citizen submission and displays only a real mocked receipt', async () => {
  let ready = false;
  const { element, created, requests } = harness('citizens', () => ready
    ? jsonResponse(goodConfig) : jsonResponse({ error: 'missing' }, 404));
  await settle();
  element('complaint-text').value = 'Синтетическая проблема у остановки';
  element('consent').checked = true;
  ready = true;
  await created[0].fire('click');
  assert.equal(element('submit-button').disabled, false);
  assert.equal(element('tracking-button').disabled, false);
  await element('complaint-form').fire('submit');
  assert.equal(requests.filter(item => item.method === 'POST').length, 1);
  assert.equal(element('receipt-id').textContent, 'test-receipt');
  assert.equal(element('receipt').hidden, false);
});

test('unsupported mayor API disables login and blocks list, save and photo requests', async () => {
  const { context, element, requests } = harness('mayor', () => jsonResponse({ error: 'missing' }, 404));
  await settle();
  assert.equal(element('admin-token').disabled, true);
  assert.equal(element('connect-button').disabled, true);
  assert.match(element('admin-mode').textContent, /Приём обращений на этом сервере ещё недоступен/u);
  await element('access-form').fire('submit');
  await context.loadComplaints();
  await context.saveComplaint({ preventDefault() {} }, { id: 'synthetic-id' });
  const photo = element('synthetic-photo');
  await context.loadPhoto(photo, 'synthetic-id');
  assert.equal(photo.disabled, true);
  assert.deepEqual(requests.map(item => item.path), ['/api/citizen/config']);
});

test('valid Node capability response enables mayor login and loads the existing list', async () => {
  const { element, requests } = harness('mayor', () => jsonResponse(goodConfig));
  await settle();
  assert.equal(element('admin-token').disabled, false);
  assert.equal(element('connect-button').disabled, false);
  assert.deepEqual(requests.map(item => item.path), ['/api/citizen/config', '/api/complaints?']);
  assert.match(element('admin-mode').textContent, /Локальное демо/u);
});

test('hosted queue opens login, waits for authorization and receives new Telegram records automatically', async () => {
  const incoming = [];
  const { context, element, requests, timers } = harness('mayor', () => jsonResponse({ ...goodConfig, demoMode: false, adminConfigured: true }), options => {
    if (options.headers['X-Admin-Token'] !== 'synthetic-admin-key') return jsonResponse({ error: 'Unauthorized' }, 401);
    assert.equal(options.cache, 'no-store');
    return jsonResponse({ complaints: incoming });
  });
  await settle();
  assert.equal(element('access-details').open, true);
  assert.match(element('load-error').textContent, /Вход в кабинет/u);
  const beforeLogin = requests.length;
  assert.equal(timers[0].delay, 10000);
  timers[0].callback();
  await settle();
  assert.equal(requests.length, beforeLogin);
  element('admin-token').value = 'synthetic-admin-key';
  await element('access-form').fire('submit');
  await settle();
  assert.equal(element('access-details').open, false);
  assert.equal(element('admin-token').value, '');
  incoming.push({ id: 'TG-NEW', source: 'telegram', status: 'new', createdAt: '2026-09-23T12:00:00Z', updatedAt: '2026-09-23T12:00:00Z', analysis: { summary: 'Лампа во дворе не работает' } });
  timers[0].callback();
  await settle();
  assert.match(element('complaints-list').innerHTML, /TG-NEW/u);
  assert.equal(element('stat-new').textContent, 1);
  assert.match(element('sync-status').textContent, /10 секунд/u);
  context.document.hidden = true;
  const beforeHidden = requests.length;
  timers[0].callback();
  await settle();
  assert.equal(requests.length, beforeHidden);
});
