import { mountMayorPlanner } from './mayor-planner.js';
import { mountScenarioLibrary } from './scenario-library.js';
import { mountPolicyOptionsPanel } from './policy-options-panel.js';
import { createPolicyOptionsFetcher } from './policy-options-client.js';
import { mountActionRegister } from './action-register.js';
import { mountDecisionBrief } from './decision-brief.js';
import { mountEvidenceRegister } from './evidence-register.js';
import { PLACES } from './places.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = (value, digits = 2) => Number(value).toLocaleString('ru-RU', {maximumFractionDigits:digits, minimumFractionDigits:digits});
const icons = {
  overview:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  map:'m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2z M9 3v16 M15 5v16',
  planner:'M5 4h14v17H5z M9 2h6v4H9z M9 10h6 M9 14h6 M9 18h3',
  analytics:'M4 3v17h17 M8 15v-4 M13 15V7 M18 15V4',
  districts:'M3 21h18 M5 21V9h6v12 M11 21V3h8v18 M7 12h2 M7 16h2 M14 7h2 M14 11h2 M14 15h2',
  scenarios:'M3 7h7l2 3h9v10H3z M3 7V4h8l2 3h8v3',
  requests:'M21 4H3v13h5l4 4 4-4h5z M7 8h10 M7 12h7',
  tasks:'M9 6h12 M9 12h12 M9 18h12 m-18-7 2 2 3-4 M3 5h2 M3 18h2',
  data:'M4 5c0-4 16-4 16 0s-16 4-16 0v14c0 4 16 4 16 0V5 M4 12c0 4 16 4 16 0',
  arrow:'M4 12h15 m-6-6 6 6-6 6', pin:'M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0 M12 8v4 M10 10h4',
  search:'M15 15l6 6 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0', menu:'M4 6h16 M4 12h16 M4 18h16',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[name] || icons.overview}"/></svg>`;
const routes = {
  overview:['Обзор города','Рабочий день начинается с общей картины.'],
  map:['Карта города','Территории, городские объекты и транспорт.'],
  planner:['Сценарий развития','Проверьте эффект решений до их реализации.'],
  analytics:['Результаты и сравнение','Что изменится в городе — и за счёт каких решений.'],
  districts:['Районы и приоритеты','Увидеть различия. Найти точку приложения усилий.'],
  scenarios:['Библиотека сценариев','Сохраняйте варианты и готовьте решения к обсуждению.'],
  requests:['Обращения жителей','От сообщения жителя — к ответственному и результату.'],
  tasks:['Поручения','Превратите рассчитанный план в проверяемые действия.'],
  data:['Данные и методика','Источники, ограничения и понятная логика расчёта.'],
};
const link = (route, text, className='mw-link') => `<a class="${className}" data-route="${route}" href="/mayor-${route}.html">${text}${icon('arrow')}</a>`;
let currentRoute = routeFromPath(), dataset, baseline, result, planner, cityMap, mapLoading, requestsLoaded=false;
let currentCity = PLACES.find(p => p.id === 'astana');
function routeFromPath() { return Object.keys(routes).find(key => location.pathname === `/mayor-${key}.html`) || 'overview'; }

document.body.classList.add('mayor-workspace');
$('mayor-app').innerHTML = `
  <a class="mw-skip" href="#mw-main">Перейти к содержимому</a>
  <aside class="mw-sidebar" id="mw-sidebar">
    <a class="mw-brand" href="/mayor-overview.html" data-route="overview"><span class="mw-brand-mark">A<span></span></span><span>ASCENSION<small>ГОРОДСКИЕ РЕШЕНИЯ</small></span></a>
    <div class="mw-workspace-label">КАБИНЕТ АКИМА</div>
    <nav aria-label="Разделы кабинета">${Object.entries(routes).map(([key,[label]]) => `<a href="/mayor-${key}.html" data-route="${key}">${icon(key)}<span>${label}</span>${key==='planner'?'<i>5</i>':''}</a>`).join('')}</nav>
    <div class="mw-sidebar-bottom"><div class="mw-small-orbit" aria-hidden="true">◎</div><strong>У города есть будущее.<br>У решения — последствия.</strong><p>Пространство для взвешенных<br>городских решений.</p><a href="/citizens.html">Портал для жителей ${icon('arrow')}</a></div>
    <div class="mw-profile"><span>А</span><div>Рабочее пространство<small>Ascension · Казахстан</small></div></div>
  </aside>
  <div class="mw-shell">
    <header class="mw-topbar"><button class="mw-menu" aria-label="Открыть меню" aria-controls="mw-sidebar" aria-expanded="false">${icon('menu')}</button><div class="mw-breadcrumb">Кабинет акима <span>/</span> <strong id="mw-crumb">Обзор города</strong></div><div class="mw-top-actions"><span class="mw-model-label"><i></i>Учебная модель</span><button id="mw-search-open" class="mw-icon-button" aria-label="Найти раздел">${icon('search')}</button><a class="mw-avatar" href="/mayor-requests.html" data-route="requests" aria-label="Открыть обращения">А</a></div></header>
    <main class="mw-main" id="mw-main" tabindex="-1">
      <div class="mw-page-heading"><div><div class="mw-eyebrow">ASCENSION / РАБОЧЕЕ ПРОСТРАНСТВО</div><h1 id="mw-page-title">Обзор города</h1><p id="mw-page-subtitle">Рабочий день начинается с общей картины.</p></div><label class="mw-city-select">${icon('pin')}<span class="mw-sr-only">Город</span><select id="mw-city">${PLACES.filter(p=>p.kind==='city').map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label></div>
      <div id="mw-loading" class="mw-loading" role="status">Загружаем показатели и инструменты города…</div>
      <div id="mw-fatal" class="mw-error" hidden role="alert"></div>
      <div id="mw-geography" class="mw-notice" hidden>Для этого города доступен географический просмотр. Расчётная модель пока есть только для Астаны. <button id="mw-return">Вернуться к модели Астаны</button></div>
      <div id="mw-views" hidden>
        <section id="mw-overview" class="mw-view" data-view="overview"></section>
        <section class="mw-view" data-view="map" hidden><div class="mw-map-intro"><span class="mw-pill">География OpenStreetMap</span><span>Транспортная анимация условная · не GPS</span><a href="/">Открыть основной симулятор ↗</a></div><div id="mw-city-map"></div></section>
        <section class="mw-view mw-model" data-view="planner" hidden><div class="mw-stepper"><b><span>01</span> Выбор решений</b><i></i><a href="/mayor-analytics.html" data-route="analytics"><span>02</span> Оценка эффекта</a><i></i><a href="/mayor-tasks.html" data-route="tasks"><span>03</span> План действий</a></div><div id="mw-planner"></div></section>
        <section class="mw-view mw-model" data-view="analytics" hidden><div id="mw-result"></div><div class="mw-module" id="comparison-panel"></div><div class="mw-module" id="policy-options-panel"></div></section>
        <section class="mw-view mw-model" data-view="districts" id="mw-districts" hidden></section>
        <section class="mw-view mw-model" data-view="scenarios" hidden><div id="scenario-library"></div><div class="mw-module" id="decision-brief"></div></section>
        <section class="mw-view" data-view="requests" hidden><div class="mw-section-note">Обращения Астаны · эта очередь не меняется при географическом просмотре другого города.</div><div id="mw-inbox" class="mw-inbox"><div class="mw-loading">Загружаем рабочую очередь…</div></div></section>
        <section class="mw-view" data-view="tasks" hidden><div class="mw-section-note">Рабочие черновики с ответственными, сроками и критериями проверки. Статусы обновляются вручную.</div><div id="action-register-panel"></div></section>
        <section class="mw-view" data-view="data" hidden><div class="mw-method-grid"><article class="mw-card"><div class="mw-eyebrow">ПРОЗРАЧНЫЙ РАСЧЁТ</div><h2>Город — это все его районы</h2><p>Индекс учитывает среднюю оценку, положение слабейшего района и каждый показатель ниже 40.</p><div class="mw-formula"><span><b>0,7</b> средняя оценка</span><em>+</em><span><b>0,3</b> худший район</span><em>−</em><span><b>n</b> критические значения</span></div><p class="mw-muted">Средняя взвешена по доле населения. Эффекты мер учитывают лаг реализации на горизонте 8 кварталов.</p></article><article class="mw-card mw-tinted"><span class="mw-pill">О границах модели</span><h2>Данные должны быть проверяемыми</h2><p>Пять районов и их показатели — синтетический набор кейса. 100 условных единиц не являются бюджетом в тенге.</p><p>Паспорта ниже позволяют хранить реальные наблюдения отдельно. Они не изменяют расчётный Score. Для практического применения нужны местные данные и калибровка эффектов.</p></article></div><div class="mw-module" id="evidence-register"></div></section>
      </div>
      <footer class="mw-footer"><span>ASCENSION <i>/</i> Городские решения</span><span>Учебные показатели · решения требуют проверки</span><a href="/mayor-data.html" data-route="data">О данных ${icon('arrow')}</a></footer>
    </main>
  </div>
  <dialog id="mw-search" class="mw-search"><form method="dialog"><div><h2>Куда перейти?</h2><button class="mw-icon-button" aria-label="Закрыть поиск">×</button></div></form><label class="mw-sr-only" for="mw-search-input">Название раздела</label><input id="mw-search-input" type="search" placeholder="Сценарии, обращения, районы…" autocomplete="off"><nav id="mw-search-results" aria-label="Результаты поиска"></nav></dialog>
  <div id="announcer" class="mw-sr-only" role="status" aria-live="polite"></div>`;

function setRoute(route, push = true) {
  if (!routes[route]) route='overview';
  currentRoute=route;
  if(push) history.pushState({route}, '', `/mayor-${route}.html`);
  document.title=`${routes[route][0]} · Ascension`;
  $('mw-crumb').textContent=routes[route][0];
  $('mw-page-title').textContent=routes[route][0];
  $('mw-page-subtitle').textContent=routes[route][1];
  document.querySelectorAll('.mw-view').forEach(view=>{ view.hidden=view.dataset.view!==route || (view.classList.contains('mw-model') && !currentCity.hasScenarioData); });
  document.querySelectorAll('.mw-sidebar nav [data-route]').forEach(a=>{if(a.dataset.route===route) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current');});
  document.body.classList.remove('mw-menu-open');
  document.querySelector('.mw-menu').setAttribute('aria-expanded','false');
  if($('mw-search').open) $('mw-search').close();
  if(route==='map' && dataset) void ensureMap();
  if(route==='requests') void ensureRequests();
  if(push){window.scrollTo({top:0,behavior:'instant'});$('mw-main').focus({preventScroll:true});}
}
document.addEventListener('click',event=>{
  const a=event.target.closest('a[data-route]');
  if(!a || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button!==0) return;
  event.preventDefault();setRoute(a.dataset.route);
});
window.addEventListener('popstate',()=>setRoute(routeFromPath(),false));
document.querySelector('.mw-menu').addEventListener('click',()=>{
  const open=document.body.classList.toggle('mw-menu-open');document.querySelector('.mw-menu').setAttribute('aria-expanded',String(open));
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){document.body.classList.remove('mw-menu-open');document.querySelector('.mw-menu').setAttribute('aria-expanded','false');}});
function searchRoutes(){const q=$('mw-search-input').value.toLocaleLowerCase('ru');const found=Object.entries(routes).filter(([,v])=>v.join(' ').toLocaleLowerCase('ru').includes(q));$('mw-search-results').innerHTML=found.map(([key,[name]])=>link(key,icon(key)+esc(name))).join('')||'<p>Раздел не найден. Попробуйте «районы» или «сценарии».</p>';}
$('mw-search-open').addEventListener('click',()=>{$('mw-search').showModal();searchRoutes();$('mw-search-input').focus();});
$('mw-search-input').addEventListener('input',searchRoutes);
$('mw-city').addEventListener('change',()=>changeCity(PLACES.find(p=>p.id===$('mw-city').value)));
$('mw-return').addEventListener('click',()=>changeCity(PLACES.find(p=>p.id==='astana')));
function changeCity(city, fromMap=false){
  if(!city)return;currentCity=city;$('mw-city').value=city.id;
  $('mw-geography').hidden=!!city.hasScenarioData;
  planner?.setCity(city);result=null;
  if(!fromMap){if(cityMap)cityMap.setCity(city);else window.dispatchEvent(new CustomEvent('city:changed',{detail:city}));}
  if(dataset)renderOverview();
  if(!city.hasScenarioData && ['overview','planner','analytics','districts','scenarios'].includes(currentRoute))setRoute('map');
  else setRoute(currentRoute,false);
}
window.addEventListener('city:changed',e=>{if(e.detail?.id && e.detail.id!==currentCity.id)changeCity(e.detail,true);});

function districtRows(value){return value.districts.map((d,index)=>`<a class="mw-district-row" href="/mayor-districts.html" data-route="districts"><span class="mw-row-index">0${index+1}</span><span class="mw-row-name">${esc(d.name)}<small>${num(dataset.districts.find(x=>x.id===d.id).populationShare*100,0)}% населения модели</small></span><span class="mw-bar"><i style="width:${Math.max(0,Math.min(100,d.afterScore))}%"></i></span><b>${num(d.afterScore)}</b>${icon('arrow')}</a>`).join('');}
function renderOverview(){
  const value=result||baseline;
  const weak=[...value.districts].sort((a,b)=>a.afterScore-b.afterScore)[0];
  const lowest=dataset.indicators.map(i=>({...i,value:weak.after[i.id]})).sort((a,b)=>a.value-b.value).slice(0,2);
  $('mw-overview').innerHTML=`
  <div class="mw-hero"><img src="/assets/mayor/astana-panorama.png" alt="Художественная панорама Астаны" fetchpriority="high"><div class="mw-hero-shade"></div><div class="mw-hero-copy"><span class="mw-hero-kicker"><i></i> АСТАНА · ГОРОД В РЕШЕНИЯХ</span><h2>Город начинается<br>с решений.</h2><p>Увидеть приоритеты. Сравнить возможности.<br>Выбрать то, что изменит жизнь районов.</p>${link('planner','Создать сценарий','mw-button mw-button-light')}</div><span class="mw-hero-caption">Астана, Казахстан · художественная панорама</span></div>
  <div class="mw-metrics"><article><span>${result?'Score сценария':'Исходный Score'} ${icon('analytics')}</span><strong>${num(value.score)}<small>/ 100</small></strong><p>${result?`Изменение: ${value.deltaScore>=0?'+':''}${num(value.deltaScore)}`:'Индекс качества жизни в модели'}</p></article><article><span>Районы в модели ${icon('districts')}</span><strong>${dataset.districts.length}<small>районов</small></strong><p>50 показателей городской среды</p></article><article><span>Бюджет сценария ${icon('planner')}</span><strong>${dataset.budget}<small>у. е.</small></strong><p>Условные единицы, не тенге</p></article><article><span>Горизонт решений ${icon('overview')}</span><strong>${dataset.horizon}<small>кварталов</small></strong><p>С учётом срока реализации мер</p></article></div>
  <div class="mw-overview-grid"><article class="mw-card mw-district-panel"><div class="mw-card-heading"><div><span class="mw-eyebrow">ГОРОД В ДЕТАЛЯХ</span><h2>Как живут районы</h2></div>${link('districts','Все показатели')}</div><p class="mw-muted">${result?'Результат текущего сценария':'Исходная оценка'} · выше — лучше</p>${districtRows(value)}<div class="mw-panel-foot"><span class="mw-dot"></span> Синтетические данные официального набора кейса</div></article><article class="mw-card mw-priority"><span class="mw-eyebrow">ФОКУС ВНИМАНИЯ</span><div class="mw-priority-title"><h2>${esc(weak.name)}</h2><span class="mw-pill">Приоритет модели</span></div><p>Район с самой низкой оценкой.<br>Начните с его слабых показателей.</p>${lowest.map(i=>`<div class="mw-priority-item"><span>${esc(i.name)}</span><b class="${i.value<40?'mw-critical':''}">${num(i.value,0)}<small>/ 100</small></b></div>`).join('')}${link('planner','Подобрать решения','mw-button')}<span class="mw-fineprint">Приоритет по учебным показателям, не оценка реальной ситуации.</span></article></div>
  <div class="mw-shortcuts"><a href="/mayor-scenarios.html" data-route="scenarios"><div><span class="mw-eyebrow">ПОДГОТОВКА К СОВЕЩАНИЮ</span><h3>Сохранить. Сравнить. Обосновать.</h3><p>Сценарии и записка по решению в одном месте.</p><span class="mw-text-action">Перейти к сценариям ${icon('arrow')}</span></div><img src="/assets/mayor/planning-icon.png" alt="" loading="lazy"></a><a href="/mayor-requests.html" data-route="requests"><div><span class="mw-eyebrow">ОБРАТНАЯ СВЯЗЬ</span><h3>Город говорит. Вы слышите.</h3><p>Обращения, ответственные и история работы.</p><span class="mw-text-action">Открыть обращения ${icon('arrow')}</span></div><img src="/assets/mayor/dialogue-icon.png" alt="" loading="lazy"></a></div>`;
}
function renderDistricts(){const value=result||baseline;
  $('mw-districts').innerHTML=`<div class="mw-section-note">${result?'После текущего расчёта':'Исходные значения'} · синтетические данные Астаны. Выше — лучше. Значения ниже 40 требуют внимания в модели.</div><div class="mw-district-tiles">${value.districts.map(d=>`<article class="mw-card"><span class="mw-eyebrow">РАЙОН</span><h2>${esc(d.name)}</h2><strong>${num(d.afterScore)}</strong><div class="mw-bar"><i style="width:${d.afterScore}%"></i></div><p>${dataset.indicators.filter(i=>d.after[i.id]<40).length} критических показателей</p></article>`).join('')}</div><div class="mw-card mw-table-card"><div class="mw-card-heading"><h2>Показатели городской среды</h2><span class="mw-pill">0–100 · учебная шкала</span></div><div class="mw-table-scroll" tabindex="0" role="region" aria-label="Таблица показателей районов"><table><thead><tr><th>Показатель</th>${value.districts.map(d=>`<th>${esc(d.name)}</th>`).join('')}</tr></thead><tbody>${dataset.indicators.map(i=>`<tr><th>${esc(i.name)}<small>${esc(i.id)} · вес ${num(i.weight*100,0)}%</small></th>${value.districts.map(d=>`<td class="${d.after[i.id]<40?'mw-critical-cell':''}">${num(d.after[i.id])}${result?`<small>${d.delta[i.id]>0?'+':''}${num(d.delta[i.id])}</small>`:''}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`;
}
async function ensureMap(){
  if(cityMap){window.dispatchEvent(new Event('resize'));return;}
  if(mapLoading)return;mapLoading=true;
  try{const {createCityMap}=await import('./map.js');cityMap=createCityMap({container:$('mw-city-map'),dataset,baseline,onDistrictSelect:id=>{planner?.focusDistrict(id);$('announcer').textContent='Район выбран. Он будет предложен для новых мер в конструкторе.';}});if(currentCity.id!=='astana')cityMap.setCity(currentCity);if(result)cityMap.setResult(result);await cityMap.ready;window.dispatchEvent(new Event('resize'));}
  catch{ $('mw-city-map').innerHTML='<div class="mw-error">Не удалось открыть карту. <a href="/">Открыть основной симулятор</a></div>'; }
  finally{mapLoading=false;}
}
async function ensureRequests(){
  if(requestsLoaded)return;requestsLoaded=true;
  try{const response=await fetch('/mayor.html');if(!response.ok)throw new Error();const html=await response.text();const source=new DOMParser().parseFromString(html,'text/html').querySelector('main');if(!source?.querySelector('#filter-form'))throw new Error();
    $('mw-inbox').replaceChildren(...source.children);
    $('mw-inbox').querySelector('footer')?.remove();
    await import('./mayor.js');
    await import('./location-map.js').catch(()=>{const note=document.createElement('p');note.className='mw-section-note';note.textContent='Ссылки географической карты не загрузились. Очередь обращений доступна; обновите страницу для повторной загрузки карты.';$('mw-inbox').append(note);});
  }catch{requestsLoaded=false;$('mw-inbox').innerHTML='<div class="mw-error">Не удалось загрузить очередь. <a href="/mayor.html">Открыть кабинет обращений</a></div>';}
}
async function initialize(){try{
  const responses=await Promise.all(['/api/dataset','/api/baseline'].map(url=>fetch(url,{signal:AbortSignal.timeout(15000)})));
  if(responses.some(r=>!r.ok))throw new Error('Данные города временно недоступны.');
  [dataset,baseline]=await Promise.all(responses.map(r=>r.json()));
  if(!baseline.valid||!dataset.measures?.length)throw new Error('Не удалось прочитать модель города.');
  renderOverview();renderDistricts();
  mountScenarioLibrary($('scenario-library'),{city:currentCity});
  mountPolicyOptionsPanel($('policy-options-panel'),{dataset,city:currentCity,fetcher:createPolicyOptionsFetcher()});
  mountActionRegister($('action-register-panel'),{dataset,city:currentCity});
  mountDecisionBrief($('decision-brief'),{dataset,city:currentCity});
  mountEvidenceRegister($('evidence-register'),{dataset,city:currentCity});
  await import('./comparison.js');
  planner=mountMayorPlanner($('mw-planner'),{dataset,baseline,resultContainer:$('mw-result'),onCalculated:detail=>{result=detail.result;renderOverview();renderDistricts();cityMap?.setResult(result);},onInvalidated:()=>{result=null;renderOverview();renderDistricts();cityMap?.setResult(null);},onOpenResults:()=>setRoute('analytics')});
  planner.setCity(currentCity);
  window.addEventListener('scenario:load',()=>setRoute('planner'));
  $('mw-loading').hidden=true;$('mw-views').hidden=false;setRoute(currentRoute,false);
}catch(error){$('mw-loading').hidden=true;$('mw-fatal').hidden=false;$('mw-fatal').innerHTML=`<strong>Не удалось загрузить рабочее пространство</strong><p>${esc(error.message)}</p><button id="mw-retry" class="mw-button">Повторить</button>`;$('mw-retry').addEventListener('click',()=>location.reload());}}
setRoute(currentRoute,false);
void initialize();
