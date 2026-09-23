const $ = (id) => document.getElementById(id);
const directions = {
  transport: { name: 'Транспорт' },
  ecology: { name: 'Экология' },
  social: { name: 'Социальная сфера' },
  safety: { name: 'Безопасность' },
  services: { name: 'Городской сервис' },
};
const measureArtwork = {
  M1: 'transport.webp',
  M2: 'traffic-lights.webp',
  M3: 'light-rail.webp',
  M4: 'ecology.webp',
  M5: 'clean-heating.webp',
  M6: 'green-belt.webp',
  M7: 'school.webp',
  M8: 'clinic.webp',
  M9: 'sports.webp',
  M10: 'safety.webp',
  M11: 'safe-crossing.webp',
  M12: 'digital-service.webp',
  M13: 'utilities.webp',
  M14: 'emergency-crew.webp',
};
const districtArtwork = {
  esil: 'district-yesil.webp',
  almaty: 'district-almaty.webp',
  saryarka: 'district-saryarka.webp',
  baikonur: 'district-baikonur.webp',
  nura: 'district-nura.webp',
};
const demo = [
  { measureId: 'M7', districtId: 'nura' },
  { measureId: 'M8', districtId: 'nura' },
  { measureId: 'M10', districtId: 'nura' },
  { measureId: 'M12' },
  { measureId: 'M5', districtId: 'saryarka' },
];
const state = {
  dataset: null, baseline: null, decisions: [], totalCost: 0, filter: 'all', picks: {},
  result: null, busy: false, simulating: false, version: 0, mutationId: 0, simulationId: 0, explanationId: 0,
};
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const number = (value, digits = 2) => Number(value).toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const signed = (value, digits = 2) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${number(Math.abs(value), digits)}`;
const measureById = (id) => state.dataset.measures.find((measure) => measure.id === id);
const districtName = (id) => state.dataset.districts.find((district) => district.id === id)?.name ?? 'Весь город';
const indicatorName = (id) => state.dataset.indicators.find((indicator) => indicator.id === id)?.name ?? id;
const scenario = () => ({ decisions: state.decisions.map((decision) => ({ ...decision })) });

async function api(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), path === '/api/explain' ? 65000 : 15000);
  try {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok && !Array.isArray(data.errors)) throw new Error(data.message || data.error || `Сервер вернул ошибку ${response.status}.`);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Сервер не ответил вовремя. Повторите запрос.');
    if (error instanceof TypeError) throw new Error('Нет связи с сервером. Проверьте, что приложение запущено, и повторите.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function announce(message) { $('announcer').textContent = message; }
function showErrors(errors) {
  const messages = errors.map((error) => typeof error === 'string' ? error : error.message);
  $('error-box').innerHTML = `<strong>Изменение не применено</strong><ul>${messages.map((message) => `<li>${escapeHtml(message)}</li>`).join('')}</ul>`;
  $('error-box').hidden = false;
  $('error-box').focus({ preventScroll: true });
  $('error-box').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  announce(messages.join(' '));
}
function clearErrors() { $('error-box').hidden = true; $('error-box').textContent = ''; }

function districtOptions(selected, includePlaceholder = false) {
  return `${includePlaceholder ? `<option value=""${!selected ? ' selected' : ''}>Выберите район</option>` : ''}${state.dataset.districts.map((district) => `<option value="${district.id}"${selected === district.id ? ' selected' : ''}>${escapeHtml(district.name)}</option>`).join('')}`;
}

function renderFilters() {
  const filters = [{ id: 'all', name: 'Все меры' }, ...Object.entries(directions).map(([id, item]) => ({ id, name: item.name }))];
  $('filters').innerHTML = filters.map((filter) => {
    const count = state.dataset.measures.filter((measure) => filter.id === 'all' || measure.direction === filter.id).length;
    return `<button class="filter" data-filter="${filter.id}" aria-pressed="${state.filter === filter.id}">${filter.name}<span class="filter-count">${count}</span></button>`;
  }).join('');
}

function renderCatalog() {
  const measures = state.dataset.measures.filter((measure) => state.filter === 'all' || measure.direction === state.filter);
  $('catalog').innerHTML = measures.map((measure) => {
    const selected = state.decisions.some((decision) => decision.measureId === measure.id);
    const full = state.decisions.length >= 5;
    const needsDistrict = measure.scope === 'district' && !state.picks[measure.id];
    const disabled = selected || full || needsDistrict || state.busy;
    const direction = directions[measure.direction];
    const note = selected ? 'Уже в вашем плане' : full ? 'В плане уже 5 решений' : needsDistrict ? 'Сначала выберите район' : `Эффекты до учёта лага ${measure.lag} кв.`;
    return `<article class="measure-card${selected ? ' is-selected' : ''}" data-measure="${measure.id}">
      <div class="measure-top"><div class="measure-category"><img class="direction-art" src="/assets/illustrations/${measureArtwork[measure.id]}" alt="" width="56" height="56" loading="lazy" decoding="async"><span class="direction-tag" data-direction="${measure.direction}">${direction.name}</span></div><span class="measure-id">${measure.id}</span></div>
      <h3>${escapeHtml(measure.name)}</h3>
      <div class="measure-meta"><span class="measure-cost">${measure.cost}<small>у. е.</small></span><span class="measure-lag">Лаг: ${measure.lag} кв.</span><span class="measure-lag">${measure.scope === 'city' ? 'Весь город' : 'Один район'}</span></div>
      <div class="effect-chips">${Object.entries(measure.effects).map(([id, effect]) => `<span class="effect-chip${effect < 0 ? ' negative' : ''}" title="${escapeHtml(indicatorName(id))}">${id} ${signed(effect, 0)}</span>`).join('')}</div>
      <div class="scope-picker">${measure.scope === 'district' ? `<label class="field-label" for="district-${measure.id}">Район реализации</label><select id="district-${measure.id}" data-pick="${measure.id}"${state.busy || selected ? ' disabled' : ''}>${districtOptions(state.picks[measure.id], true)}</select>` : '<span class="field-label">Масштаб реализации</span><div class="city-scope"><span aria-hidden="true">◎</span> Все 5 районов</div>'}</div>
      <button class="add-button${selected ? ' is-added' : ''}" data-add="${measure.id}" aria-label="${selected ? 'Добавлено' : 'Добавить'}: ${escapeHtml(measure.name)}" aria-describedby="note-${measure.id}"${disabled ? ' disabled' : ''}><span aria-hidden="true">${selected ? '✓' : '+'}</span>${selected ? 'В сценарии' : 'Добавить в план'}</button>
      <p class="add-note" id="note-${measure.id}">${note}</p>
    </article>`;
  }).join('');
}

function renderPlan() {
  $('selected-list').innerHTML = state.decisions.length === 0
    ? '<div class="empty-plan"><img class="empty-plan-art" src="/assets/illustrations/plan.webp" alt="" width="92" height="92" decoding="async"><div><h3>Всё начинается с первого шага</h3><p>Добавьте инициативы из каталога<br>или загрузите демо-сценарий.</p></div></div>'
    : state.decisions.map((decision, index) => {
      const measure = measureById(decision.measureId);
      return `<article class="selected-item"><span class="selected-number">${index + 1}</span><div class="selected-info"><h3>${measure.id} · ${escapeHtml(measure.name)}</h3>${measure.scope === 'district' ? `<label class="sr-only" for="selected-${measure.id}">Район для ${escapeHtml(measure.name)}</label><select id="selected-${measure.id}" data-change="${measure.id}"${state.busy ? ' disabled' : ''}>${districtOptions(decision.districtId)}</select>` : '<span class="selected-cost">Весь город · все 5 районов</span>'}<p class="selected-cost">${measure.cost} у. е.</p></div><button class="remove-button" data-remove="${measure.id}" aria-label="Удалить: ${escapeHtml(measure.name)}"${state.busy ? ' disabled' : ''}>×</button></article>`;
    }).join('');
  const left = state.dataset.budget - state.totalCost;
  $('budget-left').textContent = left;
  $('decision-count').textContent = state.decisions.length;
  $('plan-count').textContent = `${state.decisions.length}/5`;
  $('decision-dots').innerHTML = Array.from({ length: 5 }, (_, index) => `<span class="${index < state.decisions.length ? 'filled' : ''}"></span>`).join('');
  $('budget-bar').style.width = `${Math.min(100, state.totalCost / state.dataset.budget * 100)}%`;
  $('plan-total').textContent = state.totalCost;
  $('plan-left').textContent = left;
  $('simulate-button').disabled = state.busy || state.simulating || state.decisions.length !== 5;
  $('simulate-button').innerHTML = state.simulating ? 'Рассчитываем…' : 'Рассчитать сценарий <span aria-hidden="true">↗</span>';
  $('simulate-hint').textContent = state.busy ? 'Проверяем совместимость решений…' : state.simulating ? 'Проверяем влияние на все районы' : state.decisions.length < 5 ? `Выберите ещё ${5 - state.decisions.length} ${5 - state.decisions.length === 1 ? 'решение' : 5 - state.decisions.length < 5 ? 'решения' : 'решений'}` : 'Пять решений готовы к расчёту';
  $('demo-button').disabled = state.busy;
  $('reset-button').disabled = state.busy || state.decisions.length === 0;
}

function invalidateResult() {
  state.version += 1;
  state.simulationId += 1;
  state.explanationId += 1;
  state.result = null;
  state.simulating = false;
  $('result-content').hidden = true;
  $('result-content').textContent = '';
  $('result-placeholder').hidden = false;
  $('result-state').textContent = 'Ожидает расчёта';
  renderDistricts(state.baseline, false);
}

async function applyDecisions(decisions, message) {
  if (state.busy) return false;
  const requestId = ++state.mutationId;
  state.busy = true;
  clearErrors();
  renderPlan();
  renderCatalog();
  try {
    const validation = await api('/api/validate', { decisions });
    if (requestId !== state.mutationId) return false;
    if (!Array.isArray(validation.errors) || !Number.isFinite(validation.totalCost)) throw new Error('Сервер вернул некорректный результат проверки.');
    const blockingErrors = validation.errors.filter((error) => error.code !== 'DECISION_COUNT' || decisions.length >= 5);
    if (blockingErrors.length) { showErrors(blockingErrors); return false; }
    state.decisions = decisions.map((decision) => ({ ...decision }));
    state.totalCost = validation.totalCost;
    for (const decision of decisions) if (decision.districtId) state.picks[decision.measureId] = decision.districtId;
    invalidateResult();
    announce(`${message} Выбрано ${decisions.length} из 5. Осталось ${state.dataset.budget - state.totalCost} условных единиц.`);
    return true;
  } catch (error) {
    if (requestId === state.mutationId) showErrors([error.message]);
    return false;
  } finally {
    if (requestId === state.mutationId) { state.busy = false; renderPlan(); renderCatalog(); }
  }
}

function renderDistricts(result, calculated) {
  $('district-state').textContent = calculated ? 'После ваших решений' : 'Исходная картина';
  $('district-summary').innerHTML = result.districts.map((district) => {
    const critical = state.dataset.indicators.filter(({ id }) => district.after[id] < 40).length;
    const share = state.dataset.districts.find(({ id }) => id === district.id).populationShare;
    return `<article class="district-card"><div class="district-heading"><h3>${escapeHtml(district.name)}</h3><img class="district-people" src="/assets/illustrations/${districtArtwork[district.id]}" alt="" width="36" height="36" loading="lazy" decoding="async"></div><p class="district-population">${number(share * 100, 0)}% населения</p><span class="district-value">${number(district.afterScore)}</span>${calculated ? `<span class="district-change">${signed(district.afterScore - district.beforeScore)}</span>` : ''}<div class="district-mini-track" aria-hidden="true"><span style="width:${district.afterScore}%"></span></div><p class="district-critical${critical ? ' has-critical' : ''}">${critical ? `Критических показателей: ${critical}` : 'Без критических показателей'}</p></article>`;
  }).join('');
  $('indicator-table').innerHTML = `<thead><tr><th scope="col">Показатель</th>${result.districts.map((district) => `<th scope="col">${escapeHtml(district.name)}</th>`).join('')}</tr></thead><tbody>${state.dataset.indicators.map((indicator) => `<tr><th scope="row"><span>${indicator.id}</span>${escapeHtml(indicator.name)}</th>${result.districts.map((district) => `<td${district.after[indicator.id] < 40 ? ' class="critical"' : ''} title="До: ${number(district.before[indicator.id])}${district.after[indicator.id] < 40 ? '. Критическое значение, ниже 40' : ''}">${number(district.after[indicator.id])}${calculated ? `<span class="cell-delta${district.delta[indicator.id] < 0 ? ' negative' : ''}">${signed(district.delta[indicator.id])}</span>` : ''}</td>`).join('')}</tr>`).join('')}</tbody>`;
  $('table-note').textContent = calculated ? 'В каждой ячейке: итоговое значение и изменение относительно исходного. Наведите курсор для значения «до».' : 'Исходные значения официального синтетического набора.';
}

function renderResult(result) {
  $('result-placeholder').hidden = true;
  $('result-content').hidden = false;
  $('result-state').textContent = 'Расчёт завершён';
  $('result-content').innerHTML = `<div class="result-grid"><article class="score-card"><div class="eyebrow">ASTANA QUALITY OF LIFE SCORE</div><div class="score-value">${number(result.score)}</div><div class="score-delta">${signed(result.deltaScore)} <span>к исходным ${number(result.baselineScore)}</span></div></article><article class="result-metric"><h3>Средняя оценка районов</h3><strong>${number(result.weightedAverage)}</strong><p>С учётом доли населения<br>Худший район: ${number(result.worstDistrictScore)}</p></article><article class="result-metric"><h3>Критические показатели</h3><strong>${result.criticalCount} <small style="font-size:13px;color:var(--muted)">/ 50</small></strong><p>До решений: ${state.baseline.criticalCount}<br>Стоимость: ${result.totalCost} · остаток: ${result.remainingBudget} у. е.</p></article></div>
    <div class="result-detail"><h3>Дополнительный эффект сочетаний</h3><div class="synergy-list">${result.synergies.length ? result.synergies.map((synergy) => `<span class="synergy-chip">${synergy.pair.join(' + ')} · ${escapeHtml(districtName(synergy.districtId))} · ${Object.entries(synergy.effects).map(([id, effect]) => `${id} ${signed(effect, 0)}`).join(', ')}</span>`).join('') : '<p class="synergy-empty">В этом наборе нет активных синергий.</p>'}</div><details class="contributions" style="margin-top:16px"><summary>Вклад каждой меры с учётом лага</summary><ul>${result.contributions.map((contribution) => `<li><strong>${contribution.measureId}</strong> · ${contribution.districtIds.map(districtName).map(escapeHtml).join(', ')}: ${Object.entries(contribution.effects).map(([id, effect]) => `${id} ${signed(effect, 3)}`).join(', ')}. Реализовано ${number(contribution.realizedFactor * 100, 1)}% исходного эффекта.</li>`).join('')}</ul></details></div>
    <section class="ai-panel" aria-labelledby="ai-heading"><div class="ai-heading"><h3 id="ai-heading">Почему получился такой результат</h3><span id="ai-mode" class="ai-mode">Анализ</span></div><div id="ai-body" aria-live="polite"></div></section>`;
  renderDistricts(result, true);
}

async function calculate() {
  if (state.busy || state.simulating || state.decisions.length !== 5) return;
  clearErrors();
  const version = state.version;
  const requestId = ++state.simulationId;
  const input = scenario();
  state.simulating = true;
  renderPlan();
  try {
    const result = await api('/api/simulate', input);
    if (state.version !== version || requestId !== state.simulationId) return;
    if (!result.valid) { showErrors(result.errors || ['Не удалось рассчитать сценарий.']); return; }
    state.result = result;
    renderResult(result);
    window.dispatchEvent(new CustomEvent('scenario:calculated', { detail: structuredClone({ scenario: input, result }) }));
    $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    announce(`Сценарий рассчитан. Score ${number(result.score)}, изменение ${signed(result.deltaScore)}.`);
    void explain(input, version);
  } catch (error) {
    if (state.version === version && requestId === state.simulationId) showErrors([error.message]);
  } finally {
    if (state.version === version && requestId === state.simulationId) { state.simulating = false; renderPlan(); }
  }
}

async function explain(input, version) {
  if (state.version !== version || !state.result) return;
  const requestId = ++state.explanationId;
  $('ai-mode').className = 'ai-mode';
  $('ai-mode').textContent = 'Готовим объяснение';
  $('ai-body').innerHTML = '<p class="ai-loading">Анализируем рассчитанные показатели. Числовой результат уже готов.</p>';
  try {
    const explanation = await api('/api/explain', input);
    if (state.version !== version || requestId !== state.explanationId || !state.result) return;
    if (explanation.valid === false || !explanation.summary) throw new Error(explanation.errors?.map((item) => item.message).join(' ') || 'Объяснение недоступно. Повторите запрос.');
    const isAI = explanation.mode === 'ai' && explanation.available === true;
    $('ai-mode').textContent = isAI ? 'AI-анализ' : 'Без AI · расчётное объяснение';
    $('ai-mode').className = `ai-mode${isAI ? '' : ' offline'}`;
    const sections = [['Сильные стороны', explanation.strengths], ['Риски и компромиссы', explanation.risks], ['Рекомендации', explanation.recommendations]];
    $('ai-body').innerHTML = `<p class="ai-summary">${escapeHtml(explanation.summary)}</p><div class="ai-columns">${sections.map(([title, items]) => `<div><h4>${title}</h4><ul>${(Array.isArray(items) && items.length ? items : ['Дополнительных замечаний нет.']).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>`).join('')}</div><div class="ai-footer"><p>${isAI ? 'Текст сформирован AI на основе рассчитанного сценария. Числовые показатели выше получены моделью города.' : 'AI сейчас недоступен. Показано детерминированное объяснение по правилам модели; оно не является LLM-анализом.'}</p><button class="retry-button" id="retry-ai">Повторить анализ</button></div>`;
    $('retry-ai').addEventListener('click', () => void explain(input, version));
  } catch (error) {
    if (state.version !== version || requestId !== state.explanationId || !state.result) return;
    $('ai-mode').textContent = 'Объяснение недоступно';
    $('ai-mode').className = 'ai-mode offline';
    $('ai-body').innerHTML = `<p class="ai-summary">${escapeHtml(error.message)}</p><div class="ai-footer"><p>Расчёт сценария сохранён. Можно повторно запросить объяснение.</p><button class="retry-button" id="retry-ai">Повторить</button></div>`;
    $('retry-ai').addEventListener('click', () => void explain(input, version));
  }
}

$('filters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  state.filter = button.dataset.filter;
  renderFilters();
  renderCatalog();
  $('filters').querySelector(`[data-filter="${state.filter}"]`)?.focus({ preventScroll: true });
});
$('catalog').addEventListener('change', (event) => {
  const select = event.target.closest('[data-pick]');
  if (!select) return;
  state.picks[select.dataset.pick] = select.value;
  const id = select.dataset.pick;
  renderCatalog();
  $(`district-${id}`)?.focus({ preventScroll: true });
});
$('catalog').addEventListener('click', (event) => {
  const button = event.target.closest('[data-add]');
  if (!button || button.disabled) return;
  const measure = measureById(button.dataset.add);
  const decision = { measureId: measure.id };
  if (measure.scope === 'district') decision.districtId = state.picks[measure.id];
  void applyDecisions([...state.decisions, decision], `Мера ${measure.id} добавлена.`);
});
$('selected-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove]');
  if (!button || button.disabled) return;
  void applyDecisions(state.decisions.filter((decision) => decision.measureId !== button.dataset.remove), 'Решение удалено.');
});
$('selected-list').addEventListener('change', (event) => {
  const select = event.target.closest('[data-change]');
  if (!select) return;
  const updated = state.decisions.map((decision) => decision.measureId === select.dataset.change ? { ...decision, districtId: select.value } : { ...decision });
  void applyDecisions(updated, 'Район реализации изменён.');
});
$('demo-button').addEventListener('click', () => void applyDecisions(demo, 'Загружен официальный демо-сценарий.'));
$('reset-button').addEventListener('click', async () => {
  if (await applyDecisions([], 'Создан новый сценарий.')) { state.picks = {}; state.filter = 'all'; renderFilters(); renderCatalog(); }
});
$('simulate-button').addEventListener('click', () => void calculate());
window.addEventListener('scenario:load', (event) => {
  const input = event.detail?.scenario;
  if (!state.dataset) return;
  if (!input || !Array.isArray(input.decisions)) {
    showErrors(['Сохранённый сценарий должен содержать список решений.']);
    return;
  }
  void applyDecisions(input.decisions, 'Сценарий загружен. Рассчитайте его повторно.');
});

async function initialize() {
  try {
    const [dataset, baseline] = await Promise.all([api('/api/dataset'), api('/api/baseline')]);
    if (!dataset.measures?.length || !dataset.districts?.length || !baseline.valid) throw new Error('Не удалось получить исходные данные города.');
    state.dataset = dataset;
    state.baseline = baseline;
    $('baseline-score').textContent = number(baseline.score);
    $('budget-total').textContent = dataset.budget;
    renderFilters();
    renderCatalog();
    renderPlan();
    renderDistricts(baseline, false);
    $('loading').hidden = true;
    $('app').hidden = false;
    announce('Данные загружены. Выберите пять решений или загрузите демо-сценарий.');
    await loadDeskScenario();
  } catch (error) {
    $('loading').hidden = true;
    $('fatal-error').hidden = false;
    $('fatal-error').innerHTML = `<strong>Не удалось загрузить симулятор.</strong><p>${escapeHtml(error.message)}</p><button class="retry-button" id="retry-load">Повторить загрузку</button>`;
    $('retry-load').addEventListener('click', () => { $('fatal-error').hidden = true; $('loading').hidden = false; void initialize(); });
  }
}
void initialize();

// Saved team scenarios use the server calculation, never client-supplied scores.
let deskSnapshot = null;
let linkedComplaint = null;
const deskParams = new URLSearchParams(location.search);
window.addEventListener('scenario:calculated', event => {
  deskSnapshot = structuredClone(event.detail);
  $('save-scenario').disabled = false;
  $('save-scenario-status').textContent = 'Готов к сохранению последний рассчитанный сценарий. Изменения формы без расчёта сюда не попадут.';
});
async function deskRequest(path, body) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Desk-Request': '1' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  if(!response.ok) throw new Error(data.message || 'Не удалось выполнить действие.');
  return data;
}
$('save-scenario-form').addEventListener('submit', async event => {
  event.preventDefault(); if(!deskSnapshot) return;
  const button = $('save-scenario'); button.disabled = true;
  try {
    const saved = await deskRequest('/api/desk/scenarios', { name: $('scenario-name').value, scenario: deskSnapshot.scenario, complaintId: linkedComplaint });
    $('save-scenario-status').textContent = `Сценарий «${saved.name}» сохранён на сервере. Доступен в кабинете обращений.`;
  } catch(error) { $('save-scenario-status').textContent = `${error.message} При необходимости войдите в кабинет в другой вкладке и повторите сохранение.`; }
  finally { button.disabled = !deskSnapshot; }
});
async function loadDeskScenario() {
  try {
    if(deskParams.has('saved')) {
      const saved = await deskRequest('/api/desk/scenarios');
      const item = saved.find(s => s.id === Number(deskParams.get('saved')));
      if(!item) throw new Error('Сохранённый сценарий не найден.');
      if(await applyDecisions(item.scenario.decisions, 'Сохранённый сценарий загружен. Рассчитайте его повторно.')) { linkedComplaint=item.complaintId; $('scenario-name').value=item.name; }
    } else if(deskParams.has('complaint')) {
      const item = await deskRequest(`/api/desk/complaints/${Number(deskParams.get('complaint'))}`);
      const measure = measureById(deskParams.get('measure'));
      if(!measure) throw new Error('Мера не найдена.');
      const decision = { measureId: measure.id };
      if(measure.scope === 'district') decision.districtId=deskParams.get('district');
      if(await applyDecisions([decision], `Добавлена мера для обращения № ${item.id}. Дополните сценарий до пяти решений.`)) { linkedComplaint=item.id; $('scenario-name').value=`Обращение № ${item.id}`; }
    }
  } catch(error) { $('save-scenario-status').textContent=error.message; }
}
