const KEY = 'ascension:scenario-view-transfer:v1';
const PATHS = new Set(['/', '/index.html', '/command-center.html', '/classic.html']);
const MAX_LENGTH = 2048;
const MAX_AGE = 30 * 60 * 1000;

export function scenarioViewDestination(link, currentHref, event = {}) {
  if (!link || event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
    || link.hasAttribute('download') || link.target && link.target !== '_self') return null;
  const current = new URL(currentHref);
  const next = new URL(link.href, current);
  if (next.origin !== current.origin || !PATHS.has(current.pathname) || !PATHS.has(next.pathname)
    || next.pathname === current.pathname && next.search === current.search) return null;
  return next.pathname + next.search;
}

function copyDecisions(decisions) {
  if (!Array.isArray(decisions) || decisions.length < 1 || decisions.length > 5) throw new Error('Некорректное число решений.');
  return decisions.map((decision) => {
    if (!decision || typeof decision.measureId !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(decision.measureId)
      || decision.districtId !== undefined && (typeof decision.districtId !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(decision.districtId))) {
      throw new Error('Некорректное решение.');
    }
    return { measureId: decision.measureId, ...(decision.districtId === undefined ? {} : { districtId: decision.districtId }) };
  });
}

/** One-shot handoff between simulator views; no scores, AI text or cross-city data. */
export function createScenarioViewTransfer({ storage = () => sessionStorage, now = () => Date.now() } = {}) {
  return {
    clear() {
      try {
        const session = storage();
        if (session.getItem(KEY) === null) return '';
        session.removeItem(KEY);
        if (session.getItem(KEY) !== null) throw new Error('Пакет не удалён.');
        return '';
      } catch {
        return 'Не удалось удалить временную копию прежнего плана: она может вернуться после обновления страницы. Текущие решения остаются на экране.';
      }
    },
    save({ destination, decisions, cityId, hasScenarioData }) {
      // An untouched destination page must never overwrite a pending handoff.
      if (!decisions.length || cityId !== 'astana' || hasScenarioData !== true) return false;
      if (!PATHS.has(destination.split('?')[0])) throw new Error('Неизвестный вид симулятора.');
      const payload = JSON.stringify({ version: 1, cityId, destination, createdAt: now(), decisions: copyDecisions(decisions) });
      if (payload.length > MAX_LENGTH) throw new Error('Слишком большой план.');
      const session = storage();
      session.setItem(KEY, payload);
      if (session.getItem(KEY) !== payload) throw new Error('Браузер не сохранил план.');
      return true;
    },
    async restore({ currentHref, cityId, hasScenarioData, applyDecisions }) {
      if (cityId !== 'astana' || hasScenarioData !== true) return { status: 'none' };
      let session, raw, payload, decisions;
      try {
        session = storage();
        raw = session.getItem(KEY);
        if (raw === null) return { status: 'none' };
        if (raw.length > MAX_LENGTH) throw new Error('Слишком большой пакет.');
        payload = JSON.parse(raw);
        if (payload.version !== 1 || payload.cityId !== 'astana' || typeof payload.destination !== 'string'
          || !PATHS.has(payload.destination.split('?')[0]) || !Number.isFinite(payload.createdAt)
          || now() - payload.createdAt < 0 || now() - payload.createdAt > MAX_AGE) throw new Error('Пакет недействителен или устарел.');
        decisions = copyDecisions(payload.decisions);
        const current = new URL(currentHref);
        if (payload.destination !== current.pathname + current.search) return { status: 'none' };
      } catch {
        try { session?.removeItem(KEY); } catch {}
        return { status: 'error', message: 'Не удалось прочитать перенесённый план. Вернитесь к предыдущему виду симулятора или загрузите сохранённый сценарий.' };
      }
      const applied = await applyDecisions(decisions, 'План перенесён из другого вида симулятора. Рассчитайте его заново.');
      // Keep the handoff on a failed validation request so reloading can retry.
      if (!applied) return { status: 'rejected' };
      try {
        session.removeItem(KEY);
        if (session.getItem(KEY) !== null) throw new Error('Пакет не удалён.');
      } catch {
        return { status: 'imported', warning: 'План перенесён, но временную копию удалить не удалось. Она может восстановиться при обновлении страницы. Для результата нужен новый расчёт.' };
      }
      return { status: 'imported' };
    },
  };
}
