const SESSION_LABELS = [
  /\b5[-\s]*(?:h|hour(?:s)?)\s+usage\s+limit\b/ig,
  /\bcurrent\s+session\b/ig,
  /\bsession\s*\(\s*5\s*h(?:r)?\s*\)/ig,
];
const WEEKLY_LABELS = [/\bweekly\s+(?:usage\s+)?limits?\b/ig, /\bweekly\s*\(\s*7\s*days?\s*\)/ig];
const USAGE_VALUE = /(\d{1,3})\s*%\s*(available|left|remaining|consumed|used)\b/ig;
const PROVIDER_NAMES = { claude: 'Claude', codex: 'Codex', copilot: 'GitHub Copilot' };
const RESET_CONTEXT_BOUNDARY = /\s+(?:5[-\s]*(?:h|hour(?:s)?)\s+usage\s+limit|current\s+session|weekly\s+(?:usage\s+)?limits?|weekly\s*\(\s*7\s*days?\s*\)).*$/i;

function closestPrecedingLabel(text, valueIndex, labels) {
  let closest = -1;
  for (const label of labels) {
    const expression = new RegExp(label.source, label.flags.includes('g') ? label.flags : `${label.flags}g`);
    let match;
    while ((match = expression.exec(text))) {
      if (match.index > valueIndex) break;
      if (valueIndex - match.index <= 700) closest = Math.max(closest, match.index);
    }
  }
  return closest;
}

function resetNearValue(text, valueIndex, nextValueIndex, now = Date.now()) {
  const end = nextValueIndex ?? Math.min(text.length, valueIndex + 700);
  const candidates = [];
  const beforeStart = Math.max(0, valueIndex - 300);
  const before = text.slice(beforeStart, valueIndex);
  for (const match of before.matchAll(/\b(?:resets?|renews?)\b[^\n.]{0,70}/ig)) {
    candidates.push({ text: match[0].replace(RESET_CONTEXT_BOUNDARY, '').trim(), distance: valueIndex - (beforeStart + match.index + match[0].length) });
  }
  const after = text.slice(valueIndex, end);
  for (const match of after.matchAll(/\b(?:resets?|renews?)\b[^\n.]{0,70}/ig)) {
    candidates.push({ text: match[0].replace(RESET_CONTEXT_BOUNDARY, '').trim(), distance: match.index });
  }
  const upcoming = candidates.filter((candidate) => {
    const dateText = candidate.text
      .replace(/^\s*(?:resets?|renews?)\s*(?:on|at)?\s*/i, '')
      .replace(/\s+at\s+/ig, ' ');
    const timestamp = Date.parse(dateText);
    return !Number.isFinite(timestamp) || timestamp >= now - 60_000;
  });
  upcoming.sort((a, b) => a.distance - b.distance);
  return upcoming[0]?.text || null;
}

function findUsage(text, labels, now) {
  const values = [...text.matchAll(USAGE_VALUE)].map((match) => ({
    index: match.index,
    available: /^(?:consumed|used)$/i.test(match[2]) ? 100 - Number(match[1]) : Number(match[1]),
  }));
  let selected = null;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value.available < 0 || value.available > 100) continue;
    const labelIndex = closestPrecedingLabel(text, value.index, labels);
    if (labelIndex < 0) continue;
    const distance = value.index - labelIndex;
    if (!selected || distance < selected.distance) selected = { ...value, distance, nextIndex: values[index + 1]?.index };
  }
  return selected ? { available: selected.available, resetLabel: resetNearValue(text, selected.index, selected.nextIndex, now) } : null;
}

const creditNumber = (value) => Number(String(value).replace(/,/g, ''));

function usageFromPatterns(text, patterns, label) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const used = creditNumber(match[1]);
    const included = creditNumber(match[2]);
    if (Number.isFinite(used) && Number.isFinite(included) && included > 0 && used >= 0) {
      return { available: Math.max(0, Math.min(100, 100 - (used / included * 100))), used, included, resetLabel: 'Resets on the first day of next month', label };
    }
  }
  return null;
}

function findCopilotUsage(text, now) {
  const percentage = findUsage(text, [/\bpremium\s+requests?\b/ig], now);
  if (percentage) return { ...percentage, label: 'Premium requests' };
  const premium = usageFromPatterns(text, [
    /(\d[\d,.]*)\s*(?:\/|of)\s*(\d[\d,.]*)\s*(?:premium\s+)?requests?\b/ig,
    /(\d[\d,.]*)\s*(?:premium\s+)?requests?\s+used\s*(?:out\s+of|of)\s*(\d[\d,.]*)/ig,
    /included\s+premium\s+requests?\s+consumed\s*(\d[\d,.]*)\s+of\s*(\d[\d,.]*)\s+included/ig,
  ], 'Premium requests');
  if (premium) return premium;
  return usageFromPatterns(text, [
    /(\d[\d,.]*)\s*(?:\/|of)\s*(\d[\d,.]*)\s*(?:included\s+)?AI\s+credits?\s+used/ig,
    /(\d[\d,.]*)\s*AI\s+credits?\s+used\s*(?:out\s+of|of)\s*(\d[\d,.]*)/ig,
    /AI\s+credits?\s+used\s*[:\-]?\s*(\d[\d,.]*)\s*(?:\/|of)\s*(\d[\d,.]*)/ig,
    /(?:included\s+)?AI\s+credits?\s*[:\-]?\s*(\d[\d,.]*)\s*(?:\/|of)\s*(\d[\d,.]*)/ig,
    /(\d[\d,.]*)\s*(?:\/|of)\s*(\d[\d,.]*)\s*credits?\b/ig,
  ], 'AI credits');
}

function findActionsUsage(text, now) {
  const patterns = [
    /(\d[\d,.]*)\s*(?:min|minutes)\s+used\s*(?:\/|of)\s*(\d[\d,.]*)\s*(?:min|minutes)\s+included/ig,
    /(\d[\d,.]*)\s*(?:\/|of)\s*(\d[\d,.]*)\s*(?:min|minutes)\s+used/ig,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const used = creditNumber(match[1]);
    const included = creditNumber(match[2]);
    if (!Number.isFinite(used) || !Number.isFinite(included) || included <= 0 || used < 0) continue;
    const billed = text.match(/\bbillable\s+usage\s*\$?\s*([\d,.]+)/i);
    const billedAmount = billed ? creditNumber(billed[1]) : null;
    return {
      available: Math.max(0, Math.min(100, 100 - (used / included * 100))), used, included,
      ...(Number.isFinite(billedAmount) ? { billedAmount } : {}), resetLabel: resetNearValue(text, match.index, undefined, now),
    };
  }
  return null;
}

export function parseVisibleUsage(providerId, text, source = 'default', now = Date.now()) {
  if (providerId === 'copilot') {
    if (source === 'actions') {
      const actionsMinutes = findActionsUsage(text, now);
      return actionsMinutes ? { actionsMinutes, note: 'Synced Actions minutes from GitHub billing with AI Widgets.' } : null;
    }
    const monthly = findCopilotUsage(text, now);
    return monthly ? { monthly, note: `Synced ${monthly.label || 'Copilot usage'} from GitHub billing with AI Widgets.` } : null;
  }
  const session = findUsage(text, SESSION_LABELS, now);
  const weekly = findUsage(text, WEEKLY_LABELS, now);
  if (!session && !weekly) return null;
  if (providerId === 'claude' && session?.resetLabel && weekly?.resetLabel && session.resetLabel === weekly.resetLabel) weekly.resetLabel = null;
  return { session, weekly, note: `Synced from ${PROVIDER_NAMES[providerId] || providerId} with AI Widgets.` };
}
