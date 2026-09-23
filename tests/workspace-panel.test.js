import test from 'node:test';
import assert from 'node:assert/strict';
import { mountTeamWorkspace } from '../public/team-workspace.js';

class Element extends EventTarget {
  constructor(tag, document) {
    super(); Object.assign(this, { tagName: tag, ownerDocument: document, children: [], className: '', ownText: '', attributes: {}, value: '', disabled: false });
  }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.ownText = ''; this.append(...nodes); }
  remove() { this.parent.children = this.parent.children.filter((node) => node !== this); }
  setAttribute(key, value) { this.attributes[key] = value; }
  get textContent() { return this.ownText + this.children.map((node) => node.textContent).join(' '); }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  focus() {}
}
const all = (node) => [node, ...node.children.flatMap(all)];
const wait = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(data) });
const documentValue = (tag = 'initial') => ({ schemaVersion: 2, registers: [{ id: tag }] });
const session = (role = 'editor', name = 'Оператор') => ({ enabled: true, identity: { id: 'operator', name, role }, expiresAt: '2026-09-23T15:00:00Z' });

function setup(handler, options = {}) {
  const downloads = [];
  const view = { Blob, URL: { createObjectURL: (blob) => { downloads.push(blob); return 'blob:local-backup'; }, revokeObjectURL: () => {} } };
  const document = { defaultView: view, createElement: (tag) => new Element(tag, document) };
  const container = new Element('div', document);
  const calls = [];
  let local = documentValue();
  let applied = 0;
  const mount = mountTeamWorkspace(container, {
    getDocument: () => local,
    applyDocument: (data) => { local = data; applied += 1; },
    fetcher: async (url, init) => { calls.push({ url, ...init }); return handler(url, init); }, ...options,
  });
  const find = (name) => all(container).find((element) => element.className.split(' ').includes(`team-workspace-${name}`));
  return { mount, container, calls, find, downloads, get local() { return local; }, set local(value) { local = value; }, get applied() { return applied; } };
}

test('mount only checks session; replacement is explicit and publication carries the received revision', async () => {
  const shared = documentValue('shared');
  const ui = setup((url, init) => response(url.endsWith('session') ? session() : { revision: init.method === 'PUT' ? 3 : 2, document: shared }));
  await wait();
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0].method, 'GET');
  assert.equal(ui.find('publish').disabled, true);
  ui.find('pull').click(); await wait();
  assert.equal(ui.calls.length, 2);
  assert.equal(ui.applied, 0);
  assert.deepEqual(ui.local, documentValue());
  assert.equal(ui.find('confirmation').hidden, false);
  ui.find('backup').click();
  assert.equal(ui.downloads.length, 1);
  assert.deepEqual(JSON.parse(await ui.downloads[0].text()), documentValue());
  ui.find('replace').click(); await wait();
  assert.equal(ui.applied, 1);
  assert.deepEqual(ui.local, shared);
  assert.equal(ui.find('publish').disabled, false);
  ui.local = documentValue('edited');
  ui.find('publish').click(); await wait();
  assert.deepEqual(JSON.parse(ui.calls[2].body), { expectedRevision: 2, document: documentValue('edited') });
  assert.equal(ui.calls[2].credentials, 'same-origin');
  assert.equal(ui.calls[2].redirect, 'error');
  assert.equal(ui.applied, 1, 'publishing must never replace later local edits');
  ui.mount.dispose();
});

test('a conflict preserves local edits and requires a fresh pull before publishing again', async () => {
  const ui = setup((url, init) => init.method === 'PUT' ? response({}, 409) : response(url.endsWith('session') ? session() : { revision: 2, document: documentValue('shared') }));
  await wait(); ui.find('pull').click(); await wait(); ui.find('replace').click(); await wait();
  ui.local = documentValue('private-edit');
  ui.find('publish').click(); await wait();
  assert.deepEqual(ui.local, documentValue('private-edit'));
  assert.equal(ui.find('publish').disabled, true);
  assert.match(ui.find('message').textContent, /Конфликт версий/);
  const calls = ui.calls.length;
  ui.find('publish').click(); await wait();
  assert.equal(ui.calls.length, calls);
  ui.mount.dispose();
});

test('viewer may receive and inspect but cannot publish', async () => {
  const ui = setup((url) => response(url.endsWith('session') ? session('viewer') : { revision: 0, document: { schemaVersion: 2, registers: [] } }));
  await wait(); ui.find('pull').click(); await wait(); ui.find('replace').click(); await wait();
  assert.equal(ui.find('publish').disabled, true);
  assert.equal(ui.find('audit').disabled, false);
  assert.match(ui.find('identity').textContent, /Просмотр/);
  ui.mount.dispose();
});

test('disabled server can recover to login; access key clears immediately and never enters UI messages', async () => {
  let count = 0;
  const ui = setup((_url, init) => ++count === 1 ? response({}, 503) : init.method === 'POST' ? response(session()) : response({}, 401));
  await wait();
  assert.match(ui.find('identity').textContent, /выключено/);
  ui.find('refresh').click(); await wait();
  assert.equal(ui.find('login').hidden, false);
  ui.find('key').value = 'temporary-test-key';
  ui.find('login').dispatchEvent(new Event('submit', { cancelable: true }));
  assert.equal(ui.find('key').value, '');
  await wait();
  assert.equal(JSON.parse(ui.calls[2].body).accessKey, 'temporary-test-key');
  assert.doesNotMatch(ui.container.textContent, /temporary-test-key/);
  assert.equal(ui.find('publish').disabled, true);
  ui.mount.dispose();
});

test('local edits made during a pull are not overwritten', async () => {
  const pending = deferred();
  const ui = setup((url) => url.endsWith('session') ? response(session()) : pending.promise);
  await wait(); ui.find('pull').click();
  ui.local = documentValue('edited-while-loading');
  pending.resolve(response({ revision: 4, document: documentValue('remote') })); await wait();
  assert.equal(ui.applied, 0);
  assert.deepEqual(ui.local, documentValue('edited-while-loading'));
  assert.equal(ui.find('publish').disabled, true);
  assert.match(ui.find('message').textContent, /Локальный реестр не изменён/);
  assert.equal(ui.find('confirmation').hidden, false);
  ui.mount.dispose();
});

test('dispose aborts an in-flight pull and ignores a fetcher that still resolves', async () => {
  const pending = deferred();
  const ui = setup((url) => url.endsWith('session') ? response(session()) : pending.promise);
  await wait(); ui.find('pull').click();
  const signal = ui.calls[1].signal;
  ui.mount.dispose();
  assert.equal(signal.aborted, true);
  pending.resolve(response({ revision: 4, document: documentValue('remote') })); await wait();
  assert.equal(ui.applied, 0);
  assert.equal(ui.container.children.length, 0);
});

test('missing hooks and rejected local validation never publish or replace a document', async () => {
  const ui = setup(() => response(session()), { getDocument: undefined, applyDocument: undefined });
  await wait();
  assert.equal(ui.find('pull').disabled, true);
  assert.equal(ui.find('publish').disabled, true);
  assert.equal(ui.find('backup').disabled, true);
  ui.mount.dispose();
  const rejected = setup((url) => response(url.endsWith('session') ? session() : { revision: 4, document: documentValue('remote') }), { applyDocument: () => { throw new Error('Invalid local schema'); } });
  await wait(); rejected.find('pull').click(); await wait(); rejected.find('replace').click(); await wait();
  assert.deepEqual(rejected.local, documentValue());
  assert.equal(rejected.find('publish').disabled, true);
  rejected.mount.dispose();
});

test('untrusted identity and audit values stay text; logout preserves local draft', async () => {
  const unsafe = '<img src=x onerror=alert(1)>';
  const ui = setup((url, init) => init.method === 'DELETE' ? response(null, 204) : response(url.endsWith('session') ? session('owner', unsafe) : { entries: [{ revision: 2, at: '2026-09-23T11:00:00Z', actor: session('editor', unsafe).identity, summary: { registers: 1, actions: 5 } }] }));
  await wait(); ui.find('audit').click(); await wait();
  assert.ok(ui.container.textContent.includes(unsafe));
  assert.equal(all(ui.container).some(({ tagName }) => tagName === 'img'), false);
  ui.find('logout').click(); await wait();
  assert.deepEqual(ui.local, documentValue());
  assert.equal(ui.find('publish').disabled, true);
  assert.equal(ui.find('login').hidden, false);
  ui.mount.dispose();
});

test('ambiguous publication failure blocks repeat publication and preserves the local document', async () => {
  const ui = setup((url, init) => {
    if (init.method === 'PUT') throw new Error('offline');
    return response(url.endsWith('session') ? session() : { revision: 1, document: documentValue('shared') });
  });
  await wait(); ui.find('pull').click(); await wait(); ui.find('replace').click(); await wait();
  ui.local = documentValue('edited'); ui.find('publish').click(); await wait();
  assert.equal(ui.find('publish').disabled, true);
  assert.deepEqual(ui.local, documentValue('edited'));
  ui.mount.dispose();
});

test('first publication can preserve existing local work after explicit whole-register replacement acknowledgement', async () => {
  const ui = setup((url, init) => response(url.endsWith('session') ? session() : {
    revision: init.method === 'PUT' ? 1 : 0,
    document: init.method === 'PUT' ? documentValue('initial') : { schemaVersion: 2, registers: [] },
  }));
  await wait(); ui.find('pull').click(); await wait();
  assert.equal(ui.applied, 0);
  assert.equal(ui.find('keep').disabled, true);
  assert.equal(ui.find('publish').disabled, true);
  ui.find('acknowledge').checked = true;
  ui.find('acknowledge').dispatchEvent(new Event('change'));
  assert.equal(ui.find('keep').disabled, false);
  ui.find('keep').click();
  assert.deepEqual(ui.local, documentValue('initial'));
  assert.equal(ui.applied, 0);
  assert.equal(ui.find('publish').disabled, false);
  assert.match(ui.find('message').textContent, /целиком заменят общую версию 0/);
  ui.find('publish').click(); await wait();
  assert.deepEqual(JSON.parse(ui.calls[2].body), { expectedRevision: 0, document: documentValue('initial') });
  assert.equal(ui.applied, 0);
  ui.mount.dispose();
});

test('viewer cannot keep a local document for publication even after acknowledging the warning', async () => {
  const ui = setup((url) => response(url.endsWith('session') ? session('viewer') : { revision: 0, document: { schemaVersion: 2, registers: [] } }));
  await wait(); ui.find('pull').click(); await wait();
  ui.find('acknowledge').checked = true;
  ui.find('acknowledge').dispatchEvent(new Event('change'));
  assert.equal(ui.find('keep').disabled, true);
  assert.equal(ui.find('publish').disabled, true);
  assert.deepEqual(ui.local, documentValue());
  ui.mount.dispose();
});
