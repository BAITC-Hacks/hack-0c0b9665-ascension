import { DurableObject } from 'cloudflare:workers';
import { AIBudgetState } from './ai-budget.js';
import { createDurableComplaintStore } from './complaints/durable-store.js';
import { createComplaintFetchHandler } from './complaints/worker-routes.js';

export { default } from './worker.js';

export class AIBudget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.budget = new AIBudgetState(ctx);
  }

  acquire() { return this.budget.acquire(); }
  release(leaseId) { return this.budget.release(leaseId); }
}

/** One durable owner for public forms, admin updates and Telegram receipts. */
export class Complaints extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.handle = createComplaintFetchHandler({
      store: createDurableComplaintStore({ storage: ctx.storage }),
      sessionStorage: ctx.storage,
      adminToken: env.ADMIN_TOKEN ?? '',
      telegramToken: env.TELEGRAM_BOT_TOKEN ?? '',
      telegramUsername: env.TELEGRAM_BOT_USERNAME ?? '',
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET ?? '',
      publicBaseUrl: env.PUBLIC_BASE_URL ?? '',
      telegramSupportUrl: env.TELEGRAM_SUPPORT_URL ?? '',
    });
  }

  fetch(request) {
    // Body reads must not block unrelated requests. The store serializes its
    // mutations and the Telegram processor serializes each chat's session.
    return this.handle(request);
  }
}
