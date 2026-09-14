import { providerConnectionHealth, relativeAge } from './collector-health.mjs';

// Session quotas refill every few hours, so they only warrant a warning once
// the window is mostly spent. Weekly and monthly quotas are worth following
// as they fill up, because there is no quick recovery from exhausting them.
export const SESSION_STEPS = [75, 90];
export const PERIOD_STEPS = [20, 40, 60, 80, 100];
export const FAILURE_MINUTES_CHOICES = [10, 30, 60];
export const DEFAULT_FAILURE_MINUTES = 10;

const FIVE_HOURS_MS = 5 * 60 * 60_000;
const EIGHT_DAYS_MS = 8 * 24 * 60 * 60_000;
const FIVE_WEEKS_MS = 5 * 7 * 24 * 60 * 60_000;

// nominalMs is how long this quota's window normally lasts, with slack. It
// backs the "gap since we last looked" rollover signal below: an interval
// longer than a window's own duration is on its own good evidence a reset
// happened while nobody was watching, independent of any label.
export const PROVIDER_QUOTAS = {
  claude: [
    { key: 'session', label: 'Session', steps: SESSION_STEPS, nominalMs: FIVE_HOURS_MS },
    { key: 'weekly', label: 'Weekly', steps: PERIOD_STEPS, nominalMs: EIGHT_DAYS_MS },
  ],
  codex: [
    { key: 'session', label: 'Session', steps: SESSION_STEPS, nominalMs: FIVE_HOURS_MS },
    { key: 'weekly', label: 'Weekly', steps: PERIOD_STEPS, nominalMs: EIGHT_DAYS_MS },
  ],
  copilot: [
    { key: 'monthly', label: 'Premium requests', steps: PERIOD_STEPS, nominalMs: FIVE_WEEKS_MS },
    { key: 'actionsMinutes', label: 'Actions minutes', steps: PERIOD_STEPS, nominalMs: FIVE_WEEKS_MS },
  ],
};

const ALERT_PROVIDER_IDS = Object.keys(PROVIDER_QUOTAS);

export const DEFAULT_ALERT_SETTINGS = {
  providers: { claude: { enabled: false }, codex: { enabled: false }, copilot: { enabled: false } },
  failureMinutes: null,
};

export const DEFAULT_ALERT_STATE = { quotas: {}, failures: {} };

export function normaliseAlertSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const providers = input.providers && typeof input.providers === 'object' ? input.providers : {};
  const failureMinutes = Number(input.failureMinutes);
  return {
    providers: Object.fromEntries(ALERT_PROVIDER_IDS.map((id) => [id, { enabled: providers[id]?.enabled === true }])),
    // Anything other than an offered cadence disables the alert, so a hand
    // edited or future value never turns into a surprise notification loop.
    failureMinutes: FAILURE_MINUTES_CHOICES.includes(failureMinutes) ? failureMinutes : null,
  };
}

// Number(null) is 0, which is finite — coercing a genuinely absent timestamp
// this way would silently turn "never notified" into "notified at the epoch".
// It happens to be harmless here (an epoch that old never blocks a new
// alert), but it is not what the field means, so it is normalised precisely.
function finiteOrNull(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normaliseAlertState(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const quotas = input.quotas && typeof input.quotas === 'object' ? input.quotas : {};
  const failures = input.failures && typeof input.failures === 'object' ? input.failures : {};
  const entries = (source, pick) => Object.fromEntries(Object.entries(source)
    .filter(([, value]) => value && typeof value === 'object')
    .map(([key, value]) => [key, pick(value)]));
  return {
    quotas: entries(quotas, (value) => ({
      periodKey: typeof value.periodKey === 'string' ? value.periodKey : null,
      lastStep: Number.isFinite(Number(value.lastStep)) ? Number(value.lastStep) : 0,
      observedAt: finiteOrNull(value.observedAt),
    })),
    failures: entries(failures, (value) => ({
      episode: typeof value.episode === 'string' ? value.episode : null,
      failingSince: finiteOrNull(value.failingSince),
      lastNotifiedAt: finiteOrNull(value.lastNotifiedAt),
      silenced: value.silenced === true,
    })),
  };
}

// Stored usage records how much of the quota is left; alerts are phrased in
// terms of how much has been spent, which is what a threshold refers to.
export function quotaConsumption(usage) {
  const available = Number(usage?.available);
  if (!Number.isFinite(available)) return null;
  return Math.max(0, Math.min(100, 100 - available));
}

export function parseResetLabel(label) {
  return Date.parse(String(label)
    .replace(/^\s*(?:resets?|renews?)\s*(?:on|at)?\s*/i, '')
    .replace(/\s+at\s+/ig, ' '));
}

// The one label shape that is unambiguous relative to right now: "Resets in
// 4 hr 12 min" / "Resets in 3 days". No weekday or bare clock time is parsed
// here — guessing whether "Wed 4:00 AM" or "6:58 PM" is today or already past
// risks computing the wrong instant outright, which is worse than reporting
// none. A pure countdown carries no such ambiguity.
function relativeDurationMs(label) {
  const rest = /^resets?\s+in\s+(.+)$/i.exec(label)?.[1];
  if (!rest) return null;
  const days = Number(/(\d+)\s*days?\b/i.exec(rest)?.[1] || 0);
  const hours = Number(/(\d+)\s*(?:hours?|hrs?)\b/i.exec(rest)?.[1] || 0);
  const minutes = Number(/(\d+)\s*(?:minutes?|mins?)\b/i.exec(rest)?.[1] || 0);
  if (!days && !hours && !minutes) return null;
  return days * 24 * 60 * 60_000 + hours * 60 * 60_000 + minutes * 60_000;
}

// Bucketing absorbs the jitter between two readings of the same countdown: a
// display that only shows whole minutes can round the same instant a minute
// or two either way between one refresh and the next. Ten minutes comfortably
// covers that without blurring across an actual multi-hour window rollover.
const PERIOD_KEY_BUCKET_MS = 10 * 60_000;

// Identifies the reset window a reading belongs to, so a quota alert can fire
// once per window. Only a reading that resolves to an actual instant counts as
// identity: providers mostly expose free text ("Resets in 4 hr 12 min",
// "Resets Wed 4:00 AM") that either changes on every refresh or never changes
// at all, and using that raw text as identity is what let a quota re-announce
// the same step every refresh cycle (a countdown is never the same string
// twice) or lose a known period the moment a provider blanked the label out
// (Claude drops the weekly label when it matches the session one). When
// nothing resolves to a real instant, this returns null and callers fall back
// to noticing the quota's consumption fall, or the time since it was last
// observed, which are the signals that actually survive both failure modes.
export function quotaPeriodKey(usage, now = Date.now()) {
  if (!usage || typeof usage !== 'object') return null;
  const resetsAt = Date.parse(usage.resetsAt || '');
  if (Number.isFinite(resetsAt)) return new Date(resetsAt).toISOString();
  const label = typeof usage.resetLabel === 'string' ? usage.resetLabel.trim() : '';
  if (!label) return null;
  const parsed = parseResetLabel(label);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  const relative = relativeDurationMs(label);
  if (relative === null) return null;
  const bucketed = Math.round((now + relative) / PERIOD_KEY_BUCKET_MS) * PERIOD_KEY_BUCKET_MS;
  return new Date(bucketed).toISOString();
}

export function reachedStep(consumption, steps) {
  if (!Number.isFinite(consumption)) return 0;
  return steps.reduce((highest, step) => consumption >= step ? step : highest, 0);
}

export function quotaStateKey(providerId, quotaKey) {
  return `${providerId}.${quotaKey}`;
}

/**
 * Decides which usage thresholds deserve a notification right now.
 *
 * Only the highest step reached is announced, so a quota that jumps from 15%
 * to 85% between two refreshes produces one notification rather than four.
 *
 * A quota is treated as having rolled over to a fresh period — and its ladder
 * rearmed from zero — on any of three signals: a resolved reset instant that
 * actually advanced; a reading that falls below the quota's own lowest step
 * (a fresh period starts near full quota; a value the ladder has never
 * alerted on cannot, by itself, mean anything reset); or a gap since this
 * quota was last observed longer than its window normally lasts (the app was
 * closed, or the provider was failing, right through an actual reset, so the
 * fall below the floor was never seen at all). Real providers rarely expose a
 * reset date, so that third signal is what keeps most quotas from going silent
 * for an entire period after any interruption. A reading that cannot identify
 * its period at all never erases a period already known, and merely losing
 * that identity is never treated as a rollover on its own.
 */
export function pendingUsageAlerts({ data, alertState, now = Date.now() }) {
  const settings = normaliseAlertSettings(data?.settings?.alerts);
  const state = normaliseAlertState(alertState);
  const quotas = { ...state.quotas };
  const alerts = [];
  const providers = Array.isArray(data?.providers) ? data.providers : [];
  const enabledProviders = Array.isArray(data?.settings?.enabledProviders) ? data.settings.enabledProviders : [];

  for (const providerId of ALERT_PROVIDER_IDS) {
    const provider = providers.find((item) => item?.id === providerId);
    if (!provider) continue;
    // A provider the user removed from view is not observed any more, so it
    // should not keep speaking. Its stored steps stay put for when it returns.
    if (!settings.providers[providerId].enabled || !enabledProviders.includes(providerId)) continue;

    for (const quota of PROVIDER_QUOTAS[providerId]) {
      const key = quotaStateKey(providerId, quota.key);
      const usage = provider[quota.key];
      const consumption = quotaConsumption(usage);
      if (consumption === null) continue;
      const observedPeriodKey = quotaPeriodKey(usage, now);
      const previous = quotas[key] || { periodKey: null, lastStep: 0, observedAt: null };
      const periodAdvanced = observedPeriodKey !== null && previous.periodKey !== null && observedPeriodKey !== previous.periodKey;
      const droppedToFloor = consumption < quota.steps[0];
      const missedTheReset = previous.observedAt !== null && now - previous.observedAt > quota.nominalMs;
      const rolledOver = periodAdvanced || droppedToFloor || missedTheReset;
      const lastStep = rolledOver ? 0 : previous.lastStep;
      const step = reachedStep(consumption, quota.steps);
      if (step > lastStep) {
        alerts.push({
          kind: 'usage',
          providerId,
          providerName: provider.name || providerId,
          quotaKey: quota.key,
          quotaLabel: usage?.label || quota.label,
          step,
          consumption: Math.round(consumption),
        });
      }
      // A reading with no resolvable period never overwrites a period we
      // already knew — only a genuinely identified instant may replace one.
      quotas[key] = { periodKey: observedPeriodKey ?? previous.periodKey, lastStep: Math.max(step, lastStep), observedAt: now };
    }
  }
  return { alerts, state: { ...state, quotas } };
}

// Shared with the renderer so the "Silence" action appears for exactly the
// health states that can produce a failure alert.
export const FAILING_HEALTH_STATES = new Set(['expired', 'page-changed', 'error']);

export function latestProviderSuccess(collector, providerId) {
  const providers = collector?.providers || {};
  const entries = providerId === 'copilot'
    ? [providers.copilot?.premium, providers.copilot?.actions]
    : [providers[providerId]];
  const stamps = entries.map((entry) => entry?.lastSuccess).filter(Boolean).sort();
  return stamps.at(-1) || null;
}

/**
 * Decides which providers should report that refreshing keeps failing.
 *
 * Unlike usage alerts, these repeat on purpose: a broken collector stays
 * broken until someone reconnects it. They repeat at the configured cadence
 * until the provider refreshes successfully or the user silences the episode.
 */
export function pendingFailureAlerts({ data, collector, alertState, now = Date.now() }) {
  const settings = normaliseAlertSettings(data?.settings?.alerts);
  const state = normaliseAlertState(alertState);
  const failures = { ...state.failures };
  const alerts = [];
  const enabledProviders = Array.isArray(data?.settings?.enabledProviders) ? data.settings.enabledProviders : [];
  if (settings.failureMinutes === null) return { alerts, state: { ...state, failures } };
  const interval = settings.failureMinutes * 60_000;

  for (const providerId of ALERT_PROVIDER_IDS) {
    if (!settings.providers[providerId].enabled || !enabledProviders.includes(providerId)) continue;
    const health = providerConnectionHealth(collector, providerId, now);
    if (!FAILING_HEALTH_STATES.has(health.state)) {
      delete failures[providerId];
      continue;
    }
    const lastSuccess = latestProviderSuccess(collector, providerId);
    // The last successful refresh identifies the failing episode: once it
    // moves, this is a new problem and an earlier silence no longer applies.
    const episode = lastSuccess || 'never';
    const previous = failures[providerId];
    const current = previous && previous.episode === episode
      ? previous
      : { episode, failingSince: now, lastNotifiedAt: null, silenced: false };
    failures[providerId] = current;
    if (current.silenced) continue;
    const since = lastSuccess ? Date.parse(lastSuccess) : current.failingSince;
    if (!Number.isFinite(since) || now - since < interval) continue;
    if (current.lastNotifiedAt !== null && now - current.lastNotifiedAt < interval) continue;
    alerts.push({
      kind: 'failure',
      providerId,
      providerName: data?.providers?.find((item) => item?.id === providerId)?.name || providerId,
      message: health.message,
      // No successful refresh ever happened for this episode: `since` is only
      // the moment the app noticed the failure, not an update that occurred.
      ageLabel: lastSuccess ? relativeAge(new Date(since).toISOString(), now) : null,
    });
    failures[providerId] = { ...current, lastNotifiedAt: now };
  }
  return { alerts, state: { ...state, failures } };
}

// Silencing always takes effect immediately, even if pendingFailureAlerts has
// not yet run a cycle to create the episode itself (typical right after
// turning alerts on for a provider that was already failing) — otherwise the
// click would be a silent no-op and the alert would fire anyway on the next
// evaluation. The episode identity mirrors pendingFailureAlerts exactly, so a
// later evaluation recognises this as the same episode and honours the flag.
export function silenceFailureAlert(alertState, providerId, collector, now = Date.now()) {
  const state = normaliseAlertState(alertState);
  const episode = latestProviderSuccess(collector, providerId) || 'never';
  const current = state.failures[providerId];
  const next = current && current.episode === episode
    ? { ...current, silenced: true }
    : { episode, failingSince: now, lastNotifiedAt: null, silenced: true };
  return { ...state, failures: { ...state.failures, [providerId]: next } };
}

// Disconnecting or resetting a provider can hand its card to a different
// account, so its silenced failure episode must not carry over — and a quota
// whose data was cleared must forget its ladder entirely, or the empty state
// keeps a stale periodKey around for nothing. A quota whose reading survives
// (disconnect without deleting usage keeps the last known percentage on
// screen) must not simply forget instead: with lastStep reset to zero, the
// very next evaluation would re-announce the frozen reading as if it were
// new. So this settles that quota's ladder to match the surviving value —
// already at its current step — without ever emitting the alert that a live
// evaluation would produce for the same transition.
export function settleProviderAlerts({ data, alertState, providerIds, now = Date.now() }) {
  const state = normaliseAlertState(alertState);
  const quotas = { ...state.quotas };
  const failures = { ...state.failures };
  const providers = Array.isArray(data?.providers) ? data.providers : [];
  for (const providerId of providerIds) {
    delete failures[providerId];
    const provider = providers.find((item) => item?.id === providerId);
    for (const quota of PROVIDER_QUOTAS[providerId] || []) {
      const key = quotaStateKey(providerId, quota.key);
      const usage = provider?.[quota.key];
      const consumption = quotaConsumption(usage);
      if (consumption === null) { delete quotas[key]; continue; }
      quotas[key] = { periodKey: quotaPeriodKey(usage, now), lastStep: reachedStep(consumption, quota.steps), observedAt: now };
    }
  }
  return { quotas, failures };
}

export function alertNotification(alert) {
  if (alert.kind === 'failure') {
    return {
      title: `${alert.providerName} is not updating`,
      // ageLabel is only present once a successful refresh ever happened;
      // otherwise there is no update to date, and saying so would be false.
      body: `${alert.message}${alert.ageLabel ? ` Last update was ${alert.ageLabel}.` : ' It has never updated successfully.'}`,
    };
  }
  return {
    title: `${alert.providerName} · ${alert.quotaLabel} at ${alert.consumption}%`,
    // quotaLabel can be a provider-supplied name (e.g. "AI credits"); leave
    // its casing alone rather than lowercasing it as if it were always one of
    // the fixed labels this file defines.
    body: `You have used ${alert.consumption}% of your ${alert.quotaLabel} quota.`,
  };
}
