import { getDataset, simulate } from './simulator.js';

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 12;
const OBJECTIVES = ['maximizeScore', 'maximizeWorst', 'minimizeCost'];
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const decisionKey = ({ measureId, districtId }) => `${measureId}:${districtId ?? '*'}`;
const compareDecision = (left, right) =>
  Number(left.measureId.slice(1)) - Number(right.measureId.slice(1))
  || compareText(decisionKey(left), decisionKey(right));
const canonicalScenario = (decisions) => ({
  decisions: decisions.map(decision => ({ ...decision })).sort(compareDecision),
});
const scenarioKey = ({ decisions }) => decisions.map(decisionKey).join('|');

function dominates(left, right) {
  return left.score >= right.score
    && left.worstDistrictScore >= right.worstDistrictScore
    && left.totalCost <= right.totalCost
    && (left.score > right.score
      || left.worstDistrictScore > right.worstDistrictScore
      || left.totalCost < right.totalCost);
}

function improvesAny(candidate, baseline) {
  return candidate.score > baseline.score
    || candidate.worstDistrictScore > baseline.worstDistrictScore
    || candidate.totalCost < baseline.totalCost;
}

function compareScore(left, right) {
  return right.result.score - left.result.score
    || right.result.worstDistrictScore - left.result.worstDistrictScore
    || left.result.totalCost - right.result.totalCost
    || compareText(left.id, right.id);
}

const ranking = {
  maximizeScore: compareScore,
  maximizeWorst: (left, right) =>
    right.result.worstDistrictScore - left.result.worstDistrictScore || compareScore(left, right),
  minimizeCost: (left, right) => left.result.totalCost - right.result.totalCost || compareScore(left, right),
};

function selectOptions(frontier, limit) {
  const leaders = new Map(OBJECTIVES.map(objective =>
    [objective, [...frontier].sort(ranking[objective])[0]]));
  const ordered = [...new Set([
    ...leaders.values(),
    ...[...frontier].sort(compareScore),
  ])].filter(Boolean);
  return ordered.slice(0, limit).map(option => ({
    ...option,
    selectedFor: OBJECTIVES.filter(objective => leaders.get(objective) === option),
  })).map(option => ({
    ...option,
    selectedFor: option.selectedFor.length ? option.selectedFor : ['tradeoff'],
  }));
}

const direction = (difference) => difference > 0 ? 'improved' : difference < 0 ? 'worse' : 'unchanged';

const record = value => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const onlyKeys = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));

function normalizeConstraints(value, scenario, dataset) {
  if (value === undefined) value = {};
  if (!onlyKeys(value, ['lockedDecisions', 'protectedIndicator'])) return null;
  const locks = value.lockedDecisions === undefined ? [] : value.lockedDecisions;
  if (!Array.isArray(locks) || locks.length > scenario.decisions.length) return null;
  const keys = new Set();
  for (const lock of locks) {
    if (!onlyKeys(lock, ['measureId', 'districtId']) || typeof lock.measureId !== 'string'
      || (Object.hasOwn(lock, 'districtId') && typeof lock.districtId !== 'string')) return null;
    const original = scenario.decisions.find(decision => decision.measureId === lock.measureId);
    if (!original || original.districtId !== lock.districtId || keys.has(decisionKey(lock))) return null;
    keys.add(decisionKey(lock));
  }
  const protection = value.protectedIndicator === undefined ? null : value.protectedIndicator;
  if (protection !== null && (!onlyKeys(protection, ['indicatorId', 'districtId'])
    || !dataset.indicators.some(({ id }) => id === protection.indicatorId)
    || (Object.hasOwn(protection, 'districtId')
      && !dataset.districts.some(({ id }) => id === protection.districtId)))) return null;
  return {
    lockedDecisions: canonicalScenario(locks).decisions,
    protectedIndicator: protection === null ? null : { ...protection },
  };
}

function worsenedIndicators(result, baseline, dataset) {
  return result.districts.flatMap(district => {
    const previous = baseline.districts.find(({ id }) => id === district.id);
    return dataset.indicators.filter(({ id }) => district.after[id] < previous.after[id])
      .map(({ id, name }) => ({ districtId: district.id, districtName: district.name,
        indicatorId: id, indicatorName: name, baseline: previous.after[id],
        value: district.after[id], delta: district.after[id] - previous.after[id] }));
  });
}

/**
 * Enumerate the complete one-decision neighborhood, using only the official simulator.
 * A returned option is Pareto-nondominated within the allowed neighborhood and baseline;
 * it is not a claim of global optimality. No input, dataset or scenario is mutated.
 */
export function buildPolicyOptions(scenario, { limit = DEFAULT_LIMIT, constraints } = {}) {
  limit = Number.isFinite(limit) ? Math.max(0, Math.min(MAX_LIMIT, Math.floor(limit))) : DEFAULT_LIMIT;
  // Validate the original object before canonicalizing, so unknown fields are not lost.
  const baselineResult = simulate(scenario);
  const response = {
    valid: baselineResult.valid,
    scope: 'single-decision-neighborhood',
    exhaustiveWithinScope: baselineResult.valid,
    constraintScope: 'unrestricted',
    constraints: null,
    baseline: {
      scenario: baselineResult.valid ? canonicalScenario(scenario.decisions) : structuredClone(scenario ?? null),
      result: baselineResult,
    },
    explored: 0,
    validCandidates: 0,
    rejectedByConstraints: 0,
    paretoCandidates: 0,
    limit,
    truncated: false,
    options: [],
    errors: baselineResult.errors,
    emptyReason: null,
  };
  if (!baselineResult.valid) {
    response.emptyReason = {
      code: 'INVALID_BASELINE',
      message: 'Сначала исправьте исходный сценарий: альтернативы не рассчитывались.',
    };
    return response;
  }

  const dataset = getDataset();
  const normalized = normalizeConstraints(constraints, scenario, dataset);
  if (!normalized) {
    response.valid = false;
    response.exhaustiveWithinScope = false;
    response.errors = [{ code: 'INVALID_CONSTRAINTS',
      message: 'Ограничения не приняты: закрепляйте только точные решения текущего плана и известные показатели и районы.' }];
    response.emptyReason = response.errors[0];
    return response;
  }
  response.constraints = normalized;
  const lockedKeys = new Set(normalized.lockedDecisions.map(decisionKey));
  const protection = normalized.protectedIndicator;
  const constrained = lockedKeys.size > 0 || protection !== null;
  response.constraintScope = constrained ? 'constrained' : 'unrestricted';
  if (lockedKeys.size === scenario.decisions.length) {
    response.emptyReason = { code: 'ALL_DECISIONS_LOCKED',
      message: 'Все пять решений закреплены. Снимите хотя бы одно закрепление, чтобы искать замену.' };
    return response;
  }
  const choices = dataset.measures.flatMap(measure => measure.scope === 'city'
    ? [{ measureId: measure.id }]
    : dataset.districts.map(district => ({ measureId: measure.id, districtId: district.id })));
  const baselineScenario = response.baseline.scenario;
  const seen = new Set([scenarioKey(baselineScenario)]);
  const candidates = [];
  for (const removed of baselineScenario.decisions) {
    if (lockedKeys.has(decisionKey(removed))) continue;
    const retained = baselineScenario.decisions.filter(decision => decision !== removed);
    const retainedIds = new Set(retained.map(decision => decision.measureId));
    for (const added of choices) {
      // Repeating a retained measure can never produce a valid five-measure scenario.
      if (retainedIds.has(added.measureId)) continue;
      const candidateScenario = canonicalScenario([...retained, added]);
      const key = scenarioKey(candidateScenario);
      if (seen.has(key)) continue;
      seen.add(key);
      response.explored++;
      const result = simulate(candidateScenario);
      if (!result.valid) continue;
      const worsened = worsenedIndicators(result, baselineResult, dataset);
      if (protection && worsened.some(item => item.indicatorId === protection.indicatorId
        && (protection.districtId === undefined || item.districtId === protection.districtId))) {
        response.rejectedByConstraints++;
        continue;
      }
      response.validCandidates++;
      const delta = {
        score: result.score - baselineResult.score,
        worstDistrictScore: result.worstDistrictScore - baselineResult.worstDistrictScore,
        totalCost: result.totalCost - baselineResult.totalCost,
        criticalCount: result.criticalCount - baselineResult.criticalCount,
      };
      candidates.push({
        id: `single:${key}`,
        scenario: candidateScenario,
        result,
        worsenedIndicators: worsened,
        delta,
        changed: { removed: { ...removed }, added: { ...added } },
        objectives: {
          maximizeScore: direction(delta.score),
          maximizeWorst: direction(delta.worstDistrictScore),
          minimizeCost: direction(-delta.totalCost),
        },
      });
    }
  }

  const frontier = candidates.filter(candidate =>
    improvesAny(candidate.result, baselineResult)
    && !dominates(baselineResult, candidate.result)
    && !candidates.some(other => dominates(other.result, candidate.result)));
  response.paretoCandidates = frontier.length;
  response.options = selectOptions(frontier, limit);
  response.truncated = frontier.length > response.options.length;
  if (!frontier.length) {
    response.emptyReason = {
      code: response.validCandidates ? 'NO_IMPROVING_ALTERNATIVES' : 'NO_VALID_ALTERNATIVES',
      message: response.validCandidates
        ? 'Среди допустимых замен одного решения с заданными ограничениями нет недоминируемой альтернативы, улучшающей хотя бы одну из трёх целей. Для иных вариантов потребуется изменить несколько решений.'
        : 'Ни одна замена одного решения не прошла правила модели и заданные ограничения. Измените ограничения, чтобы расширить поиск.',
    };
  } else if (limit === 0) {
    response.emptyReason = { code: 'LIMIT_ZERO', message: 'Альтернативы рассчитаны; вывод отключён параметром limit=0.' };
  }
  return response;
}
