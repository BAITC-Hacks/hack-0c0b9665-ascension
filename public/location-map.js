// External mapping is opt-in. No resident text, receipt, or staff token enters map URLs.
const panel = document.getElementById('location-map-panel');
const caption = document.getElementById('location-map-caption');
const actions = document.getElementById('location-map-actions');
let current = null;

function externalLink(text, href) {
  const link = document.createElement('a');
  link.className = 'button secondary small';
  link.textContent = text;
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

window.addEventListener('mayor:selection', event => {
  const next = event.detail;
  const signature = JSON.stringify(next);
  if (signature === current) return;
  current = signature;
  actions.replaceChildren();
  if (!next) {
    caption.textContent = 'Выберите обращение в списке или точку на схеме.';
    return;
  }
  const location = next.location;
  const hasPoint = location && Number.isFinite(location.lat) && Number.isFinite(location.lon)
    && Math.abs(location.lat) <= 85 && Math.abs(location.lon) <= 180;
  caption.textContent = hasPoint
    ? `Обращение ${next.id}. Географическая карта откроется в отдельной вкладке. OpenStreetMap получит координаты выбранного места; текст жалобы и код проверки не передаются.`
    : 'У этого обращения нет координат, которые можно показать на карте. Можно открыть поиск адреса в OpenStreetMap; сервис получит только указанный адрес.';
  if (hasPoint) {
    const { lat, lon } = location;
    actions.append(externalLink('Открыть карту OpenStreetMap',
      `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`));
  }
  if (typeof next.address === 'string' && next.address.trim()) {
    const searchUrl = new URL('https://www.openstreetmap.org/search');
    searchUrl.searchParams.set('query', `Астана, ${next.address.trim()}`);
    actions.append(externalLink('Найти адрес на карте', searchUrl.href));
  }
  panel.hidden = false;
});
