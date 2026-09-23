export const labels = {
  status: { new: 'Новое', in_progress: 'В работе', resolved: 'Решено', rejected: 'Отклонено' },
  priority: { high: 'Высокий', normal: 'Обычный', low: 'Низкий' },
  category: { roads: 'Дороги', utilities: 'Коммунальные услуги', waste: 'Мусор', lighting: 'Освещение', safety: 'Безопасность', other: 'Другое' },
  district: { esil: 'Есиль', almaty: 'Алматы', saryarka: 'Сарыарка', baikonur: 'Байконыр', nura: 'Нура' }
};

export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export const formatDate = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Дата не указана' : new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
};
export const labelFor = (group, value, fallback = 'Не указано') => labels[group]?.[value] || fallback;
export const badge = (group, value) => `<span class="badge ${group}-${escapeHTML(Object.hasOwn(labels[group] || {}, value) ? value : 'unknown')}">${escapeHTML(labelFor(group, value))}</span>`;

export async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  } catch {
    throw new Error('Не удалось связаться с сервером. Проверьте подключение и попробуйте ещё раз.');
  }
  let data;
  try { data = await response.json(); } catch { throw new Error('Сервер вернул непонятный ответ. Попробуйте обновить страницу позже.'); }
  if (!response.ok) {
    const supplied = (Array.isArray(data.errors) ? data.errors.map(item => item?.message).filter(Boolean).join(' ') : '') || (typeof data.error === 'string' ? data.error : data.error?.message || data.message);
    const error = new Error(supplied || `Не удалось выполнить запрос (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export function renderTimeline(history = [], { publicView = false } = {}) {
  if (!Array.isArray(history) || !history.length) return '<p class="field-hint">История пока пуста.</p>';
  return `<ol class="timeline">${history.map(item => `<li><strong>${escapeHTML(labelFor('status', item.status, 'Обращение обновлено'))}</strong><time datetime="${escapeHTML(item.at)}">${escapeHTML(formatDate(item.at))}</time>${!publicView && item.assignee ? `<p>Ответственный: ${escapeHTML(item.assignee)}</p>` : ''}${item.resolution ? `<p>${escapeHTML(item.resolution)}</p>` : ''}${!publicView && item.note ? `<p>${escapeHTML(item.note)}</p>` : ''}</li>`).join('')}</ol>`;
}

function initCitizen() {
  const $ = id => document.getElementById(id);
  const form = $('complaint-form');
  let receiptLink = '';
  const showError = (id, message) => { $(id).textContent = message; $(id).hidden = !message; };

  $('complaint-text').addEventListener('input', () => { $('text-count').textContent = `${$('complaint-text').value.length} / 5000`; });
  $('location-button').addEventListener('click', () => {
    if (!navigator.geolocation) { $('location-message').textContent = 'Браузер не поддерживает геолокацию. Координаты можно ввести вручную.'; return; }
    $('location-button').disabled = true;
    $('location-message').textContent = 'Ожидаем разрешение браузера и определяем координаты…';
    navigator.geolocation.getCurrentPosition(position => {
      $('latitude').value = position.coords.latitude.toFixed(6);
      $('longitude').value = position.coords.longitude.toFixed(6);
      $('location-message').textContent = `Координаты добавлены. Точность устройства — около ${Math.round(position.coords.accuracy)} м. Проверьте, что это место проблемы.`;
      $('location-button').disabled = false;
    }, error => {
      $('location-message').textContent = error.code === 1 ? 'Доступ к местоположению не разрешён. Можно указать координаты вручную или отправить без них.' : 'Не удалось определить координаты. Можно указать их вручную или отправить без них.';
      $('location-button').disabled = false;
    }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 60000 });
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    showError('submit-error', '');
    const lat = $('latitude').value.trim();
    const lon = $('longitude').value.trim();
    if (Boolean(lat) !== Boolean(lon)) { showError('submit-error', 'Укажите обе координаты или оставьте оба поля пустыми.'); return; }
    const payload = { text: $('complaint-text').value.trim(), address: $('address').value.trim(), districtId: $('district').value, consent: $('consent').checked };
    if (payload.text.length < 10) { showError('submit-error', 'Опишите проблему подробнее: нужно не меньше 10 символов.'); return; }
    if (lat && lon) payload.location = { lat: Number(lat), lon: Number(lon) };
    $('submit-button').disabled = true;
    $('submit-button').textContent = 'Отправляем…';
    try {
      const data = await api('/api/complaints', { method: 'POST', body: JSON.stringify(payload) });
      if (!data.complaint?.id || !data.trackingToken) throw new Error('Ответ не содержит квитанцию. Обращение могло сохраниться; обратитесь к администратору перед повторной отправкой.');
      $('receipt-id').textContent = data.complaint.id;
      $('receipt-token').textContent = data.trackingToken;
      $('tracking-id').value = data.complaint.id;
      $('tracking-token').value = data.trackingToken;
      receiptLink = `${location.origin}/citizens.html#${new URLSearchParams({ id: data.complaint.id, token: data.trackingToken })}`;
      form.hidden = true;
      $('receipt').hidden = false;
      $('receipt').focus();
      renderTracking(data.complaint);
      form.reset();
      $('text-count').textContent = '0 / 5000';
      $('location-message').textContent = '';
    } catch (error) {
      showError('submit-error', `${error.message} Введённые данные остались в форме.`);
    } finally {
      $('submit-button').disabled = false;
      $('submit-button').innerHTML = 'Отправить обращение <span aria-hidden="true">↗</span>';
    }
  });

  $('another-complaint').addEventListener('click', () => {
    $('receipt').hidden = true;
    form.hidden = false;
    $('copy-message').textContent = '';
    $('complaint-text').focus();
  });
  $('copy-receipt').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(receiptLink);
      $('copy-message').textContent = 'Ссылка скопирована. Сохраните её в надёжном месте.';
    } catch {
      $('copy-message').textContent = 'Браузер не разрешил копирование. Сохраните номер и личный код из квитанции вручную.';
    }
  });

  function renderTracking(complaint) {
    // This view deliberately renders only explicit public fields, even if a server response is overbroad.
    $('tracking-result').innerHTML = `<div class="badge-row">${badge('status', complaint.status)}</div><h3>Обращение принято в систему</h3><p class="field-hint mono">${escapeHTML(complaint.id)}</p><p class="field-hint">Создано ${escapeHTML(formatDate(complaint.createdAt))}</p>${complaint.resolution ? `<div class="resolution-box"><strong>Решение по обращению</strong>${escapeHTML(complaint.resolution)}</div>` : '<p class="field-hint">Итоговое решение появится здесь после рассмотрения.</p>'}${renderTimeline(complaint.history, { publicView: true })}`;
    $('tracking-result').hidden = false;
  }

  $('tracking-form').addEventListener('submit', async event => {
    event.preventDefault();
    showError('tracking-error', '');
    $('tracking-result').hidden = true;
    $('tracking-button').disabled = true;
    $('tracking-button').textContent = 'Проверяем…';
    try {
      const data = await api('/api/complaints/track', { method: 'POST', body: JSON.stringify({ id: $('tracking-id').value.trim(), trackingToken: $('tracking-token').value.trim() }) });
      renderTracking(data.complaint);
    } catch (error) {
      showError('tracking-error', error.status === 404 ? 'Обращение не найдено. Проверьте номер и личный код из квитанции.' : error.message);
    } finally {
      $('tracking-button').disabled = false;
      $('tracking-button').innerHTML = 'Проверить статус <span aria-hidden="true">→</span>';
    }
  });

  api('/api/citizen/config').then(config => {
    $('mode-note').textContent = `${config.demoMode ? 'Локальное демо' : 'Сервис обращений'} · классификация по локальным правилам, решение проверяет сотрудник. Это не подтверждённый ИИ-анализ.`;
    if (config.telegramUrl) {
      let url;
      try { url = new URL(config.telegramUrl); } catch { /* Invalid config stays unavailable. */ }
      if (url?.protocol === 'https:' && ['t.me', 'telegram.me'].includes(url.hostname)) {
        $('telegram-link').href = url.href;
        $('telegram-link').hidden = false;
        $('telegram-note').textContent = 'Можно отправить текст и фотографию через бота.';
        return;
      }
    }
    $('telegram-note').textContent = 'Telegram пока не подключён. Обращение можно отправить через форму.';
  }).catch(() => { $('telegram-note').textContent = 'Не удалось проверить подключение Telegram. Используйте форму на сайте.'; });

  if (location.hash.length > 1) {
    const params = new URLSearchParams(location.hash.slice(1));
    const id = params.get('id');
    const token = params.get('token') || params.get('trackingToken');
    // The fragment is never sent to the HTTP server; remove it from the visible URL after reading.
    if (id && token) {
      $('tracking-id').value = id;
      $('tracking-token').value = token;
      history.replaceState(null, '', `${location.pathname}${location.search}`);
      $('tracking-form').requestSubmit();
    }
  }
}

if (document.body.dataset.page === 'citizens') initCitizen();
