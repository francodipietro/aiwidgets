import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeDeepSeekBalance, parseDeepSeekBalance } from '../src/deepseek-balance.mjs';
import { fetchDeepSeekBalance } from '../src/deepseek-client.mjs';

test('parses the DeepSeek balance and derives used without treating a top-up as consumption', () => {
  const balance = parseDeepSeekBalance({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '12.50', granted_balance: '2.50', topped_up_balance: '15.00' }] });
  assert.deepEqual(balance, { currency: 'USD', totalBalance: 12.5, grantedBalance: 2.5, toppedUpBalance: 15, used: 0, included: 12.5, isAvailable: true });
  const toppedUp = parseDeepSeekBalance({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '22.50', granted_balance: '2.50', topped_up_balance: '25.00' }] });
  assert.equal(toppedUp.totalBalance, 22.5);
});

test('keeps a locally configured funded total and treats a rising balance as a top-up', () => {
  const first = mergeDeepSeekBalance({ currency: 'USD', totalBalance: 4.93, fundedBalance: 5 }, { currency: 'USD', totalBalance: 4.93, grantedBalance: 0, toppedUpBalance: 4.93, used: 0, included: 4.93, isAvailable: true });
  assert.equal(first.used, 0.07);
  const recharged = mergeDeepSeekBalance(first, { ...first, totalBalance: 9.93, toppedUpBalance: 9.93 });
  assert.equal(recharged.fundedBalance, 10);
  assert.equal(recharged.used, 0.07);
});

test('does not carry a funded baseline across currencies', () => {
  const changed = mergeDeepSeekBalance({ currency: 'USD', totalBalance: 4, fundedBalance: 5 }, { currency: 'CNY', totalBalance: 10, grantedBalance: 0, toppedUpBalance: 10, used: 0, included: 10, isAvailable: true });
  assert.equal(changed.fundedBalance, 10);
  assert.equal(changed.used, 0);
});

test('marks a 401 balance response as an invalid API key without exposing the key', async () => {
  await assert.rejects(
    fetchDeepSeekBalance('secret-key', async (_url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer secret-key');
      return { status: 401, ok: false };
    }),
    (error) => error.code === 'api-key-invalid' && error.message === 'DeepSeek rejected this API key.',
  );
});

test('does not invent a combined balance across currencies or accept impossible totals', () => {
  assert.throws(() => parseDeepSeekBalance({ balance_infos: [{ currency: 'USD', total_balance: '1', granted_balance: '1', topped_up_balance: '0' }, { currency: 'CNY', total_balance: '1', granted_balance: '1', topped_up_balance: '0' }] }), /single-currency/);
  assert.throws(() => parseDeepSeekBalance({ balance_infos: [{ currency: 'USD', total_balance: '2', granted_balance: '1', topped_up_balance: '0' }] }), /above/);
});
