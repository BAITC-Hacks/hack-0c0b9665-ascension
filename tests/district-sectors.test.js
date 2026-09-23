import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DISTRICT_ANCHORS } from '../public/places.js';
import { DISTRICT_COLORS, DISTRICT_SECTOR_OUTLINE, DISTRICT_SECTORS, DISTRICT_BOUNDS, sectorBounds } from '../public/district-sectors.js';

const dataset = JSON.parse(readFileSync(new URL('../data/city.json', import.meta.url), 'utf8'));
const cross = (a, b, point) => (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
const area = (ring) => {
  if (ring.length < 3) return 0;
  const origin = ring[0];
  return ring.reduce((sum, point, index) => sum + cross(origin, point, ring[(index + 1) % ring.length]), 0) / 2;
};
const contains = (ring, point) => ring.slice(0, -1).every((a, index) => cross(a, ring[index + 1], point) >= -1e-11);

// Independent convex polygon intersection: clip by the actual output edges,
// rather than reusing the generator's anchor distances or bisectors.
function intersection(subject, clipRing) {
  let output = subject.slice(0, -1);
  for (let edge = 0; edge < clipRing.length - 1; edge++) {
    const input = output;
    output = [];
    const a = clipRing[edge], b = clipRing[edge + 1];
    for (let index = 0; index < input.length; index++) {
      const point = input[index], previous = input[(index + input.length - 1) % input.length];
      const distance = cross(a, b, point), previousDistance = cross(a, b, previous);
      if ((distance >= 0) !== (previousDistance >= 0)) {
        const fraction = previousDistance / (previousDistance - distance);
        output.push([previous[0] + fraction * (point[0] - previous[0]), previous[1] + fraction * (point[1] - previous[1])]);
      }
      if (distance >= 0) output.push(point);
    }
  }
  return output;
}

test('sectors expose exactly the five dataset districts and distinct stable colors', () => {
  const expected = dataset.districts.map(district => district.id).sort();
  assert.equal(DISTRICT_SECTORS.type, 'FeatureCollection');
  assert.deepEqual(DISTRICT_SECTORS.features.map(feature => feature.id).sort(), expected);
  assert.deepEqual(Object.keys(DISTRICT_COLORS).sort(), expected);
  assert.equal(new Set(Object.values(DISTRICT_COLORS)).size, expected.length);
  for (const feature of DISTRICT_SECTORS.features) {
    assert.equal(feature.type, 'Feature');
    assert.equal(typeof feature.id, 'string');
    assert.equal(feature.properties.districtId, feature.id);
    assert.equal(feature.properties.color, DISTRICT_COLORS[feature.id]);
    assert.match(feature.properties.color, /^#[0-9a-f]{6}$/);
  }
});

test('each sector is a closed nondegenerate convex Polygon containing its anchor', () => {
  for (const feature of DISTRICT_SECTORS.features) {
    assert.equal(feature.geometry.type, 'Polygon');
    assert.equal(feature.geometry.coordinates.length, 1);
    const [ring] = feature.geometry.coordinates;
    assert.ok(ring.length >= 4, feature.id);
    assert.deepEqual(ring[0], ring.at(-1), feature.id);
    assert.ok(ring.flat().every(Number.isFinite), feature.id);
    assert.equal(new Set(ring.slice(0, -1).map(point => point.join(','))).size, ring.length - 1);
    assert.ok(area(ring) > 0.0001, `${feature.id}: nonzero counterclockwise area`);
    for (let index = 0; index < ring.length - 1; index++) {
      assert.ok(cross(ring[index], ring[index + 1], ring[(index + 2) % (ring.length - 1)]) >= -1e-11, `${feature.id}: convex ring`);
    }
    assert.ok(contains(ring, DISTRICT_ANCHORS[feature.id]), `${feature.id}: contains anchor`);
    assert.ok(ring.every(point => contains(DISTRICT_SECTOR_OUTLINE, point)), `${feature.id}: stays inside display outline`);
  }
});

test('sectors exactly cover the display outline with no double-counted area', () => {
  const rings = DISTRICT_SECTORS.features.map(feature => feature.geometry.coordinates[0]);
  assert.ok(Math.abs(rings.reduce((sum, ring) => sum + area(ring), 0) - area(DISTRICT_SECTOR_OUTLINE)) < 1e-11);
  for (let first = 0; first < rings.length; first++) {
    for (let second = first + 1; second < rings.length; second++) {
      assert.ok(Math.abs(area(intersection(rings[first], rings[second]))) < 1e-11, `sectors ${first} and ${second} do not overlap`);
    }
  }
});

test('fitBounds covers each complete sector and rejects unrelated IDs', () => {
  assert.deepEqual(DISTRICT_BOUNDS, [[71.29, 51.07], [71.57, 51.24]]);
  for (const feature of DISTRICT_SECTORS.features) {
    const bounds = sectorBounds(feature.id);
    const [[west, south], [east, north]] = bounds;
    assert.ok(west < east && south < north);
    for (const [longitude, latitude] of feature.geometry.coordinates[0]) {
      assert.ok(longitude >= west && longitude <= east && latitude >= south && latitude <= north);
    }
    bounds[0][0] = 0;
    assert.notDeepEqual(sectorBounds(feature.id), bounds, 'callers cannot mutate later bounds');
  }
  assert.equal(sectorBounds('unknown'), null);
  assert.equal(sectorBounds('__proto__'), null);
});
