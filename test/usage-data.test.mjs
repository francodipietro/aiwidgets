import assert from 'node:assert/strict';
import test from 'node:test';
import { createFirstRunData, normaliseUsageData } from '../src/usage-data.mjs';

test('migrates a pre-onboarding profile without sending it through setup again', () => {
  const migrated = normaliseUsageData({
    settings: { refreshMinutes: 5, enabledProviders: ['claude', 'codex'] },
    providers: [
      { id: 'claude', note: 'Synced from Claude.', session: { available: 73 } },
      { id: 'codex', model: 'legacy', weekly: { available: 46 } },
    ],
    updatedAt: '2026-09-01T12:00:00.000Z',
  });

  assert.deepEqual(migrated.settings, {
    refreshMinutes: 1,
    enabledProviders: ['claude', 'codex'],
    onboardingComplete: true,
  });
  assert.equal(migrated.providers[0].session.available, 73);
  assert.equal(migrated.providers[1].model, undefined);
  assert.equal(migrated.updatedAt, '2026-09-01T12:00:00.000Z');
});

test('creates a new profile with no providers and onboarding pending', () => {
  const created = createFirstRunData();

  assert.deepEqual(created.settings, {
    refreshMinutes: 1,
    enabledProviders: [],
    onboardingComplete: false,
  });
  assert.deepEqual(created.providers.map(({ id }) => id), ['claude', 'codex', 'copilot']);
});

test('keeps explicit onboarding pending and discards invalid provider ids', () => {
  const normalised = normaliseUsageData({
    settings: { onboardingComplete: false, enabledProviders: ['claude', 'unknown', 'claude', 42] },
  });

  assert.equal(normalised.settings.onboardingComplete, false);
  assert.deepEqual(normalised.settings.enabledProviders, ['claude', 'claude']);
});
