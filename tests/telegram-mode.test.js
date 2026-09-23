import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTelegramPollingAllowed, checkTelegramServer, createTelegramModeApi, formatTelegramModeStatus,
  runTelegramModeCommand, switchTelegramToHosted, switchTelegramToLocal, telegramServerUrl } from '../src/telegram-mode.js';
import { startTelegramPolling } from '../src/telegram-poll.js';

const TOKEN = '123456:synthetic_test_token_not_a_real_secret';
const SECRET = 'synthetic_webhook_secret';
const HOSTED = 'https://hosted.example';
const LOCAL = 'http://127.0.0.1:3000';
const ready = { telegramConfigured: true, webhookConfigured: true };
const json = value => Response.json(value);
const telegram = result => json({ ok: true, result });

test('mode API uses fixed Telegram host, POST, timeout and preserves all pending updates', async () => {
  const calls = [];
  const api = createTelegramModeApi({ token: TOKEN, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/getMe')) return telegram({ id: 123456, is_bot: true });
    if (url.endsWith('/getWebhookInfo')) return telegram({ url: '', pending_update_count: 0 });
    return telegram(true);
  } });
  await api.getMe();
  await api.getWebhookInfo();
  await api.setWebhook({ serverUrl: HOSTED, webhookSecret: SECRET });
  await api.deleteWebhook();
  assert.deepEqual(calls.map(call => new URL(call.url).pathname.split('/').at(-1)), ['getMe', 'getWebhookInfo', 'setWebhook', 'deleteWebhook']);
  for (const { url, options } of calls) {
    assert.equal(new URL(url).hostname, 'api.telegram.org');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
  }
  assert.deepEqual(JSON.parse(calls[2].options.body), { url: `${HOSTED}/api/telegram/webhook`, secret_token: SECRET,
    max_connections: 1, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
  assert.deepEqual(JSON.parse(calls[3].options.body), { drop_pending_updates: false });
});

test('mode API redacts network errors, upstream descriptions and rejects malformed responses', async () => {
  for (const fetchImpl of [
    async url => { throw new Error(`failed ${url} ${SECRET}`); },
    async () => new Response(JSON.stringify({ ok: false, description: `${TOKEN} ${SECRET}` }), { status: 401 }),
    async () => json({ ok: false, description: TOKEN }),
    async () => new Response('{bad json'),
    async () => new Response('x'.repeat(32769)),
  ]) {
    const api = createTelegramModeApi({ token: TOKEN, fetchImpl });
    await assert.rejects(api.getWebhookInfo(), error => {
      assert.equal(error.code, 'TELEGRAM_MODE_API');
      assert.ok(!error.stack.includes(TOKEN));
      assert.ok(!error.stack.includes(SECRET));
      return true;
    });
  }
  for (const result of [null, {}, { url: null }]) {
    const api = createTelegramModeApi({ token: TOKEN, fetchImpl: async () => telegram(result) });
    await assert.rejects(api.getWebhookInfo(), { code: 'TELEGRAM_MODE_RESPONSE' });
  }
  const malformed = createTelegramModeApi({ token: TOKEN, fetchImpl: async () => telegram({}) });
  await assert.rejects(malformed.getMe(), { code: 'TELEGRAM_MODE_RESPONSE' });
  await assert.rejects(malformed.deleteWebhook(), { code: 'TELEGRAM_MODE_RESPONSE' });
});

test('invalid token, host URL and secret are rejected before Telegram network access', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return telegram(true); };
  for (const token of ['', 'not-a-token', `${TOKEN}\n`]) {
    assert.throws(() => createTelegramModeApi({ token, fetchImpl }), { code: 'TELEGRAM_MODE_TOKEN' });
  }
  const api = createTelegramModeApi({ token: TOKEN, fetchImpl });
  for (const serverUrl of [undefined, LOCAL, 'https://localhost', 'http://hosted.example', `${HOSTED}/path`,
    'https://user:password@hosted.example', `${HOSTED}?secret=value`, `${HOSTED}#secret`]) {
    await assert.rejects(api.setWebhook({ serverUrl, webhookSecret: SECRET }), { code: 'TELEGRAM_MODE_URL' });
  }
  for (const webhookSecret of ['', 'secret with spaces', 'x'.repeat(257)]) {
    await assert.rejects(api.setWebhook({ serverUrl: HOSTED, webhookSecret }), { code: 'TELEGRAM_MODE_SECRET' });
  }
  assert.equal(calls, 0);
  assert.equal(telegramServerUrl(`${HOSTED}/`, { hosted: true }), HOSTED);
  assert.equal(telegramServerUrl('http://[::1]:3000', { localOnly: true }), 'http://[::1]:3000');
});

test('hosted switch verifies server configuration and matching secret before setting the webhook', async () => {
  const calls = [];
  const api = { async setWebhook(options) { calls.push({ method: 'setWebhook', options }); } };
  const result = await switchTelegramToHosted({ api, serverUrl: HOSTED, webhookSecret: SECRET,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return json(url.endsWith('/config') ? ready : { ok: true });
    } });
  assert.deepEqual(result, { mode: 'hosted', serverUrl: HOSTED });
  assert.equal(calls[0].url, `${HOSTED}/api/citizen/config`);
  assert.equal(calls[1].url, `${HOSTED}/api/telegram/webhook`);
  assert.equal(calls[1].options.headers['X-Telegram-Bot-Api-Secret-Token'], SECRET);
  assert.equal(calls[1].options.body, '{}');
  assert.equal(calls[2].method, 'setWebhook');
  assert.deepEqual(calls[2].options, { serverUrl: HOSTED, webhookSecret: SECRET });
  for (const { options } of calls.slice(0, 2)) {
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test('unavailable or unconfigured hosted and local servers do not change webhook registration', async () => {
  for (const hosted of [true, false]) {
    for (const config of [null, {}, { telegramConfigured: true }, { webhookConfigured: true },
      { telegramConfigured: false, webhookConfigured: true }]) {
      let mutations = 0;
      const api = { async setWebhook() { mutations++; }, async deleteWebhook() { mutations++; } };
      await assert.rejects((hosted ? switchTelegramToHosted : switchTelegramToLocal)({ api,
        serverUrl: hosted ? HOSTED : LOCAL, webhookSecret: SECRET, fetchImpl: async () => json(config) }), { code: 'TELEGRAM_MODE_SERVER' });
      assert.equal(mutations, 0);
    }
    for (const probe of [() => new Response('', { status: 401 }), () => json({ ok: false }), () => new Response('<html>')]) {
      let mutations = 0;
      const api = { async setWebhook() { mutations++; }, async deleteWebhook() { mutations++; } };
      await assert.rejects((hosted ? switchTelegramToHosted : switchTelegramToLocal)({ api,
        serverUrl: hosted ? HOSTED : LOCAL, webhookSecret: SECRET,
        fetchImpl: async url => url.endsWith('/config') ? json(ready) : probe() }), { code: 'TELEGRAM_MODE_SERVER' });
      assert.equal(mutations, 0);
    }
  }
});

test('preflight hides errors containing secret headers or private URLs', async () => {
  await assert.rejects(checkTelegramServer({ serverUrl: HOSTED, webhookSecret: SECRET,
    fetchImpl: async () => { throw new Error(`${HOSTED} ${SECRET}`); } }), error => {
      assert.equal(error.code, 'TELEGRAM_MODE_SERVER');
      assert.ok(!error.stack.includes(HOSTED));
      assert.ok(!error.stack.includes(SECRET));
      return true;
    });
});

test('local switch waits for a working local server before removing and verifying webhook', async () => {
  const calls = [];
  const api = {
    async deleteWebhook() { calls.push('delete'); },
    async getWebhookInfo() { calls.push('info'); return { url: '' }; },
  };
  assert.deepEqual(await switchTelegramToLocal({ api, serverUrl: LOCAL, webhookSecret: SECRET,
    fetchImpl: async url => { calls.push(url); return json(url.endsWith('/config') ? ready : { ok: true }); } }),
  { mode: 'local', serverUrl: LOCAL });
  assert.deepEqual(calls, [`${LOCAL}/api/citizen/config`, `${LOCAL}/api/telegram/webhook`, 'delete', 'info']);
  await assert.rejects(switchTelegramToLocal({ api, serverUrl: HOSTED, webhookSecret: SECRET,
    fetchImpl: () => assert.fail('must not fetch') }), { code: 'TELEGRAM_MODE_URL' });
});

test('default polling refuses an active webhook without fetching updates or deleting webhook', async () => {
  const calls = [];
  await assert.rejects(startTelegramPolling({ env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET },
    fetchImpl: async url => { calls.push(url.split('/').at(-1)); return telegram({ url: `${HOSTED}/api/telegram/webhook` }); },
    log: () => assert.fail('must not start') }), error => {
      assert.equal(error.code, 'TELEGRAM_WEBHOOK_ACTIVE');
      assert.match(error.message, /npm run bot:local/u);
      return true;
    });
  assert.deepEqual(calls, ['getWebhookInfo']);
  await assertTelegramPollingAllowed({ getWebhookInfo: async () => ({ url: '' }) });
  await assert.rejects(assertTelegramPollingAllowed({ getWebhookInfo: async () => ({}) }), { code: 'TELEGRAM_MODE_RESPONSE' });
});

test('status hides URL credentials, unknown paths, queries, fragments and upstream error descriptions', () => {
  const value = formatTelegramModeStatus({ url: `https://user:password@hosted.example/${SECRET}?token=${TOKEN}#private`,
    pending_update_count: 7, last_error_date: 123, last_error_message: `${SECRET} ${TOKEN}` }, { token: TOKEN, webhookSecret: SECRET });
  assert.match(value, /hosted\.example\/\[скрытый путь\]/u);
  assert.match(value, /обновлений: 7/u);
  assert.match(value, /ошибке доставки/u);
  assert.doesNotMatch(value, /user|password|token=|private/u);
  assert.ok(!value.includes(SECRET));
  assert.ok(!value.includes(TOKEN));
  assert.match(formatTelegramModeStatus({ url: `${HOSTED}/api/telegram/webhook` }), /\/api\/telegram\/webhook/u);
  assert.match(formatTelegramModeStatus({ url: '' }), /webhook отключён/u);
});

test('hosted CLI prefers TELEGRAM_HOSTED_URL, falls back to PUBLIC_BASE_URL and does not start polling', async () => {
  for (const withExplicitUrl of [true, false]) {
    const calls = [];
    const logs = [];
    await runTelegramModeCommand({ command: 'hosted', env: { TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_WEBHOOK_SECRET: SECRET, PUBLIC_BASE_URL: withExplicitUrl ? LOCAL : HOSTED,
      ...(withExplicitUrl ? { TELEGRAM_HOSTED_URL: HOSTED } : {}) }, log: text => logs.push(text),
    startPolling: () => assert.fail('hosted mode must not poll'), fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.startsWith('https://api.telegram.org/')) return telegram(true);
      return json(url.endsWith('/config') ? ready : { ok: true });
    } });
    assert.equal(calls[0].url, `${HOSTED}/api/citizen/config`);
    assert.equal(JSON.parse(calls[2].options.body).url, `${HOSTED}/api/telegram/webhook`);
    assert.match(logs[0], /Компьютер можно выключить/u);
    assert.ok(!logs.join('').includes(SECRET));
    assert.ok(!logs.join('').includes(TOKEN));
  }
});

test('local CLI starts polling only after successful preflight and webhook removal', async () => {
  const calls = [];
  const env = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, PORT: '3456' };
  await runTelegramModeCommand({ command: 'local', env, log: () => {}, fetchImpl: async url => {
    calls.push(url);
    if (url.endsWith('/deleteWebhook')) return telegram(true);
    if (url.endsWith('/getWebhookInfo')) return telegram({ url: '' });
    return json(url.endsWith('/config') ? ready : { ok: true });
  }, startPolling: async options => { calls.push('poll'); assert.equal(options.env, env); } });
  assert.equal(calls[0], 'http://127.0.0.1:3456/api/citizen/config');
  assert.ok(calls[2].endsWith('/deleteWebhook'));
  assert.ok(calls[3].endsWith('/getWebhookInfo'));
  assert.equal(calls[4], 'poll');
});

test('status CLI is read-only and works without a webhook secret', async () => {
  const calls = [];
  const logs = [];
  await runTelegramModeCommand({ command: 'status', env: { TELEGRAM_BOT_TOKEN: TOKEN }, log: text => logs.push(text),
    fetchImpl: async url => { calls.push(url.split('/').at(-1)); return telegram({ url: '', pending_update_count: 3 }); },
    startPolling: () => assert.fail('status must not poll') });
  assert.deepEqual(calls, ['getWebhookInfo']);
  assert.match(logs[0], /обновлений: 3/u);
});
