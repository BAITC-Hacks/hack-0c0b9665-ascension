// Camera bookmarks, not administrative boundaries or statistical datasets.
export const PLACES = [
  { id: 'astana', name: 'Астана', kind: 'city', center: [71.4304, 51.147], zoom: 11.55, hasScenarioData: true, aliases: ['астана', 'astana', 'нур султан', 'nur sultan'] },
  { id: 'almaty-city', name: 'Алматы', kind: 'city', center: [76.945, 43.238], zoom: 11.5, aliases: ['алматы', 'almaty'] },
  { id: 'shymkent', name: 'Шымкент', kind: 'city', center: [69.59, 42.32], zoom: 11.5, aliases: ['шымкент', 'shymkent'] },
  { id: 'karaganda', name: 'Караганда', kind: 'city', center: [73.085, 49.805], zoom: 11.4, aliases: ['караганда', 'қарағанды', 'karaganda'] },
  { id: 'aktobe', name: 'Актобе', kind: 'city', center: [57.167, 50.283], zoom: 11.4, aliases: ['актобе', 'ақтөбе', 'aktobe'] },
  { id: 'atyrau', name: 'Атырау', kind: 'city', center: [51.92, 47.106], zoom: 11.5, aliases: ['атырау', 'atyrau'] },
  { id: 'aktau', name: 'Актау', kind: 'city', center: [51.17, 43.65], zoom: 11.5, aliases: ['актау', 'ақтау', 'aktau'] },
  { id: 'pavlodar', name: 'Павлодар', kind: 'city', center: [76.957, 52.287], zoom: 11.5, aliases: ['павлодар', 'pavlodar'] },
  { id: 'oskemen', name: 'Усть-Каменогорск', kind: 'city', center: [82.615, 49.95], zoom: 11.3, aliases: ['усть каменогорск', 'өскемен', 'oskemen'] },
  { id: 'semey', name: 'Семей', kind: 'city', center: [80.25, 50.41], zoom: 11.3, aliases: ['семей', 'semey'] },
  { id: 'turkistan', name: 'Туркестан', kind: 'city', center: [68.27, 43.3], zoom: 11.5, aliases: ['туркестан', 'түркістан', 'turkistan'] },
  { id: 'kyzylorda', name: 'Кызылорда', kind: 'city', center: [65.51, 44.85], zoom: 11.5, aliases: ['кызылорда', 'қызылорда', 'kyzylorda'] },
  { id: 'kostanay', name: 'Костанай', kind: 'city', center: [63.624, 53.215], zoom: 11.5, aliases: ['костанай', 'қостанай', 'kostanay'] },
  { id: 'petropavl', name: 'Петропавловск', kind: 'city', center: [69.155, 54.875], zoom: 11.5, aliases: ['петропавловск', 'петропавл', 'petropavl'] },
  { id: 'taraz', name: 'Тараз', kind: 'city', center: [71.366, 42.9], zoom: 11.5, aliases: ['тараз', 'taraz'] },
  { id: 'oral', name: 'Уральск', kind: 'city', center: [51.37, 51.23], zoom: 11.5, aliases: ['уральск', 'орал', 'oral'] },
  { id: 'kokshetau', name: 'Кокшетау', kind: 'city', center: [69.385, 53.283], zoom: 11.5, aliases: ['кокшетау', 'көкшетау', 'kokshetau'] },
  { id: 'akmola-region', name: 'Акмолинская область', kind: 'region', center: [69.9, 51.9], zoom: 6.6, aliases: ['акмолинская область', 'ақмола облысы'] },
  { id: 'almaty-region', name: 'Алматинская область', kind: 'region', center: [77.3, 44], zoom: 6.8, aliases: ['алматинская область', 'алматы облысы'] },
  { id: 'karaganda-region', name: 'Карагандинская область', kind: 'region', center: [74, 48.9], zoom: 6.2, aliases: ['карагандинская область', 'қарағанды облысы'] },
  { id: 'turkistan-region', name: 'Туркестанская область', kind: 'region', center: [68.5, 43.1], zoom: 6.5, aliases: ['туркестанская область', 'түркістан облысы'] },
  { id: 'kazakhstan', name: 'Весь Казахстан', kind: 'country', center: [67, 48.1], zoom: 4.5, aliases: ['казахстан', 'қазақстан', 'kazakhstan'] },
];

// Approximate display anchors for the five districts in the supplied case.
// They deliberately do not define boundaries or claim to be official centroids.
export const DISTRICT_ANCHORS = {
  esil: [71.442, 51.111],
  almaty: [71.505, 51.155],
  saryarka: [71.396, 51.181],
  baikonur: [71.448, 51.198],
  nura: [71.355, 51.127],
};

export const normalizePlaceName = (value) => String(value).toLocaleLowerCase('ru-RU').replace(/[-–—]/g, ' ').replace(/\s+/g, ' ').trim();
export function findPreset(query) {
  const normalized = normalizePlaceName(query);
  return PLACES.find((place) => place.id === query || normalizePlaceName(place.name) === normalized || place.aliases?.includes(normalized));
}
