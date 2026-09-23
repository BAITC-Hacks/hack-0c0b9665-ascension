import { randomBytes } from 'node:crypto';
import { openStore, passwordHash } from '../src/desk/store.js';
import { resolve } from 'node:path';
const [login,role='operator'] = process.argv.slice(2);
if (!login || !/^[a-zA-Z0-9_-]{2,40}$/.test(login) || !['admin','operator','akim'].includes(role)) { console.error('Использование: npm run desk:user -- login admin|operator|akim'); process.exit(1); }
const password = process.env.DESK_NEW_PASSWORD || randomBytes(18).toString('base64url');
if(password.length < 12 || password.length > 200 || password.trim() !== password) { console.error('Пароль: от 12 до 200 символов, без пробелов по краям.'); process.exit(1); }
const db = openStore(process.env.DESK_DB_PATH || resolve('var/desk.sqlite'));
db.prepare('INSERT INTO users(login,password,role) VALUES(?,?,?) ON CONFLICT(login) DO UPDATE SET password=excluded.password,role=excluded.role').run(login,passwordHash(password),role);
db.prepare('DELETE FROM sessions WHERE login=?').run(login);db.close();
console.log(`Учётная запись ${login} (${role}) создана/обновлена. Старые сессии завершены.`);
if(!process.env.DESK_NEW_PASSWORD) console.log(`Одноразовый вывод нового пароля: ${password}`);
