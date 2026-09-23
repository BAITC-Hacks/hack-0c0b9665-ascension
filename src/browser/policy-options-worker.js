import { buildPolicyOptions } from '../core/policy-options.js';

// Each search gets a dedicated worker. Termination cancels the synchronous search.
self.addEventListener('message', ({ data }) => {
  const requestId = data?.requestId;
  if (typeof requestId !== 'string' || !requestId || requestId.length > 128) return;
  try {
    const result = buildPolicyOptions(data.scenario, {
      limit: data.limit ?? 6,
      constraints: data.constraints,
    });
    self.postMessage({ requestId, data: result });
  } catch {
    self.postMessage({ requestId, error: {
      code: 'POLICY_SEARCH_FAILED',
      message: 'Не удалось найти альтернативы. Проверьте план и повторите поиск.',
    } });
  }
});
