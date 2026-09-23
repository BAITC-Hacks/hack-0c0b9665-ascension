import { MODEL_ID } from './scenario-library.js';

const DISCLAIMER = 'Учебная модель. Не прогноз для реальной Астаны';
const LIMITS = [
  'Адреса и конкретные объекты для исполнения не определены.',
  'Реальные цены и численность населения не подтверждены; бюджет указан в условных единицах, не в тенге.',
  'Смета, техническая мощность и выполнимость мер не проверены.',
  'Эффект и сроки в реальности не подтверждены. Лаг модели не является сроком строительства.',
  'Ответственные и календарный план не назначены. Для управленческого решения нужны проверенные исходные данные и отдельная оценка реализуемости.',
];
const SOURCES = [
  ['ТЗ официального кейса №12 «Аким на 5 часов»', 'https://drive.google.com/file/d/1oDZtYnBgbcn_Ii7vleP87hkARJ2HmbXl7Cw_rsCxqpo/view'],
  ['Официальное приложение «Датасет районов» — исходные показатели, меры, ограничения и формула', 'https://drive.google.com/file/d/1Uc-GdGoKhDY-spu8V50-ZMm33t2CjYLP/view'],
];
const mounted = new WeakMap();
const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const fmt = (value) => number.format(value);
const delta = (value) => `${value > 0 ? '+' : ''}${fmt(value)}`;
const fail = () => { throw new Error('Расчёт неполный или повреждён. Рассчитайте план заново.'); };
const finite = (value) => { if (typeof value !== 'number' || !Number.isFinite(value)) fail(); return value; };
const name = (value) => { if (typeof value !== 'string' || !value.trim() || value.length > 400) fail(); return value; };
const timestamp = (value) => { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(); return new Date(value).toISOString(); };
const text = (value, max, fallback = '') => (typeof value === 'string' ? value.trim().slice(0, max) : '') || fallback;
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const dateText = (value) => `${value.slice(0, 10)} ${value.slice(11, 19)} UTC`;

// Display-only projection: no simulator, AI, persistence, or numeric model is run here.
export function captureDecisionBrief(detail, { dataset, city, createdAt = new Date().toISOString() } = {}) {
  if (city?.hasScenarioData !== true) throw new Error('Для выбранного города нет данных учебной модели.');
  const result = detail?.result;
  if (result?.valid !== true || detail?.scenario?.decisions?.length !== 5
      || !Array.isArray(dataset?.districts) || !dataset.districts.length
      || !Array.isArray(dataset?.indicators) || !dataset.indicators.length
      || !Array.isArray(dataset?.measures) || !Array.isArray(result.districts)
      || result.districts.length !== dataset.districts.length) fail();
  const budget = finite(dataset.budget);
  const horizon = finite(dataset.horizon);
  if (budget < 0 || horizon <= 0) fail();
  const measures = new Map(dataset.measures.map((row) => [row.id, row]));
  const districtNames = new Map(dataset.districts.map((row) => [row.id, name(row.name)]));
  const indicators = dataset.indicators.map((row) => ({ id: row.id, name: name(row.name) }));
  const seenMeasures = new Set();
  const decisions = detail.scenario.decisions.map((decision) => {
    const measure = measures.get(decision?.measureId);
    if (!measure || seenMeasures.has(measure.id)) fail();
    seenMeasures.add(measure.id);
    if (!['city', 'district'].includes(measure.scope)
        || (measure.scope === 'district' && !districtNames.has(decision.districtId))
        || (measure.scope === 'city' && decision.districtId !== undefined)) fail();
    const cost = finite(measure.cost);
    const lag = finite(measure.lag);
    if (cost < 0 || lag < 0 || lag > horizon) fail();
    return { name: name(measure.name), area: measure.scope === 'city' ? 'Все районы модели' : `Район ${districtNames.get(decision.districtId)}`, cost, lag };
  });
  const seenDistricts = new Set();
  const districts = result.districts.map((row) => {
    if (!districtNames.has(row?.id) || seenDistricts.has(row.id)) fail();
    seenDistricts.add(row.id);
    return {
      name: districtNames.get(row.id), beforeScore: finite(row.beforeScore), afterScore: finite(row.afterScore),
      indicators: indicators.map((indicator) => ({ name: indicator.name,
        before: finite(row.before?.[indicator.id]), after: finite(row.after?.[indicator.id]), delta: finite(row.delta?.[indicator.id]) })),
    };
  });
  const metrics = Object.fromEntries(['baselineScore', 'score', 'deltaScore', 'totalCost', 'remainingBudget', 'criticalCount', 'worstDistrictScore']
    .map((key) => [key, finite(result[key])]));
  if (metrics.totalCost < 0 || metrics.remainingBudget < 0 || !Number.isInteger(metrics.criticalCount)
      || metrics.criticalCount < 0 || metrics.criticalCount > districts.length * indicators.length) fail();
  const worst = districts.filter((row) => Math.abs(row.afterScore - metrics.worstDistrictScore) < 1e-8).map((row) => row.name);
  if (!worst.length) fail();
  const criticalBefore = [];
  const criticalAfter = [];
  const worsened = [];
  for (const district of districts) for (const indicator of district.indicators) {
    const row = { district: district.name, ...indicator };
    if (indicator.before < 40) criticalBefore.push(row);
    if (indicator.after < 40) criticalAfter.push(row);
    if (indicator.delta < 0) worsened.push(row);
  }
  if (criticalAfter.length !== metrics.criticalCount || !Array.isArray(result.synergies)) fail();
  const synergies = result.synergies.map((row) => {
    if (!Array.isArray(row.pair) || row.pair.length !== 2 || !districtNames.has(row.districtId)) fail();
    return { measures: row.pair.map((id) => name(measures.get(id)?.name)), district: districtNames.get(row.districtId) };
  });
  return { modelId: MODEL_ID, createdAt: timestamp(createdAt), city: name(city.name || 'Астана'),
    budget, horizon, decisions, metrics, districts, worst, criticalBefore, criticalAfter, worsened, synergies };
}

function content(snapshot, { title, goal } = {}) {
  const m = snapshot.metrics;
  const rowText = (row) => `Район ${row.district} — ${row.name}: ${fmt(row.before)} → ${fmt(row.after)} (${delta(row.delta)})`;
  return {
    title: text(title, 100, 'Записка для совещания'),
    goal: text(goal, 500, 'Рассмотреть выбранный набор мер в пределах бюджета учебной модели.'),
    meta: `Город модели: ${snapshot.city} · Снимок расчёта: ${dateText(snapshot.createdAt)}`,
    score: `${fmt(m.baselineScore)} → ${fmt(m.score)} (${delta(m.deltaScore)})`,
    budget: `${fmt(m.totalCost)} из ${fmt(snapshot.budget)} усл. ед. · Остаток ${fmt(m.remainingBudget)} усл. ед.`,
    critical: `${snapshot.criticalBefore.length} → ${m.criticalCount}. Критический показатель — строго ниже 40 из 100.`,
    worst: `${snapshot.worst.join(', ')} — ${fmt(m.worstDistrictScore)} после мер`,
    horizon: `Горизонт модели: ${fmt(snapshot.horizon)} кварталов. Лаг — задержка до начала действия меры в кварталах модели. Чем позже начало, тем меньшая часть эффекта учитывается к концу горизонта. Результат уже учитывает лаги и сочетания мер. Это условное время, не календарный график работ.`,
    criticalRows: snapshot.criticalAfter.map(rowText),
    worsenedRows: snapshot.worsened.map(rowText),
    synergies: snapshot.synergies.map((row) => `Район ${row.district}: ${row.measures.join(' + ')}`),
  };
}

// All interpolated values are escaped; the file needs no app, scripts, fonts or network.
export function renderDecisionBriefHTML(snapshot, { title, goal, exportedAt = new Date().toISOString() } = {}) {
  const c = content(snapshot, { title, goal });
  const h = escapeHTML;
  const list = (items) => `<ul>${items.map((item) => `<li>${h(item)}</li>`).join('')}</ul>`;
  const table = (caption, headers, rows) => `<table><caption>${h(caption)}</caption><thead><tr>${headers.map((item) => `<th scope="col">${h(item)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value) => `<td>${h(value)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${h(c.title)}</title><style>
  *{box-sizing:border-box}body{margin:0 auto;padding:32px 20px;max-width:1000px;font:16px/1.55 system-ui,sans-serif;color:#173b32;background:white;overflow-wrap:anywhere}h1{line-height:1.2}h2{margin-top:28px;font-size:21px}.notice{padding:14px;border:2px solid #a66416;background:#fff7e9}.meta{font-size:13px;color:#465b54}table{width:100%;border-collapse:collapse;margin:22px 0;font-size:14px;table-layout:fixed}caption{text-align:left;font-weight:700;padding:8px 0}th,td{text-align:left;vertical-align:top;border:1px solid #c8d4cd;padding:8px}th{background:#eef4ef}a{color:#175c49}li{margin:6px 0}@media(max-width:480px){body{padding:18px 12px;font-size:15px}th,td{padding:5px;font-size:12px}}@media print{body{max-width:none;padding:0;color:black;font-size:10pt}h2{break-after:avoid}tr{break-inside:avoid}thead{display:table-header-group}.notice{background:white}a{color:black}.print-help{display:none}@page{margin:14mm}}
  </style></head><body><h1>${h(c.title)}</h1><p class="notice"><strong>${h(DISCLAIMER)}</strong></p><p>${h(c.goal)}</p><p class="meta">${h(c.meta)}<br>Файл сформирован: ${h(dateText(timestamp(exportedAt)))}<br>Модель официального кейса №12 · ${h(snapshot.modelId)}</p>
  <h2>Решение на рассмотрении</h2><p>Рассматривается набор из ${snapshot.decisions.length} мер. Это результат учебного расчёта, а не утверждённый план исполнения.</p>
  <p><strong>Оценка качества жизни (Score), до → после → изменение:</strong> ${h(c.score)}</p><p><strong>Бюджет:</strong> ${h(c.budget)}</p><p><strong>Критических показателей:</strong> ${h(c.critical)}</p><p><strong>Худший район:</strong> ${h(c.worst)}</p>
  ${table('Выбранные меры', ['Мера', 'Территория', 'Стоимость, усл. ед.', 'Лаг, кварталы модели'], snapshot.decisions.map((row) => [row.name, row.area, fmt(row.cost), fmt(row.lag)]))}
  <p>${h(c.horizon)}</p>${table('Оценки районов', ['Район', 'До', 'После', 'Изменение'], snapshot.districts.map((row) => [row.name, fmt(row.beforeScore), fmt(row.afterScore), delta(row.afterScore - row.beforeScore)]))}
  <h2>Критические показатели после мер</h2>${list(c.criticalRows.length ? c.criticalRows : ['В учебном расчёте после мер показателей ниже 40 нет.'])}
  <h2>Ухудшения и компромиссы</h2>${list(c.worsenedRows.length ? c.worsenedRows : ['В учебном расчёте снижения показателей относительно исходного состояния нет. Это не подтверждает отсутствие реальных рисков.'])}<p>Затраты используют общий ограниченный бюджет. Неучтённые последствия и альтернативные способы исполнения модель не оценивает.</p>
  ${c.synergies.length ? `<h2>Учтённые сочетания мер</h2>${list(c.synergies)}` : ''}
  <h2>Что НЕ подтверждено</h2>${list(LIMITS)}
  ${table('Все показатели модели — больше означает лучше; изменения в пунктах', ['Район / показатель', 'До', 'После', 'Изменение'], snapshot.districts.flatMap((district) => district.indicators.map((row) => [`${district.name} / ${row.name}`, fmt(row.before), fmt(row.after), delta(row.delta)])))}
  <h2>Источники и границы</h2><ul>${SOURCES.map(([label, url]) => `<li><a href="${h(url)}" rel="noreferrer">${h(label)}</a></li>`).join('')}</ul><p>Исходные данные организаторов синтетические. Дата реальных измерений и физические единицы показателей не заданы. Время снимка — время получения расчёта, не дата измерений. Числа взяты из успешного серверного расчёта и датасета приложения. Округление только для чтения; изменение вычислено до округления. Идентификатор модели обозначает набор кейса и не является проверкой целостности файла.</p><p class="notice">${h(DISCLAIMER)}</p><p class="print-help">Для печати откройте этот HTML-файл в браузере и используйте Ctrl+P (на macOS — Cmd+P). Файл читается без приложения и подключения к сети.</p></body></html>`;
}

export function mountDecisionBrief(container, { dataset, city } = {}) {
  if (!container?.ownerDocument) throw new Error('Для записки нужен DOM-контейнер.');
  mounted.get(container)?.();
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  let currentCity = city;
  let snapshot = null;
  let disposed = false;
  const urls = new Map();
  const el = (tag, cls, value) => {
    const node = doc.createElement(tag);
    node.className = `decision-brief-${cls}`;
    if (value !== undefined) node.textContent = value;
    return node;
  };
  const root = el('section', 'root');
  root.setAttribute('aria-label', 'Записка для совещания');
  const heading = el('h2', 'heading', 'Записка для совещания');
  const notice = el('p', 'notice', DISCLAIMER);
  const edit = el('details', 'edit'); edit.append(el('summary', 'summary', 'Название и цель записки (необязательно)'));
  const form = el('div', 'fields');
  const titleLabel = el('label', 'label', 'Название записки · до 100 символов');
  const title = el('input', 'input'); title.type = 'text'; title.maxLength = 100; title.value = ''; title.placeholder = 'Например: Приоритеты Нуры';
  titleLabel.append(title);
  const goalLabel = el('label', 'label', 'Цель обсуждения · до 500 символов');
  const goal = el('textarea', 'input'); goal.maxLength = 500; goal.rows = 2; goal.value = ''; goal.placeholder = 'Какое решение нужно обсудить';
  goalLabel.append(goal); form.append(titleLabel, goalLabel); edit.append(form);
  const download = el('button', 'download', 'Скачать записку'); download.type = 'button'; download.disabled = true;
  const help = el('p', 'hint', 'Автономный HTML для чтения и печати (Ctrl+P / Cmd+P). Название и цель остаются на этом устройстве.');
  const status = el('p', 'status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const preview = el('div', 'preview');
  root.append(heading, notice, edit, download, help, status, preview); container.append(root);
  const list = (parent, items) => {
    const ul = el('ul', 'list');
    items.forEach((value) => ul.append(el('li', 'item', value)));
    parent.append(ul);
  };
  const table = (parent, caption, headers, rows) => {
    const wrap = el('div', 'table-wrap'); wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', caption);
    const node = el('table', 'table'); node.append(el('caption', 'caption', caption));
    const head = el('thead', 'thead'); const tr = el('tr', 'row');
    headers.forEach((value) => { const th = el('th', 'cell', value); th.setAttribute('scope', 'col'); tr.append(th); }); head.append(tr);
    const body = el('tbody', 'tbody');
    rows.forEach((row) => { const tr = el('tr', 'row'); row.forEach((value) => tr.append(el('td', 'cell', value))); body.append(tr); });
    node.append(head, body); wrap.append(node); parent.append(wrap);
  };
  function render() {
    preview.replaceChildren();
    if (!snapshot) return;
    const c = content(snapshot, { title: title.value, goal: goal.value });
    const previewTitle = el('h3', 'preview-title', c.title); previewTitle.hidden = !text(title.value, 100);
    const previewGoal = el('p', 'goal', c.goal); previewGoal.hidden = !text(goal.value, 500);
    preview.append(previewTitle, previewGoal, el('p', 'meta', c.meta));
    const metrics = el('dl', 'metrics');
    for (const [label, value] of [['Оценка качества жизни (Score): до → после (изменение)', c.score], ['Бюджет', c.budget], ['Критических (строго ниже 40)', `${snapshot.criticalBefore.length} → ${snapshot.metrics.criticalCount}`], ['Худший район после мер', c.worst]]) {
      const pair = el('div', 'metric'); pair.append(el('dt', 'metric-label', label), el('dd', 'metric-value', value)); metrics.append(pair);
    }
    preview.append(metrics, el('h3', 'subheading', 'Решение на рассмотрении — пять выбранных мер'));
    list(preview, snapshot.decisions.map((row) => `${row.name} · ${row.area}`));
    preview.append(el('p', 'hint', `Горизонт — ${fmt(snapshot.horizon)} кварталов модели. Лаг — условная задержка начала действия меры; он уже учтён в результате. Это не срок реальных работ.`));
    preview.append(el('h3', 'subheading', 'Критические показатели после мер'));
    list(preview, c.criticalRows.length ? c.criticalRows : ['В учебном расчёте после мер показателей ниже 40 нет.']);
    preview.append(el('h3', 'subheading', 'Ухудшения и компромиссы'));
    list(preview, c.worsenedRows.length ? c.worsenedRows : ['В учебном расчёте снижения показателей нет. Это не подтверждает отсутствие реальных рисков.']);
    preview.append(el('p', 'hint', 'Не подтверждены: адреса и объекты, реальные цены и население, смета и мощность, эффект и сроки. Ответственные не назначены. Затраты — условные единицы; не тенге.'));
    const details = el('details', 'details'); details.append(el('summary', 'summary', 'Подробности: горизонт, таблицы, ограничения и источники'));
    details.append(el('p', 'hint', c.horizon));
    table(details, 'Стоимость и лаг выбранных мер', ['Мера', 'Территория', 'Усл. ед.', 'Лаг, кварт.'], snapshot.decisions.map((row) => [row.name, row.area, fmt(row.cost), fmt(row.lag)]));
    table(details, 'Оценки районов', ['Район', 'До', 'После', 'Изменение'], snapshot.districts.map((row) => [row.name, fmt(row.beforeScore), fmt(row.afterScore), delta(row.afterScore - row.beforeScore)]));
    if (c.synergies.length) { details.append(el('h3', 'subheading', 'Учтённые сочетания мер')); list(details, c.synergies); }
    table(details, 'Показатели модели — больше означает лучше; изменения в пунктах', ['Район / показатель', 'До', 'После', 'Изменение'], snapshot.districts.flatMap((district) => district.indicators.map((row) => [`${district.name} / ${row.name}`, fmt(row.before), fmt(row.after), delta(row.delta)])));
    details.append(el('h3', 'subheading', 'Что НЕ подтверждено')); list(details, LIMITS);
    details.append(el('h3', 'subheading', 'Источники — модель официального кейса №12'), el('p', 'meta', snapshot.modelId));
    for (const [label, url] of SOURCES) { const p = el('p', 'source'); const a = el('a', 'link', label); a.href = url; a.rel = 'noreferrer'; p.append(a); details.append(p); }
    details.append(el('p', 'hint', 'Исходные данные организаторов синтетические; дата реальных измерений и физические единицы не заданы. Время снимка — время получения расчёта, не дата измерений. Округление только для чтения; изменение вычислено до округления. Идентификатор обозначает набор кейса, не проверку целостности файла.'));
    preview.append(details);
  }
  function clear(message) {
    snapshot = null; download.disabled = true; preview.replaceChildren(); status.textContent = message;
  }
  function onCalculated(event) {
    if (disposed) return;
    if (currentCity?.hasScenarioData !== true) { clear('Для выбранного города нет данных учебной модели. Вернитесь к модели Астаны и рассчитайте план.'); return; }
    try {
      snapshot = captureDecisionBrief(event.detail, { dataset, city: currentCity });
      download.disabled = false; status.textContent = 'Записка готова по последнему успешному расчёту.'; render();
    } catch (error) { clear(error.message); }
  }
  const onInvalidated = () => clear('План изменён. Для новой записки рассчитайте его заново.');
  const onCity = (event) => {
    currentCity = event.detail;
    clear(currentCity?.hasScenarioData === true ? 'Город изменён. Рассчитайте план заново для записки.' : 'Для выбранного города нет данных учебной модели. Вернитесь к модели Астаны и рассчитайте план.');
  };
  const onInput = () => render();
  const release = (url) => { win.URL.revokeObjectURL(url); urls.delete(url); };
  const onDownload = () => {
    if (disposed || !snapshot || currentCity?.hasScenarioData !== true) return;
    let url;
    let anchor;
    try {
      const html = renderDecisionBriefHTML(snapshot, { title: title.value, goal: goal.value });
      url = win.URL.createObjectURL(new win.Blob([html], { type: 'text/html;charset=utf-8' }));
      anchor = doc.createElement('a'); anchor.href = url; anchor.download = `decision-brief-${snapshot.createdAt.slice(0, 10)}.html`; anchor.hidden = true;
      root.append(anchor); anchor.click();
      urls.set(url, win.setTimeout(() => release(url), 1000));
      status.textContent = 'HTML-файл подготовлен к скачиванию. Откройте его в браузере; для печати используйте Ctrl+P / Cmd+P.';
    } catch { if (url) release(url); status.textContent = 'Не удалось подготовить файл. Попробуйте скачать записку ещё раз.'; }
    finally { anchor?.remove(); }
  };
  title.addEventListener('input', onInput); goal.addEventListener('input', onInput); download.addEventListener('click', onDownload);
  win.addEventListener('scenario:calculated', onCalculated); win.addEventListener('scenario:invalidated', onInvalidated);
  win.addEventListener('scenario:load', onInvalidated); win.addEventListener('city:changed', onCity);
  clear(city?.hasScenarioData === true ? 'Выберите пять мер и выполните расчёт. Здесь появится записка для совещания.' : 'Для выбранного города нет данных учебной модели. Вернитесь к модели Астаны и рассчитайте план.');
  const dispose = () => {
    if (disposed) return;
    disposed = true; snapshot = null;
    win.removeEventListener('scenario:calculated', onCalculated); win.removeEventListener('scenario:invalidated', onInvalidated);
    win.removeEventListener('scenario:load', onInvalidated); win.removeEventListener('city:changed', onCity);
    title.removeEventListener('input', onInput); goal.removeEventListener('input', onInput); download.removeEventListener('click', onDownload);
    for (const [url, timer] of urls) { win.clearTimeout(timer); release(url); }
    root.remove(); mounted.delete(container);
  };
  mounted.set(container, dispose);
  return dispose;
}
