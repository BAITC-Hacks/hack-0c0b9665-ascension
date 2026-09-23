import dataset from '../../data/city.json' with { type: 'json' };
const measureById = new Map(dataset.measures.map((measure) => [measure.id, measure]));
const districtIds = new Set(dataset.districts.map((district) => district.id));
const incompatibilities = [
  { pair: ['M1', 'M3'], scope: 'city' },
  { pair: ['M4', 'M7'], scope: 'district' },
  { pair: ['M5', 'M13'], scope: 'district' },
];
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => structuredClone(value);

/** Callers receive their own copy; scenario calculation never mutates source data. */
export function getDataset() {
  return clone(dataset);
}

export function validateScenario(input) {
  const errors = [];
  let totalCost = 0;
  const error = (code, message, decisionIndex) => {
    errors.push(decisionIndex === undefined ? { code, message } : { code, message, decisionIndex });
  };

  if (!isObject(input)) {
    error('INVALID_SCENARIO', 'Сценарий должен быть объектом с массивом decisions.');
    return { valid: false, errors, totalCost };
  }
  for (const key of Object.keys(input)) {
    if (key !== 'decisions') error('UNKNOWN_FIELD', 'Неизвестное поле сценария: ' + key + '.');
  }
  if (!Array.isArray(input.decisions)) {
    error('INVALID_DECISIONS', 'Поле decisions должно быть массивом.');
    return { valid: false, errors, totalCost };
  }
  if (input.decisions.length !== 5) {
    error('DECISION_COUNT', 'Нужно выбрать ровно 5 решений.');
  }

  const selected = new Map();
  const directionCounts = new Map();
  for (const [index, decision] of input.decisions.entries()) {
    if (!isObject(decision)) {
      error('INVALID_DECISION', 'Решение должно быть объектом.', index);
      continue;
    }
    for (const key of Object.keys(decision)) {
      if (key !== 'measureId' && key !== 'districtId') {
        error('UNKNOWN_FIELD', 'Неизвестное поле решения: ' + key + '.', index);
      }
    }
    const measure = measureById.get(decision.measureId);
    if (!measure) {
      error('UNKNOWN_MEASURE', 'Указано неизвестное мероприятие.', index);
      continue;
    }
    totalCost += measure.cost;
    if (selected.has(measure.id)) {
      error('DUPLICATE_MEASURE', 'Мероприятие ' + measure.id + ' можно выбрать только один раз.', index);
    } else {
      selected.set(measure.id, { decision, index });
    }
    directionCounts.set(measure.direction, (directionCounts.get(measure.direction) ?? 0) + 1);

    if (measure.scope === 'city') {
      if (hasOwn(decision, 'districtId')) {
        error('CITY_DISTRICT_FORBIDDEN', 'Для городской меры ' + measure.id + ' район не указывается.', index);
      }
    } else if (!hasOwn(decision, 'districtId')) {
      error('DISTRICT_REQUIRED', 'Для меры ' + measure.id + ' нужно выбрать район.', index);
    } else if (!districtIds.has(decision.districtId)) {
      error('UNKNOWN_DISTRICT', 'Указан неизвестный район для меры ' + measure.id + '.', index);
    }
  }

  for (const [direction, count] of directionCounts) {
    if (count > 2) {
      error('DIRECTION_LIMIT', 'Из направления ' + direction + ' можно выбрать не более 2 мер.');
    }
  }
  if (totalCost > dataset.budget) {
    error('BUDGET_EXCEEDED', 'Стоимость ' + totalCost + ' превышает бюджет ' + dataset.budget + '.');
  }
  for (const rule of incompatibilities) {
    const first = selected.get(rule.pair[0]);
    const second = selected.get(rule.pair[1]);
    if (!first || !second) continue;
    const sameValidDistrict = districtIds.has(first.decision.districtId)
      && first.decision.districtId === second.decision.districtId;
    if (rule.scope === 'city' || sameValidDistrict) {
      error('INCOMPATIBLE_MEASURES',
        rule.pair.join(' и ') + (rule.scope === 'city'
          ? ' несовместимы в любом районе.'
          : ' нельзя применять в одном районе.'), second.index);
    }
  }
  return { valid: errors.length === 0, errors, totalCost };
}

function districtScore(indicators) {
  return dataset.indicators.reduce((sum, indicator) => sum + indicator.weight * indicators[indicator.id], 0);
}

function aggregate(districts) {
  const weightedAverage = districts.reduce((sum, district, index) =>
    sum + dataset.districts[index].populationShare * district.afterScore, 0);
  const worstDistrictScore = Math.min(...districts.map((district) => district.afterScore));
  const criticalCount = districts.reduce((sum, district) =>
    sum + dataset.indicators.filter((indicator) => district.after[indicator.id] < 40).length, 0);
  return {
    score: 0.7 * weightedAverage + 0.3 * worstDistrictScore - criticalCount,
    weightedAverage,
    worstDistrictScore,
    criticalCount,
  };
}

const baselineDistricts = dataset.districts.map((district) => ({
  id: district.id,
  name: district.name,
  before: clone(district.indicators),
  after: clone(district.indicators),
  delta: Object.fromEntries(dataset.indicators.map((indicator) => [indicator.id, 0])),
  beforeScore: districtScore(district.indicators),
  afterScore: districtScore(district.indicators),
}));
const baseline = {
  valid: true,
  errors: [],
  totalCost: 0,
  remainingBudget: dataset.budget,
  ...aggregate(baselineDistricts),
  deltaScore: 0,
  districts: baselineDistricts,
  contributions: [],
  synergies: [],
};
baseline.baselineScore = baseline.score;

/** Baseline intentionally bypasses the five-decision submission rule. */
export function getBaseline() {
  return clone(baseline);
}

export function simulate(input) {
  const validation = validateScenario(input);
  if (!validation.valid) return validation;

  // Canonical order makes both numeric accumulation and explanations order-independent.
  const decisions = [...input.decisions].sort((left, right) =>
    Number(left.measureId.slice(1)) - Number(right.measureId.slice(1)));
  const selected = new Map(decisions.map((decision) => [decision.measureId, decision]));
  const additions = new Map(dataset.districts.map((district) =>
    [district.id, Object.fromEntries(dataset.indicators.map((indicator) => [indicator.id, 0]))]));
  const contributions = [];
  const synergies = [];
  const addEffects = (id, effects) => {
    const target = additions.get(id);
    for (const [indicatorId, effect] of Object.entries(effects)) target[indicatorId] += effect;
  };

  for (const decision of decisions) {
    const measure = measureById.get(decision.measureId);
    const realizedFactor = (dataset.horizon - measure.lag) / dataset.horizon;
    const effects = Object.fromEntries(Object.entries(measure.effects)
      .map(([id, effect]) => [id, effect * realizedFactor]));
    const affected = measure.scope === 'city'
      ? dataset.districts.map((district) => district.id) : [decision.districtId];
    for (const id of affected) addEffects(id, effects);
    // Effects are realized additions before final clipping; synergy bonuses are separate.
    contributions.push({ measureId: measure.id, districtIds: affected, effects, realizedFactor });
  }
  for (const synergy of dataset.synergies) {
    if (!synergy.pair.every((id) => selected.has(id))) continue;
    const districtId = selected.get(synergy.districtFrom).districtId;
    addEffects(districtId, synergy.effects);
    synergies.push({ pair: [...synergy.pair], districtId, effects: clone(synergy.effects) });
  }

  const districts = dataset.districts.map((district) => {
    const before = clone(district.indicators);
    const after = Object.fromEntries(dataset.indicators.map(({ id }) =>
      [id, Math.max(0, Math.min(100, before[id] + additions.get(district.id)[id]))]));
    const delta = Object.fromEntries(dataset.indicators.map(({ id }) => [id, after[id] - before[id]]));
    return {
      id: district.id, name: district.name, before, after, delta,
      beforeScore: districtScore(before), afterScore: districtScore(after),
    };
  });
  const metrics = aggregate(districts);
  return {
    valid: true, errors: [], totalCost: validation.totalCost,
    remainingBudget: dataset.budget - validation.totalCost,
    ...metrics, baselineScore: baseline.score, deltaScore: metrics.score - baseline.score,
    districts, contributions, synergies,
  };
}

