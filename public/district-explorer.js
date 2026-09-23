const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const number = (value, digits = 2) => Number(value).toLocaleString('ru-RU', { maximumFractionDigits: digits });
const signed = value => `${value > 0 ? '+' : ''}${number(value)}`;
const directions = { transport: 'Транспорт', ecology: 'Экология', social: 'Социальная сфера', safety: 'Безопасность', services: 'Городской сервис' };
const artwork = { esil: 'yesil', almaty: 'almaty', saryarka: 'saryarka', baikonur: 'baikonur', nura: 'nura' };

/** The same selection drives the on-screen table and downloaded rows. */
export function selectDistrictIndicators(dataset, result, { districtId = 'all', direction = 'all', query = '', criticalOnly = false, sort = 'weakest' } = {}) {
  const districts = result.districts.filter(district => districtId === 'all' || district.id === districtId);
  const normalizedQuery = query.trim().toLocaleLowerCase('ru-RU');
  const rows = dataset.indicators.filter(indicator =>
    (direction === 'all' || indicator.direction === direction)
    && `${indicator.id} ${indicator.name}`.toLocaleLowerCase('ru-RU').includes(normalizedQuery)
    && (!criticalOnly || districts.some(district => district.after[indicator.id] < 40)));
  const weakest = indicator => Math.min(...districts.map(district => district.after[indicator.id]));
  const gain = indicator => districts.reduce((sum, district) => sum + district.delta[indicator.id], 0);
  rows.sort((left, right) => (sort === 'strongest' ? weakest(right) - weakest(left)
    : sort === 'gain' ? gain(right) - gain(left)
      : sort === 'weight' ? right.weight - left.weight : weakest(left) - weakest(right)) || left.id.localeCompare(right.id));
  return { districts, indicators: rows };
}

export function districtRecommendations(dataset, district, limit = 3) {
  const priorities = [...dataset.indicators].sort((left, right) => district.after[left.id] - district.after[right.id]).slice(0, 3);
  return dataset.measures.map(measure => {
    const factor = (dataset.horizon - measure.lag) / dataset.horizon;
    const benefits = priorities.filter(indicator => (measure.effects[indicator.id] ?? 0) > 0)
      .map(indicator => ({ indicator, effect: measure.effects[indicator.id] * factor }));
    const benefitPerCost = benefits.reduce((sum, benefit) => sum + benefit.effect * benefit.indicator.weight, 0) / measure.cost;
    return { measure, benefits, benefitPerCost };
  }).filter(item => item.benefits.length).sort((left, right) => right.benefitPerCost - left.benefitPerCost || left.measure.cost - right.measure.cost).slice(0, limit);
}

export function districtCsv(dataset, result, options = {}) {
  const { districts, indicators } = selectDistrictIndicators(dataset, result, options);
  const safe = value => `"${String(value ?? '').replace(/^[=+@-]/, "'$&").replaceAll('"', '""')}"`;
  const rows = [['Данные', 'Район', 'Код', 'Показатель', 'Вес', 'До', 'После', 'Изменение', 'Критический после (<40)']];
  for (const indicator of indicators) for (const district of districts) {
    rows.push([options.mode === 'comparison' ? 'Учебный сценарий' : 'Учебная исходная картина', district.name, indicator.id, indicator.name, indicator.weight,
      district.before[indicator.id], district.after[indicator.id], district.delta[indicator.id], district.after[indicator.id] < 40 ? 'Да' : 'Нет']);
  }
  return '\uFEFF' + rows.map(row => row.map(safe).join(';')).join('\r\n');
}

export function initDistrictExplorer({ dataset, baseline }) {
  const city = document.getElementById('city');
  if (!city || city.dataset.explorerReady) return;
  city.dataset.explorerReady = 'true';
  const state = { dataset, baseline, result: null, mode: 'baseline', districtId: 'all', direction: 'all', query: '', criticalOnly: false, sort: 'weakest' };
  const summary = document.getElementById('district-summary');
  const controls = document.createElement('div');
  controls.className = 'district-controls';
  controls.innerHTML = `<div class="district-control-heading"><p>Выберите район, найдите слабые места и перейдите к подходящим мерам.</p><button type="button" class="district-action" data-district-export>Скачать CSV ↓</button></div>
    <div class="district-fields"><label>Район<select id="explorer-district"><option value="all">Все районы</option>${dataset.districts.map(district => `<option value="${escapeHtml(district.id)}">${escapeHtml(district.name)}</option>`).join('')}</select></label>
    <label>Картина<select id="explorer-mode"><option value="baseline">Исходные значения</option><option value="comparison" disabled>До и после сценария</option></select></label>
    <label>Направление<select id="explorer-direction"><option value="all">Все направления</option>${Object.entries(directions).map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}</select></label>
    <label>Порядок показателей<select id="explorer-sort"><option value="weakest">Сначала слабые</option><option value="strongest">Сначала сильные</option><option value="gain">Наибольший прирост</option><option value="weight">По весу в оценке</option></select></label></div>
    <div class="district-filter-row"><label class="district-search"><span class="sr-only">Найти показатель</span><input id="explorer-search" type="search" placeholder="Найти показатель: школы, воздух, T1…" maxlength="120"></label><label class="district-check"><input id="explorer-critical" type="checkbox">Только критические</label><button type="button" class="district-reset" data-district-reset>Сбросить фильтры</button></div>
    <p class="district-status" id="explorer-status" role="status"></p>`;
  summary.before(controls);
  const detail = document.createElement('section');
  detail.className = 'district-detail';
  detail.setAttribute('aria-labelledby', 'district-detail-heading');
  city.append(detail);
  const current = () => state.mode === 'comparison' && state.result ? state.result : state.baseline;

  function render() {
    const result = current();
    const comparing = state.mode === 'comparison' && Boolean(state.result);
    controls.querySelector('#explorer-mode option[value="comparison"]').disabled = !state.result;
    controls.querySelector('#explorer-mode').value = state.mode;
    controls.querySelector('#explorer-district').value = state.districtId;
    document.getElementById('district-state').textContent = comparing ? 'До и после вашего сценария' : 'Исходная картина';
    summary.innerHTML = result.districts.map(district => {
      const population = dataset.districts.find(item => item.id === district.id).populationShare;
      const critical = dataset.indicators.filter(indicator => district.after[indicator.id] < 40).length;
      return `<button type="button" class="district-card district-select${state.districtId === district.id ? ' is-active' : ''}" data-explorer-district="${escapeHtml(district.id)}" aria-pressed="${state.districtId === district.id}"><span class="district-heading"><strong>${escapeHtml(district.name)}</strong><img class="district-art" src="/assets/illustrations/district-${artwork[district.id]}.webp" alt="" width="48" height="48" loading="lazy"></span><span class="district-population">${number(population * 100)}% населения</span><span class="district-value">${number(district.afterScore)}</span>${comparing ? `<span class="district-change">${signed(district.afterScore - district.beforeScore)}</span>` : ''}<span class="district-mini-track" aria-hidden="true"><span style="width:${district.afterScore}%"></span></span><span class="district-critical${critical ? ' has-critical' : ''}">${critical ? `Критических: ${critical}` : 'Без критических значений'}</span><span class="district-open">${state.districtId === district.id ? 'Выбран · показать все ↗' : 'Изучить район ↗'}</span></button>`;
    }).join('');
    renderTable();
    renderDetail();
  }

  function renderTable() {
    const result = current();
    const comparing = state.mode === 'comparison' && Boolean(state.result);
    const { districts, indicators } = selectDistrictIndicators(dataset, result, state);
    document.getElementById('indicator-table').innerHTML = `<caption class="sr-only">${comparing ? 'Сравнение исходных и рассчитанных показателей' : 'Исходные показатели'}: ${districts.map(district => escapeHtml(district.name)).join(', ')}</caption><thead><tr><th scope="col">Показатель · вес</th>${districts.map(district => `<th scope="col">${escapeHtml(district.name)}</th>`).join('')}</tr></thead><tbody>${indicators.length ? indicators.map(indicator => `<tr><th scope="row"><span>${indicator.id}</span>${escapeHtml(indicator.name)}<small class="district-weight">Вес ${number(indicator.weight * 100)}%</small></th>${districts.map(district => `<td class="${district.after[indicator.id] < 40 ? 'critical' : ''}">${comparing ? `<span class="district-before" aria-label="До">${number(district.before[indicator.id])}</span><span aria-hidden="true"> → </span>` : ''}<strong>${number(district.after[indicator.id])}</strong>${comparing ? `<span class="cell-delta${district.delta[indicator.id] < 0 ? ' negative' : ''}">${signed(district.delta[indicator.id])} п.</span>` : ''}${district.after[indicator.id] < 40 ? '<span class="sr-only"> — критическое значение</span>' : ''}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${districts.length + 1}" class="district-empty">${state.criticalOnly ? 'Критических показателей по этим условиям нет.' : 'Показатели не найдены.'} Измените поиск или сбросьте фильтры.</td></tr>`}</tbody>`;
    document.getElementById('table-note').textContent = `${comparing ? 'В ячейке: до → после, ниже — изменение в пунктах.' : 'Показаны исходные значения.'} Порог критичности — строго ниже 40. Данные учебные; CSV повторяет текущие фильтры.`;
    document.getElementById('explorer-status').textContent = `${indicators.length} из ${dataset.indicators.length} показателей · ${districts.length} из ${dataset.districts.length} районов${state.result ? '' : ' · Для сравнения рассчитайте сценарий'}`;
    controls.querySelector('[data-district-export]').disabled = indicators.length === 0;
  }

  function renderDetail() {
    const result = current();
    const district = state.districtId === 'all' ? [...result.districts].sort((left, right) => left.afterScore - right.afterScore)[0] : result.districts.find(item => item.id === state.districtId);
    const priorities = [...dataset.indicators].sort((left, right) => district.after[left.id] - district.after[right.id]).slice(0, 3);
    const recommendations = districtRecommendations(dataset, district);
    detail.innerHTML = `<div class="district-detail-intro"><div><div class="eyebrow">${state.districtId === 'all' ? 'РАЙОН С МИНИМАЛЬНОЙ ОЦЕНКОЙ' : 'ПАСПОРТ РАЙОНА'}</div><h3 id="district-detail-heading">${escapeHtml(district.name)} · на что обратить внимание</h3><p>Три самых слабых показателя${state.mode === 'comparison' ? ' после расчёта' : ' на старте'}. Выберите другой район выше, чтобы сравнить приоритеты.</p></div><a href="#workspace" class="district-action">Открыть конструктор ↗</a></div>
      <div class="district-priorities">${priorities.map(indicator => `<div class="district-priority${district.after[indicator.id] < 40 ? ' is-critical' : ''}"><span>${escapeHtml(indicator.name)}</span><strong>${number(district.after[indicator.id])}<small> / 100</small></strong><p>${district.after[indicator.id] < 40 ? `До порога 40: ${number(40 - district.after[indicator.id])} п.` : 'Выше критического порога'}</p></div>`).join('')}</div>
      <h4>Меры для этих показателей</h4><p class="district-recommendation-note">Порядок — по взвешенному эффекту на эти три показателя за 1 у. е., с учётом лага. Это ориентир для выбора; совместимость и общий эффект проверит конструктор.</p><div class="district-recommendations">${recommendations.map(({ measure, benefits }) => `<article><div class="district-recommendation-top"><span>${measure.id} · ${measure.cost} у. е.</span><span>${measure.scope === 'city' ? 'Весь город' : escapeHtml(district.name)}</span></div><h5>${escapeHtml(measure.name)}</h5><p>${benefits.map(({ indicator, effect }) => `${escapeHtml(indicator.name)}: <strong>${signed(effect)}</strong>`).join(' · ')}</p>${Object.entries(measure.effects).some(([, effect]) => effect < 0) ? `<p class="district-tradeoff">Компромисс: ${Object.entries(measure.effects).filter(([, effect]) => effect < 0).map(([id, effect]) => `${escapeHtml(dataset.indicators.find(indicator => indicator.id === id)?.name || id)} ${signed(effect * (dataset.horizon - measure.lag) / dataset.horizon)}`).join(', ')}</p>` : ''}<button type="button" class="district-action" data-recommend-measure="${measure.id}" data-recommend-district="${district.id}">Рассмотреть в конструкторе ↗</button></article>`).join('')}</div>`;
  }

  controls.addEventListener('change', event => {
    const fields = { 'explorer-district': 'districtId', 'explorer-mode': 'mode', 'explorer-direction': 'direction', 'explorer-sort': 'sort' };
    if (fields[event.target.id]) state[fields[event.target.id]] = event.target.value;
    if (event.target.id === 'explorer-critical') state.criticalOnly = event.target.checked;
    render();
  });
  controls.querySelector('#explorer-search').addEventListener('input', event => { state.query = event.target.value; renderTable(); });
  controls.addEventListener('click', event => {
    if (event.target.closest('[data-district-reset]')) {
      Object.assign(state, { districtId: 'all', direction: 'all', query: '', criticalOnly: false, sort: 'weakest' });
      controls.querySelector('#explorer-direction').value = 'all';
      controls.querySelector('#explorer-sort').value = 'weakest';
      controls.querySelector('#explorer-search').value = '';
      controls.querySelector('#explorer-critical').checked = false;
      render();
    }
    if (event.target.closest('[data-district-export]')) {
      const blob = new Blob([districtCsv(dataset, current(), state)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `ascension-districts-${state.mode}-${state.districtId}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      document.getElementById('explorer-status').textContent = 'CSV подготовлен: сохранены выбранные районы и показатели.';
    }
  });
  summary.addEventListener('click', event => {
    const button = event.target.closest('[data-explorer-district]');
    if (!button) return;
    state.districtId = state.districtId === button.dataset.explorerDistrict ? 'all' : button.dataset.explorerDistrict;
    render();
    summary.querySelector(`[data-explorer-district="${button.dataset.explorerDistrict}"]`)?.focus({ preventScroll: true });
  });
  detail.addEventListener('click', event => {
    const button = event.target.closest('[data-recommend-measure]');
    if (!button) return;
    window.dispatchEvent(new CustomEvent('constructor:focus', { detail: { measureId: button.dataset.recommendMeasure, districtId: button.dataset.recommendDistrict } }));
  });
  window.addEventListener('scenario:calculated', event => {
    if (!event.detail?.result?.valid) return;
    state.result = event.detail.result;
    state.mode = 'comparison';
    render();
  });
  window.addEventListener('scenario:invalidated', () => { state.result = null; state.mode = 'baseline'; render(); });
  render();
}

if (typeof window !== 'undefined') window.addEventListener('simulator:ready', event => initDistrictExplorer(event.detail));
