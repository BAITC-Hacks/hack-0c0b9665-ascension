import { readConfiguration } from '../workspace/auth.js';
import { WorkspaceError } from '../workspace/schema.js';
import { secureWorkspaceResponse, workspaceUnavailable } from '../http/workspace.js';

async function responseFor(request, response) {
  const secured = secureWorkspaceResponse(response);
  if (request.method !== 'HEAD') return secured;
  try { await secured.body?.cancel(); } catch { /* HEAD sends metadata even if source cleanup fails. */ }
  return new Response(null, {
    status: secured.status, statusText: secured.statusText, headers: secured.headers,
  });
}

/** Validate configuration before touching the DO; authentication and body parsing stay in its service. */
export async function handleWorkerWorkspace(request, env) {
  let result;
  try {
    try {
      await readConfiguration(env);
    } catch (error) {
      if (!(error instanceof WorkspaceError && error.status === 503 && error.code === 'WORKSPACE_DISABLED')) throw error;
      return responseFor(request, workspaceUnavailable(true));
    }
    const headers = new Headers(request.headers);
    // This private metadata is rate-limit input only. Never trust a caller-supplied value or XFF.
    headers.set('X-Workspace-Client-Address', request.headers.get('CF-Connecting-IP') || 'unknown');
    // Supplying the existing stream directly avoids Request-copy prefetch before authentication.
    const forwarded = new Request(request.url, {
      method: request.method, headers, signal: request.signal, redirect: request.redirect,
      ...(request.body ? { body: request.body, duplex: 'half' } : {}),
    });
    result = await env.TEAM_WORKSPACE.getByName('team').fetch(forwarded);
    if (!(result instanceof Response)) throw new TypeError('Workspace binding returned no response.');
  } catch {
    result = workspaceUnavailable(false);
  }
  return responseFor(request, result);
}
