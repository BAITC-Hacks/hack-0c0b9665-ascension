/** Optional UI motion. No requests, model imports, text changes or hidden writes. */
function initializeMotion() {
  if (!Element.prototype.animate || !window.matchMedia || !window.MutationObserver) return;

  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const printing = window.matchMedia('print');
  const byId = (id) => document.getElementById(id);
  const active = new Map();
  const seen = new WeakSet();
  const delays = new WeakMap();
  const durations = new WeakMap();
  const pendingReveals = new Set();
  const jobs = new Set();
  const watches = new Map();
  const watchOptions = new WeakMap();
  const ease = 'cubic-bezier(.2, .75, .25, 1)';
  let frame = 0;

  function available(element) {
    return element?.isConnected && !element.closest('[hidden], [inert]') &&
      element.getClientRects().length > 0;
  }

  function inViewport(element) {
    const rect = element.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight &&
      rect.right > 0 && rect.left < window.innerWidth;
  }

  function cancel(element) {
    const animation = active.get(element);
    active.delete(element);
    animation?.cancel();
  }

  function cancelAll() {
    for (const element of active.keys()) cancel(element);
  }

  function play(element, delay = 0, feedback = false, duration = 450) {
    if (!available(element) || !inViewport(element) || document.hidden ||
      preference.matches || printing.matches || element.contains(document.activeElement)) return;
    cancel(element);
    // No zero-opacity state or persistent fill: even interrupted loading stays readable.
    try {
      const animation = element.animate(feedback
        ? [{ opacity: .72 }, { opacity: 1 }]
        : [{ opacity: .72, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
      { duration: feedback ? 240 : duration, delay, easing: ease, fill: 'backwards' });
      active.set(element, animation);
      const release = () => { if (active.get(element) === animation) active.delete(element); };
      animation.addEventListener('finish', release, { once: true });
      animation.addEventListener('cancel', release, { once: true });
    } catch {
      // Animation is progressive enhancement; the application's DOM is left intact.
    }
  }

  const intersection = window.IntersectionObserver ? new IntersectionObserver((entries) => {
    for (const { target, isIntersecting } of entries) {
      if (!isIntersecting || !available(target)) continue;
      intersection.unobserve(target);
      pendingReveals.delete(target);
      seen.add(target);
      play(target, delays.get(target) ?? 0, false, durations.get(target));
    }
  }, { threshold: .08 }) : null;

  function reveal(element, index = 0, duration = 450) {
    if (!element || seen.has(element)) return;
    delays.set(element, Math.min(index, 3) * 40);
    durations.set(element, duration);
    if (intersection) {
      pendingReveals.add(element);
      intersection.observe(element);
    }
    else if (available(element)) {
      seen.add(element);
      play(element, delays.get(element), false, duration);
    }
  }

  function queue(job) {
    jobs.add(job);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      for (const element of active.keys()) if (!available(element)) cancel(element);
      for (const element of pendingReveals) {
        if (element.isConnected) continue;
        intersection?.unobserve(element);
        pendingReveals.delete(element);
      }
      const pending = [...jobs];
      jobs.clear();
      for (const run of pending) run();
    });
  }

  // Only explicit UI roots are observed. Never observe body, #app's subtree or #city-map.
  // Animations write no DOM attributes, so they cannot trigger these observers recursively.
  const mutations = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target.nodeType === Node.TEXT_NODE ? record.target.parentElement : record.target;
      const callbacks = watches.get(target);
      if (callbacks) for (const job of callbacks) queue(job);
    }
  });

  function watch(element, job, options) {
    if (!element) return;
    if (!watches.has(element)) watches.set(element, new Set());
    watches.get(element).add(job);
    const combined = { ...watchOptions.get(element), ...options };
    watchOptions.set(element, combined);
    mutations.observe(element, combined);
  }

  // Resolve static sections once; callbacks do not rescan the map.
  const sectionGroups = [
    [...(document.querySelector('.hero')?.children ?? [])],
    [...document.querySelectorAll('.overview-card')],
    ['map-section', 'workspace', 'results', 'city'].map((id) => byId(id)?.querySelector('.section-heading')),
    ['.plan-panel', '.table-panel', '#method', '#comparison-panel', '#result-placeholder',
      '#geography-notice'].map((selector) => document.querySelector(selector)),
  ];
  function revealSections() {
    for (const group of sectionGroups) group.forEach((element, index) => reveal(element, index));
  }

  function watchList(id, keyFor) {
    const host = byId(id);
    if (!host) return;
    let previous = new Map();
    const update = () => {
      const current = new Map([...host.children].map((element) => [keyFor(element), element]));
      for (const old of previous.values()) {
        if (old.parentElement === host) continue;
        intersection?.unobserve(old);
        pendingReveals.delete(old);
        cancel(old);
      }
      let index = 0;
      for (const [key, element] of current) {
        const old = previous.get(key);
        // Busy/validation renders replace the nodes; preserve their reveal state by identity.
        if (!old || !seen.has(old)) reveal(element, index++, previous.size ? 280 : 450);
        else seen.add(element);
      }
      previous = current;
    };
    watch(host, update, { childList: true });
    update();
  }

  function revealResult() {
    const result = byId('result-content');
    if (!available(result)) return;
    result.querySelectorAll('.result-grid > *, .result-detail, .ai-panel')
      .forEach((element, index) => reveal(element, index, 280));
  }

  function visibilityChanged() {
    revealSections();
    revealResult();
  }

  watch(byId('app'), visibilityChanged, { attributes: true, attributeFilter: ['hidden'] });
  for (const element of document.querySelectorAll('.model-only, #result-placeholder, #geography-notice')) {
    watch(element, visibilityChanged, { attributes: true, attributeFilter: ['hidden'] });
  }
  watch(byId('result-content'), revealResult, { childList: true, attributes: true, attributeFilter: ['hidden'] });
  watchList('catalog', (element) => element.dataset.measure ?? 'empty');
  watchList('selected-list', (element) => {
    const id = element.querySelector('[data-remove]')?.dataset.remove ?? 'empty';
    return `${id}:${element.querySelector('select')?.value ?? 'city'}`;
  });
  watchList('district-summary', (element) => element.querySelector('h3')?.textContent);

  const metricTargets = new Set();
  const updateMetrics = () => {
    for (const target of metricTargets) play(target, 0, true);
    metricTargets.clear();
  };
  for (const id of ['budget-left', 'decision-count', 'plan-total', 'plan-left']) {
    const element = byId(id);
    if (!element) continue;
    let value = element.textContent;
    watch(element, () => {
      const next = element.textContent;
      if (next === value) return;
      if (value.trim() && value !== '—') {
        metricTargets.add(element.closest('.metric-number') ?? element.parentElement);
        queue(updateMetrics);
      }
      value = next;
    }, { childList: true, characterData: true, subtree: true });
  }

  const focusHost = byId('district-focus');
  let districtName = focusHost?.querySelector('h3')?.textContent;
  watch(focusHost, () => {
    const next = focusHost.querySelector('h3')?.textContent;
    if (next !== districtName) [...focusHost.children].forEach((element, index) => reveal(element, index, 280));
    districtName = next;
  }, { childList: true });

  const cityChanged = () => {
    visibilityChanged();
    play(byId('map-heading'), 0, true);
  };
  const calculated = () => {
    revealResult();
    byId('comparison-panel')?.querySelectorAll('.comparison-slot')
      .forEach((element, index) => reveal(element, index, 280));
  };
  // Support the current window dispatch and a future non-bubbling document dispatch.
  for (const target of [window, document]) {
    target.addEventListener('city:changed', () => queue(cityChanged));
    target.addEventListener('scenario:invalidated', () => queue(visibilityChanged));
    target.addEventListener('scenario:calculated', () => queue(calculated));
  }
  document.addEventListener('focusin', ({ target }) => {
    for (const element of active.keys()) if (element.contains(target)) cancel(element);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelAll(); });
  preference.addEventListener('change', cancelAll);
  printing.addEventListener('change', cancelAll);
  window.addEventListener('beforeprint', cancelAll);
  window.addEventListener('pagehide', cancelAll);
  visibilityChanged();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeMotion, { once: true });
} else {
  initializeMotion();
}
