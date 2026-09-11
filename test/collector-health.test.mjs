import assert from 'node:assert/strict';
import test from 'node:test';
import { normaliseCollector, normaliseCollectorError, providerConnectionHealth, withCollectorAttempt, withCollectorFailure, withCollectorSuccess } from '../src/collector-health.mjs';

const FIRST_SYNC = '2026-09-10T12:00:00.000Z';
const SECOND_SYNC = '2026-09-11T12:00:00.000Z';

test('migrates legacy collector entries from lastSync to connection health fields', () => {
  const collector = normaliseCollector({
    providers: {
      claude: { configured: true, url: 'https://claude.ai/settings/usage', lastSync: FIRST_SYNC, status: 'Updated automatically.' },
      copilot: { configured: true, url: 'https://github.com/settings/billing/premium_requests_usage', lastSync: FIRST_SYNC, status: 'Connected.' },
    },
  });

  assert.equal(collector.providers.claude.lastSuccess, FIRST_SYNC);
  assert.equal(collector.providers.claude.lastSync, FIRST_SYNC);
  assert.equal(collector.providers.claude.lastAttempt, null);
  assert.equal(collector.providers.claude.error, null);
  assert.equal(collector.providers.copilot.premium.lastSuccess, FIRST_SYNC);
  assert.equal(collector.providers.copilot.actions.configured, false);
});

test('records attempts and normalized failures without erasing the last successful refresh', () => {
  const connected = normaliseCollector({
    providers: { codex: { configured: true, lastSync: FIRST_SYNC, status: 'Updated automatically.' } },
  }).providers.codex;
  const attempted = withCollectorAttempt(connected, 'Refreshing usage…', SECOND_SYNC);
  const failed = withCollectorFailure(attempted, new Error('No usage was found yet.'), 'Could not update usage.', SECOND_SYNC);

  assert.equal(failed.lastSuccess, FIRST_SYNC);
  assert.equal(failed.lastAttempt, SECOND_SYNC);
  assert.deepEqual(failed.error, { code: 'usage-unavailable', message: 'No usage was found yet.' });
  assert.equal(failed.status, 'Could not update usage.');
});

test('clears an earlier error only after a successful refresh', () => {
  const failed = withCollectorFailure({}, 'Sign in to continue.', 'Could not update usage.', FIRST_SYNC);
  const succeeded = withCollectorSuccess(failed, 'Updated automatically.', SECOND_SYNC);

  assert.equal(succeeded.lastAttempt, SECOND_SYNC);
  assert.equal(succeeded.lastSuccess, SECOND_SYNC);
  assert.equal(succeeded.lastSync, SECOND_SYNC);
  assert.equal(succeeded.error, null);
});

test('normalizes known connection errors into stable codes', () => {
  assert.deepEqual(normaliseCollectorError('GitHub login is required.'), {
    code: 'sign-in-required',
    message: 'GitHub login is required.',
  });
  assert.deepEqual(normaliseCollectorError('Network timeout.'), {
    code: 'refresh-failed',
    message: 'Network timeout.',
  });
});

test('summarizes fresh, stale, pending, and failed provider health for cards', () => {
  const now = Date.parse('2026-09-11T12:04:00.000Z');
  const collector = normaliseCollector({
    providers: {
      claude: { configured: true, lastSuccess: '2026-09-11T12:03:30.000Z' },
      codex: { configured: true, lastSuccess: '2026-09-11T11:58:00.000Z' },
      copilot: {
        premium: { configured: true, lastSuccess: '2026-09-11T12:03:00.000Z' },
        actions: { configured: true, error: { code: 'refresh-failed', message: 'Network timeout.' } },
      },
    },
  });

  assert.deepEqual(providerConnectionHealth(collector, 'claude', now), { state: 'fresh', message: 'Updated just now' });
  assert.deepEqual(providerConnectionHealth(collector, 'codex', now), { state: 'stale', message: 'Update is stale · Updated 6 min ago' });
  assert.deepEqual(providerConnectionHealth(collector, 'copilot', now), { state: 'error', message: 'Actions minutes: Network timeout.' });
  assert.deepEqual(providerConnectionHealth(normaliseCollector({ providers: { claude: { configured: true } } }), 'claude', now), {
    state: 'pending',
    message: 'Waiting for claude to update.',
  });
});
