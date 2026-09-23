import { explainScenario } from '../ai/explain.js';
import { createNodeAIAdmission } from './ai-admission.js';

/** The composition root shares admission with planning; standalone callers retain safe defaults. */
export function createNodeExplanation({ explain = explainScenario, aiConfigured,
  aiLimits = {}, now = Date.now, env = process.env, admission } = {}) {
  const run = admission ?? createNodeAIAdmission({ aiConfigured, aiLimits, now, env });
  // Only the default provider and its actual process environment may use the legacy success cache.
  // Explicit environments and all fallbacks receive an explicit key to avoid ambient credentials.
  const useProcessDefaults = explain === explainScenario && env === process.env;
  return (scenario, result) => run({
    operation: options => explain(scenario, result, useProcessDefaults ? undefined : options),
    fallback: async ({ reason, options }) => {
      if (reason === 'missing_api_key') return explain(scenario, result, options);
      return { ...await explainScenario(scenario, result, options), reason };
    },
  });
}
