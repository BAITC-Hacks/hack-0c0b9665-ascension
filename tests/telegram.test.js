import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelegramProcessor, createTelegramTransport, formatTelegramStatusNotification, TELEGRAM_BUTTONS as B, TELEGRAM_COMMANDS } from '../src/complaints/telegram.js';
import { createTelegramForwarder, runTelegramPolling } from '../src/telegram-poll.js';
import { createComplaintStore } from '../src/complaints/store.js';

const TEST_TOKEN = '123456:synthetic_test_token_not_a_real_secret';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

function fakeStore() {
  const records = [];
  const receipts = new Map();
  return {
    records,
    async create(input) {
      if (receipts.has(input.telegramUpdateId)) return { ...receipts.get(input.telegramUpdateId), duplicateUpdate: true };
      if (input.consent !== true || input.text.length < 10 || input.text.length > 5000 || input.address.length > 300) throw Object.assign(new Error('invalid'), { status: 400 });
      const complaint = { ...structuredClone(input), id: `C-${records.length + 1}`, status: 'new', resolution: '' };
      const receipt = { complaint, trackingToken: `private-token-${complaint.id}`, duplicateUpdate: false };
      records.push(complaint);
      receipts.set(input.telegramUpdateId, receipt);
      return receipt;
    },
    async get(id) { return records.find((record) => record.id === id) ?? null; },
    async track(id, token) {
      const record = records.find((item) => item.id === id);
      if (!record || token !== `private-token-${id}`) throw Object.assign(new Error('not found'), { status: 404 });
      return { id, status: record.status, resolution: record.resolution };
    },
  };
}

function update(id, content, chat = 100) {
  const payload = typeof content === 'string' ? { text: content } : content;
  return { update_id: id, message: { chat: { id: chat, type: 'private' }, from: { id: chat }, ...payload } };
}

function harness(store = fakeStore(), extra = {}) {
  const sent = [];
  const processUpdate = createTelegramProcessor({ store, publicBaseUrl: 'https://civic.example/', sendMessage: async (chatId, text, options) => { sent.push({ chatId, text, options }); }, ...extra });
  return { store, sent, processUpdate };
}

test('intake requires explicit consent and accumulates original text, photos, address and coordinates', async () => {
  const { processUpdate, store, sent } = harness();
  await processUpdate(update(1, '/start'));
  await processUpdate(update(2, 'На нашей улице не работает освещение.'));
  await processUpdate(update(3, '/send'));
  assert.equal(store.records.length, 0);
  assert.match(sent.at(-1).text, /\/agree/u);
  await processUpdate(update(4, '/agree'));
  await processUpdate(update(5, { photo: [{ file_id: 'small' }, { file_id: 'large', file_unique_id: 'unique' }], caption: 'Вот фото тёмного перехода.' }));
  await processUpdate(update(6, '/address проспект Тестовый, 7'));
  await processUpdate(update(7, { location: { latitude: 51.16, longitude: 71.42 } }));
  const result = await processUpdate(update(8, '/send'));
  assert.equal(result.submitted, true);
  assert.equal(store.records.length, 1);
  assert.deepEqual(store.records[0], {
    text: 'На нашей улице не работает освещение.\nВот фото тёмного перехода.',
    address: 'проспект Тестовый, 7', location: { lat: 51.16, lon: 71.42 },
    attachments: [{ type: 'photo', fileId: 'large', fileUniqueId: 'unique' }], consent: true,
    source: 'telegram', telegramChatId: '100', telegramUpdateId: 8, id: 'C-1', status: 'new', resolution: '',
  });
  assert.match(sent.at(-1).text, /Номер: C-1/u);
  assert.match(sent.at(-1).text, /Код проверки: private-token-C-1/u);
  assert.match(sent.at(-1).text, /citizens\.html#id=C-1&token=private-token-C-1/u);
});

test('repeat and concurrent updates do not append photos/text, create twice or send duplicate receipts', async () => {
  const { processUpdate, store, sent } = harness();
  await processUpdate(update(1, '/agree'));
  const photoUpdate = update(2, { caption: 'Яма возле тестового дома.', photo: [{ file_id: 'photo-1' }] });
  await Promise.all([processUpdate(photoUpdate), processUpdate(photoUpdate)]);
  const sendUpdate = update(3, '/send');
  await Promise.all([processUpdate(sendUpdate), processUpdate(sendUpdate)]);
  const count = sent.length;
  const result = await processUpdate(sendUpdate);
  assert.equal(result.duplicateUpdate, true);
  assert.equal(sent.length, count);
  assert.equal(store.records.length, 1);
  assert.equal(store.records[0].text, 'Яма возле тестового дома.');
  assert.equal(store.records[0].attachments.length, 1);
});

test('persisted submission is recovered after processor restart without an in-memory draft', async () => {
  const first = harness();
  await first.processUpdate(update(1, '/agree'));
  await first.processUpdate(update(2, 'На улице переполнен контейнер для мусора.'));
  await first.processUpdate(update(3, '/send'));
  const restarted = harness(first.store);
  const result = await restarted.processUpdate(update(3, '/send'));
  assert.equal(result.duplicateUpdate, true);
  assert.equal(first.store.records.length, 1);
  assert.equal(restarted.sent[0].text, first.sent.at(-1).text);
});

test('real store preserves photo intake and durable receipts across processor restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'civic-telegram-test-'));
  const filePath = join(directory, 'complaints.json');
  t.after(async () => { await unlink(filePath).catch((error) => { if (error.code !== 'ENOENT') throw error; }); await rmdir(directory); });
  const first = harness(createComplaintStore({ filePath }));
  await first.processUpdate(update(1, '/agree'));
  await first.processUpdate(update(2, { caption: 'Прорвало трубу, вода течёт на дорогу.', photo: [{ file_id: 'test_photo', file_unique_id: 'test_unique' }] }));
  const result = await first.processUpdate(update(3, '/send'));
  assert.equal(result.submitted, true);
  const record = await first.store.get(result.complaintId);
  assert.equal(record.attachments[0].fileId, 'test_photo');
  assert.equal(record.telegramChatId, '100');
  const restarted = harness(createComplaintStore({ filePath }));
  await restarted.processUpdate(update(4, '/agree'));
  await restarted.processUpdate(update(5, 'Новое обращение про переполненный контейнер.'));
  assert.equal((await restarted.processUpdate(update(3, '/send'))).duplicateUpdate, true);
  assert.equal(restarted.sent.at(-1).text, first.sent.at(-1).text);
  // A late replay must not erase a newer draft in the same chat.
  assert.equal((await restarted.processUpdate(update(6, '/send'))).submitted, true);
  assert.equal((await restarted.store.list()).complaints.length, 2);
});

test('failed transport retry reuses a prepared response without mutating the draft again', async () => {
  let fail = false;
  const sent = [];
  const { processUpdate, store } = harness(undefined, { sendMessage: async (_, text) => {
    if (fail) { fail = false; throw new Error('offline'); }
    sent.push(text);
  } });
  await processUpdate(update(1, '/agree'));
  fail = true;
  const report = update(2, 'Проблема с канализацией возле дома.');
  await assert.rejects(processUpdate(report), /offline/u);
  await processUpdate(report);
  fail = true;
  await assert.rejects(processUpdate(update(3, '/send')), /offline/u);
  await processUpdate(update(3, '/send'));
  assert.equal(store.records.length, 1);
  assert.equal(store.records[0].text, report.message.text);
  assert.equal(sent.filter((text) => text.includes('Обращение принято')).length, 1);
});

test('status without code is restricted to the owning chat; code lookup reveals only public decision', async () => {
  const { processUpdate, store, sent } = harness();
  await processUpdate(update(1, '/agree'));
  await processUpdate(update(2, 'Оригинальная приватная жалоба про лампу.'));
  await processUpdate(update(3, '/send'));
  store.records[0].status = 'resolved';
  store.records[0].resolution = 'Лампа заменена.';
  await processUpdate(update(4, '/status C-1'));
  assert.match(sent.at(-1).text, /Решено[\s\S]*Лампа заменена/u);
  assert.doesNotMatch(sent.at(-1).text, /Оригинальная|private-token|telegram/u);
  await processUpdate(update(5, '/status C-1', 200));
  assert.match(sent.at(-1).text, /не найдено/u);
  await processUpdate(update(6, '/status C-1 incorrect', 200));
  assert.match(sent.at(-1).text, /не найдено/u);
  await processUpdate(update(7, '/status C-1 private-token-C-1', 200));
  assert.match(sent.at(-1).text, /Решено/u);
  assert.doesNotMatch(sent.at(-1).text, /Оригинальная|private-token/u);
});

test('cancel removes a draft and consent callbacks are accepted only in their private owner chat', async () => {
  const { processUpdate, store, sent } = harness();
  const callback = (id, from) => ({ update_id: id, callback_query: { from: { id: from }, data: 'consent:agree', message: { chat: { type: 'private', id: 100 } } } });
  assert.deepEqual(await processUpdate(callback(1, 200)), { ignored: true });
  assert.equal(sent.length, 0);
  await processUpdate(callback(2, 100));
  await processUpdate(update(3, 'Тестовая жалоба после согласия.'));
  await processUpdate(update(4, '/cancel'));
  await processUpdate(update(5, '/send'));
  assert.equal(store.records.length, 0);
  const group = update(6, 'Не должно сохраняться.');
  group.message.chat.type = 'group';
  assert.deepEqual(await processUpdate(group), { ignored: true });
  assert.deepEqual(await processUpdate({ update_id: -1 }), { ignored: true });
});

test('draft rejects malformed location and requires a description even when photo is present', async () => {
  const { processUpdate, store, sent } = harness();
  await processUpdate(update(1, '/agree'));
  await processUpdate(update(2, { location: { latitude: 181, longitude: 0 } }));
  assert.match(sent.at(-1).text, /геолокацию/u);
  await processUpdate(update(3, { photo: [{ file_id: 'photo' }] }));
  await processUpdate(update(4, '/send'));
  assert.equal(store.records.length, 0);
  assert.match(sent.at(-1).text, /не меньше 10/u);
});

test('unconfigured transport never performs a network request', async () => {
  const transport = createTelegramTransport({ fetchImpl: () => { throw new Error('must not fetch'); } });
  assert.equal(transport.configured, false);
  assert.deepEqual(await transport.sendMessage('100', 'test'), { skipped: true, reason: 'not_configured' });
  assert.deepEqual(await transport.getUpdates(), []);
  await assert.rejects(transport.getPhoto('photo'), { code: 'TELEGRAM_NOT_CONFIGURED' });
});

function jsonResponse(result) { return new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } }); }

test('transport uses Telegram fixed host, POST methods, bounded long polling and private photo bytes', async () => {
  const requests = [];
  const transport = createTelegramTransport({ token: TEST_TOKEN, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/getFile')) return jsonResponse({ file_path: 'photos/file_12.jpg', file_size: JPEG.length });
    if (url.includes('/file/bot')) return new Response(JPEG);
    if (url.endsWith('/getUpdates')) return jsonResponse([]);
    return jsonResponse({ message_id: 1 });
  } });
  await transport.sendMessage(100, 'Принято.');
  await transport.getUpdates(99);
  const photo = await transport.getPhoto('private-file-id');
  assert.deepEqual(photo.data, JPEG);
  assert.equal(photo.contentType, 'image/jpeg');
  for (const request of requests) {
    assert.equal(new URL(request.url).hostname, 'api.telegram.org');
    assert.equal(request.options.redirect, 'manual');
    assert.ok(request.options.signal instanceof AbortSignal);
  }
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[1].options.body), { offset: 99, timeout: 20, limit: 100, allowed_updates: ['message', 'callback_query'] });
  assert.equal(JSON.parse(requests[2].options.body).file_id, 'private-file-id');
});

test('Telegram redirects are rejected without following a token-bearing request', async () => {
  let calls = 0;
  const transport = createTelegramTransport({ token: TEST_TOKEN, fetchImpl: async (_url, options) => {
    calls++;
    assert.equal(options.redirect, 'manual');
    return new Response('redirect', { status: 307, headers: { Location: 'https://untrusted.example' } });
  } });
  await assert.rejects(transport.sendMessage(100, 'test'), error => {
    assert.equal(error.code, 'TELEGRAM_REQUEST_FAILED');
    assert.ok(!error.message.includes(TEST_TOKEN));
    return true;
  });
  assert.equal(calls, 1);
});

test('photo download rejects external/traversal paths before issuing any download request', async () => {
  for (const path of ['https://evil.example/file.jpg', '../secret.jpg', 'photos/../secret.jpg', 'photos/%2e%2e%2fsecret.jpg', 'photos/a.jpg?x=1', 'photos/a.svg', 'photos\\a.jpg']) {
    let calls = 0;
    const transport = createTelegramTransport({ token: TEST_TOKEN, fetchImpl: async () => { calls++; return jsonResponse({ file_path: path }); } });
    await assert.rejects(transport.getPhoto('file'), { code: 'TELEGRAM_INVALID_FILE_PATH' });
    assert.equal(calls, 1);
  }
});

test('photo download enforces declared and streamed size and checks file signatures', async () => {
  const cases = [
    { file: { file_size: 11 * 1024 * 1024 }, response: () => new Response(JPEG), code: 'TELEGRAM_RESPONSE_TOO_LARGE' },
    { file: {}, response: () => new Response(JPEG, { headers: { 'content-length': String(11 * 1024 * 1024) } }), code: 'TELEGRAM_RESPONSE_TOO_LARGE' },
    { file: {}, response: () => new Response(new Uint8Array(10 * 1024 * 1024 + 1)), code: 'TELEGRAM_RESPONSE_TOO_LARGE' },
    { file: {}, response: () => new Response('<html>not a photo</html>'), code: 'TELEGRAM_INVALID_PHOTO' },
  ];
  for (const item of cases) {
    const transport = createTelegramTransport({ token: TEST_TOKEN, fetchImpl: async (url) => url.endsWith('/getFile') ? jsonResponse({ file_path: 'photos/file.jpg', ...item.file }) : item.response() });
    await assert.rejects(transport.getPhoto('file'), { code: item.code });
  }
});

test('transport errors redact bot tokens, request URLs and upstream descriptions', async () => {
  const transport = createTelegramTransport({ token: TEST_TOKEN, fetchImpl: async (url) => { throw new Error(`connection failed ${url}`); } });
  await assert.rejects(transport.getUpdates(), (error) => {
    assert.equal(error.code, 'TELEGRAM_REQUEST_FAILED');
    assert.ok(!error.stack.includes(TEST_TOKEN));
    assert.ok(!error.message.includes('https://'));
    return true;
  });
  const upstream = createTelegramTransport({ token: TEST_TOKEN, fetchImpl: async () => new Response(JSON.stringify({ ok: false, description: TEST_TOKEN })) });
  await assert.rejects(upstream.sendMessage(100, 'test'), (error) => !error.message.includes(TEST_TOKEN));
  assert.throws(() => createTelegramTransport({ token: 'malformed-secret' }), { code: 'TELEGRAM_INVALID_TOKEN' });
});

test('status notification excludes original message, address, attachments and tracking secrets', () => {
  const text = formatTelegramStatusNotification({ id: 'C-1', status: 'rejected', resolution: 'Нужны дополнительные сведения.', text: 'private-original', address: 'private-address', trackingToken: 'private-token', telegramChatId: 'private-chat', attachments: ['private-file'] });
  assert.match(text, /Отклонено/u);
  assert.match(text, /Нужны дополнительные сведения/u);
  assert.doesNotMatch(text, /private-/u);
});

test('polling forwards complete updates to the single server with webhook secret and timeout', async () => {
  const calls = [];
  const forward = createTelegramForwarder({ webhookSecret: 'synthetic_secret', fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response('{}'); } });
  const payload = update(101, 'Тестовая жалоба.');
  await forward(payload);
  assert.equal(calls[0].url, 'http://127.0.0.1:3000/api/telegram/webhook');
  assert.equal(calls[0].options.headers['X-Telegram-Bot-Api-Secret-Token'], 'synthetic_secret');
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(calls[0].options.body), payload);
});

test('forwarding rejects insecure remote URLs, redirects and failed server responses without secret leakage', async () => {
  for (const serverUrl of ['http://remote.example', 'ftp://localhost', 'https://user:secret@example.com', 'https://example.com?token=secret']) {
    assert.throws(() => createTelegramForwarder({ serverUrl, webhookSecret: 'test' }), /BOT_SERVER_URL/u);
  }
  for (const fetchImpl of [async () => new Response('', { status: 403 }), async (url) => { throw new Error(`secret in ${url}`); }]) {
    const forward = createTelegramForwarder({ serverUrl: 'https://server.example', webhookSecret: 'synthetic_secret', fetchImpl });
    await assert.rejects(forward(update(1, 'test')), (error) => {
      assert.doesNotMatch(error.message, /server\.example|synthetic_secret|https:/u);
      return true;
    });
  }
  assert.throws(() => createTelegramForwarder({ webhookSecret: '' }), /TELEGRAM_WEBHOOK_SECRET/u);
});

test('polling advances offset only after server acceptance and retries failed update', async () => {
  const controller = new AbortController();
  const offsets = [];
  const forwarded = [];
  let shouldFail = true;
  const errors = [];
  await runTelegramPolling({
    signal: controller.signal, retryDelayMs: 0, onError: (error) => errors.push(error),
    transport: { async getUpdates(offset) {
      offsets.push(offset);
      if (offset === 12) { controller.abort(); return []; }
      return [update(11, 'second'), update(10, 'first')];
    } },
    async forwardUpdate(payload) {
      forwarded.push(payload.update_id);
      if (payload.update_id === 11 && shouldFail) { shouldFail = false; throw new Error('server offline'); }
    },
  });
  assert.deepEqual(offsets, [0, 11, 12]);
  assert.deepEqual(forwarded, [10, 11, 11]);
  assert.equal(errors.length, 1);
});

test('first-time user submits through buttons with a separate address step and preview', async () => {
  const { processUpdate, sent, store } = harness();
  const buttons = () => sent.at(-1).options.replyMarkup.keyboard.flat();
  await processUpdate(update(1, '/start'));
  assert.deepEqual(buttons().map(button => button.text), [B.new, B.status, B.help, B.support]);
  assert.equal(store.records.length, 0);
  await processUpdate(update(2, B.new));
  assert.match(sent.at(-1).text, /согласие/u);
  assert.ok(buttons().some(button => button.text === B.agree));
  await processUpdate(update(3, B.agree));
  assert.match(sent.at(-1).text, /Шаг 1 из 3/u);
  await processUpdate(update(4, 'Тест: у перехода не работает фонарь.'));
  assert.match(sent.at(-1).text, /Шаг 2 из 3/u);
  assert.ok(buttons().some(button => button.request_location === true));
  await processUpdate(update(5, B.address));
  await processUpdate(update(6, 'Тестовая улица, дом 10'));
  assert.match(sent.at(-1).text, /Шаг 3 из 3/u);
  await processUpdate(update(7, B.photo));
  await processUpdate(update(8, { photo: [{ file_id: 'synthetic-photo' }] }));
  await processUpdate(update(9, B.review));
  assert.equal(store.records.length, 0, 'preview must not submit');
  assert.match(sent.at(-1).text, /Тестовая улица, дом 10[\s\S]*Фото: 1/u);
  assert.ok(buttons().some(button => button.text === B.send));
  const sendUpdate = update(10, B.send);
  assert.equal((await processUpdate(sendUpdate)).submitted, true);
  assert.equal((await processUpdate(sendUpdate)).duplicateUpdate, true);
  assert.equal(store.records.length, 1);
  assert.equal(store.records[0].text, 'Тест: у перехода не работает фонарь.');
  assert.equal(store.records[0].address, 'Тестовая улица, дом 10');
  assert.equal(store.records[0].attachments.length, 1);
  assert.deepEqual(buttons().map(button => button.text), [B.new, B.status, B.help, B.support]);
});

test('menu, help, support and restart command preserve draft without collecting navigation text', async () => {
  const { processUpdate, sent, store } = harness();
  await processUpdate(update(1, B.new));
  await processUpdate(update(2, B.agree));
  await processUpdate(update(3, 'Тест: переполнен контейнер у остановки.'));
  await processUpdate(update(4, B.menu));
  await processUpdate(update(5, 'Этот текст не должен попасть в обращение.'));
  await processUpdate(update(6, B.help));
  await processUpdate(update(7, B.support));
  await processUpdate(update(8, 'Вопрос поддержке, не текст обращения.'));
  await processUpdate(update(9, '/start'));
  assert.ok(sent.at(-1).options.replyMarkup.keyboard.flat().some(button => button.text === B.resume));
  await processUpdate(update(10, B.resume));
  await processUpdate(update(11, B.skip));
  assert.match(sent.at(-1).text, /Шаг 3 из 3/u);
  await processUpdate(update(12, B.review));
  await processUpdate(update(13, B.send));
  assert.equal(store.records[0].text, 'Тест: переполнен контейнер у остановки.');
  assert.equal(store.records[0].address, '');
});

test('new request requires a deliberate reset before discarding an existing draft', async () => {
  const { processUpdate, sent, store } = harness();
  await processUpdate(update(1, B.agree));
  await processUpdate(update(2, 'Первое тестовое обращение о дороге.'));
  await processUpdate(update(3, B.new));
  assert.match(sent.at(-1).text, /уже есть черновик/u);
  await processUpdate(update(4, B.resume));
  await processUpdate(update(5, B.review));
  assert.match(sent.at(-1).text, /Первое тестовое обращение/u);
  await processUpdate(update(6, B.new));
  await processUpdate(update(7, B.reset));
  await processUpdate(update(8, B.send));
  assert.equal(store.records.length, 0);
  assert.match(sent.at(-1).text, /согласие/u);
  await processUpdate(update(9, B.agree));
  await processUpdate(update(10, 'Второе тестовое обращение о фонаре.'));
  await processUpdate(update(11, B.send));
  assert.equal(store.records[0].text, 'Второе тестовое обращение о фонаре.');
});

test('status button accepts a number as the next message and keeps chat ownership checks', async () => {
  const { processUpdate, sent, store } = harness();
  await processUpdate(update(1, B.agree));
  await processUpdate(update(2, 'Скрытое содержание обращения про фонарь.'));
  await processUpdate(update(3, B.send));
  await processUpdate(update(4, B.status, 200));
  await processUpdate(update(5, 'C-1', 200));
  assert.match(sent.at(-1).text, /не найдено/u);
  await processUpdate(update(6, 'C-1 private-token-C-1', 200));
  assert.match(sent.at(-1).text, /Новое/u);
  assert.doesNotMatch(sent.at(-1).text, /Скрытое|private-token/u);
  await processUpdate(update(7, B.status));
  await processUpdate(update(8, 'C-1'));
  assert.match(sent.at(-1).text, /Новое/u);
  assert.equal(store.records.length, 1);
});

test('support exposes only the configured contact and never pretends to forward a request', async () => {
  for (const supportUrl of ['', 'http://insecure.example', 'https://user:secret@t.me/SupportTest']) {
    const { processUpdate, sent, store } = harness(undefined, { supportUrl });
    await processUpdate(update(1, B.support));
    assert.match(sent.at(-1).text, /Контакт оператора пока не подключён/u);
    assert.doesNotMatch(sent.at(-1).text, /secret|insecure/u);
    await processUpdate(update(2, 'Помогите с тестовой проблемой.'));
    assert.equal(store.records.length, 0);
  }
  const { processUpdate, sent } = harness(undefined, { supportUrl: '@SupportTest' });
  await processUpdate(update(1, B.support));
  assert.match(sent.at(-1).text, /https:\/\/t\.me\/SupportTest/u);
  assert.match(sent.at(-1).text, /не пересылаются оператору/u);
});

test('menu transport forwards keyboard and registers private chat commands with native menu', async () => {
  const calls = [];
  const transport = createTelegramTransport({ token: TEST_TOKEN, fetchImpl: async (url, options) => {
    calls.push({ method: url.split('/').at(-1), body: JSON.parse(options.body) });
    return jsonResponse(true);
  } });
  const replyMarkup = { keyboard: [[{ text: B.menu }]], resize_keyboard: true };
  await transport.sendMessage('100', 'Главное меню', { replyMarkup, chat_id: '200' });
  assert.deepEqual(calls[0].body.reply_markup, replyMarkup);
  assert.equal(calls[0].body.chat_id, '100');
  await transport.configureMenu();
  assert.deepEqual(calls.slice(1).map(call => call.method), ['setMyCommands', 'setChatMenuButton', 'setMyDescription']);
  assert.deepEqual(calls[1].body.scope, { type: 'all_private_chats' });
  assert.deepEqual(calls[1].body.commands, TELEGRAM_COMMANDS);
  assert.deepEqual(calls[2].body.menu_button, { type: 'commands' });
  assert.ok(calls[3].body.description.length <= 512);
});
