import assert from 'node:assert/strict';
import test from 'node:test';
import { PROVIDER_SESSION_ORIGINS, isProviderAuthenticationUrl, isProviderOrigin } from '../src/provider-origins.mjs';

const NAVIGATION_ORIGINS = {
  claude: ['https://claude.ai', 'https://www.claude.ai'],
  codex: ['https://chatgpt.com', 'https://auth.openai.com'],
  copilot: ['https://github.com'],
};

test('every provider origin the app navigates to is cleared on disconnect', () => {
  for (const [providerId, origins] of Object.entries(NAVIGATION_ORIGINS)) {
    for (const origin of origins) {
      assert.ok(isProviderOrigin(providerId, origin) || isProviderAuthenticationUrl(providerId, `${origin}/login`));
      assert.ok(PROVIDER_SESSION_ORIGINS[providerId].includes(origin), `${origin} is navigated but not cleared for ${providerId}`);
    }
  }
});

test('provider session clear lists do not overlap', () => {
  const hosts = Object.values(PROVIDER_SESSION_ORIGINS).flat().map((origin) => new URL(origin).hostname);
  assert.equal(new Set(hosts).size, hosts.length);
});
