import assert from 'node:assert/strict';
import test from 'node:test';
import { createFirstRunData, disconnectUsageData, normaliseUsageData, resetFirstRunData } from '../src/usage-data.mjs';

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

test('disconnecting a provider preserves usage unless deletion is explicitly chosen', () => {
  const source = {
    settings: { enabledProviders: ['claude', 'codex'], onboardingComplete: true },
    providers: [
      { id: 'claude', session: { available: 64 }, weekly: { available: 41 } },
      { id: 'codex', session: { available: 12 }, weekly: { available: 30 } },
    ],
  };

  const kept = disconnectUsageData(source, 'claude');
  const cleared = disconnectUsageData(source, 'claude', true);

  assert.equal(kept.providers.find((provider) => provider.id === 'claude').session.available, 64);
  assert.equal(cleared.providers.find((provider) => provider.id === 'claude').session, null);
  assert.equal(cleared.providers.find((provider) => provider.id === 'codex').session.available, 12);
  assert.equal(cleared.providers.find((provider) => provider.id === 'codex').weekly.available, 30);
  assert.deepEqual(cleared.settings.enabledProviders, ['claude', 'codex']);
});

test('resetting first-time setup clears account selection and optionally stored usage', () => {
  const source = {
    settings: { enabledProviders: ['codex'], onboardingComplete: true },
    providers: [{ id: 'codex', session: { available: 64 }, weekly: { available: 41 } }],
  };

  const kept = resetFirstRunData(source);
  const cleared = resetFirstRunData(source, true);

  assert.deepEqual(kept.settings, { refreshMinutes: 1, enabledProviders: [], onboardingComplete: false });
  assert.equal(kept.providers.find((provider) => provider.id === 'codex').session.available, 64);
  assert.equal(cleared.providers.find((provider) => provider.id === 'codex').session, null);
});
