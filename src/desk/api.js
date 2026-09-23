import { createAkimApi } from './akim-api.js';
import { createResidentApi } from './resident-api.js';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { openStore, hash, verifyPassword } from './store.js';
import { getDataset, simulate } from '../core/simulator.js';
const statuses = { new: 'Новое', review: 'На рассмотрении', clarification: 'Нужно уточнение', work: 'В работе', resolved: 'Решено', rejected: 'Отклонено' };
const transitions = { new: ['review', 'rejected'], review: ['clarification', 'work', 'rejected'], clarification: ['review'], work: ['clarification', 'resolved', 'review'], resolved: ['review'], rejected: ['review'] };
const categories = { transport: 'Транспорт', ecology: 'Экология', social: 'Социальная сфера', safety: 'Безопасность', services: 'Городской сервис', other: 'Другое' };
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function text(value, max, required = false) { if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(422, `Введите текст${required ? ' (обязательное поле)' : ''}, не более ${max} символов.`); return value.trim(); }
export function createDesk({ path = process.env.DESK_DB_PATH || resolve('var/desk.sqlite'), secure = process.env.COOKIE_SECURE === 'true' } = {}) {
  let database;
  const db = () => database ??= openStore(path);
  const attempts = new Map();
  const get = id => { const row = db().prepare('SELECT data FROM complaints WHERE id=?').get(id); if (!row) fail(404, 'Обращение не найдено.'); return JSON.parse(row.data); };
  const save = item => db().prepare('UPDATE complaints SET data=? WHERE id=?').run(JSON.stringify(item), item.id);
  const transaction = fn => { db().exec('BEGIN IMMEDIATE'); try { const result = fn(); db().exec('COMMIT'); return result; } catch (error) { db().exec('ROLLBACK'); throw error; } };
  const akim = createAkimApi({ db, getComplaint: get, saveComplaint: save, transaction });
  const resident = createResidentApi({ db, getComplaint: get, saveComplaint: save, transaction });
  function validateFields(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(422, 'Ожидается объект.');
    if (!Object.hasOwn(categories, body.category)) fail(422, 'Выберите категорию.');
    if (body.districtId && !getDataset().districts.some(d => d.id === body.districtId)) fail(422, 'Неизвестный район.');
  }
  function create(body, actor) {
    validateFields(body);
    const value = { text: text(body.text, 5000, true), address: text(body.address ?? '', 300), districtId: body.districtId || null, category: body.category };
    const submission = text(body.submissionId, 100, true), fingerprint = hash(JSON.stringify(value));
    const old = db().prepare('SELECT fingerprint, data FROM complaints WHERE submission=?').get(submission);
    if (old) { if (old.fingerprint !== fingerprint) fail(409, 'Этот ключ уже использован для другого обращения.'); return { item: JSON.parse(old.data), duplicate: true }; }
    return transaction(() => {
      const result = db().prepare('INSERT INTO complaints(submission,fingerprint,data) VALUES(?,?,?)').run(submission, fingerprint, '{}');
      const now = new Date().toISOString();
      const item = { ...value, id: Number(result.lastInsertRowid), source: 'demo', status: 'new', assignee: '', priority: 'normal', version: 1, createdAt: now, updatedAt: now, history: [{ at: now, actor, text: 'Создано демонстрационное обращение' }], replies: [], attachments: [] };
      save(item); return { item, duplicate: false };
    });
  }
  async function handle(req, res, pathname, readJson, sendJson) {
    if (await resident.handlePublic(req, res, pathname, readJson, sendJson)) return true;
    if (!pathname.startsWith('/api/desk/')) return false;
    const reply = (status, data) => sendJson(res, status, data);
    try {
      if (['POST', 'PATCH', 'DELETE'].includes(req.method)) {
        if (req.headers['x-desk-request'] !== '1') fail(403, 'Отсутствует защита запроса.');
        if (req.headers.origin) { let origin; try { origin = new URL(req.headers.origin); } catch { fail(403, 'Недопустимый источник.'); } if (origin.host !== req.headers.host || !['http:', 'https:'].includes(origin.protocol)) fail(403, 'Недопустимый источник.'); }
      }
      const token = /(?:^|;\s*)desk_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      const session = token && db().prepare('SELECT users.login,users.role FROM sessions JOIN users USING(login) WHERE token=? AND expires>?').get(hash(token), Date.now());
      if (pathname === '/api/desk/session' && req.method === 'GET') { reply(200, { user: session || null, configured: Boolean(db().prepare('SELECT login FROM users LIMIT 1').get()), statuses, transitions, categories }); return true; }
      if (pathname === '/api/desk/login' && req.method === 'POST') {
        const key = req.socket.remoteAddress; const now = Date.now();
        for (const [ip, entry] of attempts) if (entry.until < now) attempts.delete(ip);
        const entry = attempts.get(key) || { count: 0, until: now + 900000 };
        if (entry.count >= 8) fail(429, 'Слишком много попыток. Повторите через 15 минут.');
        const body = await readJson(req); const login = text(body?.login, 80, true), password = text(body?.password, 200, true);
        const user = db().prepare('SELECT * FROM users WHERE login=?').get(login);
        entry.count++; attempts.set(key, entry);
        if (!verifyPassword(password, user?.password || '00000000000000000000000000000000:' + '00'.repeat(64))) fail(401, 'Неверный логин или пароль.');
        attempts.delete(key); db().prepare('DELETE FROM sessions WHERE expires<=?').run(now);
        if (token) db().prepare('DELETE FROM sessions WHERE token=?').run(hash(token));
        const newToken = randomBytes(32).toString('hex');
        db().prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(newToken), login, now + 8 * 3600000);
        res.setHeader('Set-Cookie', `desk_session=${newToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure ? '; Secure' : ''}`);
        reply(200, { user: { login, role: user.role } }); return true;
      }
      if (!session) fail(401, 'Войдите в кабинет команды.');
      if (await resident.handleStaff(req, res, pathname, session, readJson, sendJson)) return true;
      if (await akim.handle(req, res, pathname, session, readJson, sendJson)) return true;
      if (pathname === '/api/desk/logout' && req.method === 'POST') { db().prepare('DELETE FROM sessions WHERE token=?').run(hash(token)); res.setHeader('Set-Cookie', `desk_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`); reply(200, { ok: true }); return true; }
      if (pathname === '/api/desk/users' && req.method === 'GET') { reply(200, db().prepare('SELECT login,role FROM users ORDER BY login').all()); return true; }
      if (pathname === '/api/desk/health' && req.method === 'GET') { db().prepare('SELECT 1').get(); reply(200, { ok: true, storage: 'sqlite', bot: 'not_connected' }); return true; }
      if (pathname === '/api/desk/complaints' && req.method === 'POST') { const result = create(await readJson(req), session.login); reply(result.duplicate ? 200 : 201, result.item); return true; }
      if (pathname === '/api/desk/complaints' && req.method === 'GET') {
        const params = new URL(req.url, 'http://localhost').searchParams;
        let items = db().prepare('SELECT data FROM complaints ORDER BY id DESC').all().map(r => JSON.parse(r.data));
        const q = (params.get('q') || '').toLocaleLowerCase('ru');
        items = items.filter(i => (!q || `${i.id} ${i.text} ${i.address}`.toLocaleLowerCase('ru').includes(q)) && ['status', 'districtId', 'category'].every(k => !params.get(k) || i[k] === params.get(k)) && (!params.get('from') || i.createdAt.slice(0, 10) >= params.get('from')) && (!params.get('to') || i.createdAt.slice(0, 10) <= params.get('to')));
        const page = Math.max(1, Math.min(100000, Number(params.get('page')) || 1));
        reply(200, { total: items.length, page, items: items.slice((page - 1) * 10, page * 10), stats: { open: items.filter(i => !['resolved', 'rejected'].includes(i.status)).length, resolved: items.filter(i => i.status === 'resolved').length, new: items.filter(i => i.status === 'new').length } }); return true;
      }
      const match = /^\/api\/desk\/complaints\/(\d+)(?:\/(attachments))?$/.exec(pathname);
      if (match) {
        let item = get(Number(match[1]));
        if (req.method === 'GET' && !match[2]) { reply(200, item); return true; }
        if (req.method === 'PATCH' && !match[2]) {
          const body = await readJson(req); validateFields(body); item = get(Number(match[1]));
          if (body.version !== item.version) fail(409, 'Обращение изменено другим участником. Скопируйте свой текст и обновите карточку.');
          if (!Object.hasOwn(statuses, body.status) || (body.status !== item.status && !transitions[item.status].includes(body.status))) fail(422, 'Недопустимый переход статуса.');
          const assignee = text(body.assignee ?? '', 80);
          if (assignee && !db().prepare('SELECT login FROM users WHERE login=?').get(assignee)) fail(422, 'Ответственный не найден.');
          if (!['normal', 'high'].includes(body.priority)) fail(422, 'Выберите приоритет.');
          const note = text(body.note ?? '', 2000), publicReply = text(body.publicReply ?? '', 2000);
          if (body.status !== item.status && ['clarification', 'resolved', 'rejected'].includes(body.status) && !publicReply) fail(422, 'Для этого статуса заполните ответ жителю.');
          if (body.priority === 'high' && item.priority !== 'high' && !note) fail(422, 'Обоснуйте высокий приоритет во внутреннем комментарии.');
          const changes = [];
          for (const [key, value] of Object.entries({ status: body.status, category: body.category, districtId: body.districtId || null, assignee, priority: body.priority })) if (item[key] !== value) { changes.push(`${key}: ${item[key] || '—'} → ${value || '—'}`); item[key] = value; }
          if (!changes.length && !note && !publicReply) { reply(200, item); return true; }
          const now = new Date().toISOString();
          item.version++; item.updatedAt = now;
          item.history.push({ at: now, actor: session.login, text: [...changes, note].filter(Boolean).join('\n') || 'Сохранён ответ жителю' });
          if (publicReply) item.replies.push({ at: now, actor: session.login, text: publicReply, delivery: 'not_connected' });
          save(item); reply(200, item); return true;
        }
        if (req.method === 'POST' && match[2]) {
          const body = await readJson(req, 3 * 1024 * 1024); item = get(Number(match[1]));
          const name = text(body.name, 150, true);
          if (!['image/jpeg', 'image/png', 'image/webp'].includes(body.mime) || typeof body.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.base64)) fail(422, 'Разрешены только JPEG, PNG, WebP до 2 МБ.');
          const bytes = Buffer.from(body.base64, 'base64');
          const detected = bytes.subarray(0, 3).equals(Buffer.from([255,216,255])) ? 'image/jpeg' : bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP' ? 'image/webp' : null;
          if (!bytes.length || bytes.length > 2 * 1024 * 1024 || detected !== body.mime || item.attachments.length >= 5) fail(422, 'Некорректное изображение или превышен лимит: 2 МБ, до 5 фото.');
          transaction(() => { const inserted = db().prepare('INSERT INTO attachments(complaint,name,mime,bytes) VALUES(?,?,?,?)').run(item.id,name,body.mime,bytes); item.attachments.push({ id: Number(inserted.lastInsertRowid), name }); item.version++; item.updatedAt = new Date().toISOString(); item.history.push({ at: item.updatedAt, actor: session.login, text: `Добавлено фото: ${name}` }); save(item); });
          reply(201, item); return true;
        }
      }
      const attachment = /^\/api\/desk\/attachments\/(\d+)$/.exec(pathname);
      if (attachment && req.method === 'GET') { const file = db().prepare('SELECT * FROM attachments WHERE id=?').get(Number(attachment[1])); if (!file) fail(404, 'Файл не найден.'); res.writeHead(200, { 'Content-Type': file.mime, 'Cache-Control': 'no-store', 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'" }); res.end(Buffer.from(file.bytes)); return true; }
      if (pathname === '/api/desk/scenarios' && req.method === 'GET') { reply(200, db().prepare('SELECT data FROM scenarios ORDER BY id DESC LIMIT 100').all().map(r => JSON.parse(r.data))); return true; }
      if (pathname === '/api/desk/scenarios' && req.method === 'POST') {
        const body = await readJson(req); const name = text(body?.name, 100, true); const result = simulate(body.scenario);
        if (!result.valid) fail(422, result.errors.map(e => e.message).join(' '));
        const complaintId = body.complaintId ? get(body.complaintId).id : null;
        const data = { name, scenario: body.scenario, result, complaintId, datasetVersion: hash(JSON.stringify(getDataset())), createdAt: new Date().toISOString(), actor: session.login };
        transaction(() => { const inserted = db().prepare('INSERT INTO scenarios(data) VALUES(?)').run('{}'); data.id = Number(inserted.lastInsertRowid); db().prepare('UPDATE scenarios SET data=? WHERE id=?').run(JSON.stringify(data), data.id); });
        reply(201, data); return true;
      }
      fail(404, 'Действие не найдено.');
    } catch (error) { reply(error.status || 500, { message: error.status ? error.message : 'Не удалось выполнить действие. Повторите запрос.' }); }
    return true;
  }
  return { handle, close: () => database?.close() };
}
