import { parseDeepSeekBalance } from './deepseek-balance.mjs';

export async function fetchDeepSeekBalance(apiKey, fetchImpl = fetch) {
  const response = await fetchImpl('https://api.deepseek.com/user/balance', {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401) {
    const error = new Error('DeepSeek rejected this API key.');
    error.code = 'api-key-invalid';
    throw error;
  }
  if (!response.ok) throw new Error(`DeepSeek API returned ${response.status}.`);
  return parseDeepSeekBalance(await response.json());
}
