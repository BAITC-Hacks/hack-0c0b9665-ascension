import { buildTrafficRoutes, createFleet, sampleTraffic } from './city-traffic-model.js';

const EMPTY = () => ({ type: 'FeatureCollection', features: [] });
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const number = (value, digits = 0) => Number(value).toLocaleString('ru-RU', { maximumFractionDigits: digits });
const SOURCE = 'city-explorer-traffic';
const ROUTES = 'city-explorer-routes';
const SELECTED = 'city-explorer-selection';
const LAYERS = ['city-explorer-selection-fill', 'city-explorer-selection-line', 'city-explorer-route-lines', 'city-explorer-vehicle-hit', 'city-explorer-vehicles', 'city-explorer-selection-building'];

/** All vehicle movement is a local visual simulation, independent of the policy score. */
export function mountCityExplorer({ host, map, city, reducedMotion = false }) {
  const stage = host.querySelector('.citymap-stage');
  const root = document.createElement('div');
  root.className = 'city-explorer';
  root.hidden = true;
  root.innerHTML = `
    <div class="city-explorer-top">
      <div class="city-explorer-badge"><span class="city-explorer-kicker">ГОРОД В ДВИЖЕНИИ</span><strong class="city-explorer-city"></strong><span>Транспорт · симуляция, не GPS</span></div>
      <div class="city-explorer-actions"><button type="button" data-action="traffic" aria-pressed="true" title="Показать или скрыть движение транспорта">Транспорт</button><button type="button" data-action="objects" aria-expanded="false">Объекты</button><button type="button" data-action="expand" aria-pressed="false" title="Развернуть карту">⛶ <span>Развернуть</span></button></div>
    </div>
    <aside class="city-explorer-panel" aria-label="Выбранный объект" hidden></aside>
    <div class="city-explorer-list" aria-label="Объекты в поле зрения" hidden></div>
    <div class="city-explorer-empty"><span class="city-explorer-kicker">ИССЛЕДУЙТЕ ГОРОД</span><strong>У каждого места — своя история</strong><p>Нажмите на здание, улицу или транспорт.<br>Выберите автобус и следуйте за ним.</p></div>
    <div class="city-explorer-bottom"><div class="city-explorer-playback" aria-label="Управление симуляцией транспорта"><button type="button" data-action="play" aria-label="Приостановить движение транспорта">Ⅱ</button><div class="city-explorer-clock"><strong>00:00</strong><span>время модели</span></div><div class="city-explorer-speeds" aria-label="Скорость времени модели">${[1, 2, 4].map((speed) => `<button type="button" data-speed="${speed}" aria-pressed="${speed === 1}" aria-label="Скорость времени ${speed}">${speed}×</button>`).join('')}</div><small class="city-explorer-status" role="status">Загружаем улицы…</small></div><p class="city-explorer-help">Перетаскивание — движение · Ctrl + колесо — масштаб · правая кнопка — поворот · WASD / Q E</p></div>`;
  stage.append(root);
  const el = (selector) => root.querySelector(selector);
  const state = { city, enabled: false, running: !reducedMotion, speed: 1, elapsed: 0, traffic: true, routes: [], fleet: [], points: EMPTY(), selection: null, following: null, destroyed: false, visible: true, refresh: true, expanded: false };
  let frame = 0;
  let previousTime = null;
  let lastPaint = 0;
  let lastClock = -1;
  let lastHover = 0;
  let internalCamera = false;
  let observer;
  let refreshTimer;
  let listItems = [];
  let focusBeforeExpand = null;
  let overflowBeforeExpand = '';

  function addVehicleImage(kind, color) {
    const id = `city-explorer-${kind}`;
    if (map.hasImage(id)) return;
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 48;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#173d3540';
    ctx.fillRect(7, 5, 21, 39);
    ctx.fillStyle = '#173d35';
    ctx.fillRect(3, 9, 26, 7);
    ctx.fillRect(3, 30, 26, 7);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(6, 3, 20, 40, 5);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#244c51';
    ctx.fillRect(9, 10, 14, kind === 'bus' ? 23 : 10);
    ctx.fillStyle = '#f8edb8';
    ctx.fillRect(8, 5, 5, 3);
    ctx.fillRect(19, 5, 5, 3);
    ctx.fillStyle = '#e88462';
    ctx.fillRect(8, 38, 4, 3);
    ctx.fillRect(20, 38, 4, 3);
    map.addImage(id, ctx.getImageData(0, 0, 32, 48), { pixelRatio: 2 });
  }

  function setupLayers() {
    addVehicleImage('car', '#6aa9ad');
    addVehicleImage('bus', '#e8b961');
    for (const id of [SOURCE, ROUTES, SELECTED]) map.addSource(id, { type: 'geojson', data: EMPTY() });
    map.addLayer({ id: LAYERS[0], source: SELECTED, type: 'fill', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#e7b651', 'fill-opacity': .35 } });
    map.addLayer({ id: LAYERS[1], source: SELECTED, type: 'line', paint: { 'line-color': '#b97725', 'line-width': 3, 'line-opacity': .9 } });
    map.addLayer({ id: LAYERS[2], source: ROUTES, type: 'line', paint: { 'line-color': '#288d82', 'line-width': 3, 'line-opacity': .5 } });
    map.addLayer({ id: LAYERS[3], source: SOURCE, type: 'circle', paint: { 'circle-radius': 13, 'circle-opacity': 0 } });
    map.addLayer({ id: LAYERS[4], source: SOURCE, type: 'symbol', layout: { 'icon-image': ['concat', 'city-explorer-', ['get', 'kind']], 'icon-size': ['interpolate', ['linear'], ['zoom'], 13, .6, 15, .9, 18, 1.5], 'icon-rotate': ['get', 'bearing'], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true } });
    map.addLayer({ id: LAYERS[5], source: SELECTED, type: 'fill-extrusion', filter: ['>', ['get', 'height'], 0], paint: { 'fill-extrusion-color': '#deb965', 'fill-extrusion-base': ['get', 'height'], 'fill-extrusion-height': ['+', ['get', 'height'], .6], 'fill-extrusion-opacity': .9 } });
  }

  function roadFeatures() {
    const layers = map.getStyle().layers.filter((layer) => layer.type === 'line' && layer['source-layer'] === 'transportation').map((layer) => layer.id);
    if (!layers.length) return [];
    const center = map.getCenter();
    const scale = Math.cos(center.lat * Math.PI / 180);
    const local = ([lng, lat]) => [(((lng - center.lng + 540) % 360) - 180) * scale, lat - center.lat];
    const distance = (feature) => {
      const lines = feature.geometry.type === 'MultiLineString' ? feature.geometry.coordinates : [feature.geometry.coordinates];
      let best = Infinity;
      for (const line of lines) for (let i = 1; i < line.length; i += 1) {
        const a = local(line[i - 1]);
        const b = local(line[i]);
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / (dx * dx + dy * dy || 1)));
        best = Math.min(best, (a[0] + t * dx) ** 2 + (a[1] + t * dy) ** 2);
      }
      return best;
    };
    return map.queryRenderedFeatures(undefined, { layers }).slice(0, 6000).map((feature) => ({ feature, distance: distance(feature) })).sort((a, b) => a.distance - b.distance).map(({ feature }) => feature);
  }

  function setStatus() {
    const label = el('.city-explorer-status');
    if (!state.traffic) label.textContent = 'Транспорт скрыт';
    else if (map.getZoom() < 13) label.textContent = 'Приблизьте карту, чтобы увидеть транспорт';
    else if (!state.fleet.length) label.textContent = 'На этом участке нет загруженных автодорог';
    else label.textContent = `${state.fleet.length} машин · ${state.running ? 'модель движется' : 'на паузе'}`;
    const play = el('[data-action="play"]');
    play.textContent = state.running ? 'Ⅱ' : '▶';
    play.setAttribute('aria-label', state.running ? 'Приостановить движение транспорта' : 'Запустить движение транспорта');
    play.setAttribute('aria-pressed', String(state.running));
  }

  function refreshTraffic() {
    if (!state.enabled || state.destroyed || state.following) return;
    if (!map.areTilesLoaded() || map.isMoving()) return;
    state.refresh = false;
    state.routes = map.getZoom() >= 13 ? buildTrafficRoutes(roadFeatures(), { limit: 36 }) : [];
    state.fleet = createFleet(state.routes, { limit: 72 });
    if (state.selection?.kind === 'vehicle') clearSelection();
    paintTraffic();
    setStatus();
    schedule();
    if (!el('.city-explorer-list').hidden) renderList();
  }

  function paintTraffic() {
    state.points = sampleTraffic(state.routes, state.fleet, state.elapsed);
    map.getSource(SOURCE)?.setData(state.traffic && state.enabled ? state.points : EMPTY());
    if (state.following) {
      const vehicle = state.points.features.find((feature) => String(feature.id) === state.following);
      if (vehicle) {
        internalCamera = true;
        map.jumpTo({ center: vehicle.geometry.coordinates });
        internalCamera = false;
      } else stopFollowing();
    }
    const second = Math.floor(state.elapsed);
    if (second !== lastClock) {
      lastClock = second;
      el('.city-explorer-clock strong').textContent = `${String(Math.floor(second / 60)).padStart(2, '0')}:${String(second % 60).padStart(2, '0')}`;
    }
  }

  function tick(now) {
    frame = 0;
    if (state.destroyed || !state.enabled || !state.running || !state.traffic || !state.visible || document.hidden) { previousTime = null; return; }
    if (previousTime !== null) state.elapsed += Math.min((now - previousTime) / 1000, .2) * state.speed;
    previousTime = now;
    if (now - lastPaint >= 50) { paintTraffic(); lastPaint = now; }
    frame = requestAnimationFrame(tick);
  }

  function schedule() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    previousTime = null;
    if (state.enabled && state.running && state.traffic && state.fleet.length && state.visible && !document.hidden && !state.destroyed) frame = requestAnimationFrame(tick);
  }

  function showPanel({ kind, title, facts = [], description = '', geometry = null, vehicleId = null, disclaimer = '', highlightHeight = 0 }) {
    state.selection = { kind, title, geometry, vehicleId };
    state.following = null;
    el('.city-explorer-empty').hidden = true;
    el('.city-explorer-list').hidden = true;
    el('[data-action="objects"]').setAttribute('aria-expanded', 'false');
    const panel = el('.city-explorer-panel');
    panel.innerHTML = `<button type="button" class="city-explorer-close" data-action="close" aria-label="Закрыть карточку объекта">×</button><span class="city-explorer-kicker">${escape(kind === 'vehicle' ? 'ТРАНСПОРТ · МОДЕЛЬ' : kind === 'district' ? 'РАЙОН · УЧЕБНАЯ МОДЕЛЬ' : 'ОБЪЕКТ НА КАРТЕ')}</span><h3>${escape(title)}</h3><div class="city-explorer-detail"><p>${escape(description)}</p></div><dl class="city-explorer-facts">${facts.map(([label, value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>${kind === 'vehicle' ? '<div class="city-explorer-panel-actions"><button type="button" data-action="follow" aria-pressed="false">Следовать за транспортом ↗</button></div>' : ''}<p class="city-explorer-disclaimer">${escape(disclaimer)}</p>`;
    panel.hidden = false;
    map.getSource(SELECTED)?.setData(geometry ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { height: highlightHeight }, geometry }] } : EMPTY());
    map.getSource(ROUTES)?.setData(EMPTY());
  }

  function selectVehicle(feature) {
    const p = feature.properties;
    const route = state.routes.find((item) => item.id === p.routeId);
    showPanel({ kind: 'vehicle', title: p.kind === 'bus' ? 'Городской автобус' : 'Легковой автомобиль', vehicleId: String(feature.id), description: p.routeName || 'Участок автодороги', facts: [['Скорость модели', `${number(p.speedKph)} км/ч`], ['Участок пути', route ? `${number(route.lengthMeters)} м` : '—']], disclaimer: 'Демонстрационное движение по геометрии дорог OSM. Маршруты, скорости и количество машин условные; GPS и расписания не подключены.' });
    if (route) map.getSource(ROUTES)?.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: route.coordinates } }] });
  }

  function featureTitle(feature) {
    const p = feature.properties || {};
    return p['name:ru'] || p.name || p['name:en'] || (feature.sourceLayer === 'building' || feature.geometry.type.includes('Polygon') && /building/.test(feature.layer?.id) ? feature.geometry.type === 'MultiPolygon' ? 'Группа зданий' : 'Здание' : feature.sourceLayer === 'transportation' ? 'Улица без названия' : p.class || 'Место на карте');
  }

  function selectFeature(feature) {
    const p = feature.properties || {};
    const building = feature.sourceLayer === 'building' || /building/.test(feature.layer?.id || '');
    const road = feature.sourceLayer?.startsWith('transportation');
    const facts = [['Тип', building ? 'Здание' : road ? 'Улица / дорога' : 'Городской объект']];
    const grouped = building && feature.geometry.type === 'MultiPolygon';
    if (grouped) { facts[0][1] = 'Группа зданий'; facts.push(['Контуров в группе', feature.geometry.coordinates.length]); }
    const height = Number(p.render_height ?? p.height);
    if (building && Number.isFinite(height) && height > 0) facts.push(['Высота на карте', `${number(height, 1)} м`]);
    if (p.class) facts.push(['Категория OSM', p.class]);
    if (p.housenumber) facts.push(['Номер дома', p.housenumber]);
    showPanel({ kind: 'feature', title: featureTitle(feature), geometry: feature.geometry.type === 'Point' ? null : JSON.parse(JSON.stringify(feature.geometry)), highlightHeight: building ? Number.isFinite(height) && height > 0 ? height : 3 : 0, facts, description: grouped ? 'Выбраны объединённые в карте контуры с общими сведениями. Крыши выделены золотым.' : building ? 'Контур и объём здания из географической карты.' : road ? 'Геометрия улицы из OpenStreetMap.' : 'Название и категория из географической карты.', disclaimer: 'Доступны только сведения из карты. Состояние объекта, население и загруженность не определены. Высота может быть типовой.' });
  }

  function clearSelection() {
    state.selection = null;
    state.following = null;
    el('.city-explorer-panel').hidden = true;
    el('.city-explorer-empty').hidden = false;
    map.getSource(SELECTED)?.setData(EMPTY());
    map.getSource(ROUTES)?.setData(EMPTY());
  }

  function candidates(point) {
    const box = point ? [[point.x - 7, point.y - 7], [point.x + 7, point.y + 7]] : undefined;
    return map.queryRenderedFeatures(box).filter((feature) => feature.source !== SELECTED && feature.source !== ROUTES && (feature.source === SOURCE || feature.sourceLayer === 'building' || feature.sourceLayer?.startsWith('transportation') || feature.layer?.type === 'symbol' && feature.properties?.name));
  }

  function pick(event) {
    if (!state.enabled) return;
    const features = candidates(event.point);
    const vehicle = features.find((feature) => feature.source === SOURCE);
    const feature = features.find((item) => item.sourceLayer === 'building') || features.find((item) => item.layer?.type === 'symbol') || features[0];
    if (vehicle) selectVehicle(vehicle);
    else if (feature) selectFeature(feature);
    else {
      showPanel({ kind: 'feature', title: 'Точка в городе', facts: [['Широта', number(event.lngLat.lat, 5)], ['Долгота', number(event.lngLat.lng, 5)]], description: 'Для этой точки в загруженной карте нет отдельной карточки объекта.', disclaimer: 'Приблизьте карту для выбора зданий и улиц.' });
    }
  }

  function renderList() {
    const vehicles = state.traffic ? state.points.features.filter((feature) => map.getBounds().contains(feature.geometry.coordinates)).slice(0, 8) : [];
    const seen = new Set();
    const features = candidates().filter((feature) => {
      if (feature.source === SOURCE) return false;
      const title = featureTitle(feature);
      if (seen.has(title) || title === 'Здание' || title === 'Улица без названия') return false;
      seen.add(title);
      return true;
    }).slice(0, 12);
    listItems = [...vehicles, ...features];
    el('.city-explorer-list').innerHTML = `<span class="city-explorer-kicker">В ПОЛЕ ЗРЕНИЯ · ${listItems.length}</span>${listItems.length ? listItems.map((feature, index) => `<button type="button" class="city-explorer-list-item" data-object="${index}"><strong>${escape(index < vehicles.length ? feature.properties.kind === 'bus' ? 'Автобус · модель' : 'Автомобиль · модель' : featureTitle(feature))}</strong><span>${escape(index < vehicles.length ? feature.properties.routeName : 'Показать сведения об объекте')}</span></button>`).join('') : '<p>Приблизьте карту или дождитесь загрузки улиц.</p>'}`;
  }

  function stopFollowing() {
    if (!state.following) return;
    state.following = null;
    const button = el('[data-action="follow"]');
    if (button) { button.textContent = 'Следовать за транспортом ↗'; button.setAttribute('aria-pressed', 'false'); }
  }

  function expand(enabled) {
    state.expanded = enabled;
    if (enabled) { focusBeforeExpand = document.activeElement; overflowBeforeExpand = document.body.style.overflow; }
    document.body.style.overflow = enabled ? 'hidden' : overflowBeforeExpand;
    host.classList.toggle('citymap-expanded', enabled);
    const button = el('[data-action="expand"]');
    button.setAttribute('aria-pressed', String(enabled));
    button.innerHTML = enabled ? '↙ <span>Свернуть</span>' : '⛶ <span>Развернуть</span>';
    button.title = enabled ? 'Свернуть карту (Esc)' : 'Развернуть карту';
    if (enabled) map.cooperativeGestures.disable();
    else map.cooperativeGestures.enable();
    map.resize();
    if (!enabled && focusBeforeExpand?.isConnected) focusBeforeExpand.focus({ preventScroll: true });
  }

  function controls(event) {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.speed) {
      state.speed = Number(button.dataset.speed);
      root.querySelectorAll('[data-speed]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
    }
    if (button.dataset.object !== undefined) {
      const feature = listItems[Number(button.dataset.object)];
      if (feature) feature.properties.kind === 'car' || feature.properties.kind === 'bus' ? selectVehicle(feature) : selectFeature(feature);
    }
    switch (button.dataset.action) {
      case 'play': state.running = !state.running; setStatus(); schedule(); break;
      case 'traffic':
        state.traffic = !state.traffic;
        button.setAttribute('aria-pressed', String(state.traffic));
        if (!state.traffic && state.selection?.kind === 'vehicle') clearSelection();
        paintTraffic(); setStatus(); schedule(); break;
      case 'close': clearSelection(); break;
      case 'objects': {
        const show = el('.city-explorer-list').hidden;
        if (show) { clearSelection(); el('.city-explorer-empty').hidden = true; renderList(); }
        else el('.city-explorer-empty').hidden = false;
        el('.city-explorer-list').hidden = !show;
        button.setAttribute('aria-expanded', String(show));
        break;
      }
      case 'follow':
        if (state.following) stopFollowing();
        else if (state.selection?.vehicleId && state.fleet.some((vehicle) => vehicle.id === state.selection.vehicleId)) {
          state.following = state.selection.vehicleId;
          button.textContent = 'Остановить следование';
          button.setAttribute('aria-pressed', 'true');
          paintTraffic();
        }
        break;
      case 'expand': expand(!state.expanded); break;
    }
  }

  function onKey(event) {
    if (!state.enabled || event.ctrlKey || event.metaKey || event.altKey || event.target.closest('input, select, textarea, [contenteditable="true"]')) return;
    if (event.key === 'Tab' && state.expanded) {
      const focusable = [...host.querySelectorAll('button:not(:disabled), input, select, a[href], [tabindex="0"]')].filter((item) => item.getClientRects().length);
      if (event.shiftKey && document.activeElement === focusable[0]) { focusable.at(-1)?.focus(); event.preventDefault(); }
      else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { focusable[0]?.focus(); event.preventDefault(); }
    }
    if (event.key === 'Escape') {
      if (state.expanded) expand(false);
      else { clearSelection(); el('.city-explorer-list').hidden = true; el('[data-action="objects"]').setAttribute('aria-expanded', 'false'); }
      event.preventDefault();
    }
    const shifts = { KeyW: [0, -80], KeyA: [-80, 0], KeyS: [0, 80], KeyD: [80, 0] };
    if (shifts[event.code]) { stopFollowing(); map.panBy(shifts[event.code], { duration: reducedMotion ? 0 : 120 }); event.preventDefault(); }
    if (event.code === 'KeyQ' || event.code === 'KeyE') { stopFollowing(); map.easeTo({ bearing: map.getBearing() + (event.code === 'KeyQ' ? -20 : 20), duration: reducedMotion ? 0 : 180 }); event.preventDefault(); }
  }

  const onIdle = () => { if (state.refresh && state.enabled && !state.following) refreshTraffic(); };
  const onMoveEnd = () => {
    if (internalCamera || state.following) return;
    state.refresh = true;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(onIdle, 120);
  };
  const onSourceData = (event) => {
    if (event.sourceId !== 'openmaptiles' || event.sourceDataType !== 'content') return;
    state.refresh = true;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(onIdle, 80);
  };
  const onMoveStart = (event) => { if (event.originalEvent) stopFollowing(); };
  const onHover = (event) => {
    if (!state.enabled || performance.now() - lastHover < 90) return;
    lastHover = performance.now();
    map.getCanvas().style.cursor = candidates(event.point).length ? 'pointer' : '';
  };
  setupLayers();
  map.on('click', pick);
  map.on('mousemove', onHover);
  map.on('idle', onIdle);
  map.on('moveend', onMoveEnd);
  map.on('movestart', onMoveStart);
  map.on('sourcedata', onSourceData);
  root.addEventListener('click', controls);
  host.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', schedule);
  if (typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver(([entry]) => { state.visible = entry.isIntersecting; schedule(); });
    observer.observe(stage);
  }

  return {
    setEnabled(enabled) {
      state.enabled = Boolean(enabled);
      root.hidden = !state.enabled;
      host.classList.toggle('citymap-exploring', state.enabled);
      if (!enabled) {
        if (state.expanded) expand(false);
        clearSelection();
        listItems = [];
        el('.city-explorer-list').hidden = true;
        el('[data-action="objects"]').setAttribute('aria-expanded', 'false');
        map.getCanvas().style.cursor = '';
      }
      map.resize();
      state.refresh = true;
      if (enabled) refreshTraffic();
      else map.getSource(SOURCE)?.setData(EMPTY());
      setStatus(); schedule();
    },
    setCity(nextCity) {
      state.city = nextCity;
      state.routes = []; state.fleet = []; state.elapsed = 0; state.refresh = true;
      listItems = [];
      el('.city-explorer-list').hidden = true;
      el('[data-action="objects"]').setAttribute('aria-expanded', 'false');
      clearSelection(); paintTraffic();
      schedule();
      el('.city-explorer-city').textContent = nextCity.name;
      setStatus();
    },
    inspectDistrict({ name, metric, value, phase, weakest }) {
      if (!state.enabled) return;
      showPanel({ kind: 'district', title: name, facts: [[metric, `${number(value, 1)} / 100`], ['Период', phase], ['Точка внимания', weakest]], description: 'Выбран район: показатели и подбор мер на странице относятся к нему.', disclaimer: 'Синтетические показатели кейса. Метка — условная точка района, не граница. Движение машин не связано с расчётом Score.' });
    },
    destroy() {
      state.destroyed = true;
      cancelAnimationFrame(frame);
      clearTimeout(refreshTimer);
      observer?.disconnect();
      document.removeEventListener('visibilitychange', schedule);
      host.removeEventListener('keydown', onKey);
      for (const [event, listener] of [['click', pick], ['mousemove', onHover], ['idle', onIdle], ['moveend', onMoveEnd], ['movestart', onMoveStart], ['sourcedata', onSourceData]]) map.off(event, listener);
      if (state.expanded) expand(false);
      for (const id of [...LAYERS].reverse()) if (map.getLayer(id)) map.removeLayer(id);
      for (const id of [SOURCE, ROUTES, SELECTED]) if (map.getSource(id)) map.removeSource(id);
      for (const kind of ['car', 'bus']) if (map.hasImage(`city-explorer-${kind}`)) map.removeImage(`city-explorer-${kind}`);
      host.classList.remove('citymap-exploring');
      root.remove();
    },
  };
}
