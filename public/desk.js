import { mountResidentTools } from './staff-resident.js';
import { downloadCsv } from './staff-export.js';
const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const date = v => new Date(v).toLocaleString('ru-RU');
let config, dataset, users, page = 1, total = 0, current, dirty = false, scenarios = [], selected = [], requestVersion = 0;
const filterFields = ['q', 'districtId', 'category', 'status', 'from', 'to'];
const initialQuery = new URLSearchParams(location.search);
let filterQuery = new URLSearchParams(filterFields.filter(key => initialQuery.has(key)).map(key => [key, initialQuery.get(key)]));
function saveFilterLocation() {
  const url = new URL(location.href);
  for (const key of filterFields) {
    if (filterQuery.get(key)) url.searchParams.set(key, filterQuery.get(key));
    else url.searchParams.delete(key);
  }
  history.replaceState(null, '', url.pathname + url.search + url.hash);
}
function renderQuickFilters() {
  $('quick-filters').innerHTML = [['', 'Все статусы'], ...Object.entries(config.statuses)].map(([value, label]) => `<button type="button" data-status="${esc(value)}" aria-pressed="${(filterQuery.get('status') || '') === value}">${esc(label)}</button>`).join('');
}
const district = id => dataset.districts.find(d => d.id === id)?.name || 'Район не уточнён';
const opts = (map, value, empty = 'Все') => `<option value="">${empty}</option>` + Object.entries(map).map(([id,name]) => `<option value="${esc(id)}"${id === value ? ' selected' : ''}>${esc(name)}</option>`).join('');
const districts = () => Object.fromEntries(dataset.districts.map(d => [d.id,d.name]));
function notice(message, error = false) { $('notice').textContent = message; $('notice').className = error ? 'error' : ''; }
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(path, { method, headers: { 'Content-Type':'application/json', 'X-Desk-Request':'1' }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
    const data = await res.json();
    if (!res.ok) { if (res.status === 401 && !path.endsWith('/login')) { $('workspace').hidden = true; $('login').hidden = false; $('account').replaceChildren(); } throw new Error(data.message || data.errors?.[0]?.message || 'Ошибка сервера.'); }
    return data;
  } catch(e) { if (e.name === 'AbortError') throw new Error('Сервер не ответил. Повторите действие.'); if (e instanceof TypeError) throw new Error('Нет связи с сервером. Данные формы сохранены — повторите действие.'); throw e; }
  finally { clearTimeout(timeout); }
}
async function action(button, fn, modal = false) {
  if (button.disabled) return;
  button.disabled = true; button.dataset.busy = 'true'; const original = button.textContent; button.textContent = 'Подождите…';
  if(modal) $('modal-error').textContent = '';
  try { await fn(); } catch(e) { if(modal) $('modal-error').textContent = e.message; else notice(e.message,true); }
  finally { delete button.dataset.busy; button.disabled = button.id === 'prev' ? page === 1 : button.id === 'next' ? page * 10 >= total : button.id === 'export' ? total === 0 : false; button.textContent = original; }
}
function openModal(html) { $('modal-content').innerHTML = html; $('modal-error').textContent = ''; dirty = false; if (!$('modal').open) $('modal').showModal(); }
function closeModal() { if (dirty && !confirm('Закрыть без сохранения изменений?')) return; $('modal').close(); dirty = false; }
$('close').onclick = closeModal;
$('modal').addEventListener('cancel', e => { e.preventDefault(); closeModal(); });
$('modal').addEventListener('input', () => dirty = true);
window.addEventListener('beforeunload', e => { if(dirty){e.preventDefault();e.returnValue='';} });
async function refresh() {
  const version = ++requestVersion; const query = new URLSearchParams(filterQuery); query.set('page',page);
  const data = await api(`/api/desk/complaints?${query}`); if(version !== requestVersion) return;
  total = data.total; saveFilterLocation(); renderQuickFilters(); $('export').disabled = total === 0 || $('export').dataset.busy === 'true';
  $('filter-summary').textContent = total ? `Показаны ${(page - 1) * 10 + 1}–${Math.min(page * 10, total)} из ${total}. CSV включает всю выбранную выборку.` : 'По текущим фильтрам обращений нет.'; if(page > 1 && (page - 1) * 10 >= total) { page = Math.max(1,Math.ceil(total/10)); return refresh(); }
  $('stats').innerHTML = [['В выборке',total],['Новые',data.stats.new],['Открытые',data.stats.open],['Решённые',data.stats.resolved]].map(([label,n])=>`<article class="stat"><span>${label}</span><strong>${n}</strong></article>`).join('');
  $('list').innerHTML = data.items.length ? data.items.map(i => `<article class="row"><span class="muted">№ ${i.id}<br>Демо</span><div class="row-copy"><p class="summary">${esc(i.text.slice(0,150))}${i.text.length>150?'…':''}</p><p class="muted">${esc(district(i.districtId))} · ${esc(config.categories[i.category])}</p><p class="muted">${date(i.createdAt)} · ${esc(i.assignee || 'Не назначен')}</p>${i.residentFeedback ? `<p class="badge">${i.residentFeedback.outcome === 'confirmed' ? 'Житель подтвердил результат' : 'Житель: проблема осталась'}</p>` : ''}</div><span class="badge">${esc(config.statuses[i.status])}</span><span class="muted">${i.priority==='high'?'Высокий приоритет':'Обычный приоритет'}</span><button data-open="${i.id}" aria-label="Открыть обращение ${i.id}">Открыть</button></article>`).join('') : '<div class="empty"><h3>Обращений не найдено</h3><p>Измените фильтры или создайте демонстрационное обращение.</p></div>';
  $('prev').disabled=page===1; $('next').disabled=page*10>=total; $('page').textContent=`Страница ${page} из ${Math.max(1,Math.ceil(total/10))}`;
  $('synced').textContent=`Обновлено ${new Date().toLocaleTimeString('ru-RU')} · статистика по выбранным фильтрам`;
}
async function loadScenarios() {
  scenarios = await api('/api/desk/scenarios');
  $('scenarios').innerHTML = scenarios.length ? scenarios.map(s=>`<article class="scenario"><div><strong>${esc(s.name)}</strong><p class="muted">Score ${s.result.score.toFixed(2)} · бюджет ${s.result.totalCost} · ${date(s.createdAt)}${s.complaintId?` · обращение № ${s.complaintId}`:''}</p></div><div class="actions"><button data-load="${s.id}">Загрузить</button><button data-compare="${s.id}" aria-pressed="false">Сравнить</button></div></article>`).join('') : '<p class="muted">Сохраните первый рассчитанный сценарий в конструкторе — он останется здесь после перезапуска.</p>';
  selected=[]; $('saved-comparison').replaceChildren();
}
async function authenticated(user) {
  config.user = user; $('login').hidden=true; $('workspace').hidden=false;
  $('account').innerHTML=`<span class="muted">${esc(user.login)}</span><button id="logout">Выйти</button>`;
  $('logout').onclick=e=>action(e.currentTarget,async()=>{await api('/api/desk/logout',{}); location.reload();});
  users=await api('/api/desk/users'); await Promise.all([refresh(),loadScenarios()]);
  const linkedId = Number(new URLSearchParams(location.search).get('complaint'));
  if(Number.isSafeInteger(linkedId) && linkedId > 0) await detail(linkedId);
}
$('login-form').onsubmit=e=>{e.preventDefault(); const form=e.currentTarget; action(form.querySelector('button'),async()=>{const result=await api('/api/desk/login',Object.fromEntries(new FormData(form)));form.reset();await authenticated(result.user);notice('Вы вошли в кабинет.');});};
$('filters').onsubmit=e=>{e.preventDefault(); const data = new FormData(e.currentTarget); if(data.get('from') && data.get('to') && data.get('from')>data.get('to')){notice('Начальная дата должна быть не позже конечной.',true);return;} filterQuery=new URLSearchParams(data);page=1;action(e.currentTarget.querySelector('button'),refresh);};
$('quick-filters').onclick=e=>{const button=e.target.closest('[data-status]');if(!button)return;filterQuery.set('status',button.dataset.status);$('filters').status.value=button.dataset.status;page=1;action(button,refresh);};
$('export').onclick=e=>action(e.currentTarget,async()=>{
  const query=new URLSearchParams(filterQuery);query.set('page','1');
  const first=await api(`/api/desk/complaints?${query}`);const items=[...first.items];
  const pages=Math.ceil(first.total/10);
  for(let start=2;start<=pages;start+=4){
    const batch=await Promise.all(Array.from({length:Math.min(4,pages-start+1)},(_,offset)=>{const params=new URLSearchParams(query);params.set('page',start+offset);return api(`/api/desk/complaints?${params}`);}));
    items.push(...batch.flatMap(data=>data.items));
  }
  const unique=[...new Map(items.map(item=>[item.id,item])).values()];
  downloadCsv(`ascension-complaints-${new Date().toISOString().slice(0,10)}.csv`,[
    ['Номер','Получено (UTC)','Район','Категория','Адрес','Описание','Статус','Приоритет','Ответственный','Ответ жителя'],
    ...unique.map(item=>[item.id,item.createdAt,district(item.districtId),config.categories[item.category],item.address,item.text,config.statuses[item.status],item.priority==='high'?'Высокий':'Обычный',item.assignee,item.residentFeedback?.outcome==='confirmed'?'Результат подтверждён':item.residentFeedback?'Проблема осталась':'Нет ответа'])
  ]);
  notice(`Выгружено обращений: ${unique.length}. Файл содержит все страницы выбранной выборки.`);
});
$('clear').onclick=e=>action(e.currentTarget,async()=>{$('filters').reset();filterQuery=new URLSearchParams();page=1;await refresh();});
$('refresh').onclick=e=>action(e.currentTarget,async()=>{await Promise.all([refresh(),loadScenarios()]);notice('Данные обновлены.');});
$('prev').onclick=e=>action(e.currentTarget,async()=>{page--;await refresh();}); $('next').onclick=e=>action(e.currentTarget,async()=>{page++;await refresh();});
$('new').onclick=()=>{
  const submissionId=crypto.randomUUID();
  openModal(`<h2>Новое демо-обращение</h2><p class="muted">Тестовая запись для подготовки сайта. Не отправляется в городские службы.</p><form id="create-form"><label>Описание проблемы<textarea name="text" required maxlength="5000" placeholder="Что произошло и где нужна помощь?"></textarea></label><div class="form-grid"><label>Район<select name="districtId">${opts(districts(),'', 'Нужно уточнить')}</select></label><label>Категория<select name="category" required>${opts(config.categories,'','Выберите категорию')}</select></label></div><label>Адрес<input name="address" maxlength="300" placeholder="Улица, дом или ориентир"></label><button class="primary">Зарегистрировать демо-обращение</button></form>`);
  $('create-form').onsubmit=e=>{e.preventDefault();const form=e.currentTarget;action(form.querySelector('button'),async()=>{const item=await api('/api/desk/complaints',{...Object.fromEntries(new FormData(form)),submissionId});dirty=false;await detail(item.id);await refresh();notice(`Демонстрационное обращение № ${item.id} зарегистрировано.`);},true);};
};
$('list').onclick=e=>{const b=e.target.closest('[data-open]');if(b)action(b,()=>detail(Number(b.dataset.open)));};
async function detail(id) {
  current=await api(`/api/desk/complaints/${id}`); const i=current;
  const allowed=Object.fromEntries([i.status,...config.transitions[i.status]].map(k=>[k,config.statuses[k]]));
  openModal(`<p class="eyebrow">ДЕМО / ОБРАЩЕНИЕ № ${i.id}</p><h2>Карточка обращения</h2><p class="muted">${date(i.createdAt)} · ${esc(i.address||'Адрес не указан')}</p><p class="detail-text">${esc(i.text)}</p><div class="actions card-links"><a class="button" href="/akim.html?complaint=${i.id}#problems">Открыть в кабинете акима</a><button type="button" id="copy-card">Скопировать ссылку на карточку</button></div><p id="card-link-status" class="muted" role="status"></p><form id="edit-form"><div class="form-grid"><label>Статус<select name="status">${opts(allowed,i.status,'Выберите статус')}</select></label><label>Ответственный<select name="assignee">${opts(Object.fromEntries(users.map(u=>[u.login,u.login])),i.assignee,'Не назначен')}</select></label><label>Район<select name="districtId">${opts(districts(),i.districtId,'Нужно уточнить')}</select></label><label>Категория<select name="category" required>${opts(config.categories,i.category,'Выберите категорию')}</select></label><label>Приоритет<select name="priority"><option value="normal"${i.priority==='normal'?' selected':''}>Обычный</option><option value="high"${i.priority==='high'?' selected':''}>Высокий</option></select></label></div><label>Внутренний комментарий<textarea name="note" maxlength="2000" placeholder="Только для команды. Для высокого приоритета укажите причину."></textarea></label><label>Ответ жителю<textarea name="publicReply" maxlength="2000" placeholder="Обязателен для уточнения, решения или отказа."></textarea></label><p class="muted">Бот не подключён. Ответ сохранится в карточке без отправки.</p><div class="actions"><button class="primary">Сохранить изменения</button><button type="button" id="reload-card">Обновить карточку</button></div></form><details open><summary>Фотографии (${i.attachments.length}/5)</summary><p class="muted">JPEG, PNG или WebP · до 2 МБ на фото. Открытие — в новой вкладке.</p><div class="photos">${i.attachments.map(a=>`<a href="/api/desk/attachments/${a.id}" target="_blank" rel="noopener"><img src="/api/desk/attachments/${a.id}" alt="${esc(a.name)}">${esc(a.name)}</a>`).join('')}</div><form id="upload-form"><label>Добавить фото<input type="file" name="photo" accept="image/jpeg,image/png,image/webp" required${i.attachments.length>=5?' disabled':''}></label><button${i.attachments.length>=5?' disabled':''}>Загрузить фото</button></form></details><details><summary>Связать с городской мерой</summary><p class="muted">Это предложение для учебного сценария. Выберите подходящую меру вручную; она не закроет обращение.</p><form id="measure-form"><label>Мера<select name="measure" required>${opts(Object.fromEntries(dataset.measures.map(m=>[m.id,`${m.id} · ${m.name} · ${m.cost} у. е.`])),'','Выберите меру')}</select></label><label>Район реализации<select name="districtId">${opts(districts(),i.districtId,'Выберите район для районной меры')}</select></label><button>Открыть меру в конструкторе</button></form></details><details><summary>Ответы жителю (${i.replies.length})</summary>${i.replies.length?i.replies.map(r=>`<p class="detail-text">${esc(r.text)}</p><p class="muted">${date(r.at)} · ${esc(r.actor)} · Не отправлено: бот не подключён</p>`).join(''):'<p class="muted">Ответов пока нет.</p>'}</details><details><summary>История изменений (${i.history.length})</summary><ol class="history">${[...i.history].reverse().map(h=>`<li>${esc(h.text)}<br><span class="muted">${date(h.at)} · ${esc(h.actor)}</span></li>`).join('')}</ol></details>`);
  $('copy-card').onclick=e=>action(e.currentTarget,async()=>{const url=new URL('/desk.html',location.origin);url.searchParams.set('complaint',i.id);try{await navigator.clipboard.writeText(url.href);$('card-link-status').textContent='Ссылка на карточку скопирована. Для просмотра нужен вход в кабинет.';}catch{const field=document.createElement('input');field.readOnly=true;field.value=url.href;field.setAttribute('aria-label','Ссылка на карточку');$('card-link-status').replaceChildren(field);field.select();}},true);
  $('edit-form').onsubmit=e=>{e.preventDefault();const form=e.currentTarget;action(form.querySelector('button'),async()=>{await api(`/api/desk/complaints/${i.id}`,{...Object.fromEntries(new FormData(form)),version:i.version},'PATCH');dirty=false;await detail(i.id);await refresh();notice('Изменения сохранены. Ответы не отправлялись — бот не подключён.');},true);};
  $('reload-card').onclick=e=>{if(dirty&&!confirm('Обновить карточку и отменить несохранённые изменения?'))return;action(e.currentTarget,()=>detail(i.id),true);};
  $('upload-form').onsubmit=e=>{e.preventDefault();const form=e.currentTarget; action(form.querySelector('button'),async()=>{if(dirty&&!confirm('Загрузка обновит карточку. Несохранённые поля будут сброшены. Продолжить?'))return;const file=form.photo.files[0];if(!file||file.size>2*1024*1024)throw new Error('Выберите фото размером до 2 МБ.');const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(new Error('Не удалось прочитать фото.'));reader.readAsDataURL(file);});await api(`/api/desk/complaints/${i.id}/attachments`,{name:file.name,mime:file.type,base64});await detail(i.id);notice('Фотография сохранена.');},true);};
  $('measure-form').onsubmit=e=>{e.preventDefault();const form=e.currentTarget;const m=dataset.measures.find(m=>m.id===form.measure.value);if(m.scope==='district'&&!form.districtId.value){$('modal-error').textContent='Выберите район реализации меры.';return;}if(dirty&&!confirm('Открыть конструктор? Несохранённые изменения карточки будут потеряны.'))return;dirty=false;const params=new URLSearchParams({complaint:i.id,measure:m.id});if(m.scope==='district')params.set('district',form.districtId.value);location.href=`/?${params}#workspace`;};
  mountResidentTools($('modal-content'), i, config.user);
}
$('scenarios').onclick=e=>{
  const load=e.target.closest('[data-load]');if(load){location.href=`/?saved=${load.dataset.load}#workspace`;return;}
  const compare=e.target.closest('[data-compare]');if(!compare)return;const id=Number(compare.dataset.compare);
  selected=selected.includes(id)?selected.filter(x=>x!==id):[...selected,id].slice(-2);
  document.querySelectorAll('[data-compare]').forEach(b=>{b.setAttribute('aria-pressed',String(selected.includes(Number(b.dataset.compare))));b.textContent=selected.includes(Number(b.dataset.compare))?'Убрать из сравнения':'Сравнить';});
  if(selected.length<2){$('saved-comparison').textContent=selected.length?'Выберите ещё один сценарий для сравнения.':'';return;}
  const [a,b]=selected.map(id=>scenarios.find(s=>s.id===id));
  $('saved-comparison').innerHTML=`<table><caption>${esc(a.name)} (A) и ${esc(b.name)} (B)</caption><thead><tr><th>Показатель</th><th>A</th><th>B</th><th>B − A</th></tr></thead><tbody>${[['Score',a.result.score,b.result.score],['Бюджет, у. е.',a.result.totalCost,b.result.totalCost],...a.result.districts.map(d=>[d.name,d.afterScore,b.result.districts.find(x=>x.id===d.id).afterScore])].map(([n,x,y])=>`<tr><th>${esc(n)}</th><td>${x.toFixed(2)}</td><td>${y.toFixed(2)}</td><td>${(y-x).toFixed(2)}</td></tr>`).join('')}</tbody></table>${a.datasetVersion!==b.datasetVersion?'<p>Внимание: сценарии рассчитаны на разных версиях данных.</p>':''}`;
};
async function init(){try{[config,dataset]=await Promise.all([api('/api/desk/session'),api('/api/dataset')]); const f=$('filters');f.districtId.innerHTML=opts(districts());f.category.innerHTML=opts(config.categories);f.status.innerHTML=opts(config.statuses);for(const key of filterFields){if(f.elements[key])f.elements[key].value=filterQuery.get(key)||'';}filterQuery=new URLSearchParams(new FormData(f));if(config.user)await authenticated(config.user);else{$('login').hidden=false;$('setup').textContent=config.configured?'Используйте учётную запись, созданную администратором.':'Учётные записи ещё не настроены. Администратору: npm run desk:user -- имя admin';$('login-form').querySelector('button').disabled=!config.configured;}}catch(e){notice(e.message,true);const retry=document.createElement('button');retry.textContent='Повторить загрузку';retry.onclick=()=>{retry.remove();void init();};$('notice').append(' ',retry);}}
void init();
