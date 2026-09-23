import { DurableObject } from 'cloudflare:workers';
import { AIBudgetState } from './ai-budget.js';
import { createDurableComplaintStore, runWithComplaintStorageLock } from './complaints/durable-store.js';
import { createComplaintMigrationHandler, createComplaintMigrationService } from './complaints/migration.js';
import { createComplaintFetchHandler } from './complaints/worker-routes.js';
import { cleanupTelegramUpdates } from './complaints/telegram.js';

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
    this.storage = ctx.storage;
    this.migrate = createComplaintMigrationHandler({
      migrate: createComplaintMigrationService({ storage: ctx.storage,
        runExclusive: operation => runWithComplaintStorageLock(ctx.storage, operation) }),
      adminToken: env.ADMIN_TOKEN ?? '',
      migrationToken: env.COMPLAINTS_MIGRATION_TOKEN ?? '',
    });
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

  async fetch(request) {
    // Body reads must not block unrelated requests. The store serializes its
    // mutations and the Telegram processor serializes each chat's session.
    return (await this.migrate(request)) ?? this.handle(request);
  }

  alarm() {
    return cleanupTelegramUpdates(this.storage);
  }
}
