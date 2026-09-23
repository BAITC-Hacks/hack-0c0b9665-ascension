const CATEGORY_RULES = [
  ['safety', /пожар|дым|насили|драк|угроз|опасн|қатер|өрт|fire|danger|violence/iu],
  ['lighting', /фонар|освещ|темн(?:о|ая|ый)|жарық|lamp|lighting|streetlight/iu],
  ['waste', /мусор|свалк|отход|контейнер|қоқыс|trash|garbage|waste/iu],
  ['utilities', /вод[аыуе]|водопровод|канализац|отоплен|труб|газ|электр|света|жылу|сусыз|water|heating|sewage/iu],
  ['roads', /дорог|асфальт|ям[аыуе]|тротуар|переход|светофор|жол|шұңқыр|road|pothole|sidewalk/iu],
];
export const CATEGORY_LABELS = Object.freeze({
  roads: 'Дороги и тротуары', utilities: 'Коммунальные услуги', waste: 'Мусор и отходы',
  lighting: 'Уличное освещение', safety: 'Безопасность', other: 'Другое обращение',
});
const HIGH_PRIORITY = /пожар|утечк[аи]\s+газа|запах\s+газа|огол[её]нн|открыт[а-я]*\s+люк|провал|угроз[а-я]*\s+жизни|авари|затоп|өрт|газ\s+иіс|gas\s+leak|fire|exposed\s+wire/iu;
const LOW_PRIORITY = /предлага|предложен|пожелан|благоустрой|покрас|скамейк|озелен|ұсыныс|suggest|bench|beautif/iu;

function normalized(value) {
  return String(value ?? '').toLocaleLowerCase('ru').replace(/ё/gu, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function nearby(a, b) {
  if (!a || !b) return false;
  const radians = value => value * Math.PI / 180;
  const lat = radians(b.lat - a.lat);
  const lon = radians(b.lon - a.lon);
  const chord = Math.sin(lat / 2) ** 2 + Math.cos(radians(a.lat))
    * Math.cos(radians(b.lat)) * Math.sin(lon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(chord), Math.sqrt(Math.max(0, 1 - chord))) <= 120;
}

function samePlace(input, candidate) {
  if (input.districtId && candidate.districtId && input.districtId !== candidate.districtId) return false;
  const address = normalized(input.address);
  return Boolean(address && address === normalized(candidate.address)) || nearby(input.location, candidate.location);
}

function similarText(a, b) {
  const first = normalized(a);
  const second = normalized(b);
  if (first === second && first.length >= 10) return true;
  const words = text => new Set(text.split(' ').filter(word => word.length > 2));
  const left = words(first);
  const right = words(second);
  const common = [...left].filter(word => right.has(word)).length;
  return common >= 3 && common / new Set([...left, ...right]).size >= 0.55;
}

/** Local, explainable rules only. A duplicate is a suggestion, never a merge. */
export function classifyComplaint(input, existingRecords = []) {
  const category = CATEGORY_RULES.find(([, rule]) => rule.test(input.text))?.[0] ?? 'other';
  const priority = HIGH_PRIORITY.test(input.text) ? 'high' : LOW_PRIORITY.test(input.text) ? 'low' : 'normal';
  const priorityReason = {
    high: 'Найдены слова о возможной аварии или непосредственной опасности; требуется проверка оператором.',
    normal: 'Явных признаков аварии или предложения по благоустройству не найдено.',
    low: 'Текст похож на предложение или плановое благоустройство; срочность должен подтвердить оператор.',
  }[priority];
  const duplicate = existingRecords.find(record => !['resolved', 'rejected'].includes(record.status)
    && samePlace(input, record) && similarText(input.text, record.text));
  const text = input.text.replace(/\s+/gu, ' ').trim();
  return {
    mode: 'rules', category, summary: text.length > 240 ? `${text.slice(0, 237)}…` : text,
    priority, reason: `Локальные правила: категория «${CATEGORY_LABELS[category]}». ${priorityReason}${duplicate ? ' Найдено похожее открытое обращение в том же месте; это только предположение о повторе.' : ''}`,
    duplicateOf: duplicate?.id ?? null, reviewed: false,
  };
}
