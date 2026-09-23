const DRAFT_KEY = 'mayor-workspace-draft-v1';
const DIRECTIONS = { transport: 'Транспорт', ecology: 'Экология', social: 'Социальная сфера', safety: 'Безопасность', services: 'Городские сервисы' };
const DEMO = [{ measureId: 'M7', districtId: 'nura' }, { measureId: 'M8', districtId: 'nura' }, { measureId: 'M10', districtId: 'nura' }, { measureId: 'M12' }, { measureId: 'M5', districtId: 'saryarka' }];
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const format = (value, digits = 2) => Number(value).toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const signed = value => `${value > 0 ? '+' : ''}${format(value)}`;
const copy = value => JSON.parse(JSON.stringify(value));

/** The server owns validation and all numerical results. Mount once per workspace. */
export function mountMayorPlanner(container, { dataset, baseline, resultContainer, onCalculated = () => {}, onInvalidated = () => {}, onOpenResults = () => {} } = {}) {
  if (!container?.ownerDocument || !Array.isArray(dataset?.measures) || !Array.isArray(dataset?.districts)) throw new TypeError('Нужны контейнер и каталог модели.');
  const document = container.ownerDocument;
  const view = document.defaultView;
  const state = { decisions: [], cost: 0, filter: 'all', picks: {}, result: null, enabled: true, cityId: 'astana', busy: false, calculating: false, explaining: false, generation: 0, mutation: 0, destroyed: false };
  const requests = new Map();
  const measure = id => dataset.measures.find(item => item.id === id);
  const districtName = id => dataset.districts.find(item => item.id === id)?.name ?? 'Весь город';
  const indicatorName = id => dataset.indicators.find(item => item.id === id)?.name ?? id;
  const scenario = () => ({ decisions: copy(state.decisions) });
  const emit = (type, detail) => view.dispatchEvent(new view.CustomEvent(type, { detail }));
  container.innerHTML = `<div class="mp-toolbar"><p>Пять решений. Один бюджет. Горизонт — ${escape(dataset.horizon)} кварталов.</p><div><button type="button" class="mp-button mp-button-secondary" data-mp-demo>Загрузить демо</button><button type="button" class="mp-button mp-button-secondary" data-mp-reset>Начать заново</button></div></div><p class="mp-notice" data-mp-notice hidden></p><div class="mp-errors" data-mp-errors role="alert" tabindex="-1" hidden></div><div class="mp-filters" data-mp-filters aria-label="Направления развития"></div><div class="mp-layout"><div class="mp-catalog" data-mp-catalog></div><aside class="mp-plan" aria-label="Выбранный план"><div class="mp-plan-heading"><div><span class="mp-eyebrow">ВАШ ПЛАН</span><h2>План изменений</h2></div><span class="mp-count" data-mp-count>0 / 5</span></div><div class="mp-selected-list" data-mp-selected></div><div class="mp-budget"><div><span>Использовано</span><strong data-mp-cost>0</strong></div><progress class="mp-budget-track" data-mp-progress max="${escape(dataset.budget)}" value="0" aria-label="Использованный бюджет"></progress><div><span>Осталось из ${escape(dataset.budget)} у. е.</span><strong data-mp-remaining>${escape(dataset.budget)}</strong></div></div><button type="button" class="mp-button mp-calculate" data-mp-calculate>Рассчитать сценарий</button><p class="mp-hint" data-mp-hint role="status"></p><p class="mp-plan-note">Ровно 5 уникальных мер, не более 2 в одном направлении. Стоимость — в условных единицах.</p></aside></div>`;
  if (!resultContainer) { resultContainer = document.createElement('section'); resultContainer.className = 'mp-results'; container.append(resultContainer); }
  const element = name => container.querySelector(`[data-mp-${name}]`);
  const showErrors = errors => { element('errors').innerHTML = `<strong>Проверьте план</strong><ul>${errors.map(error => `<li>${escape(typeof error === 'string' ? error : error.message)}</li>`).join('')}</ul>`; element('errors').hidden = false; };
  const clearErrors = () => { element('errors').hidden = true; element('errors').textContent = ''; };
  const abort = key => { requests.get(key)?.abort(); requests.delete(key); };
  async function request(key, path, input) {
    abort(key);
    const controller = new AbortController(); requests.set(key, controller);
    const timer = setTimeout(() => controller.abort(), key === 'explain' ? 65000 : 15000);
    try {
      const response = await view.fetch(path, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: controller.signal });
      const body = await response.json();
      if (!response.ok && !Array.isArray(body?.errors)) throw new Error(typeof body?.message === 'string' ? body.message : `Сервис временно недоступен (${response.status}).`);
      return body;
    } finally { clearTimeout(timer); if (requests.get(key) === controller) requests.delete(key); }
  }
  function renderEmptyResult() {
    resultContainer.innerHTML = '<div class="mp-result-placeholder"><span class="mp-eyebrow">РЕЗУЛЬТАТ СЦЕНАРИЯ</span><h2>Сначала — ваш план</h2><p>Выберите пять инициатив и рассчитайте сценарий. Здесь появятся изменения по районам, итоговый индекс и объяснение.</p></div>';
  }
  function invalidate() {
    state.generation += 1; state.result = null; state.calculating = false; state.explaining = false;
    abort('simulate'); abort('explain'); renderEmptyResult();
    emit('scenario:invalidated'); onInvalidated();
  }
  const options = selected => `<option value=""${!selected ? ' selected' : ''}>Выберите район</option>${dataset.districts.map(item => `<option value="${escape(item.id)}"${item.id === selected ? ' selected' : ''}>${escape(item.name)}</option>`).join('')}`;
  function render() {
    const blocked = !state.enabled || state.busy;
    element('filters').innerHTML = [['all', 'Все меры'], ...Object.entries(DIRECTIONS)].map(([id, name]) => `<button type="button" class="mp-filter${state.filter === id ? ' is-active' : ''}" data-mp-filter="${id}" aria-pressed="${state.filter === id}">${name}</button>`).join('');
    const expanded = new Set([...element('catalog').querySelectorAll('details[open]')].map(item => item.dataset.mpDetails));
    element('catalog').innerHTML = dataset.measures.filter(item => state.filter === 'all' || item.direction === state.filter).map(item => {
      const selected = state.decisions.some(decision => decision.measureId === item.id);
      const disabled = blocked || selected || state.decisions.length >= 5 || (item.scope === 'district' && !state.picks[item.id]);
      return `<article class="mp-card${selected ? ' is-selected' : ''}" data-mp-measure="${escape(item.id)}"><div class="mp-card-top"><span class="mp-direction">${escape(DIRECTIONS[item.direction])}</span><span class="mp-measure-id">${escape(item.id)}</span></div><h3>${escape(item.name)}</h3><div class="mp-card-meta"><strong>${escape(item.cost)} <small>у. е.</small></strong><span>${item.scope === 'city' ? 'Весь город' : 'Один район'}</span><span>Лаг ${escape(item.lag)} кв.</span></div><details class="mp-effects" data-mp-details="${escape(item.id)}"${expanded.has(item.id) ? ' open' : ''}><summary>Влияние на показатели</summary><ul>${Object.entries(item.effects).map(([id, value]) => `<li><span>${escape(indicatorName(id))}</span><strong>${signed(value)}</strong></li>`).join('')}</ul><p>Полный эффект до учёта лага. Горизонт расчёта — ${escape(dataset.horizon)} кварталов.</p></details><div class="mp-card-actions">${item.scope === 'district' ? `<label>Район реализации<select data-mp-pick="${escape(item.id)}"${blocked || selected ? ' disabled' : ''}>${options(state.picks[item.id])}</select></label>` : '<p class="mp-city-scope">Действует во всех пяти районах</p>'}<button type="button" class="mp-button mp-button-secondary" data-mp-add="${escape(item.id)}"${disabled ? ' disabled' : ''}>${selected ? '✓ В вашем плане' : 'Добавить в план'}</button></div></article>`;
    }).join('');
    element('selected').innerHTML = state.decisions.length ? state.decisions.map((decision, index) => { const item = measure(decision.measureId); return `<article class="mp-selected"><span class="mp-selected-number">${index + 1}</span><div><h3>${escape(item.name)}</h3>${item.scope === 'district' ? `<label class="mp-selected-district">Район<select data-mp-change="${escape(item.id)}"${blocked ? ' disabled' : ''}>${options(decision.districtId)}</select></label>` : '<p>Весь город</p>'}<span class="mp-selected-cost">${escape(item.cost)} у. е.</span></div><button type="button" class="mp-remove" data-mp-remove="${escape(item.id)}" aria-label="Удалить: ${escape(item.name)}"${blocked ? ' disabled' : ''}>×</button></article>`; }).join('') : '<div class="mp-empty-plan"><strong>С чего начнём?</strong><p>Выберите район и добавьте инициативу из каталога.</p></div>';
    element('count').textContent = `${state.decisions.length} / 5`;
    element('cost').textContent = `${format(state.cost, 0)} у. е.`;
    element('remaining').textContent = `${format(dataset.budget - state.cost, 0)} у. е.`;
    element('progress').value = state.cost;
    element('calculate').disabled = blocked || state.calculating || state.decisions.length !== 5;
    element('calculate').textContent = state.calculating ? 'Рассчитываем…' : 'Рассчитать сценарий';
    element('demo').disabled = blocked;
    element('reset').disabled = blocked || state.decisions.length === 0;
    element('hint').textContent = !state.enabled ? 'Расчёт доступен для учебной модели Астаны.' : state.busy ? 'Проверяем совместимость и бюджет…' : state.calculating ? 'Считаем влияние на пять районов…' : state.decisions.length < 5 ? `Выбрано ${state.decisions.length} из 5 решений` : 'План готов к расчёту';
    element('notice').hidden = state.enabled;
    element('notice').textContent = 'Для этой территории пока нет расчётных данных. Вернитесь к Астане, чтобы продолжить работу с учебной моделью.';
  }
  function saveDraft() { try { view.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(state.decisions)); } catch { element('hint').textContent = 'План доступен сейчас, но браузер не разрешил сохранить черновик.'; } }
  async function load(decisions) {
    if (state.destroyed || !state.enabled) return false;
    if (!Array.isArray(decisions) || decisions.length > 5 || decisions.some(item => !item || typeof item.measureId !== 'string')) { showErrors(['Ожидается список не более пяти решений.']); return false; }
    const input = decisions.map(item => ({ measureId: item.measureId, ...(item.districtId !== undefined ? { districtId: item.districtId } : {}) }));
    const mutation = ++state.mutation; state.busy = true; clearErrors(); render();
    try {
      const validation = await request('validate', '/api/validate', { decisions: input });
      if (state.destroyed || mutation !== state.mutation || !state.enabled) return false;
      if (!Array.isArray(validation.errors) || !Number.isFinite(validation.totalCost)) throw new Error('Получен неполный ответ проверки. Повторите действие.');
      const errors = validation.errors.filter(error => error.code !== 'DECISION_COUNT' || input.length >= 5);
      if (errors.length) { showErrors(errors); return false; }
      if (input.some(item => !measure(item.measureId))) throw new Error('Каталог изменился. Обновите страницу.');
      const changed = JSON.stringify(state.decisions) !== JSON.stringify(input);
      state.decisions = copy(input); state.cost = validation.totalCost;
      input.forEach(item => { if (item.districtId) state.picks[item.measureId] = item.districtId; });
      if (changed) invalidate();
      return true;
    } catch (error) {
      if (!state.destroyed && mutation === state.mutation) showErrors([error.name === 'AbortError' ? 'Проверка заняла слишком много времени. Повторите действие.' : error.message || 'Не удалось проверить план.']);
      return false;
    } finally { if (!state.destroyed && mutation === state.mutation) { state.busy = false; render(); saveDraft(); } }
  }
  function renderResult(result) {
    const worst = result.districts.reduce((current, item) => !current || item.afterScore < current.afterScore ? item : current, null);
    resultContainer.innerHTML = `<div class="mp-result-grid"><article class="mp-score-card"><span class="mp-eyebrow">ASTANA QUALITY OF LIFE SCORE</span><strong class="mp-score-value">${format(result.score)}</strong><span class="mp-score-delta">${signed(result.deltaScore)} к исходным ${format(result.baselineScore)}</span><p>Учебная модель · ${escape(dataset.horizon)} кварталов</p></article><article class="mp-metric"><h3>Бюджет плана</h3><strong>${format(result.totalCost, 0)} <small>у. е.</small></strong><p>Остаток ${format(result.remainingBudget, 0)} из ${escape(dataset.budget)}</p></article><article class="mp-metric"><h3>Критические показатели</h3><strong>${escape(result.criticalCount)} <small>из 50</small></strong><p>До решений: ${escape(baseline?.criticalCount ?? '—')} · значения ниже 40</p></article><article class="mp-metric"><h3>Слабейший район</h3><strong>${format(result.worstDistrictScore)}</strong><p>${escape(worst?.name)} · средняя по городу ${format(result.weightedAverage)}</p></article></div><section class="mp-result-details"><h2>Что меняется в районах</h2><div class="mp-district-grid">${result.districts.map(item => `<article class="mp-district"><h3>${escape(item.name)}</h3><div><strong>${format(item.afterScore)}</strong><span>${signed(item.afterScore - item.beforeScore)}</span></div><p>До решений: ${format(item.beforeScore)}</p><details><summary>Все показатели</summary><dl>${dataset.indicators.map(indicator => `<div class="${item.after[indicator.id] < 40 ? 'is-critical' : ''}"><dt>${escape(indicator.name)}</dt><dd>${format(item.after[indicator.id])} <span>(${signed(item.delta[indicator.id])})</span></dd></div>`).join('')}</dl></details></article>`).join('')}</div><details class="mp-contributions"><summary>Эффекты мер и синергии</summary><ul>${(result.contributions || []).map(item => `<li><strong>${escape(measure(item.measureId)?.name || item.measureId)}</strong> · ${item.districtIds.map(districtName).map(escape).join(', ')}: ${Object.entries(item.effects).map(([id, value]) => `${escape(indicatorName(id))} ${signed(value)}`).join('; ')}. Реализовано ${format(item.realizedFactor * 100, 1)}% эффекта.</li>`).join('')}</ul><h3>Синергии</h3>${result.synergies?.length ? `<ul>${result.synergies.map(item => `<li>${escape(item.pair.join(' + '))} · ${escape(districtName(item.districtId))}: ${Object.entries(item.effects).map(([id, value]) => `${escape(indicatorName(id))} ${signed(value)}`).join('; ')}</li>`).join('')}</ul>` : '<p>В этом плане нет дополнительных эффектов сочетаний.</p>'}</details></section><section class="mp-ai"><div class="mp-ai-heading"><div><span class="mp-eyebrow">АНАЛИЗ ПЛАНА</span><h2>За цифрами — последствия</h2></div><span class="mp-ai-mode" data-mp-ai-mode>По запросу</span></div><div class="mp-ai-body" data-mp-ai-body aria-live="polite"><p>Получите объяснение сильных сторон, рисков и компромиссов на основе уже рассчитанного плана.</p></div><button type="button" class="mp-button" data-mp-explain>Объяснить результат</button></section>`;
  }
  async function calculate() {
    if (state.destroyed || !state.enabled || state.busy || state.calculating || state.decisions.length !== 5) return;
    const generation = state.generation; const input = scenario();
    state.calculating = true; clearErrors(); render();
    try {
      const result = await request('simulate', '/api/simulate', input);
      if (state.destroyed || generation !== state.generation) return;
      if (!result.valid) { showErrors(result.errors || ['План не прошёл проверку.']); return; }
      if (!Number.isFinite(result.score) || !Array.isArray(result.districts)) throw new Error('Получен неполный результат расчёта.');
      abort('explain'); state.explaining = false;
      state.result = copy(result); renderResult(result);
      const detail = copy({ scenario: input, result }); emit('scenario:calculated', detail); onCalculated(copy(detail)); onOpenResults();
    } catch (error) { if (!state.destroyed && generation === state.generation) showErrors([error.name === 'AbortError' ? 'Расчёт не завершился вовремя. Попробуйте ещё раз.' : error.message || 'Нет связи с сервером.']); }
    finally { if (!state.destroyed && generation === state.generation) { state.calculating = false; render(); } }
  }
  async function explain() {
    if (state.destroyed || !state.enabled || !state.result || state.explaining || state.busy || state.calculating) return;
    const generation = state.generation; const resultSnapshot = state.result; state.explaining = true;
    const current = () => !state.destroyed && generation === state.generation && state.result === resultSnapshot;
    const button = resultContainer.querySelector('[data-mp-explain]');
    const body = resultContainer.querySelector('[data-mp-ai-body]');
    const mode = resultContainer.querySelector('[data-mp-ai-mode]');
    button.disabled = true; mode.textContent = 'Готовим объяснение'; body.textContent = 'Анализируем рассчитанные показатели. Числовой результат уже готов.';
    try {
      const explanation = await request('explain', '/api/explain', scenario());
      if (!current()) return;
      if (typeof explanation.summary !== 'string' || !explanation.summary) throw new Error('Объяснение пока недоступно. Попробуйте ещё раз.');
      const ai = explanation.mode === 'ai' && explanation.available === true;
      mode.textContent = ai ? 'AI-анализ' : 'Расчётное объяснение · без AI';
      body.innerHTML = `<p class="mp-ai-summary">${escape(explanation.summary)}</p><div class="mp-ai-columns">${[['Сильные стороны', explanation.strengths], ['Риски и компромиссы', explanation.risks], ['Рекомендации', explanation.recommendations]].map(([title, items]) => `<div><h3>${title}</h3><ul>${(Array.isArray(items) && items.length ? items : ['Дополнительных замечаний нет.']).map(item => `<li>${escape(item)}</li>`).join('')}</ul></div>`).join('')}</div><p class="mp-ai-note">${ai ? 'Объяснение опирается на рассчитанные факты. Значения индекса определяет модель города.' : 'AI недоступен. Показано детерминированное объяснение по правилам модели; это не LLM-анализ.'}</p>`;
    } catch (error) { if (current()) { mode.textContent = 'Объяснение недоступно'; body.textContent = error.name === 'AbortError' ? 'Сервис не ответил вовремя. Расчёт сохранён — повторите запрос.' : error.message || 'Не удалось получить объяснение.'; } }
    finally { if (current()) { state.explaining = false; button.disabled = false; button.textContent = 'Повторить объяснение'; } }
  }
  function onClick(event) {
    const target = event.target.closest?.('button'); if (!target || target.disabled) return;
    if (target.hasAttribute('data-mp-filter')) { state.filter = target.dataset.mpFilter; render(); element('filters').querySelector(`[data-mp-filter="${state.filter}"]`)?.focus(); }
    else if (target.hasAttribute('data-mp-demo')) void load(DEMO);
    else if (target.hasAttribute('data-mp-reset')) void load([]);
    else if (target.hasAttribute('data-mp-calculate')) void calculate();
    else if (target.hasAttribute('data-mp-remove')) void load(state.decisions.filter(item => item.measureId !== target.dataset.mpRemove));
    else if (target.hasAttribute('data-mp-add')) { const item = measure(target.dataset.mpAdd); if (item) void load([...state.decisions, { measureId: item.id, ...(item.scope === 'district' ? { districtId: state.picks[item.id] } : {}) }]); }
  }
  function onChange(event) {
    const target = event.target;
    if (target.hasAttribute('data-mp-pick')) { state.picks[target.dataset.mpPick] = target.value; render(); container.querySelector(`[data-mp-pick="${target.dataset.mpPick}"]`)?.focus(); }
    else if (target.hasAttribute('data-mp-change')) void load(state.decisions.map(item => item.measureId === target.dataset.mpChange ? { ...item, districtId: target.value } : item));
  }
  const onResultClick = event => { if (event.target.closest?.('[data-mp-explain]')) void explain(); };
  const onLoad = event => { if (Array.isArray(event.detail?.scenario?.decisions)) void load(event.detail.scenario.decisions); };
  container.addEventListener('click', onClick); container.addEventListener('change', onChange); resultContainer.addEventListener('click', onResultClick); view.addEventListener('scenario:load', onLoad);
  renderEmptyResult(); render();
  try { const raw = view.sessionStorage.getItem(DRAFT_KEY); if (raw && raw.length < 32768) { const draft = JSON.parse(raw); if (Array.isArray(draft) && draft.length) void load(draft); } } catch { element('hint').textContent = 'Сохранённый черновик недоступен. Можно собрать новый план.'; }
  return {
    load,
    focusDistrict(id) {
      if (state.destroyed || !state.enabled || !dataset.districts.some(item => item.id === id)) return false;
      for (const item of dataset.measures) {
        if (item.scope === 'district' && !state.decisions.some(decision => decision.measureId === item.id)) state.picks[item.id] = id;
      }
      render();
      return true;
    },
    setCity(city) {
      if (state.destroyed) return;
      const id = typeof city === 'string' ? city : city?.id;
      const enabled = id === 'astana' && (typeof city === 'string' || city?.hasScenarioData !== false);
      if (id === state.cityId && enabled === state.enabled) return;
      state.cityId = id; state.enabled = enabled; state.mutation += 1; state.busy = false; abort('validate'); invalidate(); clearErrors(); render();
    },
    destroy() {
      if (state.destroyed) return; state.destroyed = true; state.mutation += 1; state.generation += 1;
      for (const key of [...requests.keys()]) abort(key);
      container.removeEventListener('click', onClick); container.removeEventListener('change', onChange); resultContainer.removeEventListener('click', onResultClick); view.removeEventListener('scenario:load', onLoad);
    },
  };
}
