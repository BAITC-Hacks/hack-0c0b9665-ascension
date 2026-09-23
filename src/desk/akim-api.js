import { createHash } from 'node:crypto';
import { getDataset } from '../core/simulator.js';

const PREFIX = '/api/desk/akim/';
const DEFAULT_PREFERENCES = { filter: 'all', districtId: '', category: '', query: '', lang: 'ru' };
const FILTERS = new Set(['all', 'open', 'mine', 'overdue', 'review', 'watching', 'approval', 'new', 'urgent']);
const CATEGORIES = new Set(['transport', 'ecology', 'social', 'safety', 'services', 'other']);
const almatyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty', year: 'numeric', month: '2-digit', day: '2-digit' });

function fail(status, message, code = 'VALIDATION_ERROR') { throw Object.assign(new Error(message), { status, code }); }
function day(value = new Date()) { return almatyDate.format(new Date(value)); }
function date(value, minimum) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    fail(422, 'Укажите существующую дату в формате ГГГГ-ММ-ДД.');
  }
  if (minimum && value < minimum) fail(422, 'Срок не может быть раньше сегодняшнего дня в Астане.');
  return value;
}
function string(value, maximum, required = true) {
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) fail(422, `Укажите текст${required ? ' (обязательное поле)' : ''}, не более ${maximum} символов.`);
  return value.trim();
}
function fields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(422, 'Ожидается объект.');
  if (Object.keys(body).some(key => !allowed.includes(key))) fail(422, 'Запрос содержит неизвестные поля.', 'UNKNOWN_FIELD');
}
function identifiers(value, minimum = 0, maximum = 100) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum
    || value.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(value).size !== value.length) {
    fail(422, `Выберите от ${minimum} до ${maximum} различных записей с корректными идентификаторами.`);
  }
  return [...value].sort((a, b) => a - b);
}
function manager(session) {
  if (!['admin', 'akim'].includes(session.role)) fail(403, 'Действие доступно акиму или администратору.', 'FORBIDDEN');
}
function version(body, item) {
  if (!Number.isSafeInteger(body.version) || body.version < 1) fail(422, 'Укажите версию записи.');
  if (body.version !== item.version) fail(409, 'Запись изменена другим участником. Обновите данные и повторите действие.', 'VERSION_CONFLICT');
}
function fingerprint(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function publicItem(item) { const { _requestFingerprint, ...result } = item; return result; }

/** Additional cabinet storage deliberately does not mutate complaints or their workflow. */
export function createAkimApi({ db, getComplaint, transaction }) {
  const database = () => typeof db === 'function' ? db() : db;
  let ready = false;
  function initialize() {
    if (ready) return;
    database().exec(`
      CREATE TABLE IF NOT EXISTS akim_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS akim_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS akim_preferences (login TEXT PRIMARY KEY REFERENCES users(login), data TEXT NOT NULL);
    `);
    ready = true;
  }
  // Only static table names supplied by this module are interpolated into SQL.
  const all = table => database().prepare(`SELECT data FROM ${table} ORDER BY id DESC`).all().map(row => JSON.parse(row.data));
  const save = (table, item) => database().prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(item), item.id);
  function lookup(table, id) {
    if (!Number.isSafeInteger(id) || id < 1) fail(404, 'Запись не найдена.', 'NOT_FOUND');
    const row = database().prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
    if (!row) fail(404, 'Запись не найдена.', 'NOT_FOUND');
    return JSON.parse(row.data);
  }
  function linkedComplaints(ids) {
    return ids.map(id => {
      const exists = database().prepare('SELECT id FROM complaints WHERE id=?').get(id);
      if (!exists) fail(422, `Обращение №${id} не найдено.`);
      return getComplaint ? getComplaint(id) : lookup('complaints', id);
    });
  }
  function assignee(value) {
    const login = string(value, 80);
    if (!database().prepare('SELECT login FROM users WHERE login=?').get(login)) fail(422, 'Ответственный не найден.');
    return login;
  }
  const preferences = login => ({ ...DEFAULT_PREFERENCES, ...JSON.parse(database().prepare('SELECT data FROM akim_preferences WHERE login=?').get(login)?.data || '{}') });
  const activeGroups = () => all('akim_groups').filter(group => !group.ungroupedAt);
  function insert(table, item) {
    item.id = Number(database().prepare(`INSERT INTO ${table}(data) VALUES(?)`).run('{}').lastInsertRowid);
    save(table, item);
    return publicItem(item);
  }
  function replay(table, login, requestId, signature) {
    const previous = all(table).find(item => item.createdBy === login && item.requestId === requestId);
    if (!previous) return null;
    if (previous._requestFingerprint !== signature) fail(409, 'Этот ключ запроса уже использован с другими данными.', 'IDEMPOTENCY_CONFLICT');
    return publicItem(previous);
  }
  function attachmentIds(value, complaintIds) {
    const ids = identifiers(value ?? [], 0, 20);
    for (const id of ids) {
      const attachment = database().prepare('SELECT complaint FROM attachments WHERE id=?').get(id);
      if (!attachment || !complaintIds.includes(Number(attachment.complaint))) fail(422, 'Фото должно принадлежать одному из обращений этого поручения.');
    }
    return ids;
  }
  const runTransaction = transaction || (fn => {
    database().exec('BEGIN IMMEDIATE');
    try { const result = fn(); database().exec('COMMIT'); return result; }
    catch (error) { database().exec('ROLLBACK'); throw error; }
  });

  async function handle(req, res, pathname, session, readJson, sendJson) {
    if (!pathname.startsWith(PREFIX)) return false;
    const reply = (status, data) => sendJson(res, status, data);
    try {
      if (!session?.login) fail(401, 'Войдите в кабинет команды.', 'UNAUTHORIZED');
      initialize();
      const today = day();
      if (pathname === `${PREFIX}state` && req.method === 'GET') {
        const complaints = all('complaints'), tasks = all('akim_tasks').map(publicItem);
        reply(200, {
          now: new Date().toISOString(), today, complaints,
          users: database().prepare('SELECT login,role FROM users ORDER BY login').all(),
          tasks, groups: activeGroups().map(publicItem), preferences: preferences(session.login),
          scenarios: all('scenarios'), districts: getDataset().districts, bot: 'not_connected',
          summary: {
            newToday: complaints.filter(item => day(item.createdAt) === today).length,
            urgent: complaints.filter(item => item.priority === 'high' && !['resolved', 'rejected'].includes(item.status)).length,
            overdue: tasks.filter(item => item.status !== 'verified' && item.dueDate < today).length,
            pendingReview: tasks.filter(item => item.status === 'reported').length,
            watching: tasks.filter(item => item.status !== 'verified' && item.watchers.includes(session.login)).length,
          },
        });
        return true;
      }
      if (pathname === `${PREFIX}tasks` && req.method === 'POST') {
        manager(session);
        const body = await readJson(req);
        fields(body, ['title', 'complaintIds', 'assignee', 'dueDate', 'expectedResult', 'requestId']);
        const requestId = string(body.requestId, 100);
        const values = { title: string(body.title, 200), complaintIds: identifiers(body.complaintIds, 1),
          assignee: string(body.assignee, 80), dueDate: date(body.dueDate), expectedResult: string(body.expectedResult, 2000) };
        const result = runTransaction(() => {
          // Replay is checked before today's deadline validation: retries remain valid after midnight.
          const duplicate = replay('akim_tasks', session.login, requestId, fingerprint(values));
          if (duplicate) return { item: duplicate, duplicate: true };
          linkedComplaints(values.complaintIds); assignee(values.assignee); date(values.dueDate, day());
          const now = new Date().toISOString();
          return { duplicate: false, item: insert('akim_tasks', {
            ...values, requestId, _requestFingerprint: fingerprint(values), version: 1, status: 'assigned',
            createdBy: session.login, createdAt: now, updatedAt: now, watchers: [], reportRequests: [], reports: [], verification: null,
            history: [{ at: now, actor: session.login, action: 'create', text: 'Поручение создано' }],
          }) };
        });
        reply(result.duplicate ? 200 : 201, result.item);
        return true;
      }
      const taskMatch = /^\/api\/desk\/akim\/tasks\/(\d+)$/.exec(pathname);
      if (taskMatch && req.method === 'PATCH') {
        const body = await readJson(req);
        const actionFields = { watch: ['watch'], request_report: ['note'], report: ['text', 'beforeAttachmentIds', 'afterAttachmentIds'],
          verify: ['note'], return: ['note', 'dueDate'], edit: ['title', 'assignee', 'dueDate', 'expectedResult'] };
        fields(body, ['version', 'action', ...(Object.hasOwn(actionFields, body?.action) ? actionFields[body.action] : [])]);
        if (!Object.hasOwn(actionFields, body.action)) fail(422, 'Неизвестное действие.');
        const result = runTransaction(() => {
          // Read and check the version only after the complete body has arrived, inside the write transaction.
          const task = lookup('akim_tasks', Number(taskMatch[1]));
          version(body, task);
          const now = new Date().toISOString();
          let note = '';
          if (body.action === 'watch') {
            if (typeof body.watch !== 'boolean') fail(422, 'Укажите состояние личного контроля.');
            const watched = task.watchers.includes(session.login);
            if (watched === body.watch) return publicItem(task);
            task.watchers = body.watch ? [...task.watchers, session.login] : task.watchers.filter(login => login !== session.login);
            note = body.watch ? 'Взято на личный контроль' : 'Снято с личного контроля';
          } else if (body.action === 'report') {
            if (!['admin', 'akim'].includes(session.role) && !(session.role === 'operator' && task.assignee === session.login)) fail(403, 'Отчёт может отправить назначенный исполнитель или администратор.', 'FORBIDDEN');
            if (task.status !== 'assigned') fail(422, 'Отчитаться можно только по поручению в работе.', 'INVALID_TRANSITION');
            note = string(body.text, 5000);
            const beforeAttachmentIds = attachmentIds(body.beforeAttachmentIds, task.complaintIds);
            const afterAttachmentIds = attachmentIds(body.afterAttachmentIds, task.complaintIds);
            if (beforeAttachmentIds.some(id => afterAttachmentIds.includes(id))) fail(422, 'Одно фото нельзя одновременно указать как «до» и «после».');
            task.reports.push({ at: now, actor: session.login, text: note, beforeAttachmentIds, afterAttachmentIds });
            task.status = 'reported';
          } else {
            manager(session);
            if (body.action === 'request_report') {
              if (task.status === 'verified') fail(422, 'Поручение уже проверено. Сначала верните его на доработку.', 'INVALID_TRANSITION');
              note = string(body.note, 2000);
              task.reportRequests.push({ at: now, actor: session.login, note });
            } else if (body.action === 'verify') {
              if (task.status !== 'reported') fail(422, 'Проверка доступна после отчёта исполнителя.', 'INVALID_TRANSITION');
              note = string(body.note, 2000);
              task.verification = { at: now, actor: session.login, note };
              task.status = 'verified';
            } else if (body.action === 'return') {
              if (!['reported', 'verified'].includes(task.status)) fail(422, 'Вернуть можно отчитанное или проверенное поручение.', 'INVALID_TRANSITION');
              note = string(body.note, 2000);
              if (Object.hasOwn(body, 'dueDate')) task.dueDate = date(body.dueDate, day());
              task.status = 'assigned'; task.verification = null;
            } else if (body.action === 'edit') {
              if (task.status !== 'assigned') fail(422, 'Изменить можно поручение в работе. Сначала верните его на доработку.', 'INVALID_TRANSITION');
              if (!actionFields.edit.some(key => Object.hasOwn(body, key))) fail(422, 'Укажите хотя бы одно изменение.');
              const values = {
                title: Object.hasOwn(body, 'title') ? string(body.title, 200) : task.title,
                assignee: Object.hasOwn(body, 'assignee') ? assignee(body.assignee) : task.assignee,
                dueDate: date(Object.hasOwn(body, 'dueDate') ? body.dueDate : task.dueDate, day()),
                expectedResult: Object.hasOwn(body, 'expectedResult') ? string(body.expectedResult, 2000) : task.expectedResult,
              };
              const names = { title: 'Заголовок', assignee: 'Ответственный', dueDate: 'Срок', expectedResult: 'Ожидаемый результат' };
              const changes = Object.keys(values).filter(key => task[key] !== values[key]);
              if (!changes.length) return publicItem(task);
              note = changes.map(key => `${names[key]}: ${task[key]} → ${values[key]}`).join('\n');
              Object.assign(task, values);
            }
          }
          task.version++; task.updatedAt = now;
          task.history.push({ at: now, actor: session.login, action: body.action, text: note });
          save('akim_tasks', task);
          return publicItem(task);
        });
        reply(200, result); return true;
      }
      if (pathname === `${PREFIX}groups` && req.method === 'POST') {
        manager(session);
        const body = await readJson(req);
        fields(body, ['title', 'complaintIds', 'requestId']);
        const requestId = string(body.requestId, 100);
        const values = { title: string(body.title, 200), complaintIds: identifiers(body.complaintIds, 2) };
        const result = runTransaction(() => {
          const duplicate = replay('akim_groups', session.login, requestId, fingerprint(values));
          if (duplicate) return { item: duplicate, duplicate: true };
          const complaints = linkedComplaints(values.complaintIds);
          if (complaints.some(item => item.districtId !== complaints[0].districtId || item.category !== complaints[0].category)) fail(422, 'Объединять можно обращения одного района и категории.');
          if (activeGroups().some(group => group.complaintIds.some(id => values.complaintIds.includes(id)))) fail(409, 'Одно из обращений уже входит в подтверждённую группу.', 'GROUP_CONFLICT');
          const now = new Date().toISOString();
          return { duplicate: false, item: insert('akim_groups', { ...values, requestId, _requestFingerprint: fingerprint(values),
            version: 1, createdAt: now, updatedAt: now, createdBy: session.login, history: [{ at: now, actor: session.login, action: 'create', text: 'Группа подтверждена вручную' }] }) };
        });
        reply(result.duplicate ? 200 : 201, result.item); return true;
      }
      const groupMatch = /^\/api\/desk\/akim\/groups\/(\d+)$/.exec(pathname);
      if (groupMatch && req.method === 'PATCH') {
        manager(session);
        const body = await readJson(req);
        fields(body, ['version', 'action']);
        if (body.action !== 'ungroup') fail(422, 'Неизвестное действие.');
        const result = runTransaction(() => {
          const group = lookup('akim_groups', Number(groupMatch[1]));
          version(body, group);
          if (group.ungroupedAt) fail(409, 'Группа уже разъединена.', 'GROUP_CONFLICT');
          group.ungroupedAt = new Date().toISOString(); group.updatedAt = group.ungroupedAt; group.version++;
          group.history.push({ at: group.ungroupedAt, actor: session.login, action: 'ungroup', text: 'Группа разъединена; оригиналы сохранены' });
          save('akim_groups', group);
          return { ok: true, id: group.id };
        });
        reply(200, result); return true;
      }
      if (pathname === `${PREFIX}preferences` && req.method === 'PATCH') {
        const body = await readJson(req);
        fields(body, Object.keys(DEFAULT_PREFERENCES));
        const updates = {};
        if (Object.hasOwn(body, 'filter')) { if (!FILTERS.has(body.filter)) fail(422, 'Неизвестный фильтр.'); updates.filter = body.filter; }
        if (Object.hasOwn(body, 'lang')) { if (!['ru', 'kk'].includes(body.lang)) fail(422, 'Выберите русский или казахский язык.'); updates.lang = body.lang; }
        if (Object.hasOwn(body, 'districtId')) { if (!['', 'none'].includes(body.districtId) && !getDataset().districts.some(item => item.id === body.districtId)) fail(422, 'Неизвестный район.'); updates.districtId = body.districtId; }
        if (Object.hasOwn(body, 'category')) { if (body.category !== '' && !CATEGORIES.has(body.category)) fail(422, 'Неизвестная категория.'); updates.category = body.category; }
        if (Object.hasOwn(body, 'query')) updates.query = string(body.query, 300, false);
        const result = runTransaction(() => {
          const saved = { ...preferences(session.login), ...updates };
          database().prepare('INSERT INTO akim_preferences(login,data) VALUES(?,?) ON CONFLICT(login) DO UPDATE SET data=excluded.data').run(session.login, JSON.stringify(saved));
          return saved;
        });
        reply(200, result); return true;
      }
      if (pathname === `${PREFIX}report` && req.method === 'GET') {
        const params = new URL(req.url, 'http://localhost').searchParams;
        const from = date(params.get('from')), to = date(params.get('to'));
        if (from > to || (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 >= 366) fail(422, 'Выберите период от 1 до 366 дней.');
        const inPeriod = at => day(at) >= from && day(at) <= to;
        const complaints = all('complaints'), tasks = all('akim_tasks').map(publicItem);
        const received = complaints.filter(item => inPeriod(item.createdAt));
        // Retain historical verification events even when the task has since been returned.
        const verified = tasks.flatMap(task => {
          const events = task.history.filter(event => event.action === 'verify' && inPeriod(event.at));
          return events.length ? [{ ...task, verificationEvents: events }] : [];
        });
        const overdue = tasks.filter(task => task.status !== 'verified' && task.dueDate < today);
        const pendingReview = tasks.filter(task => task.status === 'reported');
        const recurring = activeGroups().map(publicItem);
        reply(200, { from, to, generatedAt: new Date().toISOString(), today,
          received, verified, overdue, pendingReview, recurring, tasks, complaints,
          counters: { received: received.length, verified: verified.length, overdue: overdue.length, pendingReview: pendingReview.length, recurring: recurring.length },
          scope: { timezone: 'Asia/Almaty', received: 'createdAt within inclusive period', verified: 'verification events within inclusive period; current status may differ',
            overdue: 'current unverified tasks due before today', pendingReview: 'current reported tasks', recurring: 'current confirmed groups', data: 'current complaint and task snapshots' },
        });
        return true;
      }
      fail(404, 'Действие не найдено.', 'NOT_FOUND');
    } catch (error) {
      reply(error.status || 500, { message: error.status ? error.message : 'Не удалось выполнить действие. Повторите запрос.', code: error.status ? error.code || 'REQUEST_ERROR' : 'INTERNAL_ERROR' });
    }
    return true;
  }
  return { handle };
}
