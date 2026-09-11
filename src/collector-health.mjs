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
  return {
    configured: input.configured === true,
    url: typeof input.url === 'string' ? input.url : null,
    lastSync: lastSuccess,
    lastSuccess,
    lastAttempt: timestamp(input.lastAttempt),
    error: normaliseCollectorError(input.error),
    status: typeof input.status === 'string' && input.status ? input.status : 'Not connected.',
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
