// Server boundary for schema 2. Stored snapshots are user-supplied context, never verified forecasts.
export const MAX_BODY_BYTES = 128 * 1024;
export class WorkspaceError extends Error {
  constructor(status, code, message, extra = {}) { super(message); Object.assign(this, { status, code, extra }); }
}
const bad = () => { throw new WorkspaceError(422, 'INVALID_DOCUMENT', 'Реестр имеет неверную структуру или превышает ограничения.'); };
const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function keys(v, required, optional = []) {
  if (!obj(v) || required.some((k) => !Object.hasOwn(v, k)) || Object.keys(v).some((k) => !required.includes(k) && !optional.includes(k))) bad();
}
function str(v, max = 200) { if (typeof v !== 'string' || v.length > max) bad(); }
function id(v) { if (typeof v !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(v)) bad(); }
function num(v, nonnegative = false) { if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > Number.MAX_SAFE_INTEGER || (nonnegative && v < 0)) bad(); }
function date(v, empty = false) {
  if (empty && v === '') return;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || v.slice(0, 4) === '0000') bad();
  const d = new Date(`${v}T00:00:00Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== v) bad();
}
function timestamp(v) { str(v, 30); if (!/^\d{4}-\d{2}-\d{2}T/.test(v) || !Number.isFinite(Date.parse(v))) bad(); date(v.slice(0, 10)); }
function implementation(v) {
  keys(v, ['siteAddress', 'siteBasis', 'siteSourceUrl', 'kpi', 'budget', 'prerequisites', 'nextStep']);
  for (const [k, max] of Object.entries({ siteAddress: 400, siteBasis: 2000, siteSourceUrl: 1000, prerequisites: 2000, nextStep: 1000 })) str(v[k], max);
  if (v.siteSourceUrl) { try { if (!['http:', 'https:'].includes(new URL(v.siteSourceUrl).protocol)) bad(); } catch { bad(); } }
  keys(v.kpi, ['name', 'unit', 'baseline', 'target', 'source']);
  str(v.kpi.name); str(v.kpi.unit, 80); str(v.kpi.source, 1000);
  for (const k of ['baseline', 'target']) if (v.kpi[k] !== null) num(v.kpi[k]);
  keys(v.budget, ['capexKzt', 'opexKzt', 'estimateSource', 'estimateDate']);
  for (const k of ['capexKzt', 'opexKzt']) if (v.budget[k] !== null) num(v.budget[k], true);
  str(v.budget.estimateSource, 1000); date(v.budget.estimateDate, true);
}
export function validateDocument(document) {
  keys(document, ['schemaVersion', 'registers']);
  if (document.schemaVersion !== 2 || !Array.isArray(document.registers) || document.registers.length > 10) bad();
  const ids = new Set(), sourceKeys = new Set();
  for (const entry of document.registers) {
    keys(entry, ['id', 'sourceKey', 'createdAt', 'source', 'actions']);
    id(entry.id); timestamp(entry.createdAt); str(entry.sourceKey, 2000);
    if (ids.has(entry.id) || sourceKeys.has(entry.sourceKey)) bad();
    ids.add(entry.id); sourceKeys.add(entry.sourceKey);
    const s = entry.source;
    keys(s, ['city', 'scenario', 'result', 'calculatedAt', 'labels']);
    keys(s.city, ['id', 'name']); id(s.city.id); str(s.city.name); timestamp(s.calculatedAt);
    keys(s.scenario, ['decisions']);
    const decisions = s.scenario.decisions;
    if (!Array.isArray(decisions) || decisions.length !== 5 || !Array.isArray(s.labels) || s.labels.length !== 5 || !Array.isArray(entry.actions) || entry.actions.length !== 5) bad();
    const measures = new Set(), actionIds = new Set();
    keys(s.result, ['valid', 'score', 'totalCost', 'remainingBudget', 'criticalCount']);
    if (s.result.valid !== true) bad();
    num(s.result.score); num(s.result.totalCost, true); num(s.result.remainingBudget, true); num(s.result.criticalCount, true);
    if (!Number.isInteger(s.result.criticalCount)) bad();
    decisions.forEach((d, i) => {
      keys(d, ['measureId'], ['districtId']); id(d.measureId); if (d.districtId !== undefined) id(d.districtId);
      if (measures.has(d.measureId)) bad(); measures.add(d.measureId);
      const label = s.labels[i], a = entry.actions[i];
      keys(label, ['measureId', 'measureName', 'districtName'], ['districtId']);
      str(label.measureName); str(label.districtName);
      keys(a, ['id', 'measureId', 'measureName', 'districtName', 'owner', 'dueDate', 'criterion', 'status', 'evidence', 'implementation'], ['districtId']);
      id(a.id); if (actionIds.has(a.id)) bad(); actionIds.add(a.id);
      if (label.measureId !== d.measureId || label.districtId !== d.districtId || a.measureId !== d.measureId || a.districtId !== d.districtId || a.measureName !== label.measureName || a.districtName !== label.districtName) bad();
      str(a.owner, 160); date(a.dueDate, true); str(a.criterion, 2000); str(a.evidence, 2000);
      if (!['draft', 'in_progress', 'completed', 'deferred'].includes(a.status)) bad();
      if (['in_progress', 'completed'].includes(a.status) && (!a.owner.trim() || !a.dueDate)) bad();
      if (a.status === 'completed' && !a.evidence.trim()) bad();
      implementation(a.implementation);
    });
    const expectedKey = JSON.stringify([s.city.id, decisions.map(({ measureId, districtId }) => [measureId, districtId ?? null]).sort((a, b) => a[0].localeCompare(b[0]))]);
    if (entry.sourceKey !== expectedKey) bad();
  }
  const serialized = JSON.stringify(document);
  if (new TextEncoder().encode(serialized).byteLength > MAX_BODY_BYTES) bad();
  return JSON.parse(serialized);
}
export function validateWrite(value) {
  keys(value, ['expectedRevision', 'document']);
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) bad();
  return { expectedRevision: value.expectedRevision, document: validateDocument(value.document) };
}
