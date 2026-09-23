import { DISTRICT_ANCHORS } from './places.js';

// These are conceptual sectors for the five-district demo, NOT administrative
// boundaries. The hand-drawn display outline below is partitioned by the demo
// anchors' Voronoi cells. No cadastral or official boundary data is implied.
export const DISTRICT_COLORS = Object.freeze({
  esil: '#218e83',
  almaty: '#4286c5',
  saryarka: '#c18a29',
  baikonur: '#8b6bb7',
  nura: '#d77968',
});

// Counterclockwise, closed, convex display outline around the Astana demo.
export const DISTRICT_SECTOR_OUTLINE = [
  [71.290, 51.105], [71.325, 51.078], [71.410, 51.070],
  [71.505, 51.083], [71.560, 51.130], [71.570, 51.190],
  [71.500, 51.235], [71.400, 51.240], [71.330, 51.215],
  [71.295, 51.165], [71.290, 51.105],
];

// A local equirectangular projection makes east/west and north/south distances
// comparable. This is sufficient for visual sectors over this small demo area.
const LONGITUDE_SCALE = Math.cos(51.15 * Math.PI / 180);
const project = ([longitude, latitude]) => [(longitude - 71.43) * LONGITUDE_SCALE, latitude - 51.15];
const unproject = ([x, y]) => [x / LONGITUDE_SCALE + 71.43, y + 51.15];

// Clip a convex polygon to the half-plane nearest to the supplied anchor.
// All cells use the same perpendicular bisectors, so edges meet without gaps.
function clipToAnchor(polygon, anchor, neighbor) {
  const dx = neighbor[0] - anchor[0];
  const dy = neighbor[1] - anchor[1];
  const midpoint = [(anchor[0] + neighbor[0]) / 2, (anchor[1] + neighbor[1]) / 2];
  const distance = ([x, y]) => (x - midpoint[0]) * dx + (y - midpoint[1]) * dy;
  const clipped = [];
  for (let index = 0; index < polygon.length; index++) {
    const current = polygon[index];
    const previous = polygon[(index + polygon.length - 1) % polygon.length];
    const currentDistance = distance(current);
    const previousDistance = distance(previous);
    const currentInside = currentDistance <= 1e-12;
    const previousInside = previousDistance <= 1e-12;
    if (currentInside !== previousInside) {
      const ratio = previousDistance / (previousDistance - currentDistance);
      clipped.push([
        previous[0] + ratio * (current[0] - previous[0]),
        previous[1] + ratio * (current[1] - previous[1]),
      ]);
    }
    if (currentInside) clipped.push(current);
  }
  return clipped;
}

function boundsFor(coordinates) {
  return [
    [Math.min(...coordinates.map(point => point[0])), Math.min(...coordinates.map(point => point[1]))],
    [Math.max(...coordinates.map(point => point[0])), Math.max(...coordinates.map(point => point[1]))],
  ];
}

export const DISTRICT_SECTORS = {
  type: 'FeatureCollection',
  features: Object.entries(DISTRICT_COLORS).map(([districtId, color]) => {
    const anchor = project(DISTRICT_ANCHORS[districtId]);
    let polygon = DISTRICT_SECTOR_OUTLINE.slice(0, -1).map(project);
    for (const [neighborId, coordinates] of Object.entries(DISTRICT_ANCHORS)) {
      if (neighborId !== districtId) polygon = clipToAnchor(polygon, anchor, project(coordinates));
    }
    const ring = polygon.map(unproject);
    ring.push([...ring[0]]);
    return {
      type: 'Feature',
      id: districtId,
      properties: { districtId, color },
      geometry: { type: 'Polygon', coordinates: [ring] },
    };
  }),
};

// MapLibre fitBounds accepts these southwest / northeast coordinate pairs.
export const DISTRICT_BOUNDS = boundsFor(DISTRICT_SECTOR_OUTLINE);

/** Bounds for a known sector, or null when the dataset ID is not in this demo. */
export function sectorBounds(districtId) {
  const feature = DISTRICT_SECTORS.features.find(item => item.id === districtId);
  return feature ? boundsFor(feature.geometry.coordinates[0]) : null;
}
