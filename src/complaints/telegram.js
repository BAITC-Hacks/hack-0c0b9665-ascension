const MAX_RECENT_UPDATES = 4096;
const MAX_DRAFTS = 1000;
const DRAFT_TTL_MS = 30 * 60 * 1000;
const SESSION_UPDATE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSION_UPDATES = 32;
const UPDATE_PREFIX = 'telegram:update:';
const UPDATE_EXPIRY_PREFIX = 'telegram:update-expiry:';
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const STATUS_LABELS = { new: 'Новое', in_progress: 'В работе', resolved: 'Решено', rejected: 'Отклонено' };
const CONSENT_PROMPT = '📝 Новое обращение\n\nДля передачи обращения в акимат нужно ваше согласие на обработку текста, фото и указанного места. Эти сведения и Telegram ID доступны сотрудникам; в публичной проверке они не показываются. Не отправляйте чужие персональные данные.\n\nНажмите «✅ Согласен, продолжить» или отправьте /agree. До отправки обращение можно отменить.';
const DESCRIPTION_PROMPT = 'Шаг 1 из 3. Что случилось?\n\nОпишите городскую проблему одним сообщением: что не работает и где это заметили. Например: «Возле дома не горит фонарь, вечером темно». Нужно не меньше 10 символов. Можно сразу отправить фото с подписью.';
const HELP_TEXT = '❓ Как пользоваться\n\n1. Нажмите «📝 Новое обращение» и подтвердите согласие.\n2. Опишите проблему. При желании добавьте адрес, геолокацию и фото через скрепку.\n3. Проверьте черновик и нажмите «✅ Отправить обращение».\n\nВ ответ придут номер и личный код. По кнопке «🔎 Проверить статус» можно узнать результат; в этом же чате достаточно номера.\n\n«🏠 Главное меню» сохраняет черновик на 30 минут бездействия. «❌ Отменить обращение» удаляет его. При перезапуске бота незавершённый черновик нужно заполнить снова.\n\nКоманды также работают: /menu, /new, /status, /help, /support, /cancel. Быстрая отправка готового черновика: /send.';

export const TELEGRAM_BUTTONS = Object.freeze({
  new: '📝 Новое обращение', status: '🔎 Проверить статус', help: '❓ Как пользоваться',
  support: '💬 Техподдержка', menu: '🏠 Главное меню', agree: '✅ Согласен, продолжить',
  cancel: '❌ Отменить обращение', resume: '↩️ Продолжить обращение', address: '📍 Указать адрес',
  location: '📌 Отправить геолокацию', photo: '📷 Добавить фото', skip: 'Пропустить адрес',
  review: '👀 Проверить и отправить', send: '✅ Отправить обращение', edit: '✏️ Дополнить обращение',
  reset: '🗑 Начать заново',
});
export const TELEGRAM_COMMANDS = Object.freeze([
  { command: 'menu', description: 'Главное меню' },
  { command: 'new', description: 'Создать обращение о городской проблеме' },
  { command: 'status', description: 'Проверить статус обращения' },
  { command: 'help', description: 'Как пользоваться ботом' },
  { command: 'support', description: 'Техническая поддержка' },
  { command: 'cancel', description: 'Отменить незавершённое обращение' },
  { command: 'start', description: 'Начать работу с ботом' },
]);
const BUTTON_COMMANDS = new Map(Object.entries(TELEGRAM_BUTTONS).map(([command, label]) => [label, command]));
const B = TELEGRAM_BUTTONS;

const expiryKey = (expiresAt, id = '') => `${UPDATE_EXPIRY_PREFIX}${String(expiresAt).padStart(16, '0')}:${id}`;

/** Called by the owning Durable Object alarm. Each batch has bounded storage work. */
export async function cleanupTelegramUpdates(storage, { now = Date.now(), limit = 128 } = {}) {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isInteger(limit) || limit < 1 || limit > 128) {
    throw new TypeError('Некорректные параметры очистки обновлений Telegram.');
  }
  return storage.transaction(async transaction => {
    const expired = await transaction.list({ prefix: UPDATE_EXPIRY_PREFIX, end: expiryKey(now + 1), limit });
    let removed = 0;
    for (const [key, index] of expired) {
      const entry = await transaction.get(index.key);
      // An expired index must never delete a newer reuse of the same update_id.
      if (entry && entry.expiresAt <= now) { await transaction.delete(index.key); removed++; }
      await transaction.delete(key);
    }
    const next = [...(await transaction.list({ prefix: UPDATE_EXPIRY_PREFIX, limit: 1 })).values()][0];
    if (next) await transaction.setAlarm(Math.max(now + 1000, next.expiresAt));
    // An executing alarm clears itself; avoiding deleteAlarm also preserves newly scheduled work.
    return { removed, more: Boolean(next && next.expiresAt <= now) };
  });
}

function keyboard(rows, placeholder = 'Выберите действие в меню') {
  return { keyboard: rows.map(row => row.map(button => typeof button === 'string' ? { text: button } : button)),
    resize_keyboard: true, is_persistent: true, input_field_placeholder: placeholder };
}

function supportLink(value) {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (/^@[A-Za-z0-9_]{5,32}$/u.test(raw)) return `https://t.me/${raw.slice(1)}`;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && ['t.me', 'telegram.me'].includes(url.hostname)
      && !url.username && !url.password && !url.hash && raw.length <= 512 ? url.href : '';
  } catch { return ''; }
}

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

export function createTelegramProcessor({ store, sendMessage = async () => ({ skipped: true }), publicBaseUrl = '', supportUrl = '', sessionStorage = null }) {
  if (!store?.create || !store?.get || !store?.track) throw new TypeError('Нужно хранилище обращений.');
  if (sessionStorage && (typeof sessionStorage.get !== 'function' || typeof sessionStorage.put !== 'function')) throw new TypeError('Хранилище сессий должно поддерживать get и put.');
  const drafts = new Map();
  const updates = new Map();
  const chatQueues = new Map();
  const screens = new Map();
  const sessions = new Map();
  const support = supportLink(supportUrl);

  function activeDraft(chatId) {
    const draft = drafts.get(chatId);
    if (draft && Date.now() - draft.updatedAt <= DRAFT_TTL_MS) return draft;
    drafts.delete(chatId);
    return null;
  }

  function screenFor(chatId) {
    const now = Date.now();
    if (sessionStorage) {
      if (now - (screens.get(chatId)?.updatedAt ?? 0) > DRAFT_TTL_MS) screens.delete(chatId);
    } else for (const [id, screen] of screens) if (now - screen.updatedAt > DRAFT_TTL_MS) screens.delete(id);
    if (!screens.has(chatId)) {
      if (!sessionStorage && screens.size >= MAX_DRAFTS) screens.delete(screens.keys().next().value);
      screens.set(chatId, { mode: 'menu', updatedAt: now });
    }
    const screen = screens.get(chatId);
    screen.updatedAt = now;
    return screen;
  }

  function menuKeyboard(chatId) {
    return keyboard([...(activeDraft(chatId) ? [[B.resume]] : []), [B.new, B.status], [B.help, B.support]]);
  }

  const consentKeyboard = () => keyboard([[B.agree], [B.menu, B.cancel]], 'Подтвердите согласие или вернитесь в меню');
  const navigationKeyboard = chatId => keyboard([...(activeDraft(chatId) ? [[B.resume]] : []), [B.menu]]);

  function draftKeyboard(draft) {
    return keyboard([
      ...(draft.text.trim().length >= 10 ? [[B.review]] : []),
      [B.address, { text: B.location, request_location: true }],
      [B.photo, ...(!draft.address && !draft.location && !draft.locationSkipped ? [B.skip] : [])],
      [B.menu, B.cancel],
    ], 'Опишите проблему или добавьте детали');
  }

  function nextStep(draft) {
    if (draft.text.trim().length < 10) return DESCRIPTION_PROMPT;
    if (!draft.address && !draft.location && !draft.locationSkipped) {
      return 'Шаг 2 из 3. Где находится проблема?\n\nНажмите «📍 Указать адрес» и напишите улицу и дом. Или отправьте геолокацию кнопкой ниже — только если вы сейчас на месте проблемы. Адрес необязателен: его можно пропустить.';
    }
    return 'Шаг 3 из 3. Всё почти готово.\n\nПри желании добавьте фото через скрепку или напишите дополнительные подробности. Затем нажмите «👀 Проверить и отправить». Обращение ещё не отправлено.';
  }

  function draftSummary(draft) {
    return ['👀 Проверьте обращение', '', draft.text.length > 1800 ? `${draft.text.slice(0, 1800)}…\n(Показано начало; отправится полный текст.)` : draft.text,
      '', `Адрес: ${draft.address || 'не указан'}`,
      `Геолокация: ${draft.location ? `${draft.location.lat}, ${draft.location.lon}` : 'не указана'}`,
      `Фото: ${draft.attachments.length}`, '', 'Обращение ещё не отправлено. Если всё верно, нажмите «✅ Отправить обращение».'].join('\n');
  }

  function draftFor(chatId) {
    const now = Date.now();
    if (sessionStorage) activeDraft(chatId);
    else for (const [id, draft] of drafts) if (now - draft.updatedAt > DRAFT_TTL_MS) drafts.delete(id);
    if (!drafts.has(chatId)) {
      if (!sessionStorage && drafts.size >= MAX_DRAFTS) drafts.delete(drafts.keys().next().value);
      drafts.set(chatId, { text: '', attachments: [], address: '', consent: false, updatedAt: now,
        ...(sessionStorage ? { generation: crypto.randomUUID() } : {}) });
    }
    const draft = drafts.get(chatId);
    draft.updatedAt = now;
    return draft;
  }

  function receiptReply(receipt) {
    const id = receipt.complaint.id;
    const link = trackingLink(publicBaseUrl, id, receipt.trackingToken);
    return `✅ Обращение принято. Номер: ${id}\nКод проверки: ${receipt.trackingToken}\n\nСохраните это сообщение. Чтобы узнать результат, нажмите «${B.status}» и отправьте номер. В этом чате код не нужен.\nБыстрая проверка: /status ${id}\n\nНа сайте нужны номер и личный код. Не передавайте код другим.${link ? `\n${link}` : ''}`;
  }

  async function prepare(update, chatId) {
    const message = update.message ?? update.callback_query?.message;
    const callback = update.callback_query?.data;
    if (callback && !['consent:agree', 'consent:cancel'].includes(callback)) return { result: { ignored: true } };
    const raw = callback === 'consent:agree' ? '/agree' : callback === 'consent:cancel' ? '/cancel' : String(message.text ?? message.caption ?? '');
    const match = raw.trim().match(/^\/(\w+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/u);
    const command = match?.[1]?.toLowerCase() ?? BUTTON_COMMANDS.get(raw.trim());
    const argument = match?.[2]?.trim() ?? '';
    const screen = screenFor(chatId);
    const reply = (text, extra = {}, markup = menuKeyboard(chatId)) => ({ text, markup, result: { handled: true, ...extra } });
    const consentReply = () => { screen.mode = 'consent'; return reply(CONSENT_PROMPT, {}, consentKeyboard()); };
    const continueDraft = () => {
      const draft = activeDraft(chatId);
      if (!draft) { screen.mode = 'menu'; return reply('Незавершённого обращения нет. Нажмите «📝 Новое обращение», чтобы начать.'); }
      if (!draft.consent) return consentReply();
      draft.updatedAt = Date.now();
      screen.mode = 'draft';
      return reply(nextStep(draft), {}, draftKeyboard(draft));
    };

    if (command === 'cancel') {
      drafts.delete(chatId);
      screen.mode = 'menu';
      return reply('Черновик удалён, обращение не отправлено. Вы в главном меню.');
    }
    if (command === 'start' || command === 'menu') {
      screen.mode = 'menu';
      return reply(`${command === 'start' ? 'Здравствуйте! Я помощник Ascension City. Помогу сообщить о городской проблеме и узнать статус обращения.' : '🏠 Главное меню'}\n\nВыберите действие кнопкой ниже. Команды запоминать не нужно.${activeDraft(chatId) ? '\n\nУ вас есть незавершённое обращение. Нажмите «↩️ Продолжить обращение», чтобы вернуться к нему.' : ''}`);
    }
    if (command === 'new' || (command === 'reset' && screen.mode === 'reset')) {
      const draft = activeDraft(chatId);
      if (command === 'new' && draft && (draft.text || draft.attachments.length || draft.address || draft.location)) {
        screen.mode = 'reset';
        return reply('У вас уже есть черновик. Можно продолжить его или начать заново. Если начать заново, текст и вложения старого черновика будут удалены.', {}, keyboard([[B.resume], [B.reset], [B.menu]]));
      }
      drafts.delete(chatId);
      draftFor(chatId);
      return consentReply();
    }
    if (command === 'resume' || command === 'edit') return continueDraft();
    if (command === 'help' || command === 'support') {
      screen.mode = command;
      const help = sessionStorage ? HELP_TEXT.replace('При перезапуске бота незавершённый черновик нужно заполнить снова.', 'Черновик сохраняется при перезапуске бота в течение этих 30 минут.') : HELP_TEXT;
      const text = command === 'help' ? help : `💬 Техподдержка\n\n${support ? `Чтобы написать человеку, откройте контакт поддержки:\n${support}\n\nОпишите, на каком шаге возникла проблема. Можно приложить скриншот и номер обращения. Личный код проверки отправлять не нужно.` : `Контакт оператора пока не подключён. Ответы на частые вопросы:\n\n• Не получается отправить? Подтвердите согласие и добавьте описание не короче 10 символов.\n• Как прикрепить фото? Нажмите скрепку в поле сообщения.\n• Где номер обращения? Он в сообщении «Обращение принято».\n• Пропал черновик? После 30 минут бездействия${sessionStorage ? '' : ' или перезапуска'} начните новое обращение.`}\n\nСообщения из этого раздела не пересылаются оператору.`;
      return reply(text, {}, navigationKeyboard(chatId));
    }
    if (command === 'status' || (!command && screen.mode === 'status')) {
      screen.mode = 'status';
      const query = command ? argument : raw.trim();
      const parts = query.split(/\s+/u).filter(Boolean);
      if (!parts.length || parts.length > 2 || (!message.text && !callback)) return reply('🔎 Проверка статуса\n\nОтправьте номер из сообщения «Обращение принято». Если вы создавали обращение в этом чате, этого достаточно. Для обращения с сайта отправьте НОМЕР и КОД через пробел.\n\nВернуться назад: «🏠 Главное меню».', {}, navigationKeyboard(chatId));
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
      if (!complaint) return reply('Обращение не найдено. Проверьте номер и код проверки и отправьте их ещё раз. Номер можно скопировать из сообщения о принятии обращения.', {}, navigationKeyboard(chatId));
      screen.mode = 'menu';
      return reply(formatTelegramStatusNotification(complaint));
    }
    if (command === 'send') {
      const draft = drafts.get(chatId);
      const active = draft && Date.now() - draft.updatedAt <= DRAFT_TTL_MS ? draft : null;
      if (sessionStorage && active) {
        active.generation ??= crypto.randomUUID();
        // The receipt stores this exact generation. Persist it before creating
        // the complaint so recovery can clear a submitted draft after a crash,
        // while a late replay still leaves a genuinely newer draft untouched.
        await saveSession(chatId, sessions.get(chatId));
      }
      // create deduplicates a Telegram update before validating its draft. This
      // recovers the original receipt if Telegram retries /send after a restart.
      let receipt;
      try {
        receipt = await store.create({
          text: active?.consent ? active.text : '',
          address: active?.address ?? '', location: active?.location,
          attachments: active?.attachments ?? [], consent: active?.consent ?? false,
          source: 'telegram', telegramChatId: chatId, telegramUpdateId: update.update_id,
          ...(sessionStorage && active?.generation ? { telegramDraftId: active.generation } : {}),
        });
      } catch (error) {
        if (error.status >= 400 && error.status < 500) {
          if (!active?.consent) return consentReply();
          screen.mode = 'draft';
          if (active.text.trim().length < 10) return reply(DESCRIPTION_PROMPT, {}, draftKeyboard(active));
          return reply('Не удалось сохранить черновик. Проверьте длину текста (до 5000 символов), адреса (до 300) и приложите не больше 10 фото.', {}, draftKeyboard(active));
        }
        throw error;
      }
      if (String(receipt.complaint.telegramChatId) !== chatId) return reply('Не удалось подтвердить это обращение. Начните новое: /start.');
      const submittedDraft = active?.generation && receipt.complaint.telegramDraftId === active.generation;
      if (!receipt.duplicateUpdate || submittedDraft) drafts.delete(chatId);
      if (!receipt.duplicateUpdate || submittedDraft) screen.mode = 'menu';
      return reply(receiptReply(receipt), { submitted: true, complaintId: receipt.complaint.id, duplicateUpdate: !!receipt.duplicateUpdate });
    }
    if (command === 'review') {
      const draft = activeDraft(chatId);
      if (!draft?.consent) return consentReply();
      if (draft.text.trim().length < 10) return continueDraft();
      screen.mode = 'review';
      return reply(draftSummary(draft), {}, keyboard([[B.send], [B.edit], [B.menu, B.cancel]], 'Проверьте обращение перед отправкой'));
    }
    if (command && !['agree', 'address', 'photo', 'location', 'skip'].includes(command)) {
      return reply('Не удалось распознать команду. Выберите действие в главном меню или откройте /help.');
    }
    if (!command && ['help', 'support', 'reset'].includes(screen.mode)) {
      return reply(screen.mode === 'support' ? `Чтобы связаться с поддержкой, ${support ? `откройте контакт: ${support}` : 'дождитесь подключения контакта оператора. Пока доступна помощь /help.'}` : 'Выберите действие кнопкой ниже. Для возврата к черновику нажмите «↩️ Продолжить обращение».', {}, navigationKeyboard(chatId));
    }
    if (!command && screen.mode === 'menu' && activeDraft(chatId)) {
      return reply('Черновик сохранён. Чтобы добавить текст или вложения, сначала нажмите «↩️ Продолжить обращение».');
    }
    if (!command && !activeDraft(chatId) && !message.photo?.length && !message.location && raw.trim().length < 10) {
      return reply('Я помогу оформить обращение о городской проблеме. Нажмите «📝 Новое обращение» или выберите другое действие в меню.');
    }
    const draft = draftFor(chatId);
    if (command === 'agree') {
      draft.consent = true;
      screen.mode = 'draft';
      return reply(`Согласие получено.\n\n${nextStep(draft)}`, {}, draftKeyboard(draft));
    }
    if (['address', 'photo', 'location', 'skip'].includes(command) && !draft.consent) return consentReply();
    if (command === 'address' && !argument) {
      screen.mode = 'address';
      return reply('📍 Напишите адрес следующим сообщением: улица, дом и ориентир. Например: «ул. Тестовая, 10, возле остановки». До 300 символов.\n\nМожно также отправить геолокацию, если вы сейчас на месте проблемы.', {}, keyboard([[{ text: B.location, request_location: true }], [B.resume, B.menu]], 'Улица, дом, ориентир'));
    }
    if (command === 'photo' || command === 'location' || command === 'skip') {
      screen.mode = 'draft';
      if (command === 'skip') { draft.locationSkipped = true; return reply(nextStep(draft), {}, draftKeyboard(draft)); }
      return reply(command === 'photo' ? '📷 Нажмите скрепку возле поля ввода и выберите фото. Можно отправить до 10 фото. Подпись добавится к описанию. Фото необязательно: продолжить можно без него.' : '📌 Нажмите кнопку геолокации ниже, если вы на месте проблемы. Для другого места укажите адрес или выберите точку через скрепку → «Геопозиция».', {}, draftKeyboard(draft));
    }
    if (command === 'address' || (!command && screen.mode === 'address' && message.text)) {
      const address = command === 'address' ? argument : raw.trim();
      if (!address || address.length > 300) return reply('Укажите адрес до 300 символов: улица, дом и ориентир.', {}, navigationKeyboard(chatId));
      draft.address = address;
    } else if (message.location) {
      const { latitude: lat, longitude: lon } = message.location;
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return reply('Не удалось прочитать геолокацию. Отправьте её заново или укажите /address адрес.', {}, draftKeyboard(draft));
      draft.location = { lat, lon };
    } else {
      const text = raw.trim();
      if (text && draft.text.length + text.length + (draft.text ? 1 : 0) > 5000) return reply('В обращении может быть до 5000 символов. Последнее сообщение не добавлено; предыдущий текст сохранён. Сократите дополнение или проверьте готовый черновик.', {}, draftKeyboard(draft));
      const photos = Array.isArray(message.photo) ? message.photo : [];
      const photo = [...photos].reverse().find((item) => typeof item?.file_id === 'string' && item.file_id.length > 0 && item.file_id.length <= 500);
      if (!text && !photo) return reply('Пока поддерживаются текст, фото и геолокация. Голосовое сообщение или документ не добавлены. Опишите проблему текстом или прикрепите фото.', {}, draft.consent ? draftKeyboard(draft) : consentKeyboard());
      if (photo && !draft.attachments.some((item) => item.fileId === photo.file_id)) {
        if (draft.attachments.length >= 10) return reply('Можно приложить не больше 10 фото. Уже добавленные фото сохранены. Нажмите «👀 Проверить и отправить».', {}, draftKeyboard(draft));
        const attachment = { type: 'photo', fileId: photo.file_id };
        if (typeof photo.file_unique_id === 'string' && photo.file_unique_id.length > 0 && photo.file_unique_id.length <= 500) attachment.fileUniqueId = photo.file_unique_id;
        draft.attachments.push(attachment);
      }
      if (text) draft.text += `${draft.text ? '\n' : ''}${text}`;
    }
    if (!draft.consent) return consentReply();
    screen.mode = 'draft';
    return reply(`Добавлено в черновик.\n\n${nextStep(draft)}`, {}, draftKeyboard(draft));
  }

  async function loadSession(chatId) {
    let session = sessions.get(chatId);
    if (session) {
      sessions.delete(chatId);
      sessions.set(chatId, session);
      return session;
    }
    const saved = await sessionStorage.get(`telegram:session:${chatId}`);
    if (saved && (saved.version !== 1 || !Array.isArray(saved.updates))) throw new Error('Не удалось прочитать сохранённую сессию Telegram.');
    const now = Date.now();
    if (saved?.draft && now - saved.draft.updatedAt <= DRAFT_TTL_MS) drafts.set(chatId, saved.draft);
    if (saved?.screen && now - saved.screen.updatedAt <= DRAFT_TTL_MS) screens.set(chatId, saved.screen);
    session = { updates: new Map((saved?.updates ?? [])
      .filter(entry => now - entry.createdAt < SESSION_UPDATE_TTL_MS)
      .slice(-MAX_SESSION_UPDATES).map(entry => [entry.id, entry])) };
    sessions.set(chatId, session);
    return session;
  }

  function pruneSessionUpdates(session) {
    const now = Date.now();
    for (const [id, entry] of session.updates) {
      if (now - entry.createdAt >= SESSION_UPDATE_TTL_MS) session.updates.delete(id);
    }
    while (session.updates.size > MAX_SESSION_UPDATES) session.updates.delete(session.updates.keys().next().value);
  }

  async function saveSession(chatId, session, entry) {
    const now = Date.now();
    pruneSessionUpdates(session);
    const screen = screens.get(chatId);
    // The 32-reply snapshot is only a cache. The separate ledger retains every
    // update for 24 hours, regardless of subsequent traffic in this chat.
    const snapshot = {
      version: 1, updatedAt: now, draft: activeDraft(chatId),
      screen: screen && now - screen.updatedAt <= DRAFT_TTL_MS ? screen : null,
      updates: [...session.updates.values()].map(({ id, createdAt, prepared, complete }) => ({ id, createdAt, prepared, complete: !!complete })),
    };
    if (!entry) return sessionStorage.put(`telegram:session:${chatId}`, snapshot);
    const expiresAt = entry.createdAt + SESSION_UPDATE_TTL_MS;
    const key = `${UPDATE_PREFIX}${entry.id}`;
    const changes = {
      [`telegram:session:${chatId}`]: snapshot,
      [key]: { version: 1, id: entry.id, chatId, createdAt: entry.createdAt, expiresAt,
        prepared: entry.prepared, complete: !!entry.complete },
      [expiryKey(expiresAt, entry.id)]: { key, expiresAt },
    };
    if (typeof sessionStorage.getAlarm !== 'function' || typeof sessionStorage.setAlarm !== 'function') {
      // Minimal local test adapters have no alarm API. The Durable Object uses the transaction below.
      return sessionStorage.put(changes);
    }
    // Commit mutation, reply, expiry, and its cleanup alarm together. A crash must
    // never leave a durable ledger without an alarm, or a draft without its ledger.
    await sessionStorage.transaction(async transaction => {
      await transaction.put(changes);
      const alarm = await transaction.getAlarm();
      if (alarm === null || alarm > expiresAt) await transaction.setAlarm(expiresAt);
    });
  }

  async function loadUpdate(id) {
    const entry = await sessionStorage.get(`${UPDATE_PREFIX}${id}`);
    if (!entry) return null;
    if (entry.version !== 1 || entry.id !== id || typeof entry.chatId !== 'string'
      || !Number.isSafeInteger(entry.expiresAt) || !Number.isSafeInteger(entry.createdAt)
      || entry.expiresAt !== entry.createdAt + SESSION_UPDATE_TTL_MS
      || !entry.prepared || typeof entry.prepared !== 'object' || typeof entry.complete !== 'boolean') {
      throw new Error('Не удалось прочитать журнал обновлений Telegram.');
    }
    return entry.expiresAt > Date.now() ? entry : null;
  }

  async function processPersistentUpdate(update, chatId) {
    const inFlight = updates.get(update.update_id);
    if (inFlight) return inFlight.chatId === chatId ? inFlight.pending : { ignored: true, duplicateUpdate: true };
    const previous = chatQueues.get(chatId) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      let entry;
      try {
        const session = await loadSession(chatId);
        pruneSessionUpdates(session);
        entry = session.updates.get(update.update_id);
        if (!entry) entry = await loadUpdate(update.update_id);
        if (entry?.chatId && entry.chatId !== chatId) return { ignored: true, duplicateUpdate: true };
        if (entry) session.updates.set(update.update_id, entry);
        if (entry?.complete) {
          // Also retries a completion write that failed after successful delivery.
          await saveSession(chatId, session, entry);
          return { ...entry.prepared.result, duplicateUpdate: true };
        }
        if (!entry) {
          entry = { id: update.update_id, createdAt: Date.now(), prepared: await prepare(update, chatId), complete: false };
          session.updates.set(update.update_id, entry);
        }
        await saveSession(chatId, session, entry);
        if (entry.prepared.text) await sendMessage(chatId, entry.prepared.text, { replyMarkup: entry.prepared.markup });
        entry.complete = true;
        await saveSession(chatId, session, entry);
        return entry.prepared.result;
      } catch (error) {
        if (!entry?.complete) {
          // Never let the next update persist a mutation whose own ledger commit failed.
          sessions.delete(chatId);
          drafts.delete(chatId);
          screens.delete(chatId);
        }
        throw error;
      }
    });
    updates.set(update.update_id, { chatId, pending });
    chatQueues.set(chatId, pending);
    try {
      return await pending;
    } finally {
      updates.delete(update.update_id);
      if (chatQueues.get(chatId) === pending) chatQueues.delete(chatId);
      for (const id of sessions.keys()) {
        if (sessions.size <= MAX_DRAFTS) break;
        if (chatQueues.has(id)) continue;
        sessions.delete(id);
        drafts.delete(id);
        screens.delete(id);
      }
    }
  }

  return async function processUpdate(update) {
    if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0) return { ignored: true };
    const chatId = chatIdOf(update);
    if (!chatId) return { ignored: true };
    if (sessionStorage) return processPersistentUpdate(update, chatId);
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
      if (entry.prepared.text) await sendMessage(chatId, entry.prepared.text, { replyMarkup: entry.prepared.markup });
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
    configureMenu: async () => ({ skipped: true, reason: 'not_configured' }),
    getUpdates: async () => [],
    getPhoto: async () => { throw telegramError('TELEGRAM_NOT_CONFIGURED', 'Telegram не настроен.', 503); },
  };
  if (typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]{20,}$/u.test(token)) throw telegramError('TELEGRAM_INVALID_TOKEN', 'Некорректный токен Telegram.', 503);

  async function fetchLimited(url, options, maxBytes, timeoutMs) {
    try {
      // Workerd supports manual redirects; reject 3xx below without forwarding the token.
      const response = await fetchImpl(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
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
    async sendMessage(chatId, text, { replyMarkup } = {}) {
      if (!/^-?\d{1,20}$/u.test(String(chatId)) || typeof text !== 'string' || !text || text.length > 4096) throw telegramError('TELEGRAM_INVALID_MESSAGE', 'Некорректное сообщение для Telegram.', 400);
      if (replyMarkup != null && (typeof replyMarkup !== 'object' || Array.isArray(replyMarkup) || JSON.stringify(replyMarkup).length > 8192)) throw telegramError('TELEGRAM_INVALID_MARKUP', 'Некорректное меню Telegram.', 400);
      return call('sendMessage', { chat_id: String(chatId), text, link_preview_options: { is_disabled: true },
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
    },
    async configureMenu() {
      await call('setMyCommands', { commands: TELEGRAM_COMMANDS, scope: { type: 'all_private_chats' } });
      await call('setChatMenuButton', { menu_button: { type: 'commands' } });
      await call('setMyDescription', { description: 'Ascension City помогает сообщить о городской проблеме: опишите её, при желании добавьте фото и место, а затем проверяйте статус обращения. Нажмите «Начать» — бот подскажет каждый шаг.' });
      return { configured: true, commandCount: TELEGRAM_COMMANDS.length };
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
