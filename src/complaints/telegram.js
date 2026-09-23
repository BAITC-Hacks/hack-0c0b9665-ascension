const MAX_RECENT_UPDATES = 4096;
const MAX_DRAFTS = 1000;
const DRAFT_TTL_MS = 30 * 60 * 1000;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const STATUS_LABELS = { new: 'Новое', in_progress: 'В работе', resolved: 'Решено', rejected: 'Отклонено' };
const CONSENT_PROMPT = 'Для передачи обращения в акимат нужно согласие на обработку текста, фото и указанного вами места. Эти сведения и Telegram ID доступны только сотрудникам; в публичной проверке они не показываются. Подтвердите /agree или отмените /cancel. Не отправляйте чужие персональные данные.';
const DRAFT_HELP = 'Опишите проблему текстом или отправьте фото с подписью. Можно добавить ещё фото, геолокацию и адрес командой /address адрес. Когда всё готово, нажмите /send. Отмена: /cancel.';

function telegramError(code, message, status = 502) {
  return Object.assign(new Error(message), { code, status });
}

function chatIdOf(update) {
  const message = update.message ?? update.callback_query?.message;
  if (message?.chat?.type !== 'private') return null;
  const id = String(message.chat.id ?? '');
  if (!/^\d{1,20}$/u.test(id)) return null;
  if (update.callback_query && String(update.callback_query.from?.id ?? '') !== id) return null;
  return id;
}

function trackingLink(base, id, token) {
  if (!base) return '';
  try {
    const url = new URL('/citizens.html', base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    // The code stays in the fragment, outside HTTP logs and referrer headers.
    url.hash = new URLSearchParams({ id, token }).toString();
    return url.href;
  } catch {
    return '';
  }
}

export function formatTelegramStatusNotification(complaint) {
  const lines = [`Обращение ${complaint.id}`, `Статус: ${STATUS_LABELS[complaint.status] ?? 'Уточняется'}.`];
  if (complaint.resolution) lines.push(`Решение: ${String(complaint.resolution).slice(0, 2500)}`);
  return lines.join('\n');
}

export function createTelegramProcessor({ store, sendMessage = async () => ({ skipped: true }), publicBaseUrl = '' }) {
  if (!store?.create || !store?.get || !store?.track) throw new TypeError('Нужно хранилище обращений.');
  const drafts = new Map();
  const updates = new Map();
  const chatQueues = new Map();

  function draftFor(chatId) {
    const now = Date.now();
    for (const [id, draft] of drafts) if (now - draft.updatedAt > DRAFT_TTL_MS) drafts.delete(id);
    if (!drafts.has(chatId)) {
      if (drafts.size >= MAX_DRAFTS) drafts.delete(drafts.keys().next().value);
      drafts.set(chatId, { text: '', attachments: [], address: '', consent: false, updatedAt: now });
    }
    const draft = drafts.get(chatId);
    draft.updatedAt = now;
    return draft;
  }

  function receiptReply(receipt) {
    const id = receipt.complaint.id;
    const link = trackingLink(publicBaseUrl, id, receipt.trackingToken);
    return `Обращение принято. Номер: ${id}\nКод проверки: ${receipt.trackingToken}\nСтатус: /status ${id}\nДля проверки на сайте сохраните номер и код. Не передавайте код другим.${link ? `\n${link}` : ''}`;
  }

  async function prepare(update, chatId) {
    const message = update.message ?? update.callback_query?.message;
    const callback = update.callback_query?.data;
    if (callback && !['consent:agree', 'consent:cancel'].includes(callback)) return { result: { ignored: true } };
    const raw = callback === 'consent:agree' ? '/agree' : callback === 'consent:cancel' ? '/cancel' : String(message.text ?? message.caption ?? '');
    const match = raw.trim().match(/^\/(\w+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/u);
    const command = match?.[1]?.toLowerCase();
    const argument = match?.[2]?.trim() ?? '';
    const reply = (text, extra = {}) => ({ text, result: { handled: true, ...extra } });

    if (command === 'cancel') {
      drafts.delete(chatId);
      return reply('Черновик удалён. Для нового обращения: /start.');
    }
    if (command === 'start') {
      drafts.delete(chatId);
      draftFor(chatId);
      return reply(`Здравствуйте! Здесь можно сообщить о городской проблеме.\n${CONSENT_PROMPT}\nПроверка существующего обращения: /status НОМЕР КОД.`);
    }
    if (command === 'status') {
      const parts = argument.split(/\s+/u).filter(Boolean);
      if (parts.length < 1 || parts.length > 2) return reply('Проверка: /status НОМЕР КОД. В своём чате код можно опустить.');
      let complaint;
      try {
        if (parts[1]) complaint = await store.track(parts[0], parts[1]);
        else {
          const record = await store.get(parts[0]);
          if (record && String(record.telegramChatId) === chatId) complaint = record;
        }
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      if (!complaint) return reply('Обращение не найдено. Проверьте номер и код проверки.');
      return reply(formatTelegramStatusNotification(complaint));
    }
    if (command === 'send') {
      const draft = drafts.get(chatId);
      const active = draft && Date.now() - draft.updatedAt <= DRAFT_TTL_MS ? draft : null;
      // create deduplicates a Telegram update before validating its draft. This
      // recovers the original receipt if Telegram retries /send after a restart.
      let receipt;
      try {
        receipt = await store.create({
          text: active?.consent ? active.text : '',
          address: active?.address ?? '', location: active?.location,
          attachments: active?.attachments ?? [], consent: active?.consent ?? false,
          source: 'telegram', telegramChatId: chatId, telegramUpdateId: update.update_id,
        });
      } catch (error) {
        if (error.status >= 400 && error.status < 500) {
          if (!active?.consent) return reply(CONSENT_PROMPT);
          if (active.text.trim().length < 10) return reply('Добавьте текст проблемы или подпись к фото (не меньше 10 символов), затем /send.');
          return reply('Не удалось сохранить черновик. Проверьте длину текста (до 5000 символов), адреса (до 300) и приложите не больше 10 фото.');
        }
        throw error;
      }
      if (String(receipt.complaint.telegramChatId) !== chatId) return reply('Не удалось подтвердить это обращение. Начните новое: /start.');
      if (!receipt.duplicateUpdate) drafts.delete(chatId);
      return reply(receiptReply(receipt), { submitted: true, complaintId: receipt.complaint.id, duplicateUpdate: !!receipt.duplicateUpdate });
    }
    if (command === 'help') return reply(`${DRAFT_HELP}\nПроверка статуса: /status НОМЕР КОД.\n${CONSENT_PROMPT}`);
    if (command && !['agree', 'address'].includes(command)) return reply('Неизвестная команда. Помощь: /help.');
    const draft = draftFor(chatId);
    if (command === 'agree') {
      draft.consent = true;
      return reply(`Согласие получено. ${draft.text || draft.attachments.length ? 'Черновик сохранён в этом чате. ' : ''}${DRAFT_HELP}`);
    }
    if (command === 'address') {
      if (!argument || argument.length > 300) return reply('Укажите адрес: /address улица, дом (до 300 символов).');
      draft.address = argument;
    } else if (message.location) {
      const { latitude: lat, longitude: lon } = message.location;
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return reply('Не удалось прочитать геолокацию. Отправьте её заново или укажите /address адрес.');
      draft.location = { lat, lon };
    } else {
      const text = raw.trim();
      if (text && draft.text.length + text.length + (draft.text ? 1 : 0) > 5000) return reply('Текст обращения не должен превышать 5000 символов. Начните заново: /cancel.');
      const photos = Array.isArray(message.photo) ? message.photo : [];
      const photo = [...photos].reverse().find((item) => typeof item?.file_id === 'string' && item.file_id.length > 0 && item.file_id.length <= 500);
      if (!text && !photo) return reply(`Поддерживаются текст, фото и геолокация. ${DRAFT_HELP}`);
      if (photo && !draft.attachments.some((item) => item.fileId === photo.file_id)) {
        if (draft.attachments.length >= 10) return reply('Можно приложить не больше 10 фото. Отправьте черновик: /send.');
        const attachment = { type: 'photo', fileId: photo.file_id };
        if (typeof photo.file_unique_id === 'string' && photo.file_unique_id.length > 0 && photo.file_unique_id.length <= 500) attachment.fileUniqueId = photo.file_unique_id;
        draft.attachments.push(attachment);
      }
      if (text) draft.text += `${draft.text ? '\n' : ''}${text}`;
    }
    return reply(draft.consent ? 'Добавлено в черновик. Можно добавить фото, /address адрес или геолокацию. Отправить обращение: /send.' : CONSENT_PROMPT);
  }

  return async function processUpdate(update) {
    if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0) return { ignored: true };
    const chatId = chatIdOf(update);
    if (!chatId) return { ignored: true };
    let entry = updates.get(update.update_id);
    if (entry?.complete) return { ...entry.prepared.result, duplicateUpdate: true };
    if (entry?.pending) return entry.pending;
    if (!entry) {
      entry = {};
      updates.set(update.update_id, entry);
    }
    const previous = chatQueues.get(chatId) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      entry.prepared ??= await prepare(update, chatId);
      if (entry.prepared.text) await sendMessage(chatId, entry.prepared.text);
      entry.complete = true;
      return entry.prepared.result;
    });
    entry.pending = pending;
    chatQueues.set(chatId, pending);
    try {
      return await pending;
    } finally {
      entry.pending = null;
      if (!entry.prepared) updates.delete(update.update_id);
      if (chatQueues.get(chatId) === pending) chatQueues.delete(chatId);
      if (updates.size > MAX_RECENT_UPDATES) {
        for (const [id, item] of updates) {
          if (!item.pending) updates.delete(id);
          if (updates.size <= MAX_RECENT_UPDATES) break;
        }
      }
    }
  };
}

async function readLimited(response, maxBytes) {
  const size = Number(response.headers.get('content-length'));
  if (Number.isFinite(size) && size > maxBytes) {
    await response.body?.cancel();
    throw telegramError('TELEGRAM_RESPONSE_TOO_LARGE', 'Ответ Telegram превышает допустимый размер.');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw telegramError('TELEGRAM_RESPONSE_TOO_LARGE', 'Ответ Telegram превышает допустимый размер.');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    reader.releaseLock();
  }
}

function photoContentType(data) {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw telegramError('TELEGRAM_INVALID_PHOTO', 'Telegram не вернул поддерживаемое фото.');
}

export function createTelegramTransport({ token = '', fetchImpl = globalThis.fetch } = {}) {
  if (!token) return {
    configured: false,
    sendMessage: async () => ({ skipped: true, reason: 'not_configured' }),
    getUpdates: async () => [],
    getPhoto: async () => { throw telegramError('TELEGRAM_NOT_CONFIGURED', 'Telegram не настроен.', 503); },
  };
  if (typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]{20,}$/u.test(token)) throw telegramError('TELEGRAM_INVALID_TOKEN', 'Некорректный токен Telegram.', 503);

  async function fetchLimited(url, options, maxBytes, timeoutMs) {
    try {
      const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok || response.redirected) {
        await response.body?.cancel();
        throw telegramError('TELEGRAM_REQUEST_FAILED', 'Telegram временно недоступен.');
      }
      return await readLimited(response, maxBytes);
    } catch (error) {
      if (error.code?.startsWith('TELEGRAM_')) throw error;
      // Fetch errors may contain the request URL, which embeds the bot token.
      throw telegramError('TELEGRAM_REQUEST_FAILED', 'Не удалось связаться с Telegram.');
    }
  }

  async function call(method, body, timeoutMs = 10000) {
    const data = await fetchLimited(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, 2 * 1024 * 1024, timeoutMs);
    let envelope;
    try { envelope = JSON.parse(data.toString('utf8')); } catch { throw telegramError('TELEGRAM_INVALID_RESPONSE', 'Некорректный ответ Telegram.'); }
    if (envelope?.ok !== true) throw telegramError('TELEGRAM_API_ERROR', 'Telegram отклонил запрос.');
    return envelope.result;
  }

  return {
    configured: true,
    async sendMessage(chatId, text) {
      if (!/^-?\d{1,20}$/u.test(String(chatId)) || typeof text !== 'string' || !text || text.length > 4096) throw telegramError('TELEGRAM_INVALID_MESSAGE', 'Некорректное сообщение для Telegram.', 400);
      return call('sendMessage', { chat_id: String(chatId), text, link_preview_options: { is_disabled: true } });
    },
    async getUpdates(offset = 0) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw telegramError('TELEGRAM_INVALID_OFFSET', 'Некорректный номер обновления.', 400);
      const result = await call('getUpdates', { offset, timeout: 20, limit: 100, allowed_updates: ['message', 'callback_query'] }, 30000);
      if (!Array.isArray(result)) throw telegramError('TELEGRAM_INVALID_RESPONSE', 'Некорректный список обновлений Telegram.');
      return result;
    },
    async getPhoto(fileId) {
      if (typeof fileId !== 'string' || !fileId || fileId.length > 500) throw telegramError('TELEGRAM_INVALID_FILE', 'Некорректный идентификатор фото.', 400);
      const file = await call('getFile', { file_id: fileId });
      if (!file || typeof file.file_path !== 'string' || !/^photos\/[A-Za-z0-9_-]+\.(?:jpe?g|png|webp)$/u.test(file.file_path)) throw telegramError('TELEGRAM_INVALID_FILE_PATH', 'Telegram вернул недопустимый путь фото.');
      if (file.file_size != null && (!Number.isSafeInteger(file.file_size) || file.file_size < 0 || file.file_size > MAX_PHOTO_BYTES)) throw telegramError('TELEGRAM_RESPONSE_TOO_LARGE', 'Фото превышает допустимый размер 10 MiB.');
      const data = await fetchLimited(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { method: 'GET' }, MAX_PHOTO_BYTES, 10000);
      return { data, contentType: photoContentType(data) };
    },
  };
}
