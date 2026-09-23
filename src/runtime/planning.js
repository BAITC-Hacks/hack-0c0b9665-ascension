import { MAX_PLAN_PROMPT_CHARS, proposePlan } from '../ai/plan.js';
import { RequestError } from '../http/errors.js';

const DENIAL_SUMMARIES = Object.freeze({
  server_request_limit: 'Лимит обращений к Ascension AI исчерпан. План можно собрать вручную.',
  server_busy: 'Ascension AI занят. Попробуйте позже или соберите план вручную.',
  server_rate_limited: 'Слишком много обращений к Ascension AI. Подождите и попробуйте снова или соберите план вручную.',
  budget_guard_unavailable: 'Ascension AI временно недоступен. План не был рассчитан; попробуйте позже или соберите его вручную.',
});

function validateInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || Reflect.ownKeys(input).length !== 1 || !Object.hasOwn(input, 'prompt')
    || typeof input.prompt !== 'string' || !input.prompt.trim()
    || input.prompt.length > MAX_PLAN_PROMPT_CHARS) {
    throw new RequestError(400, 'INVALID_PROMPT',
      `Опишите план текстом длиной от 1 до ${MAX_PLAN_PROMPT_CHARS} символов. Допустимо только поле prompt.`);
  }
}

/** Uses the caller's shared admission; client input can never select provider options. */
export function createPlanning({ admission, plan = proposePlan }) {
  if (typeof admission !== 'function' || typeof plan !== 'function') {
    throw new TypeError('Планировщику нужны функции допуска и подготовки плана.');
  }
  return async (input, env) => {
    validateInput(input);
    return admission({
      operation: options => plan(input, options),
      fallback: async ({ reason, options }) => {
        // Never invoke an injected paid operation after admission was denied.
        const body = await proposePlan(input, { ...options, apiKey: '' });
        if (reason === 'missing_api_key') return body;
        const safeReason = Object.hasOwn(DENIAL_SUMMARIES, reason) ? reason : 'budget_guard_unavailable';
        const summary = DENIAL_SUMMARIES[safeReason];
        return { ...body, reason: safeReason, summary,
          validation: { ...body.validation, errors: [{ code: 'AI_UNAVAILABLE', message: summary }] } };
      },
    }, env);
  };
}
