const CURRENCIES = new Set(['USD', 'CNY']);

function amount(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`DeepSeek returned an invalid ${field}.`);
  return parsed;
}

// The API can theoretically return balances in more than one currency. They
// must not be added together: a single availability bar only has meaning for
// one unit of account, so fail explicitly rather than inventing an exchange
// rate or denominator.
export function parseDeepSeekBalance(payload) {
  const infos = payload?.balance_infos;
  if (!Array.isArray(infos) || infos.length !== 1) throw new Error('DeepSeek returned no single-currency balance.');
  const raw = infos[0] || {};
  const currency = String(raw.currency || '').toUpperCase();
  if (!CURRENCIES.has(currency)) throw new Error('DeepSeek returned an unsupported balance currency.');
  const granted = amount(raw.granted_balance, 'granted balance');
  const toppedUp = amount(raw.topped_up_balance, 'topped-up balance');
  const total = amount(raw.total_balance, 'total balance');
  const included = granted + toppedUp;
  if (total > included + 0.000001) throw new Error('DeepSeek returned a total balance above its granted and topped-up balances.');
  return {
    currency,
    totalBalance: total,
    grantedBalance: granted,
    toppedUpBalance: toppedUp,
    used: 0,
    included: total,
    isAvailable: payload?.is_available === true,
  };
}

// The balance endpoint exposes what remains, not a lifetime invoice total.
// Keep a local funded total and increase it only when the remaining balance
// rises: that is the observable shape of a top-up. A user may set the first
// known funded amount from their account page to include spending before AI
// Widgets was connected.
export function mergeDeepSeekBalance(previous, incoming) {
  if (previous?.currency && previous.currency !== incoming.currency) {
    return { ...incoming, fundedBalance: incoming.totalBalance, included: incoming.totalBalance, used: 0 };
  }
  const previousTotal = Number(previous?.totalBalance);
  const previousFunded = Number(previous?.fundedBalance);
  const baseline = Number.isFinite(previousFunded) && previousFunded >= previousTotal
    ? previousFunded
    : Number.isFinite(previousTotal) ? previousTotal : incoming.totalBalance;
  const topUp = Number.isFinite(previousTotal) ? Math.max(0, incoming.totalBalance - previousTotal) : 0;
  const fundedBalance = baseline + topUp;
  const roundedFunded = Math.round(fundedBalance * 1_000_000) / 1_000_000;
  return { ...incoming, fundedBalance: roundedFunded, included: roundedFunded, used: Math.round(Math.max(0, roundedFunded - incoming.totalBalance) * 1_000_000) / 1_000_000 };
}
