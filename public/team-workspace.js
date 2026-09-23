// Explicit synchronization only. Access keys are never saved by this module.
const ROLES = { owner: 'Владелец', editor: 'Редактор', viewer: 'Просмотр' };
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const boundedText = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200;
const clone = (value) => JSON.parse(JSON.stringify(value));
const validIdentity = (value) => record(value) && boundedText(value.id) && boundedText(value.name)
  && Object.hasOwn(ROLES, value.role);
const validDocument = (value) => record(value) && value.schemaVersion === 2 && Array.isArray(value.registers);
const validEnvelope = (value) => record(value) && Number.isSafeInteger(value.revision)
  && value.revision >= 0 && validDocument(value.document);

class WorkspaceError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** getDocument/applyDocument own local validation and persistence; this panel owns no storage. */
export function mountTeamWorkspace(container, { getDocument, applyDocument, fetcher = globalThis.fetch } = {}) {
  const document = container.ownerDocument;
  const view = document.defaultView ?? globalThis;
  const hooksReady = typeof getDocument === 'function' && typeof applyDocument === 'function';
  let identity = null;
  let revision = null;
  let enabled = true;
  let busy = false;
  let disposed = false;
  let controller = null;
  let timeout = null;
  let confirmPull = false;
  let remotePreview = null;
  let downloadedUrl = null;

  const make = (tag, className, content) => {
    const element = document.createElement(tag);
    if (className) element.className = `team-workspace-${className}`;
    if (content !== undefined) element.textContent = content;
    return element;
  };
  const button = (className, label, action) => {
    const element = make('button', className, label);
    element.type = 'button';
    element.addEventListener('click', action);
    return element;
  };
  const root = make('details');
  root.className = 'team-workspace';
  const summary = make('summary', 'summary', 'Командный реестр · Проверяем доступ…');
  const content = make('div', 'content');
  const heading = make('h2', 'title', 'Общий реестр поручений');
  const description = make('p', 'help', 'Получайте общую версию и публикуйте локальные изменения вручную. Автоматической синхронизации нет.');
  const state = make('p', 'identity');
  const message = make('p', 'message');
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  const missingHooks = make('p', 'warning', 'Локальный реестр ещё не подключён к этой панели. Получение, публикация и резервная копия недоступны.');
  missingHooks.hidden = hooksReady;

  const login = make('form', 'login');
  login.autocomplete = 'off';
  const label = make('label', 'field', 'Ключ доступа от оператора');
  const key = make('input', 'key');
  key.type = 'password';
  key.autocomplete = 'off';
  key.maxLength = 512;
  key.required = true;
  key.spellcheck = false;
  label.append(key);
  const connect = make('button', 'connect', 'Подключиться');
  connect.type = 'submit';
  login.append(label, connect);
  login.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy || !enabled || disposed) return;
    const accessKey = key.value;
    key.value = '';
    if (!accessKey) { setMessage('Введите ключ доступа, полученный от оператора.'); return; }
    run(async () => {
      const data = await request('/session', 'POST', { accessKey });
      setSession(data);
      setMessage('Доступ открыт. Сначала получите общую версию. Локальный реестр пока не изменён.');
    });
  });

  const controls = make('div', 'controls');
  const backup = button('backup', 'Скачать локальную копию', downloadBackup);
  const pull = button('pull', 'Получить общую версию', () => {
    if (!identity || busy || !hooksReady) return;
    void run(pullDocument).then(() => { if (!disposed && confirmPull) replace.focus?.(); });
  });
  const publish = button('publish', 'Опубликовать изменения', () => run(publishDocument));
  const audit = button('audit', 'Журнал изменений', () => run(loadAudit));
  controls.append(backup, pull, publish, audit);

  const confirmation = make('div', 'confirmation');
  const preview = make('p', 'preview');
  const warning = make('p', 'warning', 'Выберите, какую копию продолжить редактировать. Замена локального реестра удалит его текущие правки из браузера: при необходимости сначала скачайте копию. Автоматического объединения двух версий нет.');
  const replace = button('replace', 'Заменить локальный реестр общей версией', () => run(replaceLocal));
  const acknowledgement = make('label', 'acknowledgement');
  const acknowledge = make('input', 'acknowledge');
  acknowledge.type = 'checkbox';
  acknowledge.checked = false;
  acknowledge.addEventListener('change', update);
  acknowledgement.append(acknowledge, make('span', '', 'Я понимаю: публикация локальной копии целиком заменит общий реестр, включая чужие правки.'));
  const keep = button('keep', 'Оставить локальный реестр для публикации', () => {
    if (busy || !remotePreview || !identity || identity.role === 'viewer' || !acknowledge.checked) return;
    try { localDocument(); }
    catch (error) { failure(error); return; }
    revision = remotePreview.revision;
    resetPreview();
    setMessage(`Локальные правки сохранены. При публикации они целиком заменят общую версию ${revision}; автоматического объединения нет.`);
    update();
  });
  const cancel = button('cancel', 'Отмена', () => { resetPreview(); update(); pull.focus?.(); });
  confirmation.append(preview, warning, replace, acknowledgement, keep, cancel);

  const sessionControls = make('div', 'controls');
  const refresh = button('refresh', 'Проверить доступ', () => run(checkSession));
  const logout = button('logout', 'Выйти', () => run(async () => {
    await request('/session', 'DELETE');
    identity = null;
    revision = null;
    resetPreview();
    journal.replaceChildren();
    setMessage('Вы вышли. Локальный реестр сохранён в этом браузере.');
  }));
  sessionControls.append(refresh, logout);
  const journal = make('div', 'journal');
  const privacy = make('details', 'explanation');
  privacy.append(make('summary', '', 'Что подтверждает общий реестр'));
  privacy.append(make('p', 'help', 'Роль выдаёт сервер. Имя в журнале — метка доступа, заданная оператором; она не подтверждает личность пользователя. Общий ключ может использоваться несколькими людьми. Статусы поручений и сведения паспорта остаются ручными и не означают официального согласования или фактического выполнения.'));
  content.append(heading, description, state, message, missingHooks, login, controls, confirmation, sessionControls, journal, privacy);
  root.append(summary, content);
  container.append(root);

  function setMessage(value, error = false) {
    if (disposed) return;
    message.textContent = value;
    message.className = `team-workspace-message${error ? ' team-workspace-error' : ''}`;
  }

  function update() {
    if (disposed) return;
    summary.textContent = `Командный реестр · ${!enabled ? 'Выключен' : identity ? ROLES[identity.role] : busy ? 'Проверяем доступ…' : 'Не подключён'}`;
    state.textContent = identity
      ? `${identity.name} · ${ROLES[identity.role]}. ${revision === null ? 'Общая версия ещё не получена.' : `Получена версия ${revision}.`}`
      : !enabled ? 'Общее хранение выключено. Оператору нужно настроить серверный доступ.' : 'Подключитесь ключом, выданным оператором.';
    login.hidden = !enabled || Boolean(identity);
    key.disabled = busy;
    connect.disabled = busy || !enabled;
    backup.disabled = busy || !hooksReady;
    pull.disabled = busy || !identity || !hooksReady;
    publish.disabled = busy || !identity || identity.role === 'viewer' || revision === null || !hooksReady || confirmPull;
    audit.disabled = busy || !identity;
    refresh.disabled = busy;
    logout.disabled = busy || !identity;
    logout.hidden = !identity;
    confirmation.hidden = !confirmPull;
    replace.disabled = busy || !identity || !hooksReady;
    keep.disabled = busy || !identity || identity.role === 'viewer' || !hooksReady || !acknowledge.checked;
    acknowledge.disabled = busy || !identity || identity.role === 'viewer';
    cancel.disabled = busy;
    content.setAttribute('aria-busy', String(busy));
  }

  async function request(path, method = 'GET', body) {
    const signal = controller?.signal;
    const response = await fetcher(`/api/workspace${path}`, {
      method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
      ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    if (disposed || signal?.aborted) throw new WorkspaceError(499, 'Cancelled');
    if (!response.ok) throw new WorkspaceError(response.status, 'Request rejected');
    if (response.status === 204) return null;
    try {
      const data = await response.json();
      if (disposed || signal?.aborted) throw new WorkspaceError(499, 'Cancelled');
      return data;
    }
    catch { throw new WorkspaceError(502, 'Invalid response'); }
  }

  function setSession(data) {
    if (data?.enabled !== true || !validIdentity(data.identity)) throw new WorkspaceError(502, 'Invalid session');
    // A new identity or refreshed session must read the shared revision again.
    identity = { ...data.identity };
    enabled = true;
    revision = null;
    resetPreview();
    journal.replaceChildren();
  }

  async function checkSession() {
    const data = await request('/session');
    setSession(data);
    setMessage('Доступ подтверждён. Получите общую версию перед публикацией.');
  }

  function localDocument() {
    try {
      const value = getDocument();
      if (!validDocument(value)) throw new Error('Invalid local document');
      return clone(value);
    } catch {
      throw new WorkspaceError(0, 'Не удалось прочитать локальный реестр. Проверьте его данные и доступность хранения.');
    }
  }

  async function pullDocument() {
    if (!identity || !hooksReady) return;
    revision = null;
    resetPreview();
    const data = await request('/register');
    if (!validEnvelope(data)) throw new WorkspaceError(502, 'Invalid document');
    remotePreview = clone(data);
    confirmPull = true;
    const actionCount = data.document.registers.reduce((sum, entry) => sum + (Array.isArray(entry?.actions) ? entry.actions.length : 0), 0);
    preview.textContent = `Общая версия ${data.revision}: реестров — ${data.document.registers.length}, поручений — ${actionCount}.`;
    setMessage('Общая версия получена для просмотра. Локальный реестр не изменён. Выберите дальнейшее действие.');
  }

  function resetPreview() {
    confirmPull = false;
    remotePreview = null;
    acknowledge.checked = false;
  }

  async function replaceLocal() {
    if (!identity || !hooksReady || !confirmPull || !remotePreview) return;
    const data = remotePreview;
    // The supplied hook validates the full schema and persists atomically before replacing its UI.
    try { await applyDocument(clone(data.document)); }
    catch { throw new WorkspaceError(0, 'Локальный реестр не смог принять общую версию. Проверьте данные и доступность хранения; публикация заблокирована.'); }
    if (disposed) return;
    revision = data.revision;
    resetPreview();
    setMessage(`Общая версия ${revision} получена. Локальный реестр заменён после вашего подтверждения.`);
  }

  async function publishDocument() {
    if (!identity || identity.role === 'viewer' || revision === null || !hooksReady || confirmPull) return;
    const documentToSend = localDocument();
    const expectedRevision = revision;
    // A failed response can follow a committed write; reconcile before another publication.
    revision = null;
    const data = await request('/register', 'PUT', { expectedRevision, document: documentToSend });
    if (!validEnvelope(data) || data.revision <= expectedRevision) throw new WorkspaceError(502, 'Invalid revision');
    revision = data.revision;
    let changed = true;
    try { changed = JSON.stringify(localDocument()) !== JSON.stringify(documentToSend); } catch { /* preserve local state */ }
    setMessage(`Опубликована версия ${revision}.${changed ? ' В браузере есть более поздние локальные правки: они пока не опубликованы.' : ' Локальная копия сохранена.'}`);
  }

  async function loadAudit() {
    if (!identity) return;
    const data = await request('/audit');
    if (!Array.isArray(data?.entries) || data.entries.length > 1000 || data.entries.some((entry) =>
      !Number.isSafeInteger(entry?.revision) || entry.revision < 0 || !validIdentity(entry.actor)
      || typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at))
      || !Number.isSafeInteger(entry.summary?.registers) || entry.summary.registers < 0
      || !Number.isSafeInteger(entry.summary?.actions) || entry.summary.actions < 0)) {
      throw new WorkspaceError(502, 'Invalid audit');
    }
    const heading = make('h3', '', 'Журнал общей версии');
    const list = make('ol', 'entries');
    for (const entry of data.entries) {
      list.append(make('li', '', `Версия ${entry.revision} · ${new Date(entry.at).toLocaleString('ru-RU')} · ${entry.actor.name} (${ROLES[entry.actor.role]}). Реестров: ${entry.summary.registers}, поручений: ${entry.summary.actions}.`));
    }
    journal.replaceChildren(heading, data.entries.length ? list : make('p', 'help', 'Публикаций пока нет.'));
    setMessage('Журнал загружен. Он показывает публикации общего реестра.');
  }

  function downloadBackup() {
    if (busy || !hooksReady || disposed) return;
    try {
      const value = localDocument();
      if (downloadedUrl) view.URL.revokeObjectURL(downloadedUrl);
      downloadedUrl = view.URL.createObjectURL(new view.Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' }));
      const link = make('a');
      link.href = downloadedUrl;
      link.download = `local-action-register-${new Date().toISOString().slice(0, 10)}.json`;
      link.hidden = true;
      root.append(link);
      link.click();
      link.remove();
      setMessage('Локальная копия подготовлена к скачиванию. Убедитесь, что браузер сохранил файл, перед заменой реестра.');
    } catch { setMessage('Не удалось подготовить локальную копию. Реестр не изменён.', true); }
  }

  function failure(error) {
    if (disposed) return;
    const status = error?.status;
    if (status === 503 || status === 404) {
      enabled = false; identity = null; revision = null; resetPreview();
      setMessage('Общее хранение выключено или ещё не подключено. Оператору нужно настроить серверный доступ. Локальный реестр доступен отдельно.', true);
    } else if (status === 401) {
      enabled = true; identity = null; revision = null; resetPreview(); journal.replaceChildren();
      setMessage('Нет действующей сессии. Подключитесь ключом доступа. Локальные правки сохранены.', true);
    } else if (status === 409) {
      revision = null; resetPreview();
      setMessage('Конфликт версий: другой пользователь уже изменил общий реестр. Локальные правки сохранены. Скачайте их копию, затем получите свежую общую версию перед новой публикацией.', true);
    } else if (status === 403) {
      revision = null;
      setMessage('Сервер отклонил действие: проверьте права доступа и адрес приложения. Локальные правки сохранены.', true);
    } else if (status === 422 || status === 413) {
      setMessage('Сервер не принял структуру или размер реестра. Локальные правки сохранены; проверьте данные.', true);
    } else if (status === 429) {
      setMessage('Слишком много попыток входа. Подождите и повторите подключение.', true);
    } else if (status === 0) {
      setMessage(error.message, true);
    } else {
      setMessage('Не удалось завершить действие. Проверьте соединение и повторите. Локальные правки сохранены; перед повторной публикацией получите общую версию.', true);
    }
  }

  async function run(action) {
    if (busy || disposed) return;
    busy = true;
    controller = new AbortController();
    update();
    try {
      await Promise.race([
        action(),
        new Promise((_, reject) => { timeout = setTimeout(() => { controller?.abort(); reject(new WorkspaceError(504, 'Timeout')); }, 15000); }),
      ]);
    } catch (error) { failure(error); }
    finally {
      clearTimeout(timeout);
      timeout = null;
      busy = false;
      controller = null;
      update();
    }
  }

  update();
  void run(checkSession);
  return {
    dispose() {
      disposed = true;
      key.value = '';
      controller?.abort();
      clearTimeout(timeout);
      if (downloadedUrl) view.URL.revokeObjectURL(downloadedUrl);
      root.remove();
    },
  };
}
