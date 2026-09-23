import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfiguration } from '../workspace/auth.js';
import { createWorkspaceHandler } from '../workspace/handler.js';
import { createSqliteRepository } from '../workspace/node-sqlite.js';
import { WorkspaceError } from '../workspace/schema.js';
import { WORKSPACE_RESPONSE_HEADERS, workspaceUnavailable } from '../http/workspace.js';
import { handleNodeWebRequest, sendNodeWebResponse } from './node-web-handler.js';

const PUBLIC_DIRECTORY = fileURLToPath(new URL('../../public/', import.meta.url));
const DEFAULT_DATABASE = fileURLToPath(new URL('../../var/workspace.sqlite', import.meta.url));
const REPOSITORY_METHODS = ['read', 'write', 'audit', 'consumeLogin', 'revokeSession', 'sessionRevoked'];

function isInside(directory, target) {
  const path = relative(directory, target);
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}

/** Resolve existing ancestors as well as a database file that does not exist yet. */
function physicalPath(path) {
  try { return realpathSync(path); }
  catch (error) {
    if (error.code !== 'ENOENT' || dirname(path) === path) throw error;
    return resolve(physicalPath(dirname(path)), relative(dirname(path), path));
  }
}

function databasePath(value, publicDir) {
  const path = resolve(value);
  const publicRoot = resolve(publicDir);
  if (isInside(publicRoot, path)) throw new Error('Workspace storage must be outside public.');
  const physical = physicalPath(path);
  if (isInside(physicalPath(publicRoot), physical)) {
    throw new Error('Workspace storage must be outside public.');
  }
  return physical;
}

/** Node composition only: transport, operator configuration and a lazily opened SQLite store. */
export function createNodeWorkspace({ env = process.env, dbPath, publicDir = PUBLIC_DIRECTORY } = {}) {
  let repository;
  let closed = false;

  function getRepository() {
    if (closed) throw new Error('Workspace storage is closed.');
    if (!repository) {
      const path = databasePath(env.WORKSPACE_DB_PATH || dbPath || DEFAULT_DATABASE, publicDir);
      mkdirSync(dirname(path), { recursive: true });
      repository = createSqliteRepository(path);
    }
    return repository;
  }

  async function unavailable(request, response, disabled = false) {
    if (!request.destroyed && !request.readableEnded) request.resume();
    await sendNodeWebResponse(request, response, workspaceUnavailable(disabled), WORKSPACE_RESPONSE_HEADERS);
  }

  return {
    async handle(request, response) {
      try {
        let config;
        try {
          // Run the service's exact validator before Request bridging or any database operation.
          config = await readConfiguration(env);
        } catch (error) {
          if (!(error instanceof WorkspaceError && error.status === 503 && error.code === 'WORKSPACE_DISABLED')) throw error;
          await unavailable(request, response, true);
          return;
        }
        if (closed) return unavailable(request, response);

        // Service authentication masks repository failures too. Track them per request so a
        // storage outage becomes 503 rather than an apparently invalid cookie or a raw 500.
        let storageFailed = false;
        const port = Object.fromEntries(REPOSITORY_METHODS.map(method => [method, (...args) => {
          try { return getRepository()[method](...args); }
          catch (error) { storageFailed = true; throw error; }
        }]));
        const handler = createWorkspaceHandler({ repository: port, getConfig: () => env });
        await handleNodeWebRequest(request, response, {
          origin: config.origin,
          responseHeaders: WORKSPACE_RESPONSE_HEADERS,
          async handler(webRequest) {
            const result = await handler(webRequest, { clientAddress: request.socket.remoteAddress });
            return storageFailed ? workspaceUnavailable(false) : result;
          },
        });
      } catch {
        if (response.headersSent || response.destroyed) response.destroy();
        else await unavailable(request, response);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      repository?.close();
    },
  };
}
