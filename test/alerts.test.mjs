import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVisibleUsage } from '../src/usage-parser.mjs';
import {
  alertNotification,
  normaliseAlertSettings,
  pendingFailureAlerts,
  pendingUsageAlerts,
  quotaPeriodKey,
  reachedStep,
  settleProviderAlerts,
  silenceFailureAlert,
} from '../src/alerts.mjs';

const MINUTE = 60_000;
const NOW = Date.parse('2026-09-11T12:00:00Z');

const profile = ({ session, weekly, alerts, enabled = ['claude'] }) => ({
  settings: { enabledProviders: enabled, onboardingComplete: true, alerts },
  providers: [
    { id: 'claude', name: 'Claude', session, weekly },
    { id: 'codex', name: 'Codex', session: null, weekly: null },
    { id: 'copilot', name: 'GitHub Copilot', monthly: null, actionsMinutes: null },
  ],
});

const alertsOn = { providers: { claude: { enabled: true } }, failureMinutes: 10 };
// Claude's session label is a live countdown ("Resets in 4 hr 12 min"): it
// never repeats across two refreshes. Any fix that leans on the raw label as
// period identity must be proven against exactly this shape, not a synthetic
// absolute date the parser never actually produces for this quota.
const claudeSessionFixture = () => parseVisibleUsage('claude', 'Current session\n71% available\nResets in 4 hr 12 min', 'default');
const claudeWeeklyFixture = () => parseVisibleUsage('claude', 'Weekly usage limit\n83% available\nResets Wed 4:00 AM', 'default');

test('stays silent until a provider is explicitly opted in', () => {
  const data = profile({ session: { available: 5, resetLabel: null, resetsAt: null }, weekly: { available: 5, resetLabel: null, resetsAt: null } });
  assert.deepEqual(pendingUsageAlerts({ data, alertState: {}, now: NOW }).alerts, []);

  const optedIn = profile({ session: { available: 5, resetLabel: null, resetsAt: null }, weekly: { available: 5, resetLabel: null, resetsAt: null }, alerts: alertsOn });
  assert.equal(pendingUsageAlerts({ data: optedIn, alertState: {}, now: NOW }).alerts.length, 2);
});

test('a malformed or unknown settings block normalises to silent', () => {
  assert.deepEqual(normaliseAlertSettings(undefined).providers.claude, { enabled: false });
  assert.equal(normaliseAlertSettings({ failureMinutes: 7 }).failureMinutes, null);
  assert.equal(normaliseAlertSettings({ failureMinutes: '10' }).failureMinutes, 10);
  assert.equal(normaliseAlertSettings({ providers: { claude: { enabled: 'yes' } } }).providers.claude.enabled, false);
});

test('a DeepSeek low-balance alert is opt-in and only fires once per low-balance episode', () => {
  const data = {
    settings: { enabledProviders: ['deepseek'], alerts: { providers: { deepseek: { enabled: true } }, deepseekLowBalance: 1, failureMinutes: null } },
    providers: [{ id: 'deepseek', name: 'DeepSeek API', balance: { currency: 'USD', totalBalance: 0.5 } }],
  };
  const first = pendingUsageAlerts({ data, alertState: {}, now: NOW });
  assert.equal(first.alerts[0].kind, 'balance');
  const repeat = pendingUsageAlerts({ data, alertState: first.state, now: NOW + MINUTE });
  assert.deepEqual(repeat.alerts, []);
  const restored = pendingUsageAlerts({ data: { ...data, providers: [{ ...data.providers[0], balance: { currency: 'USD', totalBalance: 2 } }] }, alertState: repeat.state, now: NOW + 2 * MINUTE });
  const lowAgain = pendingUsageAlerts({ data, alertState: restored.state, now: NOW + 3 * MINUTE });
  assert.equal(lowAgain.alerts.length, 1);
});

test('announces only the highest step crossed, so a jump is one notification', () => {
  const data = profile({
    session: { available: 20, resetLabel: null, resetsAt: null },
    weekly: { available: 5, resetLabel: null, resetsAt: null }, // 95% consumed: clears 20/40/60/80 at once
    alerts: alertsOn,
  });
  const { alerts } = pendingUsageAlerts({ data, alertState: {}, now: NOW });
  const weekly = alerts.filter((alert) => alert.quotaKey === 'weekly');
  assert.equal(weekly.length, 1);
  assert.equal(weekly[0].step, 80);
  assert.equal(weekly[0].consumption, 95);
});

test('a countdown label that changes on every refresh does not repeat the alert (A1 regression)', () => {
  // Reproduces the real Claude fixture: the same session, refreshed once a
  // minute, with its "Resets in N hr M min" countdown ticking down each time.
  const readings = [
    ['Resets in 4 hr 12 min', 29], // 71% available -> not yet at 75
    ['Resets in 4 hr 11 min', 22], // 78% consumed -> crosses 75
    ['Resets in 4 hr 10 min', 21],
    ['Resets in 4 hr  9 min', 20],
  ];
  let state = {};
  const seen = [];
  for (const [resetLabel, available] of readings) {
    const data = profile({ session: { available, resetLabel, resetsAt: null }, weekly: null, alerts: alertsOn });
    const result = pendingUsageAlerts({ data, alertState: state, now: NOW });
    seen.push(result.alerts.length);
    state = result.state;
  }
  assert.deepEqual(seen, [0, 1, 0, 0], 'un solo aviso pese a que la etiqueta cambia en cada refresco');
});

test('a label the parser blanks out and later restores does not repeat the alert (A2 regression)', () => {
  // Claude's own parser nulls the weekly label when it matches the session
  // one; this must not be misread as the quota rolling over and back.
  const readings = ['Resets Wed 4:00 AM', null, 'Resets Wed 4:00 AM'];
  let state = {};
  const seen = [];
  for (const resetLabel of readings) {
    const data = profile({ session: null, weekly: { available: 15, resetLabel, resetsAt: null }, alerts: alertsOn });
    const result = pendingUsageAlerts({ data, alertState: state, now: NOW });
    seen.push(result.alerts.length);
    state = result.state;
  }
  assert.deepEqual(seen, [1, 0, 0], 'la etiqueta que desaparece y vuelve no reactiva el aviso');
});

test('a single transient dip below the last announced step does not repeat the alert (M1 regression)', () => {
  const reading = (available) => profile({ session: { available, resetLabel: 'Resets in 4 hr 12 min', resetsAt: null }, weekly: null, alerts: alertsOn });
  let state = {};
  const seen = [];
  for (const available of [8, 25, 8]) { // 92% consumed -> 75% consumed (a step boundary, not a reset) -> 92% again
    const result = pendingUsageAlerts({ data: reading(available), alertState: state, now: NOW });
    seen.push(result.alerts.map((alert) => alert.step));
    state = result.state;
  }
  assert.deepEqual(seen, [[90], [], []], 'un dip que no cruza el piso de la escalera no rearma nada');
});

test('a genuine rollover (falling below the lowest step) rearms the ladder for the next real breach', () => {
  const reading = (available) => profile({ session: { available, resetLabel: 'Resets in 4 hr 55 min', resetsAt: null }, weekly: null, alerts: alertsOn });
  let state = { quotas: { 'claude.session': { periodKey: null, lastStep: 90 } }, failures: {} };
  const seen = [];
  for (const available of [97, 20]) { // 3% consumed (real reset, below the 75 floor) -> 80% consumed in the new period
    const result = pendingUsageAlerts({ data: reading(available), alertState: state, now: NOW });
    seen.push(result.alerts.map((alert) => alert.step));
    state = result.state;
  }
  assert.deepEqual(seen, [[], [75]], 'tras un reset real, el proximo cruce de 75 vuelve a avisar');
});

test('missing an unobserved reset (app closed, or the provider failing) still rearms the ladder (MEDIA-1 regression)', () => {
  // Neither resetsAt nor a resolvable date exists for this label shape, and
  // the app never saw a reading below the floor: the only remaining evidence
  // that the window actually rolled over is that far more time passed than
  // the quota's own window normally lasts.
  const reading = (available) => profile({ session: { available, resetLabel: 'Resets in 4 hr 12 min', resetsAt: null }, weekly: null, alerts: alertsOn });
  const eightHoursAgo = NOW - 8 * 60 * MINUTE;
  let state = { quotas: { 'claude.session': { periodKey: null, lastStep: 90, observedAt: eightHoursAgo } }, failures: {} };
  const seen = [];
  for (const available of [20, 15, 10, 5, 0]) { // reobserved already at 80% consumed, climbing to 100%
    const result = pendingUsageAlerts({ data: reading(available), alertState: state, now: NOW });
    seen.push(result.alerts.map((alert) => alert.step));
    state = result.state;
  }
  assert.deepEqual(seen, [[75], [], [90], [], []], 'sin el gap-check esto se queda mudo toda la ventana (bug original)');
});

test('the same missed-reset gap check works for a quota whose label never resolves to any period key (MEDIA-1 regression)', () => {
  // Claude weekly's own label ("Resets Wed 4:00 AM") never resolves and is
  // not a countdown either, so this quota has no periodKey mechanism at all —
  // it depends entirely on the floor and the gap check.
  const reading = (available) => profile({ session: null, weekly: { available, resetLabel: 'Resets Wed 4:00 AM', resetsAt: null }, alerts: alertsOn });
  const nineDaysAgo = NOW - 9 * 24 * 60 * MINUTE;
  let state = { quotas: { 'claude.weekly': { periodKey: null, lastStep: 80, observedAt: nineDaysAgo } }, failures: {} };
  const seen = [];
  for (const available of [55, 40, 25, 10, 0]) { // reobserved already at 45% consumed
    const result = pendingUsageAlerts({ data: reading(available), alertState: state, now: NOW });
    seen.push(result.alerts.map((alert) => alert.step));
    state = result.state;
  }
  assert.deepEqual(seen, [[40], [60], [], [80], [100]], 'sin el gap-check solo suena el 100% final (bug original)');
});

test('a short, ordinary gap between refreshes never triggers the missed-reset signal on its own', () => {
  const reading = (available) => profile({ session: { available, resetLabel: 'Resets in 4 hr 12 min', resetsAt: null }, weekly: null, alerts: alertsOn });
  let state = { quotas: { 'claude.session': { periodKey: null, lastStep: 90, observedAt: NOW - 2 * MINUTE } }, failures: {} };
  const result = pendingUsageAlerts({ data: reading(20), alertState: state, now: NOW }); // still 80% consumed, well past 75/90
  assert.deepEqual(result.alerts, [], 'dos minutos de hueco no es evidencia de reset');
});

test('a resolvable date advancing rearms the ladder across a label that vanishes and returns in between (MEDIA-2 regression)', () => {
  // codex.weekly is the one real fixture whose label resolves to an absolute
  // date. The sequence mirrors what actually happens when a label drops out
  // for one reading and comes back: consumption stays above the floor
  // throughout, so only the resolved-date signal can explain what happens.
  const reading = (available, resetLabel) => ({
    settings: { enabledProviders: ['codex'], onboardingComplete: true, alerts: { providers: { codex: { enabled: true } }, failureMinutes: null } },
    providers: [
      { id: 'claude', name: 'Claude', session: null, weekly: null },
      { id: 'codex', name: 'Codex', session: null, weekly: { available, resetLabel, resetsAt: null } },
      { id: 'copilot', name: 'GitHub Copilot', monthly: null, actionsMinutes: null },
    ],
  });
  let state = {};
  const seen = [];
  for (const [available, resetLabel] of [
    [10, 'Resets Sep 15, 2026 8:25 AM'],  // 90% consumed, known date K1
    [10, null],                            // same 90%, label momentarily missing
    [70, 'Resets Sep 22, 2026 8:25 AM'],  // a week later, K2: the window actually rolled over
    [45, 'Resets Sep 22, 2026 8:25 AM'],  // still K2, consumption grew within the new week
  ]) {
    const result = pendingUsageAlerts({ data: reading(available, resetLabel), alertState: state, now: NOW });
    seen.push(result.alerts.map((alert) => alert.step));
    state = result.state;
  }
  assert.deepEqual(seen, [[80], [], [20], [40]], 'el guard evita perder la identidad de K1 cuando el label falta una vez, y K2 rearma al llegar');
});

test('a resolvable reset date that actually advances rearms the ladder', () => {
  // Codex weekly is the one real fixture whose label resolves to an absolute
  // date, so a genuine advance can also be detected via the date itself.
  const spent = profile({ session: null, weekly: { available: 5, resetLabel: 'Resets Sep 15, 2026 8:25 AM', resetsAt: null }, alerts: { providers: { claude: { enabled: true } }, failureMinutes: null } });
  const first = pendingUsageAlerts({ data: spent, alertState: {}, now: NOW });
  assert.equal(first.alerts.length, 1);

  const nextWeek = profile({ session: null, weekly: { available: 100, resetLabel: 'Resets Sep 22, 2026 8:25 AM', resetsAt: null }, alerts: { providers: { claude: { enabled: true } }, failureMinutes: null } });
  const rearmed = pendingUsageAlerts({ data: nextWeek, alertState: first.state, now: NOW + MINUTE });
  assert.deepEqual(rearmed.alerts, [], 'sin consumo, nada que anunciar todavia');
  assert.equal(rearmed.state.quotas['claude.weekly'].lastStep, 0, 'el avance de fecha ya reseteo la escalera');
});

test('the real Claude fixture parses into the countdown shape the regression test assumes', () => {
  const session = claudeSessionFixture().session;
  assert.equal(session.resetLabel, 'Resets in 4 hr 12 min');
  assert.equal(Number.isFinite(Date.parse(session.resetLabel)), false, 'una cuenta regresiva nunca es una fecha resoluble por Date.parse');
  // Date.parse cannot read it, but the countdown still identifies its period
  // once anchored to a clock (see quotaPeriodKey's own tests for the detail).
  assert.notEqual(quotaPeriodKey(session, NOW), null);

  const weekly = claudeWeeklyFixture().weekly;
  assert.equal(weekly.resetLabel, 'Resets Wed 4:00 AM');
  assert.equal(quotaPeriodKey(weekly, NOW), null, 'un dia+hora sin fecha es ambiguo y no se intenta resolver');
});

test('a provider hidden from the app does not alert', () => {
  const data = profile({ session: { available: 5, resetLabel: null, resetsAt: null }, weekly: { available: 5, resetLabel: null, resetsAt: null }, alerts: alertsOn, enabled: [] });
  assert.deepEqual(pendingUsageAlerts({ data, alertState: {}, now: NOW }).alerts, []);
});

test('quotaPeriodKey resolves a date or an unambiguous countdown, never raw label text otherwise', () => {
  assert.equal(quotaPeriodKey({ resetsAt: '2026-09-18T14:00:00Z' }), '2026-09-18T14:00:00.000Z');
  assert.equal(quotaPeriodKey({ resetLabel: 'Resets Sep 15, 2026 8:25 AM' }), new Date(Date.parse('Sep 15, 2026 8:25 AM')).toISOString());
  // A pure "in N hr M min"/"in N days" countdown carries no ambiguity about
  // which day or which occurrence it means, unlike a bare weekday or clock
  // time — so, unlike those, it is resolved to an absolute (bucketed) instant.
  assert.notEqual(quotaPeriodKey({ resetLabel: 'Resets in 4 hr 12 min' }, NOW), null);
  assert.notEqual(quotaPeriodKey({ resetLabel: 'Resets in 3 days' }, NOW), null);
  // These remain ambiguous on purpose and are never guessed at.
  assert.equal(quotaPeriodKey({ resetLabel: 'Resets Wed 4:00 AM' }), null, 'weekday+hora: podria ser esta semana o la que viene');
  assert.equal(quotaPeriodKey({ resetLabel: 'Resets 6:58 PM' }), null, 'hora sola: podria ser hoy o mañana');
  assert.equal(quotaPeriodKey({ resetLabel: 'Resets on the first day of next month' }), null);
  assert.equal(quotaPeriodKey({ resetLabel: '   ' }), null);
  assert.equal(quotaPeriodKey(null), null);
});

test('a countdown resolves to a stable period across consecutive refreshes, and jumps on a real reset', () => {
  const now = NOW;
  const tick = (minutesFromNow, label) => quotaPeriodKey({ resetLabel: label, resetsAt: null }, now + minutesFromNow * MINUTE);
  // Three refreshes a minute apart, same countdown descending by a minute
  // each time: this is the exact shape that used to re-fire every cycle.
  const first = tick(0, 'Resets in 4 hr 12 min');
  const second = tick(1, 'Resets in 4 hr 11 min');
  const third = tick(2, 'Resets in 4 hr 10 min');
  assert.equal(first, second, 'el jitter de redondeo de un minuto no cambia el periodo');
  assert.equal(second, third);

  // A genuine reset: the window restarts near its full duration again.
  const afterReset = tick(6, 'Resets in 4 hr 58 min');
  assert.notEqual(afterReset, third, 'un reset real salta a un instante muy distinto');
});

test('reachedStep returns the highest rung cleared', () => {
  assert.equal(reachedStep(74, [75, 90]), 0);
  assert.equal(reachedStep(75, [75, 90]), 75);
  assert.equal(reachedStep(100, [20, 40, 60, 80, 100]), 100);
  assert.equal(reachedStep(null, [75, 90]), 0);
});

const failing = (lastSuccess) => ({
  providers: {
    claude: { configured: true, lastSuccess, lastSync: lastSuccess, lastAttempt: null, url: null, status: 'x', error: { code: 'sign-in-required', message: 'Sign in.' } },
    codex: {},
    copilot: { premium: {}, actions: {} },
  },
});

test('a failure alert waits for the configured delay, then repeats at that cadence', () => {
  const data = profile({ session: null, weekly: null, alerts: alertsOn });
  const collector = failing(new Date(NOW - 9 * MINUTE).toISOString());

  const early = pendingFailureAlerts({ data, collector, alertState: {}, now: NOW });
  assert.deepEqual(early.alerts, [], 'nueve minutos todavia no ameritan avisar');

  const due = pendingFailureAlerts({ data, collector, alertState: early.state, now: NOW + 2 * MINUTE });
  assert.equal(due.alerts.length, 1);
  assert.equal(due.alerts[0].providerName, 'Claude');

  const tooSoon = pendingFailureAlerts({ data, collector, alertState: due.state, now: NOW + 5 * MINUTE });
  assert.deepEqual(tooSoon.alerts, [], 'no repite antes del intervalo');

  const repeat = pendingFailureAlerts({ data, collector, alertState: due.state, now: NOW + 13 * MINUTE });
  assert.equal(repeat.alerts.length, 1, 'repite una vez cumplido el intervalo');
});

test('silencing stops the repetition until the provider updates again', () => {
  const data = profile({ session: null, weekly: null, alerts: alertsOn });
  const lastSuccess = new Date(NOW - 30 * MINUTE).toISOString();
  const first = pendingFailureAlerts({ data, collector: failing(lastSuccess), alertState: {}, now: NOW });
  assert.equal(first.alerts.length, 1);

  const silenced = silenceFailureAlert(first.state, 'claude', failing(lastSuccess));
  const quiet = pendingFailureAlerts({ data, collector: failing(lastSuccess), alertState: silenced, now: NOW + 20 * MINUTE });
  assert.deepEqual(quiet.alerts, []);

  // A newer successful refresh makes this a different episode, so the silence
  // no longer applies when it fails again.
  const laterEpisode = failing(new Date(NOW + 25 * MINUTE).toISOString());
  const resumed = pendingFailureAlerts({ data, collector: laterEpisode, alertState: quiet.state, now: NOW + 40 * MINUTE });
  assert.equal(resumed.alerts.length, 1);
});

test('silencing takes effect even before an episode has been recorded yet (M3 regression)', () => {
  // Turning alerts on for a provider that has already been failing for a
  // while: pendingFailureAlerts has not run a cycle yet, so there is no
  // failures[providerId] entry for the click to find.
  const lastSuccess = new Date(NOW - 90 * MINUTE).toISOString();
  const collector = failing(lastSuccess);
  const silencedBeforeAnyEvaluation = silenceFailureAlert({}, 'claude', collector, NOW);

  const data = profile({ session: null, weekly: null, alerts: alertsOn });
  const evaluated = pendingFailureAlerts({ data, collector, alertState: silencedBeforeAnyEvaluation, now: NOW + MINUTE });
  assert.deepEqual(evaluated.alerts, [], 'el silencio ya aplica aunque nunca se haya evaluado antes');
});

test('failure alerts stay off unless a cadence is chosen, and clear on recovery', () => {
  const data = profile({ session: null, weekly: null, alerts: { providers: { claude: { enabled: true } }, failureMinutes: null } });
  const collector = failing(new Date(NOW - 60 * MINUTE).toISOString());
  assert.deepEqual(pendingFailureAlerts({ data, collector, alertState: {}, now: NOW }).alerts, []);

  const on = profile({ session: null, weekly: null, alerts: alertsOn });
  const alerted = pendingFailureAlerts({ data: on, collector, alertState: {}, now: NOW });
  assert.equal(alerted.alerts.length, 1);

  const healthy = { providers: { claude: { configured: true, lastSuccess: new Date(NOW).toISOString(), lastSync: new Date(NOW).toISOString(), error: null, status: 'ok' }, codex: {}, copilot: { premium: {}, actions: {} } } };
  const recovered = pendingFailureAlerts({ data: on, collector: healthy, alertState: alerted.state, now: NOW + MINUTE });
  assert.deepEqual(recovered.alerts, []);
  assert.equal(recovered.state.failures.claude, undefined, 'el episodio resuelto no deja rastro');
});

test('settling after disconnect (usage kept) does not re-announce the frozen reading (M2 regression)', () => {
  const data = profile({ session: { available: 8, resetLabel: 'Resets in 4 hr 12 min', resetsAt: null }, weekly: null, alerts: alertsOn });
  const first = pendingUsageAlerts({ data, alertState: {}, now: NOW });
  assert.deepEqual(first.alerts.map((alert) => alert.step), [90]);

  // Disconnect keeps the same frozen 92%-consumed reading on screen.
  const settled = settleProviderAlerts({ data, alertState: first.state, providerIds: ['claude'], now: NOW + MINUTE });
  const next = pendingUsageAlerts({ data, alertState: settled, now: NOW + 2 * MINUTE });
  assert.deepEqual(next.alerts, [], 'la misma lectura congelada no vuelve a avisar tras el settle');
});

test('settling after a clear-usage disconnect drops the quota entirely, so a reconnect starts fresh', () => {
  const data = profile({ session: { available: 8, resetLabel: 'Resets in 4 hr 12 min', resetsAt: null }, weekly: null, alerts: alertsOn });
  const first = pendingUsageAlerts({ data, alertState: {}, now: NOW });
  assert.equal(first.alerts.length, 1);

  const cleared = profile({ session: null, weekly: null, alerts: alertsOn });
  const settled = settleProviderAlerts({ data: cleared, alertState: first.state, providerIds: ['claude'] });
  assert.equal(settled.quotas['claude.session'], undefined);
});

test('settling always drops the silenced failure episode', () => {
  const state = { quotas: {}, failures: { claude: { episode: 'e', failingSince: NOW, lastNotifiedAt: NOW, silenced: true } } };
  const settled = settleProviderAlerts({ data: profile({ session: null, weekly: null, alerts: alertsOn }), alertState: state, providerIds: ['claude'] });
  assert.equal(settled.failures.claude, undefined);
});

test('settling one provider leaves the others exactly as they were', () => {
  const state = {
    quotas: { 'claude.session': { periodKey: 'p', lastStep: 90, observedAt: NOW }, 'codex.weekly': { periodKey: 'p', lastStep: 40, observedAt: NOW } },
    failures: { claude: { episode: 'e', failingSince: NOW, lastNotifiedAt: NOW, silenced: true }, codex: { episode: 'e2', failingSince: NOW, lastNotifiedAt: null, silenced: false } },
  };
  const data = profile({ session: null, weekly: null, alerts: alertsOn });
  const settled = settleProviderAlerts({ data, alertState: state, providerIds: ['claude'] });
  assert.deepEqual(settled.quotas['codex.weekly'], { periodKey: 'p', lastStep: 40, observedAt: NOW });
  assert.deepEqual(settled.failures.codex, { episode: 'e2', failingSince: NOW, lastNotifiedAt: null, silenced: false });
});

test('a quota label carried on the usage itself overrides the fixed default (B2 regression)', () => {
  const data = {
    settings: { enabledProviders: ['copilot'], onboardingComplete: true, alerts: { providers: { copilot: { enabled: true } }, failureMinutes: null } },
    providers: [{ id: 'copilot', name: 'GitHub Copilot', monthly: { available: 20, label: 'AI credits', resetLabel: null, resetsAt: null }, actionsMinutes: null }],
  };
  const { alerts } = pendingUsageAlerts({ data, alertState: {}, now: NOW });
  assert.equal(alerts[0].quotaLabel, 'AI credits');
});

test('a notification never mangles a provider-supplied label\'s casing (B2/BAJA-2 regression)', () => {
  const { body } = alertNotification({ kind: 'usage', providerName: 'GitHub Copilot', quotaLabel: 'AI credits', consumption: 93 });
  assert.match(body, /AI credits/, 'el label real no debe pasar por toLowerCase()');
});

test('a failure notification never claims an update that never happened (BAJA-3 regression)', () => {
  const data = profile({ session: null, weekly: null, alerts: alertsOn });
  const collector = failing(null); // configured, but never once refreshed successfully
  const first = pendingFailureAlerts({ data, collector, alertState: {}, now: NOW });
  assert.deepEqual(first.alerts, [], 'recien detectado, todavia no cumple el intervalo');

  const { alerts } = pendingFailureAlerts({ data, collector, alertState: first.state, now: NOW + 11 * MINUTE });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].ageLabel, null);
  const { body } = alertNotification(alerts[0]);
  assert.match(body, /never updated successfully/i);
  assert.doesNotMatch(body, /last update was/i);
});
