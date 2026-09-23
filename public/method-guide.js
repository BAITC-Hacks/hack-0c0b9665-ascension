const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const number = (value, digits = 3) => Number(value).toLocaleString('ru-RU', { maximumFractionDigits: digits });
const signed = value => `${value > 0 ? '+' : ''}${number(value)}`;

/** Explains server output without replacing the authoritative simulator. */
export function scoreBreakdown(dataset, result) {
  const districts = result.districts.map(district => {
    const populationShare = dataset.districts.find(item => item.id === district.id).populationShare;
    const indicators = dataset.indicators.map(indicator => ({ ...indicator, value: district.after[indicator.id], contribution: district.after[indicator.id] * indicator.weight }));
    return { ...district, populationShare, indicators, populationContribution: district.afterScore * populationShare };
  });
  return {
    districts,
    averagePart: result.weightedAverage * 0.7,
    weakestPart: result.worstDistrictScore * 0.3,
    penalty: result.criticalCount,
    weakest: districts.filter(district => Math.abs(district.afterScore - result.worstDistrictScore) < 1e-8),
    critical: districts.flatMap(district => district.indicators.filter(indicator => indicator.value < 40).map(indicator => ({ districtId: district.id, districtName: district.name, ...indicator }))),
    score: result.score,
  };
}

export function realizedMeasure(dataset, measureId) {
  const measure = dataset.measures.find(item => item.id === measureId);
  if (!measure) return null;
  const factor = (dataset.horizon - measure.lag) / dataset.horizon;
  return { ...measure, factor, realizedQuarters: dataset.horizon - measure.lag, effects: Object.entries(measure.effects).map(([id, effect]) => ({ id, name: dataset.indicators.find(indicator => indicator.id === id)?.name || id, full: effect, realized: effect * factor })) };
}

export function initMethodGuide({ dataset, baseline }) {
  const section = document.getElementById('method');
  if (!section || section.dataset.guideReady) return;
  section.dataset.guideReady = 'true';
  const state = { result: null, mode: 'baseline', districtId: dataset.districts.find(district => district.id === 'nura')?.id || dataset.districts[0].id, measureId: dataset.measures[0].id };
  const panel = document.createElement('div');
  panel.className = 'method-guide';
  panel.innerHTML = `<nav class="method-steps" aria-label="Путь от проблемы к решению"><a href="#city"><span>01</span><strong>Изучите город</strong><small>Выберите район и слабые показатели</small></a><a href="#workspace"><span>02</span><strong>Соберите 5 решений</strong><small>Уложитесь в ${dataset.budget} у. е. и проверьте сочетания</small></a><a href="#results"><span>03</span><strong>Сравните результат</strong><small>Посмотрите изменения и вклад каждой меры</small></a></nav>
    <section class="method-live" aria-labelledby="method-live-heading"><div class="method-panel-heading"><div><div class="eyebrow">ПРОВЕРЬТЕ КАЖДОЕ СЛАГАЕМОЕ</div><h3 id="method-live-heading">Формула на данных города</h3></div><label>Набор данных<select id="method-source"><option value="baseline">Исходная картина</option><option value="scenario" disabled>Рассчитанный сценарий</option></select></label></div><div id="method-calculation" aria-live="polite"></div>
      <details class="method-calculation-details"><summary>Как получаются оценки районов и средняя оценка</summary><div id="method-population"></div><label class="method-district-label" for="method-district">Разобрать оценку района</label><select id="method-district">${dataset.districts.map(district => `<option value="${district.id}">${escapeHtml(district.name)}</option>`).join('')}</select><div id="method-district-breakdown"></div></details></section>
    <section class="method-lag" aria-labelledby="method-lag-heading"><div class="method-panel-heading"><div><div class="eyebrow">ВРЕМЯ ИМЕЕТ ЗНАЧЕНИЕ</div><h3 id="method-lag-heading">Почему эффект меры меньше обещанного</h3></div></div><label class="method-measure-label" for="method-measure">Выберите меру</label><select id="method-measure">${dataset.measures.map(measure => `<option value="${measure.id}">${measure.id} · ${escapeHtml(measure.name)}</option>`).join('')}</select><div id="method-lag-breakdown" aria-live="polite"></div></section>
    <section class="method-faq" aria-labelledby="method-faq-heading"><h3 id="method-faq-heading">Ответы перед первым сценарием</h3>
      <details><summary>Что означают баллы и откуда взяты данные?</summary><p>Каждый показатель находится в диапазоне от 0 до 100: больше — лучше. Все районы, доли населения, веса, стоимости и эффекты взяты из учебного набора проекта. Это синтетические данные, а не статистика или прогноз для реальной Астаны. Расчёт нужен для сравнения решений в одинаковых условиях.</p><a href="/api/dataset" target="_blank" rel="noopener">Открыть исходный набор данных (JSON) ↗</a></details>
      <details><summary>Почему нужно ровно 5 решений и что мешает их сочетать?</summary><p>Правила кейса: ровно 5 разных мер, стоимость не выше ${dataset.budget} у. е., максимум 2 меры одного направления. Одна мера используется один раз; для районной меры нужно выбрать район, городская действует везде. Неиспользованный бюджет не приносит бонусных баллов.</p><ul><li>M1 «Автобусные полосы» и M3 «ЛРТ» несовместимы даже в разных районах.</li><li>M4 «Парк» и M7 «Школа + детсад» несовместимы в одном районе.</li><li>M5 «Чистое топливо» и M13 «Тепло- и водосети» несовместимы в одном районе.</li></ul><a href="#workspace">Проверить свой набор в конструкторе ↗</a></details>
      <details><summary>Почему показатель 39,9 критический, а 40 — уже нет?</summary><p>В модели применяется точный порог: штраф начисляется за каждый показатель строго ниже 40 в каждом районе. Значение 40 не штрафуется. Поэтому небольшое улучшение, которое переводит показатель через порог, одновременно повышает оценку района и убирает 1 балл штрафа. Штраф считают по всем ${dataset.indicators.length * dataset.districts.length} значениям до округления.</p><a href="#city">Найти критические показатели ↗</a></details>
      <details><summary>Что такое синергия и может ли мера ухудшить ситуацию?</summary><p>Некоторые сочетания дают отдельный бонус в районе соответствующей локальной меры. Он добавляется после учёта лага и сам на коэффициент лага не умножается:</p><ul>${dataset.synergies.map(synergy => `<li>${synergy.pair.map(escapeHtml).join(' + ')}: ${Object.entries(synergy.effects).map(([id, effect]) => `${escapeHtml(dataset.indicators.find(indicator => indicator.id === id)?.name || id)} ${signed(effect)}`).join(', ')}; район меры ${synergy.districtFrom}.</li>`).join('')}</ul><p>Эффекты бывают отрицательными: безопасные переходы M11 улучшают безопасность движения, но уменьшают показатель разгрузки дорог T1. После суммирования мер и синергий каждое значение ограничивается диапазоном 0–100. Поэтому вклады до ограничения могут отличаться от фактического изменения показателя.</p></details>
      <details><summary>Что происходит после изменения или перезагрузки сценария?</summary><p>Изменение набора решений сбрасывает рассчитанный результат: сначала нужно пересчитать новый набор. Тогда обновятся показатели районов и разбор формулы. Сохранение рассчитанного сценария команды доступно после входа в кабинет; скачанный отчёт можно сохранить отдельно. Результаты модели не означают, что меры уже реализованы в городе.</p><a href="#saved-scenario-panel">Перейти к сохранению сценария ↗</a></details>
      <details><summary>Нейросеть влияет на итоговую оценку?</summary><p>Нет. Значения и итоговый Score рассчитывает сервер по фиксированным формулам. Текстовый помощник объясняет готовый результат и не меняет числа. При недоступности ИИ используется локальное объяснение, а расчёт продолжает работать.</p></details></section>`;
  section.append(panel);
  panel.querySelector('#method-district').value = state.districtId;
  const current = () => state.mode === 'scenario' && state.result ? state.result : baseline;

  function renderScore() {
    const result = current();
    const breakdown = scoreBreakdown(dataset, result);
    panel.querySelector('#method-source option[value="scenario"]').disabled = !state.result;
    panel.querySelector('#method-source').value = state.mode;
    panel.querySelector('#method-calculation').innerHTML = `<div class="method-score-parts"><div><span>Средняя с учётом населения</span><strong>${number(result.weightedAverage, 5)} <small>× 0,7</small></strong><p>${number(breakdown.averagePart, 5)} балла</p></div><div><span>Минимальная оценка района</span><strong>${number(result.worstDistrictScore, 5)} <small>× 0,3</small></strong><p>${number(breakdown.weakestPart, 5)} балла · ${breakdown.weakest.map(district => escapeHtml(district.name)).join(', ')}</p></div><div><span>Штраф за критические значения</span><strong>−${breakdown.penalty}</strong><p>По 1 баллу за значение ниже 40</p></div><div class="method-score-total"><span>Итоговый Score</span><strong>${number(breakdown.score, 5)}</strong><p>${state.mode === 'scenario' ? `${signed(result.deltaScore)} к исходной картине` : 'До принятия решений'}</p></div></div><p class="method-critical-list">${breakdown.critical.length ? `Штрафуют: ${breakdown.critical.map(item => `${escapeHtml(item.districtName)} · ${escapeHtml(item.name)} ${number(item.value)}`).join('; ')}.` : 'Критических значений нет: штраф равен нулю.'}</p><p class="method-rounding">Здесь показано до 5 знаков после запятой. Сервер считает без промежуточного округления.${state.result ? '' : ' Рассчитайте сценарий, чтобы разобрать его результат.'}</p>`;
    panel.querySelector('#method-population').innerHTML = `<p>Оценка района — сумма 10 показателей, каждый умножен на свой вес. Средняя города — сумма оценок районов, умноженных на долю населения:</p><div class="method-population-rows">${breakdown.districts.map(district => `<div><span>${escapeHtml(district.name)}</span><span>${number(district.afterScore, 5)} × ${number(district.populationShare * 100)}%</span><strong>${number(district.populationContribution, 5)}</strong></div>`).join('')}</div><p class="method-population-total">Взвешенная средняя = <strong>${number(result.weightedAverage, 5)}</strong>. Сумма долей населения — ${number(dataset.districts.reduce((sum, district) => sum + district.populationShare, 0) * 100)}%.</p>`;
    renderDistrict();
  }

  function renderDistrict() {
    const district = scoreBreakdown(dataset, current()).districts.find(item => item.id === state.districtId);
    panel.querySelector('#method-district-breakdown').innerHTML = `<div class="method-indicator-rows">${district.indicators.map(indicator => `<div><span>${escapeHtml(indicator.name)} <small>${indicator.id}</small></span><span>${number(indicator.value)} × ${number(indicator.weight * 100)}%</span><strong>${number(indicator.contribution, 5)}</strong></div>`).join('')}</div><p class="method-district-total">Оценка района ${escapeHtml(district.name)} = <strong>${number(district.afterScore, 5)}</strong> / 100. Сумма весов — ${number(dataset.indicators.reduce((sum, indicator) => sum + indicator.weight, 0) * 100)}%.</p>`;
  }

  function renderLag() {
    const measure = realizedMeasure(dataset, state.measureId);
    panel.querySelector('#method-lag-breakdown').innerHTML = `<div class="method-quarter-strip" aria-label="Горизонт ${dataset.horizon} кварталов: лаг ${measure.lag}, реализация ${measure.realizedQuarters}">${Array.from({ length: dataset.horizon }, (_, index) => `<div class="${index < measure.lag ? 'is-waiting' : 'is-realized'}"><span>${index + 1} кв.</span><strong>${index < measure.lag ? 'Лаг' : 'Эффект'}</strong></div>`).join('')}</div><div class="method-lag-equation"><span>(${dataset.horizon} − ${measure.lag}) / ${dataset.horizon}</span><span>=</span><strong>${number(measure.factor * 100)}% эффекта</strong></div><p>На горизонте ${dataset.horizon} кварталов модель учитывает ${measure.realizedQuarters} кварталов эффекта после лага. Это коэффициент итогового расчёта, а не прогноз темпа работ.</p><div class="method-effect-rows">${measure.effects.map(effect => `<div class="${effect.realized < 0 ? 'is-negative' : ''}"><span>${escapeHtml(effect.name)} <small>${effect.id}</small></span><span>${signed(effect.full)} × ${number(measure.factor)}</span><strong>${signed(effect.realized)} п.</strong></div>`).join('')}</div><p class="method-scope-note">${measure.scope === 'city' ? 'Эти изменения применяются к каждому из пяти районов.' : 'Эти изменения применяются только к выбранному району.'} Синергии и ограничение 0–100 учитываются отдельно.</p><button type="button" class="method-constructor-link" data-method-measure="${measure.id}">Рассмотреть эту меру в конструкторе ↗</button>`;
  }
  panel.addEventListener('change', event => {
    if (event.target.id === 'method-source') { state.mode = event.target.value; renderScore(); }
    if (event.target.id === 'method-district') { state.districtId = event.target.value; renderDistrict(); }
    if (event.target.id === 'method-measure') { state.measureId = event.target.value; renderLag(); }
  });
  panel.addEventListener('click', event => {
    const button = event.target.closest('[data-method-measure]');
    if (button) window.dispatchEvent(new CustomEvent('constructor:focus', { detail: { measureId: button.dataset.methodMeasure } }));
  });
  window.addEventListener('scenario:calculated', event => {
    if (!event.detail?.result?.valid) return;
    state.result = event.detail.result;
    state.mode = 'scenario';
    renderScore();
  });
  window.addEventListener('scenario:invalidated', () => { state.result = null; state.mode = 'baseline'; renderScore(); });
  renderScore();
  renderLag();
}

if (typeof window !== 'undefined') window.addEventListener('simulator:ready', event => initMethodGuide(event.detail));
