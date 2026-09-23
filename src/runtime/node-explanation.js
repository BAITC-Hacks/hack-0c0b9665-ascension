import { explainScenario, isAIConfigured } from '../ai/explain.js';
import { createLocalAIGuard } from './local-ai-guard.js';

/** Create once per server so limits survive across requests. Dependencies are injected for tests. */
export function createNodeExplanation({ explain = explainScenario, aiConfigured = isAIConfigured,
  aiLimits = {}, now = Date.now, env = process.env } = {}) {
  const guard = createLocalAIGuard({ now });
  const limits = {
    maxRequests: aiLimits.maxRequests ?? env.AI_MAX_REQUESTS,
    requestsPerMinute: aiLimits.requestsPerMinute ?? env.AI_REQUESTS_PER_MINUTE,
    maxConcurrent: aiLimits.maxConcurrent ?? env.AI_MAX_CONCURRENT,
  };
  return async (scenario, result) => {
    const permit = aiConfigured() ? guard.acquire(limits) : {};
    if (permit.reason) {
      const fallback = await explainScenario(scenario, result, { apiKey: '' });
      return { body: { ...fallback, reason: permit.reason },
        headers: permit.retryAfter ? { 'Retry-After': String(permit.retryAfter) } : {} };
    }
    try { return { body: await explain(scenario, result) }; }
    finally { permit.release?.(); }
  };
}
