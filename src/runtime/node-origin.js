/** Trust deployment configuration, never a caller's Forwarded/X-Forwarded-* headers. */
export function configuredPublicOrigin(publicOrigin, env) {
  const value = publicOrigin ?? (env.PUBLIC_ORIGIN || env.RENDER_EXTERNAL_URL);
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new Error('PUBLIC_ORIGIN / RENDER_EXTERNAL_URL должен содержать только HTTP(S) origin без пути и учётных данных.');
  }
}
