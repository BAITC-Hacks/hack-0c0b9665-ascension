const number = (value, digits = 2) => Number.isFinite(value) ? value.toLocaleString('ru-RU', { maximumFractionDigits: digits }) : '—';
const signed = (value) => `${value > 0 ? '+' : ''}${number(value)}`;
const monthsLabel = (months) => `${months} ${months % 100 >= 11 && months % 100 <= 14 ? 'месяцев' : months % 10 === 1 ? 'месяц' : months % 10 >= 2 && months % 10 <= 4 ? 'месяца' : 'месяцев'}`;
const labels = {
  workspace: ['Конструктор решений', 'Соберите план вручную и проверьте ограничения'],
  results: ['Результат сценария', 'Числа, эффекты мер и объяснение'],
  city: ['Показатели районов', 'Все районы и показатели учебной модели'],
  'policy-options-panel': ['Альтернативы решений', 'Найдите другой набор при том же бюджете'],
  'comparison-panel': ['Сравнение сценариев', 'Сопоставьте два рассчитанных плана'],
  'scenario-library': ['Мои сценарии', 'Сохраните и загрузите ваши планы'],
  'decision-brief': ['Записка по решению', 'Обоснование рассчитанного плана'],
  'action-register-panel': ['Поручения и исполнение', 'Ответственные, сроки и состояние исполнения'],
  'evidence-register': ['Паспорта данных', 'Источники и ограничения показателей'],
  method: ['Как устроена модель', 'Формула, ограничения и источники данных'],
};

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function readable(value) {
  return typeof value === 'string' ? value : value?.message || value?.description || value?.reason || '';
}

/** Map-first shell. Existing app nodes are moved, never copied or re-bound. */
export function mountCommandCenter({ dataset, baseline, map } = {}) {
  if (document.getElementById('ascension-command-center')) return null;
  const mapHost = document.getElementById('city-map');
  if (!mapHost || !dataset || !baseline) return null;
  const root = element('div', 'cc-shell');
  root.id = 'ascension-command-center';
  root.innerHTML = `
    <header class="cc-header">
      <a class="cc-brand" href="/" aria-label="ASCENSION — главная"><img class="cc-brand-mark" src="/assets/design/ascension-mark.svg" width="36" height="42" alt=""><span>ASCENSION<small>Учебная модель Астаны</small></span></a>
      <div class="cc-territory"><span class="cc-live-dot" aria-hidden="true"></span><strong>Астана</strong><span>3D · городская модель</span></div>
      <div class="cc-header-actions"></div>
    </header>
    <section class="cc-ai cc-glass" aria-labelledby="cc-ai-title">
      <button class="cc-ai-toggle" type="button" aria-expanded="true" aria-controls="cc-ai-content"><span class="cc-ai-symbol" aria-hidden="true">✦</span><span><strong id="cc-ai-title">Ascension AI</strong><small>От идеи — к городскому сценарию</small></span><span class="cc-ai-chevron" aria-hidden="true">−</span></button>
      <div id="cc-ai-content" class="cc-ai-content">
        <p class="cc-ai-intro">Что вы хотите изменить в городе?</p>
        <form class="cc-ai-form">
          <label class="sr-only" for="cc-plan-prompt">Ваш план для Астаны</label>
          <textarea id="cc-plan-prompt" rows="4" minlength="1" maxlength="4000" required placeholder="Например: улучшить школы и медицину в Нуре, сделать улицы безопаснее и снизить загрязнение воздуха…"></textarea>
          <div class="cc-prompt-examples"><button type="button" data-example="nura">Помочь Нуре</button><button type="button" data-example="transport">Транспорт и воздух</button></div>
          <button class="cc-primary cc-plan-submit" type="submit"><span aria-hidden="true">✦</span> Оценить мой план <span aria-hidden="true">↗</span></button>
        </form>
        <p class="cc-ai-status" role="status" aria-live="polite">AI предложит меры из каталога. Итог проверит расчётная модель.</p>
        <div class="cc-recovery-actions" aria-label="Выбор плана без AI"><button type="button" data-panel="workspace">Собрать план вручную</button><button type="button" data-quick-action="demo">Открыть пример</button></div>
        <div class="cc-plan-preview" hidden></div>
        <button class="cc-primary cc-apply-plan" type="button" hidden disabled>Применить и показать <span aria-hidden="true">↗</span></button>
        <p class="cc-ai-footnote">Карта OpenStreetMap · учебные показатели.<br>Это сценарий по данным кейса, а не прогноз для Астаны.</p>
      </div>
    </section>
    <section class="cc-kpis cc-glass" aria-label="Ключевые показатели города">
      <div class="cc-kpi-top"><span class="cc-kicker">КАЧЕСТВО ЖИЗНИ</span><span class="cc-kpi-phase">До решений</span></div>
      <div class="cc-score-row"><strong class="cc-score">—</strong><span class="cc-score-delta">из 100</span></div>
      <div class="cc-kpi-details"><div><span>Бюджет плана</span><strong class="cc-budget">0 / 100</strong></div><div><span>Критических значений</span><strong class="cc-critical">—</strong></div></div>
      <button class="cc-link-button" type="button" data-panel="results">Подробнее о результате <span aria-hidden="true">↗</span></button>
    </section>
    <section class="cc-timeline cc-glass" aria-label="Изменение города по кварталам">
      <div class="cc-timeline-heading"><div><span class="cc-kicker">СИМУЛЯЦИЯ ГОРОДА</span><strong class="cc-quarter">Горизонт · 8 кварталов</strong></div><span class="cc-timeline-state">Сначала рассчитайте план</span></div>
      <div class="cc-timeline-controls"><button class="cc-play" type="button" disabled aria-label="Воспроизвести симуляцию" aria-pressed="false">▶</button><div class="cc-range-wrap"><label class="sr-only" for="cc-quarter-range">Квартал симуляции</label><input id="cc-quarter-range" type="range" min="0" max="8" step="1" value="0" disabled><div class="cc-ticks" aria-hidden="true"><span>Сейчас</span><span>1 год</span><span>2 года</span></div></div><output class="cc-quarter-score" for="cc-quarter-range">—</output></div>
      <p class="cc-timeline-note">Эффекты появляются с задержкой реализации. Учебная модель.</p>
    </section>
    <nav class="cc-dock cc-glass" aria-label="Инструменты города">
      <a href="/"><span aria-hidden="true">⌂</span><span>Обзор</span></a>
      <button type="button" data-action="ai" aria-controls="cc-ai-content" aria-expanded="true"><span aria-hidden="true">✦</span><span>Ascension AI</span></button>
      <button type="button" data-panel="workspace"><span aria-hidden="true">▦</span><span>План решений</span></button>
      <button type="button" data-panel="results"><span aria-hidden="true">↗</span><span>Результат</span></button>
      <button type="button" data-panel="city"><span aria-hidden="true">◫</span><span>Районы</span></button>
      <button type="button" data-action="layers" aria-expanded="false"><span aria-hidden="true">◇</span><span>Карта и слои</span></button>
      <button type="button" data-panel="tools"><span aria-hidden="true">···</span><span>Инструменты</span></button>
      <a href="/citizens.html"><span aria-hidden="true">◇</span><span>Обращения</span></a>
      <a href="/mayor.html"><span aria-hidden="true">▤</span><span>Кабинет акимата</span></a>
    </nav>
    <aside class="cc-drawer cc-glass" role="dialog" aria-modal="false" aria-labelledby="cc-drawer-title" hidden><div class="cc-drawer-heading"><div><span class="cc-kicker">РАБОЧЕЕ ПРОСТРАНСТВО</span><h2 id="cc-drawer-title"></h2></div><button class="cc-close" type="button" aria-label="Закрыть панель">×</button></div><div class="cc-drawer-content"></div></aside>
    <span class="cc-model-badge">Учебная модель · кейс 12</span>`;
  document.body.append(root);
  const $ = (selector) => root.querySelector(selector);
  const restore = [];
  const listeners = [];
  const listen = (target, name, handler, options) => { target.addEventListener(name, handler, options); listeners.push(() => target.removeEventListener(name, handler, options)); };
  const move = (node, destination) => {
    if (!node) return;
    const marker = document.createComment(`command-center:${node.id || node.className}`);
    node.before(marker);
    restore.push(() => { marker.replaceWith(node); });
    destination.append(node);
  };
  move(mapHost, root);
  // Keep map-owned controls under its host so its selectors and listeners work.
  const mapSettings = element('div', 'cc-map-settings cc-glass');
  mapSettings.setAttribute('aria-label', 'Настройки карты и районов');
  mapHost.append(mapSettings);
  restore.push(() => mapSettings.remove());
  for (const selector of ['.citymap-toolbar', '.citymap-sector-toolbar', '.citymap-data-toolbar', '.citymap-district-list']) {
    move(mapHost.querySelector(selector), mapSettings);
  }
  move(document.querySelector('.hero-actions'), $('.cc-header-actions'));
  const panes = new Map();
  function addPane(id, nodes, title, description) {
    const pane = element('div', 'cc-pane');
    pane.dataset.panel = id;
    pane.hidden = true;
    nodes.forEach((node) => move(node, pane));
    $('.cc-drawer-content').append(pane);
    panes.set(id, { pane, title, description });
  }
  for (const [id, [title, description]] of Object.entries(labels)) {
    const node = document.getElementById(id);
    if (!node) continue;
    const nodes = id === 'results' ? [document.querySelector('.overview-grid'), node] : id === 'city' ? [document.getElementById('district-focus'), node] : [node];
    addPane(id, nodes.filter(Boolean), title, description);
  }
  // Known module hosts are found by ID even inside compact <details> wrappers.
  // Keep a fallback for additional top-level modules from the full layout.
  for (const node of [...document.querySelectorAll('#app > section')]) {
    if (!node.id || node.id === 'map-section' || panes.has(node.id)) continue;
    addPane(node.id, [node], node.querySelector('h2, h3')?.textContent || 'Дополнительный модуль', 'Открыть инструмент');
  }
  const transitPanel = mapHost.querySelector('.transit-panel');
  if (transitPanel) {
    addPane('transit', [transitPanel], 'Автобусы и остановки', 'Каталог маршрутов и остановки OpenStreetMap');
  }
  const toolsPane = element('div', 'cc-pane cc-tools-pane');
  toolsPane.hidden = true;
  for (const [action, title, description] of [['demo', 'Загрузить демо', 'Официальный пример: 5 мер за 95 единиц'], ['reset', 'Начать заново', 'Очистить текущий план решений']]) {
    const button = element('button', 'cc-tool-card');
    button.type = 'button'; button.dataset.quickAction = action;
    button.append(element('strong', '', title), element('span', '', description));
    toolsPane.append(button);
  }
  for (const [id, panel] of panes) {
    const button = element('button', 'cc-tool-card');
    button.type = 'button'; button.dataset.panel = id;
    button.append(element('strong', '', panel.title), element('span', '', panel.description));
    toolsPane.append(button);
  }
  for (const [href, title, description] of [['/classic.html', 'Компактный симулятор', 'План и результаты на одной странице'], ['/mayor-overview.html', 'Рабочее пространство акима', 'Девять разделов: от обзора города до поручений'], ['/demo.html', 'Учебный маршрут', 'Пройдите пример решения за 90 секунд'], ['/citizens.html', 'Обращение жителя', 'Сообщите о городской проблеме'], ['/mayor.html', 'Обращения в акимате', 'Работа с обращениями и ответственными']]) {
    const link = element('a', 'cc-tool-card'); link.href = href;
    link.append(element('strong', '', title), element('span', '', description)); toolsPane.append(link);
  }
  $('.cc-drawer-content').append(toolsPane);
  panes.set('tools', { pane: toolsPane, title: 'Все инструменты' });

  const resultEmpty = element('div', 'cc-result-empty');
  resultEmpty.append(element('h3', '', 'Сначала выберите пять решений'),
    element('p', '', 'Соберите план в пределах 100 условных единиц и нажмите «Посмотреть результат». Здесь появятся Astana Quality of Life Score, сильные стороны, риски и последствия решений.'));
  const resultStart = element('button', 'cc-primary', 'Выбрать решения');
  resultStart.type = 'button'; resultStart.dataset.panel = 'workspace';
  const resultDemo = element('button', 'cc-link-button', 'Открыть официальный пример');
  resultDemo.type = 'button'; resultDemo.dataset.quickAction = 'demo';
  resultEmpty.append(resultStart, resultDemo);
  panes.get('results')?.pane.append(resultEmpty);

  let activePanel = null;
  let previousFocus = null;
  const compactScreen = window.matchMedia('(max-width: 760px)');
  let aiOpen = !compactScreen.matches;
  let modelAvailable = true;
  let frames = [];
  let frameIndex = 0;
  let timer = null;
  let request = null;
  let requestVersion = 0;
  let proposal = null;
  let applying = false;
  const openedDisclosures = new WeakSet();

  function clearProposal(message = '') {
    requestVersion++; request?.abort(); request = null; proposal = null;
    $('.cc-plan-preview').hidden = true;
    $('.cc-apply-plan').hidden = true;
    $('.cc-apply-plan').disabled = true;
    $('.cc-plan-submit').disabled = applying;
    $('.cc-plan-submit').textContent = 'Оценить мой план';
    if (message) { $('.cc-ai-status').textContent = message; $('.cc-ai-status').dataset.tone = ''; }
  }
  listen($('#cc-plan-prompt'), 'input', () => clearProposal('Запрос изменён. Оцените обновлённый план.'));

  function setAI(open) {
    aiOpen = open;
    root.classList.toggle('cc-ai-collapsed', !open);
    $('#cc-ai-content').hidden = !open;
    $('.cc-ai-toggle').setAttribute('aria-expanded', String(open));
    $('.cc-ai-chevron').textContent = open ? '−' : '+';
    $('[data-action="ai"]').setAttribute('aria-expanded', String(open));
  }
  function setLayers(open) {
    root.classList.toggle('cc-layers-open', open);
    $('[data-action="layers"]').setAttribute('aria-expanded', String(open));
    if (open) closePanel(false);
    window.dispatchEvent(new Event('resize'));
  }
  function closePanel(restoreFocus = true) {
    $('.cc-drawer').hidden = true;
    root.classList.remove('cc-drawer-open');
    activePanel = null;
    root.querySelectorAll('[data-panel]').forEach((node) => node.classList.remove('is-active'));
    if (restoreFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  }
  function openPanel(id) {
    if (id === 'map-section' || id === 'top') { closePanel(); return; }
    const panel = panes.get(id);
    if (!panel) return;
    if (!modelAvailable && !['tools', 'transit', 'action-register-panel', 'evidence-register', 'team-workspace-panel'].includes(id)) map?.setCity?.('astana');
    if (!activePanel) previousFocus = document.activeElement;
    activePanel = id;
    for (const disclosure of panel.pane.querySelectorAll(':scope > details')) {
      if (!openedDisclosures.has(disclosure)) {
        const initiallyOpen = disclosure.open;
        restore.push(() => { disclosure.open = initiallyOpen; });
        openedDisclosures.add(disclosure);
      }
      disclosure.open = true;
    }
    if (id === 'transit' && transitPanel) transitPanel.open = true;
    setLayers(false);
    panes.forEach(({ pane }, key) => { pane.hidden = key !== id; });
    $('#cc-drawer-title').textContent = panel.title;
    $('.cc-drawer').hidden = false;
    root.classList.add('cc-drawer-open');
    $('.cc-drawer-content').scrollTop = 0;
    root.querySelectorAll('button[data-panel]').forEach((node) => node.classList.toggle('is-active', node.dataset.panel === id));
    $('.cc-close').focus({ preventScroll: true });
  }
  listen(root, 'click', (event) => {
    if (event.target.closest('#focus-measures')) openPanel('workspace');
    const quickAction = event.target.closest('[data-quick-action]');
    if (quickAction) {
      document.getElementById(`${quickAction.dataset.quickAction}-button`)?.click();
      openPanel('workspace');
      return;
    }
    const control = event.target.closest('button[data-panel],a[data-panel]');
    if (control) { openPanel(control.dataset.panel); return; }
    if (event.target.closest('.cc-close')) closePanel();
    if (event.target.closest('.cc-ai-toggle,[data-action="ai"]')) { setAI(!aiOpen); closePanel(false); setLayers(false); }
    if (event.target.closest('[data-action="layers"]')) setLayers(!root.classList.contains('cc-layers-open'));
  });
  listen(document, 'click', (event) => {
    const link = event.target.closest('a[href^="#"]');
    if (!link?.hash) return;
    const id = decodeURIComponent(link.hash.slice(1));
    const pane = document.getElementById(id)?.closest('.cc-pane');
    const panelId = pane?.dataset.panel || id;
    if (panes.has(panelId) || ['top', 'map-section'].includes(panelId)) { event.preventDefault(); openPanel(panelId); }
  });
  listen(document, 'keydown', (event) => {
    if (event.key === 'Escape') { closePanel(); setLayers(false); }
  });
  listen($('.cc-header-actions'), 'click', (event) => {
    if (event.target.closest('#demo-button')) openPanel('workspace');
  });
  setAI(aiOpen);
  listen(compactScreen, 'change', (event) => { if (event.matches) setAI(false); });

  function updateMetrics(result, { quarter } = {}) {
    if (!result) return;
    $('.cc-score').textContent = number(result.score);
    $('.cc-score-delta').textContent = result.deltaScore ? signed(result.deltaScore) : 'из 100';
    $('.cc-score-delta').classList.toggle('cc-negative', result.deltaScore < 0);
    updateBudget();
    $('.cc-critical').textContent = number(result.criticalCount, 0);
    $('.cc-kpi-phase').textContent = quarter !== undefined ? quarter === 0 ? 'До решений' : `Квартал ${quarter}` : result === baseline ? 'До решений' : 'После решений';
  }
  function updateBudget() {
    const selectedCost = Number(document.getElementById('plan-total')?.textContent?.replace(/\s/g, '') || 0);
    $('.cc-budget').textContent = `${number(selectedCost, 0)} / ${dataset.budget}`;
  }
  const budgetNode = document.getElementById('plan-total');
  if (budgetNode) {
    const budgetObserver = new MutationObserver(updateBudget);
    budgetObserver.observe(budgetNode, { childList: true, characterData: true, subtree: true });
    listeners.push(() => budgetObserver.disconnect());
  }
  updateMetrics(baseline);
  function stopPlayback() {
    clearInterval(timer); timer = null;
    $('.cc-play').textContent = '▶';
    $('.cc-play').setAttribute('aria-label', 'Воспроизвести симуляцию');
    $('.cc-play').setAttribute('aria-pressed', 'false');
  }
  function showFrame(index) {
    frameIndex = Math.max(0, Math.min(frames.length - 1, index));
    const source = frames[frameIndex];
    if (!source) return;
    const frame = source.result || source;
    const quarter = Number.isFinite(source.quarter) ? source.quarter : frameIndex;
    $('#cc-quarter-range').value = String(frameIndex);
    $('#cc-quarter-range').setAttribute('aria-valuetext', quarter === 0 ? 'До решений' : `Квартал ${quarter}, Score ${number(frame.score)}`);
    $('.cc-quarter').textContent = quarter === 0 ? 'Город до решений' : `Квартал ${quarter} · ${monthsLabel(quarter * 3)}`;
    $('.cc-quarter-score').textContent = number(frame.score);
    updateMetrics(frame, { quarter });
    window.dispatchEvent(new CustomEvent('ascension:frame', { detail: { frame, quarter } }));
  }
  listen($('#cc-quarter-range'), 'input', () => { stopPlayback(); showFrame(Number($('#cc-quarter-range').value)); });
  listen($('.cc-play'), 'click', () => {
    if (timer) { stopPlayback(); return; }
    if (!frames.length) return;
    if (frameIndex === frames.length - 1) showFrame(0);
    $('.cc-play').textContent = 'Ⅱ';
    $('.cc-play').setAttribute('aria-label', 'Приостановить симуляцию');
    $('.cc-play').setAttribute('aria-pressed', 'true');
    timer = setInterval(() => { showFrame(frameIndex + 1); if (frameIndex === frames.length - 1) stopPlayback(); }, 1400);
  });
  listen(window, 'ascension:trajectory', (event) => {
    const value = event.detail?.trajectory;
    const next = Array.isArray(value) ? value : value?.frames;
    if (!Array.isArray(next) || !next.length || !next.every((frame) => Number.isFinite((frame.result || frame).score) && Array.isArray((frame.result || frame).districts))) return;
    stopPlayback(); frames = next;
    $('#cc-quarter-range').max = String(frames.length - 1);
    $('#cc-quarter-range').disabled = false;
    $('.cc-play').disabled = false;
    $('.cc-timeline-state').textContent = 'Сценарная визуализация';
    showFrame(frames.length - 1);
  });
  function clearTrajectory() {
    stopPlayback(); frames = [];
    $('#cc-quarter-range').disabled = true; $('#cc-quarter-range').value = '0';
    $('.cc-play').disabled = true;
    $('.cc-quarter').textContent = 'Горизонт · 8 кварталов';
    $('.cc-quarter-score').textContent = '—';
    $('.cc-timeline-state').textContent = 'План изменён · нужен расчёт';
  }
  listen(window, 'scenario:calculated', (event) => {
    clearTrajectory();
    updateMetrics(event.detail?.result);
    resultEmpty.hidden = true;
    if (applying) { applying = false; $('.cc-ai-status').textContent = 'План рассчитан. Посмотрите изменения на карте и запустите временную шкалу.'; $('.cc-apply-plan').disabled = false; closePanel(false); }
    else {
      clearProposal('Текущий сценарий рассчитан. Результат и объяснение доступны в разделе «Результат». Здесь можно предложить новую идею.');
      if (activePanel === 'workspace') openPanel('results');
    }
  });
  listen(window, 'scenario:invalidated', () => {
    clearTrajectory();
    updateMetrics(baseline);
    resultEmpty.hidden = false;
    if (!applying) clearProposal('Для текущего плана нужен расчёт. Нажмите «Посмотреть результат» после выбора пяти мер.');
  });
  listen(window, 'scenario:load', () => { clearTrajectory(); openPanel('workspace'); });
  listen(window, 'ascension:trajectory-status', (event) => {
    if (event.detail?.loading) $('.cc-timeline-state').textContent = 'Рассчитываем кварталы…';
    else if (event.detail?.message) $('.cc-timeline-state').textContent = event.detail.message;
  });
  listen(window, 'ascension:plan-applied', (event) => {
    applying = false;
    $('.cc-ai-status').textContent = event.detail?.message || (event.detail?.applied ? 'Сценарий рассчитан.' : 'Не удалось применить план.');
    $('.cc-ai-status').dataset.tone = event.detail?.applied ? '' : 'error';
    $('.cc-apply-plan').disabled = !proposal;
    if (event.detail?.applied) closePanel(false);
  });
  listen(window, 'ascension:plan-error', (event) => {
    applying = false;
    $('.cc-ai-status').textContent = event.detail?.message || 'Не удалось применить план. Проверьте ограничения в конструкторе.';
    $('.cc-ai-status').dataset.tone = 'error';
    $('.cc-apply-plan').disabled = !proposal;
  });
  listen(window, 'city:changed', (event) => {
    clearTrajectory();
    modelAvailable = event.detail?.hasScenarioData === true;
    $('.cc-territory strong').textContent = event.detail?.name || 'Карта';
    $('.cc-territory > span:last-child').textContent = modelAvailable ? '3D · городская модель' : 'Географический просмотр';
    $('.cc-ai').hidden = !modelAvailable;
    $('.cc-kpis').hidden = !modelAvailable;
    $('.cc-timeline').hidden = !modelAvailable;
    if (!modelAvailable) {
      applying = false;
      clearProposal('Вернитесь к Астане и заново оцените план.');
      closePanel(false);
    }
  });

  const examples = {
    nura: 'Хочу помочь Нуре: построить школу с детсадом и поликлинику, добавить освещение и камеры. Во всём городе улучшить приём обращений, а в Сарыарке перевести частный сектор на чистое топливо. Проверь бюджет и влияние на районы.',
    transport: 'Хочу уменьшить пробки и улучшить качество воздуха. Подбери пять совместимых мер в пределах 100 единиц бюджета, удели внимание общественному транспорту и слабым районам. Объясни, чем придётся пожертвовать.',
  };
  listen($('.cc-prompt-examples'), 'click', (event) => {
    const button = event.target.closest('[data-example]');
    if (button && !applying) { clearProposal('Запрос изменён. Оцените обновлённый план.'); $('#cc-plan-prompt').value = examples[button.dataset.example]; $('#cc-plan-prompt').focus(); }
  });
  function addNotes(parent, title, values) {
    const items = Array.isArray(values) ? values.map(readable).filter(Boolean) : typeof values === 'string' ? [values] : [];
    if (!items.length) return;
    const details = element('details', 'cc-plan-notes');
    details.append(element('summary', '', title));
    const list = element('ul'); items.forEach((item) => list.append(element('li', '', item))); details.append(list); parent.append(details);
  }
  function showProposal(response) {
    const preview = $('.cc-plan-preview'); preview.replaceChildren(); preview.hidden = false;
    preview.append(element('span', 'cc-kicker', 'ПРЕДЛОЖЕННЫЙ ПЛАН'), element('p', 'cc-plan-summary', response.summary || 'Проверьте предложенные меры перед применением.'));
    const isNvidia = response.mode === 'ai' && response.available === true && response.valid === true && response.provider === 'nvidia';
    if (isNvidia) {
      const source = element('p', 'cc-plan-rationale', 'План подготовлен NVIDIA Nemotron.');
      if (typeof response.model === 'string') source.title = response.model;
      preview.append(source);
    }
    if (response.modelComment?.text) {
      const comment = element('div', 'cc-model-comment');
      comment.append(element('strong', '', `Комментарий ${isNvidia ? 'NVIDIA Nemotron' : 'AI'} · требует проверки`), element('p', '', response.modelComment.text));
      preview.append(comment);
    }
    const list = element('ol', 'cc-proposed-measures');
    for (const [decisionIndex, decision] of (response.decisions || []).entries()) {
      const measure = dataset.measures.find((entry) => entry.id === decision.measureId);
      const district = dataset.districts.find((entry) => entry.id === decision.districtId);
      const item = element('li');
      item.append(element('strong', '', measure?.name || decision.measureId), element('span', '', `${district?.name || (measure?.scope === 'city' ? 'Весь город' : 'Район не указан')}${measure ? ` · ${measure.cost} у. е. · задержка ${measure.lag} кв.` : ''}`));
      const origin = response.decisionOrigins?.find((entry) => entry.decisionIndex === decisionIndex);
      if (origin?.source === 'suggested') item.append(element('span', 'cc-ai-addition', 'Дополнение AI'));
      if (origin?.rationale) item.append(element('span', 'cc-plan-rationale', origin.rationale));
      list.append(item);
    }
    preview.append(list);
    addNotes(preview, 'За пределами модели', response.unsupported);
    addNotes(preview, 'Допущения и ограничения', response.assumptions);
    addNotes(preview, 'Что нужно исправить', response.validation?.errors || response.errors);
    const canApply = response.mode === 'ai' && response.available === true && response.valid === true && Array.isArray(response.decisions) && response.decisions.length === 5;
    proposal = canApply ? response.decisions.map(({ measureId, districtId }) => districtId ? { measureId, districtId } : { measureId }) : null;
    $('.cc-apply-plan').hidden = !canApply;
    $('.cc-apply-plan').disabled = !canApply;
    $('.cc-ai-status').textContent = canApply ? 'Проверьте меры: только после подтверждения они станут вашим планом.' : 'Предложение требует уточнения. Измените запрос или соберите план вручную.';
  }
  listen($('.cc-ai-form'), 'submit', async (event) => {
    event.preventDefault();
    const prompt = $('#cc-plan-prompt').value.trim();
    if (!prompt || !modelAvailable || applying) return;
    request?.abort(); request = new AbortController();
    const controller = request;
    const version = ++requestVersion;
    const timeout = setTimeout(() => controller.abort(), 45000);
    proposal = null; $('.cc-plan-preview').hidden = true; $('.cc-apply-plan').hidden = true;
    $('.cc-plan-submit').disabled = true; $('.cc-plan-submit').textContent = 'Анализируем идею…';
    $('.cc-ai-status').dataset.tone = '';
    $('.cc-ai-status').textContent = 'Сопоставляем ваш план с мерами, бюджетом и ограничениями модели…';
    try {
      const response = await fetch('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }), signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      if (version !== requestVersion) return;
      if (!response.ok || body.mode !== 'ai' || body.available !== true) {
        const reason = body.summary || readable(body.error) || readable(body.errors?.[0]) || body.message;
        throw new Error(reason || 'Ascension AI сейчас недоступен. Можно собрать и рассчитать план в конструкторе.');
      }
      showProposal(body);
    } catch (error) {
      if (version !== requestVersion) return;
      $('.cc-ai-status').textContent = error.name === 'AbortError' ? 'AI не ответил вовремя. Повторите запрос или откройте конструктор решений.' : error.message;
      $('.cc-ai-status').dataset.tone = 'error';
    } finally {
      clearTimeout(timeout);
      if (version === requestVersion) { request = null; $('.cc-plan-submit').disabled = false; $('.cc-plan-submit').textContent = 'Оценить мой план'; }
    }
  });
  listen($('.cc-apply-plan'), 'click', () => {
    if (!proposal || applying) return;
    applying = true; $('.cc-apply-plan').disabled = true;
    $('.cc-ai-status').dataset.tone = '';
    $('.cc-ai-status').textContent = 'Проверяем план и рассчитываем влияние на город…';
    window.dispatchEvent(new CustomEvent('ascension:apply-plan', { detail: { decisions: structuredClone(proposal) } }));
  });
  document.body.classList.add('cc-active');
  // This workspace opens in 3D even when the shared map defaults to districts.
  mapHost.querySelector('[data-view="3d"]')?.click();
  window.dispatchEvent(new Event('resize'));
  return {
    openPanel,
    destroy() {
      stopPlayback(); requestVersion += 1; request?.abort(); listeners.forEach((remove) => remove());
      restore.reverse().forEach((restoreNode) => restoreNode()); root.remove(); document.body.classList.remove('cc-active');
      window.dispatchEvent(new Event('resize'));
    },
  };
}
