const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const SOURCE = 'OpenStreetMap / Overpass';
const CACHE_TTL = 10 * 60 * 1000;
const REQUEST_INTERVAL = 15 * 1000;
const STOP_LIMIT = 1500;
const ROUTE_LIMIT = 500;
const OSM_URL = 'https://www.openstreetmap.org';

function fail(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

export function normalizeRouteNumber(value) {
  return String(value ?? '').trim().toUpperCase().replace(/[ABH]/g, (letter) => ({ A: 'А', B: 'В', H: 'Н' })[letter]);
}

function cityBounds(city) {
  if (!city || city.kind !== 'city' || typeof city.id !== 'string' || !city.id.trim()
    || !Array.isArray(city.center) || city.center.length !== 2 || !validCoordinates(city.center)) {
    throw fail('INVALID_CITY', 'Выберите город с корректными координатами.');
  }
  const [lon, lat] = city.center;
  // No city names or identifiers are interpolated into Overpass QL.
  return [Math.max(-90, lat - .18), Math.max(-180, lon - .28), Math.min(90, lat + .18), Math.min(180, lon + .28)]
    .map((value) => Number(value.toFixed(6)));
}

export function buildCityQuery(city) {
  const bbox = cityBounds(city).join(',');
  return `[out:json][timeout:18];(node["highway"="bus_stop"](${bbox});node["public_transport"="platform"]["bus"="yes"](${bbox});relation["route"="bus"](${bbox}););out body;`;
}

function validId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validCoordinates(value) {
  return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
    && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
}

function elementsOf(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.elements)) {
    throw fail('INVALID_RESPONSE', 'Некорректный ответ сервиса маршрутов.');
  }
  if (json.remark) throw fail('UPSTREAM_ERROR', 'Overpass вернул ошибку или неполный ответ. Попробуйте позже.');
  if (json.elements.some((element) => !element || typeof element !== 'object' || Array.isArray(element)
    || !['node', 'way', 'relation'].includes(element.type) || !validId(element.id)
    || (element.tags !== undefined && (!element.tags || typeof element.tags !== 'object' || Array.isArray(element.tags))))) {
    throw fail('INVALID_RESPONSE', 'Некорректные объекты в ответе сервиса маршрутов.');
  }
  return json.elements;
}

function textTag(tags, name) {
  return typeof tags?.[name] === 'string' ? tags[name].trim() : '';
}

function metadata(json, fetchedAt) {
  const timestamp = json.osm3s?.timestamp_osm_base;
  return { source: SOURCE, fetchedAt, osmTimestamp: typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)) ? timestamp : null };
}

function routeDetails(element) {
  return {
    id: element.id,
    number: textTag(element.tags, 'ref'),
    from: textTag(element.tags, 'from'),
    to: textTag(element.tags, 'to'),
    name: textTag(element.tags, 'name:ru') || textTag(element.tags, 'name'),
    osmUrl: `${OSM_URL}/relation/${element.id}`,
  };
}

/** A bounded geographic inventory, not an authoritative list of operational routes. */
export function parseTransitResponse(json, { city, fetchedAt = new Date().toISOString() } = {}) {
  const [south, west, north, east] = cityBounds(city);
  const elements = elementsOf(json);
  const routes = [], stops = [], routeIds = new Set(), stopIds = new Set();
  let partial = false;
  for (const element of elements) {
    if (element.type === 'relation' && element.tags?.route === 'bus') {
      if (!validId(element.id)) throw fail('INVALID_RESPONSE', 'Маршрут не содержит корректный OSM ID.');
      if (routeIds.has(element.id)) continue;
      routeIds.add(element.id);
      if (routes.length >= ROUTE_LIMIT) { partial = true; continue; }
      routes.push(routeDetails(element));
    } else if (element.type === 'node' && (element.tags?.highway === 'bus_stop'
      || (element.tags?.public_transport === 'platform' && element.tags?.bus === 'yes'))) {
      const coordinates = [element.lon, element.lat];
      if (!validId(element.id) || !validCoordinates(coordinates)) {
        throw fail('INVALID_RESPONSE', 'Остановка не содержит корректный OSM ID или координаты.');
      }
      if (stopIds.has(element.id) || element.lat < south || element.lat > north || element.lon < west || element.lon > east) continue;
      stopIds.add(element.id);
      if (stops.length >= STOP_LIMIT) { partial = true; continue; }
      const routeRefs = [...new Set(textTag(element.tags, 'route_ref').split(/[;,]/)
        .map(normalizeRouteNumber).filter((value) => /^\d+[А-ЯA-Z]?$/u.test(value)))];
      stops.push({ id: element.id, name: textTag(element.tags, 'name:ru') || textTag(element.tags, 'name'),
        coordinates, routeRefs, osmUrl: `${OSM_URL}/node/${element.id}` });
    }
  }
  return { routes, stops, ...metadata(json, fetchedAt), partial };
}

/** Keep way members separate; a missing geometry point also breaks its segment. */
export function parseRouteResponse(json, { relationId, fetchedAt = new Date().toISOString() } = {}) {
  if (!validId(relationId)) throw fail('INVALID_ROUTE', 'Некорректный OSM ID маршрута.');
  const elements = elementsOf(json);
  const relation = elements.find((element) => element.type === 'relation' && element.id === relationId && element.tags?.route === 'bus');
  if (!relation || !Array.isArray(relation.members)) throw fail('INVALID_RESPONSE', 'Геометрия автобусного маршрута не найдена.');
  const features = [];
  let partial = false;
  for (const [memberIndex, member] of relation.members.entries()) {
    if (!member || typeof member !== 'object' || !validId(member.ref)) {
      throw fail('INVALID_RESPONSE', 'Некорректный участник маршрута OSM.');
    }
    const properties = { relationId, number: textTag(relation.tags, 'ref'), osmType: member.type,
      osmId: member.ref, osmUrl: `${OSM_URL}/${member.type}/${member.ref}`, role: typeof member.role === 'string' ? member.role : '' };
    if (member.type === 'way') {
      if (!Array.isArray(member.geometry)) { partial = true; continue; }
      let segment = [], segmentIndex = 0;
      const appendSegment = () => {
        if (segment.length >= 2) features.push({ type: 'Feature', id: `way-${member.ref}-${memberIndex}-${segmentIndex++}`,
          properties, geometry: { type: 'LineString', coordinates: segment } });
        segment = [];
      };
      for (const point of member.geometry) {
        const coordinates = [point?.lon, point?.lat];
        if (!validCoordinates(coordinates)) { partial = true; appendSegment(); }
        else segment.push(coordinates);
      }
      appendSegment();
    } else if (member.type === 'node' && /^(stop|platform)(_(entry|exit)_only)?$/.test(member.role || '')) {
      const coordinates = [member.lon, member.lat];
      if (!validCoordinates(coordinates)) { partial = true; continue; }
      features.push({ type: 'Feature', id: `node-${member.ref}-${memberIndex}`, properties, geometry: { type: 'Point', coordinates } });
    }
  }
  return { type: 'FeatureCollection', features, relationId, ...metadata(json, fetchedAt), partial };
}

export function createTransitClient({ fetcher = globalThis.fetch, timeoutMs = 20000, now = Date.now } = {}) {
  if (typeof fetcher !== 'function' || typeof now !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Некорректные параметры сервиса маршрутов.');
  }
  const cache = new Map(), requestTimes = new Map(), activeCityRequests = new Map();
  const abortError = () => fail('ABORTED', 'Запрос отменён.', { name: 'AbortError' });
  const checkAbort = (signal) => { if (signal?.aborted) throw abortError(); };

  async function request(query, signal) {
    checkAbort(signal);
    const controller = new AbortController();
    let timer, onAbort;
    const cancelled = new Promise((resolve, reject) => {
      onAbort = () => {
        const error = abortError();
        controller.abort(error);
        reject(error);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        const error = fail('TIMEOUT', 'Сервис маршрутов не ответил вовремя.', { name: 'TimeoutError' });
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    try {
      const response = await Promise.race([cancelled, (async () => {
        const reply = await fetcher(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ data: query }).toString(), signal: controller.signal, credentials: 'omit', cache: 'no-store' });
        if (!reply?.ok) throw fail('HTTP_ERROR', `Сервис маршрутов недоступен (HTTP ${Number(reply?.status) || 0}).`);
        try { return await reply.json(); }
        catch { throw fail('INVALID_RESPONSE', 'Сервис маршрутов вернул некорректный JSON.'); }
      })()]);
      checkAbort(signal);
      return response;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    async loadCity(city, { signal, force = false } = {}) {
      const query = buildCityQuery(city);
      checkAbort(signal);
      const key = JSON.stringify([city.id, ...city.center]);
      const timestamp = now();
      const cached = cache.get(key);
      if (!force && cached && timestamp >= cached.time && timestamp - cached.time < CACHE_TTL) {
        cache.delete(key);
        cache.set(key, cached);
        return structuredClone(cached.data);
      }
      const previous = requestTimes.get(key);
      if (previous !== undefined && timestamp - previous < REQUEST_INTERVAL) {
        throw fail('RATE_LIMITED', 'Повторный запрос доступен через несколько секунд.',
          { retryAfterMs: REQUEST_INTERVAL - Math.max(0, timestamp - previous) });
      }
      for (const [entryKey, time] of requestTimes) if (timestamp - time >= REQUEST_INTERVAL) requestTimes.delete(entryKey);
      requestTimes.set(key, timestamp);
      const requestToken = Symbol(key);
      activeCityRequests.set(key, requestToken);
      try {
        const json = await request(query, signal);
        checkAbort(signal);
        const fetchedAt = new Date(now()).toISOString();
        const data = parseTransitResponse(json, { city, fetchedAt });
        // An older slow refresh must not overwrite a newer successful refresh.
        if (activeCityRequests.get(key) === requestToken) {
          cache.delete(key);
          cache.set(key, { time: now(), data });
          while (cache.size > 10) cache.delete(cache.keys().next().value);
        }
        return structuredClone(data);
      } finally {
        if (activeCityRequests.get(key) === requestToken) activeCityRequests.delete(key);
      }
    },

    async loadRoute(relationId, { signal } = {}) {
      if (!validId(relationId)) throw fail('INVALID_ROUTE', 'Некорректный OSM ID маршрута.');
      const json = await request(`[out:json][timeout:18];relation(${relationId})["route"="bus"];out geom;`, signal);
      checkAbort(signal);
      return parseRouteResponse(json, { relationId, fetchedAt: new Date(now()).toISOString() });
    },
  };
}
