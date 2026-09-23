let nextRequestId = 0;

function clientError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = 'PolicyOptionsError';
  error.code = code;
  return error;
}

function abortError() {
  return new DOMException('Расчёт рекомендаций отменён.', 'AbortError');
}

/** A local fetch-compatible adapter for the policy options endpoint only. */
export function createPolicyOptionsFetcher({
  WorkerClass = globalThis.Worker,
  workerUrl = new URL('./policy-options-worker.js', import.meta.url),
  timeoutMs = 12000,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Время ожидания расчёта должно быть положительным числом.');
  }

  return async function fetchPolicyOptions(endpoint, { method, body, signal } = {}) {
    if (signal?.aborted) throw abortError();
    if (endpoint !== '/api/policy-options' || typeof method !== 'string' || method.toUpperCase() !== 'POST') {
      throw clientError('UNSUPPORTED_REQUEST', 'Клиент рекомендаций поддерживает только POST /api/policy-options.');
    }
    if (typeof body !== 'string') {
      throw clientError('INVALID_JSON', 'Передайте сценарий как строку JSON.');
    }
    let scenario;
    try {
      scenario = JSON.parse(body);
    } catch (cause) {
      throw clientError('INVALID_JSON', 'Не удалось прочитать сценарий: некорректный JSON.', cause);
    }
    if (typeof WorkerClass !== 'function') {
      throw clientError('WORKER_UNAVAILABLE', 'В этом браузере недоступны фоновые расчёты. Откройте приложение в браузере с поддержкой Web Worker.');
    }

    const requestId = `policy-options-${++nextRequestId}`;
    return new Promise((resolve, reject) => {
      let worker;
      let timer;
      let settled = false;

      function cleanup() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (!worker) return;
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        worker.removeEventListener('messageerror', onMessageError);
        worker.terminate();
      }

      function finish(error, response) {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(response);
      }

      function onAbort() {
        finish(abortError());
      }

      function invalidMessage() {
        finish(clientError('INVALID_WORKER_MESSAGE', 'Фоновый расчёт вернул некорректный ответ. Повторите попытку.'));
      }

      function onMessage(event) {
        const message = event.data;
        if (!message || typeof message !== 'object' || Array.isArray(message) || !Object.hasOwn(message, 'requestId') ||
          !((typeof message.requestId === 'string' && message.requestId.length > 0) || Number.isFinite(message.requestId))) {
          invalidMessage();
          return;
        }
        // A late response from another request cannot complete this request.
        if (message.requestId !== requestId) return;
        const hasData = Object.hasOwn(message, 'data');
        const hasError = Object.hasOwn(message, 'error');
        if (hasData === hasError) {
          invalidMessage();
          return;
        }
        if (hasError) {
          const error = message.error;
          if (!error || typeof error.code !== 'string' || !error.code.trim() || typeof error.message !== 'string' || !error.message.trim()) {
            invalidMessage();
            return;
          }
          finish(clientError(error.code, error.message));
          return;
        }
        const data = message.data;
        if (!data || typeof data !== 'object' || Array.isArray(data) || (Object.hasOwn(data, 'valid') && typeof data.valid !== 'boolean')) {
          invalidMessage();
          return;
        }
        try {
          const response = new Response(JSON.stringify(data), {
            status: data.valid === false ? 422 : 200,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
          });
          finish(null, response);
        } catch {
          invalidMessage();
        }
      }

      function onError(event) {
        event.preventDefault?.();
        finish(clientError('WORKER_ERROR', 'Не удалось выполнить фоновый расчёт рекомендаций. Повторите попытку.'));
      }

      function onMessageError() {
        finish(clientError('WORKER_MESSAGE_ERROR', 'Не удалось прочитать ответ фонового расчёта. Повторите попытку.'));
      }

      try {
        worker = new WorkerClass(workerUrl, { type: 'module' });
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        worker.addEventListener('messageerror', onMessageError);
        signal?.addEventListener('abort', onAbort, { once: true });
        // The signal may have changed while the worker was being constructed.
        if (signal?.aborted) {
          onAbort();
          return;
        }
        timer = setTimeout(() => {
          finish(clientError('WORKER_TIMEOUT', 'Расчёт рекомендаций занял слишком много времени. Повторите попытку.'));
        }, timeoutMs);
        worker.postMessage({ requestId, scenario, limit: 6 });
      } catch (cause) {
        finish(clientError('WORKER_START_FAILED', 'Не удалось запустить фоновый расчёт рекомендаций. Повторите попытку.', cause));
      }
    });
  };
}
