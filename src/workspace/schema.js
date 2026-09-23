import { normalizeActionDocument } from '../../public/action-register.js';

export const MAX_BODY_BYTES = 128 * 1024;
export class WorkspaceError extends Error {
  constructor(status, code, message, extra = {}) { super(message); Object.assign(this, { status, code, extra }); }
}
const bad = () => { throw new WorkspaceError(422, 'INVALID_DOCUMENT', 'Реестр имеет неверную структуру или превышает ограничения.'); };
// Same pure schema-2 validator for local imports and storage; importing it has no DOM side effects.
export function validateDocument(document) {
  try { return normalizeActionDocument(document, { maxBytes: MAX_BODY_BYTES }); }
  catch { return bad(); }
}
export function validateWrite(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
    || !Object.hasOwn(value, 'document') || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) bad();
  return { expectedRevision: value.expectedRevision, document: validateDocument(value.document) };
}
