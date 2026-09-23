import { WorkspaceError } from './schema.js';
const encoder = new TextEncoder();
export const SESSION_TTL_MS = 15 * 60 * 1000;
export const COOKIE_NAME = 'akim_workspace_session';
const bytes = (v) => encoder.encode(v);
const b64 = (v) => btoa(String.fromCharCode(...new Uint8Array(v))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const unb64 = (v) => Uint8Array.from(atob(v.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
const disabled = () => { throw new WorkspaceError(503, 'WORKSPACE_DISABLED', 'Общий реестр выключен: оператор должен настроить защищённый доступ.'); };
export async function sha256(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(value)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function readConfiguration(input) {
  try {
    if (!input || typeof input.WORKSPACE_SESSION_SECRET !== 'string' || input.WORKSPACE_SESSION_SECRET.length < 32 || input.WORKSPACE_SESSION_SECRET.length > 512) disabled();
    const origin = new URL(input.WORKSPACE_ORIGIN);
    if (origin.origin !== input.WORKSPACE_ORIGIN || origin.username || origin.password || !['https:', 'http:'].includes(origin.protocol)) disabled();
    if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) disabled();
    if (typeof input.WORKSPACE_ACCESS_POLICY !== 'string' || input.WORKSPACE_ACCESS_POLICY.length > 16_384) disabled();
    const policy = JSON.parse(input.WORKSPACE_ACCESS_POLICY);
    if (!Array.isArray(policy) || !policy.length || policy.length > 20) disabled();
    const ids = new Set(), hashes = new Set();
    for (const p of policy) {
      if (!p || Object.keys(p).length !== 4 || typeof p.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.id) || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 160 || !['owner', 'editor', 'viewer'].includes(p.role) || typeof p.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(p.tokenHash) || ids.has(p.id) || hashes.has(p.tokenHash)) disabled();
      ids.add(p.id); hashes.add(p.tokenHash);
    }
    const key = await crypto.subtle.importKey('raw', bytes(input.WORKSPACE_SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    return { origin: origin.origin, secure: origin.protocol === 'https:', policy, key };
  } catch { return disabled(); }
}
export function enforceOrigin(request, config) {
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  if ((origin !== null && origin !== config.origin) || (fetchSite !== null && !['same-origin', 'none'].includes(fetchSite)) || (!['GET', 'HEAD'].includes(request.method) && origin !== config.origin)) {
    throw new WorkspaceError(403, 'ORIGIN_REJECTED', 'Запрос должен идти с того же сайта.');
  }
}
// HMAC verification compares signatures in the crypto implementation, not JS string equality.
async function constantEqual(key, left, right) {
  const signature = await crypto.subtle.sign('HMAC', key, bytes(left));
  return crypto.subtle.verify('HMAC', key, signature, bytes(right));
}
async function fingerprint(config, policy) { return b64(await crypto.subtle.sign('HMAC', config.key, bytes(JSON.stringify(policy)))); }
export const publicIdentity = ({ id, name, role }) => ({ id, name, role });
export async function authenticateAccessKey(accessKey, config) {
  if (typeof accessKey !== 'string' || accessKey.length < 32 || accessKey.length > 512) return null;
  const digest = await sha256(accessKey);
  let matched = null;
  for (const policy of config.policy) if (await constantEqual(config.key, policy.tokenHash, digest)) matched = policy;
  return matched;
}
export async function issueSession(policy, config, now) {
  const payload = { v: 1, id: policy.id, fingerprint: await fingerprint(config, policy), jti: crypto.randomUUID(), iat: now, exp: now + SESSION_TTL_MS };
  const encoded = b64(bytes(JSON.stringify(payload)));
  return { value: `${encoded}.${b64(await crypto.subtle.sign('HMAC', config.key, bytes(encoded)))}`, payload };
}
export async function authenticateSession(request, config, repository, now) {
  try {
    const cookie = request.headers.get('cookie') ?? '';
    if (cookie.length > 8192) return null;
    const matches = cookie.split(';').map((v) => v.trim()).filter((v) => v.startsWith(`${COOKIE_NAME}=`));
    if (matches.length !== 1) return null;
    const token = matches[0].slice(COOKIE_NAME.length + 1);
    if (token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
    const [encoded, signature] = token.split('.');
    if (!await crypto.subtle.verify('HMAC', config.key, unb64(signature), bytes(encoded))) return null;
    const payload = JSON.parse(new TextDecoder().decode(unb64(encoded)));
    if (payload.v !== 1 || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat > now || payload.exp <= now || payload.exp - payload.iat !== SESSION_TTL_MS || typeof payload.jti !== 'string' || payload.jti.length > 80) return null;
    const policy = config.policy.find((p) => p.id === payload.id);
    if (!policy || typeof payload.fingerprint !== 'string' || !await constantEqual(config.key, payload.fingerprint, await fingerprint(config, policy)) || repository.sessionRevoked(payload.jti)) return null;
    return { identity: publicIdentity(policy), payload };
  } catch { return null; }
}
export function sessionCookie(value, config, clear = false) {
  return `${COOKIE_NAME}=${value}; Path=/api/workspace; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_TTL_MS / 1000}${config.secure ? '; Secure' : ''}`;
}
