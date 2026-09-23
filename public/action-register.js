// A browser-local manual register. No network, AI, or official workflow is invoked.
export const ACTION_REGISTER_STORAGE_KEY = 'akim-action-register-v1';
export const ACTION_REGISTER_LIMIT = 10;
export const ACTION_REGISTER_SCHEMA_VERSION = 2;
const MAX_STORAGE_CHARS = 500_000;
const STATUS = { draft: 'Черновик', in_progress: 'В работе', completed: 'Выполнено', deferred: 'Отложено' };
const FIELD_LIMITS = { owner: 160, dueDate: 10, criterion: 2000, evidence: 2000 };
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 200) => typeof value === 'string' && value.length <= max;
const identifier = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const clone = (value) => JSON.parse(JSON.stringify(value));

const IMPLEMENTATION_FIELDS = [
  ['siteAddress', 'site-address', 'Площадка / адрес', 'text', 400],
  ['siteBasis', 'site-basis', 'Основание выбора площадки', 'textarea', 2000],
  ['siteSourceUrl', 'site-source', 'Ссылка на источник площадки', 'url', 1000],
  ['kpi.name', 'kpi-name', 'Физический KPI: название', 'text', 200],
  ['kpi.unit', 'kpi-unit', 'Единица измерения KPI', 'text', 80],
  ['kpi.baseline', 'kpi-baseline', 'Исходное значение KPI', 'number'],
  ['kpi.target', 'kpi-target', 'Целевое значение KPI', 'number'],
  ['kpi.source', 'kpi-source', 'Источник значений KPI', 'textarea', 1000],
  ['budget.capexKzt', 'capex', 'CAPEX, тенге (разовые затраты)', 'money'],
  ['budget.opexKzt', 'opex', 'OPEX, тенге (эксплуатация)', 'money'],
  ['budget.estimateSource', 'estimate-source', 'Источник сметы и период OPEX', 'textarea', 1000],
  ['budget.estimateDate', 'estimate-date', 'Дата сметы', 'date', 10],
  ['prerequisites', 'prerequisites', 'Инфраструктурные предпосылки', 'textarea', 2000],
  ['nextStep', 'next-step', 'Следующий шаг', 'textarea', 1000],
];
const getPath = (value, path) => path.split('.').reduce((item, key) => item?.[key], value);
function setPath(value, path, content) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((item, key) => item[key], value)[last] = content;
}
export function emptyImplementation() {
  return { siteAddress: '', siteBasis: '', siteSourceUrl: '',
    kpi: { name: '', unit: '', baseline: null, target: null, source: '' },
    budget: { capexKzt: null, opexKzt: null, estimateSource: '', estimateDate: '' },
    prerequisites: '', nextStep: '' };
}
function validSourceUrl(value) {
  if (value === '') return true;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}
function validImplementationField(value, type, max) {
  if (type === 'number' || type === 'money') return value === null
    || (finite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER && (type !== 'money' || value >= 0));
  return text(value, max) && (type !== 'date' || value === '' || validDate(value))
    && (type !== 'url' || validSourceUrl(value));
}
function validImplementation(value) {
  return record(value) && record(value.kpi) && record(value.budget)
    && IMPLEMENTATION_FIELDS.every(([path, , , type, max]) => validImplementationField(getPath(value, path), type, max));
}
export function implementationGaps(action) {
  const implementation = action.implementation ?? emptyImplementation();
  const missing = [];
  if (!action.owner.trim()) missing.push('Ответственный');
  if (!validDate(action.dueDate)) missing.push('Срок');
  if (!action.criterion.trim()) missing.push('Критерий проверки');
  for (const [path, , label] of IMPLEMENTATION_FIELDS) {
    if (path === 'siteSourceUrl') continue;
    if (path === 'siteBasis' && implementation.siteSourceUrl.trim()) continue;
    const value = getPath(implementation, path);
    if (value === null || (typeof value === 'string' && !value.trim())) missing.push(label);
  }
  return missing;
}

export function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day > 0 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export function localDate(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

export function isOverdue(action, today = localDate()) {
  return action.status !== 'completed' && validDate(action.dueDate) && action.dueDate < today;
}

function statusError(action) {
  if (!Object.hasOwn(STATUS, action.status)) return 'Неизвестный статус.';
  if (['in_progress', 'completed'].includes(action.status)
    && (!action.owner.trim() || !validDate(action.dueDate))) {
    return 'Для статуса «В работе» или «Выполнено» укажите ответственного и корректный срок.';
  }
  if (action.status === 'completed' && !action.evidence.trim()) {
    return 'Для статуса «Выполнено» введите подтверждение результата. Показатели модели не подтверждают выполнение.';
  }
  return '';
}

function sourceKey(city, decisions) {
  return JSON.stringify([city.id, decisions.map(({ measureId, districtId }) => [measureId, districtId ?? null])
    .sort((a, b) => a[0].localeCompare(b[0]))]);
}

function validMetrics(value) {
  return record(value) && value.valid === true
    && ['score', 'totalCost', 'remainingBudget', 'criticalCount'].every((key) => finite(value[key]))
    && value.totalCost >= 0 && value.remainingBudget >= 0
    && Number.isInteger(value.criticalCount) && value.criticalCount >= 0;
}

function validDecisions(decisions) {
  return Array.isArray(decisions) && decisions.length === 5
    && decisions.every((item) => record(item) && identifier(item.measureId)
      && (item.districtId === undefined || identifier(item.districtId)))
    && new Set(decisions.map((item) => item.measureId)).size === 5;
}

function capture(detail, dataset, city) {
  if (city?.hasScenarioData !== true || !identifier(city.id) || !text(city.name)
    || !record(dataset) || !Array.isArray(dataset.measures) || !Array.isArray(dataset.districts)
    || !validDecisions(detail?.scenario?.decisions) || !validMetrics(detail?.result)) return null;
  const decisions = [];
  const labels = [];
  for (const input of detail.scenario.decisions) {
    const measure = dataset.measures.find((item) => item.id === input.measureId);
    const district = dataset.districts.find((item) => item.id === input.districtId);
    if (!measure || !text(measure.name) || !['city', 'district'].includes(measure.scope)
      || (measure.scope === 'district' && (!district || !text(district.name)))
      || (measure.scope === 'city' && input.districtId !== undefined)) return null;
    const decision = { measureId: input.measureId };
    if (input.districtId !== undefined) decision.districtId = input.districtId;
    decisions.push(decision);
    labels.push({ ...decision, measureName: measure.name, districtName: district?.name ?? 'Весь город' });
  }
  return {
    city: { id: city.id, name: city.name }, scenario: { decisions },
    result: Object.fromEntries(['valid', 'score', 'totalCost', 'remainingBudget', 'criticalCount'].map((key) => [key, detail.result[key]])),
    calculatedAt: new Date().toISOString(), labels,
  };
}

const timestamp = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)
  && value.length <= 30 && Number.isFinite(Date.parse(value));

// Reject the whole store on corruption: never silently drop or replace a person's work.
function parseStore(raw) {
  if (raw === null) return [];
  if (raw.length > MAX_STORAGE_CHARS) throw new Error('corrupted');
  const data = JSON.parse(raw);
  if (!record(data) || ![1, ACTION_REGISTER_SCHEMA_VERSION].includes(data.schemaVersion) || !Array.isArray(data.registers)
    || data.registers.length > ACTION_REGISTER_LIMIT) throw new Error('corrupted');
  const ids = new Set();
  const keys = new Set();
  for (const entry of data.registers) {
    const source = entry?.source;
    if (!record(entry) || !identifier(entry.id) || ids.has(entry.id) || !timestamp(entry.createdAt)
      || !record(source) || !identifier(source.city?.id) || !text(source.city?.name)
      || !validDecisions(source.scenario?.decisions) || !validMetrics(source.result)
      || !timestamp(source.calculatedAt) || !Array.isArray(source.labels) || source.labels.length !== 5
      || entry.sourceKey !== sourceKey(source.city, source.scenario.decisions) || keys.has(entry.sourceKey)
      || !Array.isArray(entry.actions) || entry.actions.length !== 5) throw new Error('corrupted');
    const actionIds = new Set();
    source.scenario.decisions.forEach((decision, index) => {
      const label = source.labels[index];
      const action = entry.actions[index];
      if (!record(label) || !record(action) || !identifier(action.id) || actionIds.has(action.id)
        || label.measureId !== decision.measureId || label.districtId !== decision.districtId
        || !text(label.measureName) || !text(label.districtName)
        || action.measureId !== label.measureId || action.districtId !== label.districtId
        || action.measureName !== label.measureName || action.districtName !== label.districtName
        || !Object.entries(FIELD_LIMITS).every(([key, max]) => text(action[key], max))
        || (action.dueDate !== '' && !validDate(action.dueDate)) || statusError(action)) throw new Error('corrupted');
      actionIds.add(action.id);
      if (data.schemaVersion === 1) action.implementation = emptyImplementation();
      else if (!validImplementation(action.implementation)) throw new Error('corrupted');
    });
    ids.add(entry.id);
    keys.add(entry.sourceKey);
  }
  return data.registers;
}

function allowedKeys(value, keys) {
  if (!record(value) || Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))) throw new Error('fields');
}

function jsonValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && finite(value)) return;
  if (!value || typeof value !== 'object' || seen.has(value)
    || (Array.isArray(value) ? Object.getPrototypeOf(value) !== Array.prototype
      : ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) throw new Error('value');
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some((descriptor) => !Object.hasOwn(descriptor, 'value'))) throw new Error('accessor');
  if (Array.isArray(value) && Reflect.ownKeys(value).some((key) => typeof key !== 'string'
    || (key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)))) throw new Error('array fields');
  seen.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) jsonValue(item, seen);
  seen.delete(value);
}

/** Strict transport document, independent from the input. Local v1 migration stays in parseStore. */
export function normalizeActionDocument(document, { maxBytes = 128 * 1024 } = {}) {
  try {
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024) throw new Error('limit');
    allowedKeys(document, ['schemaVersion', 'registers']);
    jsonValue(document);
    if (document.schemaVersion !== ACTION_REGISTER_SCHEMA_VERSION || !Array.isArray(document.registers)
      || document.registers.length > ACTION_REGISTER_LIMIT) throw new Error('schema');
    for (const entry of document.registers) {
      allowedKeys(entry, ['id', 'sourceKey', 'createdAt', 'source', 'actions']);
      allowedKeys(entry.source, ['city', 'scenario', 'result', 'calculatedAt', 'labels']);
      allowedKeys(entry.source.city, ['id', 'name']);
      allowedKeys(entry.source.scenario, ['decisions']);
      allowedKeys(entry.source.result, ['valid', 'score', 'totalCost', 'remainingBudget', 'criticalCount']);
      if (!Array.isArray(entry.source.scenario.decisions) || !Array.isArray(entry.source.labels)
        || !Array.isArray(entry.actions)) throw new Error('arrays');
      for (const decision of entry.source.scenario.decisions) allowedKeys(decision, ['measureId', 'districtId']);
      for (const label of entry.source.labels) allowedKeys(label, ['measureId', 'districtId', 'measureName', 'districtName']);
      for (const action of entry.actions) {
        allowedKeys(action, ['id', 'measureId', 'districtId', 'measureName', 'districtName', 'owner', 'dueDate', 'criterion', 'status', 'evidence', 'implementation']);
        allowedKeys(action.implementation, ['siteAddress', 'siteBasis', 'siteSourceUrl', 'kpi', 'budget', 'prerequisites', 'nextStep']);
        allowedKeys(action.implementation.kpi, ['name', 'unit', 'baseline', 'target', 'source']);
        allowedKeys(action.implementation.budget, ['capexKzt', 'opexKzt', 'estimateSource', 'estimateDate']);
      }
    }
    const raw = JSON.stringify(document);
    if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new Error('size');
    return { schemaVersion: ACTION_REGISTER_SCHEMA_VERSION, registers: parseStore(raw) };
  } catch {
    throw Object.assign(new Error('Документ реестра не принят: нужна корректная схема 2 без посторонних полей, до 10 наборов и 128 КиБ UTF-8.'), { code: 'INVALID' });
  }
}

function csvCell(value) {
  let content = String(value ?? '');
  // Treat manual text as text when opened in spreadsheet software.
  if (/^[\s]*[=+@-]/.test(content) || /^[\t\r\n]/.test(content)) content = `'${content}`;
  return `"${content.replaceAll('"', '""')}"`;
}

export function registerCsv(registers) {
  const rows = [['Реестр', 'Создан', 'Город', 'Мера', 'Район', 'Ответственный', 'Срок', 'Критерий проверки', 'Статус', 'Подтверждение', 'Исходный сценарий', ...IMPLEMENTATION_FIELDS.map(([, , label]) => label)]];
  for (const entry of registers) for (const action of entry.actions) {
    rows.push([entry.id, entry.createdAt, entry.source.city.name, action.measureName, action.districtName,
      action.owner, action.dueDate, action.criterion, STATUS[action.status], action.evidence,
      JSON.stringify(entry.source.scenario), ...IMPLEMENTATION_FIELDS.map(([path]) => getPath(action.implementation, path))]);
  }
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/** Mount once, after loading the dataset. Only future successful calculation events enable creation. */
export function mountActionRegister(container, { dataset = null, city = null } = {}) {
  if (!container?.ownerDocument || typeof container.append !== 'function') throw new TypeError('Нужен DOM-контейнер реестра.');
  const document = container.ownerDocument;
  const window = document.defaultView ?? globalThis.window;
  if (!window?.addEventListener) throw new TypeError('Нужно окно браузера.');
  let currentCity = city ? { ...city } : null;
  let current = null;
  let registers = [];
  let persistedRaw = null;
  let blocked = '';
  let storageState = '';
  let disposed = false;
  let serial = 0;
  const cleanups = [];
  const id = () => `ar-${Date.now().toString(36)}-${(++serial).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  function node(tag, className, content) {
    const element = document.createElement(tag);
    element.className = className;
    if (content !== undefined) element.textContent = content;
    return element;
  }
  function button(className, label, handler) {
    const element = node('button', className, label);
    element.type = 'button';
    element.addEventListener('click', handler);
    return element;
  }
  function listen(name, handler) {
    window.addEventListener(name, handler);
    cleanups.push(() => window.removeEventListener(name, handler));
  }
  const root = node('section', 'action-register');
  const heading = node('h2', 'action-register-title', 'Реестр действий');
  const notice = node('p', 'action-register-notice', 'Локальный черновик в этом браузере. Не отправлено исполнителям. Нет синхронизации и официального согласования.');
  const disclaimer = node('p', 'action-register-help', 'Меры и районы взяты из учебной модели. Ответственных, сроки и критерии проверки задаёт человек. Значения модели не доказывают выполнение и не обосновывают реальные управленческие решения.');
  const controls = node('div', 'action-register-controls');
  const create = button('action-register-create', 'Создать черновик поручений', generate);
  const exportJson = button('action-register-export-json', 'Экспорт JSON', () => download(JSON.stringify({
    schemaVersion: ACTION_REGISTER_SCHEMA_VERSION, exportedAt: new Date().toISOString(), notice: notice.textContent, registers,
  }, null, 2), 'json', 'application/json'));
  const exportCsv = button('action-register-export-csv', 'Экспорт CSV', () => download(registerCsv(registers), 'csv', 'text/csv;charset=utf-8'));
  const hint = node('p', 'action-register-hint');
  const summary = node('p', 'action-register-summary');
  const storageNotice = node('p', 'action-register-storage');
  storageNotice.setAttribute('role', 'status');
  const message = node('p', 'action-register-message');
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  const list = node('div', 'action-register-list');
  controls.append(create, exportJson, exportCsv);
  root.append(heading, notice, disclaimer, controls, hint, summary, storageNotice, message, list);
  container.append(root);

  function setMessage(value) { message.textContent = value; }
  function storageError(error) {
    return error?.name === 'QuotaExceededError'
      ? 'Хранилище переполнено. Изменения только в памяти: экспортируйте JSON до закрытия страницы.'
      : 'Локальное хранилище недоступно. Изменения только в памяти: экспортируйте JSON до закрытия страницы.';
  }
  try {
    persistedRaw = window.localStorage.getItem(ACTION_REGISTER_STORAGE_KEY);
    try {
      registers = parseStore(persistedRaw);
      storageState = 'Реестр сохраняется в этом браузере при каждом изменении.';
    } catch {
      blocked = 'corrupted';
      storageState = 'Сохранённый реестр повреждён или имеет неизвестную версию. Он не перезаписан. Новые записи только в памяти; экспортируйте их перед закрытием.';
    }
  } catch (error) {
    blocked = 'unavailable';
    storageState = storageError(error);
  }
  function persist() {
    if (disposed || blocked) return;
    try {
      const storage = window.localStorage;
      if (storage.getItem(ACTION_REGISTER_STORAGE_KEY) !== persistedRaw) {
        blocked = 'conflict';
        storageState = 'Реестр изменился в другой вкладке. Ваши правки только в памяти: экспортируйте JSON перед перезагрузкой. Чужие изменения не перезаписаны.';
      } else {
        const raw = JSON.stringify({ schemaVersion: ACTION_REGISTER_SCHEMA_VERSION, registers });
        if (raw.length > MAX_STORAGE_CHARS) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
        storage.setItem(ACTION_REGISTER_STORAGE_KEY, raw);
        persistedRaw = raw;
        storageState = 'Сохранено в этом браузере. Нет синхронизации.';
      }
    } catch (error) { storageState = storageError(error); }
    storageNotice.textContent = storageState;
  }
  function refresh() {
    if (disposed) return;
    const duplicate = current && registers.some((entry) => entry.sourceKey === sourceKey(current.city, current.scenario.decisions));
    create.disabled = !current || duplicate || registers.length >= ACTION_REGISTER_LIMIT;
    hint.textContent = currentCity?.hasScenarioData !== true
      ? 'Для выбранной территории нет данных сценария. Сохранённые поручения доступны ниже.'
      : !current ? 'Рассчитайте текущий сценарий на сервере, затем создайте черновик.'
        : duplicate ? 'Для этого набора мер и районов уже есть реестр. Редактируйте его ниже.'
          : registers.length >= ACTION_REGISTER_LIMIT ? `Лимит: ${ACTION_REGISTER_LIMIT} наборов по 5 поручений. Экспортируйте и явно удалите ненужный набор.`
            : 'Будут созданы 5 черновиков без назначенных ответственных и сроков.';
    const actions = registers.flatMap((entry) => entry.actions);
    summary.textContent = `Поручений: ${actions.length} · Черновик: ${actions.filter((a) => a.status === 'draft').length} · В работе: ${actions.filter((a) => a.status === 'in_progress').length} · Выполнено: ${actions.filter((a) => a.status === 'completed').length} · Отложено: ${actions.filter((a) => a.status === 'deferred').length} · Просрочено: ${actions.filter((a) => isOverdue(a)).length} (срок прошёл, статус не «Выполнено»).`;
    storageNotice.textContent = storageState;
    exportJson.disabled = exportCsv.disabled = registers.length === 0;
  }
  function generate() {
    if (disposed || !current || create.disabled) return;
    const source = clone(current);
    const key = sourceKey(source.city, source.scenario.decisions);
    if (registers.some((entry) => entry.sourceKey === key) || registers.length >= ACTION_REGISTER_LIMIT) return;
    const entry = { id: id(), sourceKey: key, createdAt: new Date().toISOString(), source,
      actions: source.labels.map((label) => ({ id: id(), ...label, owner: '', dueDate: '', criterion: '', status: 'draft', evidence: '', implementation: emptyImplementation() })) };
    registers.push(entry);
    appendRegister(entry);
    persist();
    refresh();
    setMessage('Созданы 5 черновиков. Заполните ответственных, сроки и критерии проверки вручную.');
  }
  function download(content, extension, type) {
    if (disposed) return;
    try {
      const url = window.URL.createObjectURL(new window.Blob([content], { type }));
      const link = node('a', 'action-register-download');
      link.href = url;
      link.download = `action-register-${localDate()}.${extension}`;
      root.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
      setMessage('Файл подготовлен для скачивания. Он содержит введённые вами данные.');
    } catch { setMessage('Не удалось скачать файл в этом браузере. Реестр не удалён.'); }
  }
  function appendRegister(entry) {
    const group = node('section', 'action-register-group');
    const title = node('h3', 'action-register-group-title', `${entry.source.city.name} · ${new Date(entry.createdAt).toLocaleString('ru-RU')}`);
    const sourceInfo = node('details', 'action-register-source');
    sourceInfo.append(node('summary', '', `Исходный сценарий · ${entry.id}`),
      node('p', '', `Расчёт: ${new Date(entry.source.calculatedAt).toLocaleString('ru-RU')}. Score учебной модели: ${entry.source.result.score}. Стоимость: ${entry.source.result.totalCost} условных единиц.`),
      node('p', '', entry.source.labels.map((label) => `${label.measureId}: ${label.measureName} — ${label.districtName}`).join('; ')),
      node('p', '', 'Это сохранённый источник поручений; последующие расчёты его не меняют. JSON-экспорт содержит снимок.'),
      node('p', '', 'Справочный снимок. После переноса реестра его цифры не считаются проверенными сервером; требуется новый расчёт.'));
    const cards = node('div', 'action-register-cards');
    entry.actions.forEach((action, index) => cards.append(actionCard(action, index)));
    const deletion = node('div', 'action-register-deletion');
    const confirmPanel = node('div', 'action-register-delete-panel');
    confirmPanel.hidden = true;
    const remove = button('action-register-delete', 'Удалить этот набор…', () => {
      if (disposed) return;
      confirmPanel.hidden = false;
      cancel.focus?.();
    });
    const cancel = button('action-register-delete-cancel', 'Отмена', () => {
      confirmPanel.hidden = true;
      remove.focus?.();
    });
    const confirm = button('action-register-delete-confirm', 'Подтвердить удаление 5 поручений', () => {
      if (disposed || confirmPanel.hidden) return;
      registers = registers.filter((item) => item.id !== entry.id);
      group.remove();
      persist();
      refresh();
      setMessage('Набор удалён из текущего реестра. Проверьте сообщение о сохранении.');
      create.focus?.();
    });
    confirmPanel.append(node('p', '', 'Удалить все 5 поручений и ручные записи этого набора? Сначала экспортируйте реестр, если данные нужны.'), cancel, confirm);
    deletion.append(remove, confirmPanel);
    group.append(title, sourceInfo, cards, deletion);
    list.append(group);
  }
  function actionCard(action, index) {
    const card = node('article', 'action-register-card');
    const details = node('details', 'action-register-card-details');
    const toggle = node('summary', 'action-register-card-toggle');
    const title = node('span', 'action-register-card-title', `${index + 1}. ${action.measureName}`);
    const preview = node('span', 'action-register-card-preview');
    const district = node('p', 'action-register-district', `${action.measureId} · ${action.districtName}`);
    const overdue = node('p', 'action-register-overdue');
    const validation = node('p', 'action-register-validation');
    validation.setAttribute('role', 'status');
    const readiness = node('p', 'action-register-readiness');
    const passportSummary = node('summary', 'action-register-implementation-toggle');
    const updateReadiness = () => {
      const missing = implementationGaps(action);
      passportSummary.textContent = `Паспорт реализации · ${missing.length ? `нужно уточнить: ${missing.length}` : 'ручные поля заполнены'}`;
      readiness.textContent = missing.length ? `Нужно уточнить перед реализацией: ${missing.join('; ')}.`
        : 'Ручные поля заполнены. Источники, смета и реализуемость требуют проверки человеком; это не согласование и не подтверждение выполнения.';
    };
    const updateOverdue = () => {
      overdue.textContent = isOverdue(action) ? `Просрочено: срок ${action.dueDate}` : '';
      preview.textContent = `${action.districtName} · ${STATUS[action.status]} · Ответственный: ${action.owner || 'нужно уточнить'} · Срок: ${action.dueDate || 'нужно уточнить'}${isOverdue(action) ? ' · Просрочено' : ''}`;
    };
    function field(key, labelText, type = 'text') {
      const label = node('label', 'action-register-field');
      const control = node(type === 'textarea' ? 'textarea' : 'input', `action-register-${key === 'dueDate' ? 'due' : key}`);
      if (type !== 'textarea') control.type = type;
      control.value = action[key];
      control.placeholder = key === 'evidence' ? 'Введите фактическое подтверждение вручную' : 'Нужно уточнить';
      control.maxLength = FIELD_LIMITS[key];
      if (key === 'dueDate') { control.min = '0001-01-01'; control.max = '9999-12-31'; }
      if (type === 'textarea') control.rows = 2;
      control.setAttribute('aria-label', `${labelText}: ${action.measureName}, ${action.districtName}`);
      const edit = () => {
        if (disposed) return;
        const value = control.value;
        const candidate = { ...action, [key]: value };
        const error = !text(value, FIELD_LIMITS[key]) ? 'Слишком длинное значение.'
          : key === 'dueDate' && value !== '' && !validDate(value) ? 'Укажите существующую дату в формате ГГГГ-ММ-ДД.' : statusError(candidate);
        if (error) {
          control.value = action[key];
          validation.textContent = `${error} Чтобы очистить обязательное поле, сначала выберите «Черновик».`;
          return;
        }
        action[key] = value;
        validation.textContent = '';
        persist();
        updateOverdue();
        updateReadiness();
        refresh();
      };
      control.addEventListener('input', edit);
      control.addEventListener('change', edit);
      label.append(node('span', '', labelText), control);
      return label;
    }
    const statusLabel = node('label', 'action-register-field');
    const select = node('select', 'action-register-state');
    select.setAttribute('aria-label', `Статус: ${action.measureName}, ${action.districtName}`);
    for (const [value, label] of Object.entries(STATUS)) {
      const option = node('option', '', label);
      option.value = value;
      select.append(option);
    }
    select.value = action.status;
    select.addEventListener('change', () => {
      if (disposed) return;
      const error = statusError({ ...action, status: select.value });
      if (error) { select.value = action.status; validation.textContent = error; return; }
      action.status = select.value;
      validation.textContent = '';
      persist();
      updateOverdue();
      refresh();
    });
    statusLabel.append(node('span', '', 'Статус — задаётся вручную'), select);
    const passport = node('details', 'action-register-implementation');
    passport.append(passportSummary, node('p', 'action-register-help', 'Площадка: если неизвестна, оставьте поле пустым — она не определена. KPI указывается в физических единицах. CAPEX/OPEX — ручная реальная оценка в тенге, не стоимость модели в условных единицах. Пустое число означает «не определено», ноль — явно введённое значение.'));
    for (const [path, className, labelText, type, max] of IMPLEMENTATION_FIELDS) {
      const label = node('label', 'action-register-field');
      const control = node(type === 'textarea' ? 'textarea' : 'input', `action-register-${className}`);
      if (type !== 'textarea') control.type = type === 'money' ? 'number' : type;
      control.value = String(getPath(action.implementation, path) ?? '');
      control.placeholder = path === 'siteAddress' ? 'Не определена' : 'Нужно уточнить';
      if (max) control.maxLength = max;
      if (type === 'number' || type === 'money') {
        control.step = 'any'; control.max = String(Number.MAX_SAFE_INTEGER);
        control.min = type === 'money' ? '0' : String(-Number.MAX_SAFE_INTEGER);
      }
      if (type === 'date') { control.min = '0001-01-01'; control.max = '9999-12-31'; }
      if (type === 'textarea') control.rows = 2;
      control.setAttribute('aria-label', `${labelText}: ${action.measureName}, ${action.districtName}`);
      const edit = (event) => {
        if (disposed) return;
        const value = type === 'number' || type === 'money'
          ? control.value.trim() === '' ? null : Number(control.value) : control.value;
        if (control.validity?.badInput || !validImplementationField(value, type, max)) {
          // Preserve intermediate typing (e.g. "https:") until the user leaves the field.
          if (event.type === 'change') control.value = String(getPath(action.implementation, path) ?? '');
          validation.textContent = `${labelText}: ${type === 'url' ? 'нужна ссылка http:// или https://.'
            : type === 'date' ? 'нужна существующая дата ГГГГ-ММ-ДД.'
              : type === 'money' ? 'укажите неотрицательное конечное число или оставьте пустым.'
                : type === 'number' ? 'укажите конечное число или оставьте пустым.' : 'слишком длинное значение.'}`;
          return;
        }
        setPath(action.implementation, path, value);
        validation.textContent = '';
        updateReadiness();
        persist();
        refresh();
      };
      control.addEventListener('input', edit);
      control.addEventListener('change', edit);
      label.append(node('span', '', labelText), control);
      passport.append(label);
    }
    passport.append(readiness, node('p', 'action-register-help', 'Паспорт можно сохранить незаполненным. «В работе» может означать сбор недостающих данных и не подтверждает готовность к реализации.'));
    toggle.append(title, preview);
    details.append(toggle, district, field('owner', 'Ответственный'), field('dueDate', 'Срок', 'date'),
      field('criterion', 'Критерий проверки', 'textarea'), statusLabel,
      field('evidence', 'Подтверждение результата', 'textarea'), passport, validation, overdue);
    card.append(details);
    updateOverdue();
    updateReadiness();
    return card;
  }
  listen('scenario:calculated', (event) => {
    current = capture(event.detail, dataset, currentCity);
    refresh();
  });
  const invalidate = () => { current = null; refresh(); };
  listen('scenario:invalidated', invalidate);
  listen('scenario:load', invalidate);
  listen('city:changed', (event) => { currentCity = event.detail ? { ...event.detail } : null; invalidate(); });
  listen('focus', refresh);
  listen('storage', (event) => {
    if ((event.key === ACTION_REGISTER_STORAGE_KEY || event.key === null) && event.newValue !== persistedRaw) {
      blocked = 'conflict';
      storageState = 'Реестр изменился в другой вкладке. Экспортируйте текущие записи перед перезагрузкой; автоматическое сохранение остановлено.';
      refresh();
    }
  });
  registers.forEach(appendRegister);
  refresh();
  function assertMounted() {
    if (disposed) throw Object.assign(new Error('Реестр уже отключён.'), { code: 'DISPOSED' });
  }
  return {
    getDocument() {
      assertMounted();
      return normalizeActionDocument({ schemaVersion: ACTION_REGISTER_SCHEMA_VERSION, registers });
    },
    // Caller must obtain explicit Pull/replace confirmation and offer a backup first.
    applyDocument(document) {
      assertMounted();
      const next = normalizeActionDocument(document);
      const raw = JSON.stringify(next);
      try {
        if (blocked || window.localStorage.getItem(ACTION_REGISTER_STORAGE_KEY) !== persistedRaw) throw new Error('blocked');
        window.localStorage.setItem(ACTION_REGISTER_STORAGE_KEY, raw);
      } catch {
        throw Object.assign(new Error('Не удалось сохранить полученный реестр в этом браузере. Текущие записи не заменены; проверьте хранилище или конфликт вкладок.'), { code: 'STORAGE' });
      }
      // Commit the view only after full validation and a successful local write.
      persistedRaw = raw;
      registers = next.registers;
      current = null;
      list.replaceChildren();
      registers.forEach(appendRegister);
      storageState = 'Полученный ручной реестр сохранён в этом браузере. Снимки расчёта — справочные.';
      refresh();
      setMessage('Ручные записи заменены после загрузки. Для новых поручений рассчитайте текущий сценарий заново.');
      return { savedLocally: true };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
      root.remove();
    },
  };
}
