import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrafficRoutes, sampleRoute, createFleet, sampleTraffic } from '../public/city-traffic-model.js';

const road = (coordinates = [[71.4, 51.1], [71.41, 51.1]], properties = {}) => ({
  type: 'Feature', properties: { class: 'primary', name: 'Тестовая улица', ...properties },
  geometry: { type: 'LineString', coordinates },
});
const close = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} ≈ ${expected}`);

test('routes use valid roads, reject malformed paths, and remove duplicate layer geometry', () => {
  const original = road();
  const duplicate = { ...road([...original.geometry.coordinates].reverse()), layer: { id: 'road-casing' } };
  const features = [original, duplicate, road(undefined, { class: 'path' }), road(undefined, { class: 'rail' }),
    road(undefined, { subclass: 'pedestrian' }), road(undefined, { motor_vehicle: 'no' }),
    road([[71.4, 51.1], [NaN, 51.2]]), road([[Infinity, 51], [71, 52]]),
    road([[181, 51], [71, 52]]), road([[71, 91], [71, 52]]), road([[71, 51]]),
    road([[71, 51], [71, 51]]), road([[71, 51], [71.00001, 51]]), null];
  const routes = buildTrafficRoutes(features);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].name, 'Тестовая улица');
  assert.ok(routes[0].lengthMeters > 600 && routes[0].lengthMeters < 800);
  assert.equal(routes[0].cumulativeMeters.at(-1), routes[0].lengthMeters);
  assert.deepEqual(buildTrafficRoutes(null), []);
});

test('MultiLineString segments remain separate routes and repeated points are collapsed', () => {
  const routes = buildTrafficRoutes([{ ...road(), geometry: { type: 'MultiLineString', coordinates: [
    [[0, 0], [0, 0], [0.002, 0]], [[0, 1], [0.002, 1]], [[0, 0]],
  ] } }]);
  assert.equal(routes.length, 2);
  assert.equal(routes[0].coordinates.length, 2);
  assert.equal(routes[0].cumulativeMeters.length, 2);
  assert.notEqual(routes[0].id, routes[1].id);
});

test('distance sampling moves out and back without teleporting and points with travel direction', () => {
  const [route] = buildTrafficRoutes([road([[0, 0], [0.01, 0]])]);
  const length = route.lengthMeters;
  const forward = sampleRoute(route, length * 0.25);
  const backward = sampleRoute(route, length * 1.75);
  close(forward.coordinates[0], 0.0025);
  close(backward.coordinates[0], 0.0025);
  close(forward.bearing, 90);
  close(backward.bearing, 270);
  close(sampleRoute(route, length).coordinates[0], 0.01);
  close(sampleRoute(route, length * 2).coordinates[0], 0);
  close(sampleRoute(route, length - 0.1).coordinates[0], sampleRoute(route, length + 0.1).coordinates[0]);
  close(sampleRoute(route, -length * 0.25).coordinates[0], 0.0025);
  close(sampleRoute(route, length * 100.25).coordinates[0], forward.coordinates[0]);
});

test('bearing follows both directions around a corner and north is zero', () => {
  const [route] = buildTrafficRoutes([road([[0, 0], [0, 0.01], [0.01, 0.01]])]);
  const firstLength = route.cumulativeMeters[1];
  close(sampleRoute(route, firstLength / 2).bearing, 0);
  close(sampleRoute(route, firstLength + (route.lengthMeters - firstLength) / 2).bearing, 90, 0.01);
  close(sampleRoute(route, route.lengthMeters * 2 - firstLength / 2).bearing, 180);
  close(sampleRoute(route, route.lengthMeters * 2 - firstLength).bearing, 180);
});

test('antimeridian interpolation remains on the short road and all samples are finite', () => {
  const [route] = buildTrafficRoutes([road([[179.999, 10], [-179.999, 10]])]);
  assert.ok(route.lengthMeters < 300);
  const sample = sampleRoute(route, route.lengthMeters / 2);
  close(Math.abs(sample.coordinates[0]), 180);
  for (const distance of [0, -100, Infinity, NaN, 1e12]) {
    const value = sampleRoute(route, distance);
    assert.ok(value.coordinates.every(Number.isFinite));
    assert.ok(Number.isFinite(value.bearing));
  }
});

test('invalid and degenerate routes cannot emit invalid points', () => {
  for (const route of [null, {}, { coordinates: [] },
    { coordinates: [[0, 0], [0, 0]], cumulativeMeters: [0, 0], lengthMeters: 0 },
    { coordinates: [[0, 0], [NaN, 1]], cumulativeMeters: [0, 100], lengthMeters: 100 },
    { coordinates: [[0, 0], [1, 0]], cumulativeMeters: [0, Infinity], lengthMeters: Infinity }]) {
    assert.equal(sampleRoute(route, 10), null);
  }
  assert.deepEqual(createFleet([]), []);
  assert.deepEqual(sampleTraffic([], [], 0), { type: 'FeatureCollection', features: [] });
});

test('fleet creation is deterministic, capped, and creates plausible synthetic speeds', () => {
  const features = Array.from({ length: 200 }, (_, i) => road([[i / 100, 0], [i / 100, 0.02]]));
  assert.equal(buildTrafficRoutes(features).length, 30);
  assert.equal(buildTrafficRoutes(features, { limit: 4 }).length, 4);
  assert.equal(buildTrafficRoutes(features, { limit: 0 }).length, 0);
  const routes = buildTrafficRoutes(features, { limit: 1e6 });
  assert.ok(routes.length <= 120);
  const fleet = createFleet(routes);
  assert.equal(fleet.length, 64);
  assert.deepEqual(createFleet(routes), fleet);
  assert.equal(createFleet(routes, { limit: 5 }).length, 5);
  assert.equal(createFleet(routes, { limit: 0 }).length, 0);
  assert.ok(createFleet(routes, { limit: 1e6 }).length <= 256);
  assert.equal(new Set(fleet.map((vehicle) => vehicle.id)).size, fleet.length);
  assert.ok(fleet.some((vehicle) => vehicle.kind === 'bus'));
  assert.ok(fleet.every((vehicle) => ['car', 'bus'].includes(vehicle.kind) && vehicle.speedKph >= 22 && vehicle.speedKph <= 46));
});

test('traffic accepts elapsed zero, moves at configured speed, and provides symbol properties', () => {
  const routes = buildTrafficRoutes([road([[0, 0], [0.01, 0]])]);
  const fleet = [{ id: 'car-1', routeId: routes[0].id, kind: 'car', speedKph: 36, offsetMeters: 0 }];
  const initial = sampleTraffic(routes, fleet, 0);
  const moved = sampleTraffic(routes, fleet, 10);
  assert.equal(initial.features[0].id, 'car-1');
  assert.deepEqual(initial.features[0].geometry, { type: 'Point', coordinates: [0, 0] });
  close(moved.features[0].geometry.coordinates[0], sampleRoute(routes[0], 100).coordinates[0]);
  assert.deepEqual(initial.features[0].properties, {
    id: 'car-1', routeId: routes[0].id, kind: 'car', speedKph: 36, routeName: 'Тестовая улица', bearing: 90,
  });
  assert.equal(sampleTraffic(routes, [{ ...fleet[0], routeId: 'missing' }], 0).features.length, 0);
  assert.equal(sampleTraffic(routes, [{ ...fleet[0], speedKph: NaN }], 0).features.length, 0);
});

test('route building and animation do not mutate caller-owned inputs', () => {
  const features = [road([[0, 0], [0, 0], [0.01, 0]])];
  const originalFeatures = structuredClone(features);
  const routes = buildTrafficRoutes(features);
  const originalRoutes = structuredClone(routes);
  const fleet = createFleet(routes);
  const originalFleet = structuredClone(fleet);
  const sampled = sampleTraffic(routes, fleet, 123);
  sampled.features[0].geometry.coordinates[0] = 90;
  assert.deepEqual(features, originalFeatures);
  assert.deepEqual(routes, originalRoutes);
  assert.deepEqual(fleet, originalFleet);
  routes[0].coordinates[0][0] = 80;
  assert.deepEqual(features, originalFeatures);
});
