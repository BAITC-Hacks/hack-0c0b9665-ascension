import { MODEL_ID } from './scenario-library.js';
export { MODEL_ID };
export const STORAGE_KEY = 'akim-evidence-register-v1';
export const MAX_FILE_BYTES = 128 * 1024;
const MAX_RECORDS = 60;
const SOURCE_URL = 'https://drive.google.com/file/d/1Uc-GdGoKhDY-spu8V50-ZMm33t2CjYLP/view';
const LIMITS = { metricLabel: 160, unit: 80, sourceTitle: 200, sourceUrl: 1000, custodian: 160, coverage: 300, method: 600, reviewNote: 600, reviewer: 120 };
const FIELDS = ['indicatorId', 'districtId', 'observedValue', 'periodStart', 'periodEnd', 'reviewStatus', 'reviewedOn', ...Object.keys(LIMITS)];
const REQUIRED = ['metricLabel', 'observedValue', 'unit', 'periodStart', 'periodEnd', 'sourceTitle', 'sourceUrl', 'custodian', 'coverage', 'method'];
const LABELS = { metricLabel: 'Измеряемая величина', observedValue: 'Измеренное значение', unit: 'Единица измерения', periodStart: 'Начало периода', periodEnd: 'Конец периода', sourceTitle: 'Название источника', sourceUrl: 'Ссылка на источник', custodian: 'Владелец данных', coverage: 'Охват измерения', method: 'Метод измерения и связь с показателем', reviewer: 'Кто проверил', reviewedOn: 'Дата проверки', reviewNote: 'Замечания к проверке' };
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = message => { throw new Error(message); };
const only = (value, fields) => isRecord(value) && Object.keys(value).every(key => fields.includes(key));
const keyOf = record => `${record.indicatorId}:${record.districtId}`;
const todayUTC = () => new Date().toISOString().slice(0, 10);

function date(value, label) {
  if (value === '' || value === undefined) return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail(`Некорректная дата: ${label}.`);
  return value;
}

function missingFields(record, today) {
  const missing = REQUIRED.filter(field => record[field] === '' || record[field] === null || record[field] === undefined).map(field => LABELS[field]);
  if (today && record.periodEnd > today) missing.push('Период измерения ещё не завершён');
  if (record.reviewStatus === 'reviewed') {
    if (!record.reviewer) missing.push(LABELS.reviewer);
    if (!record.reviewedOn) missing.push(LABELS.reviewedOn);
    if (today && record.reviewedOn > today) missing.push('Дата проверки находится в будущем');
  }
  return missing;
}

export function normalizeObservation(value, dataset) {
  if (!only(value, FIELDS)) fail('Паспорт содержит неизвестные поля или имеет неверный формат.');
  if (!dataset?.indicators?.some(item => item.id === value.indicatorId)) fail('Неизвестный показатель.');
  if (value.districtId !== 'city' && !dataset?.districts?.some(item => item.id === value.districtId)) fail('Неизвестная территория измерения.');
  const record = { indicatorId: value.indicatorId, districtId: value.districtId };
  for (const [field, limit] of Object.entries(LIMITS)) {
    const text = value[field] === undefined ? '' : value[field];
    if (typeof text !== 'string' || text.length > limit || /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/.test(text) || (!['coverage', 'method', 'reviewNote'].includes(field) && /[\r\n]/.test(text))) fail(`Некорректное поле «${LABELS[field]}» (до ${limit} символов).`);
    record[field] = text.trim();
  }
  if (record.sourceUrl) {
    let url;
    try { url = new URL(record.sourceUrl); } catch { fail('Укажите полную ссылку HTTP или HTTPS.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) fail('Источник должен быть HTTP/HTTPS без пароля в ссылке.');
  }
  record.observedValue = value.observedValue ?? null;
  if (record.observedValue !== null && (typeof record.observedValue !== 'number' || !Number.isFinite(record.observedValue))) fail('Измеренное значение должно быть конечным числом.');
  for (const field of ['periodStart', 'periodEnd', 'reviewedOn']) record[field] = date(value[field], LABELS[field]);
  if (record.periodStart && record.periodEnd && record.periodStart > record.periodEnd) fail('Начало периода должно быть не позже окончания.');
  record.reviewStatus = value.reviewStatus ?? 'draft';
  if (!['draft', 'reviewed'].includes(record.reviewStatus)) fail('Неизвестный статус проверки.');
  if (record.reviewStatus === 'reviewed' && missingFields(record).length) fail(`Для отметки проверки заполните: ${missingFields(record).join(', ')}.`);
  return record;
}

export function assessObservation(value, dataset, { today = todayUTC() } = {}) {
  const record = normalizeObservation(value, dataset);
  date(today, 'сегодня');
  const missing = missingFields(record, today);
  const complete = missing.length === 0;
  return { complete, missing, reviewed: complete && record.reviewStatus === 'reviewed', stale: Boolean(record.periodEnd && Date.parse(`${today}T00:00:00Z`) - Date.parse(`${record.periodEnd}T00:00:00Z`) > 365 * 86400000) };
}

function normalizeRecords(records, dataset) {
  if (!Array.isArray(records) || records.length > MAX_RECORDS) fail('В реестре допускается не более 60 паспортов.');
  const normalized = records.map(value => normalizeObservation(value, dataset));
  if (new Set(normalized.map(keyOf)).size !== normalized.length) fail('Повтор показателя и территории в одном файле.');
  return normalized;
}

function decodeBundle(text, dataset) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES) fail('Паспорт данных должен быть меньше 128 КиБ.');
  let value;
  try { value = JSON.parse(text); } catch { fail('Файл не содержит корректный JSON.'); }
  if (!only(value, ['schemaVersion', 'modelId', 'exportedAt', 'records']) || value.schemaVersion !== 1 || value.modelId !== MODEL_ID || typeof value.exportedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value.exportedAt) || !Number.isFinite(Date.parse(value.exportedAt)) || !new Date(value.exportedAt).toISOString().startsWith(value.exportedAt.slice(0, 19))) fail('Нужен экспорт паспортов модели official-astana-v1, версии 1.');
  return normalizeRecords(value.records, dataset);
}

export function parseEvidenceBundle(text, dataset) {
  return decodeBundle(text, dataset).map(record => ({ ...record, reviewStatus: 'draft', reviewer: '', reviewedOn: '' }));
}

export function mergeEvidence(existing, incoming, dataset) {
  const map = new Map(normalizeRecords(existing, dataset).map(record => [keyOf(record), record]));
  for (const record of normalizeRecords(incoming, dataset)) map.set(keyOf(record), record);
  return normalizeRecords([...map.values()], dataset);
}

export function serializeEvidenceBundle(records, dataset) {
  const text = JSON.stringify({ schemaVersion: 1, modelId: MODEL_ID, exportedAt: new Date().toISOString(), records: normalizeRecords(records, dataset) });
  if (new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES) fail('Реестр превышает лимит 128 КиБ. Сократите описания.');
  return text;
}

export function createEvidenceRepository(getStorage, dataset) {
  return {
    read() {
      const text = getStorage().getItem(STORAGE_KEY);
      return text === null ? [] : decodeBundle(text, dataset);
    },
    save(records) {
      getStorage().setItem(STORAGE_KEY, serializeEvidenceBundle(records, dataset));
    },
  };
}

export function mountEvidenceRegister(container, { dataset, city } = {}) {
  if (!container || !dataset?.indicators?.length || !dataset?.districts?.length) throw new Error('Для паспортов нужен контейнер и набор показателей.');
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  const repository = createEvidenceRepository(() => win.localStorage, dataset);
  let records = [], storageReady = true, disposed = false, currentCity = city, pendingImport = null, importVersion = 0;
  const el = (tag, text, className) => { const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = `evidence-${className}`; return node; };
  const root = el('div', undefined, 'register');
  const heading = el('h2', 'Источники и готовность данных');
  const summary = el('p', '', 'summary');
  const notice = el('p', 'Score рассчитывается по синтетическому набору организатора. Реальные наблюдения хранятся отдельно и не меняют формулу. Заполненный паспорт не доказывает точность модели.', 'notice');
  const message = el('p', '', 'message'); message.setAttribute('role', 'status');
  const details = el('details'); details.append(el('summary', 'Посмотреть паспорт модели и добавить источник'));
  const model = el('div', undefined, 'model');
  const source = el('a', 'Официальное приложение кейса №12'); source.href = SOURCE_URL; source.target = '_blank'; source.rel = 'noopener noreferrer';
  model.append(el('p', 'Модель official-astana-v1: пять учебных районов, 10 показателей 0–100, бюджет 100 условных единиц, горизонт 8 кварталов. Даты реальных измерений, физические единицы и калибровка эффектов отсутствуют.'), source, el('p', 'Реальный пилот требует источников для районов, сопоставления физических единиц с индексами, проверки смет и эффектов. Городской показатель не доказывает ситуацию в каждом районе.'));
  const sources = el('details'); sources.append(el('summary', 'Официальные источники для проверки'));
  const sourceLinks = [
    ['БНС: население Астаны и региональная статистика', 'https://stat.gov.kz/ru/region/astana/', 'Динамические общегородские сведения. Фиксируйте выпуск, период, единицу и разбивку; не распределяйте по учебным долям районов.'],
    ['Акимат: школы на начало 2025–2026 учебного года', 'https://www.gov.kz/memleket/entities/astana/press/news/details/1059869?lang=ru', 'Исторический срез. Количество школ не показывает дефицит мест или доступность; нужны адреса, мощность, контингент и сменность.'],
    ['Акимат: итоги здравоохранения за 2025 год', 'https://www.gov.kz/memleket/entities/astana/press/news/details/1136763?lang=ru', 'Введённые поликлиники не равны всей сети. Требуются мощность, штат, прикреплённое население и факт ввода каждого объекта.'],
    ['Акимат: паспорт территории на 1 февраля 2025 года', 'https://www.gov.kz/memleket/entities/astana/documents/details/801996?lang=ru', 'Исторический документ содержит шесть районов; учебная модель — пять. Сопоставление территорий и действующие границы не подтверждены.'],
    ['iKOMEK109: итоги десяти месяцев', 'https://www.gov.kz/memleket/entities/astana/press/news/details/1108275', 'Точный отчётный год требует подтверждения. Инциденты и обращения — разные сущности; нужны определения, районная разбивка и сроки исполнения.'],
  ];
  for (const [title, url, limitation] of sourceLinks) { const link = el('a', title); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; const item = el('div', undefined, 'source'); item.append(link, el('p', limitation)); sources.append(item); }
  sources.append(el('p', 'Каталог проверен 23.09.2026. Это дата чтения, не дата измерения. Ссылки не подтверждают причинный эффект мер и не меняют Score.'));
  model.append(sources);
  const form = el('form'); form.className = 'evidence-form';
  const controls = {};
  const field = (name, label, type = 'text', options) => {
    const wrapper = el('label', undefined, 'field'); wrapper.append(el('span', label));
    const input = el(options ? 'select' : type === 'textarea' ? 'textarea' : 'input');
    input.name = name;
    if (options) for (const [value, text] of options) { const option = el('option', text); option.value = value; input.append(option); }
    else if (type !== 'textarea') input.type = type;
    if (LIMITS[name]) input.maxLength = LIMITS[name];
    if (type === 'number') input.step = 'any';
    controls[name] = input; wrapper.append(input); form.append(wrapper); return input;
  };
  field('indicatorId', 'Направление модели', 'text', dataset.indicators.map(item => [item.id, item.name]));
  field('districtId', 'Территория измерения', 'text', [['city', 'Весь город — не районные данные'], ...dataset.districts.map(item => [item.id, item.name])]);
  for (const name of ['metricLabel', 'observedValue', 'unit', 'periodStart', 'periodEnd', 'sourceTitle', 'sourceUrl', 'custodian', 'coverage', 'method', 'reviewNote']) field(name, LABELS[name], name === 'observedValue' ? 'number' : name.startsWith('period') ? 'date' : name === 'sourceUrl' ? 'url' : ['coverage', 'method', 'reviewNote'].includes(name) ? 'textarea' : 'text');
  field('reviewStatus', 'Проверка человеком', 'text', [['draft', 'Нужно проверить'], ['reviewed', 'Проверено пользователем по источнику']]);
  field('reviewer', LABELS.reviewer); field('reviewedOn', LABELS.reviewedOn, 'date');
  const save = el('button', 'Сохранить паспорт'); save.type = 'submit'; form.append(save);
  const gaps = el('p', '', 'gaps');
  const list = el('div', undefined, 'list');
  const actions = el('div', undefined, 'actions');
  const exportButton = el('button', 'Скачать паспорта'); exportButton.type = 'button';
  const fileLabel = el('label', 'Импорт паспортов (JSON)'); const file = el('input'); file.type = 'file'; file.accept = '.json,application/json'; fileLabel.append(file);
  const importNote = el('p', '', 'import-note');
  const importButton = el('button', 'Добавить импортированные паспорта'); importButton.type = 'button'; importButton.hidden = true;
  actions.append(exportButton, fileLabel, importNote, importButton);
  details.append(model, el('p', 'Сохраняется только в этом браузере. Не вводите персональные данные или закрытые ссылки. Импорт требует повторной проверки; совпадающие паспорта заменяются только после подтверждения.'), form, gaps, list, actions);
  root.append(heading, summary, notice, message, details); container.append(root);

  const enabled = () => currentCity?.hasScenarioData === true;
  function notify(text, error = false) { message.textContent = text; message.classList.toggle('evidence-error', error); }
  function filledRecord() {
    return Object.fromEntries(Object.entries(controls).map(([name, control]) => [name, name === 'observedValue' ? control.value.trim() === '' ? null : Number(control.value) : control.value]));
  }
  function fill(value) { for (const [name, control] of Object.entries(controls)) control.value = value?.[name] ?? (name === 'indicatorId' ? dataset.indicators[0].id : name === 'districtId' ? 'city' : name === 'reviewStatus' ? 'draft' : ''); }
  function updateGaps() {
    try { const record = normalizeObservation({ ...filledRecord(), reviewStatus: 'draft' }, dataset); const assessment = assessObservation(record, dataset); gaps.textContent = assessment.missing.length ? `Нужно уточнить: ${assessment.missing.join('; ')}.` : 'Основные поля заполнены. Сверьте источник и метод перед отметкой проверки.'; }
    catch (error) { gaps.textContent = error.message; }
  }
  function render() {
    const assessments = records.map(record => assessObservation(record, dataset));
    const reviewed = assessments.filter(item => item.reviewed).length;
    summary.textContent = enabled() ? `Паспортов: ${records.length}; проверено пользователем: ${reviewed}. Реальная модель эффекта не откалибрована.` : 'Для выбранной территории расчётная модель и её паспорта не подключены. Сохранённые паспорта Астаны остаются в браузере.';
    form.hidden = !enabled(); list.hidden = !enabled(); actions.hidden = !enabled(); gaps.hidden = !enabled();
    save.disabled = !storageReady || !enabled(); file.disabled = !storageReady || !enabled(); exportButton.disabled = !records.length || !storageReady || !enabled();
    list.replaceChildren();
    records.forEach((record, index) => {
      const item = el('details');
      const indicator = dataset.indicators.find(value => value.id === record.indicatorId).name;
      const district = record.districtId === 'city' ? 'Весь город' : dataset.districts.find(value => value.id === record.districtId).name;
      const assessment = assessments[index];
      item.append(el('summary', `${indicator} · ${district} · ${assessment.reviewed ? 'проверено пользователем' : 'нужно проверить'}${assessment.stale ? ' · данные старше года' : ''}`));
      item.append(el('p', `${record.metricLabel || 'Величина не указана'}: ${record.observedValue ?? 'нет значения'} ${record.unit}. Период: ${record.periodStart || '?'} — ${record.periodEnd || '?'}.`));
      if (record.sourceUrl) { const link = el('a', record.sourceTitle || 'Открыть источник'); link.href = record.sourceUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; item.append(link); }
      item.append(el('p', `Охват: ${record.coverage || 'не указан'}. Метод: ${record.method || 'не указан'}.`));
      if (assessment.missing.length) item.append(el('p', `Не хватает: ${assessment.missing.join('; ')}.`));
      const edit = el('button', 'Открыть для изменения'); edit.type = 'button'; edit.addEventListener('click', () => { fill(record); updateGaps(); controls.metricLabel.focus(); }); item.append(edit); list.append(item);
    });
  }
  function load() {
    try { records = repository.read(); storageReady = true; }
    catch (error) { storageReady = false; notify(`Не удалось прочитать сохранённые паспорта: ${error.message} Данные не перезаписаны. Сохранение отключено до восстановления хранилища браузера.`, true); }
    render();
  }
  form.addEventListener('input', updateGaps);
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!enabled() || !storageReady || disposed) return;
    try {
      const record = normalizeObservation(filledRecord(), dataset);
      const assessment = assessObservation(record, dataset);
      if (record.reviewStatus === 'reviewed' && !assessment.reviewed) fail(`Проверка не завершена: ${assessment.missing.join('; ')}.`);
      const next = mergeEvidence(records, [record], dataset);
      repository.save(next); records = next; ++importVersion; pendingImport = null; importButton.hidden = true; importNote.textContent = ''; file.value = ''; render(); notify('Паспорт сохранён локально. Официальный расчёт не изменён.');
    } catch (error) { notify(`Не сохранено: ${error.message}`, true); }
  });
  exportButton.addEventListener('click', () => {
    if (!enabled() || !storageReady || !records.length || disposed) return;
    const blob = new win.Blob([serializeEvidenceBundle(records, dataset)], { type: 'application/json;charset=utf-8' });
    const url = win.URL.createObjectURL(blob); const anchor = el('a'); anchor.href = url; anchor.download = 'astana-data-passports.json'; anchor.click(); win.setTimeout(() => win.URL.revokeObjectURL(url), 1000);
  });
  file.addEventListener('change', async () => {
    const version = ++importVersion; pendingImport = null; importButton.hidden = true; importNote.textContent = '';
    const selected = file.files?.[0]; if (!selected || !enabled() || !storageReady) return;
    try {
      if (selected.size > MAX_FILE_BYTES) fail('Лимит импорта — 128 КиБ.');
      const text = await selected.text();
      if (disposed || version !== importVersion || !enabled()) return;
      pendingImport = parseEvidenceBundle(text, dataset);
      mergeEvidence(records, pendingImport, dataset);
      const replaced = pendingImport.filter(record => records.some(existing => keyOf(existing) === keyOf(record))).length;
      importNote.textContent = `Будет добавлено паспортов: ${pendingImport.length}. Совпадений для замены: ${replaced}. Все импортированные записи потребуют повторной проверки.`;
      importButton.hidden = !pendingImport.length;
    } catch (error) { if (version === importVersion && !disposed) notify(`Импорт не выполнен: ${error.message}`, true); }
  });
  importButton.addEventListener('click', () => {
    if (!pendingImport || !enabled() || !storageReady || disposed) return;
    try { const next = mergeEvidence(records, pendingImport, dataset); repository.save(next); records = next; pendingImport = null; importButton.hidden = true; importNote.textContent = ''; file.value = ''; render(); notify('Паспорта импортированы как непроверенные наблюдения. Score не изменён.'); }
    catch (error) { notify(`Импорт не сохранён: ${error.message}`, true); }
  });
  const onCity = event => { currentCity = event.detail; ++importVersion; pendingImport = null; importButton.hidden = true; importNote.textContent = ''; file.value = ''; render(); };
  const onStorage = event => { if (event.key === STORAGE_KEY || event.key === null) { ++importVersion; pendingImport = null; importButton.hidden = true; load(); } };
  win.addEventListener('city:changed', onCity); win.addEventListener('storage', onStorage);
  fill(); updateGaps(); load();
  return () => { disposed = true; ++importVersion; win.removeEventListener('city:changed', onCity); win.removeEventListener('storage', onStorage); root.remove(); };
}
