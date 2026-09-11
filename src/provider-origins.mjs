export const PROVIDER_SESSION_ORIGINS = {
  claude: ['https://claude.ai', 'https://www.claude.ai'],
  codex: ['https://chatgpt.com', 'https://auth.openai.com'],
  copilot: ['https://github.com'],
};

export function isProviderOrigin(providerId, value) {
  try {
    const url = new URL(value);
    if (providerId === 'codex') return url.hostname === 'chatgpt.com';
    if (providerId === 'claude') return url.hostname === 'claude.ai' || url.hostname === 'www.claude.ai';
    if (providerId === 'copilot') return url.hostname === 'github.com';
  } catch { /* Invalid URLs are handled by the caller. */ }
  return false;
}

export function isProviderAuthenticationUrl(providerId, value) {
  try {
    const url = new URL(value);
    const pathAndHash = `${url.pathname}${url.hash}`;
    if (providerId === 'codex') return url.hostname === 'auth.openai.com' || /\/(?:auth|login|oauth)(?:\/|$)/i.test(pathAndHash);
    if (providerId === 'claude') return /\/(?:auth|login|oauth)(?:\/|$)/i.test(pathAndHash);
    if (providerId === 'copilot') return url.hostname === 'github.com' && /\/(?:login|sessions?)(?:\/|$)/i.test(url.pathname);
  } catch { /* Invalid URLs are handled by the caller. */ }
  return false;
}
