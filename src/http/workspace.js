import { SECURITY_HEADERS } from './policy.js';

const PREFIX = '/api/workspace';
export const WORKSPACE_RESPONSE_HEADERS = Object.freeze({ ...SECURITY_HEADERS, 'Cache-Control': 'no-store' });

/** Keep the optional workspace separate from similarly named simulator or asset paths. */
export function isWorkspacePath(pathname) {
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

export function secureWorkspaceResponse(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(WORKSPACE_RESPONSE_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function workspaceUnavailable(disabled = false) {
  return Response.json({ error: {
    code: disabled ? 'WORKSPACE_DISABLED' : 'WORKSPACE_UNAVAILABLE',
    message: disabled
      ? 'Общий реестр выключен: оператор должен настроить защищённый доступ.'
      : 'Общий реестр временно недоступен. Локальные записи не изменены.',
  } }, { status: 503, headers: WORKSPACE_RESPONSE_HEADERS });
}
