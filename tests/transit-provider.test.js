import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCityQuery, normalizeRouteNumber, parseTransitResponse, parseRouteResponse, createTransitClient } from '../public/transit-provider.js';

const city = { id: 'astana', kind: 'city', center: [71.4304, 51.147] };
const timestamp = '2026-09-23T11:20:00Z';
const envelope = (elements = []) => ({ elements, osm3s: { timestamp_osm_base: timestamp } });
const reply = (json = envelope()) => ({ ok: true, json: async () => json });
const stop = (id = 1, extra = {}) => ({ type: 'node', id, lon: 71.43, lat: 51.15, tags: { highway: 'bus_stop', name: 'Остановка' }, ...extra });
const route = (id = 20, extra = {}) => ({ type: 'relation', id, tags: { route: 'bus', ref: '55Б', from: 'A', to: 'B', name: 'Автобус 55Б' }, ...extra });
const geometry = envelope([route(20, { members: [
  { type: 'way', ref: 31, role: '', geometry: [{ lon: 71.4, lat: 51.1 }, { lon: 71.41, lat: 51.11 }] },
  { type: 'way', ref: 32, role: '', geometry: [{ lon: 71.5, lat: 51.2 }, { lon: 71.51, lat: 51.21 }] },
  { type: 'node', ref: 33, role: 'stop', lon: 71.4, lat: 51.1 },
  { type: 'node', ref: 34, role: 'platform_exit_only', lon: 71.5, lat: 51.2 },
  { type: 'node', ref: 35, role: 'label', lon: 71.6, lat: 51.3 },
] })]);

test('route normalization preserves distinct Cyrillic Б and В variants', () => {
  assert.equal(normalizeRouteNumber(' 307a '), '307А');
  assert.equal(normalizeRouteNumber('24H'), '24Н');
  assert.equal(normalizeRouteNumber('55B'), '55В');
  assert.equal(normalizeRouteNumber('55Б'), '55Б');
  assert.notEqual(normalizeRouteNumber('55B'), normalizeRouteNumber('55Б'));
});

test('queries use only a bounded city box and do not interpolate city names', () => {
  const query = buildCityQuery({ ...city, id: '";out geom;', name: '";out geom;' });
  assert.equal((query.match(/50\.967,71\.1504,51\.327,71\.7104/g) || []).length, 3);
  assert.match(query, /node\["public_transport"="platform"\]\["bus"="yes"\]/);
  assert.match(query, /relation\["route"="bus"\]/);
  assert.ok(query.endsWith('out body;'));
  assert.doesNotMatch(query, /out geom|area\(/);
  for (const invalid of [null, { ...city, kind: 'country' }, { ...city, kind: 'region' }, { ...city, center: [NaN, 51] },
    { ...city, center: ['71', 51] }, { ...city, center: [71, 91] }, { ...city, id: '' }]) {
    assert.throws(() => buildCityQuery(invalid), { code: 'INVALID_CITY' });
  }
});

test('city parsing preserves source, IDs, lon/lat, route metadata and valid stop associations', () => {
  const data = parseTransitResponse(envelope([
    stop(10, { tags: { highway: 'bus_stop', 'name:ru': 'Площадь', name: 'Square', route_ref: '10;55Б;55B,307a;24H;bad token;10' } }),
    stop(10), stop(11, { lon: 76.945 }), route(20), route(20),
    stop(12, { tags: { public_transport: 'platform', bus: 'yes', name: 'Платформа' } }),
    stop(13, { tags: { public_transport: 'platform', train: 'yes' } }),
  ]), { city, fetchedAt: timestamp });
  assert.equal(data.routes.length, 1);
  assert.deepEqual(data.routes[0], { id: 20, number: '55Б', from: 'A', to: 'B', name: 'Автобус 55Б', osmUrl: 'https://www.openstreetmap.org/relation/20' });
  assert.equal(data.stops.length, 2);
  assert.deepEqual(data.stops[0], { id: 10, name: 'Площадь', coordinates: [71.43, 51.15], routeRefs: ['10', '55Б', '55В', '307А', '24Н'], osmUrl: 'https://www.openstreetmap.org/node/10' });
  assert.equal(data.source, 'OpenStreetMap / Overpass');
  assert.equal(data.fetchedAt, timestamp);
  assert.equal(data.osmTimestamp, timestamp);
  assert.equal(data.partial, false);
});

test('city parsing caps output and identifies truncated inventories', () => {
  const data = parseTransitResponse(envelope([
    ...Array.from({ length: 1501 }, (_, index) => stop(index + 1)),
    ...Array.from({ length: 501 }, (_, index) => route(index + 1)),
  ]), { city });
  assert.equal(data.stops.length, 1500);
  assert.equal(data.routes.length, 500);
  assert.equal(data.partial, true);
});

test('malformed payloads and Overpass partial-error responses fail visibly', () => {
  for (const json of [null, {}, { elements: {} }, { elements: [null] }, { elements: [{}] },
    envelope([stop(1, { lon: NaN })]), envelope([stop(1, { tags: [] })]), envelope([route('20')])]) {
    assert.throws(() => parseTransitResponse(json, { city }), { code: 'INVALID_RESPONSE' });
  }
  assert.throws(() => parseTransitResponse({ ...envelope([stop()]), remark: 'runtime error: timeout' }, { city }), { code: 'UPSTREAM_ERROR' });
  assert.deepEqual(parseTransitResponse(envelope(), { city }).stops, []);
});

test('route geometries preserve separate ways and include only stop/platform nodes', () => {
  const data = parseRouteResponse(geometry, { relationId: 20, fetchedAt: timestamp });
  assert.equal(data.type, 'FeatureCollection');
  assert.equal(data.features.length, 4);
  assert.deepEqual(data.features.map((feature) => feature.geometry.type), ['LineString', 'LineString', 'Point', 'Point']);
  assert.deepEqual(data.features[0].geometry.coordinates, [[71.4, 51.1], [71.41, 51.11]]);
  assert.deepEqual(data.features[1].geometry.coordinates, [[71.5, 51.2], [71.51, 51.21]]);
  assert.equal(data.features[0].properties.osmId, 31);
  assert.equal(data.features[0].properties.osmUrl, 'https://www.openstreetmap.org/way/31');
  assert.equal(data.osmTimestamp, timestamp);
  assert.equal(data.partial, false);
  assert.throws(() => parseRouteResponse(geometry, { relationId: 21 }), { code: 'INVALID_RESPONSE' });
});

test('missing geometry breaks line segments instead of drawing artificial connections', () => {
  const data = parseRouteResponse(envelope([route(20, { members: [{ type: 'way', ref: 31, geometry: [
    { lon: 71, lat: 51 }, { lon: 71.1, lat: 51.1 }, null, { lon: 72, lat: 52 }, { lon: 72.1, lat: 52.1 },
  ] }, { type: 'way', ref: 32 }] })]), { relationId: 20 });
  assert.equal(data.features.length, 2);
  assert.deepEqual(data.features.map((feature) => feature.geometry.coordinates.length), [2, 2]);
  assert.equal(data.partial, true);
});

test('client posts form data without credentials, caches isolated copies and rate-limits force', async () => {
  const calls = [];
  let clock = Date.parse(timestamp);
  const client = createTransitClient({ now: () => clock, fetcher: async (...args) => { calls.push(args); return reply(envelope([stop()])); } });
  assert.equal(calls.length, 0, 'construction makes no network requests');
  const first = await client.loadCity(city);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://overpass-api.de/api/interpreter');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(calls[0][1].credentials, 'omit');
  assert.equal(new URLSearchParams(calls[0][1].body).get('data'), buildCityQuery(city));
  first.stops[0].coordinates[0] = 0;
  assert.equal((await client.loadCity(city)).stops[0].coordinates[0], 71.43);
  assert.equal(calls.length, 1);
  await assert.rejects(client.loadCity(city, { force: true }), { code: 'RATE_LIMITED', retryAfterMs: 15000 });
  clock += 15000;
  await client.loadCity(city, { force: true });
  assert.equal(calls.length, 2);
  clock += 10 * 60 * 1000;
  await client.loadCity(city);
  assert.equal(calls.length, 3);
});

test('cache identity includes coordinates and evicts beyond ten cities', async () => {
  let calls = 0, clock = Date.parse(timestamp);
  const client = createTransitClient({ now: () => clock, fetcher: async () => { calls++; return reply(); } });
  await client.loadCity(city);
  await client.loadCity({ ...city, center: [71.5, 51.15] });
  for (let index = 0; index < 9; index++) await client.loadCity({ ...city, id: `city-${index}` });
  assert.equal(calls, 11);
  clock += 15000;
  await client.loadCity(city);
  assert.equal(calls, 12);
});

test('caller cancellation aborts the request and late completion cannot populate cache', async () => {
  let calls = 0, clock = Date.parse(timestamp), finish, requestSignal;
  const client = createTransitClient({ now: () => clock, fetcher: async (url, options) => {
    calls++; requestSignal = options.signal;
    if (calls === 1) return new Promise((resolve) => { finish = resolve; });
    return reply();
  } });
  const controller = new AbortController();
  const pending = client.loadCity(city, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError', code: 'ABORTED' });
  assert.equal(requestSignal.aborted, true);
  finish(reply(envelope([stop()])));
  clock += 15000;
  assert.deepEqual((await client.loadCity(city)).stops, []);
  assert.equal(calls, 2);
  await assert.rejects(client.loadCity(city, { signal: controller.signal }), { code: 'ABORTED' });
  assert.equal(calls, 2);
});

test('timeout settles even with a fetch implementation that ignores abort', async () => {
  let signal;
  const client = createTransitClient({ timeoutMs: 10, fetcher: async (url, options) => { signal = options.signal; return new Promise(() => {}); } });
  await assert.rejects(client.loadCity(city), { code: 'TIMEOUT', name: 'TimeoutError' });
  assert.equal(signal.aborted, true);
});

test('separate operations do not cancel each other; route lookup rejects unsafe IDs', async () => {
  const controller = new AbortController();
  const client = createTransitClient({ fetcher: async (url, options) => {
    if (new URLSearchParams(options.body).get('data').includes('relation(20)')) return reply(geometry);
    return new Promise(() => {});
  } });
  const pendingCity = client.loadCity(city, { signal: controller.signal });
  const found = await client.loadRoute(20);
  assert.equal(found.features.length, 4);
  controller.abort();
  await assert.rejects(pendingCity, { code: 'ABORTED' });
  for (const id of ['20', '20);node;', -1, 1.2, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(client.loadRoute(id), { code: 'INVALID_ROUTE' });
  }
});

test('HTTP, JSON and Overpass errors never become cached success', async () => {
  let clock = Date.parse(timestamp), calls = 0;
  const responses = [{ ok: false, status: 429 }, { ok: true, json: async () => { throw new SyntaxError(); } },
    reply({ ...envelope(), remark: 'runtime error' }), reply(envelope([stop()]))];
  const client = createTransitClient({ now: () => clock, fetcher: async () => responses[calls++] });
  for (const code of ['HTTP_ERROR', 'INVALID_RESPONSE', 'UPSTREAM_ERROR']) {
    await assert.rejects(client.loadCity(city), { code });
    clock += 15000;
  }
  assert.equal((await client.loadCity(city)).stops.length, 1);
  assert.equal(calls, 4);
});

test('a slow old response cannot replace a newer force refresh in cache', async () => {
  let clock = Date.parse(timestamp), calls = 0, finish;
  const client = createTransitClient({ now: () => clock, fetcher: async () => {
    calls++;
    if (calls === 1) return new Promise((resolve) => { finish = resolve; });
    return reply(envelope([stop(2)]));
  } });
  const older = client.loadCity(city);
  clock += 15000;
  assert.equal((await client.loadCity(city, { force: true })).stops[0].id, 2);
  finish(reply(envelope([stop(1)])));
  assert.equal((await older).stops[0].id, 1);
  assert.equal((await client.loadCity(city)).stops[0].id, 2);
  assert.equal(calls, 2);
});
