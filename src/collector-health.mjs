const timestamp = (value) => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

export function normaliseCollectorError(error) {
  if (!error) return null;
  if (typeof error === 'object' && typeof error.code === 'string' && typeof error.message === 'string') {
    return { code: error.code, message: error.message.slice(0, 280) };
  }
  const message = String(error?.message || error).replace(/^Error:\s*/i, '').trim().slice(0, 280);
  if (!message) return null;
  const lower = message.toLowerCase();
  const code = /sign in|signed in|login|auth/.test(lower)
    ? 'sign-in-required'
    : /no .*usage|finish loading|not found|page/.test(lower)
      ? 'usage-unavailable'
      : 'refresh-failed';
  return { code, message };
}

export function normaliseCollectorEntry(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const lastSuccess = timestamp(input.lastSuccess || input.lastSync);
  const status = typeof input.status === 'string' && input.status ? input.status : 'Not connected.';
  // Health fields were introduced after `status`. Preserve meaningful
  // failures from older profiles instead of presenting their last successful
  // sync as merely stale.
  const legacyFailure = input.configured === true && /^(?:could not|sign in|login|required|no .*(?:usage|session|actions|copilot))/i.test(status)
    ? status
    : null;
  return {
    configured: input.configured === true,
    url: typeof input.url === 'string' ? input.url : null,
    lastSync: lastSuccess,
    lastSuccess,
    lastAttempt: timestamp(input.lastAttempt),
    error: normaliseCollectorError(input.error || legacyFailure),
    status,
  };
}

export function defaultCollector() {
  const disconnected = () => normaliseCollectorEntry({});
  return {
    providers: {
      claude: disconnected(),
      codex: disconnected(),
      copilot: { premium: disconnected(), actions: disconnected() },
    },
  };
}

export function normaliseCollector(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const providers = input.providers && typeof input.providers === 'object' ? input.providers : {};
  const copilot = providers.copilot && typeof providers.copilot === 'object' ? providers.copilot : {};
  // Before Copilot gained two sources, its entry represented premium usage.
  const premium = copilot.premium && typeof copilot.premium === 'object' ? copilot.premium : copilot;
  return {
    providers: {
      claude: normaliseCollectorEntry(providers.claude),
      codex: normaliseCollectorEntry(providers.codex),
      copilot: {
        premium: normaliseCollectorEntry(premium),
        actions: normaliseCollectorEntry(copilot.actions),
      },
    },
  };
}

const iso = (value = new Date()) => timestamp(value) || new Date().toISOString();

export function withCollectorAttempt(entry, status, now) {
  return { ...normaliseCollectorEntry(entry), lastAttempt: iso(now), status };
}

export function withCollectorSuccess(entry, status, now) {
  const completedAt = iso(now);
  return {
    ...normaliseCollectorEntry(entry),
    lastAttempt: completedAt,
    lastSuccess: completedAt,
    lastSync: completedAt,
    error: null,
    status,
  };
}

export function withCollectorFailure(entry, error, status, now) {
  return {
    ...normaliseCollectorEntry(entry),
    lastAttempt: iso(now),
    error: normaliseCollectorError(error),
    status,
  };
}

const staleAfterMs = 5 * 60_000;

export function relativeAge(timestamp, now) {
  const elapsed = Math.max(0, now - Date.parse(timestamp));
  if (elapsed < 60_000) return 'just now';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function providerConnectionHealth(collector, providerId, now = Date.now()) {
  const providers = collector?.providers || {};
  const sourceEntries = providerId === 'copilot'
    ? [['Premium requests', providers.copilot?.premium], ['Actions minutes', providers.copilot?.actions]]
    : [[providerId, providers[providerId]]];
  const entries = sourceEntries.map(([source, entry]) => [source, normaliseCollectorEntry(entry)]);
  const failed = entries.find(([, entry]) => entry.error);
  if (failed) {
    const [source, entry] = failed;
    if (entry.error.code === 'sign-in-required') return { state: 'expired', message: 'Session expired · reconnect to update.' };
    if (entry.error.code === 'usage-unavailable') return { state: 'page-changed', message: 'Usage page changed or is unavailable.' };
    return { state: 'error', message: `${source}: ${entry.error.message}` };
  }
  if (entries.every(([, entry]) => !entry.configured)) return { state: 'disconnected', message: 'Not connected yet.' };
  const pending = entries.find(([, entry]) => entry.configured && !entry.lastSuccess);
  if (pending) return { state: 'pending', message: `Waiting for ${pending[0]} to update.` };
  const oldestSuccess = Math.min(...entries.map(([, entry]) => Date.parse(entry.lastSuccess)).filter(Number.isFinite));
  if (!Number.isFinite(oldestSuccess)) return { state: 'pending', message: 'Waiting for the first update.' };
  const age = now - oldestSuccess;
  const message = `Updated ${relativeAge(new Date(oldestSuccess).toISOString(), now)}`;
  return age > staleAfterMs ? { state: 'stale', message: `Update is stale · ${message}` } : { state: 'fresh', message };
}
