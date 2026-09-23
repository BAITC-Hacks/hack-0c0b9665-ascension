const format = (value, digits = 2) => Number(value).toLocaleString('ru-RU', { maximumFractionDigits: digits });
const signed = value => `${value > 0 ? '+' : ''}${format(value)}`;

/** Facts for the explanation come from a completed calculation, not a second model. */
export function buildBudgetStory(dataset, scenario, result) {
  if (!result?.valid || !Array.isArray(result.districts) || !result.districts.length
    || !Array.isArray(scenario?.decisions) || !Array.isArray(dataset?.measures)
    || !Array.isArray(dataset?.indicators) || !Number.isFinite(result.remainingBudget)) {
    throw new Error('Для объяснения нужен завершённый расчёт сценария.');
  }
  const measureMap = new Map(dataset.measures.map(item => [item.id, item]));
  const districtMap = new Map(dataset.districts.map(item => [item.id, item]));
  const indicatorMap = new Map(dataset.indicators.map(item => [item.id, item]));
  const districtNames = ids => ids.map(id => districtMap.get(id)?.name || id).join(', ');
  const measures = scenario.decisions.map(decision => {
    const measure = measureMap.get(decision.measureId);
    if (!measure) throw new Error('В расчёте найдена неизвестная мера.');
    const contribution = result.contributions.find(item => item.measureId === measure.id);
    return {
      id: measure.id, name: measure.name, cost: measure.cost,
      area: measure.scope === 'city' ? 'Все районы' : districtNames([decision.districtId]),
      effects: contribution ? Object.entries(contribution.effects).map(([id, value]) => `${indicatorMap.get(id)?.name || id}: ${signed(value)}`).join('; ') : '',
      realized: contribution ? contribution.realizedFactor * 100 : null,
    };
  });
  const districts = result.districts.map(district => ({
    ...district,
    gain: district.afterScore - district.beforeScore,
    improvements: dataset.indicators.filter(({ id }) => district.delta[id] > 0)
      .sort((a, b) => district.delta[b.id] - district.delta[a.id])
      .map(({ id, name }) => `${name.toLocaleLowerCase('ru-RU')} (${signed(district.delta[id])})`),
  }));
  const ranked = [...districts].sort((a, b) => a.afterScore - b.afterScore);
  const critical = districts.flatMap(district => dataset.indicators
    .filter(({ id }) => district.after[id] < 40)
    .map(({ id, name }) => ({ district: district.name, name, value: district.after[id] })));
  const negative = districts.flatMap(district => dataset.indicators
    .filter(({ id }) => district.delta[id] < 0)
    .map(({ id, name }) => `${district.name}: ${name.toLocaleLowerCase('ru-RU')} ${signed(district.delta[id])}`));
  const weakest = ranked[0];
  const lowest = [...dataset.indicators].sort((a, b) => weakest.after[a.id] - weakest.after[b.id]).slice(0, 3)
    .map(({ id, name }) => `${name.toLocaleLowerCase('ru-RU')} — ${format(weakest.after[id])}`);
  const unselected = dataset.measures.filter(measure => !scenario.decisions.some(decision => decision.measureId === measure.id));
  const cheapestUnselected = unselected.length ? Math.min(...unselected.map(measure => measure.cost)) : null;
  return {
    cost: result.totalCost, remaining: result.remainingBudget, budget: dataset.budget,
    horizon: dataset.horizon, measures,
    beneficiaries: districts.filter(item => item.gain > 0).sort((a, b) => b.gain - a.gain),
    weakest, gap: ranked.at(-1).afterScore - weakest.afterScore, critical, negative, lowest,
    decisionCount: scenario.decisions.length, cheapestUnselected,
    unchangedCount: districts.reduce((count, district) => count + dataset.indicators.filter(({ id }) => district.delta[id] === 0).length, 0),
  };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderBudgetStory(panel, story) {
  panel.replaceChildren();
  panel.removeAttribute('aria-busy');
  const heading = element('h3', '', 'Кому помогает бюджет и что остаётся решить');
  heading.id = 'budget-story-heading';
  panel.setAttribute('aria-labelledby', heading.id);
  panel.append(heading, element('p', 'bs-intro', `Выбрано ${story.decisionCount} решений на ${format(story.cost)} из ${format(story.budget)} у. е. Остаток — ${format(story.remaining)} у. е. Горизонт модели: ${story.horizon} кварталов.`));
  const columns = element('div', 'bs-columns');
  const benefit = element('section');
  benefit.append(element('h4', '', 'Где ожидается улучшение'));
  const list = element('ul', 'bs-beneficiaries');
  for (const district of story.beneficiaries) {
    const item = element('li');
    item.append(element('strong', '', `${district.name} · ${signed(district.gain)} к оценке района`),
      element('span', '', district.improvements.join('; ')));
    list.append(item);
  }
  benefit.append(story.beneficiaries.length ? list : element('p', '', 'Суммарная оценка районов не выросла. Отдельные изменения показателей видны в таблице расчёта.'));
  const gaps = element('section');
  gaps.append(element('h4', '', 'Что требует внимания'), element('p', '', `Самый слабый район после решений — ${story.weakest.name}: ${format(story.weakest.afterScore)}. Разрыв с лидирующим районом — ${format(story.gap)} балла.`));
  if (story.critical.length) {
    gaps.append(element('p', '', `Остаются показатели ниже критического порога 40: ${story.critical.map(item => `${item.district} — ${item.name.toLocaleLowerCase('ru-RU')} ${format(item.value)}`).join('; ')}.`));
  } else {
    gaps.append(element('p', '', 'Показателей ниже критического порога 40 не осталось. Это порог учебной модели, а не подтверждение решения всех проблем жителей.'));
  }
  gaps.append(element('p', '', `Самые низкие показатели района ${story.weakest.name}: ${story.lowest.join('; ')}.`), element('p', '', `Без изменения остаются ${story.unchangedCount} значений показателей по районам.`));
  columns.append(benefit, gaps);
  panel.append(columns);
  const tradeoffs = element('div', 'bs-tradeoffs');
  tradeoffs.append(element('h4', '', 'Почему нельзя просто добавить всё'));
  tradeoffs.append(element('p', '', 'В модели нужно ровно пять решений, не более двух из одного направления, а некоторые меры несовместимы. Дополнительная мера требует пересобрать набор и проверить ограничения заново. Неизрасходованный бюджет сам по себе не повышает Score.'));
  if (story.cheapestUnselected !== null && story.remaining < story.cheapestUnselected) {
    tradeoffs.append(element('p', '', `Остаток ${format(story.remaining)} у. е. также меньше стоимости самой дешёвой невыбранной меры (${format(story.cheapestUnselected)} у. е.).`));
  } else if (story.remaining > 0) {
    tradeoffs.append(element('p', '', 'По стоимости остатка хватает хотя бы на одну невыбранную меру, но свободного шестого места в сценарии нет. Можно сравнить замену одного решения другим.'));
  }
  if (story.negative.length) tradeoffs.append(element('p', 'bs-warning', `Обратная сторона выбранных мер: ${story.negative.join('; ')}.`));
  panel.append(tradeoffs);
  const details = element('details', 'bs-measures');
  details.append(element('summary', '', 'На что идут средства и когда появится эффект'));
  const measures = element('ul');
  for (const measure of story.measures) {
    const item = element('li');
    item.append(element('strong', '', `${measure.id} · ${measure.name} · ${format(measure.cost)} у. е.`), element('span', '', `${measure.area}. ${measure.effects}.${measure.realized !== null ? ` За горизонт модели учтено ${format(measure.realized)}% исходного эффекта с учётом лага.` : ''}`));
    measures.append(item);
  }
  details.append(measures, element('p', '', 'Здесь показаны вклады мер до ограничения показателей диапазоном 0–100. Дополнительные эффекты сочетаний и итоговые изменения приведены в расчёте выше.'));
  panel.append(details, element('p', 'bs-disclaimer', 'Синтетические данные учебной модели. Оценка района и изменение индикатора не измеряют число получателей помощи; модель не подтверждает выполнение работ или реальный эффект для конкретного жителя.'));
}

// The panel belongs to the result DOM. Clearing or replacing that DOM invalidates
// in-flight requests too, so an earlier calculation can never reappear after reset.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  let datasetPromise;
  let calculation = 0;
  const getDataset = () => {
    if (!datasetPromise) datasetPromise = fetch('/api/dataset', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) })
      .then(async response => {
        if (!response.ok) throw new Error('Не удалось загрузить данные модели.');
        return response.json();
      }).catch(error => { datasetPromise = undefined; throw error; });
    return datasetPromise;
  };
  window.addEventListener('scenario:calculated', event => {
    const container = document.getElementById('result-content');
    if (!container || container.hidden || !event.detail?.result?.valid) return;
    const detail = structuredClone(event.detail);
    const ticket = ++calculation;
    container.querySelector('.budget-story')?.remove();
    const panel = element('section', 'budget-story');
    container.append(panel);
    const current = () => ticket === calculation && panel.isConnected && container.contains(panel) && !container.hidden;
    const load = async () => {
      panel.setAttribute('aria-busy', 'true');
      panel.replaceChildren(element('p', '', 'Готовим объяснение бюджета…'));
      try {
        const dataset = await getDataset();
        if (!current()) return;
        renderBudgetStory(panel, buildBudgetStory(dataset, detail.scenario, detail.result));
      } catch {
        if (!current()) return;
        panel.removeAttribute('aria-busy');
        const message = element('p', '', 'Объяснение бюджета пока недоступно. Результат расчёта выше сохранён.');
        message.setAttribute('role', 'status');
        const retry = element('button', 'bs-retry', 'Повторить объяснение бюджета');
        retry.type = 'button';
        retry.addEventListener('click', () => void load());
        panel.replaceChildren(message, retry);
      }
    };
    void load();
  });
}
