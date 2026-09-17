import electron from 'electron';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runUsageCli } from './usage-cli.mjs';
import { defaultCollector, normaliseCollector, withCollectorAttempt, withCollectorFailure, withCollectorSuccess } from './collector-health.mjs';
import { PROVIDER_SESSION_ORIGINS, isProviderAuthenticationUrl, isProviderOrigin } from './provider-origins.mjs';
import { alertNotification, normaliseAlertState, pendingFailureAlerts, pendingUsageAlerts, settleProviderAlerts, silenceFailureAlert } from './alerts.mjs';
import { forgetProviderHistory, normaliseHistory, recordHistorySamples, setRetentionDays } from './history.mjs';
import { DEFAULT_DATA, createFirstRunData, disconnectUsageData, normaliseUsageData, resetFirstRunData } from './usage-data.mjs';
import { parseVisibleUsage } from './usage-parser.mjs';
import { mergeDeepSeekBalance } from './deepseek-balance.mjs';
import { fetchDeepSeekBalance } from './deepseek-client.mjs';

const { app, BrowserWindow, Notification, dialog, ipcMain, nativeImage, safeStorage, screen, session, Tray } = electron;
const APP_NAME = 'AI Widgets';
const DATA_FILE = 'usage.json';
const COLLECTOR_FILE = 'subscription-collector.json';
const RUNTIME_FILE = 'runtime.json';
const DESKTOP_LAYOUT_FILE = 'desktop-widget.json';
const HEARTBEAT_FILE = 'collector-heartbeat.json';
const ALERTS_FILE = 'alerts.json';
const HISTORY_FILE = 'history.json';
const DEEPSEEK_CREDENTIALS_FILE = 'deepseek-credentials.json';
const CLI_REFRESH_DIRECTORY = 'usage-refresh';
const CLI_REFRESH_RESPONSE_TTL_MS = 60_000;
const CLI_REFRESH_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COLLECTOR_PARTITION = 'persist:aiwidgets-subscriptions';
const SESSION_DATA_TYPES = ['cache', 'cookies', 'fileSystems', 'indexedDB', 'localStorage', 'serviceWorkers', 'webSQL'];
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
  deepseek: { name: 'DeepSeek API' },
};
const DEFAULT_DESKTOP_LAYOUT = {
  version: 3,
  x: null,
  y: null,
  cardWidth: 170,
  desktopVisible: true,
  editing: false,
  autoPosition: true,
  panelLayout: 'one-column',
};
const PROVIDER_IDS = ['claude', 'codex', 'copilot', 'deepseek'];
const PAGE_PROVIDER_IDS = ['claude', 'codex', 'copilot'];
const API_PROVIDER_IDS = ['deepseek'];
const GNOME_EXTENSION_UUID = 'aiwidgets@fdipietro.dev';
const GNOME_USER_EXTENSION_DIRECTORY = path.join('.local', 'share', 'gnome-shell', 'extensions', GNOME_EXTENSION_UUID);
const MAC_WIDGET_SPACING = 20;
const MAC_WIDGET_MARGIN = 28;
const MAC_WIDGET_HEIGHT = 286;
const MAC_PANEL_WIDTH = 318;
const MAC_PANEL_MAX_WIDTH = 1200;

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
const providerConnectionInFlight = new Map();
const providerOpenInFlight = new Map();
const providerRefreshInFlight = new Map();
const providerRetryTimers = new Map();
const privacyProtectedProviders = new Set();
let privacyOperation = Promise.resolve();
// Launching the application from the desktop menu should show its settings.
// Closing that window leaves the background collector running; the GNOME
// extension remains the separate compact usage view in the top panel.
const openSettingsOnStart = !process.argv.includes('--background');
const providerWindows = new Map();
const quitRequested = process.argv.includes('--quit');
const usageCliRequested = process.argv.includes('usage') || process.argv.includes('--usage');
const automaticRefreshEnabled = process.env.AIWIDGETS_TEST_DISABLE_REFRESH !== '1';

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
function alertsPath() { return path.join(app.getPath('userData'), ALERTS_FILE); }
function historyPath() { return path.join(app.getPath('userData'), HISTORY_FILE); }
function deepSeekCredentialsPath() { return path.join(app.getPath('userData'), DEEPSEEK_CREDENTIALS_FILE); }

function enabledProviderIds(data) {
  const configured = data?.settings?.enabledProviders;
  return Array.isArray(configured) ? configured.filter((id) => PROVIDER_IDS.includes(id)) : DEFAULT_DATA.settings.enabledProviders;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => execFile(command, args, { timeout: 5_000 }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stderr }));
    else resolve(stdout);
  }));
}

async function gnomeIntegrationState() {
  if (process.platform !== 'linux') return { supported: false, installed: false, enabled: false };
  const desktop = String(process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  if (!desktop.includes('gnome')) return { supported: false, installed: false, enabled: false };
  try {
    const info = await runCommand('gnome-extensions', ['info', GNOME_EXTENSION_UUID]);
    const extensionPath = info.match(/^Path:\s*(.+)$/mi)?.[1]?.trim() || '';
    const userExtensionPath = path.join(app.getPath('home'), GNOME_USER_EXTENSION_DIRECTORY);
    return {
      supported: true,
      installed: true,
      enabled: /^Enabled:\s+Yes$/mi.test(info),
      active: /^State:\s+ACTIVE$/mi.test(info),
      needsMigration: extensionPath === userExtensionPath,
    };
  } catch {
    return { supported: true, installed: false, enabled: false, active: false };
  }
}

async function enableGnomeIntegration() {
  if (process.platform !== 'linux') throw new Error('GNOME desktop integration is only available on Linux.');
  const state = await gnomeIntegrationState();
  if (!state.installed) throw new Error('The bundled GNOME extension is not installed. Reinstall AI Widgets.');
  // Older releases installed the extension per-user from a ZIP. GNOME gives
  // that copy priority over the system copy now shipped in the .deb. This is
  // deliberately user-triggered: it removes only the old duplicate and then
  // enables the packaged extension.
  if (state.needsMigration) {
    await runCommand('gnome-extensions', ['disable', GNOME_EXTENSION_UUID]);
    await runCommand('gnome-extensions', ['uninstall', GNOME_EXTENSION_UUID]);
  }
  await runCommand('gnome-extensions', ['enable', GNOME_EXTENSION_UUID]);
  return gnomeIntegrationState();
}

function normaliseDesktopLayout(input) {
  const layout = input && typeof input === 'object' ? input : {};
  const { panelColumns, ...modernLayout } = layout;
  const coordinate = (value) => Number.isFinite(value) ? Math.round(value) : null;
  const panelLayout = ['one-column', 'two-columns', 'row'].includes(modernLayout.panelLayout)
    ? modernLayout.panelLayout
    : Number(panelColumns) === 2 ? 'two-columns' : 'one-column';
  return {
    ...DEFAULT_DESKTOP_LAYOUT,
    ...modernLayout,
    version: DEFAULT_DESKTOP_LAYOUT.version,
    x: coordinate(layout.x),
    y: coordinate(layout.y),
    cardWidth: Math.max(150, Math.min(360, Number(layout.cardWidth) || DEFAULT_DESKTOP_LAYOUT.cardWidth)),
    desktopVisible: layout.desktopVisible !== false,
    editing: layout.editing === true,
    autoPosition: layout.autoPosition !== false,
    panelLayout,
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
  return { data: await readData(), collector: await readCollector(), layout: { ...desktopLayout } };
}

async function readUiState() {
  // An unreadable history.json must not take the rest of the control panel
  // down with it — usage, alerts, and connections are all independent of it.
  let history;
  try { history = await readHistory(); }
  catch (error) { history = { ...normaliseHistory({}), error: error.message }; }
  return { ...(await readData()), collector: await readCollector(), alertState: await readAlertState(), history, desktopIntegration: await gnomeIntegrationState() };
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

function trayPopoverBounds(preferredHeight, preferredWidth) {
  const display = screen.getDisplayNearestPoint(trayRef?.getBounds() || screen.getCursorScreenPoint());
  const { workArea } = display;
  const maxHeight = Math.max(1, workArea.height - 24);
  const maxWidth = Math.max(1, Math.min(MAC_PANEL_MAX_WIDTH, workArea.width - 16));
  const initialHeight = Math.min(720, maxHeight);
  const currentHeight = trayPopoverRef && !trayPopoverRef.isDestroyed() ? trayPopoverRef.getBounds().height : initialHeight;
  const currentWidth = trayPopoverRef && !trayPopoverRef.isDestroyed() ? trayPopoverRef.getBounds().width : MAC_PANEL_WIDTH;
  const requestedHeight = Number.isFinite(preferredHeight) ? preferredHeight : currentHeight;
  const requestedWidth = Number.isFinite(preferredWidth) ? preferredWidth : currentWidth;
  const height = Math.max(Math.min(280, maxHeight), Math.min(Math.ceil(requestedHeight), maxHeight));
  const width = Math.max(Math.min(MAC_PANEL_WIDTH, maxWidth), Math.min(Math.ceil(requestedWidth), maxWidth));
  const trayBounds = trayRef?.getBounds();
  const requestedX = trayBounds ? trayBounds.x + trayBounds.width - width : workArea.x + workArea.width - width - 8;
  const requestedY = trayBounds ? trayBounds.y + trayBounds.height + 4 : workArea.y + 4;
  return {
    x: Math.max(workArea.x + 8, Math.min(requestedX, workArea.x + workArea.width - width - 8)),
    y: Math.max(workArea.y + 4, Math.min(requestedY, workArea.y + workArea.height - height - 8)),
    width, height,
  };
}

function resizeTrayPopover(contentHeight, contentWidth) {
  if (!trayPopoverRef || trayPopoverRef.isDestroyed() || !Number.isFinite(contentHeight)) return;
  const bounds = trayPopoverBounds(contentHeight, contentWidth);
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

async function readCollector() {
  const target = collectorPath();
  let stored = {};
  try { stored = JSON.parse(await readFile(target, 'utf8')); } catch { /* First run. */ }
  const config = normaliseCollector(stored);
  if (!(await fileExists(target))) await writeJson(target, config);
  return config;
}

async function writeCollector(config) { await writeJson(collectorPath(), config); return config; }

function collectorEntry(config, providerId, source = 'default') {
  return providerId === 'copilot' ? config.providers.copilot[source] : config.providers[providerId];
}

async function readDeepSeekApiKey() {
  let stored;
  try { stored = JSON.parse(await readFile(deepSeekCredentialsPath(), 'utf8')); }
  catch { return null; }
  if (typeof stored?.encryptedApiKey !== 'string' || !safeStorage.isEncryptionAvailable()) return null;
  try { return safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, 'base64')); }
  catch { return null; }
}

async function saveDeepSeekApiKey(apiKey) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this system.');
  await writeJson(deepSeekCredentialsPath(), { encryptedApiKey: safeStorage.encryptString(apiKey).toString('base64') });
}

async function deleteDeepSeekApiKey() {
  await unlink(deepSeekCredentialsPath()).catch((error) => { if (error.code !== 'ENOENT') throw error; });
}

function sourceStartUrl(providerId, source = 'default') {
  return PROVIDERS[providerId].startUrls?.[source] || PROVIDERS[providerId].startUrl;
}

function normaliseProviderSource(providerId, source) {
  if (providerId === 'copilot') return source === 'actions' ? 'actions' : 'premium';
  return 'default';
}

function providerSources(providerId) {
  if (providerId === 'deepseek') return ['api'];
  return providerId === 'copilot' ? ['premium', 'actions'] : ['default'];
}

async function closeProviderWindows(providerId) {
  for (const source of providerSources(providerId)) {
    const key = `${providerId}:${source}`;
    clearProviderRetry(key);
    const win = providerWindows.get(key);
    if (win && !win.isDestroyed()) win.destroy();
  }
}

async function clearProviderSession(providerId) {
  const origins = PROVIDER_SESSION_ORIGINS[providerId];
  if (!origins) throw new Error('Invalid page provider.');
  // All providers historically shared this persistent partition. Restricting
  // the clear to their origins removes their cookies and site storage without
  // affecting the other providers' signed-in sessions.
  await session.fromPartition(COLLECTOR_PARTITION).clearData({
    dataTypes: SESSION_DATA_TYPES,
    origins,
    originMatchingMode: 'origin-in-all-contexts',
  });
}

async function clearCollectorPartition() {
  const collectorSession = session.fromPartition(COLLECTOR_PARTITION);
  await collectorSession.clearData();
  await collectorSession.clearAuthCache();
  await collectorSession.clearHostResolverCache();
}

function isPrivacyProtected(providerId) {
  return privacyProtectedProviders.has(providerId);
}

async function waitForProviderWork(providerIds) {
  const keys = new Set(providerIds.flatMap((providerId) => providerSources(providerId).map((source) => `${providerId}:${source}`)));
  const work = [
    ...[...providerRefreshInFlight.entries()].filter(([key]) => keys.has(key)).map(([, task]) => task),
    ...[...providerConnectionInFlight.entries()].filter(([key]) => keys.has(key)).map(([, task]) => task),
    ...[...providerOpenInFlight.entries()].filter(([key]) => keys.has(key)).map(([, task]) => task),
  ];
  await Promise.allSettled(work);
}

function runPrivacyOperation(providerIds, operation) {
  const task = privacyOperation.catch(() => {}).then(async () => {
    providerIds.forEach((providerId) => privacyProtectedProviders.add(providerId));
    try {
      await Promise.all(providerIds.map(closeProviderWindows));
      await waitForProviderWork(providerIds);
      // A refresh that was already past its first protection check can finish
      // its drain by creating a hidden window. Close once more before clearing
      // session data so no live renderer can restore cookies or storage.
      await Promise.all(providerIds.map(closeProviderWindows));
      return await operation();
    } finally {
      providerIds.forEach((providerId) => privacyProtectedProviders.delete(providerId));
    }
  });
  privacyOperation = task.catch(() => {});
  return task;
}

let usageWork = Promise.resolve();

// usage.json has several independent read-modify-write callers (automatic
// refresh, the enabled-providers form, alert preferences, the privacy
// operations). Without a shared queue, two of them racing can silently drop
// each other's change: the last writer wins with a copy based on a stale
// read, and nothing reports it. `mutate` receives the current data and
// returns either the value to persist, or null to signal no change is
// needed (skipping the write and the caller's notification).
function withUsageData(mutate) {
  const task = usageWork.catch(() => {}).then(async () => {
    const current = await readData();
    const next = await mutate(current);
    if (next === null) return { data: current, changed: false };
    next.updatedAt = new Date().toISOString();
    await writeJson(await ensureDataFile(), next);
    return { data: next, changed: true };
  });
  usageWork = task.catch(() => {});
  return task;
}

let alertWork = Promise.resolve();

async function readAlertState() {
  try { return normaliseAlertState(JSON.parse(await readFile(alertsPath(), 'utf8'))); }
  catch { return normaliseAlertState({}); }
}

async function writeAlertState(state) {
  await writeJson(alertsPath(), state);
  return state;
}

// Every alert path reads, decides and writes the same file, so they run one
// after another. Losing a write here would re-announce a threshold that was
// already delivered, which is the one failure mode alerts must not have.
function queueAlertWork(operation) {
  const task = alertWork.catch(() => {}).then(operation);
  alertWork = task.catch(() => {});
  return task;
}

function emitAlert(alert) {
  // Electron cannot report whether the user denied notifications, so an
  // unsupported or blocked system simply produces nothing. The settings panel
  // says so rather than letting the app look like it is working.
  if (!Notification.isSupported()) return;
  const { title, body } = alertNotification(alert);
  const notification = new Notification({ title, body });
  notification.on('click', () => showControlCenter());
  notification.show();
}

async function evaluateAlerts() {
  return queueAlertWork(async () => {
    const [data, collector] = [await readData(), await readCollector()];
    const now = Date.now();
    const usage = pendingUsageAlerts({ data, alertState: await readAlertState(), now });
    const failure = pendingFailureAlerts({ data, collector, alertState: usage.state, now });
    await writeAlertState(failure.state);
    [...usage.alerts, ...failure.alerts].forEach(emitAlert);
    return [...usage.alerts, ...failure.alerts];
  });
}

let historyWork = Promise.resolve();

async function readHistory() {
  try { return normaliseHistory(JSON.parse(await readFile(historyPath(), 'utf8'))); }
  catch (error) {
    // A missing file is a normal first run: start empty. Anything else — a
    // truncated or mid-write file, a permission error, a file momentarily
    // locked by an external sync tool — must not be treated the same way.
    // recordHistory writes unconditionally every refresh cycle; silently
    // returning an empty history here would have the very next cycle
    // overwrite and permanently destroy whatever was actually on disk.
    if (error.code === 'ENOENT') return normaliseHistory({});
    throw new Error(`Could not read history.json: ${error.message}`);
  }
}

async function writeHistory(history) {
  await writeJson(historyPath(), history);
  return history;
}

// Its own queue, like alerts.json: a read-modify-write file with more than
// one caller (the refresh cycle, the retention setting, a privacy operation)
// must not race itself, or a change can be silently dropped.
function queueHistoryWork(operation) {
  const task = historyWork.catch(() => {}).then(operation);
  historyWork = task.catch(() => {});
  return task;
}

async function recordHistory() {
  return queueHistoryWork(async () => {
    const { history, changed } = recordHistorySamples({ data: await readData(), history: await readHistory(), now: Date.now() });
    // Nothing changed (every quota's reading matched its last recorded
    // point, and retention had nothing to prune): skip the write entirely,
    // rather than rewriting an identical file every refresh cycle forever.
    return changed ? writeHistory(history) : history;
  });
}

async function saveHistoryRetention(retentionDays) {
  await queueHistoryWork(async () => writeHistory(setRetentionDays(await readHistory(), retentionDays)));
  notifyUsageChanged();
  return readUiState();
}

async function clearHistory() {
  await queueHistoryWork(async () => writeHistory({ ...(await readHistory()), samples: {} }));
  notifyUsageChanged();
  return readUiState();
}

// Mirrors settleAlertsAfterPrivacyChange's reasoning, but history has no
// "settle to the frozen value" case to worry about: a chart is only ever
// read, never re-announced, so a provider whose usage survives a disconnect
// can safely keep its trend exactly as it already stands.
async function forgetHistoryAfterPrivacyChange(providerIds) {
  await queueHistoryWork(async () => writeHistory(forgetProviderHistory(await readHistory(), providerIds)));
}

async function exportHistory() {
  const history = await readHistory();
  const target = windowRef ?? undefined;
  const { canceled, filePath } = await dialog.showSaveDialog(target, {
    title: 'Export usage history',
    defaultPath: `aiwidgets-history-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { exported: false };
  await writeFile(filePath, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
  return { exported: true, filePath };
}

async function silenceProviderAlerts(providerId) {
  if (!PROVIDER_IDS.includes(providerId)) throw new Error('Invalid provider.');
  // Silencing must take effect immediately even if evaluateAlerts has not yet
  // run a cycle to create the failing episode itself — otherwise the click
  // would be a silent no-op and the alert would still fire on the next cycle.
  const collector = await readCollector();
  await queueAlertWork(async () => writeAlertState(silenceFailureAlert(await readAlertState(), providerId, collector)));
  notifyUsageChanged();
  return readUiState();
}

// Disconnecting or resetting can hand the same provider to a different
// account, so its silenced failure episode must not carry over. A quota whose
// usage was deleted has nothing left to track; one whose reading survives
// (disconnect without deleting usage keeps the last known percentage on
// screen) must be settled to match that frozen value rather than forgotten —
// forgetting it would reset its ladder to zero and the very next evaluation
// would re-announce the unchanged reading as if it were new.
async function settleAlertsAfterPrivacyChange(providerIds, data) {
  await queueAlertWork(async () => writeAlertState(settleProviderAlerts({ data, alertState: await readAlertState(), providerIds })));
}

async function disconnectProvider(providerId, clearUsage = false) {
  if (!PROVIDER_IDS.includes(providerId)) throw new Error('Invalid provider.');
  return runPrivacyOperation([providerId], async () => {
    if (PAGE_PROVIDER_IDS.includes(providerId)) await clearProviderSession(providerId);
    if (providerId === 'deepseek') await deleteDeepSeekApiKey();
    const collector = await readCollector();
    const defaults = defaultCollector();
    if (providerId === 'copilot') collector.providers.copilot = defaults.providers.copilot;
    else collector.providers[providerId] = defaults.providers[providerId];
    await writeCollector(collector);
    const { data } = await withUsageData((current) => disconnectUsageData(current, providerId, clearUsage));
    await settleAlertsAfterPrivacyChange([providerId], data);
    // The trend chart follows the same choice as the metrics it is drawn
    // from: preserving usage preserves its history too, deleting it deletes both.
    if (clearUsage) await forgetHistoryAfterPrivacyChange([providerId]);
    notifyCollectorChanged();
    notifyUsageChanged();
    return readUiState();
  });
}

async function resetFirstTimeSetup(clearUsage = false) {
  return runPrivacyOperation(PROVIDER_IDS, async () => {
    await clearCollectorPartition();
    await deleteDeepSeekApiKey();
    await writeCollector(defaultCollector());
    const { data } = await withUsageData((current) => resetFirstRunData(current, clearUsage));
    await settleAlertsAfterPrivacyChange(PROVIDER_IDS, data);
    if (clearUsage) await forgetHistoryAfterPrivacyChange(PROVIDER_IDS);
    notifyCollectorChanged();
    notifyUsageChanged();
    return readUiState();
  });
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
  const { data } = await withUsageData((current) => {
    current.settings.enabledProviders = ids.filter((id) => Object.hasOwn(PROVIDERS, id));
    if (completeOnboarding) current.settings.onboardingComplete = true;
    return current;
  });
  notifyUsageChanged();
  if (data.settings.enabledProviders.includes('copilot')) refreshProvider('copilot').catch(() => {});
  return data;
}

async function saveAlertSettings(alerts) {
  await withUsageData((current) => {
    // normaliseUsageData already ran the incoming block through
    // normaliseAlertSettings, so an unknown cadence or provider cannot survive.
    current.settings.alerts = normaliseUsageData({ ...current, settings: { ...current.settings, alerts } }).settings.alerts;
    return current;
  });
  notifyUsageChanged();
  return readUiState();
}

async function enableProvider(providerId) {
  const { data, changed } = await withUsageData((current) => {
    if (current.settings.enabledProviders.includes(providerId)) return null;
    current.settings.enabledProviders.push(providerId);
    return current;
  });
  if (changed) notifyUsageChanged();
  return data;
}

async function applyCollectedUsage(providerId, text, source = 'default') {
  const parsed = parseVisibleUsage(providerId, text, source);
  if (!parsed) return { accepted: false, reason: providerId === 'copilot' && source === 'actions' ? 'No Actions minutes usage was found yet.' : providerId === 'copilot' ? 'No Copilot usage was found yet.' : 'No session or weekly percentage was found on the usage page.' };
  await withUsageData((current) => {
    const provider = current.providers.find((item) => item.id === providerId);
    if (parsed.session) provider.session = { available: parsed.session.available, resetsAt: null, resetLabel: parsed.session.resetLabel || null };
    if (parsed.weekly) provider.weekly = { available: parsed.weekly.available, resetsAt: null, resetLabel: parsed.weekly.resetLabel || null };
    if (parsed.monthly) provider.monthly = { available: parsed.monthly.available, resetsAt: null, resetLabel: parsed.monthly.resetLabel || null, label: parsed.monthly.label || 'Premium requests', ...(Number.isFinite(parsed.monthly.used) ? { used: parsed.monthly.used } : {}), ...(Number.isFinite(parsed.monthly.included) ? { included: parsed.monthly.included } : {}) };
    if (parsed.actionsMinutes) provider.actionsMinutes = parsed.actionsMinutes;
    provider.note = parsed.note;
    return current;
  });
  notifyUsageChanged();
  return { accepted: true, session: parsed.session?.available ?? null, weekly: parsed.weekly?.available ?? null, monthly: parsed.monthly?.available ?? null };
}

async function applyDeepSeekBalance(balance) {
  await withUsageData((current) => {
    const provider = current.providers.find((item) => item.id === 'deepseek');
    provider.balance = mergeDeepSeekBalance(provider.balance, balance);
    provider.note = 'Balance updated from DeepSeek API.';
    return current;
  });
  notifyUsageChanged();
}

async function saveDeepSeekFundedBalance(value) {
  const fundedBalance = Number(value);
  if (!Number.isFinite(fundedBalance) || fundedBalance < 0) throw new Error('Enter a valid funded balance.');
  await withUsageData((current) => {
    const provider = current.providers.find((item) => item.id === 'deepseek');
    if (!provider?.balance) throw new Error('Refresh the DeepSeek balance before setting its funded total.');
    if (fundedBalance < provider.balance.totalBalance) throw new Error('Funded balance cannot be below the available balance.');
    provider.balance = { ...provider.balance, fundedBalance, included: fundedBalance, used: fundedBalance - provider.balance.totalBalance };
    return current;
  });
  notifyUsageChanged();
  return readUiState();
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
  if (isPrivacyProtected('copilot') || win.isDestroyed() || !win.isVisible() || providerConnectionInFlight.has(key)) return;
  const currentUrl = win.webContents.getURL();
  if (!isCanonicalUsageUrl('copilot', currentUrl)) {
    if (isProviderOrigin('copilot', currentUrl) && !/\/(?:login|sessions?)(?:\/|$)/i.test(new URL(currentUrl).pathname)) {
      await win.loadURL(sourceStartUrl('copilot', 'premium')).catch(() => {});
    }
    return;
  }
  let finishConnection;
  const connection = new Promise((resolve) => { finishConnection = resolve; });
  providerConnectionInFlight.set(key, connection);
  try {
    await recordCollectorAttempt('copilot', 'Reading Copilot usage from the signed-in GitHub account.', 'premium');
    const premium = await applyCollectedUsage('copilot', await extractSettledUsageText('copilot', win.webContents, 'premium'), 'premium');
    if (!premium.accepted) {
      await setCollectorStatus('copilot', 'Signed in; waiting for Copilot usage to finish loading.', null, 'premium');
      scheduleProviderRetry(key, () => autoConnectCopilot(win));
      return;
    }
    clearProviderRetry(key);
    await enableProvider('copilot');
    let config = await readCollector();
    const premiumEntry = collectorEntry(config, 'copilot', 'premium');
    Object.assign(premiumEntry, withCollectorSuccess({ ...premiumEntry, configured: true, url: win.webContents.getURL() }, 'Copilot usage connected and updated automatically.'));
    Object.assign(collectorEntry(config, 'copilot', 'actions'), { configured: true, url: sourceStartUrl('copilot', 'actions'), status: 'Reading Actions minutes.' });
    await writeCollector(config);
    notifyCollectorChanged();

    try {
      await recordCollectorAttempt('copilot', 'Reading Actions minutes.', 'actions');
      const actionsWindow = createProviderWindow('copilot', false, 'actions');
      await actionsWindow.loadURL(sourceStartUrl('copilot', 'actions'));
      await selectProviderView('copilot', 'actions', actionsWindow.webContents);
      const actions = await applyCollectedUsage('copilot', await extractSettledUsageText('copilot', actionsWindow.webContents, 'actions'), 'actions');
      config = await readCollector();
      const actionsEntry = collectorEntry(config, 'copilot', 'actions');
      Object.assign(actionsEntry, actions.accepted
        ? withCollectorSuccess(actionsEntry, 'Actions minutes connected and updated automatically.')
        : withCollectorFailure(actionsEntry, actions.reason, actions.reason));
      await writeCollector(config);
      notifyCollectorChanged();
    } catch (error) {
      await setCollectorFailure('copilot', error, `Could not read Actions minutes: ${error.message}`, 'actions');
    }
    win.hide();
    showControlCenter();
  } catch (error) {
    await setCollectorFailure('copilot', error, `Could not read GitHub billing: ${error.message}`, 'premium');
  } finally {
    providerConnectionInFlight.delete(key);
    finishConnection();
  }
}

async function autoConnectProvider(providerId, source, win) {
  if (providerId === 'copilot') return autoConnectCopilot(win);
  if (isPrivacyProtected(providerId) || win.isDestroyed() || !win.isVisible()) return;
  const key = `${providerId}:${source}`;
  if (providerConnectionInFlight.has(key)) return;
  const currentUrl = win.webContents.getURL();
  if (!isCanonicalUsageUrl(providerId, currentUrl)) {
    if (isProviderOrigin(providerId, currentUrl) && !/\/(?:auth|login|oauth)(?:\/|$)/i.test(new URL(currentUrl).pathname)) {
      await win.loadURL(sourceStartUrl(providerId, source)).catch(() => {});
    }
    return;
  }
  let finishConnection;
  const connection = new Promise((resolve) => { finishConnection = resolve; });
  providerConnectionInFlight.set(key, connection);
  try {
    await recordCollectorAttempt(providerId, 'Reading usage from the signed-in account.', source);
    const result = await applyCollectedUsage(providerId, await extractSettledUsageText(providerId, win.webContents, source), source);
    const config = await readCollector();
    const entry = collectorEntry(config, providerId, source);
    if (result.accepted) {
      clearProviderRetry(key);
      await enableProvider(providerId);
      Object.assign(entry, withCollectorSuccess({ ...entry,
        configured: true,
        url: win.webContents.getURL(),
      }, 'Connected and updated automatically.'));
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
    await setCollectorFailure(providerId, error, `Could not read usage yet: ${error.message}`, source);
  } finally {
    providerConnectionInFlight.delete(key);
    finishConnection();
  }
}

function createProviderWindow(providerId, show, source = 'default') {
  if (isPrivacyProtected(providerId)) throw new Error('This provider is being disconnected.');
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
  Object.assign(entry, lastSync ? withCollectorSuccess(entry, status, lastSync) : { ...entry, status });
  await writeCollector(config);
  notifyCollectorChanged();
  return config;
}

async function recordCollectorAttempt(providerId, status, source = 'default') {
  const config = await readCollector();
  const entry = collectorEntry(config, providerId, source);
  Object.assign(entry, withCollectorAttempt(entry, status));
  await writeCollector(config);
  notifyCollectorChanged();
  return config;
}

async function setCollectorFailure(providerId, error, status, source = 'default') {
  const config = await readCollector();
  const entry = collectorEntry(config, providerId, source);
  Object.assign(entry, withCollectorFailure(entry, error, status));
  await writeCollector(config);
  notifyCollectorChanged();
  return config;
}

async function refreshPageProviderNow(providerId, source = 'default') {
  if (isPrivacyProtected(providerId)) return readCollector();
  const config = await readCollector();
  const entry = collectorEntry(config, providerId, source);
  if (!entry.configured || !entry.url) return config;
  const visible = providerWindows.get(`${providerId}:${source}`);
  if (visible && !visible.isDestroyed() && visible.isVisible()) return config;
  const win = createProviderWindow(providerId, false, source);
  try {
    await recordCollectorAttempt(providerId, 'Refreshing usage…', source);
    await win.loadURL(sourceUrl(providerId, source, entry));
    if (isProviderAuthenticationUrl(providerId, win.webContents.getURL())) {
      return setCollectorFailure(providerId, `Sign in to ${PROVIDERS[providerId].name} to refresh usage.`, 'Session expired; reconnect required.', source);
    }
    await selectProviderView(providerId, source, win.webContents);
    const result = await applyCollectedUsage(providerId, await extractSettledUsageText(providerId, win.webContents, source), source);
    return result.accepted
      ? setCollectorStatus(providerId, 'Updated automatically.', new Date().toISOString(), source)
      : setCollectorFailure(providerId, result.reason, result.reason, source);
  } catch (error) { return setCollectorFailure(providerId, error, `Could not update: ${error.message}`, source); }
}

function refreshPageProvider(providerId, source = 'default') {
  if (isPrivacyProtected(providerId)) return readCollector();
  const key = `${providerId}:${source}`;
  const active = providerRefreshInFlight.get(key);
  if (active) return active;
  const task = refreshPageProviderNow(providerId, source);
  providerRefreshInFlight.set(key, task);
  task.finally(() => {
    if (providerRefreshInFlight.get(key) === task) providerRefreshInFlight.delete(key);
  }).catch(() => {});
  return task;
}

async function refreshCopilotProvider() {
  await Promise.all(['premium', 'actions'].map((source) => refreshPageProvider('copilot', source)));
  return readCollector();
}

async function refreshDeepSeekProviderNow() {
  if (isPrivacyProtected('deepseek')) return readCollector();
  const key = await readDeepSeekApiKey();
  if (!key) return setCollectorFailure('deepseek', { code: 'api-key-missing', message: 'API key is unavailable; connect DeepSeek again.' }, 'API key unavailable; reconnect required.');
  try {
    await recordCollectorAttempt('deepseek', 'Refreshing balance…');
    await applyDeepSeekBalance(await fetchDeepSeekBalance(key));
    return setCollectorStatus('deepseek', 'Updated automatically.', new Date().toISOString());
  } catch (error) {
    return setCollectorFailure('deepseek', error, `Could not update balance: ${error.message}`);
  }
}

function refreshDeepSeekProvider() {
  if (isPrivacyProtected('deepseek')) return readCollector();
  const active = providerRefreshInFlight.get('deepseek:api');
  if (active) return active;
  const task = refreshDeepSeekProviderNow();
  providerRefreshInFlight.set('deepseek:api', task);
  task.finally(() => { if (providerRefreshInFlight.get('deepseek:api') === task) providerRefreshInFlight.delete('deepseek:api'); }).catch(() => {});
  return task;
}

async function connectDeepSeek(apiKey) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) throw new Error('Enter a DeepSeek API key.');
  if (key.length > 1000) throw new Error('The API key is too long.');
  // Connecting writes the same credential and collector state that a privacy
  // action removes. One queue prevents an in-flight Connect from recreating
  // the key just after Disconnect or Reset has removed it.
  await runPrivacyOperation(['deepseek'], async () => {
    await saveDeepSeekApiKey(key);
    const config = await readCollector();
    Object.assign(config.providers.deepseek, { configured: true, url: 'https://api.deepseek.com/user/balance', status: 'API key saved. Refreshing balance…', error: null });
    await writeCollector(config);
    await enableProvider('deepseek');
    notifyCollectorChanged();
  });
  await refreshDeepSeekProvider();
  return readUiState();
}

async function refreshProvider(providerId, source = 'default') {
  if (providerId === 'deepseek') return refreshDeepSeekProvider();
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
    // Alerts and history are both decided once the cycle has written every
    // provider, so they judge the same snapshot instead of a partial refresh.
    await evaluateAlerts().catch(() => {});
    await recordHistory().catch(() => {});
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
  if (isPrivacyProtected(providerId)) throw new Error('This provider is being disconnected.');
  const key = `${providerId}:${source}`;
  const active = providerOpenInFlight.get(key);
  if (active) return active;
  const task = (async () => {
    clearProviderRetry(key);
    const config = await readCollector();
    if (isPrivacyProtected(providerId)) return readCollector();
    const entry = collectorEntry(config, providerId, source);
    entry.status = `Sign in to ${PROVIDERS[providerId].name}; AI Widgets will connect automatically.`;
    await writeCollector(config);
    notifyCollectorChanged();
    if (isPrivacyProtected(providerId)) return readCollector();
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
    if (isPrivacyProtected(providerId)) { if (!win.isDestroyed()) win.destroy(); return readCollector(); }
    win.show(); win.focus();
    autoConnectProvider(providerId, source, win).catch(() => {});
    return readCollector();
  })();
  providerOpenInFlight.set(key, task);
  task.finally(() => {
    if (providerOpenInFlight.get(key) === task) providerOpenInFlight.delete(key);
  }).catch(() => {});
  return task;
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
  if (automaticRefreshEnabled) {
    refreshAllProviders().catch(() => {});
    setInterval(() => { refreshAllProviders().catch(() => {}); }, 60_000);
  }
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

ipcMain.handle('usage:read', readUiState);
ipcMain.handle('providers:save-enabled', (_event, ids, completeOnboarding) => saveEnabledProviders(ids, completeOnboarding === true));
ipcMain.handle('collector:info', readCollector);
ipcMain.handle('collector:open', (_event, providerId, source) => PAGE_PROVIDER_IDS.includes(providerId)
  ? openProvider(providerId, normaliseProviderSource(providerId, source))
  : Promise.reject(new Error('Invalid page provider.')));
ipcMain.handle('collector:refresh', refreshAllProviders);
ipcMain.handle('collector:refresh-provider', (_event, providerId) => PAGE_PROVIDER_IDS.includes(providerId)
  ? refreshProvider(providerId)
  : API_PROVIDER_IDS.includes(providerId) ? refreshProvider(providerId) : Promise.reject(new Error('Invalid provider.')));
ipcMain.handle('collector:disconnect', (_event, providerId, clearUsage) => disconnectProvider(providerId, clearUsage === true));
ipcMain.handle('deepseek:connect', (_event, apiKey) => connectDeepSeek(apiKey));
ipcMain.handle('deepseek:save-funded', (_event, fundedBalance) => saveDeepSeekFundedBalance(fundedBalance));
ipcMain.handle('onboarding:reset', (_event, clearUsage) => resetFirstTimeSetup(clearUsage === true));
ipcMain.handle('alerts:save', (_event, alerts) => saveAlertSettings(alerts));
ipcMain.handle('alerts:silence', (_event, providerId) => silenceProviderAlerts(providerId));
ipcMain.handle('alerts:supported', () => Notification.isSupported());
ipcMain.handle('history:save-retention', (_event, retentionDays) => saveHistoryRetention(retentionDays));
ipcMain.handle('history:clear', clearHistory);
ipcMain.handle('history:export', exportHistory);
ipcMain.on('window:resize-control', (_event, height) => resizeControlWindow(height));
ipcMain.handle('window:minimize', () => windowRef?.minimize());
ipcMain.handle('window:close', () => windowRef?.hide());
ipcMain.handle('desktop-widget:state', desktopWidgetState);
ipcMain.handle('desktop-integration:state', gnomeIntegrationState);
ipcMain.handle('desktop-integration:enable', enableGnomeIntegration);
ipcMain.handle('desktop-widget:refresh', async () => { await refreshAllProviders(); return desktopWidgetState(); });
ipcMain.handle('desktop-widget:toggle-visible', () => setDesktopLayout({ desktopVisible: !desktopLayout.desktopVisible }));
ipcMain.handle('desktop-widget:set-editing', (_event, editing) => setDesktopLayout({ editing: Boolean(editing), desktopVisible: true }));
ipcMain.handle('desktop-widget:anchor', () => setDesktopLayout({ autoPosition: true, x: null, y: null }));
ipcMain.handle('desktop-widget:resize', (_event, delta) => adjustDesktopWidgetWidth(delta));
ipcMain.on('desktop-widget:resize-panel', (_event, size) => {
  const height = typeof size === 'object' ? size?.height : size;
  const width = typeof size === 'object' ? size?.width : undefined;
  resizeTrayPopover(height, width);
});
ipcMain.handle('desktop-widget:set-panel-layout', (_event, panelLayout) => setDesktopLayout({ panelLayout }));
ipcMain.handle('desktop-widget:open-settings', () => { trayPopoverRef?.hide(); showControlCenter(); });
ipcMain.handle('desktop-widget:exit', requestQuit);
