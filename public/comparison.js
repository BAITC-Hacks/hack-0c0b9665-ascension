// Browser-only consumer of the integration contract; all scores come from the core.
const metrics = [
  ['score', 'Качество жизни'],
  ['totalCost', 'Потрачено'],
  ['remainingBudget', 'Остаток бюджета'],
  ['criticalCount', 'Критических показателей'],
  ['worstDistrictScore', 'Оценка худшего района'],
];
const numberFormat = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

// Validate the event shape, not the city's mathematical rules. Reject a whole
// damaged event before touching either slot. Clone first, keeping full precision.
function snapshot(detail) {
  try {
    const copy = structuredClone(detail);
    if (!isRecord(copy) || !isRecord(copy.scenario) || !isRecord(copy.result)) return null;
    const { scenario, result } = copy;
    if (result.valid !== true || !Array.isArray(scenario.decisions)
      || scenario.decisions.length !== 5) return null;
    const ids = new Set();
    for (const decision of scenario.decisions) {
      if (!isRecord(decision) || typeof decision.measureId !== 'string'
        || !decision.measureId.trim() || ids.has(decision.measureId)) return null;
      if (Object.hasOwn(decision, 'districtId')
        && (typeof decision.districtId !== 'string' || !decision.districtId.trim())) return null;
      ids.add(decision.measureId);
    }
    if (!metrics.every(([key]) => finite(result[key]))) return null;
    if (result.totalCost < 0 || result.remainingBudget < 0
      || !Number.isInteger(result.criticalCount) || result.criticalCount < 0) return null;
    if (!Array.isArray(result.districts) || result.districts.length !== 5) return null;
    const districts = new Set();
    for (const district of result.districts) {
      if (!isRecord(district) || typeof district.id !== 'string' || !district.id.trim()
        || typeof district.name !== 'string' || !district.name.trim()
        || !finite(district.afterScore) || districts.has(district.id)) return null;
      districts.add(district.id);
    }
    return { scenario, result };
  } catch {
    // Non-cloneable details (functions, proxies, etc.) cannot corrupt saved results.
    return null;
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function mount() {
  const host = document.getElementById('comparison-panel');
  if (!host || host.dataset.comparisonMounted === 'true') return;
  host.dataset.comparisonMounted = 'true';
  const root = element('div', 'comparison-root');
  const title = element('h2', 'comparison-title', 'Сравнение сценариев');
  title.id = 'comparison-heading';
  root.setAttribute('role', 'region');
  root.setAttribute('aria-labelledby', title.id);
  const intro = element('p', 'comparison-intro',
    'Рассчитайте два варианта. Здесь сохраняются два последних результата: A — предыдущий, B — новый.');
  const status = element('p', 'comparison-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  const slots = element('div', 'comparison-slots');
  const districtArea = element('div', 'comparison-districts');
  root.append(title, intro, slots, districtArea, status);
  host.append(root);
  let saved = [];

  function render() {
    const disclosure = document.getElementById('comparison-details');
    if (disclosure) disclosure.hidden = saved.length < 2;
    slots.replaceChildren();
    for (let index = 0; index < 2; index += 1) {
      const label = index === 0 ? 'A' : 'B';
      const value = saved[index];
      const card = element('article', 'comparison-slot');
      const heading = element('h3', 'comparison-slot-title', `Сценарий ${label}`);
      heading.id = `comparison-slot-${label}`;
      card.setAttribute('aria-labelledby', heading.id);
      card.append(heading);
      if (value) {
        const list = element('dl', 'comparison-metrics');
        for (const [key, name] of metrics) {
          const row = element('div', 'comparison-metric');
          row.append(element('dt', 'comparison-label', name),
            element('dd', 'comparison-value', numberFormat.format(value.result[key])));
          list.append(row);
        }
        card.append(list);
      } else {
        card.append(element('p', 'comparison-empty', index === 0
          ? 'Пока нет результатов. Рассчитайте первый сценарий.'
          : 'Рассчитайте второй сценарий, чтобы сравнить его с A.'));
      }
      const load = element('button', 'comparison-load', `Загрузить ${label}`);
      load.type = 'button';
      load.disabled = !value;
      load.addEventListener('click', () => {
        if (!value) return;
        // The main app owns loading and recalculation. Its consumers may mutate
        // this outgoing copy without changing our stored scenario.
        window.dispatchEvent(new CustomEvent('scenario:load', {
          detail: { scenario: structuredClone(value.scenario) },
        }));
        status.textContent = `Сценарий ${label} передан в форму. Для нового результата запустите расчёт.`;
      });
      card.append(load);
      slots.append(card);
    }
    renderDistricts();
  }

  function renderDistricts() {
    districtArea.replaceChildren();
    if (!saved.length) return;
    const table = element('table', 'comparison-table');
    table.append(element('caption', 'comparison-caption', 'Оценки районов · разница B − A'));
    const head = element('thead');
    const header = element('tr');
    for (const name of ['Район', 'A', 'B', 'B − A']) {
      const cell = element('th', 'comparison-cell', name);
      cell.scope = 'col';
      header.append(cell);
    }
    head.append(header);
    const body = element('tbody');
    const first = new Map(saved[0].result.districts.map((district) => [district.id, district]));
    const second = new Map((saved[1]?.result.districts ?? []).map((district) => [district.id, district]));
    for (const id of new Set([...first.keys(), ...second.keys()])) {
      const a = first.get(id);
      const b = second.get(id);
      const row = element('tr');
      const name = element('th', 'comparison-cell comparison-district-name', (a ?? b).name);
      name.scope = 'row';
      row.append(name);
      for (const value of [a?.afterScore, b?.afterScore]) {
        row.append(element('td', 'comparison-cell', value === undefined ? 'Нет данных' : numberFormat.format(value)));
      }
      const delta = a && b ? b.afterScore - a.afterScore : undefined;
      // Avoid misleading +0.00/-0.00 after display rounding.
      const roundedDelta = delta === undefined ? undefined : Number(delta.toFixed(2));
      const change = element('td', 'comparison-cell', delta === undefined ? 'Нет данных'
        : `${roundedDelta > 0 ? '+' : ''}${numberFormat.format(roundedDelta === 0 ? 0 : delta)}`);
      if (roundedDelta > 0) change.classList.add('comparison-increase');
      if (roundedDelta < 0) change.classList.add('comparison-decrease');
      row.append(change);
      body.append(row);
    }
    table.append(head, body);
    districtArea.append(table);
  }

  window.addEventListener('scenario:calculated', (event) => {
    const value = snapshot(event.detail);
    if (!value) {
      status.textContent = 'Результат не сохранён: нужны корректные данные успешного расчёта. Предыдущие сценарии сохранены.';
      return;
    }
    saved = [...saved, value].slice(-2);
    render();
    status.textContent = saved.length === 1
      ? 'Сценарий A сохранён. Рассчитайте второй вариант.'
      : 'Сохранены два последних сценария. Сравнение A и B обновлено.';
  });
  render();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
