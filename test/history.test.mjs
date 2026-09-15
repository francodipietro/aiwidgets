import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_RETENTION_DAYS,
  MAX_POINTS_PER_QUOTA,
  forgetProviderHistory,
  historySampleCount,
  minMax,
  normaliseHistory,
  pruneHistory,
  recordHistorySamples,
  setRetentionDays,
  sparklineGeometry,
} from '../src/history.mjs';

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse('2026-09-11T12:00:00Z');

const profile = (session, enabled = ['claude']) => ({
  settings: { enabledProviders: enabled },
  providers: [
    { id: 'claude', name: 'Claude', session, weekly: null },
    { id: 'codex', name: 'Codex', session: null, weekly: null },
    { id: 'copilot', name: 'GitHub Copilot', monthly: null, actionsMinutes: null },
  ],
});

test('a malformed or missing history normalises to the default retention and no samples', () => {
  assert.deepEqual(normaliseHistory(undefined), { retentionDays: DEFAULT_RETENTION_DAYS, samples: {} });
  assert.equal(normaliseHistory({ retentionDays: 45 }).retentionDays, DEFAULT_RETENTION_DAYS, 'una retencion no ofrecida cae al default');
  assert.equal(normaliseHistory({ retentionDays: 7 }).retentionDays, 7);
  assert.deepEqual(normaliseHistory({ samples: { 'claude.session': 'not an array' } }).samples, {});
  assert.deepEqual(normaliseHistory({ samples: { 'claude.session': [{ t: 'x', v: 1 }, { t: 1, v: 2 }] } }).samples['claude.session'], [{ t: 1, v: 2 }], 'descarta puntos invalidos');
});

test('normaliseHistory sorts points by time, even when the stored file is not (BAJA-3/M6 regression)', () => {
  // A hand-edited file, or one merged/restored out of order, must not silently
  // draw a broken chart: quotaPeriodKey-style downstream code and the
  // sparkline both assume the first point is the oldest.
  const out = normaliseHistory({ samples: { 'claude.session': [{ t: NOW, v: 3 }, { t: NOW - 2 * DAY, v: 1 }, { t: NOW - DAY, v: 2 }] } });
  assert.deepEqual(out.samples['claude.session'].map((point) => point.t), [NOW - 2 * DAY, NOW - DAY, NOW]);
});

test('records a sample only when the reading actually changes, and reports whether it did', () => {
  const first = recordHistorySamples({ data: profile({ available: 60, resetLabel: null, resetsAt: null }), history: {}, now: NOW });
  assert.deepEqual(first.history.samples['claude.session'], [{ t: NOW, v: 40 }]);
  assert.equal(first.changed, true);

  const unchanged = recordHistorySamples({ data: profile({ available: 60, resetLabel: null, resetsAt: null }), history: first.history, now: NOW + 60_000 });
  assert.equal(unchanged.history.samples['claude.session'].length, 1, 'la misma lectura no agrega un punto nuevo');
  assert.equal(unchanged.changed, false, 'nada que persistir: el llamador puede saltar la escritura (BAJA-1)');

  const changed = recordHistorySamples({ data: profile({ available: 55, resetLabel: null, resetsAt: null }), history: unchanged.history, now: NOW + 120_000 });
  assert.deepEqual(changed.history.samples['claude.session'], [{ t: NOW, v: 40 }, { t: NOW + 120_000, v: 45 }]);
  assert.equal(changed.changed, true);
});

test('recording also reports changed when pruning removed a point, even with no new reading (BAJA-3/M2 regression)', () => {
  const stale = { retentionDays: 7, samples: { 'claude.weekly': [{ t: NOW - 10 * DAY, v: 20 }] } };
  // Same unchanged value as the (now pruned-away) stored point, so nothing is
  // appended — but the stale point falling out of the 7-day window is itself
  // a real change to persist.
  const result = recordHistorySamples({ data: profile(null, ['claude']), history: stale, now: NOW });
  assert.equal(result.changed, true);
});

test('only records quotas for providers currently enabled', () => {
  const result = recordHistorySamples({ data: profile({ available: 60, resetLabel: null, resetsAt: null }, []), history: {}, now: NOW });
  assert.deepEqual(result.history.samples, {});
  assert.equal(result.changed, false);
});

test('a fractional consumption is kept to one decimal, not raw float noise', () => {
  const data = {
    settings: { enabledProviders: ['copilot'] },
    providers: [{ id: 'copilot', name: 'GitHub Copilot', monthly: { available: 81.666666, resetLabel: null, resetsAt: null }, actionsMinutes: null }],
  };
  const result = recordHistorySamples({ data, history: {}, now: NOW });
  assert.equal(result.history.samples['copilot.monthly'][0].v, 18.3);
});

test('a quota is capped at MAX_POINTS_PER_QUOTA, keeping the most recent readings (MEDIA-2 regression)', () => {
  const points = Array.from({ length: MAX_POINTS_PER_QUOTA }, (_, index) => ({ t: NOW - (MAX_POINTS_PER_QUOTA - index) * 60_000, v: index % 2 }));
  const history = { retentionDays: 90, samples: { 'claude.session': points } };
  // The next reading differs from the last stored one, so it must append —
  // and the cap must drop the oldest point to make room, not grow forever.
  const nextValue = points.at(-1).v === 0 ? 100 : 0;
  const result = recordHistorySamples({ data: profile({ available: 100 - nextValue, resetLabel: null, resetsAt: null }), history, now: NOW });
  assert.equal(result.history.samples['claude.session'].length, MAX_POINTS_PER_QUOTA);
  assert.equal(result.history.samples['claude.session'].at(-1).v, nextValue);
  assert.equal(result.history.samples['claude.session'][0].t, points[1].t, 'se descarto el punto mas viejo, no el mas nuevo');
});

test('changing retention prunes immediately, not only on the next recorded sample', () => {
  const history = { retentionDays: 90, samples: { 'claude.session': [{ t: NOW - 10 * DAY, v: 40 }, { t: NOW - 1 * DAY, v: 50 }] } };
  const shortened = setRetentionDays(history, 7, NOW);
  assert.equal(shortened.retentionDays, 7);
  assert.deepEqual(shortened.samples['claude.session'], [{ t: NOW - 1 * DAY, v: 50 }], 'el punto de hace 10 dias ya no entra en 7 dias de retencion');
});

test('an invalid retention value is ignored, keeping the current one', () => {
  const history = { retentionDays: 30, samples: {} };
  assert.equal(setRetentionDays(history, 45, NOW).retentionDays, 30);
});

test('pruneHistory drops points older than the configured retention and empties out quotas with none left', () => {
  const history = normaliseHistory({
    retentionDays: 7,
    samples: {
      'claude.session': [{ t: NOW - 10 * DAY, v: 40 }],
      'claude.weekly': [{ t: NOW - 1 * DAY, v: 20 }, { t: NOW, v: 30 }],
    },
  });
  const pruned = pruneHistory(history, NOW);
  assert.equal(pruned.samples['claude.session'], undefined, 'una cuota sin puntos vigentes desaparece, no queda como arreglo vacio');
  assert.equal(pruned.samples['claude.weekly'].length, 2);
});

test('a point exactly on the retention cutoff is kept, not dropped (BAJA-3/M4 regression)', () => {
  const retentionDays = 7;
  const cutoff = NOW - retentionDays * DAY;
  const history = { retentionDays, samples: { 'claude.session': [{ t: cutoff, v: 40 }] } };
  assert.equal(pruneHistory(history, NOW).samples['claude.session'].length, 1, 'el punto justo en el limite todavia entra');
});

test('forgetting a provider drops only its own quotas', () => {
  const history = {
    retentionDays: 30,
    samples: { 'claude.session': [{ t: NOW, v: 40 }], 'codex.weekly': [{ t: NOW, v: 20 }] },
  };
  const forgotten = forgetProviderHistory(history, ['claude']);
  assert.deepEqual(Object.keys(forgotten.samples), ['codex.weekly']);
});

test('historySampleCount adds points across every quota', () => {
  const history = { retentionDays: 30, samples: { a: [{ t: 1, v: 1 }, { t: 2, v: 2 }], b: [{ t: 3, v: 3 }] } };
  assert.equal(historySampleCount(history), 3);
});

test('minMax works past the argument-spread call-stack limit (MEDIA-2 regression)', () => {
  const values = Array.from({ length: 200_000 }, (_, index) => index);
  assert.deepEqual(minMax(values), { min: 0, max: 199_999 });
  assert.throws(() => Math.min(...values), RangeError, 'confirma que el problema que minMax evita es real');
});

test('sparklineGeometry uses a real time axis, not the sample index (BAJA-4 regression)', () => {
  const points = [{ t: NOW, v: 10 }, { t: NOW + 60 * 60_000, v: 20 }, { t: NOW + 2 * 60 * 60_000, v: 30 }, { t: NOW + 2 * 60 * 60_000 + 80 * DAY, v: 40 }];
  const geo = sparklineGeometry(points, { width: 220 });
  const xs = geo.coords.map((point) => Math.round(point.x * 10) / 10);
  // Three points an hour apart bunch together; the fourth, 80 days later,
  // sits far to the right — an index-based axis would space them evenly instead.
  assert.ok(xs[1] - xs[0] < 1, 'una hora de separacion apenas mueve el eje');
  assert.ok(xs[3] - xs[2] > 100, 'un salto de 80 dias sí se nota');
});

test('sparklineGeometry centers a perfectly flat series instead of pinning it to the floor (BAJA-2 regression)', () => {
  const points = [{ t: NOW, v: 95 }, { t: NOW + 60_000, v: 95 }, { t: NOW + 120_000, v: 95 }];
  const geo = sparklineGeometry(points, { height: 44, padY: 7 });
  for (const point of geo.coords) assert.equal(point.y, 22, 'centrado en vez de pegado al piso (height - padY)');
});

test('sparklineGeometry returns null with fewer than two points, and never throws on a single point', () => {
  assert.equal(sparklineGeometry([]), null);
  assert.equal(sparklineGeometry([{ t: NOW, v: 10 }]), null);
});

test('sparklineGeometry downsamples very long histories, always keeping the first and last point', () => {
  const points = Array.from({ length: 5000 }, (_, index) => ({ t: NOW + index * 60_000, v: index % 100 }));
  const geo = sparklineGeometry(points, { maxMarks: 220 });
  assert.equal(geo.coords.length, 220);
  assert.equal(geo.coords[0].t, points[0].t);
  assert.equal(geo.coords.at(-1).t, points.at(-1).t);
  assert.equal(geo.totalCount, 5000, 'el conteo total mostrado en el titulo sigue siendo el real, no el muestreado');
});
