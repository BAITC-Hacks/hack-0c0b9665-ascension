// Presentation only: every metric and delta comes from the official simulator.
const metricDefinitions = [
  ['score', 'Городской Score', 'maximizeScore'],
  ['worstDistrictScore', 'Слабейший район', 'maximizeWorst'],
  ['totalCost', 'Стоимость, у. е.', 'minimizeCost'],
  ['criticalCount', 'Критических показателей', null],
];
const priorityLabels = {
  maximizeScore: 'Приоритет: Score',
  maximizeWorst: 'Приоритет: слабый район',
  minimizeCost: 'Приоритет: стоимость',
  tradeoff: 'Другой компромисс',
};
const numberFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonnegativeInteger = (value) => Number.isInteger(value) && value >= 0;
const validCatalog = (value) => record(value) && Array.isArray(value.measures)
  && Array.isArray(value.districts) ? value : null;

function validDecision(value) {
  return record(value) && typeof value.measureId === 'string' && value.measureId.trim()
    && (!Object.hasOwn(value, 'districtId')
      || (typeof value.districtId === 'string' && value.districtId.trim()));
}

function snapshot(detail) {
  try {
    const copy = structuredClone(detail);
    if (!record(copy) || !record(copy.scenario) || !record(copy.result)) return null;
    const decisions = copy.scenario.decisions;
    if (!Array.isArray(decisions) || decisions.length !== 5 || !decisions.every(validDecision)
      || new Set(decisions.map(({ measureId }) => measureId)).size !== 5) return null;
    const result = copy.result;
    if (result.valid !== true || !metricDefinitions.every(([key]) => finite(result[key]))
      || result.totalCost < 0 || !nonnegativeInteger(result.criticalCount)
      || !Array.isArray(result.districts) || result.districts.length !== 5
      || !result.districts.every((district) => record(district)
        && typeof district.id === 'string' && typeof district.name === 'string'
        && finite(district.afterScore))) return null;
    // Send only the public scenario contract; never forward unrelated event fields.
    return { scenario: { decisions: decisions.map(({ measureId, districtId }) =>
      districtId === undefined ? { measureId } : { measureId, districtId }) }, result };
  } catch {
    return null;
  }
}

function scenarioKey(scenario) {
  return JSON.stringify(scenario.decisions.map(({ measureId, districtId }) =>
    [measureId, districtId ?? null]).sort((a, b) => a[0].localeCompare(b[0])));
}

function validateResponse(data, expectedScenario) {
  if (!record(data) || data.valid !== true || data.scope !== 'single-decision-neighborhood'
    || typeof data.exhaustiveWithinScope !== 'boolean' || typeof data.truncated !== 'boolean'
    || !['explored', 'validCandidates', 'paretoCandidates', 'limit'].every((key) => nonnegativeInteger(data[key]))
    || !Array.isArray(data.options)) return false;
  const baseline = snapshot(data.baseline);
  if (!baseline || scenarioKey(baseline.scenario) !== scenarioKey(expectedScenario)) return false;
  return data.options.every((option) => record(option) && typeof option.id === 'string'
    && snapshot(option) && record(option.delta)
    && metricDefinitions.every(([key]) => finite(option.delta[key]))
    && record(option.changed) && validDecision(option.changed.removed) && validDecision(option.changed.added)
    && record(option.objectives) && ['maximizeScore', 'maximizeWorst', 'minimizeCost']
      .every((key) => ['improved', 'unchanged', 'worse'].includes(option.objectives[key]))
    && Array.isArray(option.selectedFor) && option.selectedFor.every((key) => Object.hasOwn(priorityLabels, key)));
}

function signed(value) {
  const rounded = Number(value.toFixed(2));
  return `${rounded > 0 ? '+' : ''}${numberFormat.format(rounded === 0 ? 0 : rounded)}`;
}

/** Mount once per container. Returns a cleanup handle; importing does not touch DOM. */
export function mountPolicyOptionsPanel(container, {
  endpoint = '/api/policy-options', fetcher = globalThis.fetch,
  dataset = null, city = null, timeoutMs = 12000,
} = {}) {
  if (!container?.ownerDocument || typeof container.append !== 'function') {
    throw new TypeError('Для панели альтернатив нужен DOM-контейнер.');
  }
  if (typeof fetcher !== 'function' || !finite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Нужны fetcher и положительный timeoutMs.');
  }
  const document = container.ownerDocument;
  const window = document.defaultView;
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const root = element('section', 'policy-options-root');
  root.setAttribute('aria-label', 'Альтернативы решения');
  const heading = element('div', 'policy-options-heading');
  const headingCopy = element('div', 'policy-options-heading-copy');
  headingCopy.append(element('p', 'policy-options-eyebrow', 'ПРОВЕРЕННЫЕ ЗАМЕНЫ'),
    element('h2', 'policy-options-title', 'Что можно сделать иначе'));
  const findButton = element('button', 'policy-options-find', 'Найти альтернативы');
  findButton.type = 'button';
  heading.append(headingCopy, findButton);
  const intro = element('p', 'policy-options-intro',
    'Сравниваем допустимые замены одного решения. Это не поиск глобального оптимума.');
  const verificationNote = element('p', 'policy-options-verification',
    'Предварительный расчёт на вашем устройстве по модели кейса. После загрузки варианта нажмите «Рассчитать» для проверки сервером.');
  const status = element('p', 'policy-options-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  const baselineArea = element('div', 'policy-options-baseline');
  const summary = element('div', 'policy-options-summary');
  const cards = element('div', 'policy-options-cards');
  root.append(heading, intro, verificationNote, status, baselineArea, summary, cards);
  container.append(root);

  let available = city?.hasScenarioData === true;
  let current = null;
  let sequence = 0;
  let pending = null;
  let destroyed = false;
  let catalog = validCatalog(dataset);

  function setStatus(message, error = false) {
    status.textContent = message;
    status.className = `policy-options-status${error ? ' policy-options-error' : ''}`;
  }

  function updateButton() {
    findButton.disabled = destroyed || !available || !current || Boolean(pending);
    findButton.textContent = pending ? 'Ищем допустимые замены…' : 'Найти альтернативы';
    cards.setAttribute('aria-busy', String(Boolean(pending)));
  }

  function cancel() {
    sequence += 1;
    if (pending) {
      pending.controller.abort();
      clearTimeout(pending.timer);
      pending = null;
    }
  }

  function clear(message) {
    cancel();
    current = null;
    baselineArea.replaceChildren();
    summary.replaceChildren();
    cards.replaceChildren();
    setStatus(!available ? 'Для выбранного города нет данных модели. Альтернативы недоступны.' : message);
    updateButton();
  }

  function weakestNames(result) {
    return result.districts.filter(({ afterScore }) => Math.abs(afterScore - result.worstDistrictScore) < 1e-8)
      .map(({ name }) => name).join(', ');
  }

  function renderMetrics(result, delta = null, objectives = {}) {
    const metrics = element('dl', 'policy-options-metrics');
    for (const [key, label, objective] of metricDefinitions) {
      const row = element('div', 'policy-options-metric');
      const value = element('dd', 'policy-options-value', numberFormat.format(result[key]));
      if (delta) {
        const change = element('span', `policy-options-delta policy-options-${objectives[objective] ?? 'neutral'}`,
          `${signed(delta[key])} к вашему плану`);
        value.append(change);
      }
      row.append(element('dt', 'policy-options-label', label), value);
      if (key === 'worstDistrictScore') {
        row.append(element('dd', 'policy-options-district', weakestNames(result)));
      }
      metrics.append(row);
    }
    return metrics;
  }

  function renderBaseline(result) {
    baselineArea.replaceChildren(element('p', 'policy-options-baseline-label', 'Ваш рассчитанный план'),
      renderMetrics(result));
  }

  function decisionName(decision) {
    const measure = catalog?.measures?.find(({ id }) => id === decision.measureId);
    const district = catalog?.districts?.find(({ id }) => id === decision.districtId)
      ?? current?.result.districts.find(({ id }) => id === decision.districtId);
    return `${decision.measureId} · ${measure?.name ?? 'Мера'} — ${decision.districtId
      ? district?.name ?? decision.districtId : 'весь город'}`;
  }

  function renderResponse(data) {
    renderBaseline(data.baseline.result);
    summary.replaceChildren();
    cards.replaceChildren();
    const coverage = data.exhaustiveWithinScope ? 'Все замены одного решения проверены.'
      : 'Проверена только часть замен одного решения.';
    summary.append(element('p', 'policy-options-coverage',
      `${coverage} Проверено: ${data.explored}. Допустимых: ${data.validCandidates}. Вариантов без доминирования: ${data.paretoCandidates}.`));
    if (!catalog) summary.append(element('p', 'policy-options-limit',
      'Названия мер недоступны. Меры обозначены кодами из каталога.'));
    if (!data.options.length) {
      setStatus(typeof data.emptyReason?.message === 'string' ? data.emptyReason.message
        : 'Подходящих альтернатив в проверенных заменах не найдено.');
      return;
    }
    summary.append(element('p', 'policy-options-explanation',
      'Это варианты Парето: среди проверенных замен и вашего плана нет другого варианта не хуже по всем трём целям и лучше хотя бы по одной. Выбирайте, какой компромисс подходит городу.'));
    if (data.truncated) summary.append(element('p', 'policy-options-limit',
      `Показано ${data.options.length} из ${data.paretoCandidates} вариантов. Список ограничен; это не все найденные компромиссы.`));
    for (const [index, option] of data.options.entries()) {
      const card = element('article', 'policy-options-card');
      const tags = element('div', 'policy-options-tags');
      for (const priority of option.selectedFor) tags.append(element('span', 'policy-options-tag', priorityLabels[priority]));
      card.append(tags, element('h3', 'policy-options-card-title', `Вариант ${index + 1}`));
      const change = element('div', 'policy-options-change');
      change.append(element('p', 'policy-options-change-label', 'Вместо'),
        element('p', 'policy-options-removed', decisionName(option.changed.removed)),
        element('p', 'policy-options-change-label', 'Выбрать'),
        element('p', 'policy-options-added', decisionName(option.changed.added)));
      card.append(change, renderMetrics(option.result, option.delta, option.objectives));
      const loadButton = element('button', 'policy-options-load', `Загрузить вариант ${index + 1}`);
      loadButton.type = 'button';
      const renderedSequence = sequence;
      loadButton.addEventListener('click', () => {
        if (destroyed || !available || !current || renderedSequence !== sequence) return;
        const scenario = snapshot(option).scenario;
        clear('Вариант передан в форму для проверки. Запустите расчёт, чтобы увидеть новый результат.');
        window.dispatchEvent(new window.CustomEvent('scenario:load', { detail: { scenario } }));
        setStatus('Вариант передан в форму для проверки. Запустите расчёт, чтобы увидеть новый результат.');
      });
      card.append(loadButton);
      cards.append(card);
    }
    setStatus(`Найдено вариантов: ${data.options.length}. Дельты показаны относительно вашего рассчитанного плана.`);
  }

  async function requestOptions() {
    if (destroyed || !available || !current || pending) return;
    cancel();
    const requestSequence = sequence;
    const scenario = structuredClone(current.scenario);
    const controller = new AbortController();
    let timedOut = false;
    pending = { controller, timer: null };
    cards.replaceChildren();
    summary.replaceChildren();
    setStatus('Проверяем замены по правилам модели.');
    updateButton();
    try {
      const timeout = new Promise((_, reject) => {
        pending.timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error('TIMEOUT'));
        }, timeoutMs);
      });
      const work = async () => {
        const response = await fetcher(endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(scenario), signal: controller.signal,
        });
        if (!response.ok) {
          if (response.status === 404) throw new Error('Расчёт альтернатив пока не подключён. Ваш основной результат сохранён.');
          if (response.status === 503) throw new Error('Поиск альтернатив временно недоступен. Попробуйте позже.');
          if (response.status === 422) throw new Error('Модель не приняла этот план. Проверьте решения и рассчитайте сценарий снова.');
          throw new Error(`Не удалось получить альтернативы (HTTP ${response.status}). Попробуйте ещё раз.`);
        }
        const data = await response.json();
        if (!validateResponse(data, scenario)) throw new Error('Расчёт альтернатив вернул неполные или устаревшие данные. Пересчитайте план и повторите поиск.');
        let names = catalog;
        if (!names) {
          try {
            const response = await fetcher('/api/dataset', { signal: controller.signal });
            if (response.ok) names = validCatalog(await response.json());
          } catch { /* Metric results remain usable with IDs if names are unavailable. */ }
        }
        return { data, names };
      };
      const { data, names } = await Promise.race([work(), timeout]);
      if (destroyed || requestSequence !== sequence) return;
      catalog = names;
      renderResponse(data);
    } catch (error) {
      if (destroyed || requestSequence !== sequence) return;
      const message = timedOut ? 'Поиск занял слишком много времени. Попробуйте ещё раз.'
        : error instanceof TypeError || error instanceof SyntaxError
          ? 'Не удалось получить результат расчёта альтернатив. Повторите поиск; если ошибка остаётся, проверьте соединение и обновите страницу.'
          : error.message || 'Поиск альтернатив недоступен. Попробуйте ещё раз.';
      setStatus(message, true);
    } finally {
      if (requestSequence === sequence) {
        clearTimeout(pending?.timer);
        pending = null;
        updateButton();
      }
    }
  }

  const onCalculated = (event) => {
    clear('Сначала рассчитайте корректный план из пяти решений.');
    if (!available) return;
    current = snapshot(event.detail);
    if (!current) return;
    renderBaseline(current.result);
    setStatus('План рассчитан. Найдите альтернативы и сравните последствия одной замены.');
    updateButton();
  };
  const onInvalidated = () => clear('План изменён. Рассчитайте его снова перед поиском альтернатив.');
  const onCityChanged = (event) => {
    available = event.detail?.hasScenarioData === true;
    clear('Город изменён. Рассчитайте план, чтобы найти альтернативы.');
  };
  const listeners = [
    ['scenario:calculated', onCalculated], ['scenario:invalidated', onInvalidated],
    ['scenario:load', onInvalidated], ['city:changed', onCityChanged],
  ];
  for (const [name, listener] of listeners) window.addEventListener(name, listener);
  findButton.addEventListener('click', requestOptions);
  clear('Сначала рассчитайте корректный план из пяти решений.');
  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancel();
      for (const [name, listener] of listeners) window.removeEventListener(name, listener);
      findButton.removeEventListener('click', requestOptions);
      root.remove();
    },
  };
}
