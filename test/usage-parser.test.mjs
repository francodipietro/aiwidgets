import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseVisibleUsage } from '../src/usage-parser.mjs';

const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-09-11T10:00:00Z');

test('parses Claude session and weekly quotas from a fixture', async () => {
  const parsed = parseVisibleUsage('claude', await fixture('claude-usage.txt'), 'default', NOW);
  assert.deepEqual(parsed, {
    session: { available: 71, resetLabel: 'Resets in 4 hr 12 min' },
    weekly: { available: 83, resetLabel: 'Resets Wed 4:00 AM' },
    note: 'Synced from Claude with AI Widgets.',
  });
});

test('parses Codex quotas from a fixture', async () => {
  const parsed = parseVisibleUsage('codex', await fixture('codex-usage.txt'), 'default', NOW);
  assert.deepEqual(parsed, {
    session: { available: 76, resetLabel: 'Resets 6:58 PM' },
    weekly: { available: 38, resetLabel: 'Resets Sep 15, 2026 8:25 AM' },
    note: 'Synced from Codex with AI Widgets.',
  });
});

test('parses Copilot premium requests and Actions minutes fixtures', async () => {
  const premium = parseVisibleUsage('copilot', await fixture('copilot-premium.txt'), 'premium', NOW);
  assert.equal(premium.monthly.label, 'Premium requests');
  assert.equal(premium.monthly.used, 55);
  assert.equal(premium.monthly.included, 300);
  assert.equal(premium.monthly.available, 100 - (55 / 300 * 100));

  const actions = parseVisibleUsage('copilot', await fixture('copilot-actions.txt'), 'actions', NOW);
  assert.equal(actions.actionsMinutes.used, 1420.7);
  assert.equal(actions.actionsMinutes.included, 2000);
  assert.equal(actions.actionsMinutes.billedAmount, 12.34);
});

test('accepts the AI credits presentation and rejects incomplete content', () => {
  const credits = parseVisibleUsage('copilot', '120 of 300 AI credits used', 'premium', NOW);
  assert.equal(credits.monthly.label, 'AI credits');
  assert.equal(credits.monthly.available, 60);
  assert.equal(parseVisibleUsage('copilot', 'GitHub billing is loading', 'premium', NOW), null);
});

test('does not show stale absolute reset dates and de-duplicates Claude resets', () => {
  const stale = parseVisibleUsage('codex', '5-hour usage limit 50% available Resets Sep 9, 2026 1:19 AM', 'default', NOW);
  assert.equal(stale.session.resetLabel, null);

  const duplicated = parseVisibleUsage('claude', 'Current session 80% available Resets Sep 15, 2026 8:25 AM Weekly usage limit 60% available Resets Sep 15, 2026 8:25 AM', 'default', NOW);
  assert.equal(duplicated.session.resetLabel, 'Resets Sep 15, 2026 8:25 AM');
  assert.equal(duplicated.weekly.resetLabel, null);
});
