import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createTelegramWebhookClient, runTelegramWebhookCommand, telegramWebhookEndpoint } from '../src/telegram-webhook.js';
import { createAppServer } from '../src/server.js';

const TOKEN = '123456:synthetic_token_for_webhook_tests';
const SECRET = 'synthetic_webhook_secret';
const ORIGIN = 'https://host.example';
const ENDPOINT = `${ORIGIN}/api/telegram/webhook`;
const BOT = { id: 123456, is_bot: true, username: 'ascension_test_bot' };
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

function harness({ overrides = {}, webhookUrl = '' } = {}) {
  const calls = [];
  let state = { url: webhookUrl, pending_update_count: 4 };
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    const method = parsed.pathname.split('/').at(-1);
    const key = parsed.host === 'api.telegram.org' ? method : parsed.pathname;
    calls.push({ key, url, options, body: options.body ? JSON.parse(options.body) : undefined });
    if (Object.hasOwn(overrides, key)) return overrides[key](calls.at(-1));
    if (key === 'getMe') return json({ ok: true, result: BOT });
    if (key === 'getWebhookInfo') return json({ ok: true, result: state });
    if (key === 'setWebhook') { state = { ...state, url: ENDPOINT, max_connections: 1, allowed_updates: ['message'] }; return json({ ok: true, result: true }); }
    if (key === 'deleteWebhook') { state = { ...state, url: '' }; return json({ ok: true, result: true }); }
    if (key === '/api/health') return json({ ok: true });
    if (key === '/api/citizen/config') return json({ adminConfigured: true, telegramUrl: `https://t.me/${BOT.username}` });
    if (key === '/api/telegram/webhook') return json({ ok: true });
    throw new Error(`Unexpected request: ${key}`);
  };
  return { calls, fetchImpl, client: createTelegramWebhookClient({ token: TOKEN, fetchImpl }) };
}

test('webhook endpoint accepts HTTPS origins and rejects paths, credentials, queries and unsupported ports', () => {
  for (const input of [ORIGIN, `${ORIGIN}/`, `${ORIGIN}:443`]) assert.equal(telegramWebhookEndpoint(input), ENDPOINT);
  assert.equal(telegramWebhookEndpoint(`${ORIGIN}:8443`), `${ORIGIN}:8443/api/telegram/webhook`);
  for (const input of ['', undefined, 'not a URL', 'http://host.example', 'https://user:private@host.example', `${ORIGIN}/secret`, `${ORIGIN}?token=private`, `${ORIGIN}#private`, `${ORIGIN}:3000`]) {
    assert.throws(() => telegramWebhookEndpoint(input), error => {
      assert.match(error.message, /PUBLIC_BASE_URL/u);
      assert.doesNotMatch(error.message, /private|host\.example/u);
      return true;
    });
  }
});

test('info returns only safe bot identity and delivery fields, never the configured URL or Telegram error', async () => {
  const { client, calls } = harness({ overrides: {
    getWebhookInfo: () => json({ ok: true, result: { url: 'https://secret.example/private-token?secret=private-value', pending_update_count: 7,
      max_connections: 1, last_error_message: `Failed URL with ${TOKEN}`, secret_token: SECRET } }),
  } });
  assert.deepEqual(await client.info(), { botId: BOT.id, botUsername: BOT.username, webhookConfigured: true, pendingUpdateCount: 7, maxConnections: 1, hasDeliveryError: true });
  for (const call of calls) {
    assert.equal(new URL(call.url).host, 'api.telegram.org');
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.redirect, 'error');
    assert.ok(call.options.signal instanceof AbortSignal);
  }
});

test('set verifies server readiness and authentication before changing Telegram, keeps pending updates and confirms configuration', async () => {
  const { client, calls } = harness();
  const result = await client.set({ publicBaseUrl: ORIGIN, webhookSecret: SECRET });
  assert.equal(result.configured, true);
  assert.equal(result.pendingUpdateCount, 4);
  assert.deepEqual(calls.map(call => call.key), ['getMe', '/api/health', '/api/citizen/config', '/api/telegram/webhook', 'setWebhook', 'getWebhookInfo']);
  assert.equal(calls[3].options.headers['X-Telegram-Bot-Api-Secret-Token'], SECRET);
  assert.deepEqual(calls[3].body, {});
  assert.deepEqual(calls[4].body, { url: ENDPOINT, secret_token: SECRET, max_connections: 1, allowed_updates: ['message'], drop_pending_updates: false });
  for (const call of calls) {
    assert.equal(call.options.redirect, 'error');
    assert.ok(call.options.signal instanceof AbortSignal);
  }
  assert.doesNotMatch(JSON.stringify(result), /https:|synthetic_|secret_token/u);
});

test('set validates local configuration before making any request', async () => {
  const { client, calls } = harness();
  for (const secret of ['', 'has space', 'bad/slash', 'a'.repeat(257), undefined]) {
    await assert.rejects(client.set({ publicBaseUrl: ORIGIN, webhookSecret: secret }), /TELEGRAM_WEBHOOK_SECRET/u);
  }
  await assert.rejects(client.set({ publicBaseUrl: 'http://host.example', webhookSecret: SECRET }), /PUBLIC_BASE_URL/u);
  assert.equal(calls.length, 0);
  for (const token of ['', undefined, 'bogus', '123:too_short']) assert.throws(() => createTelegramWebhookClient({ token }), /TELEGRAM_BOT_TOKEN/u);
});

test('set leaves existing webhook unchanged when health, admin, bot identity or deployed secret is wrong', async () => {
  for (const overrides of [
    { '/api/health': () => json({ ok: false }) },
    { '/api/health': () => new Response('secret error', { status: 503 }) },
    { '/api/citizen/config': () => json({ adminConfigured: false, telegramUrl: `https://t.me/${BOT.username}` }) },
    { '/api/citizen/config': () => json({ adminConfigured: true, telegramUrl: 'https://t.me/another_bot' }) },
    { '/api/citizen/config': () => json({ adminConfigured: true, telegramUrl: null }) },
    { '/api/telegram/webhook': () => new Response(`secret ${SECRET}`, { status: 401 }) },
    { '/api/telegram/webhook': () => json({ ok: false }) },
  ]) {
    const { client, calls } = harness({ overrides, webhookUrl: 'https://old.example/private' });
    await assert.rejects(client.set({ publicBaseUrl: ORIGIN, webhookSecret: SECRET }), error => {
      assert.doesNotMatch(error.message, /synthetic_|old\.example|host\.example|https:/u);
      return true;
    });
    assert.equal(calls.some(call => ['setWebhook', 'deleteWebhook'].includes(call.key)), false);
  }
});

test('delete preserves the Telegram queue and verifies that polling is available', async () => {
  const { client, calls } = harness({ webhookUrl: 'https://old.example/private' });
  assert.deepEqual(await client.delete(), { webhookConfigured: false, pendingUpdateCount: 4, maxConnections: null, hasDeliveryError: false, deleted: true });
  assert.deepEqual(calls.map(call => call.key), ['deleteWebhook', 'getWebhookInfo']);
  assert.deepEqual(calls[0].body, { drop_pending_updates: false });
});

test('polling preflight stops for active webhook with an actionable safe message', async () => {
  const { client, calls } = harness({ webhookUrl: 'https://old.example/private' });
  await assert.rejects(client.assertPollingAvailable(), error => {
    assert.match(error.message, /npm run bot:webhook -- delete/u);
    assert.doesNotMatch(error.message, /old\.example|private|https:/u);
    return true;
  });
  assert.deepEqual(calls.map(call => call.key), ['getWebhookInfo']);
  const local = harness();
  assert.equal((await local.client.assertPollingAvailable()).webhookConfigured, false);
});

test('successful API acknowledgement alone does not confirm webhook changes', async () => {
  for (const state of [
    { url: 'https://wrong.example/private', max_connections: 1, allowed_updates: ['message'] },
    { url: ENDPOINT, max_connections: 40, allowed_updates: ['message'] },
    { url: ENDPOINT, max_connections: 1, allowed_updates: ['callback_query'] },
  ]) {
    const { client } = harness({ overrides: { getWebhookInfo: () => json({ ok: true, result: { ...state, pending_update_count: 0 } }) } });
    await assert.rejects(client.set({ publicBaseUrl: ORIGIN, webhookSecret: SECRET }), /не подтвердил ожидаемую/u);
  }
  const { client } = harness({ overrides: { deleteWebhook: () => json({ ok: true, result: true }) }, webhookUrl: 'https://old.example/private' });
  await assert.rejects(client.delete(), /Webhook остаётся включённым/u);
});

test('network failures, redirects, API errors and malformed responses never expose credentials', async () => {
  const failures = [
    () => { throw new Error(`Request to https://api.telegram.org/bot${TOKEN}/getMe failed`); },
    () => new Response(JSON.stringify({ description: TOKEN }), { status: 401 }),
    () => json({ ok: false, description: TOKEN }),
    () => new Response(`invalid ${TOKEN}`),
    () => { const response = json({ ok: true, result: BOT }); Object.defineProperty(response, 'redirected', { value: true }); return response; },
    () => json({ ok: true, result: { ...BOT, username: TOKEN } }),
    () => new Response(TOKEN, { headers: { 'content-length': '1000000' } }),
    () => new Response('a'.repeat(65537)),
  ];
  for (const failRequest of failures) {
    const { client } = harness({ overrides: { getMe: failRequest } });
    await assert.rejects(client.info(), error => {
      assert.doesNotMatch(error.message, /123456|synthetic_|https:|api\.telegram\.org/u);
      return true;
    });
  }
});

test('CLI accepts only info, set and delete and prints only sanitized results', async () => {
  const { fetchImpl, calls } = harness({ webhookUrl: 'https://old.example/private' });
  const output = [];
  const options = { env: { TELEGRAM_BOT_TOKEN: TOKEN }, fetchImpl, log: value => output.push(value) };
  for (const args of [[], ['unknown'], ['info', TOKEN]]) await assert.rejects(runTelegramWebhookCommand({ ...options, args }), /Использование/u);
  assert.equal(calls.length, 0);
  await runTelegramWebhookCommand({ ...options, args: ['info'] });
  assert.equal(JSON.parse(output[0]).botUsername, BOT.username);
  assert.doesNotMatch(output.join(''), /synthetic_|old\.example|private|https:/u);
});

test('readiness probe reaches the real local HTTP contract without creating a complaint or sending a message', async t => {
  const effects = [];
  const unexpected = operation => async () => { effects.push(operation); throw new Error('Unexpected probe side effect'); };
  const server = createAppServer({ aiConfigured: () => false, complaints: {
    store: { create: unexpected('create'), get: unexpected('get'), track: unexpected('track') },
    transport: { sendMessage: unexpected('sendMessage') },
    adminToken: 'synthetic_admin', webhookSecret: SECRET, telegramToken: TOKEN, telegramUsername: BOT.username,
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const localBase = `http://127.0.0.1:${server.address().port}`;
  const telegram = harness();
  const client = createTelegramWebhookClient({ token: TOKEN, fetchImpl: (url, options) => {
    const parsed = new URL(url);
    return parsed.host === 'api.telegram.org' ? telegram.fetchImpl(url, options) : fetch(new URL(parsed.pathname, localBase), options);
  } });
  assert.equal((await client.set({ publicBaseUrl: ORIGIN, webhookSecret: SECRET })).configured, true);
  assert.deepEqual(effects, []);
  assert.deepEqual(telegram.calls.map(call => call.key), ['getMe', 'setWebhook', 'getWebhookInfo']);
});
