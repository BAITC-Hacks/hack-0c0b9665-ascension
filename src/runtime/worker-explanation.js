import { explainScenario } from '../ai/explain.js';
import { createLocalAIGuard } from './local-ai-guard.js';

function localLimits(env) {
  return {
    maxRequests: env.AI_MAX_REQUESTS,
    requestsPerMinute: env.AI_REQUESTS_PER_MINUTE,
    maxConcurrent: env.AI_MAX_CONCURRENT,
  };
}

async function checkPlatformRate(env) {
  try {
    // The platform rate limit is per location; the durable budget remains authoritative.
    const result = await env.AI_RATE_LIMITER?.limit({ key: 'ascension-city-map:explain' });
    if (result?.success === true) return null;
  } catch { /* Missing and unavailable guards both disable paid calls. */ }
  return { reason: 'server_rate_limited' };
}

async function acquireDurableBudget(env) {
  try {
    const budget = env.AI_BUDGET?.getByName('global');
    const permit = budget && await budget.acquire();
    if (permit?.allowed === true && typeof permit.leaseId === 'string' && permit.leaseId.trim()) {
      return {
        async release() {
          // Failed releases stay reserved until lease expiry; never retry the provider call.
          try { await budget.release(permit.leaseId); } catch { /* Fail closed. */ }
        },
      };
    }
    const reason = typeof permit?.reason === 'string' && permit.reason
      ? permit.reason : 'budget_guard_unavailable';
    return { reason, retryAfter: permit?.retryAfter };
  } catch {
    return { reason: 'budget_guard_unavailable' };
  }
}

function retryHeaders({ reason, retryAfter }) {
  const retry = Number.isInteger(retryAfter) && retryAfter > 0 ? retryAfter
    : reason === 'server_request_limit' ? undefined : reason === 'server_busy' ? 5 : 60;
  return retry ? { 'Retry-After': String(retry) } : {};
}

/** Runtime policy around the provider, independent of HTTP routing and serialization. */
export function createWorkerExplanation({ explain = explainScenario, now = Date.now } = {}) {
  // These counters are an isolate-local backstop, never the durable spending cap.
  const guard = createLocalAIGuard({ now });

  return async function explainInWorker(scenario, result, env) {
    const options = {
      apiKey: env.OPENAI_API_KEY ?? '',
      model: env.OPENAI_MODEL,
      // Replacement enumeration is unsuitable for the free Worker's CPU budget.
      skipReplacementSearch: true,
    };
    const fallback = async denial => ({
      body: { ...await explain(scenario, result, { ...options, apiKey: '' }), reason: denial.reason },
      headers: retryHeaders(denial),
    });
    if (!options.apiKey.trim()) return { body: await explain(scenario, result, options) };

    const limits = localLimits(env);
    const localDenial = guard.check(limits);
    const denial = localDenial.reason ? localDenial : await checkPlatformRate(env);
    if (denial) return fallback(denial);

    // Recheck atomically after awaiting the platform binding to close the dispatch race.
    const localPermit = guard.acquire(limits);
    if (localPermit.reason) return fallback(localPermit);
    try {
      const durablePermit = await acquireDurableBudget(env);
      if (durablePermit.reason) return await fallback(durablePermit);
      try {
        return { body: await explain(scenario, result, options) };
      } finally {
        await durablePermit.release();
      }
    } finally {
      localPermit.release();
    }
  };
}
