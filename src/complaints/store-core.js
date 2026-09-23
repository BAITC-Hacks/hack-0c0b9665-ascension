import { randomBytes, timingSafeEqual } from 'node:crypto';
import { CATEGORY_LABELS, classifyComplaint } from './classify.js';

const STATUSES = ['new', 'in_progress', 'resolved', 'rejected'];
const PRIORITIES = ['high', 'normal', 'low'];
const DISTRICTS = ['', 'esil', 'almaty', 'saryarka', 'baikonur', 'nura'];
const CATEGORIES = Object.keys(CATEGORY_LABELS);
const CLOSED = new Set(['resolved', 'rejected']);
const TRANSITIONS = { new: STATUSES, in_progress: ['in_progress', 'resolved', 'rejected'],
  resolved: ['resolved', 'in_progress'], rejected: ['rejected', 'in_progress'] };
const CREATE_FIELDS = ['text', 'address', 'districtId', 'location', 'consent', 'source',
  'telegramChatId', 'telegramUpdateId', 'telegramDraftId', 'attachments'];
const PATCH_FIELDS = ['status', 'assignee', 'resolution', 'priority', 'category', 'summary', 'reason', 'duplicateOf'];

function failure(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}
function invalid(message) { throw failure(400, 'INVALID_COMPLAINT', message); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactFields(value, fields) {
  if (!plain(value)) invalid('Ожидается JSON-объект.');
  if (Object.keys(value).some(key => !fields.includes(key))) invalid('Передано неподдерживаемое поле.');
}
function textField(value, name, max, min = 0) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    invalid(`Поле «${name}» должно содержать от ${min} до ${max} символов.`);
  }
  return value.trim();
}
function enumeration(value, allowed, name) {
  if (!allowed.includes(value)) invalid(`Недопустимое значение поля «${name}».`);
  return value;
}
function updateId(value) {
  if (!Number.isSafeInteger(value) || value < 0) invalid('Некорректный идентификатор Telegram update.');
  return value;
}
function normalizeInput(input) {
  exactFields(input, CREATE_FIELDS);
  if (input.consent !== true) invalid('Для отправки обращения необходимо согласие на обработку данных.');
  const source = enumeration(input.source ?? 'web', ['web', 'telegram'], 'источник');
  const normalized = {
    text: textField(input.text, 'текст', 5000, 10), address: textField(input.address ?? '', 'адрес', 300),
    districtId: enumeration(input.districtId ?? '', DISTRICTS, 'район'), source,
    location: null, attachments: [],
  };
  if (input.location != null) {
    exactFields(input.location, ['lat', 'lon']);
    const { lat, lon } = input.location;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      invalid('Координаты должны быть числами: широта −90…90, долгота −180…180.');
    }
    normalized.location = { lat, lon };
  }
  if (source === 'web' && ['telegramChatId', 'telegramUpdateId', 'telegramDraftId', 'attachments'].some(key => key in input)) {
    invalid('Данные Telegram доступны только Telegram-приёму.');
  }
  if (source === 'telegram') {
    if (!['string', 'number'].includes(typeof input.telegramChatId)
      || (typeof input.telegramChatId === 'number' && !Number.isSafeInteger(input.telegramChatId))
      || !/^-?\d{1,20}$/u.test(String(input.telegramChatId))) invalid('Некорректный идентификатор чата Telegram.');
    normalized.telegramChatId = String(input.telegramChatId);
    normalized.telegramUpdateId = updateId(input.telegramUpdateId);
    if (input.telegramDraftId !== undefined) {
      if (typeof input.telegramDraftId !== 'string'
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(input.telegramDraftId)) invalid('Некорректный идентификатор черновика Telegram.');
      normalized.telegramDraftId = input.telegramDraftId;
    }
    if (input.attachments !== undefined) {
      if (!Array.isArray(input.attachments) || input.attachments.length > 10) invalid('Допустимо не более 10 фотографий.');
      normalized.attachments = input.attachments.map(attachment => {
        exactFields(attachment, ['fileId', 'fileUniqueId', 'type']);
        enumeration(attachment.type, ['photo'], 'тип вложения');
        return { type: 'photo', fileId: textField(attachment.fileId, 'файл Telegram', 500, 1),
          ...(attachment.fileUniqueId === undefined ? {} : { fileUniqueId: textField(attachment.fileUniqueId, 'файл Telegram', 500, 1) }) };
      });
    }
  }
  return normalized;
}

function safeHistory(history) {
  return history.map(({ status, assignee, resolution, at }) => ({ status, assignee, resolution, at }));
}

/** Admin view never exposes delivery credentials, resident tokens, or Telegram file identifiers. */
export function toAdminComplaint(record) {
  if (!record) return null;
  const { id, text, address, districtId, location, source, analysis, status, assignee, resolution,
    createdAt, updatedAt, history } = record;
  return structuredClone({ id, text, address, districtId, location, source, analysis, status, assignee,
    resolution, createdAt, updatedAt, history,
    attachments: record.attachments.map(({ type }, index) => ({ type, index })) });
}

/** A copied summary/reason can contain personal data, so public tracking uses generic labels. */
export function toPublicComplaint(record) {
  if (!record) return null;
  const { id, status, assignee, resolution, createdAt, updatedAt } = record;
  return { id, status, assignee, resolution, createdAt, updatedAt,
    analysis: { mode: 'rules', category: record.analysis.category, priority: record.analysis.priority,
      summary: CATEGORY_LABELS[record.analysis.category], reviewed: record.analysis.reviewed === true },
    history: safeHistory(record.history) };
}

function validPersisted(record) {
  if (!plain(record)) return false;
  try {
    normalizeInput({ text: record.text, address: record.address, districtId: record.districtId,
      location: record.location, source: record.source, consent: true,
      ...(record.source === 'telegram' ? { telegramChatId: record.telegramChatId,
        telegramUpdateId: record.telegramUpdateId, telegramDraftId: record.telegramDraftId, attachments: record.attachments } : {}) });
    textField(record.assignee, 'исполнитель', 120);
    textField(record.resolution, 'решение', 2000);
    textField(record.analysis?.summary, 'краткое описание', 500, 1);
    textField(record.analysis?.reason, 'обоснование', 1000, 1);
  } catch { return false; }
  return /^C-[A-F0-9]{16}$/u.test(record.id) && typeof record.trackingToken === 'string'
    && /^[A-Za-z0-9_-]{43}$/u.test(record.trackingToken) && typeof record.text === 'string'
    && typeof record.address === 'string' && DISTRICTS.includes(record.districtId)
    && ['web', 'telegram'].includes(record.source) && Array.isArray(record.attachments)
    && plain(record.analysis) && record.analysis.mode === 'rules' && CATEGORIES.includes(record.analysis.category)
    && PRIORITIES.includes(record.analysis.priority) && typeof record.analysis.reviewed === 'boolean'
    && (record.analysis.duplicateOf === null || /^C-[A-F0-9]{16}$/u.test(record.analysis.duplicateOf))
    && typeof record.analysis.summary === 'string'
    && typeof record.analysis.reason === 'string' && STATUSES.includes(record.status)
    && typeof record.assignee === 'string' && typeof record.resolution === 'string'
    && typeof record.createdAt === 'string' && Number.isFinite(Date.parse(record.createdAt))
    && typeof record.updatedAt === 'string' && Number.isFinite(Date.parse(record.updatedAt))
    && Array.isArray(record.history) && record.history.length > 0
    && record.history.every(item => plain(item) && STATUSES.includes(item.status)
      && typeof item.assignee === 'string' && typeof item.resolution === 'string' && Number.isFinite(Date.parse(item.at)))
    && record.history.at(-1).status === record.status && record.history.at(-1).assignee === record.assignee
    && record.history.at(-1).resolution === record.resolution
    && (record.source !== 'web' || record.attachments.length === 0)
    && (!CLOSED.has(record.status) || Boolean(record.resolution.trim()))
    && (record.source !== 'telegram' || (typeof record.telegramChatId === 'string'
      && /^-?\d{1,20}$/u.test(record.telegramChatId) && Number.isSafeInteger(record.telegramUpdateId)
      && record.telegramUpdateId >= 0));
}

/** Validate both filesystem and durable records before any operation can mutate them. */
export function validateComplaintRecords(records) {
  if (!Array.isArray(records) || !records.every(validPersisted)) {
    throw failure(500, 'COMPLAINT_STORAGE_CORRUPT', 'Хранилище обращений повреждено. Данные не перезаписаны; требуется восстановление.');
  }
  const ids = new Set();
  const updates = new Set();
  for (const record of records) {
    if (ids.has(record.id) || (record.source === 'telegram' && updates.has(record.telegramUpdateId))) {
      throw failure(500, 'COMPLAINT_STORAGE_CORRUPT', 'Хранилище обращений повреждено. Данные не перезаписаны; требуется восстановление.');
    }
    ids.add(record.id);
    if (record.source === 'telegram') updates.add(record.telegramUpdateId);
  }
  return records;
}

function findRecord(records, id) {
  const record = records.find(item => item.id === id);
  if (!record) throw failure(404, 'COMPLAINT_NOT_FOUND', 'Обращение не найдено.');
  return record;
}

function statsFor(records) {
  return { total: records.length, ...Object.fromEntries(STATUSES.map(status => [status, records.filter(record => record.status === status).length])),
    ...Object.fromEntries(PRIORITIES.map(priority => [priority, records.filter(record => record.analysis.priority === priority).length])) };
}

/** The adapter serializes run callbacks and commits complete validated record sets. */
export function createComplaintStoreCore({ run, save }) {
  return {
    create(input) {
      return run(async records => {
        // A replay returns its durable receipt even if a caller has lost the original draft.
        if (plain(input) && input.source === 'telegram') {
          const incomingId = updateId(input.telegramUpdateId);
          const existing = records.find(record => record.source === 'telegram' && record.telegramUpdateId === incomingId);
          if (existing) return { complaint: structuredClone(existing), trackingToken: existing.trackingToken, duplicateUpdate: true };
        }
        const value = normalizeInput(input);
        if (value.source === 'telegram' && value.telegramDraftId) {
          // A newer /send can arrive before Telegram retries the update that
          // committed this draft. Deduplicate the persisted draft generation
          // inside the same serialized operation as the complaint write.
          const existing = records.find(record => record.source === 'telegram'
            && record.telegramChatId === value.telegramChatId
            && record.telegramDraftId === value.telegramDraftId);
          if (existing) return { complaint: structuredClone(existing), trackingToken: existing.trackingToken, duplicateUpdate: true };
        }
        const now = new Date().toISOString();
        const record = { ...value, id: `C-${randomBytes(8).toString('hex').toUpperCase()}`,
          analysis: classifyComplaint(value, records), status: 'new', assignee: '', resolution: '',
          createdAt: now, updatedAt: now, trackingToken: randomBytes(32).toString('base64url'),
          history: [{ status: 'new', assignee: '', resolution: '', at: now }] };
        await save([...records, record]);
        return { complaint: structuredClone(record), trackingToken: record.trackingToken, duplicateUpdate: false };
      });
    },
    list(filters = {}) {
      return run(records => {
        exactFields(filters, ['status', 'priority', 'districtId', 'category', 'q']);
        for (const [field, allowed] of [['status', STATUSES], ['priority', PRIORITIES], ['districtId', DISTRICTS], ['category', CATEGORIES]]) {
          if (filters[field] !== undefined && filters[field] !== '') enumeration(filters[field], allowed, field);
        }
        const q = textField(filters.q ?? '', 'поиск', 200).toLocaleLowerCase('ru');
        const selected = records.filter(record => (!filters.status || record.status === filters.status)
          && (!filters.priority || record.analysis.priority === filters.priority)
          && (!filters.districtId || record.districtId === filters.districtId)
          && (!filters.category || record.analysis.category === filters.category)
          && (!q || [record.id, record.text, record.address, record.analysis.summary, record.assignee]
            .some(value => value.toLocaleLowerCase('ru').includes(q))));
        return { complaints: selected.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map(toAdminComplaint),
          stats: statsFor(records) };
      });
    },
    get(id) { return run(records => structuredClone(records.find(record => record.id === id) ?? null)); },
    track(id, token) {
      return run(records => {
        const record = records.find(item => item.id === id);
        const candidate = typeof token === 'string' ? Buffer.from(token) : Buffer.alloc(0);
        const expected = Buffer.from(record?.trackingToken ?? '');
        if (!record || candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
          throw failure(404, 'COMPLAINT_NOT_FOUND', 'Обращение не найдено.');
        }
        return toPublicComplaint(record);
      });
    },
    update(id, patch) {
      return run(async records => {
        exactFields(patch, [...PATCH_FIELDS, 'expectedUpdatedAt']);
        if (Object.keys(patch).length === 0) invalid('Укажите изменение обращения.');
        const record = findRecord(records, id);
        if ('expectedUpdatedAt' in patch) {
          if (typeof patch.expectedUpdatedAt !== 'string') invalid('Некорректная версия обращения.');
          if (patch.expectedUpdatedAt !== record.updatedAt) {
            throw failure(409, 'COMPLAINT_CHANGED', 'Обращение уже изменено. Обновите данные и сверьте свои правки перед сохранением.');
          }
        }
        const next = structuredClone(record);
        if ('status' in patch) {
          const status = enumeration(patch.status, STATUSES, 'статус');
          if (!TRANSITIONS[record.status].includes(status)) throw failure(409, 'INVALID_STATUS_TRANSITION', 'Для повторного рассмотрения переведите обращение в работу.');
          next.status = status;
          if (CLOSED.has(record.status) && status === 'in_progress') next.resolution = '';
        }
        if ('assignee' in patch) next.assignee = textField(patch.assignee, 'исполнитель', 120);
        if ('resolution' in patch) next.resolution = textField(patch.resolution, 'решение', 2000);
        if (CLOSED.has(next.status) && !next.resolution) invalid('Для закрытия обращения обязательно публичное решение.');
        if ('priority' in patch) next.analysis.priority = enumeration(patch.priority, PRIORITIES, 'приоритет');
        if ('category' in patch) next.analysis.category = enumeration(patch.category, CATEGORIES, 'категория');
        if ('summary' in patch) next.analysis.summary = textField(patch.summary, 'краткое описание', 500, 1);
        if ('reason' in patch) next.analysis.reason = textField(patch.reason, 'обоснование', 1000, 1);
        if ('duplicateOf' in patch) {
          if (patch.duplicateOf !== null && (typeof patch.duplicateOf !== 'string' || patch.duplicateOf === id
            || !records.some(candidate => candidate.id === patch.duplicateOf))) invalid('Выберите другое существующее обращение или снимите отметку повтора.');
          next.analysis.duplicateOf = patch.duplicateOf;
        }
        if (['priority', 'category', 'summary', 'reason', 'duplicateOf'].some(field => field in patch)) next.analysis.reviewed = true;
        const changes = {};
        for (const key of PATCH_FIELDS) {
          const before = ['status', 'assignee', 'resolution'].includes(key) ? record[key] : record.analysis[key];
          const after = ['status', 'assignee', 'resolution'].includes(key) ? next[key] : next.analysis[key];
          if (before !== after) changes[key] = { before, after };
        }
        if (record.analysis.reviewed !== next.analysis.reviewed) changes.reviewed = { before: record.analysis.reviewed, after: next.analysis.reviewed };
        if (Object.keys(changes).length === 0) return structuredClone(record);
        next.updatedAt = new Date(Math.max(Date.now(), Date.parse(record.updatedAt) + 1)).toISOString();
        next.history.push({ status: next.status, assignee: next.assignee, resolution: next.resolution, at: next.updatedAt, changes });
        await save(records.map(item => item.id === id ? next : item));
        return structuredClone(next);
      });
    },
  };
}
