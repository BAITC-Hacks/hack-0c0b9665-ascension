const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const formatDate = value => new Date(value).toLocaleString('ru-RU');
async function request(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(path, {method, headers:{'Content-Type':'application/json','X-Desk-Request':'1'}, body:body === undefined ? undefined : JSON.stringify(body), signal:AbortSignal.timeout(15000)});
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || 'Не удалось выполнить действие. Повторите запрос.');
  return data;
}

/** Each card owns its controls, so a slow request cannot update another complaint. */
export function mountResidentTools(container, complaint, user) {
  const section = document.createElement('section');
  section.className = 'resident-tools';
  section.innerHTML = '<h3>Связь с жителем и публичный результат</h3><div class="resident-tools-content"></div><p class="resident-tools-status" role="status" aria-live="polite"></p>';
  container.append(section);
  const content = section.querySelector('.resident-tools-content');
  const status = section.querySelector('.resident-tools-status');
  const base = `/api/desk/resident/complaints/${complaint.id}`;
  const manager = ['admin','akim'].includes(user?.role);
  let working = false;
  async function action(button, callback) {
    if (working) return;
    working = true;
    const label = button.textContent;
    button.disabled = true; button.textContent = 'Подождите…'; status.textContent = '';
    try { await callback(); }
    catch (error) { status.textContent = /Timeout|Abort|fetch/i.test(error.message) ? 'Нет ответа от сервера. Данные формы сохранены — повторите действие.' : error.message; }
    finally { working = false; button.disabled = false; button.textContent = label; }
  }
  async function load() {
    content.textContent = 'Загружаем обратную связь…';
    const info = await request(base);
    if (!section.isConnected) return;
    const publication = info.publication;
    const published = publication?.active === true;
    const selected = (kind, id) => (publication?.[`${kind}AttachmentIds`] || []).includes(id);
    const photos = kind => complaint.attachments.map(photo => `<label class="publication-photo"><input type="checkbox" name="${kind}" value="${photo.id}"${selected(kind,photo.id) ? ' checked' : ''}><img src="/api/desk/attachments/${photo.id}" alt=""><span>${escape(photo.name)}</span></label>`).join('');
    content.innerHTML = `<p class="muted">Персональная ссылка открывает только это обращение, ответы и сроки. Она действует 90 дней. Передайте её самому жителю.</p>
      <p class="muted">${info.hasLink ? `Ссылка уже выдана, срок до ${escape(formatDate(info.expiresAt))}. Новая ссылка заменит прежнюю.` : 'Персональная ссылка ещё не создана.'}</p>
      <button type="button" data-link>${info.hasLink ? 'Заменить персональную ссылку' : 'Создать персональную ссылку'}</button>
      <div class="resident-link" hidden><label>Персональная ссылка<input readonly aria-label="Персональная ссылка"></label><div class="actions"><button type="button" data-copy>Копировать ссылку</button><a class="button" data-open target="_blank" rel="noopener noreferrer">Открыть страницу жителя</a></div><p class="muted">Сохраните ссылку сейчас. После закрытия карточки можно выпустить новую.</p></div>
      <h4>Обратная связь жителя</h4><div>${info.feedback.length ? info.feedback.map(feedback => `<article class="resident-feedback"><strong>${feedback.outcome === 'confirmed' ? 'Житель подтвердил решение' : 'Житель сообщил: проблема осталась'}</strong><p class="muted">${escape(formatDate(feedback.at))}</p><p class="detail-text">${escape(feedback.comment || 'Без комментария')}</p>${feedback.photo ? `<a href="/api/desk/attachments/${feedback.photo.id}" target="_blank" rel="noopener">Открыть фото жителя</a>` : ''}</article>`).join('') : '<p class="muted">Житель ещё не оценил результат.</p>'}</div>
      ${manager ? `<details class="publication"><summary>Публикация в «Что изменилось в городе»</summary><p class="muted">Публикуются только заполненные здесь текст и выбранные фотографии. Проверьте, что в них нет личных данных. Текст обращения и внутренние комментарии автоматически не переносятся.</p>
      ${complaint.status !== 'resolved' ? '<p>Публикация доступна после перевода обращения в статус «Решено».</p>' : ''}
      <form class="publication-form"><label>Публичный заголовок<input name="title" required maxlength="160" value="${escape(publication?.title || '')}" placeholder="Например: восстановили освещение в районе"></label><label>Описание выполненной работы<textarea name="summary" required maxlength="2000">${escape(publication?.summary || '')}</textarea></label>
      ${complaint.attachments.length ? `<fieldset><legend>Фотографии до</legend><div class="publication-photos">${photos('before')}</div></fieldset><fieldset><legend>Фотографии после</legend><div class="publication-photos">${photos('after')}</div></fieldset>` : '<p class="muted">Фотографий пока нет. Можно опубликовать результат без фото.</p>'}
      <button class="primary"${complaint.status !== 'resolved' ? ' disabled' : ''}>${published ? 'Обновить публикацию' : 'Опубликовать результат'}</button></form>
      ${published ? '<button type="button" data-unpublish>Снять с публикации</button>' : ''}<p><a href="/results.html" target="_blank" rel="noopener">Посмотреть публичную страницу</a></p></details>` : '<p class="muted">Публичный результат может опубликовать аким или администратор.</p>'}`;
    content.querySelector('[data-link]').onclick = event => action(event.currentTarget, async () => {
      const data = await request(`${base}/link`, {version:complaint.version});
      if (!section.isConnected) return;
      const url = `${location.origin}/resident.html#${data.token}`;
      const box = content.querySelector('.resident-link'); box.hidden = false;
      box.querySelector('input').value = url;
      box.querySelector('[data-open]').href = url;
      content.querySelector('[data-link]').textContent = 'Заменить персональную ссылку';
      status.textContent = `Ссылка создана. Действует до ${formatDate(data.expiresAt)}. Предыдущая ссылка больше не действует.`;
    });
    content.querySelector('[data-copy]').onclick = event => action(event.currentTarget, async () => {
      const input = content.querySelector('.resident-link input');
      try { await navigator.clipboard.writeText(input.value); status.textContent = 'Ссылка скопирована.'; }
      catch { input.focus(); input.select(); status.textContent = 'Ссылка выделена. Нажмите Ctrl+C или ⌘C, чтобы скопировать.'; }
    });
    const form = content.querySelector('.publication-form');
    if (form) form.onsubmit = event => {
      event.preventDefault();
      action(form.querySelector('button'), async () => {
        const data = new FormData(form);
        await request(`${base}/publication`, {version:complaint.version,title:data.get('title'),summary:data.get('summary'),beforeAttachmentIds:data.getAll('before').map(Number),afterAttachmentIds:data.getAll('after').map(Number)});
        await load(); status.textContent = 'Результат опубликован. Он доступен на публичной странице.';
      });
    };
    const remove = content.querySelector('[data-unpublish]');
    if (remove) remove.onclick = event => action(event.currentTarget, async () => {
      await request(`${base}/publication`, {version:complaint.version}, 'DELETE');
      await load(); status.textContent = 'Публикация скрыта. Обращение и фотографии сохранены в кабинете.';
    });
  }
  void load().catch(error => {
    content.textContent = '';
    status.textContent = error.message;
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Повторить загрузку обратной связи';
    retry.onclick = event => action(event.currentTarget,load); content.append(retry);
  });
}
