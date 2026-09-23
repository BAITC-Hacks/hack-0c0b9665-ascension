import { getDataset, getBaseline, simulate } from './simulator.js';

const dataset = getDataset();
const measureById = new Map(dataset.measures.map((measure) => [measure.id, measure]));
const horizon = dataset.horizon;

const assumptions = [
  'Учебная симуляция на синтетических данных кейса; не прогноз фактического состояния Астаны.',
  'Квартал 0 — исходное состояние, квартал 8 — точный результат официальной формулы. Промежуточная динамика — допущение визуализации.',
  'Все меры запускаются одновременно. До окончания указанного лага эффект равен нулю, затем плавно растёт и замедляется к концу горизонта.',
  'Для промежуточных кварталов используется кривая 3u² − 2u³, где u — доля времени после лага. Эта кривая не откалибрована по наблюдениям.',
  'Синергия проявляется после завершения обоих лагов и достигает полного фиксированного бонуса в квартале 8.',
  'Побочные эффекты сохраняют знак. Значения ограничены диапазоном 0–100; Score и штраф за значения строго ниже 40 пересчитываются каждый квартал.',
  'Население и внешние условия постоянны; инфляция, погода, миграция, аварии и строительные неудобства не моделируются. Расходы — стоимость всего плана, а не поквартальный денежный поток.',
];

// A bounded adoption curve: no effect before the lag, gradual ramp-up, then
// diminishing increments. The endpoint magnitude always comes from simulate().
function progressAt(quarter, lag) {
  if (quarter <= lag) return 0;
  if (quarter >= horizon) return 1;
  const u = (quarter - lag) / (horizon - lag);
  return u * u * (3 - 2 * u);
}

function scaleEffects(effects, progress) {
  return Object.fromEntries(Object.entries(effects).map(([id, effect]) => [id, effect * progress]));
}

function scoreDistrict(indicators) {
  return dataset.indicators.reduce((sum, { id, weight }) => sum + weight * indicators[id], 0);
}

function frameAt(quarter, endpoint, baseline) {
  // Returning the canonical snapshots also prevents floating-point drift at the
  // two anchors. Each frame owns its data and can safely be consumed by the map.
  if (quarter === 0) return { quarter, ...structuredClone(baseline) };
  if (quarter === horizon) return { quarter, ...structuredClone(endpoint) };

  const additions = new Map(dataset.districts.map(({ id }) =>
    [id, Object.fromEntries(dataset.indicators.map((indicator) => [indicator.id, 0]))]));
  const addEffects = (districtId, effects) => {
    const values = additions.get(districtId);
    for (const [id, effect] of Object.entries(effects)) values[id] += effect;
  };

  const contributions = endpoint.contributions.map((contribution) => {
    const progress = progressAt(quarter, measureById.get(contribution.measureId).lag);
    const effects = scaleEffects(contribution.effects, progress);
    for (const districtId of contribution.districtIds) addEffects(districtId, effects);
    return {
      measureId: contribution.measureId,
      districtIds: [...contribution.districtIds],
      effects,
      realizedFactor: contribution.realizedFactor * progress,
    };
  });

  const synergies = [];
  for (const synergy of endpoint.synergies) {
    const lag = Math.max(...synergy.pair.map((id) => measureById.get(id).lag));
    const progress = progressAt(quarter, lag);
    if (progress === 0) continue;
    const effects = scaleEffects(synergy.effects, progress);
    addEffects(synergy.districtId, effects);
    synergies.push({ pair: [...synergy.pair], districtId: synergy.districtId, effects });
  }

  const districts = dataset.districts.map((district) => {
    const before = { ...district.indicators };
    const after = Object.fromEntries(dataset.indicators.map(({ id }) =>
      [id, Math.max(0, Math.min(100, before[id] + additions.get(district.id)[id]))]));
    return {
      id: district.id,
      name: district.name,
      before,
      after,
      delta: Object.fromEntries(dataset.indicators.map(({ id }) => [id, after[id] - before[id]])),
      beforeScore: scoreDistrict(before),
      afterScore: scoreDistrict(after),
    };
  });
  const weightedAverage = districts.reduce((sum, district, index) =>
    sum + dataset.districts[index].populationShare * district.afterScore, 0);
  const worstDistrictScore = Math.min(...districts.map((district) => district.afterScore));
  const criticalCount = districts.reduce((sum, district) =>
    sum + dataset.indicators.filter(({ id }) => district.after[id] < 40).length, 0);
  const score = 0.7 * weightedAverage + 0.3 * worstDistrictScore - criticalCount;

  return {
    quarter,
    valid: true,
    errors: [],
    totalCost: endpoint.totalCost,
    remainingBudget: endpoint.remainingBudget,
    score,
    weightedAverage,
    worstDistrictScore,
    criticalCount,
    baselineScore: baseline.score,
    deltaScore: score - baseline.score,
    districts,
    contributions,
    synergies,
  };
}

/**
 * Visualize a valid official scenario over its eight-quarter horizon.
 * The endpoint is authoritative; intermediate frames are synthetic assumptions,
 * not extra official data or an empirically calibrated city forecast.
 */
export function simulateTrajectory(scenario) {
  const endpoint = simulate(scenario);
  if (!endpoint.valid) return endpoint;

  const baseline = getBaseline();
  const frames = Array.from({ length: horizon + 1 }, (_, quarter) => frameAt(quarter, endpoint, baseline));
  const minimum = frames.reduce((worst, frame) => frame.score < worst.score ? frame : worst);
  const peakCritical = frames.reduce((worst, frame) => frame.criticalCount > worst.criticalCount ? frame : worst);
  const firstEffect = frames.find((frame) => frame.districts.some((district) =>
    Object.values(district.delta).some((delta) => delta !== 0)));

  return {
    ...endpoint,
    model: 'lagged-saturation-v1',
    synthetic: true,
    horizon,
    assumptions: [...assumptions],
    summary: {
      firstEffectQuarter: firstEffect?.quarter ?? null,
      minimumScore: minimum.score,
      minimumScoreQuarter: minimum.quarter,
      peakCriticalCount: peakCritical.criticalCount,
      peakCriticalQuarter: peakCritical.quarter,
    },
    frames,
  };
}
