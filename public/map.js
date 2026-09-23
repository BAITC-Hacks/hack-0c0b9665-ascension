import { PLACES, DISTRICT_ANCHORS, findPreset } from './places.js';
import { mountCityExplorer } from './city-explorer.js';

const VERSION = '5.24.0';
const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const SEARCH_URL = 'https://photon.komoot.io/api/';
const fmt = (value, digits = 1) => Number(value).toLocaleString('ru-RU', { maximumFractionDigits: digits, minimumFractionDigits: digits });
const signed = (value) => `${value > 0 ? '+' : ''}${fmt(value)}`;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let libraryPromise;
let componentNumber = 0;

function loadMapLibrary() {
  if (globalThis.maplibregl) return Promise.resolve(globalThis.maplibregl);
  if (libraryPromise) return libraryPromise;
  libraryPromise = new Promise((resolve, reject) => {
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = `/vendor/maplibre-gl-${VERSION}.css`;
    document.head.append(stylesheet);
    const script = document.createElement('script');
    script.src = `/vendor/maplibre-gl-${VERSION}.js`;
    script.async = true;
    script.onload = () => globalThis.maplibregl ? resolve(globalThis.maplibregl) : reject(new Error('Map library unavailable'));
    script.onerror = () => reject(new Error('Map library unavailable'));
    document.head.append(script);
  });
  return libraryPromise;
}

export function createCityMap({ container, dataset, baseline, onDistrictSelect }) {
  const host = typeof container === 'string' ? document.getElementById(container) : container;
  if (!host) throw new Error('A map container is required');
  const prefix = `citymap-${++componentNumber}`;
  const state = { city: PLACES[0], result: null, districtId: 'nura', metric: 'score', phase: 'before', is3D: true, map: null, markers: [], loaded: false, destroyed: false, searchId: 0, lastSearchAt: 0, cache: new Map() };
  if (!document.querySelector('link[data-city-explorer]')) {
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = '/city-explorer.css';
    stylesheet.dataset.cityExplorer = 'true';
    document.head.append(stylesheet);
  }
  host.classList.add('citymap');
  host.innerHTML = `
    <div class="citymap-toolbar">
      <label class="citymap-place-label" for="${prefix}-place"><span class="citymap-field-caption">ТЕРРИТОРИЯ</span><select id="${prefix}-place" class="citymap-place" aria-label="Выбрать город или регион"><optgroup label="Города Казахстана">${PLACES.filter((p) => p.kind === 'city').map((p) => `<option value="${p.id}">${p.name}${p.hasScenarioData ? ' · демо' : ''}</option>`).join('')}</optgroup><optgroup label="Регионы и страна">${PLACES.filter((p) => p.kind !== 'city').map((p) => `<option value="${p.id}">${p.name}</option>`).join('')}</optgroup></select></label>
      <form class="citymap-search" role="search"><label class="citymap-field-caption" for="${prefix}-search">НАЙТИ НА КАРТЕ</label><div class="citymap-search-row"><span aria-hidden="true">⌕</span><input id="${prefix}-search" type="search" maxlength="120" autocomplete="off" placeholder="Любой город или регион" aria-describedby="${prefix}-search-status"><button type="submit" aria-label="Найти город или регион">Найти <span aria-hidden="true">↗</span></button></div><div class="citymap-search-results" hidden></div></form>
      <div class="citymap-mode" aria-label="Вид карты"><button type="button" data-view="2d" aria-pressed="false">Обзор 2D</button><button type="button" data-view="3d" aria-pressed="true">Город 3D <span aria-hidden="true">◇</span></button></div>
    </div>
    <p class="citymap-search-status" id="${prefix}-search-status" role="status" hidden></p>
    <div class="citymap-stage">
      <div class="citymap-canvas" aria-label="Интерактивная карта. Масштабируйте кнопками или колесом, перемещайте перетаскиванием."></div>
      <div class="citymap-location"><span class="citymap-live-dot" aria-hidden="true"></span><div><strong class="citymap-city-name">Астана</strong><span class="citymap-city-caption">Демонстрационный сценарий · 5 районов</span></div></div>
      <div class="citymap-loading" role="status"><span class="citymap-loader" aria-hidden="true"></span>Загружаем географическую карту…</div>
      <div class="citymap-fallback" hidden><span aria-hidden="true">⌁</span><h3>Карта сейчас недоступна</h3><p>Проверьте подключение и поддержку WebGL в браузере. Данные районов остаются в списке под картой.</p><button type="button" class="citymap-retry">Повторить загрузку</button></div>
      <div class="citymap-map-tools"><button type="button" class="citymap-overview" title="Показать всю выбранную территорию" aria-label="Показать всю выбранную территорию">⌖</button><button type="button" class="citymap-buildings" title="Приблизить к зданиям" aria-label="Приблизить к зданиям">▥</button></div>
      <div class="citymap-inspector" aria-live="polite"></div>
      <div class="citymap-legend"><span class="citymap-legend-label">Оценка района</span><span class="citymap-gradient" aria-hidden="true"></span><div><span>0 · ниже</span><span>выше · 100</span></div></div>
      <p class="citymap-network-note" role="status" hidden></p>
    </div>
    <div class="citymap-data-toolbar"><div class="citymap-phase" aria-label="Показатели до и после"><button type="button" data-phase="before" aria-pressed="true">До решений</button><button type="button" data-phase="after" aria-pressed="false" disabled>После решений</button></div><label for="${prefix}-metric" class="citymap-metric-label">Слой данных <select id="${prefix}-metric" class="citymap-metric"><option value="score">Общая оценка района</option>${dataset.indicators.map((i) => `<option value="${escape(i.id)}">${escape(i.name)}</option>`).join('')}</select></label></div>
    <div class="citymap-district-list" aria-label="Районы демонстрационной модели"></div>
    <p class="citymap-disclaimer">Показатели — синтетические данные кейса. Метки обозначают условные точки районов, не их границы. 3D показывает здания из OpenStreetMap; полнота и высота зависят от исходных данных.</p>
    <p class="citymap-search-credit">Поиск: <a href="https://github.com/komoot/photon" target="_blank" rel="noopener noreferrer">Photon</a> · География: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap</a></p>`;

  const el = (selector) => host.querySelector(selector);
  const all = (selector) => [...host.querySelectorAll(selector)];
  const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let loadingTimer;
  let searchController;
  let resizeObserver;
  let explorer;
  const currentDistricts = () => (state.result || baseline).districts;
  const metricName = () => state.metric === 'score' ? 'Оценка района' : dataset.indicators.find((i) => i.id === state.metric)?.name || state.metric;
  const districtValue = (district) => state.metric === 'score' ? district[state.phase === 'after' ? 'afterScore' : 'beforeScore'] : district[state.phase][state.metric];
  const valueTone = (value) => value < 40 ? 'critical' : value < 55 ? 'watch' : value < 65 ? 'steady' : 'good';

  function renderDistricts() {
    const enabled = state.city.hasScenarioData === true;
    el('.citymap-data-toolbar').hidden = !enabled;
    el('.citymap-district-list').hidden = !enabled;
    el('.citymap-legend').hidden = !enabled;
    el('.citymap-legend-label').textContent = metricName();
    all('[data-phase]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.phase === state.phase));
      button.disabled = button.dataset.phase === 'after' && !state.result;
    });
    if (!enabled) {
      el('.citymap-inspector').innerHTML = `<span class="citymap-kicker">ГЕОГРАФИЧЕСКИЙ ОБЗОР</span><h3>${escape(state.city.name)}</h3><p class="citymap-geography-note">Карта доступна. Для расчёта решений нужны проверенные местные показатели, бюджет и эффекты мер.</p><button type="button" class="citymap-return">Вернуться к демо Астаны <span aria-hidden="true">↗</span></button>`;
      el('.citymap-return').addEventListener('click', () => setCity('astana'));
      el('.citymap-disclaimer').textContent = 'Для этой территории местные данные не подключены. Оценки и результаты Астаны сюда не переносятся. География и 3D-здания — OpenStreetMap.';
    } else {
      el('.citymap-disclaimer').textContent = 'Показатели — синтетические данные кейса. Метки обозначают условные точки районов, не их границы. 3D показывает здания из OpenStreetMap; полнота и высота зависят от исходных данных.';
      el('.citymap-district-list').innerHTML = currentDistricts().map((district) => {
        const value = districtValue(district);
        const change = district.afterScore - district.beforeScore;
        return `<button type="button" data-district="${escape(district.id)}" class="citymap-district-card ${district.id === state.districtId ? 'is-selected' : ''}" aria-pressed="${district.id === state.districtId}"><span class="citymap-district-card-name"><span class="citymap-tone-dot" data-tone="${valueTone(value)}"></span>${escape(district.name)}</span><strong>${fmt(value)}</strong><span class="citymap-district-card-foot">${state.phase === 'after' && state.result ? `${signed(change)} к оценке` : 'Исходный показатель'}</span></button>`;
      }).join('');
      renderInspector();
    }
    updateMarkers();
  }

  function renderInspector() {
    const district = currentDistricts().find((item) => item.id === state.districtId);
    if (!district) return;
    const values = district[state.phase];
    const weakest = dataset.indicators.reduce((min, item) => values[item.id] < values[min.id] ? item : min, dataset.indicators[0]);
    const criticalCount = dataset.indicators.filter((item) => values[item.id] < 40).length;
    const value = districtValue(district);
    const beforeValue = state.metric === 'score' ? district.beforeScore : district.before[state.metric];
    const afterValue = state.metric === 'score' ? district.afterScore : district.after[state.metric];
    el('.citymap-inspector').innerHTML = `<div class="citymap-inspector-heading"><span class="citymap-kicker">${state.phase === 'after' ? 'ПОСЛЕ РЕШЕНИЙ' : 'ИСХОДНАЯ КАРТИНА'}</span><span class="citymap-sample-tag">Демо</span></div><h3>${escape(district.name)} <span>район</span></h3><div class="citymap-inspector-value"><strong data-tone="${valueTone(value)}">${fmt(value)}</strong><span>${escape(metricName())}${state.result ? `<b class="citymap-inspector-delta">${fmt(beforeValue)} → ${fmt(afterValue)} <em>(${signed(afterValue - beforeValue)})</em></b>` : '<b>из 100 баллов</b>'}</span></div><div class="citymap-priority"><span>${criticalCount ? `${criticalCount} критических показателя` : 'Точка внимания'}</span><strong>${escape(weakest.name)}</strong><span>${fmt(values[weakest.id])} / 100 · минимальный показатель</span></div>`;
  }

  function updateMarkers() {
    if (!state.map || !globalThis.maplibregl) return;
    state.markers.forEach((marker) => marker.remove());
    state.markers = [];
    if (!state.city.hasScenarioData) return;
    for (const district of currentDistricts()) {
      const coordinates = DISTRICT_ANCHORS[district.id];
      if (!coordinates) continue;
      const value = districtValue(district);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `citymap-marker ${state.districtId === district.id ? 'is-selected' : ''}`;
      button.dataset.tone = valueTone(value);
      button.setAttribute('aria-label', `${district.name}. ${metricName()}: ${fmt(value)}. Условная точка района.`);
      button.setAttribute('aria-pressed', String(state.districtId === district.id));
      button.innerHTML = `<span class="citymap-marker-number">${fmt(value)}</span><span class="citymap-marker-label">${escape(district.name)}</span>`;
      button.addEventListener('click', (event) => { event.stopPropagation(); focusDistrict(district.id, false); });
      state.markers.push(new globalThis.maplibregl.Marker({ element: button, anchor: 'bottom' }).setLngLat(coordinates).addTo(state.map));
    }
  }

  function focusDistrict(id, move = true) {
    if (!state.city.hasScenarioData || !currentDistricts().some((district) => district.id === id)) return;
    state.districtId = id;
    renderDistricts();
    inspectDistrict();
    if (move && state.loaded) state.map.easeTo({ center: DISTRICT_ANCHORS[id], zoom: Math.max(state.map.getZoom(), 12.2), duration: reducedMotion ? 0 : 750 });
    if (typeof onDistrictSelect === 'function') onDistrictSelect(id);
  }

  function inspectDistrict() {
    const district = currentDistricts().find((item) => item.id === state.districtId);
    if (!district || !state.city.hasScenarioData) return;
    const values = district[state.phase];
    const weakest = dataset.indicators.reduce((min, item) => values[item.id] < values[min.id] ? item : min, dataset.indicators[0]);
    explorer?.inspectDistrict({ name: district.name, metric: metricName(), value: districtValue(district), phase: state.phase === 'after' ? 'После решений' : 'До решений', weakest: `${weakest.name} · ${fmt(values[weakest.id])}` });
  }

  function showTerritory() {
    if (!state.map || !state.loaded) return;
    state.is3D = false;
    updateViewButtons();
    if (state.city.bounds) state.map.fitBounds(state.city.bounds, { padding: { top: 100, right: 65, bottom: 90, left: 65 }, maxZoom: 12, pitch: 0, bearing: 0, duration: reducedMotion ? 0 : 950 });
    else state.map.flyTo({ center: state.city.center, zoom: state.city.zoom ?? 11.5, pitch: 0, bearing: 0, duration: reducedMotion ? 0 : 950 });
  }

  function updateViewButtons() {
    all('[data-view]').forEach((button) => button.setAttribute('aria-pressed', String((button.dataset.view === '3d') === state.is3D)));
    if (state.loaded && state.map.getLayer('citymap-buildings-3d')) state.map.setLayoutProperty('citymap-buildings-3d', 'visibility', state.is3D ? 'visible' : 'none');
    explorer?.setEnabled(state.is3D);
  }

  function set3D(enabled, close = false) {
    state.is3D = enabled;
    updateViewButtons();
    if (!state.loaded) return;
    const center = state.city.hasScenarioData && enabled && state.map.getZoom() < 13 ? [71.4304, 51.1282] : state.map.getCenter();
    state.map.flyTo({ center, pitch: enabled ? 58 : 0, bearing: enabled ? -18 : 0, zoom: enabled ? Math.max(state.map.getZoom(), close ? 15.8 : 14.7) : state.map.getZoom(), duration: reducedMotion ? 0 : 1100 });
  }

  function setCity(city) {
    const next = typeof city === 'string' ? findPreset(city) : city;
    if (!next || !Array.isArray(next.center) || next.center.length !== 2 || !next.center.every(Number.isFinite) || Math.abs(next.center[0]) > 180 || Math.abs(next.center[1]) > 85) return false;
    state.searchId += 1;
    searchController?.abort();
    el('.citymap-search button[type="submit"]').disabled = false;
    // Dataset identity is explicit; searched places never inherit Astana metrics.
    state.city = { ...next, hasScenarioData: next.id === 'astana' && next.hasScenarioData === true };
    explorer?.setCity(state.city);
    el('.citymap-city-name').textContent = state.city.name;
    el('.citymap-city-caption').textContent = state.city.hasScenarioData ? 'Демонстрационный сценарий · 5 районов' : 'Географический обзор · местные данные не подключены';
    const select = el('.citymap-place');
    const oldCustom = select.querySelector('[data-custom]');
    oldCustom?.remove();
    if (!PLACES.some((place) => place.id === next.id)) {
      const option = document.createElement('option');
      option.value = next.id;
      option.textContent = next.name;
      option.dataset.custom = 'true';
      select.append(option);
    }
    select.value = next.id;
    el('.citymap-search-results').hidden = true;
    renderDistricts();
    if (state.is3D && state.city.kind === 'city' && state.loaded) state.map.flyTo({ center: state.city.hasScenarioData ? [71.4304, 51.1282] : state.city.center, zoom: 15, pitch: 58, bearing: -18, duration: reducedMotion ? 0 : 1000 });
    else showTerritory();
    window.dispatchEvent(new CustomEvent('city:changed', { detail: { id: state.city.id, name: state.city.name, center: [...state.city.center], kind: state.city.kind, hasScenarioData: state.city.hasScenarioData } }));
    return true;
  }

  function setResult(result) {
    state.result = result?.valid !== false && Array.isArray(result?.districts) ? result : null;
    state.phase = state.result ? 'after' : 'before';
    renderDistricts();
    if (state.city.hasScenarioData) inspectDistrict();
  }

  function searchStatus(message) {
    el('.citymap-search-status').textContent = message;
    el('.citymap-search-status').hidden = !message;
  }

  async function search(event) {
    event.preventDefault();
    const query = el('input[type="search"]').value.trim();
    if (query.length < 2) { searchStatus('Введите не менее двух символов: город, область или регион.'); return; }
    const preset = findPreset(query);
    if (preset) { setCity(preset); searchStatus(`Выбрано: ${preset.name}.`); return; }
    if (Date.now() - state.lastSearchAt < 1600) { searchStatus('Подождите секунду перед следующим поиском.'); return; }
    const requestId = ++state.searchId;
    searchController?.abort();
    searchController = new AbortController();
    const controller = searchController;
    const timeout = setTimeout(() => controller.abort(), 12000);
    const submit = el('.citymap-search button[type="submit"]');
    submit.disabled = true;
    el('.citymap-search-results').hidden = true;
    searchStatus('Ищем город или регион…');
    try {
      const cacheKey = query.toLocaleLowerCase();
      let data = state.cache.get(cacheKey);
      if (!data) {
        state.lastSearchAt = Date.now();
        const url = new URL(SEARCH_URL);
        url.searchParams.set('q', query);
        url.searchParams.set('limit', '6');
        url.searchParams.set('lat', String(state.city.center[1]));
        url.searchParams.set('lon', String(state.city.center[0]));
        for (const layer of ['city', 'county', 'state', 'country']) url.searchParams.append('layer', layer);
        const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' }, credentials: 'omit' });
        if (!response.ok) throw new Error('Search unavailable');
        data = await response.json();
        if (!Array.isArray(data.features)) throw new Error('Invalid search response');
        if (state.cache.size >= 30) state.cache.delete(state.cache.keys().next().value);
        state.cache.set(cacheKey, data);
      }
      if (requestId !== state.searchId || state.destroyed) return;
      const features = data.features.filter((feature) => feature.geometry?.type === 'Point' && feature.geometry.coordinates?.length === 2 && feature.geometry.coordinates.every(Number.isFinite) && Math.abs(feature.geometry.coordinates[0]) <= 180 && Math.abs(feature.geometry.coordinates[1]) <= 85).slice(0, 6);
      if (!features.length) { searchStatus('Место не найдено. Уточните название и страну или выберите территорию из списка.'); return; }
      const results = el('.citymap-search-results');
      results.replaceChildren();
      for (const feature of features) {
        const p = feature.properties || {};
        const context = [...new Set([p.state, p.country].filter((name) => name && name !== p.name))].join(', ');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'citymap-search-result';
        button.innerHTML = `<strong>${escape(p.name || query)}</strong><span>${escape(context || 'Географический обзор')}</span>`;
        button.addEventListener('click', () => {
          const center = feature.geometry.coordinates;
          const knownAstana = p.countrycode?.toUpperCase() === 'KZ' && ['city', 'state'].includes(p.type) && Math.abs(center[0] - 71.43) < 0.2 && Math.abs(center[1] - 51.15) < 0.2 && ['Астана', 'Astana', 'Астана қаласы'].includes(p.name);
          if (knownAstana) setCity('astana');
          else {
            const extent = p.extent;
            const bounds = Array.isArray(extent) && extent.length === 4 && extent.every(Number.isFinite) ? [[extent[0], extent[3]], [extent[2], extent[1]]] : null;
            setCity({ id: `search-${p.osm_type || ''}-${p.osm_id || `${center[0]}-${center[1]}`}`, name: p.name || query, center, bounds, kind: ['state', 'county'].includes(p.type) ? 'region' : p.type === 'country' ? 'country' : 'city', zoom: ['state', 'county', 'country'].includes(p.type) ? 6 : 11.5 });
          }
          searchStatus(`Выбрано: ${p.name || query}${context ? ` · ${context}` : ''}.`);
        });
        results.append(button);
      }
      results.hidden = false;
      searchStatus('Выберите место из результатов поиска.');
    } catch (error) {
      if (requestId === state.searchId && !state.destroyed) searchStatus(error.name === 'AbortError' ? 'Поиск не ответил вовремя. Выберите город из списка или повторите позже.' : 'Поиск временно недоступен. Города и регионы из списка работают без поискового сервиса.');
    } finally {
      clearTimeout(timeout);
      if (requestId === state.searchId && !state.destroyed) submit.disabled = false;
    }
  }

  function failMap() {
    clearTimeout(loadingTimer);
    state.loaded = false;
    explorer?.destroy();
    explorer = null;
    el('.citymap-loading').hidden = true;
    el('.citymap-fallback').hidden = false;
    host.classList.add('citymap-is-unavailable');
  }

  async function initialize() {
    clearTimeout(loadingTimer);
    el('.citymap-fallback').hidden = true;
    el('.citymap-loading').hidden = false;
    el('.citymap-network-note').hidden = true;
    host.classList.remove('citymap-is-unavailable');
    loadingTimer = setTimeout(() => { if (!state.loaded) failMap(); }, 22000);
    try {
      const lib = await loadMapLibrary();
      if (state.destroyed) return;
      explorer?.destroy();
      explorer = null;
      state.map?.remove();
      state.loaded = false;
      state.map = new lib.Map({ container: el('.citymap-canvas'), style: STYLE_URL, center: state.is3D && state.city.hasScenarioData ? [71.4304, 51.1282] : state.city.center, zoom: state.is3D ? 15 : state.city.zoom ?? 11.5, maxZoom: 19, pitch: state.is3D ? 58 : 0, bearing: state.is3D ? -18 : 0, maxPitch: 65, attributionControl: false, cooperativeGestures: true, locale: { 'NavigationControl.ZoomIn': 'Приблизить', 'NavigationControl.ZoomOut': 'Отдалить', 'NavigationControl.ResetBearing': 'На север', 'AttributionControl.ToggleAttribution': 'Источники карты', 'CooperativeGesturesHandler.WindowsHelpText': 'Ctrl + прокрутка — масштаб карты', 'CooperativeGesturesHandler.MacHelpText': '⌘ + прокрутка — масштаб карты', 'CooperativeGesturesHandler.MobileHelpText': 'Перемещайте карту двумя пальцами' } });
      const map = state.map;
      map.addControl(new lib.NavigationControl({ visualizePitch: true }), 'top-right');
      map.addControl(new lib.AttributionControl({ compact: false }), 'bottom-right');
      map.addControl(new lib.ScaleControl({ maxWidth: 100, unit: 'metric' }), 'bottom-right');
      map.on('load', () => {
        if (state.destroyed || state.map !== map) return;
        state.loaded = true;
        clearTimeout(loadingTimer);
        el('.citymap-loading').hidden = true;
        el('.citymap-fallback').hidden = true;
        host.classList.remove('citymap-is-unavailable');
        const firstLabel = map.getStyle().layers.find((layer) => layer.type === 'symbol' && layer.layout?.['text-field'])?.id;
        map.addLayer({ id: 'citymap-buildings-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 13, filter: ['!=', ['get', 'hide_3d'], true], layout: { visibility: state.is3D ? 'visible' : 'none' }, paint: { 'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 3], 0, '#dce4d8', 20, '#b6cdc2', 70, '#7daba5', 160, '#477a7d'], 'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 3], 'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0], 'fill-extrusion-opacity': 0.96 } }, firstLabel);
        map.setLight({ anchor: 'viewport', color: '#fff4de', intensity: .38, position: [1.5, 210, 35] });
        explorer = mountCityExplorer({ host, map, city: state.city, reducedMotion });
        explorer.setCity(state.city);
        explorer.setEnabled(state.is3D);
        updateMarkers();
        if (state.city.bounds) showTerritory();
      });
      map.on('error', () => {
        if (state.destroyed || state.map !== map) return;
        if (state.loaded) {
          el('.citymap-network-note').textContent = 'Часть карты не загрузилась. Проверьте подключение к интернету.';
          el('.citymap-network-note').hidden = false;
        }
      });
      map.on('idle', () => { if (state.loaded && map.areTilesLoaded()) el('.citymap-network-note').hidden = true; });
      map.getCanvas().addEventListener('webglcontextlost', (event) => { event.preventDefault(); failMap(); });
      resizeObserver?.disconnect();
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => state.map?.resize());
        resizeObserver.observe(el('.citymap-stage'));
      }
      updateMarkers();
    } catch {
      if (!state.destroyed) failMap();
    }
  }

  el('.citymap-place').addEventListener('change', (event) => { setCity(event.target.value); searchStatus(''); });
  el('.citymap-search').addEventListener('submit', search);
  el('input[type="search"]').addEventListener('keydown', (event) => { if (event.key === 'Escape') el('.citymap-search-results').hidden = true; });
  el('.citymap-district-list').addEventListener('click', (event) => { const button = event.target.closest('[data-district]'); if (button) focusDistrict(button.dataset.district); });
  el('.citymap-metric').addEventListener('change', (event) => { state.metric = event.target.value; renderDistricts(); inspectDistrict(); });
  all('[data-phase]').forEach((button) => button.addEventListener('click', () => { state.phase = button.dataset.phase; renderDistricts(); inspectDistrict(); }));
  all('[data-view]').forEach((button) => button.addEventListener('click', () => set3D(button.dataset.view === '3d')));
  el('.citymap-overview').addEventListener('click', showTerritory);
  el('.citymap-buildings').addEventListener('click', () => set3D(true, true));
  el('.citymap-retry').addEventListener('click', () => { libraryPromise = undefined; void initialize(); });
  renderDistricts();
  const ready = initialize();
  return { setResult, setCity, focusDistrict, ready, destroy() { state.destroyed = true; clearTimeout(loadingTimer); searchController?.abort(); resizeObserver?.disconnect(); explorer?.destroy(); state.markers.forEach((marker) => marker.remove()); state.map?.remove(); host.replaceChildren(); } };
}
