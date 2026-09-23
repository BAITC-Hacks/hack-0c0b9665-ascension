import { ASTANA_ROUTES, CATALOG_DATE } from './transit-catalog.js';
import { createTransitClient, normalizeRouteNumber } from './transit-provider.js';

const EMPTY = () => ({ type: 'FeatureCollection', features: [] });
const SOURCE = 'transit-stops';
const ROUTE_SOURCE = 'transit-route';
const LAYERS = ['transit-route-line', 'transit-stop-points', 'transit-route-stops'];
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const natural = (a, b) => a.number.localeCompare(b.number, 'ru', { numeric: true });
const label = (route) => `${route.from || 'Начальная остановка не указана'} → ${route.to || 'Конечная остановка не указана'}`;
const date = (value) => value ? new Date(value).toLocaleDateString('ru-RU') : 'не указана';
const errorMessage = (error) => error instanceof TypeError ? 'сервис временно не отвечает или ограничил доступ' : error?.message || 'ошибка сети';

export function routeCatalog(city, data) {
  const entries = city?.id === 'astana' ? ASTANA_ROUTES.map((r) => ({ ...r, source: 'screenshot', relations: [] })) : [];
  const byNumber = new Map(entries.map((r) => [normalizeRouteNumber(r.number), r]));
  for (const relation of data?.routes || []) {
    const key = normalizeRouteNumber(relation.number);
    if (!key) continue;
    if (!byNumber.has(key)) {
      const route = { number: relation.number, from: relation.from, to: relation.to, source: 'osm', relations: [] };
      entries.push(route);
      byNumber.set(key, route);
    }
    byNumber.get(key).relations.push(relation);
  }
  return entries.sort(natural);
}

export function matchingStops(stops, number) {
  const normalized = normalizeRouteNumber(number);
  return stops.filter((stop) => stop.routeRefs?.some((ref) => normalizeRouteNumber(ref) === normalized));
}

export function transitBounds(collection) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const feature of collection.features) {
    const points = feature.geometry.type === 'LineString' ? feature.geometry.coordinates : [feature.geometry.coordinates];
    for (const [longitude, latitude] of points) {
      west = Math.min(west, longitude); south = Math.min(south, latitude);
      east = Math.max(east, longitude); north = Math.max(north, latitude);
    }
  }
  return Number.isFinite(west) ? [[west, south], [east, north]] : null;
}

/** Local catalogue works without WebGL. External data loads only on explicit refresh. */
export function mountTransitPanel({ host, city, client = createTransitClient(), fetcher = globalThis.fetch, reducedMotion = false }) {
  if (!document.querySelector('link[data-transit]')) {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = '/transit-panel.css'; css.dataset.transit = 'true';
    document.head.append(css);
  }
  const root = document.createElement('details');
  root.className = 'transit-panel';
  root.innerHTML = `<summary><span>Автобусы и остановки <b class="transit-city"></b></span><span class="transit-count"></span></summary>
    <div class="transit-body"><p class="transit-intro">Маршруты и остановки из доступных источников. GPS-позиции автобусов и время прибытия не подключены.</p>
    <div class="transit-tools"><label class="transit-search-label">Номер или остановка<input class="transit-search" type="search" maxlength="100" placeholder="Например, 52 или вокзал"></label><button type="button" class="transit-refresh">Обновить из OpenStreetMap</button></div>
    <div class="transit-tabs" role="group" aria-label="Транспортные данные"><button type="button" data-tab="routes" aria-pressed="true">Маршруты</button><button type="button" data-tab="stops" aria-pressed="false">Остановки</button><label><input type="checkbox" class="transit-show-stops"> Остановки на карте</label></div>
    <p class="transit-status" role="status"></p><p class="transit-provenance"></p><div class="transit-selection" hidden></div>
    <div class="transit-list"></div><button type="button" class="transit-more" hidden>Показать ещё</button>
    <p class="transit-credit">Геоданные: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors · ODbL</a>. Полнота зависит от участников OSM; это не диспетчерская система.</p></div>`;
  host.append(root);
  const el = (selector) => root.querySelector(selector);
  const state = { city, data: null, map: null, selected: null, directionId: null, geometry: EMPTY(), tab: 'routes', limit: 24, generation: 0, controller: null, destroyed: false, busy: false };
  let snapshotPromise;
  let snapshot;

  function status(text) { el('.transit-status').textContent = text; }
  function stopCollection(stops) {
    return { type: 'FeatureCollection', features: stops.map((s) => ({ type: 'Feature', id: s.id, geometry: { type: 'Point', coordinates: s.coordinates }, properties: { id: s.id, name: s.name } })) };
  }
  function paint() {
    const map = state.map;
    if (!map) return;
    const stops = state.data?.stops || [];
    map.getSource(SOURCE)?.setData(el('.transit-show-stops').checked ? stopCollection(stops) : EMPTY());
    const associated = state.selected ? matchingStops(stops, state.selected.number) : [];
    map.getSource(ROUTE_SOURCE)?.setData({ type: 'FeatureCollection', features: [...state.geometry.features, ...stopCollection(associated).features] });
  }
  function render() {
    const routes = routeCatalog(state.city, state.data);
    const stops = state.data?.stops || [];
    el('.transit-city').textContent = `· ${state.city?.name || 'выберите город'}`;
    el('.transit-count').textContent = `${routes.length} маршрутов · ${stops.length} остановок`;
    el('.transit-refresh').disabled = state.busy || state.city?.kind !== 'city';
    el('.transit-refresh').textContent = state.busy ? 'Загружаем…' : 'Обновить из OpenStreetMap';
    el('.transit-show-stops').disabled = !state.map || !stops.length;
    el('.transit-provenance').textContent = [state.city?.id === 'astana' ? `Каталог Avtobys: скриншоты ${CATALOG_DATE}.` : '', state.data ? `${state.data.snapshot ? 'Сохранённый снимок OSM' : 'Ответ OSM'}: база ${date(state.data.osmTimestamp)}, загружено ${date(state.data.fetchedAt)}.${state.data.partial ? ' Показана ограниченная выборка.' : ''}` : 'OSM ещё не загружен.'].filter(Boolean).join(' ');
    const query = el('.transit-search').value.trim().toLocaleLowerCase('ru');
    const queryNumber = normalizeRouteNumber(query);
    const items = state.tab === 'routes' ? routes.filter((r) => !query || `${r.number} ${label(r)}`.toLocaleLowerCase('ru').includes(query) || (/^\d/u.test(queryNumber) && normalizeRouteNumber(r.number).includes(queryNumber))) : stops.filter((s) => !query || `${s.name} ${(s.routeRefs || []).join(' ')}`.toLocaleLowerCase('ru').includes(query));
    el('.transit-list').innerHTML = items.slice(0, state.limit).map((item) => state.tab === 'routes'
      ? `<button type="button" class="transit-card" data-route="${escape(item.number)}"><b class="transit-number">${escape(item.number)}</b><span><strong>${escape(label(item))}</strong><small>${item.source === 'screenshot' ? 'Avtobys · скриншот' : 'OpenStreetMap'}${item.endpointStatus === 'truncated' ? ' · название обрезано' : ''}</small></span></button>`
      : `<button type="button" class="transit-card transit-stop" data-stop="${item.id}"><span class="transit-stop-icon" aria-hidden="true">●</span><span><strong>${escape(item.name || 'Остановка без названия')}</strong><small>${item.routeRefs?.length ? `Маршруты OSM: ${escape(item.routeRefs.join(', '))}` : 'Маршруты не указаны в OSM'}</small></span></button>`).join('') || `<p class="transit-empty">${query ? 'Ничего не найдено. Попробуйте другой номер или название.' : state.city?.kind !== 'city' ? 'Выберите город для загрузки остановок.' : state.tab === 'routes' ? 'Каталог этого города пока не загружен. Попробуйте обновить из OpenStreetMap.' : 'Нет загруженных остановок. Нажмите «Обновить из OpenStreetMap».'}</p>`;
    el('.transit-more').hidden = items.length <= state.limit;
    el('.transit-more').textContent = `Показать ещё (${items.length - Math.min(items.length, state.limit)})`;
    renderSelection();
    paint();
  }
  function renderSelection() {
    const selected = state.selected;
    const box = el('.transit-selection');
    box.hidden = !selected;
    if (!selected) { box.replaceChildren(); return; }
    const stops = matchingStops(state.data?.stops || [], selected.number);
    box.innerHTML = `<button type="button" class="transit-close" aria-label="Закрыть маршрут">×</button><h4>Автобус ${escape(selected.number)}</h4><p>${escape(label(selected))}</p>
      ${selected.endpointStatus === 'truncated' ? '<p>Часть названия обрезана на исходном скриншоте. Полная конечная не подтверждена.</p>' : ''}
      <p>${stops.length ? `${stops.length} остановок связаны с номером в OSM. Порядок движения не установлен.` : 'Связь этого номера с остановками в загруженных данных OSM не найдена.'}</p>
      ${selected.relations.length ? `<label>Направление из OSM <select class="transit-direction">${selected.relations.map((r) => `<option value="${r.id}" ${r.id === state.directionId ? 'selected' : ''}>${escape(r.from || r.name || selected.number)} → ${escape(r.to || 'конечная не указана')}</option>`).join('')}</select></label><button type="button" class="transit-load-route" ${state.busy ? 'disabled' : ''}>Показать линию OSM</button>` : '<p>Геометрия маршрута в загруженных данных OSM отсутствует. Линия маршрута недоступна.</p>'}`;
  }
  async function loadSnapshot() {
    const generation = state.generation;
    try {
      snapshotPromise ||= fetcher('/transit-astana-stops.json').then((r) => { if (!r.ok) throw new Error('snapshot'); return r.json(); }).catch((error) => { snapshotPromise = null; throw error; });
      snapshot = await snapshotPromise;
      if (state.destroyed || state.city.id !== 'astana' || state.data) return;
      state.data = { ...snapshot, snapshot: true };
      status('Сохранённые остановки доступны без запроса к внешнему API. Нажмите обновление для получения данных OSM.');
      render();
    } catch {
      if (!state.destroyed && generation === state.generation) status('Снимок остановок недоступен. Каталог маршрутов работает; можно запросить OSM.');
    }
  }
  async function refresh() {
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    const generation = ++state.generation;
    state.busy = true; render(); status('Запрашиваем маршруты и остановки выбранного города в OSM…');
    try {
      const data = await client.loadCity(state.city, { signal: controller.signal, force: true });
      if (state.destroyed || generation !== state.generation) return;
      state.data = data;
      state.selected = state.selected ? routeCatalog(state.city, data).find((r) => normalizeRouteNumber(r.number) === normalizeRouteNumber(state.selected.number)) || null : null;
      state.geometry = EMPTY();
      status(`Получено ${data.stops.length} остановок и ${data.routes.length} направлений OSM в области города. Это не данные движения автобусов.`);
    } catch (error) {
      if (!state.destroyed && generation === state.generation) status(`OSM сейчас недоступен: ${errorMessage(error)}. ${state.data ? 'Сохранённые данные остаются доступными.' : 'Попробуйте позже.'}`);
    } finally {
      if (!state.destroyed && generation === state.generation) { state.busy = false; render(); }
    }
  }
  async function loadRoute() {
    const id = Number(el('.transit-direction')?.value);
    if (!Number.isSafeInteger(id) || id <= 0 || state.busy) return;
    state.controller?.abort();
    const controller = new AbortController(); state.controller = controller;
    const generation = ++state.generation;
    state.busy = true; render(); status('Загружаем геометрию выбранного направления…');
    try {
      const geometry = await client.loadRoute(id, { signal: controller.signal });
      if (state.destroyed || generation !== state.generation) return;
      state.geometry = geometry;
      paint();
      const bounds = transitBounds(geometry);
      if (bounds && state.map) {
        state.map.fitBounds(bounds, { padding: 65, maxZoom: 15, duration: reducedMotion ? 0 : 700 });
      }
      status(geometry.features.length ? 'Показаны сегменты выбранного направления из OSM. GPS и расписание не подключены.' : 'В OSM нет геометрии для выбранного направления.');
    } catch (error) {
      if (!state.destroyed && generation === state.generation) status(`Не удалось загрузить линию: ${errorMessage(error)}.`);
    } finally {
      if (!state.destroyed && generation === state.generation) { state.busy = false; render(); }
    }
  }
  function cancelSelection() {
    state.generation += 1; state.controller?.abort(); state.busy = false;
    state.selected = null; state.directionId = null; state.geometry = EMPTY();
  }
  function showStop(id, move = true) {
    const stop = state.data?.stops.find((s) => String(s.id) === String(id));
    if (!stop) return;
    root.open = true;
    status(`${stop.name || 'Остановка без названия'} · OSM node ${stop.id} · ${stop.coordinates[1].toFixed(5)}, ${stop.coordinates[0].toFixed(5)}${stop.routeRefs?.length ? ` · маршруты: ${stop.routeRefs.join(', ')}` : ''}`);
    if (move) state.map?.flyTo({ center: stop.coordinates, zoom: 16, duration: reducedMotion ? 0 : 700 });
  }
  function mapClick(event) {
    const layers = ['transit-stop-points', 'transit-route-stops'].filter((id) => state.map?.getLayer(id));
    const feature = layers.length ? state.map.queryRenderedFeatures(event.point, { layers })[0] : null;
    if (feature?.properties.id) showStop(feature.properties.id, false);
    else if (feature?.geometry.type === 'Point' && feature.properties.osmId) {
      root.open = true;
      status(`Остановка направления OSM · node ${feature.properties.osmId} · ${feature.geometry.coordinates[1].toFixed(5)}, ${feature.geometry.coordinates[0].toFixed(5)}. Название в геометрии не указано.`);
    }
  }
  function setMap(map) {
    if (state.map) {
      state.map.off('click', mapClick);
      for (const layer of [...LAYERS].reverse()) if (state.map.getLayer(layer)) state.map.removeLayer(layer);
      for (const source of [SOURCE, ROUTE_SOURCE]) if (state.map.getSource(source)) state.map.removeSource(source);
    }
    state.map = map;
    if (map) {
      map.addSource(SOURCE, { type: 'geojson', data: EMPTY() });
      map.addSource(ROUTE_SOURCE, { type: 'geojson', data: EMPTY() });
      map.addLayer({ id: LAYERS[0], type: 'line', source: ROUTE_SOURCE, filter: ['==', '$type', 'LineString'], paint: { 'line-color': '#7c3aed', 'line-width': 5, 'line-opacity': .85 } });
      map.addLayer({ id: LAYERS[1], type: 'circle', source: SOURCE, paint: { 'circle-color': '#0879bf', 'circle-radius': 5, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
      map.addLayer({ id: LAYERS[2], type: 'circle', source: ROUTE_SOURCE, filter: ['==', '$type', 'Point'], paint: { 'circle-color': '#f5b83e', 'circle-radius': 7, 'circle-stroke-color': '#362b13', 'circle-stroke-width': 2 } });
      map.on('click', mapClick);
    }
    render();
  }
  function setCity(next) {
    cancelSelection(); state.city = next; state.data = next.id === 'astana' && snapshot ? { ...snapshot, snapshot: true } : null;
    state.limit = 24; el('.transit-search').value = ''; el('.transit-show-stops').checked = false;
    status(next.kind === 'city' ? 'Каталог относится к выбранному городу. Данные OSM можно загрузить кнопкой обновления.' : 'Для транспортных данных выберите город.');
    render();
    if (next.id === 'astana' && !state.data) void loadSnapshot();
  }
  el('.transit-refresh').addEventListener('click', refresh);
  el('.transit-search').addEventListener('input', () => { state.limit = 24; render(); });
  el('.transit-show-stops').addEventListener('change', paint);
  el('.transit-more').addEventListener('click', () => { state.limit += 24; render(); });
  root.addEventListener('change', (event) => {
    if (event.target.matches('.transit-direction')) {
      state.generation += 1; state.controller?.abort(); state.busy = false;
      state.directionId = Number(event.target.value); state.geometry = EMPTY();
      render();
    }
  });
  root.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]');
    if (tab) { state.tab = tab.dataset.tab; state.limit = 24; root.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-pressed', String(b === tab))); render(); }
    const route = event.target.closest('[data-route]');
    if (route) { cancelSelection(); state.selected = routeCatalog(state.city, state.data).find((r) => r.number === route.dataset.route); render(); }
    const stop = event.target.closest('[data-stop]'); if (stop) showStop(stop.dataset.stop);
    if (event.target.closest('.transit-close')) { cancelSelection(); render(); }
    if (event.target.closest('.transit-load-route')) void loadRoute();
  });
  setCity(city);
  return { setMap, setCity, destroy() { state.destroyed = true; cancelSelection(); setMap(null); root.remove(); } };
}
