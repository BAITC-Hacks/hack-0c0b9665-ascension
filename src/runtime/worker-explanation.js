import { explainScenario } from '../ai/explain.js';
import { createWorkerAIAdmission } from './ai-admission.js';

/** Provider-specific options stay separate from the shared paid-operation policy. */
export function createWorkerExplanation({ explain = explainScenario, now = Date.now, admission } = {}) {
  const run = admission ?? createWorkerAIAdmission({ now });
  const explainWithoutSearch = (scenario, result, options) => explain(scenario, result, {
    ...options,
    // Replacement enumeration is unsuitable for the free Worker's CPU budget.
    skipReplacementSearch: true,
  });
  return (scenario, result, env) => run({
    operation: options => explainWithoutSearch(scenario, result, options),
    fallback: async ({ reason, options }) => {
      const body = await explainWithoutSearch(scenario, result, options);
      return reason === 'missing_api_key' ? body : { ...body, reason };
    },
  }, env);
}
