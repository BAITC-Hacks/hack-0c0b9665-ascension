import { createLocalAIGuard } from './local-ai-guard.js';
import { resolveAIConfiguration } from '../ai/provider.js';

const limitsFor = (env = {}, overrides = {}) => ({
  maxRequests: overrides.maxRequests ?? env.AI_MAX_REQUESTS,
  requestsPerMinute: overrides.requestsPerMinute ?? env.AI_REQUESTS_PER_MINUTE,
  maxConcurrent: overrides.maxConcurrent ?? env.AI_MAX_CONCURRENT,
});
const providerOptions = env => {
  const { configured, ...options } = resolveAIConfiguration({}, env);
  return options;
};
function retryHeaders({ reason, retryAfter }) {
  const retry = Number.isInteger(retryAfter) && retryAfter > 0 ? retryAfter
    : reason === 'server_request_limit' ? undefined : reason === 'server_busy' ? 5 : 60;
  return retry ? { 'Retry-After': String(retry) } : {};
}
async function declined(fallback, options, denial = {}, headers = {}) {
  return { body: await fallback({ reason: denial.reason, options: { ...options, apiKey: '', aiBinding: undefined } }), headers };
}

/** One instance per Node server; every paid operation shares these counters. */
export function createNodeAIAdmission({ now = Date.now, env = globalThis.process?.env ?? {},
  aiLimits = {}, aiConfigured = () => resolveAIConfiguration({}, env).configured } = {}) {
  const guard = createLocalAIGuard({ now });
  const limits = limitsFor(env, aiLimits);
  return async function run({ operation, fallback }) {
    const options = providerOptions(env);
    if (!aiConfigured()) return declined(fallback, options, { reason: 'missing_api_key' });
    const permit = guard.acquire(limits);
    if (permit.reason) return declined(fallback, options, permit,
      permit.retryAfter ? { 'Retry-After': String(permit.retryAfter) } : {});
    try { return { body: await operation(options), headers: {} }; }
    finally { permit.release(); }
  };
}

async function platformDenial(env) {
  try {
    const result = await env.AI_RATE_LIMITER?.limit({ key: 'ascension-city-map:explain' });
    if (result?.success === true) return null;
  } catch { /* Admission failures never enable provider calls. */ }
  return { reason: 'server_rate_limited' };
}
async function durablePermit(env) {
  try {
    const budget = env.AI_BUDGET?.getByName('global');
    const permit = budget && await budget.acquire();
    if (permit?.allowed === true && typeof permit.leaseId === 'string' && permit.leaseId.trim()) {
      return { async release() {
        try { await budget.release(permit.leaseId); } catch { /* Lease expiry preserves the cap. */ }
      } };
    }
    return { reason: typeof permit?.reason === 'string' && permit.reason
      ? permit.reason : 'budget_guard_unavailable', retryAfter: permit?.retryAfter };
  } catch { return { reason: 'budget_guard_unavailable' }; }
}

/** One instance per Worker isolate, with the existing global durable budget. */
export function createWorkerAIAdmission({ now = Date.now } = {}) {
  const guard = createLocalAIGuard({ now });
  return async function run({ operation, fallback }, env) {
    const options = providerOptions(env);
    if (!resolveAIConfiguration({}, env).configured) return declined(fallback, options, { reason: 'missing_api_key' });
    const limits = limitsFor(env);
    const localDenial = guard.check(limits);
    const denial = localDenial.reason ? localDenial : await platformDenial(env);
    if (denial) return declined(fallback, options, denial, retryHeaders(denial));
    // Recheck after the asynchronous platform guard before taking a durable lease.
    const local = guard.acquire(limits);
    if (local.reason) return declined(fallback, options, local, retryHeaders(local));
    try {
      const durable = await durablePermit(env);
      if (durable.reason) return await declined(fallback, options, durable, retryHeaders(durable));
      try { return { body: await operation(options), headers: {} }; }
      finally { await durable.release(); }
    } finally { local.release(); }
  };
}
