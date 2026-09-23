function boundedInteger(value, fallback, maximum) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= maximum ? parsed : fallback;
}

/** Process/isolate-local backstop, never a persistent or monetary budget. */
export function createLocalAIGuard({ now = Date.now } = {}) {
  let total = 0;
  let active = 0;
  let recent = [];

  function check(limits = {}) {
    const time = now();
    recent = recent.filter(started => time - started < 60_000);
    if (total >= boundedInteger(limits.maxRequests, 100, 10_000)) return { reason: 'server_request_limit' };
    if (active >= boundedInteger(limits.maxConcurrent, 2, 10)) return { reason: 'server_busy', retryAfter: 5 };
    if (recent.length >= boundedInteger(limits.requestsPerMinute, 10, 120)) {
      return { reason: 'server_rate_limited',
        retryAfter: recent.length ? Math.max(1, Math.ceil((60_000 - time + recent[0]) / 1000)) : 60 };
    }
    return {};
  }

  return {
    check,
    acquire(limits) {
      const denied = check(limits);
      if (denied.reason) return denied;
      total++;
      active++;
      recent.push(now());
      let released = false;
      return { release() {
        if (!released) { released = true; active--; }
      } };
    },
  };
}
