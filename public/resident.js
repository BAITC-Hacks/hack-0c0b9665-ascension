const byId = (id) => document.getElementById(id);
const districtNames = { esil: 'Есиль', almaty: 'Алматы', saryarka: 'Сарыарка', baikonur: 'Байконур', nura: 'Нура' };
const statuses = { new: 'Принято', review: 'На рассмотрении', clarification: 'Нужно уточнение', work: 'В работе', resolved: 'Работы завершены', rejected: 'Рассмотрение завершено' };
const taskStatuses = { assigned: 'Назначено', reported: 'Исполнитель отчитался', verified: 'Проверено' };
let token = '';
let complaint = null;
let loadingRequest = null;
let sending = false;
let pendingSubmission = null;
const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined && text !== null) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}
function formatDate(value, withTime = false) {
  if (!value) return 'Не указано';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Дата не указана' : (withTime ? timeFormat : dateFormat).format(date);
}
function dateNode(value) {
  const element = node('time', formatDate(value, true));
  if (value && !Number.isNaN(new Date(value).getTime())) element.dateTime = new Date(value).toISOString();
  return element;
}
function notice(id, message, isError = false) {
  const element = byId(id);
  element.textContent = message;
  element.classList.toggle('error', isError);
  element.hidden = !message;
}
function metadata(label, value) {
  const item = node('div');
  item.append(node('dt', label), node('dd', value));
  return item;
}
function renderEntries(id, entries, render) {
  byId(id).replaceChildren(...entries.map(render));
  const empty = byId(`${id}-empty`);
  if (empty) empty.hidden = entries.length > 0;
}
function render(data) {
  complaint = data;
  byId('complaint-content').hidden = false;
  byId('complaint-id').textContent = `ОБРАЩЕНИЕ ${data.id || ''}`;
  byId('complaint-status').textContent = statuses[data.status] || 'Статус уточняется';
  byId('complaint-status').dataset.state = data.status;
  byId('demo-label').hidden = data.source !== 'demo';
  const nextSteps = { new: 'Обращение принято. Команда проверит описание и определит исполнителя.', review: 'Команда рассматривает обращение. Следите за ответами и назначением работ.', clarification: 'Команде нужно уточнение. Проверьте последний ответ по обращению и свяжитесь с командой, которая его приняла.', work: 'Работы выполняются. Их сроки и состояние указаны ниже.', resolved: 'Исполнитель сообщил о завершении. Проверьте результат и оставьте обратную связь.', rejected: 'Рассмотрение завершено. Причину и дальнейшие действия смотрите в ответах по обращению.' };
  byId('next-step').textContent = data.canRespond ? 'Есть результат для проверки. Выберите «Проблема решена» или сообщите, что ещё нужно сделать, в форме обратной связи.' : nextSteps[data.status] || 'Актуальные события и ответы команды показаны ниже.';
  byId('complaint-text').textContent = data.text || 'Описание не указано.';
  byId('complaint-meta').replaceChildren(
    metadata('Адрес', data.address || 'Не указан'),
    metadata('Район', districtNames[data.districtId] || data.districtId || 'Не указан'),
    metadata('Принято', formatDate(data.createdAt)),
    metadata('Обновлено', formatDate(data.updatedAt, true)),
  );
  renderEntries('timeline', Array.isArray(data.timeline) ? data.timeline : [], (entry) => {
    const item = node('li');
    item.append(dateNode(entry.at), node('p', entry.label || 'Статус обновлён'));
    return item;
  });
  renderEntries('tasks', Array.isArray(data.tasks) ? data.tasks : [], (entry) => {
    const item = node('li');
    item.append(node('h3', entry.title || 'Работы по обращению'));
    const details = node('div', null, 'entry-meta');
    details.append(node('span', taskStatuses[entry.status] || 'В работе', 'tag'));
    const dueDate = node('span', entry.dueDate ? `Срок: ${formatDate(entry.dueDate)}` : 'Срок пока не назначен');
    const deadline = entry.dueDate ? new Date(entry.dueDate) : null;
    if (deadline && !Number.isNaN(deadline.getTime())) {
      deadline.setHours(23, 59, 59, 999);
      if (deadline.getTime() < Date.now() && entry.status === 'assigned') {
        dueDate.className = 'overdue';
        dueDate.append(document.createTextNode(' · срок прошёл'));
      }
    }
    details.append(dueDate);
    item.append(details);
    return item;
  });
  renderEntries('replies', Array.isArray(data.replies) ? data.replies : [], (entry) => {
    const item = node('li');
    item.append(dateNode(entry.at), node('p', entry.text || ''));
    return item;
  });
  const feedback = Array.isArray(data.feedback) ? data.feedback : [];
  byId('feedback-history-panel').hidden = feedback.length === 0;
  renderEntries('feedback-history', feedback, (entry) => {
    const item = node('li');
    item.append(dateNode(entry.at), node('h3', entry.outcome === 'confirmed' ? 'Вы подтвердили решение' : 'Вы сообщили, что проблема осталась'));
    if (entry.comment) item.append(node('p', entry.comment));
    if (entry.hasPhoto) item.append(node('p', 'Фото передано команде обращения.', 'muted'));
    return item;
  });
  byId('feedback-form').hidden = !data.canRespond;
  byId('response-unavailable').hidden = Boolean(data.canRespond);
  if (!data.canRespond) {
    byId('response-unavailable').textContent = feedback.length
      ? 'Ваш ответ передан команде. Новое подтверждение станет доступно после следующего отчёта о выполненных работах.'
      : 'Здесь можно будет подтвердить результат, когда исполнитель сообщит о завершении работ.';
  }
}

async function loadComplaint({ refresh = false, preserveNotice = false } = {}) {
  if (!token || sending) return;
  loadingRequest?.abort();
  const controller = new AbortController();
  loadingRequest = controller;
  const timeout = setTimeout(() => controller.abort(), 15000);
  byId('load-error').hidden = true;
  byId('loading').hidden = refresh;
  byId('refresh').disabled = true;
  byId('refresh-version').disabled = true;
  byId('close-complaint').disabled = false;
  if (refresh) notice('refresh-notice', 'Проверяем обновления…');
  try {
    const response = await fetch('/api/resident/complaint', { headers: { 'X-Resident-Token': token }, credentials: 'omit', cache: 'no-store', signal: controller.signal });
    if (controller.signal.aborted || loadingRequest !== controller) return;
    if ([401, 403, 404].includes(response.status)) {
      complaint = null;
      byId('complaint-content').hidden = true;
      byId('access-title').textContent = 'Ссылка недоступна';
      byId('access-copy').textContent = 'Проверьте, что вы открыли ссылку целиком. Если она отозвана или истекла, запросите новую у команды, которая приняла обращение.';
      byId('access-state').hidden = false;
      return;
    }
    if (!response.ok) throw new Error(response.status === 429 ? 'Слишком много запросов. Подождите немного и попробуйте снова.' : 'Сервер временно недоступен. Попробуйте ещё раз.');
    const data = await response.json();
    if (!data || !data.id) throw new Error('Не удалось прочитать данные обращения. Попробуйте ещё раз.');
    if (controller.signal.aborted || loadingRequest !== controller) return;
    byId('access-state').hidden = true;
    render(data);
    byId('refresh-version').hidden = true;
    if (!preserveNotice) notice('feedback-notice', '');
    if (refresh) notice('refresh-notice', 'Статус обновлён.');
  } catch (error) {
    if (loadingRequest !== controller) return;
    const message = controller.signal.aborted ? 'Сервер отвечает дольше обычного. Проверьте соединение и попробуйте снова.' : error.message === 'Failed to fetch' ? 'Нет связи с сервером. Проверьте соединение и повторите попытку.' : error.message;
    if (complaint && refresh) notice('refresh-notice', message, true);
    else {
      byId('load-error-copy').textContent = message;
      byId('load-error').hidden = false;
    }
  } finally {
    clearTimeout(timeout);
    if (loadingRequest === controller) {
      byId('loading').hidden = true;
      byId('refresh').disabled = false;
      byId('refresh-version').disabled = false;
      loadingRequest = null;
    }
  }
}
function updateComment() {
  const unresolved = byId('feedback-form').elements.outcome.value === 'unresolved';
  byId('comment').required = unresolved;
  byId('comment-requirement').textContent = unresolved ? '· обязательно' : '· необязательно';
  byId('comment-count').textContent = `${byId('comment').value.length} / 2000`;
}
function validatePhoto(file) {
  if (!file) return '';
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return 'Выберите фото в формате JPG, PNG или WebP.';
  if (file.size > 2 * 1024 * 1024) return 'Фото слишком большое. Максимальный размер — 2 МБ.';
  if (!file.size) return 'Файл пустой. Выберите другое фото.';
  return '';
}
function updatePhoto() {
  const file = byId('photo').files[0];
  const error = validatePhoto(file);
  byId('photo').setCustomValidity(error);
  byId('photo-status').textContent = error || (file ? `${file.name} · ${Math.ceil(file.size / 1024)} КБ` : '');
  byId('remove-photo').hidden = !file;
}
function photoPayload(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, mime: file.type, base64: String(reader.result).split(',')[1] });
    reader.onerror = () => reject(new Error('Не удалось прочитать фото. Выберите файл снова.'));
    reader.onabort = () => reject(new Error('Чтение фото прервано. Выберите файл снова.'));
    reader.readAsDataURL(file);
  });
}
function requestId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function sendFeedback(event) {
  event.preventDefault();
  if (sending || !complaint?.canRespond || !token) return;
  const form = byId('feedback-form');
  updateComment();
  updatePhoto();
  if (!form.reportValidity()) return;
  const outcome = form.elements.outcome.value;
  const comment = byId('comment').value.trim();
  if (outcome === 'unresolved' && !comment) {
    notice('feedback-notice', 'Опишите, что осталось нерешённым, чтобы команда могла продолжить работу.', true);
    byId('comment').focus();
    return;
  }
  const requestToken = token;
  const file = byId('photo').files[0];
  sending = true;
  byId('feedback-fields').disabled = true;
  byId('close-complaint').disabled = true;
  byId('refresh').disabled = true;
  byId('submit-feedback').textContent = 'Отправляем…';
  notice('feedback-notice', '');
  byId('refresh-version').hidden = true;
  let timeout;
  let success = false;
  try {
    const body = { version: complaint.version, outcome, comment };
    if (file) body.photo = await photoPayload(file);
    const fingerprint = JSON.stringify(body);
    if (!pendingSubmission || pendingSubmission.fingerprint !== fingerprint) pendingSubmission = { fingerprint, requestId: requestId() };
    body.requestId = pendingSubmission.requestId;
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 20000);
    const response = await fetch('/api/resident/feedback', { method: 'POST', credentials: 'omit', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Resident-Token': requestToken, 'X-Resident-Request': '1' }, body: JSON.stringify(body), signal: controller.signal });
    if (token !== requestToken) return;
    if (response.status === 409) {
      notice('feedback-notice', 'Обращение обновилось. Загрузите свежие данные и проверьте результат перед отправкой. Ваш текст и фото сохранены в форме.', true);
      byId('refresh-version').hidden = false;
      byId('refresh-version').focus();
      return;
    }
    if (!response.ok) {
      const messages = { 401: 'Персональная ссылка больше недоступна. Запросите новую у команды обращения.', 403: 'Отправка недоступна. Обновите данные обращения и попробуйте снова.', 404: 'Обращение недоступно по этой ссылке.', 413: 'Фото слишком большое. Максимальный размер — 2 МБ.', 422: 'Проверьте комментарий и формат фото. Обновите данные обращения, если ошибка повторяется.', 429: 'Слишком много запросов. Подождите немного перед следующей попыткой.' };
      throw new Error(messages[response.status] || 'Не удалось отправить ответ. Ваши данные остались в форме — попробуйте ещё раз.');
    }
    success = true;
    pendingSubmission = null;
    form.reset();
    updateComment();
    updatePhoto();
    notice('feedback-notice', outcome === 'confirmed' ? 'Спасибо! Вы подтвердили, что проблема решена.' : 'Спасибо. Команда получила ваш ответ о нерешённой проблеме.');
    byId('feedback-notice').focus();
  } catch (error) {
    if (token !== requestToken) return;
    notice('feedback-notice', error.name === 'AbortError' ? 'Не удалось дождаться подтверждения. Ваш ответ мог сохраниться. Повторите отправку — дубликат не будет создан.' : error.message === 'Failed to fetch' ? 'Нет связи с сервером. Ваши данные остались в форме — попробуйте ещё раз.' : error.message, true);
    byId('feedback-notice').focus();
  } finally {
    clearTimeout(timeout);
    sending = false;
    byId('feedback-fields').disabled = false;
    byId('close-complaint').disabled = false;
    byId('refresh').disabled = false;
    byId('submit-feedback').textContent = 'Отправить ответ ↗';
    if (success && token === requestToken) await loadComplaint({ refresh: true, preserveNotice: true });
    else if (token !== requestToken) await loadComplaint();
  }
}
function start() {
  loadingRequest?.abort();
  loadingRequest = null;
  complaint = null;
  pendingSubmission = null;
  byId('access-link').value = '';
  notice('access-error', '');
  byId('complaint-content').hidden = true;
  byId('load-error').hidden = true;
  byId('access-state').hidden = true;
  byId('feedback-form').reset();
  updateComment();
  updatePhoto();
  notice('feedback-notice', '');
  notice('refresh-notice', '');
  const fragment = window.location.hash.slice(1);
  token = /^[a-fA-F0-9]{64}$/.test(fragment) ? fragment.toLowerCase() : '';
  if (!token) {
    byId('loading').hidden = true;
    byId('access-title').textContent = fragment ? 'Персональная ссылка неполная' : 'Откройте персональную ссылку';
    byId('access-copy').textContent = fragment ? 'Откройте исходную ссылку целиком, включая всё после знака #. Если это не помогло, запросите новую у команды обращения.' : 'Персональную ссылку выдаёт команда, которая приняла обращение. Вход в аккаунт не требуется.';
    byId('access-state').hidden = false;
    return;
  }
  loadComplaint();
}
function accessToken(value) {
  const input = value.trim();
  if (/^[a-fA-F0-9]{64}$/.test(input)) return input.toLowerCase();
  try {
    const url = new URL(input, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname !== '/resident.html' || !/^[a-fA-F0-9]{64}$/.test(url.hash.slice(1))) return '';
    return url.hash.slice(1).toLowerCase();
  } catch { return ''; }
}
byId('access-form').addEventListener('submit', event => {
  event.preventDefault();
  const value = accessToken(byId('access-link').value);
  if (!value) {
    notice('access-error', 'Вставьте полную персональную ссылку этого сайта или код из 64 символов после #. Проверьте, что ссылка скопирована целиком.', true);
    byId('access-link').setAttribute('aria-invalid', 'true');
    byId('access-link').focus();
    return;
  }
  byId('access-link').removeAttribute('aria-invalid');
  history.replaceState(null, '', `${window.location.pathname}#${value}`);
  start();
});
byId('access-link').addEventListener('input', () => { byId('access-link').removeAttribute('aria-invalid'); notice('access-error', ''); });
byId('close-complaint').addEventListener('click', () => {
  if (sending) return;
  history.replaceState(null, '', window.location.pathname);
  start();
  byId('access-link').focus();
});
byId('skip-content').addEventListener('click', () => byId('content').focus());
byId('retry-load').addEventListener('click', () => loadComplaint());
byId('refresh').addEventListener('click', () => loadComplaint({ refresh: true }));
byId('refresh-version').addEventListener('click', () => loadComplaint({ refresh: true }));
byId('feedback-form').addEventListener('change', updateComment);
byId('comment').addEventListener('input', updateComment);
byId('photo').addEventListener('change', updatePhoto);
byId('remove-photo').addEventListener('click', () => { byId('photo').value = ''; updatePhoto(); });
byId('feedback-form').addEventListener('submit', sendFeedback);
window.addEventListener('hashchange', start);
start();
