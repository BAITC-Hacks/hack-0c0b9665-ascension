import { api, labels, escapeHTML as esc, formatDate, labelFor, badge, renderTimeline } from './citizen.js';

const $ = id => document.getElementById(id);
let adminToken = '';
let complaints = [];
let selectedId = null;
let requestVersion = 0;
const drafts = new Map();
const pendingSaves = new Set();
const photoUrls = new Set();
const headers = () => adminToken ? { 'X-Admin-Token': adminToken } : {};
const optionsFor = (group, selected) => Object.entries(labels[group]).map(([value, label]) => `<option value="${value}"${selected === value ? ' selected' : ''}>${esc(label)}</option>`).join('');
const hasLocation = complaint => complaint.location && Number.isFinite(complaint.location.lat) && Number.isFinite(complaint.location.lon);
const priorityOf = complaint => complaint.priority || complaint.analysis?.priority || 'normal';
const announce = message => { $('announcer').textContent = message; };

function releasePhotos() {
  photoUrls.forEach(url => URL.revokeObjectURL(url));
  photoUrls.clear();
}

function setError(message) {
  $('load-error').textContent = message;
  $('load-error').hidden = !message;
}

function filteredQuery() {
  const params = new URLSearchParams();
  for (const [key, value] of new FormData($('filter-form'))) if (String(value).trim()) params.set(key, String(value).trim());
  return params.toString();
}

async function loadComplaints() {
  const version = ++requestVersion;
  $('complaints-list').setAttribute('aria-busy', 'true');
  $('refresh-button').disabled = true;
  setError('');
  try {
    const data = await api(`/api/complaints?${filteredQuery()}`, { headers: headers() });
    if (version !== requestVersion) return;
    complaints = Array.isArray(data.complaints) ? data.complaints : [];
    $('stat-total').textContent = complaints.length;
    $('stat-new').textContent = complaints.filter(item => item.status === 'new').length;
    $('stat-progress').textContent = complaints.filter(item => item.status === 'in_progress').length;
    $('stat-resolved').textContent = complaints.filter(item => item.status === 'resolved').length;
    $('results-count').textContent = `Найдено: ${complaints.length}`;
    if (!complaints.some(item => item.id === selectedId)) selectedId = null;
    renderList();
    renderMap();
    renderDetail();
    announce(`Список обновлён. Обращений: ${complaints.length}.`);
  } catch (error) {
    if (version !== requestVersion) return;
    const accessError = error.status === 401 || error.status === 403;
    setError(accessError ? 'Для доступа нужен действующий токен администратора. Откройте «Доступ к панели» и подключитесь.' : error.message);
    $('results-count').textContent = 'Не удалось загрузить';
    if (!complaints.length) $('complaints-list').innerHTML = `<div class="empty-state"><h3>${accessError ? 'Панель защищена' : 'Список недоступен'}</h3><p>${accessError ? 'Введите токен администратора выше.' : 'Проверьте соединение и нажмите «Обновить».'}</p></div>`;
    else $('results-count').textContent = 'Показаны предыдущие данные';
  } finally {
    if (version === requestVersion) {
      $('complaints-list').setAttribute('aria-busy', 'false');
      $('refresh-button').disabled = false;
    }
  }
}

function renderList() {
  if (!complaints.length) {
    $('complaints-list').innerHTML = '<div class="empty-state"><h3>Пока ничего не найдено</h3><p>Измените фильтры или дождитесь первого обращения от жителя.</p></div>';
    return;
  }
  $('complaints-list').innerHTML = complaints.map(complaint => `<button type="button" class="complaint-card" data-id="${esc(complaint.id)}" aria-pressed="${complaint.id === selectedId}"><span class="card-number"><span class="mono">${esc(complaint.id)}</span><time datetime="${esc(complaint.createdAt)}">${esc(formatDate(complaint.createdAt))}</time></span><span class="badge-row">${badge('status', complaint.status)}${badge('priority', priorityOf(complaint))}</span><h3>${esc(complaint.analysis?.summary || 'Обращение жителя')}</h3><span class="card-meta"><span>${esc(labelFor('category', complaint.analysis?.category, 'Другое'))}</span><span>${esc(labelFor('district', complaint.districtId, 'Район не указан'))}</span></span><span class="card-meta" style="display:block">${hasLocation(complaint) ? '↗ Координаты указаны' : '○ Без координат'}${complaint.assignee ? ` · ${esc(complaint.assignee)}` : ''}</span></button>`).join('');
  $('complaints-list').querySelectorAll('[data-id]').forEach(button => button.addEventListener('click', () => selectComplaint(button.dataset.id)));
}

function selectComplaint(id, fromMap = false) {
  selectedId = id;
  renderList();
  renderDetail();
  renderMap();
  if (fromMap || matchMedia('(max-width: 780px)').matches) {
    $('complaint-detail').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    $('complaint-detail').focus({ preventScroll: true });
  }
}

function currentFields(complaint) {
  return { status: complaint.status, assignee: complaint.assignee || '', resolution: complaint.resolution || '', priority: priorityOf(complaint), category: complaint.analysis?.category || 'other', summary: complaint.analysis?.summary || '', reason: complaint.analysis?.reason || '', duplicateOf: complaint.analysis?.duplicateOf || '' };
}

function setEditorBusy(form, busy) {
  form.querySelectorAll('input, select, textarea, button').forEach(control => { control.disabled = busy; });
  form.setAttribute('aria-busy', String(busy));
  if (busy) form.querySelector('#save-button').textContent = 'Сохраняем…';
}

function invalidatePendingLoads() {
  requestVersion += 1;
  $('complaints-list').setAttribute('aria-busy', 'false');
  $('refresh-button').disabled = false;
}

function renderDetail() {
  releasePhotos();
  const complaint = complaints.find(item => item.id === selectedId);
  window.dispatchEvent(new CustomEvent('mayor:selection', { detail: complaint ? { location: complaint.location, address: complaint.address, id: complaint.id } : null }));
  if (!complaint) {
    $('complaint-detail').innerHTML = '<div class="empty-state detail-placeholder"><span aria-hidden="true">↗</span><h3>Каждое сообщение имеет значение</h3><p>Выберите обращение, чтобы увидеть подробности и назначить следующий шаг.</p></div>';
    return;
  }
  const analysis = complaint.analysis || {};
  const draft = drafts.get(complaint.id);
  const values = { ...currentFields(complaint), ...draft?.fields };
  const photos = (complaint.attachments || []).filter(item => item.type === 'photo');
  $('complaint-detail').innerHTML = `<div class="detail-header"><div><div class="detail-number mono">${esc(complaint.id)}</div><h3>${esc(analysis.summary || 'Обращение жителя')}</h3></div></div><div class="badge-row">${badge('status', complaint.status)}${badge('priority', priorityOf(complaint))}<span class="badge">${complaint.source === 'telegram' ? 'Telegram' : 'Веб-форма'}</span></div><div class="detail-meta"><div><strong>Район</strong>${esc(labelFor('district', complaint.districtId, 'Не указан'))}</div><div><strong>Тема</strong>${esc(labelFor('category', analysis.category, 'Другое'))}</div><div><strong>Адрес / ориентир</strong>${esc(complaint.address || 'Не указан')}</div><div><strong>Координаты</strong>${hasLocation(complaint) ? `${esc(complaint.location.lat.toFixed(5))}, ${esc(complaint.location.lon.toFixed(5))}` : 'Не указаны'}</div></div><div class="original-text">${esc(complaint.text || 'Текст не передан')}</div>${photos.length ? `<div class="photo-grid">${photos.map((photo, i) => `<figure><button type="button" class="button secondary photo-load" data-photo-index="${Number.isInteger(photo.index) ? photo.index : i}">Загрузить фото ${i + 1}</button><figcaption>Фото из обращения · ${i + 1}</figcaption></figure>`).join('')}</div>` : ''}<div class="analysis-note"><strong>${analysis.reviewed ? 'Классификация проверена сотрудником' : 'Предварительная классификация по локальным правилам'}</strong><p>${esc(analysis.reason || 'Причина приоритета не указана.')}</p>${analysis.duplicateOf ? `<p>Возможный повтор обращения: <span class="mono">${esc(analysis.duplicateOf)}</span></p>` : ''}<p>Локальные правила не являются ИИ-анализом.</p></div><form id="edit-form" class="edit-section"><h4>Следующий шаг</h4><div class="two-fields"><div><label for="edit-status">Статус</label><select id="edit-status" name="status">${optionsFor('status', values.status)}</select></div><div><label for="edit-priority">Приоритет</label><select id="edit-priority" name="priority">${optionsFor('priority', values.priority)}</select></div></div><label for="edit-assignee">Ответственный</label><input id="edit-assignee" name="assignee" maxlength="120" value="${esc(values.assignee)}" placeholder="Подразделение или сотрудник"><label for="edit-resolution">Решение / результат</label><textarea id="edit-resolution" name="resolution" maxlength="2000" rows="3" placeholder="Что сделано или почему обращение отклонено">${esc(values.resolution)}</textarea><p class="field-hint">Решение увидит житель. Для статусов «Решено» и «Отклонено» оно обязательно.</p><details class="analysis-edit"><summary>Проверить и исправить классификацию</summary><label for="edit-category">Тема обращения</label><select id="edit-category" name="category">${optionsFor('category', values.category)}</select><label for="edit-summary">Краткое описание</label><textarea id="edit-summary" name="summary" maxlength="500" rows="2">${esc(values.summary)}</textarea><label for="edit-reason">Обоснование приоритета</label><textarea id="edit-reason" name="reason" maxlength="1000" rows="2">${esc(values.reason)}</textarea><label for="edit-duplicate">Связь с повторным обращением</label><input id="edit-duplicate" name="duplicateOf" value="${esc(values.duplicateOf)}" maxlength="120" placeholder="Номер исходного обращения"><p class="field-hint">Оставьте пустым, если это самостоятельное обращение. Исправления отмечаются как проверенные сотрудником.</p></details><p id="edit-message" class="notice" role="status" hidden></p><button id="save-button" type="submit" class="button primary wide">Сохранить изменения <span aria-hidden="true">✓</span></button><p class="field-hint" id="draft-hint">${drafts.has(complaint.id) ? 'Есть несохранённые изменения в этой вкладке.' : 'Изменения попадут в историю обращения.'}</p></form><h4 class="history-heading">История рассмотрения</h4>${renderTimeline(complaint.history)}`;
  const editForm = $('edit-form');
  const discardButton = document.createElement('button');
  discardButton.type = 'button';
  discardButton.className = 'button subtle wide';
  discardButton.textContent = 'Отменить мои правки';
  discardButton.hidden = !draft;
  editForm.insertBefore(discardButton, $('draft-hint'));
  discardButton.addEventListener('click', () => {
    drafts.delete(complaint.id);
    renderDetail();
    loadComplaints();
  });
  if (draft && draft.baseUpdatedAt !== complaint.updatedAt) {
    $('edit-message').hidden = false;
    $('edit-message').className = 'notice error';
    $('edit-message').textContent = 'Обращение обновилось после начала ваших правок. Ваши изменения сохранены в этой вкладке. Скопируйте нужный текст и отмените правки, чтобы работать с актуальной версией.';
  }
  const captureDraft = event => {
    const field = event.target.name;
    if (!Object.hasOwn(currentFields(complaint), field)) return;
    const next = drafts.get(complaint.id) || { fields: {}, baseFields: currentFields(complaint), baseUpdatedAt: complaint.updatedAt };
    if (event.target.value.trim() === next.baseFields[field]) delete next.fields[field];
    else next.fields[field] = event.target.value;
    if (Object.keys(next.fields).length) drafts.set(complaint.id, next);
    else drafts.delete(complaint.id);
    discardButton.hidden = !drafts.has(complaint.id);
    $('draft-hint').textContent = drafts.has(complaint.id) ? 'Есть несохранённые изменения в этой вкладке.' : 'Изменения попадут в историю обращения.';
    $('edit-resolution').required = ['resolved', 'rejected'].includes($('edit-status').value);
  };
  $('edit-resolution').required = ['resolved', 'rejected'].includes(values.status);
  editForm.addEventListener('input', captureDraft);
  editForm.addEventListener('change', captureDraft);
  editForm.addEventListener('submit', event => saveComplaint(event, complaint));
  if (pendingSaves.has(complaint.id)) setEditorBusy(editForm, true);
  $('complaint-detail').querySelectorAll('.photo-load').forEach(button => button.addEventListener('click', () => loadPhoto(button, complaint.id)));
}

async function saveComplaint(event, complaint) {
  event.preventDefault();
  if (pendingSaves.has(complaint.id)) return;
  const editForm = event.currentTarget;
  const formValues = Object.fromEntries(new FormData(editForm));
  const original = currentFields(complaint);
  const patch = {};
  for (const [key, value] of Object.entries(formValues)) {
    const clean = value.trim();
    if (clean !== original[key]) patch[key] = key === 'duplicateOf' ? clean || null : clean;
  }
  const message = $('edit-message');
  message.hidden = false;
  message.className = 'notice';
  if (!Object.keys(patch).length) { message.textContent = 'Изменений нет — карточка уже актуальна.'; return; }
  if (['resolved', 'rejected'].includes(formValues.status) && !formValues.resolution.trim()) {
    message.className = 'notice error';
    message.textContent = 'Добавьте решение, прежде чем закрыть обращение.';
    $('edit-resolution').focus();
    return;
  }
  const draft = drafts.get(complaint.id) || { fields: Object.fromEntries(Object.keys(patch).map(key => [key, formValues[key]])), baseFields: original, baseUpdatedAt: complaint.updatedAt };
  drafts.set(complaint.id, draft);
  patch.expectedUpdatedAt = draft.baseUpdatedAt;
  pendingSaves.add(complaint.id);
  invalidatePendingLoads();
  setEditorBusy(editForm, true);
  message.textContent = 'Сохраняем изменения…';
  try {
    const data = await api(`/api/complaints/${encodeURIComponent(complaint.id)}`, { method: 'PATCH', headers: headers(), body: JSON.stringify(patch) });
    invalidatePendingLoads();
    pendingSaves.delete(complaint.id);
    drafts.delete(complaint.id);
    const index = complaints.findIndex(item => item.id === complaint.id);
    if (index !== -1 && data.complaint) complaints[index] = data.complaint;
    if (selectedId === complaint.id) {
      renderDetail();
      const savedMessage = $('edit-message');
      savedMessage.hidden = false;
      savedMessage.className = 'notice success';
      savedMessage.textContent = 'Изменения сохранены.';
      if (data.notification?.state === 'failed') savedMessage.textContent += ' Уведомление в Telegram не доставлено; данные сохранены.';
      if (data.notification?.state === 'not_configured') savedMessage.textContent += ' Telegram не настроен; уведомление жителю не отправлено.';
    }
    renderList();
    renderMap();
    // Refresh counts without discarding the saved card or another record's draft.
    $('stat-total').textContent = complaints.length;
    $('stat-new').textContent = complaints.filter(item => item.status === 'new').length;
    $('stat-progress').textContent = complaints.filter(item => item.status === 'in_progress').length;
    $('stat-resolved').textContent = complaints.filter(item => item.status === 'resolved').length;
    announce('Изменения сохранены. Обновите список, чтобы повторно применить фильтры.');
  } catch (error) {
    invalidatePendingLoads();
    pendingSaves.delete(complaint.id);
    if (selectedId === complaint.id) {
      renderDetail();
      const errorMessage = $('edit-message');
      errorMessage.hidden = false;
      errorMessage.className = 'notice error';
      errorMessage.textContent = `${error.message} Введённые изменения сохранены в этой вкладке.`;
    }
  }
}

async function loadPhoto(button, id) {
  button.disabled = true;
  button.textContent = 'Загружаем фото…';
  try {
    const response = await fetch(`/api/complaints/${encodeURIComponent(id)}/photos/${button.dataset.photoIndex}`, { headers: headers() });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Нет доступа к фото' : 'Фото недоступно');
    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) throw new Error('Сервер не вернул изображение');
    if (selectedId !== id || !button.isConnected) return;
    const url = URL.createObjectURL(blob);
    photoUrls.add(url);
    const img = document.createElement('img');
    img.src = url;
    img.alt = `Фото из обращения ${id}`;
    img.addEventListener('error', () => { img.replaceWith(document.createTextNode('Не удалось показать фото.')); URL.revokeObjectURL(url); photoUrls.delete(url); }, { once: true });
    button.replaceWith(img);
  } catch (error) {
    if (button.isConnected) { button.disabled = false; button.textContent = `${error.message}. Повторить`; }
  }
}

function renderMap() {
  const located = complaints.filter(hasLocation);
  $('located-count').textContent = located.length;
  $('unlocated-count').textContent = complaints.length - located.length;
  if (!located.length) {
    $('complaints-map').innerHTML = '<div class="empty-state"><h3>Нет точек на схеме</h3><p>В текущей выборке нет обращений с координатами. Они по-прежнему доступны в списке.</p></div>';
    return;
  }
  let minLat = Math.min(...located.map(item => item.location.lat));
  let maxLat = Math.max(...located.map(item => item.location.lat));
  let minLon = Math.min(...located.map(item => item.location.lon));
  let maxLon = Math.max(...located.map(item => item.location.lon));
  const latPad = Math.max((maxLat - minLat) * .15, .005);
  const lonPad = Math.max((maxLon - minLon) * .15, .008);
  minLat -= latPad; maxLat += latPad; minLon -= lonPad; maxLon += lonPad;
  const groups = new Map();
  located.forEach(item => {
    const key = `${item.location.lat},${item.location.lon}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  const grouped = [...groups.values()];
  $('complaints-map').innerHTML = `<span class="map-caption">↑ Север · схема, не карта районов</span><span class="map-axis north">${maxLat.toFixed(3)}° шир.</span><span class="map-axis south">${minLat.toFixed(3)}° шир.</span><span class="map-axis west">${minLon.toFixed(3)}° долг.</span><span class="map-axis east">${maxLon.toFixed(3)}° долг.</span><div class="map-plane">${grouped.map((group, index) => {
    const selected = group.find(item => item.id === selectedId);
    const item = selected || group.find(entry => priorityOf(entry) === 'high') || group[0];
    const x = ((item.location.lon - minLon) / (maxLon - minLon) * 100).toFixed(4);
    const y = ((maxLat - item.location.lat) / (maxLat - minLat) * 100).toFixed(4);
    const title = group.length > 1 ? `${group.length} обращений в одной точке. Нажимайте для переключения: ${group.map(entry => entry.id).join(', ')}` : `${item.id}: ${item.analysis?.summary || 'Обращение'}; ${labelFor('priority', priorityOf(item))} приоритет`;
    return `<button type="button" class="map-point ${esc(priorityOf(item))}" data-group="${index}" style="left:${x}%;top:${y}%" aria-label="${esc(title)}" title="${esc(title)}" aria-pressed="${Boolean(selected)}">${group.length > 1 ? group.length : '<span aria-hidden="true">•</span>'}</button>`;
  }).join('')}</div>`;
  $('complaints-map').querySelectorAll('[data-group]').forEach(button => button.addEventListener('click', () => {
    const group = grouped[Number(button.dataset.group)];
    const currentIndex = group.findIndex(item => item.id === selectedId);
    selectComplaint(group[(currentIndex + 1) % group.length].id, true);
  }));
}

$('filter-form').addEventListener('submit', event => { event.preventDefault(); loadComplaints(); });
$('filter-form').querySelectorAll('select').forEach(select => select.addEventListener('change', loadComplaints));
$('reset-filters').addEventListener('click', () => { $('filter-form').reset(); loadComplaints(); });
$('refresh-button').addEventListener('click', loadComplaints);
$('access-form').addEventListener('submit', event => {
  event.preventDefault();
  adminToken = $('admin-token').value.trim();
  $('admin-token').value = '';
  complaints = [];
  selectedId = null;
  drafts.clear();
  renderDetail();
  loadComplaints();
});
$('clear-token').addEventListener('click', () => {
  adminToken = '';
  $('admin-token').value = '';
  complaints = [];
  drafts.clear();
  selectedId = null;
  releasePhotos();
  renderList();
  renderDetail();
  renderMap();
  ['stat-total', 'stat-new', 'stat-progress', 'stat-resolved'].forEach(id => { $(id).textContent = '—'; });
  announce('Токен очищен из памяти вкладки.');
  loadComplaints();
});
window.addEventListener('pagehide', releasePhotos);
api('/api/citizen/config').then(config => {
  $('admin-mode').textContent = config.adminConfigured ? 'Защищённая панель · введите токен администратора для доступа.' : config.demoMode ? 'Локальное демо · доступ без токена разрешён только с этого компьютера.' : 'Для удалённого доступа требуется настроенный токен администратора.';
}).catch(() => { $('admin-mode').textContent = 'Не удалось определить режим доступа. При запросе авторизации введите токен администратора.'; });
loadComplaints();
