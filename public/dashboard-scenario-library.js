// Local snapshots are display-only. Only the application/server validates and recalculates decisions.
export const STORAGE_KEY = 'akim-scenario-library-v1';
export const MODEL_ID = 'official-astana-v1';
export const MAX_ENTRIES = 20;
export const MAX_FILE_BYTES = 128 * 1024;
const mounted = new WeakMap();
const districtNames = { esil: 'Есиль', almaty: 'Алматы', saryarka: 'Сарыарка', baikonur: 'Байконур', nura: 'Нура' };
const record = (value) => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const own = (value, key) => Object.hasOwn(value, key);
const fail = (message) => { throw new Error(message); };
const keysOnly = (value, keys) => record(value) && Object.keys(value).every((key) => keys.includes(key));
const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value);
const validDate = (value) => typeof value === 'string' && value.length <= 40
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
const copy = (value) => structuredClone(value);

function boundedName(value) {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 80
    || /[\u0000-\u001f\u007f]/.test(value)) fail('Название должно содержать от 1 до 80 символов без переносов строк.');
  return value.trim();
}

export function normalizeScenario(value) {
  if (!keysOnly(value, ['decisions']) || !Array.isArray(value.decisions)
    || value.decisions.length < 1 || value.decisions.length > 5) {
    fail('Сценарий должен содержать от 1 до 5 решений.');
  }
  const ids = new Set();
  const decisions = Array.from(value.decisions, (decision) => {
    if (!keysOnly(decision, ['measureId', 'districtId']) || !identifier(decision.measureId)
      || ids.has(decision.measureId) || (own(decision, 'districtId') && !identifier(decision.districtId))) {
      fail('Некорректное решение: нужны уникальный measureId и необязательный districtId (до 40 букв, цифр, _ или -).');
    }
    ids.add(decision.measureId);
    return own(decision, 'districtId')
      ? { measureId: decision.measureId, districtId: decision.districtId }
      : { measureId: decision.measureId };
  });
  return { decisions };
}

function normalizeSnapshot(value) {
  const keys = ['score', 'totalCost', 'remainingBudget', 'criticalCount'];
  if (!record(value) || !keys.every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]))
    || value.totalCost < 0 || value.remainingBudget < 0
    || !Number.isInteger(value.criticalCount) || value.criticalCount < 0) fail('Повреждён снимок расчёта.');
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

export function captureCalculated(detail) {
  try {
    if (!record(detail) || !record(detail.result) || detail.result.valid !== true) return null;
    const scenario = normalizeScenario(detail.scenario);
    if (scenario.decisions.length !== 5) return null;
    return { scenario, snapshot: normalizeSnapshot(detail.result) };
  } catch { return null; }
}

function parseJSON(text) {
  if (typeof text !== 'string' || text.length > MAX_FILE_BYTES
    || new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES) fail('Лимит JSON — 128 КиБ.');
  try { return JSON.parse(text); } catch { return fail('Файл не содержит корректный JSON.'); }
}

export function parseComparisonImport(text) {
  const value = parseJSON(text);
  if (!record(value) || value.schemaVersion !== 1) fail('Неизвестная версия экспорта. Поддерживается schemaVersion: 1.');
  if (!keysOnly(value, ['schemaVersion', 'exportedAt', 'slots']) || !validDate(value.exportedAt)
    || !keysOnly(value.slots, ['A', 'B'])) fail('Ожидается экспорт сравнения с датой exportedAt и слотами A/B.');
  const entries = [];
  for (const slot of ['A', 'B']) {
    const source = value.slots[slot];
    if (source === null || source === undefined) continue;
    if (!keysOnly(source, ['scenario', 'result'])) fail(`Некорректный слот ${slot}.`);
    // Never read or clone imported result; it may contain forged scores or arbitrary text.
    entries.push({ slot, scenario: normalizeScenario(source.scenario) });
  }
  if (!entries.length) fail('В файле нет сценариев для импорта.');
  return entries;
}

function normalizeEntry(value) {
  if (!keysOnly(value, ['id', 'name', 'createdAt', 'modelId', 'source', 'scenario', 'snapshot'])
    || !identifier(value.id) || !validDate(value.createdAt) || value.modelId !== MODEL_ID
    || !['calculated', 'imported'].includes(value.source)) fail('Повреждена запись библиотеки.');
  const scenario = normalizeScenario(value.scenario);
  if (value.source === 'calculated' && scenario.decisions.length !== 5) fail('Повреждён сохранённый расчёт.');
  return {
    id: value.id, name: boundedName(value.name), createdAt: value.createdAt,
    modelId: MODEL_ID, source: value.source, scenario,
    snapshot: value.source === 'calculated' ? normalizeSnapshot(value.snapshot) : null,
  };
}

function normalizeEntries(entries) {
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) fail('В библиотеке может быть не больше 20 сценариев.');
  const normalized = Array.from(entries, normalizeEntry);
  if (new Set(normalized.map((entry) => entry.id)).size !== normalized.length) fail('Повторяются идентификаторы сохранений.');
  return normalized;
}

export function createLibraryRepository(getStorage) {
  const read = () => {
    const raw = getStorage().getItem(STORAGE_KEY);
    if (raw === null) return [];
    const value = parseJSON(raw);
    if (!keysOnly(value, ['schemaVersion', 'entries']) || value.schemaVersion !== 1) fail('Неизвестный или повреждённый формат библиотеки.');
    return normalizeEntries(value.entries);
  };
  const write = (entries) => {
    const normalized = normalizeEntries(entries);
    getStorage().setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 1, entries: normalized }));
    return normalized;
  };
  return {
    read,
    add(entries) {
      // Re-read before every mutation: do not overwrite a newer list from another tab.
      return write([...read(), ...normalizeEntries(entries)]);
    },
    remove(id) { return write(read().filter((entry) => entry.id !== id)); },
    reset() { getStorage().removeItem(STORAGE_KEY); return []; },
  };
}

function element(document, tag, className, text) {
  const node = document.createElement(tag);
  node.className = `scenario-library-${className}`;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function mountScenarioLibrary(container, { city } = {}) {
  if (!container) return () => {};
  if (mounted.has(container)) return mounted.get(container);
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  const el = (tag, className, text) => element(doc, tag, className, text);
  const button = (text, handler, kind = '') => {
    const node = el('button', `button${kind ? ` scenario-library-${kind}` : ''}`, text);
    node.type = 'button';
    node.addEventListener('click', handler);
    return node;
  };
  const repo = createLibraryRepository(() => win.localStorage);
  const root = el('div', 'root');
  const heading = el('h2', 'title', 'Мои сценарии');
  const intro = el('p', 'intro', 'Сохраните план или рассчитанный сценарий, чтобы вернуться к нему. До 20 сценариев хранятся только в этом браузере на этом адресе сайта.');
  const notice = el('p', 'notice', 'Астана · синтетическая учебная модель. Сохранённые оценки — снимки, а не прогноз. После загрузки нужен новый расчёт.');
  const cityNotice = el('p', 'notice', 'Библиотека относится к официальной модели Астаны. Выберите Астану, чтобы сохранять, импортировать и загружать сценарии.');
  const body = el('div', 'body');
  const saveForm = el('form', 'save-form');
  saveForm.id = 'local-scenario-form';
  const nameLabel = el('label', 'label', 'Название сценария');
  const nameInput = el('input', 'input');
  nameInput.id = 'local-scenario-name';
  nameInput.type = 'text'; nameInput.maxLength = 80; nameInput.required = true;
  nameInput.placeholder = 'Например, школы и медицина Нуры';
  nameLabel.append(nameInput);
  const save = button('Сохранить расчёт', () => {});
  save.type = 'submit'; save.disabled = true; save.id = 'save-local-scenario';
  const current = el('p', 'hint', 'Сначала рассчитайте сценарий. Сохранение происходит только по вашей кнопке.');
  saveForm.append(nameLabel, save, current);
  const importArea = el('div', 'import-area');
  const fileLabel = el('label', 'label', 'Импорт сравнения (JSON, до 128 КиБ)');
  const fileInput = el('input', 'file'); fileInput.type = 'file'; fileInput.accept = '.json,application/json';
  fileLabel.append(fileInput);
  const importHint = el('p', 'hint', 'Импортируются только решения A/B. Оценки и текст из файла не сохраняются.');
  const preview = el('form', 'preview'); preview.hidden = true;
  importArea.append(fileLabel, importHint, preview);
  const storageNotice = el('div', 'storage-notice'); storageNotice.hidden = true;
  const storageText = el('p', 'hint');
  const retry = button('Повторить чтение', () => refresh());
  const reset = button('Сбросить библиотеку…', () => confirmReset(), 'danger');
  storageNotice.append(storageText, retry, reset);
  const count = el('p', 'count');
  const list = el('div', 'list'); list.id = 'local-scenarios';
  const status = el('p', 'status'); status.id = 'library-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
  body.append(saveForm, importArea, storageNotice, count, list, status);
  root.append(heading, intro, notice, cityNotice, body); container.append(root);
  let entries = [], candidate = null, currentPlan = null, pending = [], pendingNames = [], storageReady = false;
  let astana = city?.hasScenarioData === true, disposed = false, importRevision = 0;
  body.hidden = !astana; notice.hidden = !astana; cityNotice.hidden = astana;
  const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
  const date = (value) => new Date(value).toLocaleString('ru-RU');
  const summary = (scenario) => scenario.decisions.map((d) => `${d.measureId}${d.districtId ? ` → ${own(districtNames, d.districtId) ? districtNames[d.districtId] : d.districtId}` : ' → город'}`).join(' · ');
  const announce = (text) => { status.textContent = text; };
  const sync = () => {
    save.disabled = (!candidate && !currentPlan) || !storageReady || !astana || entries.length >= MAX_ENTRIES;
    save.textContent = candidate ? 'Сохранить расчёт' : 'Сохранить план без расчёта';
  };
  function storageError(error) {
    storageReady = false; storageNotice.hidden = false;
    storageText.textContent = error?.name === 'QuotaExceededError'
      ? 'В браузере недостаточно места. Новые записи не сохранены. Освободите место или удалите ненужный сценарий и повторите. Название и текущий расчёт сохранены в форме.'
      : 'Не удалось прочитать или изменить библиотеку. Данные не перезаписаны. Проверьте разрешение браузера на хранение данных и повторите чтение. Повреждённую библиотеку можно сбросить отдельно от текущего выбора.';
    sync();
  }
  function renderList() {
    count.textContent = `${entries.length} из ${MAX_ENTRIES} сохранений`;
    list.replaceChildren();
    if (!entries.length) list.append(el('p', 'empty', 'Здесь появятся ваши сохранённые сценарии.'));
    for (const entry of entries) {
      const card = el('article', 'card'); card.classList.add('library-item');
      const title = el('h3', 'card-title', entry.name);
      const meta = el('p', 'meta', `${date(entry.createdAt)} · Астана · ${entry.snapshot ? 'Сохранённый расчёт' : 'План без расчёта'}`);
      const decisions = el('p', 'decisions', summary(entry.scenario));
      const snapshot = el('p', 'snapshot', entry.snapshot
        ? `Снимок: Score ${number.format(entry.snapshot.score)} · бюджет ${number.format(entry.snapshot.totalCost)} · критических ${entry.snapshot.criticalCount}`
        : 'Без оценки. Загрузите решения и рассчитайте их заново.');
      const actions = el('div', 'actions');
      const load = button('Загрузить в план', () => {
        if (!astana) return;
        win.dispatchEvent(new win.CustomEvent('scenario:load', { detail: { scenario: copy(entry.scenario) } }));
        announce(`«${entry.name}»: решения переданы на проверку. Проверьте план и нажмите «Рассчитать».`);
      });
      const remove = button('Удалить', () => {
        confirmation.replaceChildren(el('p', 'hint', `Удалить «${entry.name}» из этого браузера?`),
          button('Да, удалить', () => {
            if (!astana) return;
            try { entries = repo.remove(entry.id); renderList(); refresh(); announce('Сценарий удалён.'); }
            catch (error) { storageError(error); }
          }, 'danger'), button('Отмена', () => { confirmation.hidden = true; remove.focus(); }));
        confirmation.hidden = false;
        confirmation.querySelector('button').focus();
      }, 'danger');
      const confirmation = el('div', 'confirmation'); confirmation.hidden = true;
      confirmation.setAttribute('role', 'group'); confirmation.setAttribute('aria-label', 'Подтверждение удаления');
      actions.append(load, remove); card.append(title, meta, decisions, snapshot, actions, confirmation); list.append(card);
    }
    sync();
  }
  function refresh() {
    try { entries = repo.read(); storageReady = true; storageNotice.hidden = true; renderList(); }
    catch (error) { storageError(error); }
  }
  function confirmReset() {
    storageText.textContent = 'Удалить все локальные сохранения библиотеки? Текущий план и расчёт останутся. Это действие нельзя отменить.';
    const yes = button('Да, сбросить библиотеку', () => {
      if (!astana) return;
      try { entries = repo.reset(); storageNotice.replaceChildren(storageText, retry, reset); refresh(); announce('Библиотека очищена. Текущий план не изменён.'); }
      catch (error) { storageNotice.replaceChildren(storageText, retry, reset); storageError(error); }
    }, 'danger');
    storageNotice.replaceChildren(storageText, yes, button('Отмена', () => {
      storageNotice.replaceChildren(storageText, retry, reset); refresh();
    }));
    yes.focus();
  }
  function newEntry(name, scenario, snapshot, source) {
    return { id: win.crypto.randomUUID(), name: boundedName(name), createdAt: new Date().toISOString(), modelId: MODEL_ID, source, scenario: copy(scenario), snapshot };
  }
  saveForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if ((!candidate && !currentPlan) || !astana || !storageReady) return;
    let entry;
    try { entry = candidate
      ? newEntry(nameInput.value, candidate.scenario, candidate.snapshot, 'calculated')
      : newEntry(nameInput.value, currentPlan, null, 'imported'); }
    catch (error) { announce(error.message); nameInput.focus(); return; }
    try { entries = repo.add([entry]); renderList(); announce(`«${entry.name}» сохранён в этом браузере.`); }
    catch (error) { storageError(error); }
  });
  fileInput.addEventListener('change', async () => {
    const revision = ++importRevision;
    const file = fileInput.files?.[0];
    fileInput.value = ''; pending = []; preview.hidden = true; preview.replaceChildren();
    if (!file || !astana) return;
    try {
      if (file.size > MAX_FILE_BYTES) fail('Файл больше 128 КиБ. Выберите меньший JSON экспорта.');
      const text = await file.text();
      if (disposed || revision !== importRevision || !astana) return;
      pending = parseComparisonImport(text);
      pendingNames = pending.map((item) => {
        const label = el('label', 'label', `Название для слота ${item.slot}`);
        const input = el('input', 'input'); input.type = 'text'; input.maxLength = 80; input.required = true; input.value = `Импорт ${item.slot} · ${new Date().toLocaleDateString('ru-RU')}`;
        label.append(input); preview.append(label, el('p', 'decisions', summary(item.scenario)));
        return input;
      });
      const accept = button(`Сохранить импорт (${pending.length})`, () => {}); accept.type = 'submit';
      preview.append(accept, button('Отмена импорта', () => { pending = []; preview.hidden = true; announce('Импорт отменён.'); }));
      preview.hidden = false; pendingNames[0].focus();
      announce('Файл проверен. Задайте названия и подтвердите сохранение решений.');
    } catch (error) { announce(error.message || 'Не удалось прочитать файл. Текущий план не изменён.'); }
  });
  preview.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!pending.length || !astana) return;
    let imported;
    try { imported = pending.map((item, index) => newEntry(pendingNames[index].value, item.scenario, null, 'imported')); }
    catch (error) { announce(error.message); return; }
    try {
      entries = repo.add(imported); storageReady = true; storageNotice.hidden = true;
      pending = []; preview.hidden = true; renderList(); announce(`Импортировано сценариев: ${imported.length}. Оценки из файла отброшены. Для расчёта загрузите сценарий в план.`);
    } catch (error) {
      if (entries.length + imported.length > MAX_ENTRIES) announce('Недостаточно места: максимум 20 сценариев. Удалите лишние; ни один сценарий из файла пока не сохранён.');
      else storageError(error);
    }
  });
  const onCalculated = (event) => {
    if (!astana) return;
    const next = captureCalculated(event.detail);
    if (!next) {
      announce(candidate ? 'Новый результат не подходит для сохранения. Доступен предыдущий успешный расчёт, указанный над библиотекой.'
        : 'Результат не подходит для сохранения. Рассчитайте допустимый сценарий.');
      return;
    }
    candidate = next;
    current.textContent = `Последний успешный расчёт: Score ${number.format(candidate.snapshot.score)}. ${summary(candidate.scenario)}`;
    sync();
  };
  const onChanged = (event) => {
    try { currentPlan = normalizeScenario(event.detail?.scenario); } catch { currentPlan = null; }
    candidate = null;
    current.textContent = currentPlan ? 'План можно сохранить без оценки. Для сохранения результата рассчитайте его.' : 'Добавьте хотя бы одну инициативу для сохранения плана.';
    sync();
  };
  const onCity = (event) => {
    astana = event.detail?.hasScenarioData === true;
    body.hidden = !astana; notice.hidden = !astana; cityNotice.hidden = astana;
    candidate = null; pending = []; preview.hidden = true; ++importRevision;
    current.textContent = currentPlan ? 'План сохранён в конструкторе. Можно сохранить его без оценки; для результата нужен новый расчёт.' : 'Рассчитайте сценарий Астаны или соберите план для сохранения.'; sync();
  };
  const onInvalidated = () => {
    candidate = null;
    current.textContent = 'Расчёт больше не актуален. План можно сохранить без оценки или рассчитать заново.';
    sync();
  };
  const onStorage = (event) => { if (event.key === STORAGE_KEY || event.key === null) refresh(); };
  win.addEventListener('scenario:changed', onChanged);
  win.addEventListener('scenario:calculated', onCalculated);
  win.addEventListener('scenario:invalidated', onInvalidated);
  win.addEventListener('city:changed', onCity);
  win.addEventListener('storage', onStorage);
  const dispose = () => {
    disposed = true; ++importRevision;
    win.removeEventListener('scenario:changed', onChanged);
    win.removeEventListener('scenario:calculated', onCalculated); win.removeEventListener('scenario:invalidated', onInvalidated);
    win.removeEventListener('city:changed', onCity); win.removeEventListener('storage', onStorage);
    root.remove(); mounted.delete(container);
  };
  mounted.set(container, dispose); refresh(); return dispose;
}
