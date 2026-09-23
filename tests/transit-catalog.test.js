import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ASTANA_ROUTES } from '../public/transit-catalog.js';
import { routeCatalog, matchingStops, transitBounds } from '../public/transit-panel.js';

test('screenshot catalogue includes all 127 unique routes and preserves incomplete endpoints', () => {
  assert.equal(ASTANA_ROUTES.length, 127);
  assert.equal(new Set(ASTANA_ROUTES.map((r) => r.number)).size, 127);
  for (const number of ['1', '4А', '15А', '22А', '24Н', '29А', '49', '52', '55А', '55Б', '120А', '307А', '310', '504', '508', '701']) {
    assert.ok(ASTANA_ROUTES.some((r) => r.number === number), number);
  }
  assert.equal(ASTANA_ROUTES.filter((r) => r.endpointStatus === 'truncated').length, 25);
  assert.equal(ASTANA_ROUTES.find((r) => r.number === '49').to, '');
  assert.ok(ASTANA_ROUTES.every((r) => r.screenshot && !Object.hasOwn(r, 'coordinates')));
});

test('city inventories cannot inherit Astana catalogue and do not overwrite screenshot facts', () => {
  const routes = [{ id: 1, number: '15A', from: 'OSM from', to: 'OSM to' }, { id: 2, number: '15А', from: 'reverse', to: 'direction' }];
  const astana = routeCatalog({ id: 'astana' }, { routes });
  const route = astana.find((r) => r.number === '15А');
  assert.equal(astana.length, 127);
  assert.equal(route.relations.length, 2);
  assert.equal(route.endpointStatus, 'truncated');
  assert.notEqual(route.from, 'OSM from');
  assert.deepEqual(routeCatalog({ id: 'almaty-city' }, null), []);
  assert.equal(routeCatalog({ id: 'almaty-city' }, { routes }).length, 1);
});

test('route-stop association requires an explicit OSM tag and never a nearby coordinate', () => {
  const stops = [{ id: 1, routeRefs: ['15A'] }, { id: 2, routeRefs: ['15'] }, { id: 3, routeRefs: [] }];
  assert.deepEqual(matchingStops(stops, '15А').map((s) => s.id), [1]);
  assert.deepEqual(matchingStops(stops, '52'), []);
});

test('map bounds use bounded iteration without argument expansion for large geometries', () => {
  const coordinates = Array.from({ length: 150000 }, (_, i) => [71 + i / 1000000, 51 + i / 1000000]);
  const bounds = transitBounds({ features: [{ geometry: { type: 'LineString', coordinates } }] });
  assert.deepEqual(bounds, [[71, 51], coordinates.at(-1)]);
  assert.equal(transitBounds({ features: [] }), null);
});

test('bundled stop snapshot carries real OSM identifiers, source and date without GPS vehicles', async () => {
  const data = JSON.parse(await readFile(new URL('../public/transit-astana-stops.json', import.meta.url), 'utf8'));
  assert.equal(data.stops.length, 966);
  assert.equal(new Set(data.stops.map((s) => s.id)).size, 966);
  assert.equal(data.routes.length, 0);
  assert.equal(data.osmTimestamp, '2026-09-22T08:45:51Z');
  assert.equal(data.license, 'ODbL-1.0');
  assert.ok(data.stops.every((s) => s.coordinates[0] > 71 && s.coordinates[0] < 72 && s.coordinates[1] > 50.9 && s.coordinates[1] < 51.4));
  assert.ok(!Object.hasOwn(data, 'vehicles'));
});
