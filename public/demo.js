const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const number = (value, digits = 2) => Number(value).toLocaleString('ru-RU', { maximumFractionDigits: digits });
const signed = value => `${value > 0 ? '+' : ''}${number(value)}`;
const official = { decisions: [{ measureId: 'M7', districtId: 'nura' }, { measureId: 'M8', districtId: 'nura' }, { measureId: 'M10', districtId: 'nura' }, { measureId: 'M12' }, { measureId: 'M5', districtId: 'saryarka' }] };
const alternative = { decisions: official.decisions.map(item => item.measureId === 'M7' ? { ...item, districtId: 'esil' } : { ...item }) };
const steps = ['Обращение', 'Решения', 'Сравнение', 'Поручение', 'Ответ жителя'];
// Illustrative workflow state is deliberately not persisted or sent to a desk API.
const state = { step: 0, choice: 'official', assigned: false, feedback: null, comment: '', dataset: null, results: null, loading: false, furthest: 0 };
const result = () => state.results[state.choice];
const district = (value, id) => value.districts.find(item => item.id === id);
const announce = text => { $('demo-announcer').textContent = text; };
const measure = id => state.dataset.measures.find(item => item.id === id);
const districtName = id => state.dataset.districts.find(item => item.id === id)?.name || 'Весь город';

let elapsed = 0;
let timerStarted = null;
let timerHandle = null;
function updateClock() {
  const seconds = Math.min(90, elapsed + (timerStarted === null ? 0 : (performance.now() - timerStarted) / 1000));
  const remaining = Math.max(0, 90 - Math.floor(seconds));
  $('demo-clock').textContent = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
  $('demo-timer-progress').value = seconds;
  if (seconds >= 90) {
    pauseTimer();
    elapsed = 90;
    $('demo-timer').disabled = true;
    $('demo-clock-hint').textContent = '90 секунд прошли. Продолжайте в своём темпе.';
    announce('90 секунд прошли. Вы можете спокойно закончить демонстрацию.');
  }
}
function pauseTimer() {
  if (timerStarted !== null) elapsed += (performance.now() - timerStarted) / 1000;
  timerStarted = null;
  clearInterval(timerHandle);
  timerHandle = null;
  $('demo-timer').textContent = elapsed ? 'Продолжить таймер' : 'Запустить таймер';
}
function completion() {
  $('demo-complete').hidden = state.step !== 4 || !state.feedback;
  $('demo-timer').disabled = Boolean(state.feedback) || elapsed >= 90;
  if (!state.feedback) return;
  const selected = state.choice === 'official' ? 'Нура' : 'Есиль';
  $('demo-complete-copy').textContent = `Вы выбрали M7 в районе ${selected}, зафиксировали поручение и получили ответ жителя. ${state.feedback === 'resolved' ? 'Результат подтверждён — учебная история завершена.' : 'Проблема осталась — следующий шаг команды: повторная проверка и доработка решения.'} Score выбранного сценария: ${number(result().score)}. Все действия остались в учебной истории.`;
  pauseTimer();
  $('demo-clock-hint').textContent = 'Готово. Можно перейти к рабочим разделам.';
}
function renderProgress() {
  $('demo-progress').innerHTML = steps.map((title, index) => {
    const enabled = index <= state.furthest && (index !== 4 || state.assigned);
    return `<li${index === state.step ? ' aria-current="step"' : ''}${index < state.step || (index === 4 && state.feedback) ? ' class="done"' : ''}><button type="button" data-step="${index}"${enabled ? '' : ' disabled'}${index === state.step ? ' aria-current="step"' : ''}><span class="step-number" aria-hidden="true">${index < state.step || (index === 4 && state.feedback) ? '✓' : index + 1}</span><span>${title}</span></button></li>`;
  }).join('');
}

async function request(path, body) {
  try {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (!response.ok || data.valid === false) throw new Error(data.errors?.map(item => item.message).join(' ') || data.message || 'Сервер не смог рассчитать сценарий.');
    return data;
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error('Сервер не ответил вовремя. Повторите загрузку.');
    if (error instanceof TypeError) throw new Error('Нет связи с сервером. Проверьте подключение и повторите загрузку.');
    throw error;
  }
}

function heading(title, description, seconds) {
  return `<div class="step-head"><div><p class="eyebrow">ШАГ ${state.step + 1} / ${steps.length} · УЧЕБНАЯ ИСТОРИЯ</p><h2 id="step-heading" tabindex="-1">${title}</h2><p class="step-lead">${description}</p></div><span class="step-time">~ ${seconds} сек.</span></div>`;
}

function complaintStep() {
  const nura = state.dataset.districts.find(item => item.id === 'nura');
  return heading('Сначала — проблема жителя', 'Вымышленное обращение показывает, с чего начинается работа. Его нет в журнале обращений.', 15) + `<div class="split"><article class="story-card"><span class="tag">ДЕМО-001 · РАЙОН НУРА</span><h3>Школа далеко, мест в детсаду не хватает</h3><blockquote>«В нашем квартале много семей с детьми. Хотим школу и детсад ближе к дому».</blockquote><p>Автор и квартал вымышлены. Персональные данные не используются.</p><dl><div><dt>Школы и детсады · S1</dt><dd>${number(nura.indicators.S1)} / 100</dd></div><div><dt>Критический порог модели</dt><dd>&lt; 40</dd></div></dl></article><aside class="explain-card"><p class="eyebrow">КАК ДУМАЕТ АКИМ</p><h3>Увидеть потребность в контексте города</h3><p>В исходной модели у Нуры показатель школ и детсадов ниже 40. Это помогает поставить вопрос о приоритете района.</p><p>Следующий шаг — включить подходящую меру в бюджет и сравнить последствия для всех районов.</p></aside></div>`;
}

function decisionsStep() {
  return heading('Пять решений, один бюджет', 'Берём официальный пример из учебного кейса. Мера M7 отвечает на тему обращения; остальные решения учитывают другие потребности города.', 15) + `<div class="split"><div><ul class="measure-list">${official.decisions.map(decision => { const item = measure(decision.measureId); return `<li><div><div class="measure-id">${item.id}</div>${escapeHtml(item.name)}<span>${escapeHtml(districtName(decision.districtId))} · лаг ${item.lag} кв.</span></div><b>${item.cost} у. е.</b></li>`; }).join('')}</ul><div class="budget-mini"><div><strong>${number(state.results.official.totalCost)}</strong><span>из ${state.dataset.budget} у. е. потрачено</span></div><div><strong>${number(state.results.official.remainingBudget)}</strong><span>у. е. осталось</span></div></div></div><aside class="explain-card"><p class="eyebrow">БЮДЖЕТНЫЙ ВЫБОР</p><h3>Эффект появляется постепенно</h3><p>M7 — школа и детсад в Нуре — стоит <strong>${measure('M7').cost} у. е.</strong> и имеет лаг ${measure('M7').lag} квартала. За горизонт ${state.dataset.horizon} кварталов модель учитывает часть исходного эффекта.</p><p>Нужно ровно пять мер, не более двух из одного направления; несовместимые сочетания запрещены. Остаток бюджета не позволяет добавить шестое решение.</p><p>Далее проверим: что изменится, если ту же школу направить в другой район?</p></aside></div>`;
}

function scenarioCard(key, title, subtitle) {
  const value = state.results[key];
  const nura = district(value, 'nura');
  const esil = district(value, 'esil');
  return `<label class="scenario-card"><input type="radio" name="scenario" value="${key}"${state.choice === key ? ' checked' : ''}><h3>${title}</h3><p>${subtitle}</p><dl class="scenario-metrics"><div><dt>Итоговый Score</dt><dd>${number(value.score)}</dd></div><div><dt>Расход / остаток, у. е.</dt><dd>${value.totalCost} <small>/ ${value.remainingBudget}</small></dd></div><div><dt>Нура · школы и детсады</dt><dd>${number(nura.after.S1)} <small>(${signed(nura.delta.S1)})</small></dd></div><div><dt>Есиль · школы и детсады</dt><dd>${number(esil.after.S1)} <small>(${signed(esil.delta.S1)})</small></dd></div><div><dt>Критические показатели</dt><dd>${value.criticalCount}</dd></div><div><dt>Оценка худшего района</dt><dd>${number(value.worstDistrictScore)}</dd></div></dl></label>`;
}

function comparisonStep() {
  const a = state.results.official, b = state.results.alternative;
  return heading('Одинаковые расходы, разный результат', 'Меняем только район меры M7: из Нуры в Есиль. Оба варианта рассчитаны сервером, все остальные решения одинаковы.', 25) + `<fieldset class="scenario-options"><legend>Выберите вариант для продолжения учебной истории</legend><div class="scenario-grid">${scenarioCard('official', 'M7 в Нуре', 'Официальный пример учебного кейса')}${scenarioCard('alternative', 'M7 в Есиле', 'Альтернатива: меняется район одной меры')}</div></fieldset><div class="comparison-note"><p>Разница Score «Нура минус Есиль»: <strong>${signed(a.score - b.score)}</strong>. Бюджет в обоих вариантах: ${a.totalCost} у. е., остаток ${a.remainingBudget} у. е.</p><p>При переносе M7 в Есиль показатель S1 в Нуре остаётся ${number(district(b, 'nura').after.S1)} — ниже 40. У общего Score учитываются средняя оценка, худший район и штраф за каждый критический показатель. Это сравнение двух вариантов, а не поиск оптимального плана.</p></div>`;
}

function assignmentStep() {
  const isNura = state.choice === 'official';
  return heading('Решение превращается в поручение', 'Учебное поручение показывает следующий этап работы. Оно не назначает реальных исполнителей и не появляется в кабинете.', 20) + `<div class="split"><article class="story-card"><span class="tag">ПРИМЕР ПОРУЧЕНИЯ · ДЕМО-001</span><h3>${isNura ? 'Подготовить план школы и детсада в Нуре' : 'Пересмотреть ответ на обращение из Нуры'}</h3><p>${isNura ? 'Учебный исполнитель: команда социальной инфраструктуры. Пример срока подготовки плана: 30 календарных дней; это не срок строительства.' : 'В выбранном варианте M7 направлена в Есиль. Учебной команде социальной инфраструктуры нужно объяснить жителю Нуры выбор и подготовить другой вариант ответа.'}</p><dl><div><dt>Выбранный вариант</dt><dd>M7 · ${isNura ? 'Нура' : 'Есиль'}</dd></div><div><dt>Score модели</dt><dd>${number(result().score)}</dd></div></dl><button id="demo-assign" type="button" class="primary"${state.assigned ? ' disabled' : ''}>${state.assigned ? 'Учебное поручение зафиксировано' : 'Зафиксировать учебное поручение'}</button><p id="assignment-status" class="assignment-status" role="status">${state.assigned ? 'Пример поручения хранится только в памяти этой страницы. Можно перейти к ответу жителя.' : 'Нажмите кнопку, чтобы продолжить. Никакие данные в рабочий кабинет не отправятся.'}</p></article><aside class="explain-card"><p class="eyebrow">ОТВЕТСТВЕННОСТЬ</p><h3>Расчёт ещё не означает выполненную работу</h3><p>Score помогает сравнить сценарии. Для реального результата нужны исполнитель, срок, проверка отчёта и обратная связь жителя.</p><p>На последнем шаге перейдём к вымышленному моменту проверки результата. Реальные кварталы здесь не проходят.</p></aside></div>`;
}

function feedbackText() {
  if (state.feedback === 'resolved') return 'Учебный ответ: житель подтвердил результат. В реальном процессе это дополняет отчёт исполнителя. Здесь подтверждение остаётся только в памяти страницы.';
  if (state.feedback === 'unresolved') return 'Учебный ответ: проблема осталась. История требует повторной проверки и нового решения; одного отчёта исполнителя недостаточно. Записи в рабочем кабинете не менялись.';
  return 'Выберите ответ жителя. Обратная связь иллюстрирует проверку результата и не меняет рассчитанный Score.';
}

function confirmationStep() {
  return heading('Последнее слово — у жителя', 'Переносимся в вымышленный момент проверки результата. Отчёт ниже — пример, он не подтверждает реальные работы.', 15) + `<div class="split"><article class="story-card"><span class="tag">УЧЕБНАЯ ПРОВЕРКА РЕЗУЛЬТАТА</span><h3>${state.choice === 'official' ? 'Пример отчёта: объекты введены в эксплуатацию' : 'Пример отчёта: жителю направлено объяснение'}</h3><p>${state.choice === 'official' ? 'Предположим, исполнитель отчитался о новой школе и детсаде. Только житель может подтвердить, что его ситуация улучшилась.' : 'Школа в выбранном сценарии направлена в Есиль, а исходное обращение поступило из Нуры. Само объяснение бюджетного выбора не означает, что проблема решена.'}</p><label class="feedback-label" for="demo-comment">Комментарий жителя (учебный, до 600 символов)<textarea class="feedback-comment" id="demo-comment" maxlength="600" placeholder="Например: в детском саду по-прежнему нет мест">${escapeHtml(state.comment)}</textarea></label><div class="feedback-actions"><button data-feedback="resolved" type="button" aria-pressed="${state.feedback === 'resolved'}">Проблема решена</button><button data-feedback="unresolved" type="button" aria-pressed="${state.feedback === 'unresolved'}">Проблема осталась</button></div><p id="feedback-status" class="feedback-status" role="status">${feedbackText()}</p></article><aside class="explain-card"><p class="eyebrow">ЦЕПОЧКА ЗАМЫКАЕТСЯ</p><h3>Проблема → выбор → проверка</h3><p>Мы прошли от потребности жителя к бюджетному решению, сравнению районов, поручению и обратной связи.</p><p>Можно открыть рабочие разделы сайта. Учебные данные этой демонстрации туда не переносятся.</p></aside></div><nav class="real-links" aria-label="Продолжить работу"><a href="/#workspace">Собрать свой сценарий ↗</a><a href="/mayor.html">Кабинет обращений ↗</a><a href="/citizens.html">Страница жителя ↗</a></nav>`;
}

function render(focus = false) {
  state.furthest = Math.max(state.furthest, state.step);
  renderProgress();
  $('demo-stage').innerHTML = [complaintStep, decisionsStep, comparisonStep, assignmentStep, confirmationStep][state.step]();
  $('demo-position').textContent = `Шаг ${state.step + 1} из ${steps.length}`;
  $('demo-back').disabled = state.step === 0;
  $('demo-next').hidden = state.step === steps.length - 1;
  $('demo-next').disabled = state.step === 3 && !state.assigned;
  $('demo-next').textContent = state.step === 3 ? 'К ответу жителя →' : 'Далее →';
  completion();
  if (focus) $('step-heading').focus({ preventScroll: false });
  announce(`Шаг ${state.step + 1} из ${steps.length}: ${steps[state.step]}.`);
}

async function initialize() {
  if (state.loading) return;
  state.loading = true;
  $('demo-loading').hidden = false;
  $('demo-error').hidden = true;
  try {
    const [dataset, first, second] = await Promise.all([request('/api/dataset'), request('/api/simulate', official), request('/api/simulate', alternative)]);
    if (!Array.isArray(dataset.measures) || !Array.isArray(dataset.districts) || !Number.isFinite(first.score) || !Number.isFinite(second.score)) throw new Error('Сервер вернул неполные данные. Повторите загрузку.');
    state.dataset = dataset;
    state.results = { official: first, alternative: second };
    $('demo-workspace').hidden = false;
    render();
  } catch (error) {
    $('demo-error-text').textContent = error.message;
    $('demo-error').hidden = false;
  } finally {
    $('demo-loading').hidden = true;
    state.loading = false;
  }
}

$('demo-next').addEventListener('click', () => {
  if (state.step >= steps.length - 1 || (state.step === 3 && !state.assigned)) return;
  state.step++;
  render(true);
});
$('demo-back').addEventListener('click', () => { if (state.step > 0) { state.step--; render(true); } });
$('demo-restart').addEventListener('click', () => {
  Object.assign(state, { step: 0, choice: 'official', assigned: false, feedback: null, comment: '', furthest: 0 });
  pauseTimer();
  elapsed = 0;
  $('demo-timer').disabled = false;
  $('demo-timer').textContent = 'Запустить таймер';
  $('demo-clock-hint').textContent = 'Ориентир для выступления';
  updateClock();
  render(true);
});
$('demo-retry').addEventListener('click', () => void initialize());
$('demo-stage').addEventListener('change', event => {
  if (event.target.name !== 'scenario' || !['official', 'alternative'].includes(event.target.value)) return;
  if (state.choice !== event.target.value) {
    state.choice = event.target.value;
    state.assigned = false;
    state.feedback = null;
    state.comment = '';
    state.furthest = 3;
    renderProgress();
    completion();
  }
  announce(`Выбран вариант: M7 в ${state.choice === 'official' ? 'Нуре' : 'Есиле'}.`);
});
$('demo-stage').addEventListener('input', event => {
  if (event.target.id === 'demo-comment') { state.comment = event.target.value; event.target.removeAttribute('aria-invalid'); }
});
$('demo-stage').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.id === 'demo-assign') {
    state.assigned = true;
    button.disabled = true;
    button.textContent = 'Учебное поручение зафиксировано';
    $('assignment-status').textContent = 'Пример поручения хранится только в памяти этой страницы. Можно перейти к ответу жителя.';
    $('demo-next').disabled = false;
    $('demo-next').focus();
  }
  if (['resolved', 'unresolved'].includes(button.dataset.feedback)) {
    if (button.dataset.feedback === 'unresolved' && !state.comment.trim()) {
      $('feedback-status').textContent = 'Расскажите в комментарии, что осталось нерешённым. Это поможет команде понять, какие работы нужно повторить.';
      $('demo-comment').setAttribute('aria-invalid', 'true');
      $('demo-comment').focus();
      return;
    }
    $('demo-comment').removeAttribute('aria-invalid');
    state.feedback = button.dataset.feedback;
    for (const option of $('demo-stage').querySelectorAll('[data-feedback]')) option.setAttribute('aria-pressed', String(option.dataset.feedback === state.feedback));
    $('feedback-status').textContent = feedbackText();
    renderProgress();
    completion();
    announce(state.feedback === 'resolved' ? 'Демонстрация завершена: результат подтверждён.' : 'Демонстрация завершена: обращение требует повторной проверки.');
  }
});
$('demo-progress').addEventListener('click', event => {
  const button = event.target.closest('[data-step]');
  if (!button || button.disabled) return;
  state.step = Number(button.dataset.step);
  render(true);
});
$('demo-timer').addEventListener('click', () => {
  if (timerStarted !== null) {
    pauseTimer();
    $('demo-clock-hint').textContent = 'Таймер на паузе';
  } else {
    timerStarted = performance.now();
    timerHandle = setInterval(updateClock, 250);
    $('demo-timer').textContent = 'Пауза';
    $('demo-clock-hint').textContent = 'Переходите между шагами самостоятельно';
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && timerStarted !== null) {
    pauseTimer();
    $('demo-clock-hint').textContent = 'Таймер на паузе: вы переключили вкладку';
  }
});
void initialize();
