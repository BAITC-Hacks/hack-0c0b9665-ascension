import { MAX_BODY_BYTES, WorkspaceError, validateWrite } from './schema.js';
import { readConfiguration, enforceOrigin, authenticateAccessKey, authenticateSession, issueSession, sessionCookie, publicIdentity, sha256 } from './auth.js';

export async function readBoundedJson(request) {
  if ((request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') throw new WorkspaceError(415, 'JSON_REQUIRED', 'Нужен JSON.');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new WorkspaceError(413, 'PAYLOAD_TOO_LARGE', 'Лимит общего реестра: 128 КиБ.');
  if (!request.body) throw new WorkspaceError(400, 'INVALID_JSON', 'Пустой запрос.');
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { try { await reader.cancel(); } catch { /* Preserve the quota error even if cancellation fails. */ } throw new WorkspaceError(413, 'PAYLOAD_TOO_LARGE', 'Лимит общего реестра: 128 КиБ.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all)); }
  catch { throw new WorkspaceError(400, 'INVALID_JSON', 'Неверный JSON.'); }
}
const json = (value, status = 200, headers = {}) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
export function createWorkspaceHandler({ repository, getConfig, now = Date.now }) {
  if (!repository || typeof getConfig !== 'function') throw new TypeError('Repository and configuration provider required.');
  return async function handleWorkspace(request, { clientAddress } = {}) {
    try {
      const url = new URL(request.url), path = url.pathname, method = request.method;
      const config = await readConfiguration(await getConfig());
      enforceOrigin(request, config);
      if (url.search) throw new WorkspaceError(400, 'QUERY_NOT_ALLOWED', 'Параметры URL не используются для доступа.');
      const routes = { '/api/workspace/session': ['GET', 'POST', 'DELETE'], '/api/workspace/register': ['GET', 'PUT'], '/api/workspace/audit': ['GET'] };
      if (!Object.hasOwn(routes, path)) throw new WorkspaceError(404, 'NOT_FOUND', 'Маршрут не найден.');
      if (!routes[path].includes(method)) return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Метод не поддерживается.' } }, 405, { Allow: routes[path].join(', ') });
      const clock = now();
      if (path === '/api/workspace/session' && method === 'POST') {
        const address = typeof clientAddress === 'string' && clientAddress.length > 0 && clientAddress.length <= 128 ? clientAddress : 'unknown';
        const retry = repository.consumeLogin(clock, await sha256(address));
        if (retry) return json({ error: { code: 'LOGIN_RATE_LIMIT', message: 'Слишком много попыток входа. Повторите позже.' } }, 429, { 'Retry-After': String(retry) });
        const input = await readBoundedJson(request);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'accessKey')) throw new WorkspaceError(400, 'INVALID_LOGIN', 'Неверный формат входа.');
        const policy = await authenticateAccessKey(input.accessKey, config);
        if (!policy) throw new WorkspaceError(401, 'UNAUTHENTICATED', 'Ключ доступа не принят.');
        const session = await issueSession(policy, config, clock);
        return json({ enabled: true, identity: publicIdentity(policy), expiresAt: new Date(session.payload.exp).toISOString() }, 200, { 'Set-Cookie': sessionCookie(session.value, config) });
      }
      const session = await authenticateSession(request, config, repository, clock);
      if (!session) throw new WorkspaceError(401, 'UNAUTHENTICATED', 'Войдите с ключом доступа, выданным оператором.');
      if (path === '/api/workspace/session') {
        if (method === 'DELETE') {
          repository.revokeSession(session.payload.jti, session.payload.exp, clock);
          return json({ enabled: true, signedOut: true }, 200, { 'Set-Cookie': sessionCookie('', config, true) });
        }
        return json({ enabled: true, identity: session.identity, expiresAt: new Date(session.payload.exp).toISOString() });
      }
      if (path === '/api/workspace/audit') return json({ entries: repository.audit() }); // All authenticated roles can inspect authorship.
      if (method === 'GET') return json(repository.read());
      if (!['owner', 'editor'].includes(session.identity.role)) throw new WorkspaceError(403, 'FORBIDDEN', 'Роль наблюдателя разрешает только чтение.');
      const input = validateWrite(await readBoundedJson(request));
      return json(repository.write({ ...input, actor: session.identity, at: new Date(clock).toISOString() }));
    } catch (error) {
      if (error instanceof WorkspaceError) return json({ error: { code: error.code, message: error.message, ...error.extra } }, error.status);
      return json({ error: { code: 'WORKSPACE_ERROR', message: 'Общий реестр временно недоступен. Локальные записи не изменены.' } }, 500);
    }
  };
}
