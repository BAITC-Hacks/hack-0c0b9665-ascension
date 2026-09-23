import { randomBytes, createHash } from 'node:crypto';
import { getDataset } from '../core/simulator.js';

const STAFF = '/api/desk/resident/';
const STATUSES = { new: 'Обращение принято', review: 'На рассмотрении', clarification: 'Нужно уточнение', work: 'Работы выполняются', resolved: 'Работы завершены', rejected: 'Получен ответ по обращению' };
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const digest = value => createHash('sha256').update(value).digest('hex');
function fail(status, message, code = 'VALIDATION_ERROR') { throw Object.assign(new Error(message), { status, code }); }
function fields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(422, 'Ожидается объект.');
  if (Object.keys(body).some(key => !allowed.includes(key))) fail(422, 'Запрос содержит неизвестные поля.', 'UNKNOWN_FIELD');
}
function string(value, maximum, required = true) {
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) fail(422, `Укажите текст длиной до ${maximum} символов.`);
  return value.trim();
}
function version(body, complaint) {
  if (!Number.isSafeInteger(body.version) || body.version < 1) fail(422, 'Укажите версию обращения.');
  if (body.version !== complaint.version) fail(409, 'Обращение изменилось. Обновите страницу и повторите действие.', 'VERSION_CONFLICT');
}
function imageFile(value) {
  fields(value, ['name', 'mime', 'base64']);
  const name = string(value.name, 150);
  if (!IMAGE_TYPES.has(value.mime) || typeof value.base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.base64)) fail(422, 'Разрешены JPEG, PNG и WebP до 2 МБ.');
  const bytes = Buffer.from(value.base64, 'base64');
  const detected = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? 'image/jpeg'
    : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
  if (!bytes.length || bytes.length > 2 * 1024 * 1024 || detected !== value.mime) fail(422, 'Некорректное изображение. Разрешены JPEG, PNG и WebP до 2 МБ.');
  return { name, mime: value.mime, bytes };
}

/** Bearer links grant access to one resident's view only; raw tokens are never persisted. */
export function createResidentApi({ db, getComplaint, saveComplaint, transaction }) {
  const database = () => typeof db === 'function' ? db() : db;
  let ready = false;
  const limits = new Map();
  function initialize() {
    if (ready) return;
    database().exec(`
      CREATE TABLE IF NOT EXISTS resident_links (complaint INTEGER PRIMARY KEY REFERENCES complaints(id), token_hash TEXT UNIQUE NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS resident_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, complaint INTEGER NOT NULL REFERENCES complaints(id), request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(complaint,request_id));
      CREATE TABLE IF NOT EXISTS resident_publications (id INTEGER PRIMARY KEY AUTOINCREMENT, complaint INTEGER UNIQUE NOT NULL REFERENCES complaints(id), data TEXT NOT NULL);
    `);
    ready = true;
  }
  const get = getComplaint || (id => {
    const row = database().prepare('SELECT data FROM complaints WHERE id=?').get(id);
    if (!row) fail(404, 'Обращение не найдено.', 'NOT_FOUND');
    return JSON.parse(row.data);
  });
  const save = saveComplaint || (item => database().prepare('UPDATE complaints SET data=? WHERE id=?').run(JSON.stringify(item), item.id));
  const transact = transaction || (fn => {
    database().exec('BEGIN IMMEDIATE');
    try { const value = fn(); database().exec('COMMIT'); return value; }
    catch (error) { database().exec('ROLLBACK'); throw error; }
  });
  const feedbackFor = id => database().prepare('SELECT data FROM resident_feedback WHERE complaint=? ORDER BY id').all(id).map(row => JSON.parse(row.data));
  const publicationFor = id => {
    const row = database().prepare('SELECT data FROM resident_publications WHERE complaint=?').get(id);
    return row ? JSON.parse(row.data) : null;
  };
  function tasksFor(id) {
    if (!database().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='akim_tasks'").get()) return [];
    return database().prepare('SELECT data FROM akim_tasks ORDER BY id').all().map(row => JSON.parse(row.data)).filter(task => task.complaintIds?.includes(id));
  }
  function rateLimit(key, maximum, period) {
    const now = Date.now();
    for (const [id, entry] of limits) if (entry.until <= now) limits.delete(id);
    let entry = limits.get(key);
    if (!entry) {
      // Bound memory even when callers cycle through invalid tokens or source addresses.
      if (limits.size >= 2048) fail(429, 'Слишком много запросов. Повторите позже.', 'RATE_LIMITED');
      entry = { count: 0, until: now + period }; limits.set(key, entry);
    }
    if (++entry.count > maximum) fail(429, 'Слишком много запросов. Повторите позже.', 'RATE_LIMITED');
  }
  function tokenComplaint(req) {
    const token = req.headers['x-resident-token'];
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) fail(401, 'Персональная ссылка недействительна или истекла.', 'INVALID_LINK');
    const link = database().prepare('SELECT complaint FROM resident_links WHERE token_hash=? AND expires>?').get(digest(token), Date.now());
    if (!link) fail(401, 'Персональная ссылка недействительна или истекла.', 'INVALID_LINK');
    return get(Number(link.complaint));
  }
  function protectMutation(req) {
    if (req.headers['x-resident-request'] !== '1') fail(403, 'Отсутствует защита запроса.', 'FORBIDDEN');
    if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Недопустимый источник запроса.', 'FORBIDDEN');
    if (req.headers.origin) {
      let origin;
      try { origin = new URL(req.headers.origin); } catch { fail(403, 'Недопустимый источник запроса.', 'FORBIDDEN'); }
      if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host || origin.username || origin.password) fail(403, 'Недопустимый источник запроса.', 'FORBIDDEN');
    }
  }
  function resolutionEvent(item) {
    const history = item.history || [];
    for (let index = history.length - 1; index >= 0; index--) {
      if (/^status: [a-z]+ → resolved(?:\n|$)/.test(history[index].text || '')) return { key: `complaint:${index}:${history[index].at}`, at: history[index].at };
    }
    return { key: `complaint:initial:${item.createdAt}`, at: item.updatedAt };
  }
  function resolutionKeys(item, tasks) {
    const keys = [];
    if (item.status === 'resolved') keys.push(resolutionEvent(item).key);
    const latest = tasks.at(-1);
    if (latest && ['reported', 'verified'].includes(latest.status) && latest.reports?.length) {
      keys.push(`task:${latest.id}:${latest.reports.length}:${latest.reports.at(-1).at}`);
    }
    return keys;
  }
  function canRespond(item, tasks, feedback) {
    const consumed = new Set(feedback.flatMap(entry => entry.resolutionKeys || []));
    return resolutionKeys(item, tasks).some(key => !consumed.has(key));
  }
  const safeFeedback = entry => ({ id: entry.id, at: entry.at, outcome: entry.outcome, comment: entry.comment, hasPhoto: Boolean(entry.photo) });
  function residentView(item) {
    const tasks = tasksFor(item.id), feedback = feedbackFor(item.id);
    const timeline = [{ at: item.createdAt, label: STATUSES.new }];
    for (const event of item.history || []) {
      const status = /^status: [a-z]+ → ([a-z]+)(?:\n|$)/.exec(event.text || '')?.[1];
      if (STATUSES[status]) timeline.push({ at: event.at, label: STATUSES[status] });
    }
    for (const entry of feedback) timeline.push({ at: entry.at, label: entry.outcome === 'confirmed' ? 'Житель подтвердил результат' : 'Житель сообщил: проблема осталась' });
    if (timeline.length === 1 && item.status !== 'new') timeline.push({ at: item.updatedAt, label: STATUSES[item.status] || 'Обращение обновлено' });
    timeline.sort((a, b) => a.at.localeCompare(b.at));
    return {
      id: item.id, text: item.text, address: item.address, districtId: item.districtId, status: item.status,
      createdAt: item.createdAt, updatedAt: item.updatedAt, version: item.version, source: item.source,
      replies: (item.replies || []).map(reply => ({ at: reply.at, text: reply.text })), timeline,
      tasks: tasks.map(task => ({ title: 'Работы по обращению', dueDate: task.dueDate, status: task.status })),
      feedback: feedback.map(safeFeedback), canRespond: canRespond(item, tasks, feedback),
    };
  }
  function activePublication(publication, item = get(publication.complaintId)) {
    return publication.active && item.status === 'resolved' && publication.resolutionKey === resolutionEvent(item).key
      && feedbackFor(item.id).at(-1)?.outcome !== 'unresolved';
  }
  function publicResult(publication, item) {
    const feedback = feedbackFor(item.id);
    const photo = id => ({ url: `/api/public/results/${publication.id}/photos/${id}` });
    return { id: publication.id, title: publication.title, summary: publication.summary, districtId: item.districtId,
      completedAt: publication.completedAt, publishedAt: publication.publishedAt,
      durationDays: Math.max(0, Math.ceil((Date.parse(publication.completedAt) - Date.parse(item.createdAt)) / 86400000)),
      before: publication.beforeAttachmentIds.map(photo), after: publication.afterAttachmentIds.map(photo),
      residentConfirmed: feedback.at(-1)?.outcome === 'confirmed' && !canRespond(item, tasksFor(item.id), feedback), source: item.source };
  }
  function checkedPhotos(value, complaintId) {
    if (!Array.isArray(value) || value.length > 5 || new Set(value).size !== value.length || value.some(id => !Number.isSafeInteger(id) || id < 1)) fail(422, 'Выберите до пяти разных фотографий.');
    for (const id of value) {
      const file = database().prepare('SELECT complaint,mime FROM attachments WHERE id=?').get(id);
      if (!file || Number(file.complaint) !== complaintId || !IMAGE_TYPES.has(file.mime)) fail(422, 'Можно публиковать только фотографии этого обращения.');
    }
    return [...value];
  }
  const errorResponse = (res, sendJson, error) => sendJson(res, error.status || 500, { message: error.status ? error.message : 'Не удалось выполнить действие. Повторите запрос.', code: error.status ? error.code || 'REQUEST_ERROR' : 'INTERNAL_ERROR' });

  async function handleStaff(req, res, pathname, session, readJson, sendJson) {
    if (!pathname.startsWith(STAFF)) return false;
    try {
      if (!session?.login) fail(401, 'Войдите в кабинет команды.', 'UNAUTHORIZED');
      initialize();
      const match = /^\/api\/desk\/resident\/complaints\/(\d+)(?:\/(link|publication))?$/.exec(pathname);
      if (!match) fail(404, 'Действие не найдено.', 'NOT_FOUND');
      const id = Number(match[1]), action = match[2];
      if (!Number.isSafeInteger(id) || id < 1) fail(404, 'Обращение не найдено.', 'NOT_FOUND');
      if (!action && req.method === 'GET') {
        const item = get(id), link = database().prepare('SELECT expires FROM resident_links WHERE complaint=?').get(id);
        const publication = publicationFor(id);
        sendJson(res, 200, { version: item.version, hasLink: Boolean(link && link.expires > Date.now()), expiresAt: link ? new Date(link.expires).toISOString() : null,
          feedback: feedbackFor(id).map(entry => ({ ...safeFeedback(entry), photo: entry.photo || null })),
          publication: publication ? { ...publication, effectiveVisible: activePublication(publication, item) } : null });
        return true;
      }
      if (action === 'link' && req.method === 'POST') {
        if (!['admin', 'akim', 'operator'].includes(session.role)) fail(403, 'Недостаточно прав для создания ссылки.', 'FORBIDDEN');
        const body = await readJson(req); fields(body, ['version']);
        const result = transact(() => {
          const item = get(id); version(body, item);
          const token = randomBytes(32).toString('hex'), expires = Date.now() + 90 * 86400000;
          database().prepare('INSERT INTO resident_links(complaint,token_hash,expires) VALUES(?,?,?) ON CONFLICT(complaint) DO UPDATE SET token_hash=excluded.token_hash,expires=excluded.expires').run(id, digest(token), expires);
          return { token, expiresAt: new Date(expires).toISOString(), version: item.version };
        });
        sendJson(res, 201, result); return true;
      }
      if (action === 'publication' && ['POST', 'DELETE'].includes(req.method)) {
        if (!['admin', 'akim'].includes(session.role)) fail(403, 'Публиковать результаты может аким или администратор.', 'FORBIDDEN');
        const body = await readJson(req);
        fields(body, req.method === 'DELETE' ? ['version'] : ['version', 'title', 'summary', 'beforeAttachmentIds', 'afterAttachmentIds']);
        const result = transact(() => {
          const item = get(id); version(body, item);
          const existing = publicationFor(id);
          if (req.method === 'DELETE') {
            if (existing) { existing.active = false; existing.hiddenAt = new Date().toISOString(); database().prepare('UPDATE resident_publications SET data=? WHERE id=?').run(JSON.stringify(existing), existing.id); }
            return { ok: true };
          }
          if (item.status !== 'resolved' || feedbackFor(id).at(-1)?.outcome === 'unresolved') fail(422, 'Публикация доступна после решения обращения и устранения замечаний жителя.', 'INVALID_TRANSITION');
          const title = string(body.title, 160), summary = string(body.summary, 2000);
          const beforeAttachmentIds = checkedPhotos(body.beforeAttachmentIds ?? [], id), afterAttachmentIds = checkedPhotos(body.afterAttachmentIds ?? [], id);
          if (beforeAttachmentIds.length + afterAttachmentIds.length > 5 || beforeAttachmentIds.some(photo => afterAttachmentIds.includes(photo))) fail(422, 'Выберите до пяти разных фотографий до и после.');
          const publicationId = existing?.id ?? Number(database().prepare('INSERT INTO resident_publications(complaint,data) VALUES(?,?)').run(id, '{}').lastInsertRowid);
          const publication = { id: publicationId, complaintId: id, title, summary, beforeAttachmentIds, afterAttachmentIds, active: true,
            publishedAt: new Date().toISOString(), completedAt: resolutionEvent(item).at, resolutionKey: resolutionEvent(item).key, source: item.source };
          database().prepare('UPDATE resident_publications SET data=? WHERE id=?').run(JSON.stringify(publication), publicationId);
          return publication;
        });
        sendJson(res, 200, result); return true;
      }
      fail(404, 'Действие не найдено.', 'NOT_FOUND');
    } catch (error) { errorResponse(res, sendJson, error); }
    return true;
  }

  async function handlePublic(req, res, pathname, readJson, sendJson) {
    if (!pathname.startsWith('/api/resident/') && pathname !== '/api/public/results' && !pathname.startsWith('/api/public/results/')) return false;
    try {
      initialize();
      rateLimit(`ip:${req.socket.remoteAddress}`, 180, 60000);
      if (pathname === '/api/resident/complaint' && req.method === 'GET') {
        sendJson(res, 200, residentView(tokenComplaint(req))); return true;
      }
      if (pathname === '/api/resident/feedback' && req.method === 'POST') {
        protectMutation(req);
        const initial = tokenComplaint(req);
        rateLimit(`feedback:${initial.id}`, 30, 15 * 60000);
        const body = await readJson(req, 3 * 1024 * 1024);
        fields(body, ['version', 'outcome', 'comment', 'requestId', 'photo']);
        if (!['confirmed', 'unresolved'].includes(body.outcome)) fail(422, 'Выберите результат проверки.');
        const comment = string(body.comment ?? '', 2000, body.outcome === 'unresolved'), requestId = string(body.requestId, 100);
        const photo = body.photo === undefined || body.photo === null ? null : imageFile(body.photo);
        const signature = digest(JSON.stringify({ version: body.version, outcome: body.outcome, comment, photo: photo ? { name: photo.name, mime: photo.mime, sha256: digest(photo.bytes) } : null }));
        const result = transact(() => {
          // Revalidate the bearer and re-read the record after the entire body arrives.
          const item = tokenComplaint(req);
          const previous = database().prepare('SELECT fingerprint,data FROM resident_feedback WHERE complaint=? AND request_id=?').get(item.id, requestId);
          if (previous) {
            if (previous.fingerprint !== signature) fail(409, 'Этот ключ запроса уже использован с другими данными.', 'IDEMPOTENCY_CONFLICT');
            return { duplicate: true, feedback: safeFeedback(JSON.parse(previous.data)), complaint: residentView(item) };
          }
          version(body, item);
          const tasks = tasksFor(item.id), feedback = feedbackFor(item.id);
          if (!canRespond(item, tasks, feedback)) fail(409, 'Ответ уже получен или работы ещё не завершены. Новая проверка появится после следующего результата работ.', 'RESPONSE_NOT_AVAILABLE');
          const at = new Date().toISOString();
          let attachment = null;
          if (photo) {
            if ((item.attachments || []).length >= 5) fail(422, 'К обращению уже приложено пять фотографий. Отправьте комментарий без фото.');
            const inserted = database().prepare('INSERT INTO attachments(complaint,name,mime,bytes) VALUES(?,?,?,?)').run(item.id, photo.name, photo.mime, photo.bytes);
            attachment = { id: Number(inserted.lastInsertRowid), name: photo.name };
            (item.attachments ??= []).push(attachment);
          }
          const inserted = database().prepare('INSERT INTO resident_feedback(complaint,request_id,fingerprint,data) VALUES(?,?,?,?)').run(item.id, requestId, signature, '{}');
          const entry = { id: Number(inserted.lastInsertRowid), at, outcome: body.outcome, comment, photo: attachment, resolutionKeys: resolutionKeys(item, tasks) };
          database().prepare('UPDATE resident_feedback SET data=? WHERE id=?').run(JSON.stringify(entry), entry.id);
          item.residentFeedback = { ...safeFeedback(entry), photo: attachment };
          if (body.outcome === 'unresolved') {
            const previousStatus = item.status; item.status = 'review';
            (item.history ??= []).push({ at, actor: 'resident', text: `status: ${previousStatus} → review\nЖитель сообщил, что проблема осталась${comment ? `: ${comment}` : ''}` });
          } else (item.history ??= []).push({ at, actor: 'resident', text: `Житель подтвердил результат${comment ? `: ${comment}` : ''}` });
          item.version++; item.updatedAt = at; save(item);
          return { duplicate: false, feedback: safeFeedback(entry), complaint: residentView(item) };
        });
        sendJson(res, result.duplicate ? 200 : 201, { feedback: result.feedback, complaint: result.complaint }); return true;
      }
      if (pathname === '/api/public/results' && req.method === 'GET') {
        const districtId = new URL(req.url, 'http://localhost').searchParams.get('districtId') || '';
        const districts = getDataset().districts.map(({ id, name }) => ({ id, name }));
        if (districtId && !districts.some(district => district.id === districtId)) fail(422, 'Неизвестный район.');
        const items = database().prepare('SELECT data FROM resident_publications ORDER BY id DESC').all().map(row => JSON.parse(row.data)).flatMap(publication => {
          const item = get(publication.complaintId);
          return activePublication(publication, item) && (!districtId || item.districtId === districtId) ? [publicResult(publication, item)] : [];
        });
        sendJson(res, 200, { items, districts }); return true;
      }
      const photoMatch = /^\/api\/public\/results\/(\d+)\/photos\/(\d+)$/.exec(pathname);
      if (photoMatch && req.method === 'GET') {
        const row = database().prepare('SELECT data FROM resident_publications WHERE id=?').get(Number(photoMatch[1]));
        const publication = row && JSON.parse(row.data), attachmentId = Number(photoMatch[2]);
        if (!publication || !activePublication(publication) || ![...publication.beforeAttachmentIds, ...publication.afterAttachmentIds].includes(attachmentId)) fail(404, 'Фото не найдено.', 'NOT_FOUND');
        const file = database().prepare('SELECT mime,bytes FROM attachments WHERE id=? AND complaint=?').get(attachmentId, publication.complaintId);
        if (!file || !IMAGE_TYPES.has(file.mime)) fail(404, 'Фото не найдено.', 'NOT_FOUND');
        res.writeHead(200, { 'Content-Type': file.mime, 'Content-Length': file.bytes.length, 'Cache-Control': 'no-store', 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'", 'X-Content-Type-Options': 'nosniff' });
        res.end(Buffer.from(file.bytes)); return true;
      }
      fail(404, 'Действие не найдено.', 'NOT_FOUND');
    } catch (error) { errorResponse(res, sendJson, error); }
    return true;
  }
  return { handlePublic, handleStaff };
}
