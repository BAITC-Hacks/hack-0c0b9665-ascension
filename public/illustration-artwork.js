/** Decorative artwork only. Labels, values, routes and application state stay with the UI. */
export const ARTWORK_BASE = '/assets/illustrations/';
const asset = name => `${ARTWORK_BASE}${name}.webp`;

// Map by initiative ID, not direction: every initiative has its own image.
export const measureArtwork = Object.freeze({
  M1: asset('transport'),
  M2: asset('traffic-lights'),
  M3: asset('light-rail'),
  M4: asset('ecology'),
  M5: asset('clean-heating'),
  M6: asset('green-belt'),
  M7: asset('school'),
  M8: asset('clinic'),
  M9: asset('sports'),
  M10: asset('safety'),
  M11: asset('safe-crossing'),
  M12: asset('digital-service'),
  M13: asset('utilities'),
  M14: asset('emergency-crew'),
});

export const districtArtwork = Object.freeze({
  esil: asset('district-yesil'),
  almaty: asset('district-almaty'),
  saryarka: asset('district-saryarka'),
  baikonur: asset('district-baikonur'),
  nura: asset('district-nura'),
});

export const metricArtwork = Object.freeze({
  baselineScore: asset('services'),
  budgetTotal: asset('budget'),
  budgetRemaining: asset('budget-remaining'),
  decisionCount: asset('decision-checklist'),
});

export const emptyStateArtwork = Object.freeze({
  plan: asset('plan'),
  results: asset('people'),
});

export const backgroundArtwork = Object.freeze({
  hero: asset('city-hero'),
  heroMobile: asset('city-hero-mobile'),
  texture: asset('city-texture'),
});
