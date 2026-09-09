import electron from 'electron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const { app, BrowserWindow, ipcMain, screen } = electron;
const execFileAsync = promisify(execFile);
const APP_NAME = 'AI Widgets';
const DATA_FILE = 'usage.json';
const COLLECTOR_FILE = 'subscription-collector.json';
const RUNTIME_FILE = 'runtime.json';
const COLLECTOR_PARTITION = 'persist:aiwidgets-subscriptions';
const PROVIDERS = {
  codex: { name: 'Codex', startUrl: 'https://chatgpt.com/codex/settings/usage' },
  claude: { name: 'Claude', startUrl: 'https://claude.ai/settings' },
  copilot: {
    name: 'GitHub Copilot',
    startUrl: 'https://github.com/settings/billing',
    startUrls: {
      premium: 'https://github.com/settings/billing/premium_requests_usage',
      actions: 'https://github.com/settings/billing',
    },
  }
};
const DEFAULT_DATA = {
  settings: { refreshMinutes: 1, enabledProviders: ['claude', 'codex'] },
  providers: [
    { id: 'claude', name: 'Claude', accent: '#f2ae93', session: null, weekly: null, note: 'Not connected yet.' },
    { id: 'codex', name: 'Codex', accent: '#c9ddff', session: null, weekly: null, note: 'Not connected yet.' },
    { id: 'copilot', name: 'GitHub Copilot', accent: '#b8c0cc', monthly: null, actionsMinutes: null, note: 'Not connected yet.' }
  ]
};

// GitHub's Billing API returns Actions costs per runner SKU. The dashboard's
// included-minutes meter uses Linux-equivalent minutes, whose published base
// rate is $0.006/minute. Premium requests are an annual Copilot Pro allowance
// for this account; the REST report exposes usage but not that entitlement.
const ACTIONS_LINUX_MINUTE_RATE = 0.006;
const ACTIONS_INCLUDED_BY_GITHUB_PLAN = { free: 2000, pro: 3000 };
const COPILOT_PREMIUM_INCLUDED = 300;

let windowRef;
let quitting = false;
// Launching the application from the desktop menu should show its settings.
// Closing that window leaves the background collector running; the GNOME
// extension remains the separate compact usage view in the top panel.
let openSettingsOnStart = true;
const providerWindows = new Map();
const quitRequested = process.argv.includes('--quit');

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_event, commandLine) => {
  if (commandLine.includes('--quit')) {
    requestQuit();
    return;
  }
  showControlCenter();
});

function dataPath() { return path.join(app.getPath('userData'), DATA_FILE); }
function collectorPath() { return path.join(app.getPath('userData'), COLLECTOR_FILE); }
function runtimePath() { return path.join(app.getPath('userData'), RUNTIME_FILE); }

async function fileExists(target) {
  try { await access(target, constants.F_OK); return true; } catch { return false; }
}

async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, target);
}

async function setRuntimeActive(active) {
  await writeJson(runtimePath(), { active: Boolean(active), updatedAt: new Date().toISOString() });
}

async function requestQuit() {
  if (quitting) return;
  quitting = true;
  await setRuntimeActive(false).catch(() => {});
  app.quit();
}

async function ensureDataFile() {
  const target = dataPath();
  if (!(await fileExists(target))) await writeJson(target, DEFAULT_DATA);
  return target;
}

function defaultCollector() {
  const disconnected = () => ({ configured: false, url: null, lastSync: null, status: 'Not connected.' });
  return {
    providers: {
      claude: disconnected(),
      codex: disconnected(),
      copilot: { premium: disconnected(), actions: disconnected() },
    },
  };
}

async function readCollector() {
  const target = collectorPath();
  let stored = {};
  try { stored = JSON.parse(await readFile(target, 'utf8')); } catch { /* First run. */ }
  const defaults = defaultCollector();
  const storedCopilot = stored.providers?.copilot || {};
  const storedPremium = storedCopilot.premium && typeof storedCopilot.premium === 'object'
    ? storedCopilot.premium
    : storedCopilot;
  const config = {
    providers: {
      claude: { ...defaults.providers.claude, ...(stored.providers?.claude || {}) },
      codex: { ...defaults.providers.codex, ...(stored.providers?.codex || {}) },
      copilot: {
        premium: { ...defaults.providers.copilot.premium, ...storedPremium },
        actions: { ...defaults.providers.copilot.actions, ...(storedCopilot.actions || {}) },
      },
    },
  };
  if (!(await fileExists(target))) await writeJson(target, config);
  return config;
}

async function writeCollector(config) { await writeJson(collectorPath(), config); return config; }

function collectorEntry(config, providerId, source = 'default') {
  return providerId === 'copilot' ? config.providers.copilot[source] : config.providers[providerId];
}

function sourceStartUrl(providerId, source = 'default') {
  return PROVIDERS[providerId].startUrls?.[source] || PROVIDERS[providerId].startUrl;
}

function sourceUrl(providerId, source, entry) {
  if (!entry.url) return sourceStartUrl(providerId, source);
  try {
    const saved = new URL(entry.url);
    // Builds before 0.4.15 stored the generic overview as the Premium source.
    // It has no percentage, so replace that stale configuration automatically.
    if (providerId === 'copilot' && source === 'premium' && saved.pathname === '/settings/billing') return sourceStartUrl(providerId, source);
  } catch { return sourceStartUrl(providerId, source); }
  return entry.url;
}

function normalise(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const rawProviders = Array.isArray(input.providers) ? input.providers : [];
  const providers = DEFAULT_DATA.providers.map((fallback) => {
    const storedProvider = rawProviders.find((item) => item?.id === fallback.id) || fallback;
    // Model names are not consistently available from subscription usage pages.
    // Ignore legacy values rather than presenting an unreliable label.
    const { model: _legacyModel, ...provider } = storedProvider;
    const usage = (value) => {
      if (!value || typeof value !== 'object') return null;
      const available = Number(value.available);
      if (!Number.isFinite(available)) return null;
      const used = Number(value.used);
      const included = Number(value.included);
      const billedAmount = Number(value.billedAmount);
      return {
        available: Math.max(0, Math.min(100, available)),
        resetsAt: value.resetsAt || null,
        resetLabel: value.resetLabel || null,
        ...(Number.isFinite(used) ? { used } : {}),
        ...(Number.isFinite(included) ? { included } : {}),
        ...(Number.isFinite(billedAmount) ? { billedAmount } : {}),
        ...(typeof value.label === 'string' ? { label: value.label } : {}),
      };
    };
    const weekly = usage(provider.weekly);
    const placeholder = provider.note === 'No data yet.' && !provider.session && weekly?.available === 100;
    return { ...fallback, ...provider, accent: fallback.accent, session: usage(provider.session), weekly: placeholder ? null : weekly, monthly: usage(provider.monthly), actionsMinutes: usage(provider.actionsMinutes), note: String(provider.note || '') };
  });
  const requested = input.settings?.enabledProviders;
  const enabledProviders = Array.isArray(requested)
    ? requested.filter((id) => Object.hasOwn(PROVIDERS, id))
    : DEFAULT_DATA.settings.enabledProviders;
  // Refresh cadence is deliberately fixed at one minute. Older local files
  // may still contain five minutes, so do not let them retain that delay.
  return { settings: { ...DEFAULT_DATA.settings, ...(input.settings || {}), refreshMinutes: 1, enabledProviders }, providers, updatedAt: input.updatedAt || null };
}

async function readData() {
  const target = await ensureDataFile();
  try { return normalise(JSON.parse(await readFile(target, 'utf8'))); }
  catch (error) { return { ...normalise(DEFAULT_DATA), error: `Could not read ${target}: ${error.message}` }; }
}

async function saveEnabledProviders(ids) {
  if (!Array.isArray(ids)) throw new Error('Enabled providers must be an array.');
  const data = await readData();
  data.settings.enabledProviders = ids.filter((id) => Object.hasOwn(PROVIDERS, id));
  data.updatedAt = new Date().toISOString();
  await writeJson(await ensureDataFile(), data);
  windowRef?.webContents.send('usage:changed');
  if (data.settings.enabledProviders.includes('copilot')) refreshProvider('copilot').catch(() => {});
  return data;
}

function githubBillingPeriod() {
  const now = new Date();
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

function nextMonthlyResetLabel() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return `Resets ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(next)} at 12:00 AM UTC`;
}

async function githubApi(endpoint) {
  let result;
  try {
    result = await execFileAsync('gh', ['api', '-H', 'X-GitHub-Api-Version: 2026-03-10', endpoint], {
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    const detail = String(error.stderr || error.message || '').trim().replace(/\s+/g, ' ');
    throw new Error(detail || 'GitHub CLI could not read Billing API.');
  }
  try { return JSON.parse(result.stdout); }
  catch { throw new Error('GitHub Billing API returned invalid JSON.'); }
}

function monthlyQuantity(items, product, unitType) {
  return items
    .filter((item) => String(item?.product || '').toLowerCase() === product && String(item?.unitType || '').toLowerCase() === unitType)
    .reduce((sum, item) => sum + Number(item.grossQuantity || 0), 0);
}

function monthlyAmount(items, product, unitType, field) {
  return items
    .filter((item) => String(item?.product || '').toLowerCase() === product && String(item?.unitType || '').toLowerCase() === unitType)
    .reduce((sum, item) => sum + Number(item[field] || 0), 0);
}

async function readGitHubCopilotUsage() {
  const { year, month } = githubBillingPeriod();
  const query = `?year=${year}&month=${month}`;
  const profile = await githubApi('user');
  const login = String(profile?.login || '');
  if (!login) throw new Error('GitHub CLI did not return the authenticated account.');
  const [premiumReport, summary] = await Promise.all([
    githubApi(`users/${encodeURIComponent(login)}/settings/billing/premium_request/usage${query}`),
    githubApi(`users/${encodeURIComponent(login)}/settings/billing/usage/summary${query}`),
  ]);
  return githubCopilotUsageFromReports(profile, premiumReport, summary);
}

function githubCopilotUsageFromReports(profile, premiumReport, summary) {
  const premiumItems = Array.isArray(premiumReport?.usageItems) ? premiumReport.usageItems : [];
  const summaryItems = Array.isArray(summary?.usageItems) ? summary.usageItems : [];
  const premiumUsed = monthlyQuantity(premiumItems, 'copilot', 'requests');
  const githubPlan = String(profile?.plan?.name || '').toLowerCase();
  const actionsIncluded = ACTIONS_INCLUDED_BY_GITHUB_PLAN[githubPlan];
  if (!Number.isFinite(premiumUsed) || !actionsIncluded) {
    throw new Error(`GitHub plan ${githubPlan || 'unknown'} has no configured included-minutes allowance.`);
  }
  const actionsGross = monthlyAmount(summaryItems, 'actions', 'minutes', 'grossAmount');
  const actionsBilled = monthlyAmount(summaryItems, 'actions', 'minutes', 'netAmount');
  const actionsUsed = actionsGross / ACTIONS_LINUX_MINUTE_RATE;
  return {
    monthly: {
      available: Math.max(0, Math.min(100, 100 - (premiumUsed / COPILOT_PREMIUM_INCLUDED * 100))),
      used: premiumUsed,
      included: COPILOT_PREMIUM_INCLUDED,
      label: 'Premium requests',
      resetLabel: nextMonthlyResetLabel(),
    },
    actionsMinutes: {
      available: Math.max(0, Math.min(100, 100 - (actionsUsed / actionsIncluded * 100))),
      used: actionsUsed,
      included: actionsIncluded,
      billedAmount: actionsBilled,
      resetLabel: nextMonthlyResetLabel(),
    },
    plan: githubPlan,
  };
}

async function applyGitHubCopilotUsage() {
  const parsed = await readGitHubCopilotUsage();
  const target = await ensureDataFile();
  const data = await readData();
  const provider = data.providers.find((item) => item.id === 'copilot');
  provider.monthly = parsed.monthly;
  provider.actionsMinutes = parsed.actionsMinutes;
  provider.note = `Synced from GitHub Billing API (GitHub ${parsed.plan === 'free' ? 'Free' : parsed.plan}).`;
  data.updatedAt = new Date().toISOString();
  await writeJson(target, data);
  windowRef?.webContents.send('usage:changed');
  return parsed;
}

const SESSION_LABELS = [/\b5[-\s]*(?:h|hour(?:s)?)\s+usage\s+limit\b/ig, /\bcurrent\s+session\b/ig, /\bsession\s*\(\s*5\s*h(?:r)?\s*\)/ig];
const WEEKLY_LABELS = [/\bweekly\s+(?:usage\s+)?limits?\b/ig, /\bweekly\s*\(\s*7\s*days?\s*\)/ig];
const USAGE_VALUE = /(\d{1,3})\s*%\s*(available|left|remaining|consumed|used)\b/ig;

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

function resetNearValue(text, valueIndex, nextValueIndex) {
  const end = nextValueIndex ?? Math.min(text.length, valueIndex + 700);
  const after = text.slice(valueIndex, end).match(/\b(?:resets?|renews?)\b[^\n.]{0,70}/i)?.[0]?.trim();
  if (after) return after;
  // Some provider layouts put the reset label directly before the percentage.
  // Use it only as a fallback and keep it within the same compact usage block.
  const before = text.slice(Math.max(0, valueIndex - 180), valueIndex);
  const matches = [...before.matchAll(/\b(?:resets?|renews?)\b[^\n.]{0,70}/ig)];
  return matches.at(-1)?.[0]?.trim() || null;
}

function findUsage(text, labels) {
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
  return selected ? { available: selected.available, resetLabel: resetNearValue(text, selected.index, selected.nextIndex) } : null;
}

function parseVisibleUsage(providerId, text, source = 'default') {
  if (providerId === 'copilot') {
    if (source === 'actions') {
      const actionsMinutes = findActionsUsage(text);
      return actionsMinutes ? { actionsMinutes, note: 'Synced Actions minutes from GitHub Copilot billing with AI Widgets.' } : null;
    }
    const premium = findCopilotUsage(text);
    return premium ? { monthly: premium, note: 'Synced Premium requests from GitHub Copilot with AI Widgets.' } : null;
  }
  const session = findUsage(text, SESSION_LABELS);
  const weekly = findUsage(text, WEEKLY_LABELS);
  if (!session && !weekly) return null;
  return { session, weekly, note: `Synced from ${PROVIDERS[providerId].name} with AI Widgets.` };
}

const creditNumber = (value) => Number(String(value).replace(/,/g, ''));

function findCopilotUsage(text) {
  const premiumPercentage = findUsage(text, [/\bpremium\s+requests?\b/ig]);
  if (premiumPercentage) return { ...premiumPercentage, label: 'Premium requests' };
  const premiumPatterns = [
    /(\d[\d,.]*)\s*(?:\/|of)\s*(\d[\d,.]*)\s*(?:premium\s+)?requests?\b/ig,
    /(\d[\d,.]*)\s*(?:premium\s+)?requests?\s+used\s*(?:out\s+of|of)\s*(\d[\d,.]*)/ig,
  ];
  for (const pattern of premiumPatterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const used = creditNumber(match[1]);
    const included = creditNumber(match[2]);
    if (Number.isFinite(used) && Number.isFinite(included) && included > 0 && used >= 0) {
      return { available: Math.max(0, Math.min(100, 100 - (used / included * 100))), resetLabel: 'Resets on the first day of next month', label: 'Premium requests' };
    }
  }
  const patterns = [
    /(\d[\d,.]*)\s*(?:\/|of)\s*(\d[\d,.]*)\s*(?:included\s+)?AI\s+credits?\s+used/ig,
    /(\d[\d,.]*)\s*AI\s+credits?\s+used\s*(?:out\s+of|of)\s*(\d[\d,.]*)/ig,
    /AI\s+credits?\s+used\s*[:\-]?\s*(\d[\d,.]*)\s*(?:\/|of)\s*(\d[\d,.]*)/ig,
    /(?:included\s+)?AI\s+credits?\s*[:\-]?\s*(\d[\d,.]*)\s*(?:\/|of)\s*(\d[\d,.]*)/ig,
    /(\d[\d,.]*)\s*(?:\/|of)\s*(\d[\d,.]*)\s*credits?\b/ig,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const used = creditNumber(match[1]);
    const included = creditNumber(match[2]);
    if (Number.isFinite(used) && Number.isFinite(included) && included > 0 && used >= 0) {
      return { available: Math.max(0, Math.min(100, 100 - (used / included * 100))), resetLabel: 'Resets on the first day of next month', label: 'AI credits' };
    }
  }
  return null;
}

function findActionsUsage(text) {
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
      available: Math.max(0, Math.min(100, 100 - (used / included * 100))),
      used,
      included,
      ...(Number.isFinite(billedAmount) ? { billedAmount } : {}),
      resetLabel: resetNearValue(text, match.index),
    };
  }
  return null;
}

async function applyCollectedUsage(providerId, text, source = 'default') {
  const parsed = parseVisibleUsage(providerId, text, source);
  if (!parsed) return { accepted: false, reason: providerId === 'copilot' && source === 'actions' ? 'No Actions minutes usage was found on the saved page.' : providerId === 'copilot' ? 'No Premium requests usage was found on the saved page.' : 'No session or weekly percentage was found on the saved page.' };
  const target = await ensureDataFile();
  const data = await readData();
  const provider = data.providers.find((item) => item.id === providerId);
  if (parsed.session) provider.session = { available: parsed.session.available, resetsAt: null, resetLabel: parsed.session.resetLabel || null };
  if (parsed.weekly) provider.weekly = { available: parsed.weekly.available, resetsAt: null, resetLabel: parsed.weekly.resetLabel || null };
  if (parsed.monthly) provider.monthly = { available: parsed.monthly.available, resetsAt: null, resetLabel: parsed.monthly.resetLabel || null, label: parsed.monthly.label || provider.monthly?.label || null };
  if (parsed.actionsMinutes) provider.actionsMinutes = parsed.actionsMinutes;
  provider.note = parsed.note;
  data.updatedAt = new Date().toISOString();
  await writeJson(target, data);
  windowRef?.webContents.send('usage:changed');
  return { accepted: true, session: parsed.session?.available ?? null, weekly: parsed.weekly?.available ?? null, monthly: parsed.monthly?.available ?? null };
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function extractSettledUsageText(providerId, webContents, source = 'default') {
  let latest = '';
  // Codex renders the 5-hour card after the weekly card. Poll briefly rather
  // than accepting the partially rendered page from a hidden BrowserWindow.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    latest = await extractUsageText(webContents);
    const parsed = parseVisibleUsage(providerId, latest, source);
    if (providerId === 'copilot' ? source === 'actions' ? parsed?.actionsMinutes : parsed?.monthly : parsed?.session && parsed?.weekly) return latest;
    if (attempt < 4) await delay(1500);
  }
  return latest;
}

function isAllowedUsageUrl(providerId, value) {
  try {
    const url = new URL(value);
    if (providerId === 'codex') return url.hostname === 'chatgpt.com' && (url.pathname.startsWith('/codex') || url.pathname.startsWith('/settings'));
    if (providerId === 'copilot') return url.hostname === 'github.com' && url.pathname.startsWith('/settings/billing');
    return (url.hostname === 'claude.ai' || url.hostname === 'www.claude.ai') &&
      (url.pathname.startsWith('/settings') || url.hash.startsWith('#settings/usage'));
  } catch { return false; }
}

async function selectProviderView(providerId, source, webContents) {
  if (providerId !== 'copilot' || source !== 'actions') return;
  // GitHub renders the product switcher in the billing overview client-side.
  // Selecting Actions after each load makes the saved overview source stable.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const selected = await webContents.executeJavaScript(`(() => {
      const controls = [...document.querySelectorAll('a, button, [role="tab"]')];
      const action = controls.find((element) => element.innerText?.trim() === 'Actions');
      if (!action) return false;
      action.click();
      return true;
    })()`, true).catch(() => false);
    if (selected) { await delay(800); return; }
    await delay(500);
  }
}

function createProviderWindow(providerId, show, source = 'default') {
  const key = `${providerId}:${source}`;
  const existing = providerWindows.get(key);
  if (existing && !existing.isDestroyed()) return existing;
  const win = new BrowserWindow({
    width: 1120, height: 790, show, title: `${APP_NAME} — connect ${PROVIDERS[providerId].name}`, autoHideMenuBar: true,
    webPreferences: { partition: COLLECTOR_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  // OAuth often opens a popup. Navigate the tracked window itself so it is
  // still the window used by “Use current page” after Google redirects.
  win.webContents.setWindowOpenHandler(({ url }) => {
    win.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });
  win.on('close', (event) => {
    if (!quitting) { event.preventDefault(); win.hide(); }
  });
  win.on('closed', () => providerWindows.delete(key));
  providerWindows.set(key, win);
  return win;
}

async function extractUsageText(webContents) {
  return webContents.executeJavaScript(`(() => {
    const lines = (document.body?.innerText || '').split('\\n').map((line) => line.trim()).filter(Boolean);
    const relevant = /\\b(?:\\d{1,3}\\s*%|current\\s+session|weekly\\s+(?:usage\\s+)?limits?|5[-\\s]*(?:h|hour(?:s)?)\\s+usage\\s+limit|AI\\s+credits?|Actions\\s+minutes|included\\s+usage|billable\\s+usage|available|remaining|consumed|used|reset)\\b/i;
    const kept = new Set();
    lines.forEach((line, index) => { if (relevant.test(line)) for (let offset = -3; offset <= 6; offset += 1) if (lines[index + offset]) kept.add(index + offset); });
    return [...kept].sort((a, b) => a - b).map((index) => lines[index]).join('\\n').slice(0, 20000);
  })()`, true);
}

async function setCollectorStatus(providerId, status, lastSync = null, source = 'default') {
  const config = await readCollector();
  const entry = collectorEntry(config, providerId, source);
  entry.status = status;
  if (lastSync) entry.lastSync = lastSync;
  await writeCollector(config);
  return config;
}

async function refreshPageProvider(providerId, source = 'default') {
  const config = await readCollector();
  const entry = collectorEntry(config, providerId, source);
  if (!entry.configured || !entry.url) return config;
  const visible = providerWindows.get(`${providerId}:${source}`);
  if (visible && !visible.isDestroyed() && visible.isVisible()) return config;
  const win = createProviderWindow(providerId, false, source);
  try {
    await win.loadURL(sourceUrl(providerId, source, entry));
    await selectProviderView(providerId, source, win.webContents);
    const result = await applyCollectedUsage(providerId, await extractSettledUsageText(providerId, win.webContents, source), source);
    return setCollectorStatus(providerId, result.accepted ? 'Updated automatically.' : result.reason, result.accepted ? new Date().toISOString() : null, source);
  } catch (error) { return setCollectorStatus(providerId, `Could not update: ${error.message}`, null, source); }
}

async function refreshCopilotProvider() {
  try {
    await applyGitHubCopilotUsage();
    const config = await readCollector();
    const status = 'Updated from GitHub Billing API.';
    for (const source of ['premium', 'actions']) {
      const entry = collectorEntry(config, 'copilot', source);
      entry.status = status;
      entry.lastSync = new Date().toISOString();
    }
    await writeCollector(config);
    return config;
  } catch (error) {
    const config = await readCollector();
    const status = `GitHub Billing API unavailable: ${error.message}`;
    for (const source of ['premium', 'actions']) collectorEntry(config, 'copilot', source).status = status;
    await writeCollector(config);
    return config;
  }
}

async function refreshProvider(providerId, source = 'default') {
  if (providerId === 'copilot') return refreshCopilotProvider();
  return refreshPageProvider(providerId, source);
}

async function refreshAllProviders() {
  const data = await readData();
  await Promise.all(data.settings.enabledProviders.flatMap((providerId) => providerId === 'copilot'
    ? [refreshProvider('copilot')]
    : [refreshProvider(providerId)]));
  return readCollector();
}

async function openProvider(providerId, source = 'default') {
  const config = await readCollector();
  const entry = collectorEntry(config, providerId, source);
  const win = createProviderWindow(providerId, true, source);
  await win.loadURL(sourceUrl(providerId, source, entry));
  await selectProviderView(providerId, source, win.webContents);
  win.show(); win.focus();
  return readCollector();
}

async function saveProviderPage(providerId, source = 'default') {
  const win = providerWindows.get(`${providerId}:${source}`);
  if (!win || win.isDestroyed()) throw new Error(`Click “Open ${PROVIDERS[providerId].name}”, sign in in that window, then return here without closing it.`);
  const url = win.webContents.getURL();
  if (!isAllowedUsageUrl(providerId, url)) {
    const destination = providerId === 'copilot' && source === 'actions' ? 'Settings → Billing → Overview → Actions' : providerId === 'copilot' ? 'Settings → Billing → Premium request analytics' : 'Settings / Usage';
    throw new Error(`The window is still at ${url || 'a blank page'}. Finish signing in and navigate to ${destination} before saving it.`);
  }
  const config = await readCollector();
  const entry = collectorEntry(config, providerId, source);
  Object.assign(entry, { configured: true, url, status: 'Page saved; starting update.' });
  await writeCollector(config);
  // The page is already open and authenticated. Read it in place instead of
  // immediately calling loadURL() again: ChatGPT's usage screen is a SPA and
  // that reload can remain pending while the configuration UI waits for IPC.
  let result;
  try {
    result = await applyCollectedUsage(providerId, await extractSettledUsageText(providerId, win.webContents, source), source);
    entry.status = result.accepted ? 'Page saved and read.' : result.reason;
    entry.lastSync = result.accepted ? new Date().toISOString() : null;
  } catch (error) {
    entry.status = `Page saved; the first read failed: ${error.message}`;
  }
  await writeCollector(config);
  win.hide();
  return config;
}

function createWindow() {
  const display = screen.getPrimaryDisplay(); const { x, y } = display.workArea;
  windowRef = new BrowserWindow({
    // This is the configuration/control window, not the desktop widget. The
    // actual widget is provided by the GNOME Shell extension and sits on the
    // wallpaper. Keep this window hidden until it is explicitly requested.
    width: 940, height: 760, x: x + 34, y: y + 34, show: false,
    title: `${APP_NAME} — settings`, frame: false, transparent: false,
    resizable: false, alwaysOnTop: false, skipTaskbar: false, hasShadow: true, autoHideMenuBar: true,
    webPreferences: { preload: path.join(import.meta.dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  windowRef.loadFile(path.join(import.meta.dirname, 'index.html'));
  windowRef.on('close', (event) => {
    if (!quitting) { event.preventDefault(); windowRef.hide(); }
  });
  windowRef.on('closed', () => { windowRef = undefined; });
}

function showControlCenter() {
  if (!windowRef) createWindow();
  if (windowRef.isMinimized()) windowRef.restore();
  windowRef.setIgnoreMouseEvents(false); windowRef.show(); windowRef.focus();
}

app.whenReady().then(async () => {
  if (quitRequested) {
    await requestQuit();
    return;
  }
  await ensureDataFile(); await readCollector(); await setRuntimeActive(true);
  refreshAllProviders().catch(() => {});
  setInterval(() => { refreshAllProviders(); }, 60_000);
  setInterval(async () => {
    try {
      const runtime = JSON.parse(await readFile(runtimePath(), 'utf8'));
      if (runtime?.active === false) await requestQuit();
    } catch { /* Missing runtime state means active. */ }
  }, 1000);
  app.setLoginItemSettings({ openAtLogin: process.platform !== 'linux' });
  if (openSettingsOnStart) showControlCenter();
});
app.on('before-quit', () => { quitting = true; setRuntimeActive(false).catch(() => {}); });
app.on('activate', showControlCenter);

ipcMain.handle('usage:read', readData);
ipcMain.handle('providers:save-enabled', (_event, ids) => saveEnabledProviders(ids));
ipcMain.handle('collector:info', readCollector);
ipcMain.handle('collector:open', (_event, providerId, source) => PROVIDERS[providerId] ? openProvider(providerId, source) : Promise.reject(new Error('Invalid provider.')));
ipcMain.handle('collector:save-page', (_event, providerId, source) => PROVIDERS[providerId] ? saveProviderPage(providerId, source) : Promise.reject(new Error('Invalid provider.')));
ipcMain.handle('collector:refresh', refreshAllProviders);
ipcMain.handle('window:minimize', () => windowRef?.minimize());
ipcMain.handle('window:close', () => windowRef?.hide());
