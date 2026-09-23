import { getDataset, simulate } from '../core/simulator.js';

const data = getDataset();
const fmt = (number) => number.toFixed(2);
const measures = new Map(data.measures.map((measure) => [measure.id, measure]));
const districts = new Map(data.districts.map((district) => [district.id, district]));
const cache = new Map();
const textFields = ['summary', 'strengths', 'risks', 'recommendations'];
const schema = {
  type: 'object', additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    strengths: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    recommendations: { type: 'array', items: { type: 'string' } },
  },
  required: textFields,
};

export function isAIConfigured() {
  return Boolean(globalThis.process?.env?.OPENAI_API_KEY?.trim());
}

function bestReplacement(scenario, result) {
  let best;
  const selected = new Set(scenario.decisions.map((decision) => decision.measureId));
  for (let index = 0; index < scenario.decisions.length; index += 1) {
    for (const measure of data.measures) {
      if (selected.has(measure.id) && measure.id !== scenario.decisions[index].measureId) continue;
      const targets = measure.scope === 'city' ? [undefined] : data.districts.map((district) => district.id);
      for (const districtId of targets) {
        const candidate = structuredClone(scenario);
        candidate.decisions[index] = districtId === undefined
          ? { measureId: measure.id } : { measureId: measure.id, districtId };
        const computed = simulate(candidate);
        if (computed.valid && computed.score > (best?.score ?? result.score) + 1e-9) {
          best = { removed: scenario.decisions[index], added: candidate.decisions[index],
            score: computed.score, totalCost: computed.totalCost, scenario: candidate };
        }
      }
    }
  }
  return best;
}

export function buildExplanationFacts(scenario, result, options = {}) {
  if (!result?.valid) throw new Error('A valid calculated scenario is required.');
  const critical = result.districts.flatMap((district) => data.indicators
    .filter((indicator) => district.after[indicator.id] < 40)
    .map((indicator) => ({ district: district.name, indicator: indicator.name,
      value: district.after[indicator.id] })));
  const weakest = [...result.districts].sort((a, b) => a.afterScore - b.afterScore)[0];
  return {
    synthetic: true, horizonQuarters: data.horizon, budget: data.budget,
    score: result.score, baselineScore: result.baselineScore, deltaScore: result.deltaScore,
    totalCost: result.totalCost, remainingBudget: result.remainingBudget,
    weightedAverage: result.weightedAverage, worstDistrictScore: result.worstDistrictScore,
    criticalCount: result.criticalCount, critical, weakestDistrict: weakest.name,
    decisions: scenario.decisions.map((decision) => ({ ...decision, ...measures.get(decision.measureId),
      target: decision.districtId ? districts.get(decision.districtId).name : 'Все районы' })),
    districts: result.districts, contributions: result.contributions, synergies: result.synergies,
    replacementSearchPerformed: options.skipReplacementSearch !== true,
    bestSingleReplacement: options.skipReplacementSearch === true ? null : bestReplacement(scenario, result),
    formula: '0.7 * populationWeightedAverage + 0.3 * worstDistrictScore - criticalCount; critical means strictly below 40',
  };
}

function decisionLabel(decision) {
  return `${decision.measureId} «${measures.get(decision.measureId).name}»` +
    (decision.districtId ? ` (${districts.get(decision.districtId).name})` : ' (весь город)');
}

function deterministic(facts, reason) {
  const bestDistricts = [...facts.districts].sort((a, b) =>
    (b.afterScore - b.beforeScore) - (a.afterScore - a.beforeScore)).slice(0, 3);
  const strengths = bestDistricts.filter((district) => district.afterScore > district.beforeScore)
    .map((district) => `${district.name}: оценка района ${fmt(district.beforeScore)} → ${fmt(district.afterScore)}.`);
  if (facts.synergies.length) strengths.push(`Сработали синергии: ${facts.synergies.map((s) => s.pair.join(' + ')).join('; ')}.`);
  const risks = [`Самый слабый район — ${facts.weakestDistrict}, ${fmt(facts.worstDistrictScore)}. Его оценка имеет вес 30% в городской формуле.`];
  if (facts.critical.length) {
    risks.push(`Остались критические показатели: ${facts.critical.map((c) => `${c.district} / ${c.indicator}: ${fmt(c.value)}`).join('; ')}.`);
  } else risks.push('Показателей ниже 40 нет. Это отсутствие штрафа модели, а не отсутствие реальных городских проблем.');
  const negative = facts.contributions.flatMap((c) => Object.entries(c.effects)
    .filter(([,value]) => value < 0).map(([id,value]) => `${c.measureId}: ${id} ${fmt(value)}`));
  if (negative.length) risks.push(`Отрицательные побочные эффекты: ${negative.join('; ')}.`);
  risks.push('Эффекты условные и учитывают задержку реализации на горизонте 8 кварталов; это не прогноз для реального города.');
  const best = facts.bestSingleReplacement;
  const recommendations = !facts.replacementSearchPerformed
    ? ['Поиск замены не выполнялся. Сравните альтернативные наборы решений в панели сравнения.']
    : best
    ? [`Проверенная замена: ${decisionLabel(best.removed)} → ${decisionLabel(best.added)}. Score ${fmt(best.score)}, стоимость ${best.totalCost}. Это лучший найденный вариант одной замены, не глобальный оптимум.`]
    : ['Среди допустимых замен одного решения улучшение не найдено. Для дальнейшего поиска сравните несколько решений одновременно.'];
  if (facts.remainingBudget) recommendations.push(`Остаток ${facts.remainingBudget} единиц сам по себе не даёт баллов; шестое решение добавлять нельзя.`);
  return {
    mode: 'deterministic', available: false, reason,
    summary: `Расчётное пояснение: Score ${fmt(facts.baselineScore)} → ${fmt(facts.score)} (${facts.deltaScore >= 0 ? '+' : ''}${fmt(facts.deltaScore)}), стоимость ${facts.totalCost} из ${facts.budget}. LLM-анализ не выполнен.`,
    strengths, risks, recommendations,
  };
}

function parseAnalysis(response) {
  if (response.status !== 'completed') throw new Error('Incomplete model response');
  const content = response.output?.flatMap((item) => item.content ?? []) ?? [];
  if (content.some((item) => item.type === 'refusal')) throw new Error('Model refused');
  const json = content.filter((item) => item.type === 'output_text').map((item) => item.text).join('');
  const value = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some((key) => !textFields.includes(key)) ||
    typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 5000 ||
    !textFields.slice(1).every((key) => Array.isArray(value[key]) && value[key].length > 0 &&
      value[key].length <= 8 && value[key].every((entry) => typeof entry === 'string' && entry.trim() && entry.length < 4000))) {
    throw new Error('Invalid model analysis');
  }
  return value;
}

export async function explainScenario(scenario, result, options = {}) {
  const facts = buildExplanationFacts(scenario, result, options);
  const apiKey = options.apiKey ?? globalThis.process?.env?.OPENAI_API_KEY;
  if (!apiKey?.trim()) return deterministic(facts, 'not_configured');
  const model = options.model ?? globalThis.process?.env?.OPENAI_MODEL ?? 'gpt-6-astra';
  const cacheKey = JSON.stringify([model, facts.replacementSearchPerformed,
    [...scenario.decisions].sort((a,b) => a.measureId.localeCompare(b.measureId))]);
  // Injectable transports never share live-response cache with production.
  const useCache = !options.fetchImpl && !options.apiKey;
  const cached = useCache && cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return structuredClone(cached.value);
  try {
    const response = await (options.fetchImpl ?? fetch)('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 25000),
      body: JSON.stringify({ model, store: false, max_output_tokens: 3000,
        ...(model === 'gpt-6-astra' ? { reasoning: { effort: 'low' } } : {}),
        input: [
          { role: 'developer', content: 'Ты аналитик учебного симулятора города. Ответь по-русски кратко. Вход содержит только синтетические данные и результаты доверенного калькулятора. Объясни сильные стороны, риски, компромиссы и последствия. Не рассчитывай новые числа, не меняй бюджет, Score или формулу. Используй только готовые числа из JSON, округляя при показе до двух знаков. Не утверждай, что условные эффекты гарантированы в реальном городе. Объясни приоритет самого слабого района и штрафы строго ниже 40. Рекомендацию bestSingleReplacement, если она есть, назови проверенной заменой одного решения, никогда глобальным оптимумом. Если replacementSearchPerformed=false, поиск замены не выполнялся; не утверждай, что улучшений нет или что замена проверена. Не предлагай шестое решение или несовместимые меры. По 2–4 коротких пункта в каждом списке.' },
          { role: 'user', content: JSON.stringify(facts) },
        ],
        text: { format: { type: 'json_schema', name: 'city_scenario_analysis', strict: true, schema } },
      }),
    });
    if (!response.ok) {
      return deterministic(facts, response.status === 429 ? 'rate_limited' : 'provider_error');
    }
    const analysis = parseAnalysis(await response.json());
    const value = { mode: 'ai', available: true, model, ...analysis };
    if (useCache) {
      if (cache.size >= 100) cache.delete(cache.keys().next().value);
      cache.set(cacheKey, { expires: Date.now() + 600000, value });
    }
    return structuredClone(value);
  } catch (error) {
    return deterministic(facts, ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'provider_error');
  }
}
