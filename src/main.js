import electron from 'electron';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runUsageCli } from './usage-cli.mjs';
import { DEFAULT_DATA, createFirstRunData, normaliseUsageData } from './usage-data.mjs';
import { parseVisibleUsage } from './usage-parser.mjs';

const { app, BrowserWindow, ipcMain, nativeImage, screen, Tray } = electron;
const APP_NAME = 'AI Widgets';
const DATA_FILE = 'usage.json';
const COLLECTOR_FILE = 'subscription-collector.json';
const RUNTIME_FILE = 'runtime.json';
const DESKTOP_LAYOUT_FILE = 'desktop-widget.json';
const HEARTBEAT_FILE = 'collector-heartbeat.json';
const CLI_REFRESH_DIRECTORY = 'usage-refresh';
const CLI_REFRESH_RESPONSE_TTL_MS = 60_000;
const CLI_REFRESH_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COLLECTOR_PARTITION = 'persist:aiwidgets-subscriptions';
const PROVIDERS = {
  codex: { name: 'Codex', startUrl: 'https://chatgpt.com/codex/settings/usage' },
  claude: { name: 'Claude', startUrl: 'https://claude.ai/settings/usage' },
  copilot: {
    name: 'GitHub Copilot',
    // GitHub's login endpoint currently normalizes a nested billing return
    // URL to the Billing overview. The collector redirects from there to the
    // analytics page once the signed-in session is established.
    startUrl: 'https://github.com/login?return_to=%2Fsettings%2Fbilling',
    startUrls: {
      premium: 'https://github.com/settings/billing/premium_requests_usage',
      actions: 'https://github.com/login?return_to=%2Fsettings%2Fbilling',
    },
  },
};
const DEFAULT_DESKTOP_LAYOUT = {
  version: 1,
  x: null,
  y: null,
  cardWidth: 170,
  desktopVisible: true,
  editing: false,
  autoPosition: true,
};
const PROVIDER_IDS = ['claude', 'codex', 'copilot'];
const PAGE_PROVIDER_IDS = ['claude', 'codex', 'copilot'];
const MAC_WIDGET_SPACING = 20;
const MAC_WIDGET_MARGIN = 28;
const MAC_WIDGET_HEIGHT = 286;
const MAC_PANEL_WIDTH = 318;

let windowRef;
let desktopWidgetRef;
let trayPopoverRef;
let trayRef;
let desktopLayout = { ...DEFAULT_DESKTOP_LAYOUT };
let desktopWidgetData = DEFAULT_DATA;
let layoutSaveTimer;
let layoutSaveInFlight = Promise.resolve();
let applyingDesktopBounds = false;
let quitting = false;
let refreshInFlight;
let cliRefreshInFlight = false;
const providerConnectionInFlight = new Set();
const providerRetryTimers = new Map();
// Launching the application from the desktop menu should show its settings.
// Closing that window leaves the background collector running; the GNOME
// extension remains the separate compact usage view in the top panel.
const openSettingsOnStart = !process.argv.includes('--background');
const providerWindows = new Map();
const quitRequested = process.argv.includes('--quit');
const usageCliRequested = process.argv.includes('usage') || process.argv.includes('--usage');

// Keep development first-run tests completely separate from the installed
// application's data and the isolated provider browser sessions.
if (process.env.AIWIDGETS_TEST_USER_DATA) app.setPath('userData', path.resolve(process.env.AIWIDGETS_TEST_USER_DATA));

function clearProviderRetry(key) {
  const timer = providerRetryTimers.get(key);
  if (timer) clearTimeout(timer);
  providerRetryTimers.delete(key);
}

function scheduleProviderRetry(key, callback) {
  if (providerRetryTimers.has(key)) return;
  const timer = setTimeout(() => {
    providerRetryTimers.delete(key);
    callback().catch(() => {});
  }, 3000);
  providerRetryTimers.set(key, timer);
}

// The usage command only extracts text from hidden pages. Disable unused GPU
// paths so a terminal invocation does not emit VA-API/WebGL diagnostics.
if (usageCliRequested) {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-webgl');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  app.commandLine.appendSwitch('disable-accelerated-video-decode');
  app.commandLine.appendSwitch('disable-features', 'VaapiVideoDecoder,VaapiVideoEncoder');
}

if (!usageCliRequested) {
  if (!app.requestSingleInstanceLock()) app.quit();
  app.on('second-instance', (_event, commandLine) => {
    if (commandLine.includes('--quit')) {
      requestQuit();
      return;
    }
    showControlCenter();
  });
}

function dataPath() { return path.join(app.getPath('userData'), DATA_FILE); }
function collectorPath() { return path.join(app.getPath('userData'), COLLECTOR_FILE); }
function runtimePath() { return path.join(app.getPath('userData'), RUNTIME_FILE); }
function heartbeatPath() { return path.join(app.getPath('userData'), HEARTBEAT_FILE); }
function cliRefreshRequestDirectory() { return path.join(app.getPath('userData'), CLI_REFRESH_DIRECTORY, 'requests'); }
function cliRefreshResponseDirectory() { return path.join(app.getPath('userData'), CLI_REFRESH_DIRECTORY, 'responses'); }
function cliRefreshResponsePath(id) { return path.join(app.getPath('userData'), CLI_REFRESH_DIRECTORY, 'responses', `${id}.json`); }
function desktopLayoutPath() { return path.join(app.getPath('userData'), DESKTOP_LAYOUT_FILE); }

function enabledProviderIds(data) {
  const configured = data?.settings?.enabledProviders;
  return Array.isArray(configured) ? configured.filter((id) => PROVIDER_IDS.includes(id)) : DEFAULT_DATA.settings.enabledProviders;
}

function normaliseDesktopLayout(input) {
  const layout = input && typeof input === 'object' ? input : {};
  const coordinate = (value) => Number.isFinite(value) ? Math.round(value) : null;
  return {
    ...DEFAULT_DESKTOP_LAYOUT,
    ...layout,
    version: DEFAULT_DESKTOP_LAYOUT.version,
    x: coordinate(layout.x),
    y: coordinate(layout.y),
    cardWidth: Math.max(150, Math.min(360, Number(layout.cardWidth) || DEFAULT_DESKTOP_LAYOUT.cardWidth)),
    desktopVisible: layout.desktopVisible !== false,
    editing: layout.editing === true,
    autoPosition: layout.autoPosition !== false,
  };
}

async function loadDesktopLayout() {
  try { desktopLayout = normaliseDesktopLayout(JSON.parse(await readFile(desktopLayoutPath(), 'utf8'))); }
  catch { desktopLayout = { ...DEFAULT_DESKTOP_LAYOUT }; }
  desktopLayout.editing = false;
  return desktopLayout;
}

async function saveDesktopLayout() {
  await writeJson(desktopLayoutPath(), { ...desktopLayout, editing: false });
}

function logDesktopLayoutSaveError(error) {
  console.error(`AI Widgets: could not save desktop widget layout: ${error.message}`);
}

function scheduleDesktopLayoutSave() {
  clearTimeout(layoutSaveTimer);
  layoutSaveTimer = setTimeout(() => {
    layoutSaveTimer = undefined;
    queueDesktopLayoutSave().catch(logDesktopLayoutSaveError);
  }, 150);
}

function queueDesktopLayoutSave() {
  layoutSaveInFlight = layoutSaveInFlight.catch(() => {}).then(() => saveDesktopLayout());
  return layoutSaveInFlight;
}

async function flushDesktopLayoutSave() {
  if (layoutSaveTimer) {
    clearTimeout(layoutSaveTimer);
    layoutSaveTimer = undefined;
    queueDesktopLayoutSave();
  }
  await layoutSaveInFlight.catch(logDesktopLayoutSaveError);
}

async function fileExists(target) {
  try { await access(target, constants.F_OK); return true; } catch { return false; }
}

async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, target);
}

async function ensureCliRefreshDirectories() {
  await Promise.all([
    mkdir(cliRefreshRequestDirectory(), { recursive: true }),
    mkdir(cliRefreshResponseDirectory(), { recursive: true }),
  ]);
}

async function pruneCliRefreshResponses() {
  const cutoff = Date.now() - CLI_REFRESH_RESPONSE_TTL_MS;
  let names;
  try { names = await readdir(cliRefreshResponseDirectory()); }
  catch { return; }
  await Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => {
    const file = path.join(cliRefreshResponseDirectory(), name);
    try {
      if ((await stat(file)).mtimeMs < cutoff) await unlink(file);
    } catch { /* A CLI may have consumed the response first. */ }
  }));
}

async function setRuntimeActive(active) {
  await writeJson(runtimePath(), { active: Boolean(active), updatedAt: new Date().toISOString() });
}

async function setRuntimeHeartbeat() {
  await writeJson(heartbeatPath(), { updatedAt: new Date().toISOString() });
}


async function backgroundCollectorMayOwnSession() {
  try {
    const runtime = JSON.parse(await readFile(runtimePath(), 'utf8'));
    return runtime?.active === true;
  } catch { return false; }
}

function isMacDesktopIntegration() { return process.platform === 'darwin'; }

function widgetDimensions(data) {
  const count = Math.max(1, enabledProviderIds(data).length);
  return { width: (desktopLayout.cardWidth * count) + (MAC_WIDGET_SPACING * (count - 1)), height: MAC_WIDGET_HEIGHT };
}

function boundedWidgetPosition(bounds, display) {
  const { workArea } = display;
  const right = workArea.x + workArea.width - bounds.width - MAC_WIDGET_MARGIN;
  const top = workArea.y + 18;
  const maxX = Math.max(workArea.x, workArea.x + workArea.width - bounds.width);
  const maxY = Math.max(workArea.y, workArea.y + workArea.height - bounds.height);
  const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
  if (desktopLayout.autoPosition || desktopLayout.x === null || desktopLayout.y === null) {
    return { x: clamp(right, workArea.x, maxX), y: clamp(top, workArea.y, maxY) };
  }
  return {
    x: clamp(desktopLayout.x, workArea.x, maxX),
    y: clamp(desktopLayout.y, workArea.y, maxY),
  };
}

function applyDesktopWidgetInteractivity() {
  if (!desktopWidgetRef || desktopWidgetRef.isDestroyed()) return;
  const editing = desktopLayout.editing === true;
  desktopWidgetRef.setIgnoreMouseEvents(!editing, { forward: true });
  desktopWidgetRef.setFocusable(editing);
  desktopWidgetRef.setAlwaysOnTop(false);
}

function setDesktopWidgetBounds(data) {
  if (!desktopWidgetRef || desktopWidgetRef.isDestroyed()) return;
  const dimensions = widgetDimensions(data);
  const display = desktopLayout.autoPosition || desktopLayout.x === null || desktopLayout.y === null
    ? screen.getPrimaryDisplay()
    : screen.getDisplayNearestPoint({ x: desktopLayout.x, y: desktopLayout.y });
  const position = boundedWidgetPosition(dimensions, display);
  applyingDesktopBounds = true;
  desktopWidgetRef.setBounds({ ...position, ...dimensions });
  applyingDesktopBounds = false;
}

async function desktopWidgetState() {
  return { data: await readData(), layout: { ...desktopLayout } };
}

async function refreshNativeWidgets() {
  if (!isMacDesktopIntegration()) return;
  const state = await desktopWidgetState();
  desktopWidgetData = state.data;
  if (desktopWidgetRef && !desktopWidgetRef.isDestroyed()) {
    setDesktopWidgetBounds(state.data);
    applyDesktopWidgetInteractivity();
    // Calling showInactive() on every data refresh asks macOS to order this
    // normal-level window again. That made the cards resurface above the app
    // the user was working in once per refresh interval. Only order it in
    // when it was explicitly hidden (or during initial creation).
    if (desktopLayout.desktopVisible) {
      if (!desktopWidgetRef.isVisible()) desktopWidgetRef.showInactive();
    } else if (desktopWidgetRef.isVisible()) {
      desktopWidgetRef.hide();
    }
    desktopWidgetRef.webContents.send('desktop-widget:state', state);
  }
  if (trayPopoverRef && !trayPopoverRef.isDestroyed()) trayPopoverRef.webContents.send('desktop-widget:state', state);
}

async function setDesktopLayout(patch) {
  desktopLayout = normaliseDesktopLayout({ ...desktopLayout, ...patch });
  // Panel actions may race a pending drag/resize debounce. Cancel that timer
  // and use the same serialized writer so the latest layout is the one that
  // reaches disk.
  clearTimeout(layoutSaveTimer);
  layoutSaveTimer = undefined;
  await queueDesktopLayoutSave().catch((error) => {
    logDesktopLayoutSaveError(error);
    throw error;
  });
  await refreshNativeWidgets();
  return { ...desktopLayout };
}

async function adjustDesktopWidgetWidth(change) {
  const delta = Number(change);
  if (!Number.isFinite(delta)) return { ...desktopLayout };
  desktopLayout = normaliseDesktopLayout({ ...desktopLayout, cardWidth: desktopLayout.cardWidth + delta });
  // Wheel events arrive in bursts. Resize the visible window immediately, but
  // defer the disk write just as we do while dragging the cards.
  scheduleDesktopLayoutSave();
  setDesktopWidgetBounds(desktopWidgetData);
  return { ...desktopLayout };
}

function createDesktopWidget() {
  if (!isMacDesktopIntegration()) return null;
  if (desktopWidgetRef && !desktopWidgetRef.isDestroyed()) return desktopWidgetRef;
  const dimensions = widgetDimensions({ settings: DEFAULT_DATA.settings });
  const position = boundedWidgetPosition(dimensions, screen.getPrimaryDisplay());
  desktopWidgetRef = new BrowserWindow({
    ...position, ...dimensions, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, show: false,
    webPreferences: { preload: path.join(import.meta.dirname, 'widget-preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  desktopWidgetRef.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  desktopWidgetRef.on('move', () => {
    if (applyingDesktopBounds || desktopLayout.editing !== true) return;
    const { x, y } = desktopWidgetRef.getBounds();
    desktopLayout = normaliseDesktopLayout({ ...desktopLayout, x, y, autoPosition: false });
    scheduleDesktopLayoutSave();
  });
  desktopWidgetRef.on('closed', () => { desktopWidgetRef = undefined; });
  desktopWidgetRef.webContents.once('did-finish-load', () => { refreshNativeWidgets().catch(() => {}); });
  desktopWidgetRef.loadFile(path.join(import.meta.dirname, 'widget.html'), { query: { surface: 'desktop' } })
    .catch((error) => console.error(`AI Widgets: could not load desktop cards: ${error.message}`));
  return desktopWidgetRef;
}

function trayPopoverBounds(preferredHeight) {
  const display = screen.getDisplayNearestPoint(trayRef?.getBounds() || screen.getCursorScreenPoint());
  const { workArea } = display;
  const maxHeight = Math.max(1, workArea.height - 24);
  const initialHeight = Math.min(720, maxHeight);
  const currentHeight = trayPopoverRef && !trayPopoverRef.isDestroyed() ? trayPopoverRef.getBounds().height : initialHeight;
  const requestedHeight = Number.isFinite(preferredHeight) ? preferredHeight : currentHeight;
  const height = Math.max(Math.min(280, maxHeight), Math.min(Math.ceil(requestedHeight), maxHeight));
  const trayBounds = trayRef?.getBounds();
  const requestedX = trayBounds ? trayBounds.x + trayBounds.width - MAC_PANEL_WIDTH : workArea.x + workArea.width - MAC_PANEL_WIDTH - 8;
  const requestedY = trayBounds ? trayBounds.y + trayBounds.height + 4 : workArea.y + 4;
  return {
    x: Math.max(workArea.x + 8, Math.min(requestedX, workArea.x + workArea.width - MAC_PANEL_WIDTH - 8)),
    y: Math.max(workArea.y + 4, Math.min(requestedY, workArea.y + workArea.height - height - 8)),
    width: MAC_PANEL_WIDTH, height,
  };
}

function resizeTrayPopover(contentHeight) {
  if (!trayPopoverRef || trayPopoverRef.isDestroyed() || !Number.isFinite(contentHeight)) return;
  const bounds = trayPopoverBounds(contentHeight);
  const current = trayPopoverRef.getBounds();
  if (current.x === bounds.x && current.y === bounds.y && current.width === bounds.width && current.height === bounds.height) return;
  trayPopoverRef.setBounds(bounds);
}

function createTrayPopover() {
  if (trayPopoverRef && !trayPopoverRef.isDestroyed()) return trayPopoverRef;
  trayPopoverRef = new BrowserWindow({
    ...trayPopoverBounds(), frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: true,
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, show: false,
    vibrancy: 'popover', visualEffectState: 'active',
    webPreferences: { preload: path.join(import.meta.dirname, 'widget-preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  trayPopoverRef.setAlwaysOnTop(true, 'pop-up-menu');
  trayPopoverRef.on('blur', () => trayPopoverRef?.hide());
  trayPopoverRef.on('closed', () => { trayPopoverRef = undefined; });
  trayPopoverRef.loadFile(path.join(import.meta.dirname, 'widget.html'), { query: { surface: 'panel' } })
    .catch((error) => console.error(`AI Widgets: could not load menu-bar panel: ${error.message}`));
  return trayPopoverRef;
}

async function toggleTrayPopover() {
  const popup = createTrayPopover();
  if (popup.isVisible()) { popup.hide(); return; }
  const state = await desktopWidgetState();
  popup.setBounds(trayPopoverBounds(popup.getBounds().height));
  popup.show();
  popup.focus();
  popup.webContents.send('desktop-widget:state', state);
}

function createMenuBarItem() {
  if (!isMacDesktopIntegration() || trayRef) return;
  const icon = nativeImage.createFromPath(path.join(import.meta.dirname, '..', 'imgs', 'menu-bar-iconTemplate.svg')).resize({ width: 18, height: 18 });
  icon.setTemplateImage(true);
  trayRef = new Tray(icon);
  trayRef.setTitle('AI');
  trayRef.setToolTip('AI Widgets');
  trayRef.on('click', () => { toggleTrayPopover().catch(() => {}); });
}

async function initialiseMacDesktopIntegration() {
  if (!isMacDesktopIntegration()) return;
  await loadDesktopLayout();
  createMenuBarItem();
  createDesktopWidget();
  await refreshNativeWidgets();
}

async function destroyMacDesktopIntegration() {
  await flushDesktopLayoutSave();
  desktopWidgetRef?.destroy();
  trayPopoverRef?.destroy();
  trayRef?.destroy();
  desktopWidgetRef = trayPopoverRef = trayRef = undefined;
}

function notifyUsageChanged() {
  windowRef?.webContents.send('usage:changed');
  refreshNativeWidgets().catch(() => {});
}

function notifyCollectorChanged() {
  windowRef?.webContents.send('collector:changed');
}

async function requestQuit() {
  if (quitting) return;
  quitting = true;
  await setRuntimeActive(false).catch(() => {});
  await destroyMacDesktopIntegration().catch(() => {});
  app.quit();
}

async function ensureDataFile() {
  const target = dataPath();
  if (!(await fileExists(target))) {
    await writeJson(target, createFirstRunData());
  }
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

function normaliseProviderSource(providerId, source) {
  if (providerId === 'copilot') return source === 'actions' ? 'actions' : 'premium';
  return 'default';
}

function sourceUrl(providerId, source, entry) {
  if (!entry.url) return sourceStartUrl(providerId, source);
  try {
    const saved = new URL(entry.url);
    // Older connections saved the Billing overview. Its Copilot section only
    // contains spend, whereas the analytics view exposes the included quota.
    if (providerId === 'copilot' && source === 'premium' && saved.pathname === '/settings/billing') return sourceStartUrl(providerId, source);
  } catch { return sourceStartUrl(providerId, source); }
  return entry.url;
}

async function readData() {
  const target = await ensureDataFile();
  try { return normaliseUsageData(JSON.parse(await readFile(target, 'utf8'))); }
  catch (error) { return { ...normaliseUsageData(DEFAULT_DATA), error: `Could not read ${target}: ${error.message}` }; }
}

async function saveEnabledProviders(ids, completeOnboarding = false) {
  if (!Array.isArray(ids)) throw new Error('Enabled providers must be an array.');
  const data = await readData();
  data.settings.enabledProviders = ids.filter((id) => Object.hasOwn(PROVIDERS, id));
  if (completeOnboarding) data.settings.onboardingComplete = true;
  data.updatedAt = new Date().toISOString();
  await writeJson(await ensureDataFile(), data);
  notifyUsageChanged();
  if (data.settings.enabledProviders.includes('copilot')) refreshProvider('copilot').catch(() => {});
  return data;
}

async function enableProvider(providerId) {
  const data = await readData();
  if (data.settings.enabledProviders.includes(providerId)) return data;
  data.settings.enabledProviders.push(providerId);
  data.updatedAt = new Date().toISOString();
  await writeJson(await ensureDataFile(), data);
  notifyUsageChanged();
  return data;
}

async function applyCollectedUsage(providerId, text, source = 'default') {
  const parsed = parseVisibleUsage(providerId, text, source);
  if (!parsed) return { accepted: false, reason: providerId === 'copilot' && source === 'actions' ? 'No Actions minutes usage was found yet.' : providerId === 'copilot' ? 'No Copilot usage was found yet.' : 'No session or weekly percentage was found on the usage page.' };
  const target = await ensureDataFile();
  const data = await readData();
  const provider = data.providers.find((item) => item.id === providerId);
  if (parsed.session) provider.session = { available: parsed.session.available, resetsAt: null, resetLabel: parsed.session.resetLabel || null };
  if (parsed.weekly) provider.weekly = { available: parsed.weekly.available, resetsAt: null, resetLabel: parsed.weekly.resetLabel || null };
  if (parsed.monthly) provider.monthly = { available: parsed.monthly.available, resetsAt: null, resetLabel: parsed.monthly.resetLabel || null, label: parsed.monthly.label || 'Premium requests', ...(Number.isFinite(parsed.monthly.used) ? { used: parsed.monthly.used } : {}), ...(Number.isFinite(parsed.monthly.included) ? { included: parsed.monthly.included } : {}) };
  if (parsed.actionsMinutes) provider.actionsMinutes = parsed.actionsMinutes;
  provider.note = parsed.note;
  data.updatedAt = new Date().toISOString();
  await writeJson(target, data);
  notifyUsageChanged();
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

function isProviderOrigin(providerId, value) {
  try {
    const url = new URL(value);
    if (providerId === 'codex') return url.hostname === 'chatgpt.com';
    if (providerId === 'claude') return url.hostname === 'claude.ai' || url.hostname === 'www.claude.ai';
    if (providerId === 'copilot') return url.hostname === 'github.com';
    return false;
  } catch { return false; }
}

function isCanonicalUsageUrl(providerId, value) {
  try {
    const url = new URL(value);
    if (providerId === 'codex') return url.hostname === 'chatgpt.com' && (
      url.pathname.startsWith('/codex/settings/usage') ||
      url.pathname.startsWith('/codex/cloud/settings/analytics')
    );
    if (providerId === 'copilot') return url.hostname === 'github.com' && url.pathname.startsWith('/settings/billing/premium_requests_usage');
    return (url.hostname === 'claude.ai' || url.hostname === 'www.claude.ai') &&
      (url.pathname.startsWith('/settings/usage') || url.hash.startsWith('#settings/usage'));
  } catch { return false; }
}

async function selectProviderView(providerId, source, webContents) {
  if (providerId !== 'copilot') return;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const selected = await webContents.executeJavaScript(`(() => {
      const controls = [...document.querySelectorAll('a, button, [role="tab"]')];
      const label = ${JSON.stringify(source === 'actions' ? 'actions' : 'premium')};
      const control = controls.find((element) => label === 'actions'
        ? /^actions$/i.test(element.innerText?.trim() || '')
        : /^(?:copilot|premium requests?)$/i.test(element.innerText?.trim() || ''));
      if (!control) return false;
      control.click();
      return true;
    })()`, true).catch(() => false);
    if (selected) { await delay(800); return; }
    await delay(500);
  }
}

async function autoConnectCopilot(win) {
  const key = 'copilot:premium';
  if (win.isDestroyed() || !win.isVisible() || providerConnectionInFlight.has(key)) return;
  const currentUrl = win.webContents.getURL();
  if (!isCanonicalUsageUrl('copilot', currentUrl)) {
    if (isProviderOrigin('copilot', currentUrl) && !/\/(?:login|sessions?)(?:\/|$)/i.test(new URL(currentUrl).pathname)) {
      await win.loadURL(sourceStartUrl('copilot', 'premium')).catch(() => {});
    }
    return;
  }
  providerConnectionInFlight.add(key);
  try {
    await setCollectorStatus('copilot', 'Reading Copilot usage from the signed-in GitHub account.', null, 'premium');
    const premium = await applyCollectedUsage('copilot', await extractSettledUsageText('copilot', win.webContents, 'premium'), 'premium');
    if (!premium.accepted) {
      await setCollectorStatus('copilot', 'Signed in; waiting for Copilot usage to finish loading.', null, 'premium');
      scheduleProviderRetry(key, () => autoConnectCopilot(win));
      return;
    }
    clearProviderRetry(key);
    await enableProvider('copilot');
    let config = await readCollector();
    Object.assign(collectorEntry(config, 'copilot', 'premium'), { configured: true, url: win.webContents.getURL(), status: 'Copilot usage connected and updated automatically.', lastSync: new Date().toISOString() });
    Object.assign(collectorEntry(config, 'copilot', 'actions'), { configured: true, url: sourceStartUrl('copilot', 'actions'), status: 'Reading Actions minutes.', lastSync: null });
    await writeCollector(config);
    notifyCollectorChanged();

    const actionsWindow = createProviderWindow('copilot', false, 'actions');
    await actionsWindow.loadURL(sourceStartUrl('copilot', 'actions'));
    await selectProviderView('copilot', 'actions', actionsWindow.webContents);
    const actions = await applyCollectedUsage('copilot', await extractSettledUsageText('copilot', actionsWindow.webContents, 'actions'), 'actions');
    config = await readCollector();
    const actionsEntry = collectorEntry(config, 'copilot', 'actions');
    actionsEntry.status = actions.accepted ? 'Actions minutes connected and updated automatically.' : actions.reason;
    actionsEntry.lastSync = actions.accepted ? new Date().toISOString() : null;
    await writeCollector(config);
    notifyCollectorChanged();
    win.hide();
    showControlCenter();
  } catch (error) {
    await setCollectorStatus('copilot', `Could not read GitHub billing: ${error.message}`, null, 'premium');
  } finally {
    providerConnectionInFlight.delete(key);
  }
}

async function autoConnectProvider(providerId, source, win) {
  if (providerId === 'copilot') return autoConnectCopilot(win);
  if (win.isDestroyed() || !win.isVisible()) return;
  const key = `${providerId}:${source}`;
  if (providerConnectionInFlight.has(key)) return;
  const currentUrl = win.webContents.getURL();
  if (!isCanonicalUsageUrl(providerId, currentUrl)) {
    if (isProviderOrigin(providerId, currentUrl) && !/\/(?:auth|login|oauth)(?:\/|$)/i.test(new URL(currentUrl).pathname)) {
      await win.loadURL(sourceStartUrl(providerId, source)).catch(() => {});
    }
    return;
  }
  providerConnectionInFlight.add(key);
  try {
    await setCollectorStatus(providerId, 'Reading usage from the signed-in account.', null, source);
    const result = await applyCollectedUsage(providerId, await extractSettledUsageText(providerId, win.webContents, source), source);
    const config = await readCollector();
    const entry = collectorEntry(config, providerId, source);
    if (result.accepted) {
      clearProviderRetry(key);
      await enableProvider(providerId);
      Object.assign(entry, {
        configured: true,
        url: win.webContents.getURL(),
        status: 'Connected and updated automatically.',
        lastSync: new Date().toISOString(),
      });
      await writeCollector(config);
      notifyCollectorChanged();
      win.hide();
      showControlCenter();
    } else {
      entry.status = 'Signed in; waiting for the usage page to finish loading.';
      await writeCollector(config);
      notifyCollectorChanged();
      scheduleProviderRetry(key, () => autoConnectProvider(providerId, source, win));
    }
  } catch (error) {
    await setCollectorStatus(providerId, `Could not read usage yet: ${error.message}`, null, source);
  } finally {
    providerConnectionInFlight.delete(key);
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
  // OAuth often opens a popup. Keep the login in the tracked persistent
  // window so the usage page can be detected immediately after authorization.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const destination = new URL(url);
      if (destination.protocol === 'https:') win.loadURL(destination.href).catch(() => {});
    } catch { /* Ignore malformed popup destinations. */ }
    return { action: 'deny' };
  });
  win.webContents.on('did-finish-load', () => { autoConnectProvider(providerId, source, win).catch(() => {}); });
  win.webContents.on('did-navigate-in-page', () => { autoConnectProvider(providerId, source, win).catch(() => {}); });
  win.on('close', (event) => {
    clearProviderRetry(key);
    if (!quitting) { event.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { clearProviderRetry(key); providerWindows.delete(key); });
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
  notifyCollectorChanged();
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
  await Promise.all(['premium', 'actions'].map((source) => refreshPageProvider('copilot', source)));
  return readCollector();
}

async function refreshProvider(providerId, source = 'default') {
  if (providerId === 'copilot') return refreshCopilotProvider();
  return refreshPageProvider(providerId, source);
}

function refreshAllProviders() {
  if (refreshInFlight) return refreshInFlight;
  const task = (async () => {
    const data = await readData();
    await Promise.all(data.settings.enabledProviders.flatMap((providerId) => providerId === 'copilot'
      ? [refreshProvider('copilot')]
      : [refreshProvider(providerId)]));
    return readCollector();
  })();
  refreshInFlight = task;
  task.then(
    () => { if (refreshInFlight === task) refreshInFlight = undefined; },
    () => { if (refreshInFlight === task) refreshInFlight = undefined; },
  );
  return task;
}

async function processCliRefreshRequests() {
  if (cliRefreshInFlight) return;
  cliRefreshInFlight = true;
  try {
    let names;
    try { names = await readdir(cliRefreshRequestDirectory()); }
    catch { return; }
    const requests = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(cliRefreshRequestDirectory(), name);
      try {
        const request = JSON.parse(await readFile(file, 'utf8'));
        if (typeof request?.id === 'string' && CLI_REFRESH_REQUEST_ID.test(request.id) && name === `${request.id}.json`) {
          requests.push({ file, id: request.id });
        }
      } catch { /* Ignore an incomplete or invalid request file. */ }
    }
    if (!requests.length) return;
    try {
      await refreshAllProviders();
      await Promise.all(requests.map(async ({ file, id }) => {
        await writeJson(cliRefreshResponsePath(id), { id, completedAt: new Date().toISOString() });
        await unlink(file).catch(() => {});
      }));
    } catch (error) {
      await Promise.all(requests.map(async ({ file, id }) => {
        await writeJson(cliRefreshResponsePath(id), { id, error: error.message || String(error) });
        await unlink(file).catch(() => {});
      }));
    }
  } finally {
    cliRefreshInFlight = false;
  }
}

async function openProvider(providerId, source = 'default') {
  clearProviderRetry(`${providerId}:${source}`);
  const config = await readCollector();
  const entry = collectorEntry(config, providerId, source);
  entry.status = `Sign in to ${PROVIDERS[providerId].name}; AI Widgets will connect automatically.`;
  await writeCollector(config);
  notifyCollectorChanged();
  const win = createProviderWindow(providerId, true, source);
  // Start a first-time Copilot connection at GitHub's explicit login URL.
  // Afterwards sourceStartUrl handles the direct authenticated analytics URL.
  const url = providerId === 'copilot' && !entry.configured
    ? PROVIDERS.copilot.startUrl
    : sourceUrl(providerId, source, entry);
  // The did-finish-load handler can immediately advance an authenticated
  // Copilot login from Billing to its analytics page. Electron reports that
  // expected superseded navigation as ERR_ABORTED; it is not a failed login.
  await win.loadURL(url).catch((error) => {
    if (error?.code !== 'ERR_ABORTED') throw error;
  });
  win.show(); win.focus();
  autoConnectProvider(providerId, source, win).catch(() => {});
  return readCollector();
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

function resizeControlWindow(contentHeight) {
  if (!windowRef || windowRef.isDestroyed() || !Number.isFinite(contentHeight)) return;
  const bounds = windowRef.getBounds();
  const { workArea } = screen.getDisplayMatching(bounds);
  const height = Math.max(420, Math.min(Math.ceil(contentHeight), workArea.height - 32));
  if (Math.abs(bounds.height - height) < 2) return;
  const y = Math.max(workArea.y + 16, Math.min(bounds.y, workArea.y + workArea.height - height - 16));
  windowRef.setBounds({ ...bounds, y, height });
}

function showControlCenter() {
  if (!windowRef) createWindow();
  if (windowRef.isMinimized()) windowRef.restore();
  windowRef.setIgnoreMouseEvents(false); windowRef.show(); windowRef.focus();
}

app.whenReady().then(async () => {
  if (usageCliRequested) {
    const collectorMayOwnSession = await backgroundCollectorMayOwnSession();
    const code = await runUsageCli(process.argv.slice(2), {
      dataPath: dataPath(),
      // A separate CLI process must not open a second copy of the persistent
      // subscription browser profile while the background collector owns it.
      // Only when no process claims the profile can this short-lived Electron
      // process safely refresh configured sources before printing values.
      refresh: collectorMayOwnSession ? undefined : refreshAllProviders,
    });
    app.exit(code);
    return;
  }
  if (quitRequested) {
    await requestQuit();
    return;
  }
  await ensureDataFile(); await readCollector(); await setRuntimeActive(true); await setRuntimeHeartbeat();
  await ensureCliRefreshDirectories();
  await pruneCliRefreshResponses();
  await initialiseMacDesktopIntegration();
  refreshAllProviders().catch(() => {});
  setInterval(() => { refreshAllProviders().catch(() => {}); }, 60_000);
  setInterval(() => { setRuntimeHeartbeat().catch(() => {}); }, 5_000);
  processCliRefreshRequests().catch(() => {});
  setInterval(() => { processCliRefreshRequests().catch(() => {}); }, 500);
  setInterval(() => { pruneCliRefreshResponses().catch(() => {}); }, CLI_REFRESH_RESPONSE_TTL_MS);
  setInterval(async () => {
    try {
      const runtime = JSON.parse(await readFile(runtimePath(), 'utf8'));
      if (runtime?.active === false) await requestQuit();
    } catch { /* Missing runtime state means active. */ }
  }, 1000);
  // Linux uses the package's XDG autostart desktop entry. macOS uses
  // Electron's login-item integration until it gains a native widget host.
  app.setLoginItemSettings({ openAtLogin: process.platform !== 'linux' });
  if (openSettingsOnStart) showControlCenter();
});
app.on('before-quit', (event) => {
  if (usageCliRequested) return;
  if (quitting) return;
  event.preventDefault();
  requestQuit().catch(() => {});
});
app.on('activate', showControlCenter);

ipcMain.handle('usage:read', readData);
ipcMain.handle('providers:save-enabled', (_event, ids, completeOnboarding) => saveEnabledProviders(ids, completeOnboarding === true));
ipcMain.handle('collector:info', readCollector);
ipcMain.handle('collector:open', (_event, providerId, source) => PAGE_PROVIDER_IDS.includes(providerId)
  ? openProvider(providerId, normaliseProviderSource(providerId, source))
  : Promise.reject(new Error('Invalid page provider.')));
ipcMain.handle('collector:refresh', refreshAllProviders);
ipcMain.on('window:resize-control', (_event, height) => resizeControlWindow(height));
ipcMain.handle('window:minimize', () => windowRef?.minimize());
ipcMain.handle('window:close', () => windowRef?.hide());
ipcMain.handle('desktop-widget:state', desktopWidgetState);
ipcMain.handle('desktop-widget:refresh', async () => { await refreshAllProviders(); return desktopWidgetState(); });
ipcMain.handle('desktop-widget:toggle-visible', () => setDesktopLayout({ desktopVisible: !desktopLayout.desktopVisible }));
ipcMain.handle('desktop-widget:set-editing', (_event, editing) => setDesktopLayout({ editing: Boolean(editing), desktopVisible: true }));
ipcMain.handle('desktop-widget:anchor', () => setDesktopLayout({ autoPosition: true, x: null, y: null }));
ipcMain.handle('desktop-widget:resize', (_event, delta) => adjustDesktopWidgetWidth(delta));
ipcMain.on('desktop-widget:resize-panel', (_event, height) => resizeTrayPopover(height));
ipcMain.handle('desktop-widget:open-settings', () => { trayPopoverRef?.hide(); showControlCenter(); });
ipcMain.handle('desktop-widget:exit', requestQuit);
