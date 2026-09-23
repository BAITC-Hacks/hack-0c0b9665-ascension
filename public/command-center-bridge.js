import { mountCommandCenter } from './command-center.js';

/** Connect the map workspace to the existing validated application flow. */
export function mountCommandCenterBridge({ dataset, baseline, map, applyDecisions, calculate,
  getContext, fetcher = globalThis.fetch, eventTarget = window, mount = mountCommandCenter }) {
  const ui = mount({ dataset, baseline, map });
  let epoch = 0;
  let controller;
  let applying = false;
  let destroyed = false;
  let currentTrajectory = null;
  const removers = [];
  const emit = (type, detail) => eventTarget.dispatchEvent(new CustomEvent(type, { detail }));
  const listen = (type, callback) => {
    eventTarget.addEventListener(type, callback);
    removers.push(() => eventTarget.removeEventListener(type, callback));
  };
  const activeCity = () => getContext().hasScenarioData === true;

  function invalidate() {
    epoch++;
    controller?.abort();
    controller = null;
    currentTrajectory = null;
  }

  listen('scenario:invalidated', invalidate);
  listen('scenario:load', invalidate);
  listen('city:changed', invalidate);
  listen('ascension:apply-plan', async (event) => {
    if (destroyed || applying) return;
    if (!activeCity()) {
      emit('ascension:plan-applied', { applied: false, message: 'Вернитесь к учебной модели Астаны.' });
      return;
    }
    const decisions = event.detail?.decisions;
    if (!Array.isArray(decisions) || decisions.length !== 5) {
      emit('ascension:plan-applied', { applied: false, message: 'Для расчёта нужны пять допустимых решений.' });
      return;
    }
    applying = true;
    try {
      const applied = await applyDecisions(structuredClone(decisions), 'План Ascension AI принят.');
      if (destroyed) return;
      if (!applied || !activeCity()) {
        emit('ascension:plan-applied', { applied: false, message: 'План не применён. Проверьте ограничения в конструкторе.' });
        return;
      }
      await calculate();
      if (destroyed) return;
      const context = getContext();
      const calculated = context.resultValid === true && activeCity()
        && JSON.stringify(context.decisions) === JSON.stringify(decisions);
      emit('ascension:plan-applied', { applied: calculated,
        message: calculated ? 'Сценарий рассчитан. Выберите квартал на шкале времени.' : 'Расчёт не завершён. Повторите его в конструкторе.' });
    } catch {
      if (!destroyed) emit('ascension:plan-applied', { applied: false, message: 'Не удалось применить план. Повторите попытку.' });
    } finally { applying = false; }
  });

  listen('scenario:calculated', async (event) => {
    invalidate();
    if (destroyed || !activeCity()) return;
    const scenario = event.detail?.scenario;
    if (!Array.isArray(scenario?.decisions)) return;
    const requestEpoch = epoch;
    controller = new AbortController();
    const pending = controller;
    const timeout = setTimeout(() => pending.abort(), 15_000);
    emit('ascension:trajectory-status', { loading: true });
    try {
      const response = await fetcher('/api/trajectory', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisions: scenario.decisions }), signal: pending.signal });
      if (!response.ok) throw new Error('trajectory');
      const trajectory = await response.json();
      if (destroyed || requestEpoch !== epoch || !activeCity()) return;
      if (trajectory.valid !== true || !Array.isArray(trajectory.frames)
        || trajectory.frames.length !== dataset.horizon + 1
        || trajectory.frames.some((frame, index) => frame.quarter !== index || !Number.isFinite(frame.score)
          || !Array.isArray(frame.districts) || frame.districts.length !== dataset.districts.length)) {
        throw new Error('invalid trajectory');
      }
      currentTrajectory = trajectory;
      emit('ascension:trajectory', { trajectory, scenario: structuredClone(scenario) });
      emit('ascension:trajectory-status', { loading: false });
    } catch {
      if (!destroyed && requestEpoch === epoch && activeCity()) emit('ascension:trajectory-status', {
        loading: false, message: 'Динамика временно недоступна. Итоговый расчёт сохранён в результатах.' });
    } finally {
      clearTimeout(timeout);
      if (controller === pending) controller = null;
    }
  });

  listen('ascension:frame', (event) => {
    if (destroyed || !activeCity() || !currentTrajectory) return;
    const quarter = event.detail?.quarter ?? event.detail?.frame?.quarter;
    const frame = currentTrajectory.frames.find((item) => item.quarter === quarter);
    // Only a frame from the latest server calculation can update the map.
    if (frame) map?.setResult(frame.quarter === 0 ? null : frame);
  });

  return { ...ui, destroy() {
    destroyed = true;
    invalidate();
    removers.forEach(remove => remove());
    ui?.destroy?.();
  } };
}
