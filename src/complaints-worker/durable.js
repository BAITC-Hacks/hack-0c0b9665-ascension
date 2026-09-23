import { DurableObject } from 'cloudflare:workers';
import { createComplaintRuntime } from './runtime.js';

export class ComplaintService extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.runtime = createComplaintRuntime({ storage: ctx.storage, env });
  }
  fetch(request) { return this.runtime.fetch(request); }
  alarm() { return this.runtime.alarm(); }
}
