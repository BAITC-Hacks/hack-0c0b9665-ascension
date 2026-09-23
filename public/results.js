const byId = (id) => document.getElementById(id);
const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
let activeRequest = null;
const parameters = new URLSearchParams(window.location.search);
let selectedDistrict = parameters.get('districtId') || '';
let search = (parameters.get('q') || '').slice(0, 160);
let confirmation = ['confirmed', 'pending'].includes(parameters.get('confirmation')) ? parameters.get('confirmation') : '';
let source = ['real', 'demo'].includes(parameters.get('source')) ? parameters.get('source') : '';
let sort = ['oldest', 'fastest'].includes(parameters.get('sort')) ? parameters.get('sort') : 'newest';
let allResults = [];
let districtNames = new Map();

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined && text !== null) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}
function dateText(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? dateFormat.format(date) : 'Не указано';
}
function daysText(value) {
  if (!Number.isFinite(value) || value < 0) return 'Не указан';
  const days = Math.round(value);
  return days === 0 ? 'Менее дня' : `До ${days.toLocaleString('ru-RU')} дн.`;
}
function detail(label, value) {
  const item = node('div');
  item.append(node('dt', label), node('dd', value));
  return item;
}
function publicPhotoUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || !['http:', 'https:'].includes(url.protocol) || !url.pathname.startsWith('/api/public/results/') || !url.pathname.includes('/photos/')) return null;
    return `${url.pathname}${url.search}`;
  } catch { return null; }
}
function photoGroup(label, entries, title) {
  const group = node('div', null, 'photo-group');
  group.append(node('h3', label));
  const photos = (Array.isArray(entries) ? entries : []).map((photo) => publicPhotoUrl(photo?.url)).filter(Boolean);
  if (!photos.length) group.append(node('p', 'Фото не опубликовано', 'no-photo'));
  photos.forEach((url, index) => {
    const figure = node('figure');
    const link = node('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `Открыть фото: ${label.toLowerCase()}, ${title}${photos.length > 1 ? `, ${index + 1}` : ''} (в новой вкладке)`);
    const image = document.createElement('img');
    image.alt = `${label}: ${title}${photos.length > 1 ? ` — фото ${index + 1}` : ''}`;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.width = 480;
    image.height = 360;
    image.addEventListener('error', () => link.replaceWith(node('p', 'Фото временно недоступно', 'photo-unavailable')), { once: true });
    image.src = url;
    link.append(image);
    figure.append(link);
    if (photos.length > 1) figure.append(node('figcaption', `Фото ${index + 1} из ${photos.length}`));
    group.append(figure);
  });
  return group;
}
function resultCard(result) {
  const article = node('article', null, 'result-card');
  const copy = node('div', null, 'result-card-copy');
  const tags = node('div', null, 'tag-row');
  tags.append(node('span', districtNames.get(result.districtId) || result.districtId || 'Город', 'district-tag'));
  if (result.source === 'demo') tags.append(node('span', 'Демонстрационные данные', 'tag demo-tag'));
  const title = result.title || 'Выполненные работы';
  copy.append(tags, node('h2', title), node('p', result.summary || '', 'result-summary'));
  const dates = node('dl', null, 'result-dates');
  dates.append(detail('Работы завершены', dateText(result.completedAt)), detail('От обращения до результата', daysText(result.durationDays)));
  copy.append(dates);
  const confirmation = node('p', null, `confirmation${result.residentConfirmed ? ' confirmed' : ''}`);
  const symbol = node('span', result.residentConfirmed ? '✓' : '·', 'confirmation-symbol');
  symbol.setAttribute('aria-hidden', 'true');
  confirmation.append(symbol, node('span', result.residentConfirmed ? 'Житель подтвердил: проблема решена' : 'Подтверждение жителя пока не получено'));
  copy.append(confirmation, node('p', `Опубликовано ${dateText(result.publishedAt)}`, 'published-at'));
  const details = node('details', null, 'result-details');
  details.append(node('summary', 'Подробнее о результате'));
  const provenance = node('dl', null, 'result-dates');
  provenance.append(detail('Работы завершены', dateText(result.completedAt)), detail('Публикация', dateText(result.publishedAt)));
  details.append(provenance, node('p', result.residentConfirmed ? 'Житель подтвердил, что проблема решена. Если ситуация изменится и обращение вернётся в работу, публикация будет скрыта.' : 'Работы завершены по отчёту команды. Подтверждение жителя пока не получено.', 'muted'));
  copy.append(details);
  article.append(copy);
  if ((Array.isArray(result.before) && result.before.length) || (Array.isArray(result.after) && result.after.length)) {
    const photos = node('div', null, 'comparison-photos');
    photos.append(photoGroup('До работ', result.before, title), photoGroup('После работ', result.after, title));
    article.append(photos);
  }
  return article;
}
function setDistricts(districts) {
  districtNames = new Map(districts.map((district) => [district.id, district.name]));
  const all = node('option', 'Все районы');
  all.value = '';
  byId('district-filter').replaceChildren(all, ...districts.map((district) => {
    const option = node('option', district.name);
    option.value = district.id;
    return option;
  }));
  if (selectedDistrict && !districtNames.has(selectedDistrict)) {
    selectedDistrict = '';
    byId('filter-notice').textContent = 'Район из ссылки не найден. Показаны результаты всех районов.';
    byId('filter-notice').hidden = false;
    syncUrl();
  }
  byId('district-filter').value = selectedDistrict;
}
function syncUrl() {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries({ districtId: selectedDistrict, q: search, confirmation, source, sort: sort === 'newest' ? '' : sort })) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  history.replaceState(null, '', `${url.pathname}${url.search}`);
}
function renderResults() {
  const normalize = value => String(value || '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
  const terms = normalize(search.trim()).split(/\s+/).filter(Boolean);
  const items = allResults.filter(item => {
    const text = normalize(`${item.title} ${item.summary} ${districtNames.get(item.districtId) || ''}`);
    return (!selectedDistrict || item.districtId === selectedDistrict) && terms.every(term => text.includes(term)) &&
      (!confirmation || Boolean(item.residentConfirmed) === (confirmation === 'confirmed')) &&
      (!source || (item.source === 'demo') === (source === 'demo'));
  });
  const timestamp = item => new Date(item.publishedAt || item.completedAt).getTime() || 0;
  items.sort((a, b) => sort === 'fastest' ? (Number.isFinite(a.durationDays) ? a.durationDays : Infinity) - (Number.isFinite(b.durationDays) ? b.durationDays : Infinity) || timestamp(b) - timestamp(a) : sort === 'oldest' ? timestamp(a) - timestamp(b) : timestamp(b) - timestamp(a));
  byId('results-grid').replaceChildren(...items.map(resultCard));
  byId('results-count').textContent = `Показано: ${items.length} из ${allResults.length}${selectedDistrict ? ` · ${districtNames.get(selectedDistrict)}` : ' · все районы'}`;
  byId('results-empty').hidden = items.length !== 0;
  const filtered = Boolean(selectedDistrict || search.trim() || confirmation || source);
  byId('empty-title').textContent = allResults.length && filtered ? 'По вашим условиям ничего не найдено' : 'Первые результаты ещё впереди';
  byId('empty-copy').textContent = allResults.length && filtered ? 'Попробуйте другое слово, выберите другой район или сбросьте фильтры.' : 'Завершённые работы появятся здесь после публикации командой. Пока можно пройти учебную демонстрацию.';
  byId('clear-filter').hidden = !filtered;
  byId('reset-filters').hidden = !filtered && sort === 'newest';
  byId('empty-demo-link').hidden = allResults.length > 0;
  byId('results-stats').hidden = false;
  byId('stat-total').textContent = items.length.toLocaleString('ru-RU');
  byId('stat-confirmed').textContent = items.filter(item => item.residentConfirmed).length.toLocaleString('ru-RU');
  const durations = items.map(item => item.durationDays).filter(value => Number.isFinite(value) && value >= 0);
  byId('stat-duration').textContent = durations.length ? daysText(durations.reduce((sum, value) => sum + value, 0) / durations.length) : '—';
}
async function loadResults() {
  activeRequest?.abort();
  const controller = new AbortController();
  activeRequest = controller;
  const timeout = setTimeout(() => controller.abort(), 15000);
  byId('results-grid').setAttribute('aria-busy', 'true');
  byId('results-loading').hidden = false;
  byId('results-error').hidden = true;
  byId('results-empty').hidden = true;
  byId('retry-results').disabled = true;
  byId('refresh-results').disabled = true;
  try {
    const response = await fetch('/api/public/results', { credentials: 'omit', cache: 'no-store', signal: controller.signal });
    if (activeRequest !== controller || controller.signal.aborted) return;
    if (!response.ok) throw new Error(response.status === 429 ? 'Слишком много запросов. Подождите немного и повторите попытку.' : 'Сервер временно недоступен. Попробуйте ещё раз.');
    const data = await response.json();
    if (activeRequest !== controller || controller.signal.aborted) return;
    if (!data || !Array.isArray(data.items) || !Array.isArray(data.districts)) throw new Error('Не удалось прочитать результаты. Попробуйте ещё раз.');
    allResults = data.items;
    setDistricts(data.districts);
    byId('district-filter').disabled = false;
    renderResults();
  } catch (error) {
    if (activeRequest !== controller) return;
    byId('results-error-copy').textContent = controller.signal.aborted ? 'Сервер отвечает дольше обычного. Проверьте соединение и повторите попытку.' : error.message === 'Failed to fetch' ? 'Нет связи с сервером. Проверьте соединение и повторите попытку.' : error.message;
    // Previously displayed work may have been reopened; do not show stale publications as current.
    allResults = [];
    byId('results-grid').replaceChildren();
    byId('results-stats').hidden = true;
    byId('results-count').textContent = '';
    byId('results-error').hidden = false;
  } finally {
    clearTimeout(timeout);
    if (activeRequest === controller) {
      byId('results-loading').hidden = true;
      byId('results-grid').setAttribute('aria-busy', 'false');
      byId('retry-results').disabled = false;
      byId('refresh-results').disabled = false;
      activeRequest = null;
    }
  }
}
function applyFilters() {
  selectedDistrict = byId('district-filter').value;
  search = byId('result-search').value;
  confirmation = byId('confirmation-filter').value;
  source = byId('source-filter').value;
  sort = byId('result-sort').value;
  syncUrl();
  if (activeRequest || !byId('results-error').hidden) return;
  renderResults();
}
function resetFilters() {
  byId('results-filters').reset();
  applyFilters();
  byId('result-search').focus();
}
byId('result-search').value = search;
byId('confirmation-filter').value = confirmation;
byId('source-filter').value = source;
byId('result-sort').value = sort;
byId('results-filters').addEventListener('submit', event => { event.preventDefault(); applyFilters(); });
byId('results-filters').addEventListener('change', applyFilters);
byId('result-search').addEventListener('input', applyFilters);
byId('clear-filter').addEventListener('click', resetFilters);
byId('reset-filters').addEventListener('click', resetFilters);
byId('retry-results').addEventListener('click', loadResults);
byId('refresh-results').addEventListener('click', loadResults);
loadResults();
