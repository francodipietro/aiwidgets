import { PROVIDER_QUOTAS, quotaConsumption, quotaStateKey } from './alerts.mjs';

export const RETENTION_DAYS_CHOICES = [7, 30, 90];
export const DEFAULT_RETENTION_DAYS = 30;

// Retention bounds growth by time; this bounds it by volume, independent of
// how long the app has been reporting changes. At the fixed one-minute
// refresh cadence a quota that keeps changing could otherwise accumulate
// tens of thousands of points within its retention window — expensive to
// read/write on every cycle, and past a few hundred thousand arguments
// `Math.min(...values)`-style spreads exceed the engine's call-stack limit
// outright. 2,000 points is generous for a sparkline that only has ~220
// pixels to plot into.
export const MAX_POINTS_PER_QUOTA = 2000;

export const DEFAULT_HISTORY = { retentionDays: DEFAULT_RETENTION_DAYS, samples: {} };

export function normaliseHistory(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const retentionDays = Number(input.retentionDays);
  const samples = input.samples && typeof input.samples === 'object' ? input.samples : {};
  return {
    retentionDays: RETENTION_DAYS_CHOICES.includes(retentionDays) ? retentionDays : DEFAULT_RETENTION_DAYS,
    samples: Object.fromEntries(Object.entries(samples)
      .filter(([, points]) => Array.isArray(points))
      .map(([key, points]) => [key, normalisePoints(points)])),
  };
}

function normalisePoints(points) {
  return points
    .filter((point) => point && typeof point === 'object')
    .map((point) => ({ t: Number(point.t), v: Number(point.v) }))
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.v))
    // A hand-edited or externally merged file is not guaranteed to arrive in
    // order, but the sparkline's geometry (and recordHistorySamples' own
    // "last point" comparison) both assume the first point is the oldest and
    // the last is the newest. Out of order input would otherwise draw
    // coordinates outside the chart entirely.
    .sort((a, b) => a.t - b.t);
}

// Number.MAX_SAFE_INTEGER-safe min/max for arrays that can exceed the spread
// operator's call-stack limit (Math.min(...values) fails around 125k items).
export function minMax(values) {
  let min = Infinity, max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

// Samples are dropped once older than the configured retention, applied on
// every write so changing the setting takes effect immediately rather than
// waiting for the file to be touched again — the size and retention of the
// history are meant to be transparent, not eventually-consistent.
export function pruneHistory(history, now = Date.now()) {
  const cutoff = now - history.retentionDays * 24 * 60 * 60_000;
  return {
    ...history,
    samples: Object.fromEntries(Object.entries(history.samples)
      .map(([key, points]) => [key, points.filter((point) => point.t >= cutoff)])
      .filter(([, points]) => points.length > 0)),
  };
}

function totalPoints(history) {
  return Object.values(history.samples).reduce((total, points) => total + points.length, 0);
}

/**
 * Appends one sample per quota whose consumption differs from the last one
 * recorded, so the file only grows with real change instead of with time — a
 * quota that sits still (the app closed, or between two refreshes with the
 * same reading) adds nothing. Only currently visible providers are recorded,
 * matching the same visibility rule alerts already use.
 *
 * Returns `{ history, changed }`: `changed` is false when neither a new point
 * was appended nor retention pruned an existing one, so a caller with nothing
 * to persist can skip the write — matching the `{ data, changed }` shape
 * `withUsageData` already uses in main.js for the same reason.
 */
export function recordHistorySamples({ data, history, now = Date.now() }) {
  const state = normaliseHistory(history);
  const samples = { ...state.samples };
  const providers = Array.isArray(data?.providers) ? data.providers : [];
  const enabledProviders = Array.isArray(data?.settings?.enabledProviders) ? data.settings.enabledProviders : [];
  let appended = false;

  for (const providerId of Object.keys(PROVIDER_QUOTAS)) {
    if (!enabledProviders.includes(providerId)) continue;
    const provider = providers.find((item) => item?.id === providerId);
    if (!provider) continue;
    for (const quota of PROVIDER_QUOTAS[providerId]) {
      const consumption = quotaConsumption(provider[quota.key]);
      if (consumption === null) continue;
      const key = quotaStateKey(providerId, quota.key);
      const points = samples[key] || [];
      const last = points.at(-1);
      const rounded = Math.round(consumption * 10) / 10;
      if (last && last.v === rounded) continue;
      samples[key] = [...points, { t: now, v: rounded }].slice(-MAX_POINTS_PER_QUOTA);
      appended = true;
    }
  }
  const beforePrune = totalPoints({ ...state, samples });
  const pruned = pruneHistory({ ...state, samples }, now);
  const changed = appended || totalPoints(pruned) !== beforePrune;
  return { history: pruned, changed };
}

// A quota whose usage is deleted (clear-usage disconnect, or a full reset)
// has nothing left to chart, and keeping its old points around would draw a
// trend for an account that is no longer connected.
export function forgetProviderHistory(history, providerIds) {
  const state = normaliseHistory(history);
  const targets = new Set(providerIds);
  return {
    ...state,
    samples: Object.fromEntries(Object.entries(state.samples).filter(([key]) => !targets.has(key.split('.')[0]))),
  };
}

export function setRetentionDays(history, retentionDays, now = Date.now()) {
  const state = normaliseHistory(history);
  const days = RETENTION_DAYS_CHOICES.includes(Number(retentionDays)) ? Number(retentionDays) : state.retentionDays;
  return pruneHistory({ ...state, retentionDays: days }, now);
}

export function historySampleCount(history) {
  return totalPoints(normaliseHistory(history));
}

export const SPARKLINE_MAX_MARKS = 220;

// Evenly samples down to at most `maxMarks` points (always keeping the first
// and last), so a chart with only ~220px to plot into never has to lay out
// more marks than it has pixels for, and so downstream min/max math never
// receives more arguments than a spread call can safely take.
function downsample(points, maxMarks) {
  if (points.length <= maxMarks) return points;
  const step = (points.length - 1) / (maxMarks - 1);
  return Array.from({ length: maxMarks }, (_, index) => points[Math.round(index * step)]);
}

/**
 * The pure geometry behind a quota's trend sparkline: which points to draw,
 * and where. Kept out of the renderer (which cannot be imported by node:test
 * — it touches `document` at module scope) so the one part of this feature
 * with real math — a real time axis, not one point per index; guards against
 * a zero-span axis on either dimension; downsampling — has the same test
 * coverage as everything else in this file. The renderer turns this into SVG
 * markup and nothing more.
 *
 * Returns null when there are fewer than two points to connect.
 */
export function sparklineGeometry(points, { width = 220, height = 44, padX = 6, padY = 7, maxMarks = SPARKLINE_MAX_MARKS } = {}) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const sampled = downsample(points, maxMarks);
  const minT = sampled[0].t, maxT = sampled.at(-1).t;
  const spanT = Math.max(1, maxT - minT);
  const { min: minV, max: maxV } = minMax(sampled.map((point) => point.v));
  const flat = minV === maxV;
  const spanV = flat ? 1 : maxV - minV;
  const x = (t) => padX + ((t - minT) / spanT) * (width - padX * 2);
  // A flat series (every sampled value identical) has no ratio to place on
  // the axis; center it instead of letting it collapse to the axis floor,
  // where it would be visually indistinguishable from a near-zero series.
  const y = (v) => flat ? height / 2 : height - padY - ((v - minV) / spanV) * (height - padY * 2);
  const coords = sampled.map((point) => ({ x: x(point.t), y: y(point.v), t: point.t, v: point.v }));
  return { width, height, padX, padY, coords, last: coords.at(-1), sampledCount: sampled.length, totalCount: points.length };
}
