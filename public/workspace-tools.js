const DRAFT_KEY = 'ascension.workspace.draft.v1';
const LIBRARY_KEY = 'ascension.workspace.library.v1';
const $ = id => document.getElementById(id);
const number = value => Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 3 });

// Stored files and links contain only decisions. The server validates and calculates them again.
export function cleanScenario(input) {
  if (!input || !Array.isArray(input.decisions) || input.decisions.length > 5) return null;
  const ids = new Set();
  for (const item of input.decisions) {
    if (!item || !/^M(?:[1-9]|1[0-4])$/.test(item.measureId) || ids.has(item.measureId)) return null;
    if (item.districtId !== undefined && !['esil', 'almaty', 'saryarka', 'baik onur'.replace(' ', ''), 'nura'].includes(item.districtId)) return null;
    ids.add(item.measureId);
  }
  return { decisions: input.decisions.map(({ measureId, districtId }) => districtId === undefined ? { measureId } : { measureId, districtId }) };
}

export function readDraft() {
  try { return cleanScenario(JSON.parse(localStorage.getItem(DRAFT_KEY))); } catch { return null; }
}

export function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function resultCsv(result, dataset) {
  const rows = [['Район', 'Код', 'Показатель', 'До', 'После', 'Изменение', 'Критический после (<40)']];
  for (const district of result.districts) {
    for (const indicator of dataset.indicators) rows.push([district.name, indicator.id, indicator.name,
      district.before[indicator.id], district.after[indicator.id], district.delta[indicator.id], district.after[indicator.id] < 40 ? 'Да' : 'Нет']);
  }
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(';')).join('\r\n');
}

function download(name, contents, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let initialized = false;
export function initializeWorkspaceTools() {
  if (initialized) return;
  initialized = true;
  let current = { decisions: [] }, latest = null, library = [];
  try {
    const stored = JSON.parse(localStorage.getItem(LIBRARY_KEY));
    if (Array.isArray(stored)) library = stored.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string'
      && cleanScenario(item.scenario) && item.scenario.decisions.length).slice(0, 12)
      .map(item => ({ id: item.id, name: item.name.slice(0, 80), scenario: cleanScenario(item.scenario) }));
  } catch { /* A damaged browser store must not prevent calculation. */ }

  function saveLibrary(next) {
    try { localStorage.setItem(LIBRARY_KEY, JSON.stringify(next)); library = next; renderLibrary(); return true; }
    catch { $('library-status').textContent = 'Браузер не разрешил сохранение. Освободите место или разрешите хранение данных.'; return false; }
  }
  function renderLibrary() {
    $('local-scenarios').replaceChildren();
    if (!library.length) { $('local-scenarios').textContent = 'Здесь появятся ваши сохранённые планы.'; return; }
    for (const item of library) {
      const row = document.createElement('article'); row.className = 'library-item';
      const info = document.createElement('div');
      const title = document.createElement('strong'); title.textContent = item.name;
      const subtitle = document.createElement('span'); subtitle.textContent = `${item.scenario.decisions.length} из 5 решений · ${item.scenario.decisions.map(d => d.measureId).join(', ')}`;
      info.append(title, subtitle);
      const load = document.createElement('button'); load.type = 'button'; load.className = 'retry-button'; load.textContent = 'Загрузить';
      load.setAttribute('aria-label', `Загрузить сценарий ${item.name}`);
      load.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('scenario:load', { detail: { scenario: structuredClone(item.scenario) } }));
        $('local-scenario-name').value = item.name;
        location.hash = 'workspace';
      });
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'retry-button'; remove.textContent = 'Удалить';
      remove.setAttribute('aria-label', `Удалить сценарий ${item.name}`);
      remove.addEventListener('click', () => {
        if (saveLibrary(library.filter(entry => entry.id !== item.id))) $('library-status').textContent = `Вариант «${item.name}» удалён. Текущий план сохранён.`;
      });
      row.append(info, load, remove); $('local-scenarios').append(row);
    }
  }
  $('local-scenario-form').addEventListener('submit', event => {
    event.preventDefault();
    const name = $('local-scenario-name').value.trim();
    if (!name || !current.decisions.length) { $('library-status').textContent = 'Введите название и добавьте хотя бы одну инициативу.'; return; }
    if (library.length >= 12) { $('library-status').textContent = 'Сохранено 12 вариантов. Удалите ненужный, чтобы добавить новый.'; return; }
    if (saveLibrary([...library, { id: crypto.randomUUID(), name, scenario: structuredClone(current) }])) $('library-status').textContent = `Вариант «${name}» сохранён в этом браузере.`;
  });
  window.addEventListener('scenario:changed', event => {
    current = cleanScenario(event.detail?.scenario) || { decisions: [] };
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(current));
      $('draft-status').textContent = current.decisions.length ? 'Черновик сохранён в этом браузере.' : 'Новый план. Изменения сохраняются автоматически.';
    } catch { $('draft-status').textContent = 'Автосохранение недоступно в этом браузере. Держите страницу открытой.'; }
  });
  window.addEventListener('scenario:invalidated', () => {
    latest = null; $('result-actions').hidden = true; $('share-link-field').hidden = true;
    $('result-action-status').textContent = '';
  });
  window.addEventListener('scenario:calculated', event => {
    latest = structuredClone(event.detail); $('result-actions').hidden = false;
    $('result-action-status').textContent = 'Расчёт учебной модели. Выгрузка содержит точные значения до округления.';
  });
  $('export-result').addEventListener('click', () => {
    if (!latest) return;
    download('ascension-scenario.json', JSON.stringify({ schemaVersion: 1, synthetic: true, exportedAt: new Date().toISOString(),
      scenario: cleanScenario(latest.scenario), result: latest.result }, null, 2), 'application/json;charset=utf-8');
    $('result-action-status').textContent = 'Расчёт подготовлен к скачиванию.';
  });
  $('export-indicators').addEventListener('click', () => {
    if (!latest) return;
    download('ascension-indicators.csv', resultCsv(latest.result, latest.dataset), 'text/csv;charset=utf-8');
    $('result-action-status').textContent = '50 показателей с изменениями подготовлены к скачиванию.';
  });
  $('share-result').addEventListener('click', async () => {
    if (!latest) return;
    const url = new URL('/', location.origin);
    url.searchParams.set('plan', JSON.stringify(cleanScenario(latest.scenario))); url.hash = 'results';
    $('share-link').value = url.href; $('share-link-field').hidden = false;
    try {
      await navigator.clipboard.writeText(url.href);
      $('result-action-status').textContent = 'Ссылка скопирована. При открытии сервер заново рассчитает этот план.';
    } catch {
      $('share-link').focus(); $('share-link').select();
      $('result-action-status').textContent = 'Выделенная ссылка готова для копирования. Она содержит только выбранные меры и районы.';
    }
  });
  $('print-result').addEventListener('click', () => {
    if (!latest) return;
    let report = $('scenario-print-report');
    if (!report) { report = document.createElement('section'); report.id = 'scenario-print-report'; document.body.append(report); }
    report.replaceChildren();
    const line = (tag, text) => { const node = document.createElement(tag); node.textContent = text; report.append(node); };
    line('h1', 'ASCENSION · Результат сценария');
    line('p', `Учебная модель · ${new Date().toLocaleDateString('ru-RU')} · горизонт ${latest.dataset.horizon} кварталов`);
    line('h2', `Score: ${number(latest.result.score)} · изменение: ${number(latest.result.deltaScore)}`);
    line('p', `Бюджет: ${latest.result.totalCost} из ${latest.dataset.budget}. Критических показателей: ${latest.result.criticalCount}.`);
    line('h2', 'План решений');
    for (const decision of latest.scenario.decisions) {
      const measure = latest.dataset.measures.find(m => m.id === decision.measureId);
      const district = latest.dataset.districts.find(d => d.id === decision.districtId);
      line('p', `${measure.id} · ${measure.name} · ${district?.name || 'Весь город'} · ${measure.cost} у. е.`);
    }
    line('h2', 'Результат по районам');
    for (const district of latest.result.districts) line('p', `${district.name}: ${number(district.beforeScore)} → ${number(district.afterScore)}. Критических показателей: ${Object.values(district.after).filter(value => value < 40).length}.`);
    line('p', 'Score = 0,7 × средняя оценка с учётом населения + 0,3 × оценка слабейшего района − число значений ниже 40. Данные синтетические; это не прогноз для реального города.');
    document.body.classList.add('printing-scenario');
    window.print();
  });
  window.addEventListener('afterprint', () => document.body.classList.remove('printing-scenario'));
  renderLibrary();
}
