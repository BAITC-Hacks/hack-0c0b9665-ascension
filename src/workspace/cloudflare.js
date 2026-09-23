import { DurableObject } from 'cloudflare:workers';
import { createDurableRepository } from './durable-repository.js';
import { createWorkspaceHandler } from './handler.js';

// One named instance per team workspace. The caller must preserve the original Request headers.
export class TeamWorkspaceDurableObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.repository = createDurableRepository(ctx.storage);
    this.handle = createWorkspaceHandler({ repository: this.repository, getConfig: () => this.env });
  }
  fetch(request) { return this.handle(request); }
}
