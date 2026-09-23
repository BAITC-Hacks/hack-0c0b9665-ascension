import { getBaseline, getDataset, simulate, validateScenario } from '../core/simulator.js';
import { RequestError } from './errors.js';
import { assertSameOrigin, requireMethod } from './policy.js';

const API_METHODS = new Map([
  ['/api/health', 'GET'], ['/api/dataset', 'GET'], ['/api/baseline', 'GET'],
  ['/api/validate', 'POST'], ['/api/simulate', 'POST'], ['/api/explain', 'POST'],
]);

/**
 * One application contract for both transports. The explanation service owns provider admission;
 * this layer guarantees that it receives only a valid scenario and a fresh official calculation.
 * A null result delegates a non-API path to the transport's static asset adapter.
 */
export async function handleApiRequest({ pathname, method, readJson, aiConfigured, explain, headers, origin }) {
  const expected = API_METHODS.get(pathname);
  if (!expected) {
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      throw new RequestError(404, 'NOT_FOUND', 'Маршрут API не найден.');
    }
    return null;
  }
  requireMethod(method, [expected]);
  if (expected === 'POST') assertSameOrigin(headers, origin);
  if (pathname === '/api/health') return { status: 200, body: { ok: true, aiConfigured: Boolean(aiConfigured) } };
  if (pathname === '/api/dataset') return { status: 200, body: getDataset() };
  if (pathname === '/api/baseline') return { status: 200, body: getBaseline() };

  const scenario = await readJson();
  if (pathname === '/api/validate') return { status: 200, body: validateScenario(scenario) };
  const result = simulate(scenario);
  if (!result.valid) return { status: 422, body: result };
  if (pathname === '/api/simulate') return { status: 200, body: result };
  return { status: 200, ...await explain(scenario, result) };
}
