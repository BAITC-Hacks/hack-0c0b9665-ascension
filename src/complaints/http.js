import { fileURLToPath } from 'node:url';
import { createComplaintStore } from './store.js';
import { createComplaintRouteCore } from './route-core.js';

const DEFAULT_FILE = fileURLToPath(new URL('../../var/complaints.json', import.meta.url));

/** Node adapter: local JSON storage and environment defaults. */
export function createComplaintRoutes(options = {}) {
  return createComplaintRouteCore({
    ...options,
    store: options.store ?? createComplaintStore({ filePath: process.env.COMPLAINTS_FILE || DEFAULT_FILE }),
    adminToken: options.adminToken ?? process.env.ADMIN_TOKEN ?? '',
    webhookSecret: options.webhookSecret ?? process.env.TELEGRAM_WEBHOOK_SECRET ?? '',
    telegramToken: options.telegramToken ?? process.env.TELEGRAM_BOT_TOKEN ?? '',
    telegramUsername: options.telegramUsername ?? process.env.TELEGRAM_BOT_USERNAME ?? '',
    publicBaseUrl: options.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? '',
    telegramSupportUrl: options.telegramSupportUrl ?? process.env.TELEGRAM_SUPPORT_URL ?? '',
  });
}
