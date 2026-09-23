// Overview reads canonical data. Calculations and saved scenarios remain in their existing modules.
const byId = (id) => document.getElementById(id);
const format = (value, digits = 2) => Number.isFinite(value) ? value.toLocaleString('ru-RU', { maximumFractionDigits: digits }) : '—';
let generation = 0;
let request;
async function loadOverview() {
  const version = ++generation;
  request?.abort();
  const controller = new AbortController(); request = controller;
  const timeout = setTimeout(() => controller.abort(), 15000);
  byId('home-data-loading').hidden = false; byId('home-data-error').hidden = true; byId('home-retry').disabled = true;
  const read = async (path) => { const response = await fetch(path, { signal: controller.signal, headers: { Accept: 'application/json' } }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); };
  try {
    const [dataset, baseline, health] = await Promise.all([read('/api/dataset'), read('/api/baseline'), read('/api/health').catch(() => null)]);
    if (version !== generation) return;
    if (!Array.isArray(dataset.districts) || !Array.isArray(baseline.districts) || !Number.isFinite(baseline.score)) throw new Error('Invalid model data');
    byId('home-district-count').textContent = format(dataset.districts.length, 0); byId('home-budget').textContent = format(dataset.budget, 0); byId('home-score').textContent = format(baseline.score);
    const fragment = document.createDocumentFragment();
    for (const district of baseline.districts) {
      const source = dataset.districts.find((item) => item.id === district.id);
      const card = document.createElement('article'); card.className = 'home-district';
      const title = document.createElement('strong'); title.textContent = district.name;
      const value = document.createElement('div'); value.className = 'home-district-value'; value.textContent = format(district.afterScore);
      const share = document.createElement('small'); share.textContent = `${format((source?.populationShare ?? 0) * 100, 0)}% населения модели`;
      const meter = document.createElement('meter'); meter.min = 0; meter.max = 100; meter.value = district.afterScore; meter.setAttribute('aria-label', `${district.name}: индекс качества жизни`);
      card.append(title, value, share, meter); fragment.append(card);
    }
    byId('home-districts').replaceChildren(fragment);
    byId('home-ai-status').textContent = health?.aiConfigured ? 'ИИ настроен на сервере · доступность ответа проверяется при запросе.' : health ? 'Сейчас доступен расчёт без ИИ. Все показатели и сценарии работают.' : 'Расчёт доступен. Статус ИИ временно не удалось проверить.';
  } catch {
    if (version !== generation) return;
    byId('home-data-error').hidden = false; byId('home-ai-status').textContent = 'Доступность сервиса временно не подтверждена.';
  } finally { clearTimeout(timeout); if (version === generation) { byId('home-data-loading').hidden = true; byId('home-retry').disabled = false; } }
}
byId('home-retry')?.addEventListener('click', () => void loadOverview());
if (byId('home-districts')) void loadOverview();
