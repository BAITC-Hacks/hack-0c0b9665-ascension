import { getDataset, simulate } from '../core/simulator.js';

const data = getDataset();
const fmt = (number) => number.toFixed(2);
const measures = new Map(data.measures.map((measure) => [measure.id, measure]));
const districts = new Map(data.districts.map((district) => [district.id, district]));
const cache = new Map();
const MAX_TIMEOUT_MS = 25000;
const MAX_PROVIDER_BYTES = 64 * 1024;
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

function recommendationCatalog(facts) {
  const catalog = {
    COMPARE_SCENARIOS: 'Сравните альтернативные наборы в панели сценариев. Любой изменённый план нужно заново проверить и рассчитать сервером.',
    FOCUS_WEAKEST: `Проверьте приоритеты самого слабого района: ${facts.weakestDistrict}, оценка ${fmt(facts.worstDistrictScore)}.`,
    MONITOR_LAGS: `Учитывайте задержки реализации: горизонт учебной модели — ${facts.horizonQuarters} кварталов. Это не календарный план реальных работ.`,
  };
  if (facts.criticalCount > 0) catalog.REVIEW_CRITICAL =
    `Проверьте оставшиеся критические показатели: ${facts.critical.map(c => `${c.district} / ${c.indicator}: ${fmt(c.value)}`).join('; ')}.`;
  const best = facts.bestSingleReplacement;
  if (facts.replacementSearchPerformed && best) catalog.VERIFIED_SINGLE_REPLACEMENT =
    `Проверенная замена: ${decisionLabel(best.removed)} → ${decisionLabel(best.added)}. Score ${fmt(best.score)}, стоимость ${best.totalCost}. Это лучший найденный вариант одной замены, не глобальный оптимум. После загрузки варианта пересчитайте его сервером.`;
  return catalog;
}

function analysisSchema(catalog) {
  return { ...schema, properties: { ...schema.properties,
    recommendations: { type: 'array', items: { type: 'string', enum: Object.keys(catalog) } },
  } };
}

class InvalidModelAnalysis extends Error {}

async function readProviderResponse(response, allowJsonMock) {
  if (Number(response.headers?.get?.('content-length')) > MAX_PROVIDER_BYTES) {
    try { await response.body?.cancel?.(); } catch { /* Preserve the response limit error. */ }
    throw new InvalidModelAnalysis('Provider response is too large');
  }
  if (!response.body?.getReader) {
    // Injected transports may expose json(); native fetch always uses the bounded stream.
    if (allowJsonMock && typeof response.json === 'function') return response.json();
    throw new InvalidModelAnalysis('Provider response has no readable body');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_PROVIDER_BYTES) {
        try { await reader.cancel(); } catch { /* Preserve the response limit error. */ }
        throw new InvalidModelAnalysis('Provider response is too large');
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(chunks.join(''));
}

function groundAnalysis(analysis, facts, catalog) {
  const prose = [analysis.summary, ...analysis.strengths, ...analysis.risks];
  // A number whitelist cannot distinguish "Score 100" from a legitimate budget
  // of 100. Provider prose has no numeric channel: all displayed figures and
  // actionable recommendations below are rendered from the official facts.
  // This is deliberately not a proof of all qualitative natural-language claims.
  const unsupportedCertainty = /(?:гарантир|подтвержд[её]нн.{0,25}прогноз|глобальн.{0,15}оптим|(?<!\p{L})шест\p{L}*)/iu;
  const normalizedProse = prose.map(text => text.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' '));
  if (prose.some(text => /\p{N}/u.test(text))
    || normalizedProse.some(text => unsupportedCertainty.test(text))
    || analysis.recommendations.some(code => !Object.hasOwn(catalog, code))) {
    throw new InvalidModelAnalysis('Model output violated the evidence contract');
  }
  const recommendations = [...new Set(analysis.recommendations.length
    ? analysis.recommendations : ['COMPARE_SCENARIOS'])].map(code => catalog[code]);
  if (!facts.replacementSearchPerformed) recommendations.push(
    'Поиск замены не выполнялся сервером. Предварительные варианты в отдельной панели проверяются при повторном серверном расчёте.');
  return {
    summary: `Учебный Score ${fmt(facts.baselineScore)} → ${fmt(facts.score)} (${facts.deltaScore >= 0 ? '+' : ''}${fmt(facts.deltaScore)}); стоимость ${facts.totalCost} из ${facts.budget}, остаток ${facts.remainingBudget}. ${analysis.summary}`,
    strengths: analysis.strengths,
    risks: [...analysis.risks, 'Данные и эффекты синтетические. Качественное объяснение модели может содержать неточности; это не подтверждённый прогноз для реального города.'],
    recommendations,
  };
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
    !textFields.slice(1).every((key) => Array.isArray(value[key]) && (key === 'recommendations' || value[key].length > 0) &&
      value[key].length <= 8 && value[key].every((entry) => typeof entry === 'string' && entry.trim() && entry.length < 4000))) {
    throw new Error('Invalid model analysis');
  }
  return value;
}

export async function explainScenario(scenario, result, options = {}) {
  const facts = buildExplanationFacts(scenario, result, options);
  const catalog = recommendationCatalog(facts);
  const apiKey = options.apiKey ?? globalThis.process?.env?.OPENAI_API_KEY;
  if (typeof apiKey !== 'string' || !apiKey.trim()) return deterministic(facts, 'not_configured');
  const model = options.model ?? globalThis.process?.env?.OPENAI_MODEL ?? 'gpt-6-astra';
  if (typeof model !== 'string' || !model.trim() || model.length > 120) {
    return deterministic(facts, 'not_configured');
  }
  const cacheKey = JSON.stringify(['evidence-contract-v1', model, facts.replacementSearchPerformed,
    [...scenario.decisions].sort((a,b) => a.measureId.localeCompare(b.measureId))]);
  // Injectable transports never share live-response cache with production.
  const useCache = !options.fetchImpl && !options.apiKey;
  const cached = useCache && cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return structuredClone(cached.value);
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.floor(options.timeoutMs))) : MAX_TIMEOUT_MS;
  const controller = new AbortController();
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const error = new Error('Request timed out');
        error.name = 'TimeoutError';
        reject(error);
      }, timeoutMs);
    });
    const request = async () => {
      const response = await (options.fetchImpl ?? fetch)('https://api.openai.com/v1/responses', {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        redirect: 'manual', signal: controller.signal,
        body: JSON.stringify({ model, store: false, max_output_tokens: 3000,
          ...(model === 'gpt-6-astra' ? { reasoning: { effort: 'low' } } : {}),
          input: [
            { role: 'developer', content: `Ты аналитик учебного симулятора города. Ответь по-русски кратко. Вход содержит только синтетические данные и результаты доверенного калькулятора. В summary, strengths, risks объясни качественно сильные стороны, риски и компромиссы, без цифр, числовых значений, процентов и кодов мер/показателей. Не рассчитывай новые числа и не записывай числа словами: числовую сводку и точные значения добавит сервер. Называй меры и районы словами. Не используй утверждения о гарантии, подтверждённом прогнозе или глобальном оптимуме; сервер добавит оговорку о синтетике. Не предлагай добавление, удаление или замену мер в свободной прозе. Объясни приоритет самого слабого района и оставшиеся дефициты. recommendations — только выбранные коды из списка ${Object.keys(catalog).join(', ')}; это не свободный текст. Если подходящего совета нет, верни пустой массив. Код VERIFIED_SINGLE_REPLACEMENT допустим только если он есть в списке. Если replacementSearchPerformed=false, поиск замены не выполнялся; не утверждай, что улучшений нет или что замена проверена. Не предлагай шестое решение или несовместимые меры. По два–четыре коротких пункта strengths и risks.` },
            { role: 'user', content: JSON.stringify(facts) },
          ],
          text: { format: { type: 'json_schema', name: 'city_scenario_analysis', strict: true, schema: analysisSchema(catalog) } },
        }),
      });
      if (response.redirected || !response.ok) {
        controller.abort();
        try { await response.body?.cancel?.(); } catch { /* Abort may have closed the stream. */ }
        return deterministic(facts, response.status === 429 ? 'rate_limited' : 'provider_error');
      }
      const analysis = groundAnalysis(parseAnalysis(await readProviderResponse(response, Boolean(options.fetchImpl))), facts, catalog);
      // A transport that ignores abort must never populate the shared cache after timeout.
      if (controller.signal.aborted) throw controller.signal.reason;
      const value = { mode: 'ai', available: true, model, ...analysis };
      if (useCache) {
        if (cache.size >= 100) cache.delete(cache.keys().next().value);
        cache.set(cacheKey, { expires: Date.now() + 600000, value });
      }
      return structuredClone(value);
    };
    return await Promise.race([request(), deadline]);
  } catch (error) {
    return deterministic(facts, error instanceof InvalidModelAnalysis ? 'invalid_model_analysis'
      : ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'provider_error');
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}
