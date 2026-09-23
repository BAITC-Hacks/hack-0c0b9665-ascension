const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sessions = new Map();
export function clearDecisionDrafts() { sessions.clear(); }
const controlKeys = ['data-complaint', 'data-pick', 'data-add', 'data-remove', 'data-calculate', 'data-clear', 'data-name', 'data-save', 'data-load', 'data-pair', 'data-compare'];
function focusedControl(container) {
  const active = document.activeElement;
  if (!container.contains(active)) return null;
  const key = controlKeys.find(key => active.hasAttribute(key));
  return key ? { key, value: active.getAttribute(key) } : null;
}
const namesKK = {
  M1: 'Автобустарға арналған жолақтар', M2: 'Ақылды бағдаршамдар', M3: 'Жеңіл рельсті көлік желісі',
  M4: 'Саябақ / сквер', M5: 'Жеке секторды таза отынға көшіру', M6: 'Қаланы көгалдандыру бағдарламасы',
  M7: 'Мектеп + балабақша', M8: 'Отбасылық денсаулық орталығы / емхана', M9: 'Ауладағы спорт алаңдары',
  M10: 'Жарықтандыру және камералар', M11: 'Қауіпсіз өткелдер және мектеп аймақтары',
  M12: 'Өтініштердің бірыңғай цифрлық платформасы', M13: 'Жылу және су желілерін жаңарту', M14: 'ТКШ апаттық бригадалары және ерте хабарлау',
};
const indicatorsKK = { T1: 'Жол жүктемесін азайту', T2: 'Қоғамдық көліктің қолжетімділігі', E1: 'Көгалдандыру', E2: 'Ауа сапасы', S1: 'Мектептер мен балабақшалар', S2: 'Емханалар және алғашқы медициналық көмек', B1: 'Көше қауіпсіздігі', B2: 'Жол қозғалысының қауіпсіздігі', C1: 'Тұрғын үй-коммуналдық шаруашылық сенімділігі', C2: 'Тұрғындардың өтініштерін шешу жылдамдығы' };

/** A decision workbench keeps drafts in memory, and saves completed scenarios through the existing server calculator. */
export async function renderDecisions({ container, state, lang = 'ru', request, onError = () => {} }) {
  const scope = state.user?.login || container;
  let model = sessions.get(scope);
  if (!model) { model = { draft: [], complaintId: '', picks: {}, result: null, saved: [], name: '', pair: ['', ''], comparison: null, busy: false, error: '', notice: '' }; sessions.set(scope, model); }
  model.context = { state, lang, request, onError };
  model.draw = draw;
  const run = async () => {
    if (!model.dataset) {
      container.innerHTML = '<p role="status">' + (lang === 'kk' ? 'Шешімдер жүктелуде…' : 'Загружаем варианты решений…') + '</p>';
      try { model.dataset = await request('/api/dataset'); }
      catch (error) { container.innerHTML = `<p role="alert">${escape(error.message)}</p><button type="button" data-retry>${lang === 'kk' ? 'Қайталау' : 'Повторить'}</button>`; container.querySelector('[data-retry]').onclick = run; onError(error); return; }
    }
    // A new tab container must not discard a draft or a scenario saved since the shell last refreshed.
    const savedById = new Map([...(state.scenarios || []), ...model.saved].map(s => [s.id, s]));
    model.saved = [...savedById.values()].sort((a, b) => b.id - a.id);
    draw();
  };
  function draw() {
    const focus = model.restoreFocus || focusedControl(container);
    const { state: current, lang: locale } = model.context;
    const t = (ru, kk) => locale === 'kk' ? kk : ru;
    const fmt = n => Number(n).toLocaleString(locale === 'kk' ? 'kk-KZ' : 'ru-RU', { maximumFractionDigits: 2 });
    const sign = n => `${n > 0 ? '+' : ''}${fmt(n)}`;
    const dataset = model.dataset;
    const measureName = m => locale === 'kk' ? namesKK[m.id] ?? m.name : m.name;
    const districtName = id => id ? (locale === 'kk' ? { esil: 'Есіл', almaty: 'Алматы', saryarka: 'Сарыарқа', baikonur: 'Байқоңыр', nura: 'Нұра' }[id] : dataset.districts.find(d => d.id === id)?.name) ?? id : t('Весь город', 'Бүкіл қала');
    const complaint = current.complaints.find(c => String(c.id) === model.complaintId);
    const suggestions = complaint ? dataset.measures.filter(m => m.direction === complaint.category) : [];
    const cost = model.draft.reduce((sum, d) => sum + dataset.measures.find(m => m.id === d.measureId).cost, 0);
    const selectDistricts = selected => `<option value="">${t('Выберите район', 'Ауданды таңдаңыз')}</option>${dataset.districts.map(d => `<option value="${d.id}"${d.id === selected ? ' selected' : ''}>${escape(districtName(d.id))}</option>`).join('')}`;
    const disabled = model.busy ? ' disabled' : '';
    container.innerHTML = `<div class="ad-workbench">
      <div class="ad-heading"><div><p class="ad-eyebrow">${t('Обоснование решения', 'Шешімнің негіздемесі')}</p><h2>${t('Что изменится от моего решения?', 'Менің шешімім нені өзгертеді?')}</h2></div><a href="/">${t('Открыть симулятор', 'Симуляторды ашу')} ↗</a></div>
      <p class="ad-note">${t('Учебная модель: бюджет и эффекты условные. Расчёт не подтверждает выполнение работ и не закрывает обращения.', 'Оқу моделі: бюджет пен әсерлер шартты. Есеп жұмыстардың орындалуын растамайды және өтініштерді жаппайды.')}</p>
      <div class="ad-message${model.error ? ' ad-error' : ''}" role="${model.error ? 'alert' : 'status'}">${escape(model.error || model.notice)}</div>
      <label class="ad-field">${t('Проблема, для которой выбираем решение', 'Шешім таңдалатын мәселе')}<select data-complaint${disabled}><option value="">${t('Общий городской сценарий', 'Жалпы қалалық сценарий')}</option>${current.complaints.map(c => `<option value="${c.id}"${String(c.id) === model.complaintId ? ' selected' : ''}>#${c.id} · ${escape(c.text.slice(0, 85))}</option>`).join('')}</select></label>
      ${complaint ? `<div class="ad-problem"><strong>#${complaint.id} · ${escape(complaint.address || t('Адрес не указан', 'Мекенжай көрсетілмеген'))}</strong><p>${escape(complaint.text)}</p><a href="/desk.html?complaint=${complaint.id}">${t('Открыть исходное обращение', 'Бастапқы өтінішті ашу')}</a><p>${suggestions.length ? t('Предложены меры того же направления. Проверьте, соответствуют ли они конкретной проблеме; автоматического подтверждения связи нет.', 'Сол бағыттағы шаралар ұсынылды. Олардың нақты мәселеге сәйкестігін тексеріңіз; байланыс автоматты түрде расталмайды.') : t('Для этой категории в каталоге нет прямого соответствия. Можно составить общий сценарий; подходящая мера не гарантирована.', 'Каталогта бұл санатқа тікелей сәйкес шара жоқ. Жалпы сценарий құруға болады; сәйкес шараға кепілдік берілмейді.')}</p></div>` : ''}
      <div class="ad-layout"><section aria-label="${t('Каталог мер', 'Шаралар каталогы')}"><h3>${suggestions.length ? t('Варианты по направлению обращения', 'Өтініш бағыты бойынша нұсқалар') : t('Каталог городских мер', 'Қалалық шаралар каталогы')}</h3>
      ${suggestions.length ? `<p class="ad-muted">${t('После подходящих вариантов показаны остальные меры для комплекта из пяти.', 'Сәйкес нұсқалардан кейін бес шараны жинақтау үшін қалған шаралар көрсетілген.')}</p>` : ''}
      <div class="ad-catalog">${[...suggestions, ...dataset.measures.filter(m => !suggestions.includes(m))].map(m => {
        const selectedDecision = model.draft.find(d => d.measureId === m.id);
        const chosen = Boolean(selectedDecision);
        const district = selectedDecision?.districtId || model.picks[m.id] || complaint?.districtId || '';
        return `<article class="ad-measure${suggestions.includes(m) ? ' ad-suggested' : ''}"><div class="ad-measure-meta"><span>${m.id}</span><strong>${m.cost} ${t('у. е.', 'ш. б.')}</strong></div><h4>${escape(measureName(m))}</h4><p>${t('Лаг', 'Кідіріс')}: ${m.lag} ${t('кв.', 'тоқсан')} · ${m.scope === 'city' ? t('Весь город', 'Бүкіл қала') : t('Один район', 'Бір аудан')}</p><div class="ad-effects">${Object.entries(m.effects).map(([key, value]) => `<span class="${value < 0 ? 'ad-negative' : ''}" title="${escape(locale === 'kk' ? indicatorsKK[key] : dataset.indicators.find(i => i.id === key)?.name)}">${escape(locale === 'kk' ? indicatorsKK[key] : dataset.indicators.find(i => i.id === key)?.name)} ${sign(value * (8 - m.lag) / 8)}</span>`).join('')}</div><p class="ad-muted">${t('Эффекты с учётом лага, до синергий и ограничения 0–100.', 'Кідіріс ескерілген, синергия мен 0–100 шектеуіне дейінгі әсерлер.')}</p>
        ${m.scope === 'district' ? `<label class="ad-field">${t('Район реализации', 'Іске асыру ауданы')}<select data-pick="${m.id}"${disabled}${chosen ? ' disabled' : ''}>${selectDistricts(district)}</select></label>` : ''}
        <button type="button" data-add="${m.id}"${disabled}${chosen || model.draft.length >= 5 || (m.scope === 'district' && !district) ? ' disabled' : ''}>${chosen ? t('В плане', 'Жоспарда') : t('Добавить в план', 'Жоспарға қосу')}</button></article>`;
      }).join('')}</div></section><aside class="ad-plan"><h3 tabindex="-1">${t('Мой план', 'Менің жоспарым')} <span>${model.draft.length}/5</span></h3><p>${t('Бюджет', 'Бюджет')}: <strong>${cost}/${dataset.budget}</strong> · ${t('Остаток', 'Қалдық')}: ${dataset.budget - cost}</p>
      <ol>${model.draft.map(d => { const m = dataset.measures.find(m => m.id === d.measureId); return `<li><strong>${d.measureId} · ${escape(measureName(m))}</strong><span>${escape(districtName(d.districtId))} · ${m.cost} ${t('у. е.', 'ш. б.')}</span><button class="ad-text-button" type="button" data-remove="${m.id}"${disabled}>${t('Убрать', 'Алып тастау')}</button></li>`; }).join('')}</ol>
      ${!model.draft.length ? `<p class="ad-muted">${t('Добавьте пять мер. Район и совместимость проверяются сервером.', 'Бес шара қосыңыз. Аудан мен үйлесімділікті сервер тексереді.')}</p>` : ''}
      <button class="ad-primary" type="button" data-calculate${disabled}${model.draft.length !== 5 ? ' disabled' : ''}>${model.busy ? t('Обрабатываем…', 'Өңделуде…') : t('Рассчитать последствия', 'Салдарын есептеу')}</button>
      <button type="button" data-clear${disabled}${!model.draft.length ? ' disabled' : ''}>${t('Очистить план', 'Жоспарды тазарту')}</button>
      ${model.result ? `<div class="ad-result"><h4>${t('Расчётный результат', 'Есептік нәтиже')}</h4><dl><div><dt>Score</dt><dd>${fmt(model.result.score)} <small>(${sign(model.result.deltaScore)})</small></dd></div><div><dt>${t('Критических показателей', 'Сындарлы көрсеткіштер')}</dt><dd>${model.result.criticalCount}</dd></div><div><dt>${t('Слабейший район, балл', 'Ең әлсіз аудан, балл')}</dt><dd>${fmt(model.result.worstDistrictScore)}</dd></div></dl><p>${t('Оценка по синтетическим данным. Для фактического результата используйте поручения и проверку исполнения.', 'Синтетикалық деректер бойынша баға. Нақты нәтиже үшін тапсырмалар мен орындалуды тексеруді қолданыңыз.')}</p><label class="ad-field">${t('Название сценария', 'Сценарий атауы')}<input data-name maxlength="100" value="${escape(model.name)}" placeholder="${t('Например: Приоритет — безопасность', 'Мысалы: Басымдық — қауіпсіздік')}"${disabled}></label><button type="button" data-save${disabled}>${t('Сохранить сценарий', 'Сценарийді сақтау')}</button></div>` : ''}
      </aside></div><section class="ad-saved"><h3>${t('Сохранённые варианты и сравнение', 'Сақталған нұсқалар және салыстыру')}</h3><p>${t('Выберите A и B. Оба варианта заново рассчитываются сервером по текущим правилам.', 'A және B таңдаңыз. Екі нұсқаны да сервер қолданыстағы ережелер бойынша қайта есептейді.')}</p>
      ${model.saved.length ? `<div class="ad-compare-controls">${['A', 'B'].map((label, idx) => `<label class="ad-field">${label}<select data-pair="${idx}"${disabled}><option value="">${t('Выберите сценарий', 'Сценарийді таңдаңыз')}</option>${model.saved.map(s => `<option value="${s.id}"${String(s.id) === model.pair[idx] ? ' selected' : ''}>#${s.id} ${escape(s.name)}</option>`).join('')}</select></label>`).join('')}<button type="button" data-compare${disabled}${!model.pair[0] || !model.pair[1] || model.pair[0] === model.pair[1] ? ' disabled' : ''}>${t('Сравнить A и B', 'A мен B салыстыру')}</button></div><div class="ad-scenario-list">${model.saved.map(s => `<article><div><strong>${escape(s.name)}</strong><p>${s.complaintId ? `${t('Обращение', 'Өтініш')} #${s.complaintId} · ` : ''}${t('Автор', 'Автор')}: ${escape(s.actor)}</p></div><button type="button" data-load="${s.id}"${disabled}>${t('Загрузить в план', 'Жоспарға жүктеу')}</button></article>`).join('')}</div>` : `<p class="ad-muted">${t('Сохраните рассчитанный план, чтобы вернуться к нему после перезагрузки.', 'Қайта жүктегеннен кейін оралу үшін есептелген жоспарды сақтаңыз.')}</p>`}
      ${model.comparison ? renderComparison(model.comparison, t, fmt, sign, districtName) : ''}</section></div>`;
    const mutate = async action => {
      if (model.busy) return;
      model.restoreFocus = focusedControl(container);
      model.busy = true; model.error = ''; model.notice = ''; draw();
      try { await action(); }
      catch (error) { model.error = error.message; model.context.onError(error); }
      finally { model.busy = false; model.draw(); model.restoreFocus = null; }
    };
    const validate = async draft => {
      const result = await model.context.request('/api/validate', { method: 'POST', body: { decisions: draft } });
      const failures = (result.errors ?? []).filter(e => e.code !== 'DECISION_COUNT');
      if (failures.length) throw new Error(failures.map(e => e.message).join(' '));
      model.draft = draft; model.result = null;
    };
    container.querySelector('[data-complaint]').onchange = e => { model.complaintId = e.target.value; model.picks = {}; model.notice = ''; model.error = ''; draw(); };
    container.querySelectorAll('[data-pick]').forEach(el => el.onchange = e => { model.picks[el.dataset.pick] = e.target.value; draw(); container.querySelector(`[data-pick="${el.dataset.pick}"]`)?.focus(); });
    container.querySelectorAll('[data-add]').forEach(el => el.onclick = () => mutate(async () => { const m = dataset.measures.find(m => m.id === el.dataset.add); const decision = { measureId: m.id }; if (m.scope === 'district') decision.districtId = model.picks[m.id] || complaint?.districtId; await validate([...model.draft, decision]); }));
    container.querySelectorAll('[data-remove]').forEach(el => el.onclick = () => mutate(() => validate(model.draft.filter(d => d.measureId !== el.dataset.remove))));
    container.querySelector('[data-clear]').onclick = () => { model.draft = []; model.result = null; model.error = ''; model.notice = ''; draw(); };
    container.querySelector('[data-calculate]').onclick = () => mutate(async () => { model.result = await model.context.request('/api/simulate', { method: 'POST', body: { decisions: model.draft } }); });
    const name = container.querySelector('[data-name]'); if (name) name.oninput = e => { model.name = e.target.value; };
    const save = container.querySelector('[data-save]'); if (save) save.onclick = () => mutate(async () => {
      if (!model.name.trim()) throw new Error(t('Введите название сценария.', 'Сценарий атауын енгізіңіз.'));
      const saved = await model.context.request('/api/desk/scenarios', { method: 'POST', body: { name: model.name.trim(), scenario: { decisions: model.draft }, complaintId: model.complaintId ? Number(model.complaintId) : null } });
      model.saved = [saved, ...model.saved.filter(s => s.id !== saved.id)]; model.context.state.scenarios = model.saved;
      model.notice = t('Сценарий сохранён. Его можно сравнить с другим вариантом.', 'Сценарий сақталды. Оны басқа нұсқамен салыстыруға болады.');
    });
    container.querySelectorAll('[data-load]').forEach(el => el.onclick = () => mutate(async () => { const saved = model.saved.find(s => String(s.id) === el.dataset.load); await validate(saved.scenario.decisions); model.picks = Object.fromEntries(saved.scenario.decisions.filter(d => d.districtId).map(d => [d.measureId, d.districtId])); model.name = saved.name; model.complaintId = String(saved.complaintId ?? ''); model.notice = t('План загружен. Нажмите «Рассчитать последствия».', 'Жоспар жүктелді. «Салдарын есептеу» батырмасын басыңыз.'); container.querySelector('.ad-plan')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }));
    container.querySelectorAll('[data-pair]').forEach(el => el.onchange = e => { model.pair[Number(el.dataset.pair)] = e.target.value; model.comparison = null; draw(); });
    const compare = container.querySelector('[data-compare]'); if (compare) compare.onclick = () => mutate(async () => { const selected = model.pair.map(id => model.saved.find(s => String(s.id) === id)); const results = await Promise.all(selected.map(s => model.context.request('/api/simulate', { method: 'POST', body: s.scenario }))); model.comparison = { selected, results }; });
    if (focus) {
      const next = [...container.querySelectorAll(`[${focus.key}]`)].find(el => el.getAttribute(focus.key) === focus.value);
      if (next && !next.disabled) next.focus({ preventScroll: true });
      else if (!model.busy) container.querySelector('.ad-plan h3')?.focus({ preventScroll: true });
    }
  }
  await run();
}

function renderComparison({ selected, results: [a, b] }, t, fmt, sign, districtName) {
  const metrics = [[t('Стоимость', 'Құны'), a.totalCost, b.totalCost], ['Score', a.score, b.score], [t('Критических показателей', 'Сындарлы көрсеткіштер'), a.criticalCount, b.criticalCount], [t('Слабейший район, балл', 'Ең әлсіз аудан, балл'), a.worstDistrictScore, b.worstDistrictScore], ...a.districts.map(d => [districtName(d.id), d.afterScore, b.districts.find(v => v.id === d.id).afterScore])];
  return `<div class="ad-comparison" aria-live="polite"><h4>${escape(selected[0].name)} / ${escape(selected[1].name)}</h4><div class="ad-table-wrap"><table><caption>${t('Сравнение расчётных последствий; разница B − A', 'Есептік салдарды салыстыру; айырмасы B − A')}</caption><thead><tr><th scope="col">${t('Показатель', 'Көрсеткіш')}</th><th scope="col">A</th><th scope="col">B</th><th scope="col">B − A</th></tr></thead><tbody>${metrics.map(([name, x, y]) => `<tr><th scope="row">${escape(name)}</th><td>${fmt(x)}</td><td>${fmt(y)}</td><td>${sign(y - x)}</td></tr>`).join('')}</tbody></table></div><p class="ad-note">${t('Меньше критических показателей — лучше. Рост Score не гарантирует улучшения каждого района; проверьте строки районов. Это сравнение сценариев, а не отчёт о выполненных работах.', 'Сындарлы көрсеткіштер неғұрлым аз болса, соғұрлым жақсы. Score өсуі әр ауданның жақсарғанын білдірмейді; аудан жолдарын тексеріңіз. Бұл орындалған жұмыс есебі емес, сценарийлерді салыстыру.')}</p></div>`;
}
