/** An intentional public HTTP error. Unexpected errors must never expose their message. */
export class RequestError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export function errorResult(error) {
  const known = error instanceof RequestError;
  return {
    status: known ? error.status : 500,
    headers: known ? error.headers : {},
    body: { valid: false, errors: [{
      code: known ? error.code : 'INTERNAL_ERROR',
      message: known ? error.message : 'Не удалось обработать запрос.',
    }] },
  };
}
