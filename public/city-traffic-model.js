// A bounded visual simulation on map road geometry. These are not live vehicles.
const EARTH_RADIUS_METERS = 6_371_008.8;
const TO_RADIANS = Math.PI / 180;
const MAX_ROUTES = 120;
const MAX_VEHICLES = 256;
const EXCLUDED_ROADS = /(?:^|[\s_:/-])(pedestrian|footway|cycleway|path|steps|rail|railway|tram|subway|platform|ferry|waterway|river)(?:$|[\s_:/-])/i;

const boundedLimit = (value, fallback, maximum) => Number.isFinite(value)
  ? Math.max(0, Math.min(maximum, Math.floor(value))) : fallback;
const isCoordinate = (point) => Array.isArray(point) && point.length >= 2
  && Number.isFinite(point[0]) && Number.isFinite(point[1])
  && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90;
const longitudeDelta = (from, to) => ((to - from + 540) % 360) - 180;
const wrapLongitude = (value) => ((value + 540) % 360) - 180;

function distanceBetween(a, b) {
  const latitudeDelta = (b[1] - a[1]) * TO_RADIANS;
  const longitude = longitudeDelta(a[0], b[0]) * TO_RADIANS;
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(a[1] * TO_RADIANS) * Math.cos(b[1] * TO_RADIANS) * Math.sin(longitude / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, haversine))));
}

function bearingBetween(a, b) {
  const longitude = longitudeDelta(a[0], b[0]) * TO_RADIANS;
  const fromLatitude = a[1] * TO_RADIANS;
  const toLatitude = b[1] * TO_RADIANS;
  const y = Math.sin(longitude) * Math.cos(toLatitude);
  const x = Math.cos(fromLatitude) * Math.sin(toLatitude)
    - Math.sin(fromLatitude) * Math.cos(toLatitude) * Math.cos(longitude);
  return (Math.atan2(y, x) / TO_RADIANS + 360) % 360;
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function routeFromLine(line, name, seen) {
  if (!Array.isArray(line) || line.length < 2 || line.length > 2048 || !line.every(isCoordinate)) return null;
  const coordinates = [];
  const cumulativeMeters = [0];
  let lengthMeters = 0;
  for (const point of line) {
    const previous = coordinates.at(-1);
    const segmentLength = previous ? distanceBetween(previous, point) : 0;
    if (previous && segmentLength < 0.1) continue;
    coordinates.push([point[0], point[1]]);
    if (previous) {
      lengthMeters += segmentLength;
      cumulativeMeters.push(lengthMeters);
    }
  }
  if (coordinates.length < 2 || lengthMeters <= 60) return null;
  // Rendered roads can appear in casing/fill layers and neighboring tiles.
  const points = coordinates.map(([lng, lat]) => `${lng.toFixed(5)},${lat.toFixed(5)}`);
  const forward = points.join(';');
  const reverse = [...points].reverse().join(';');
  const key = forward < reverse ? forward : reverse;
  if (seen.has(key)) return null;
  seen.add(key);
  return { id: `road-${hashString(key).toString(36)}`, name, coordinates, lengthMeters, cumulativeMeters };
}

export function buildTrafficRoutes(features, { limit = 30 } = {}) {
  const capacity = boundedLimit(limit, 30, MAX_ROUTES);
  const routes = [];
  const seen = new Set();
  if (!Array.isArray(features) || !capacity) return routes;
  for (const feature of features.slice(0, 6000)) {
    const properties = feature?.properties || {};
    const tags = [properties.class, properties.subclass, properties.highway, properties.type,
      feature?.sourceLayer, feature?.layer?.['source-layer'], feature?.layer?.id].filter(Boolean).join(' ');
    if (EXCLUDED_ROADS.test(tags) || properties.motor_vehicle === 'no' || properties.access === 'no') continue;
    const geometry = feature?.geometry;
    const lines = geometry?.type === 'LineString' ? [geometry.coordinates]
      : geometry?.type === 'MultiLineString' && Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
    const name = String(properties['name:ru'] || properties.name || properties.ref || 'Городская улица').slice(0, 120);
    for (const line of lines.slice(0, 128)) {
      const route = routeFromLine(line, name, seen);
      if (route) routes.push(route);
      if (routes.length >= capacity) return routes;
    }
  }
  return routes;
}

export function sampleRoute(route, distanceMeters = 0) {
  const coordinates = route?.coordinates;
  const cumulative = route?.cumulativeMeters;
  const length = route?.lengthMeters;
  if (!Array.isArray(coordinates) || coordinates.length < 2 || !Array.isArray(cumulative)
    || cumulative.length !== coordinates.length || !Number.isFinite(length) || length <= 0
    || cumulative[0] !== 0 || cumulative.at(-1) !== length) return null;
  const distance = Number.isFinite(distanceMeters) ? distanceMeters : 0;
  const cycle = length * 2;
  const phase = ((distance % cycle) + cycle) % cycle;
  const reverse = phase >= length;
  const along = reverse ? cycle - phase : phase;
  let low = 0;
  let high = coordinates.length - 1;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (cumulative[middle] <= along) low = middle;
    else high = middle;
  }
  if (reverse && low > 0 && cumulative[low] === along) low -= 1;
  const start = coordinates[low];
  const end = coordinates[low + 1];
  const segmentLength = cumulative[low + 1] - cumulative[low];
  if (!isCoordinate(start) || !isCoordinate(end) || !Number.isFinite(segmentLength) || segmentLength <= 0) return null;
  const fraction = Math.min(1, Math.max(0, (along - cumulative[low]) / segmentLength));
  return {
    coordinates: [wrapLongitude(start[0] + longitudeDelta(start[0], end[0]) * fraction),
      start[1] + (end[1] - start[1]) * fraction],
    bearing: reverse ? bearingBetween(end, start) : bearingBetween(start, end),
  };
}

export function createFleet(routes, { limit = 64 } = {}) {
  const capacity = boundedLimit(limit, 64, MAX_VEHICLES);
  const available = Array.isArray(routes) ? routes.slice(0, MAX_ROUTES).filter((route) => sampleRoute(route, 0)) : [];
  const fleet = [];
  if (!available.length || !capacity) return fleet;
  // Allocate fairly across streets before adding extra vehicles to long roads.
  for (let round = 0; round < 8 && fleet.length < capacity; round += 1) {
    for (const route of available) {
      if (round >= Math.min(8, Math.max(2, Math.floor(route.lengthMeters / 180)))) continue;
      const seed = hashString(`${route.id}:${round}`);
      const kind = seed % 7 === 0 ? 'bus' : 'car';
      fleet.push({
        id: `vehicle-${route.id}-${round}`,
        routeId: route.id,
        kind,
        speedKph: kind === 'bus' ? 22 + seed % 13 : 28 + seed % 19,
        offsetMeters: (seed / 4294967296) * route.lengthMeters * 2,
      });
      if (fleet.length >= capacity) break;
    }
  }
  return fleet;
}

export function sampleTraffic(routes, fleet, elapsedSeconds = 0) {
  const routeIndex = new Map((Array.isArray(routes) ? routes.slice(0, MAX_ROUTES) : []).map((route) => [route?.id, route]));
  const elapsed = Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0;
  const features = [];
  for (const vehicle of (Array.isArray(fleet) ? fleet.slice(0, MAX_VEHICLES) : [])) {
    const route = routeIndex.get(vehicle?.routeId);
    if (!route || !Number.isFinite(vehicle?.speedKph) || vehicle.speedKph < 0 || !Number.isFinite(vehicle?.offsetMeters)) continue;
    const sample = sampleRoute(route, vehicle.offsetMeters + elapsed * vehicle.speedKph / 3.6);
    if (!sample) continue;
    features.push({
      type: 'Feature',
      id: vehicle.id,
      geometry: { type: 'Point', coordinates: sample.coordinates },
      properties: { id: vehicle.id, kind: vehicle.kind, speedKph: vehicle.speedKph,
        routeName: route.name, bearing: sample.bearing, routeId: route.id },
    });
  }
  return { type: 'FeatureCollection', features };
}
