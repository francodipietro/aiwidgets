import { providerConnectionHealth } from './collector-health.mjs';
import { FAILING_HEALTH_STATES, FAILURE_MINUTES_CHOICES, PROVIDER_QUOTAS, parseResetLabel } from './alerts.mjs';
import { RETENTION_DAYS_CHOICES, minMax, sparklineGeometry } from './history.mjs';

const app = document.querySelector('#app');
let state;
let integrating = false;
let connectingDeepSeek = false;
let editingDeepSeekFunding = false;
let managingProviders = false;
let setupProviderIds = null;
let onboardingError = '';
let privacyConfirmation = null;
let privacyError = '';
let managingAlerts = false;
let alertsSupported = true;
// Held while the panel is open so a background refresh re-rendering the form
// cannot quietly revert a choice the user has made but not saved yet.
let alertDraft = null;
let managingHistory = false;
let historyStatus = '';
let timer;
let lastRequestedHeight;
let enablingDesktopIntegration = false;
let desktopIntegrationError = '';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[char]));
const percentage = (usage) => usage ? Math.round(usage.available) : null;
const resetText = (usage) => {
  const label = usage?.resetLabel;
  if (label) {
    const timestamp = parseResetLabel(label);
    if (!Number.isFinite(timestamp) || timestamp >= Date.now() - 60_000) return label;
  }
  if (usage?.resetsAt) {
    const timestamp = Date.parse(usage.resetsAt);
    if (Number.isFinite(timestamp) && timestamp >= Date.now() - 60_000) return `Resets ${new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp))}`;
  }
  return 'No reset date';
};
const meter = (usage, label) => {
  const available = percentage(usage);
  if (available === null) return `<section class="usage unavailable"><span>${label}</span><strong>—</strong><small>no data</small></section>`;
  const consumed = 100 - available;
  return `<section class="usage"><span>${label}</span><div class="figure"><strong>${consumed}%</strong><div><b>consumed</b><small>${available}% available</small></div></div><div class="bar"><i style="width:${consumed}%"></i></div><small>${resetText(usage)}</small></section>`;
};

const money = (value, currency) => new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
const balanceMeter = (balance) => {
  if (!balance) return `<section class="usage unavailable"><span>API balance</span><strong>—</strong><small>no data</small></section>`;
  const total = Number(balance.included);
  const available = Number(balance.totalBalance);
  const used = Number(balance.used);
  if (![total, available, used].every(Number.isFinite) || total <= 0) return `<section class="usage unavailable"><span>API balance</span><strong>${escapeHtml(money(available || 0, balance.currency || 'USD'))}</strong><small>No funded balance yet</small></section>`;
  const consumed = Math.max(0, Math.min(100, used / total * 100));
  return `<section class="usage deepseek-balance"><span>API balance</span><div class="balance-figure"><div><strong>${Math.round(consumed)}%</strong><b>used</b></div><div class="balance-available"><strong>${escapeHtml(money(available, balance.currency))}</strong><b>available</b></div></div><div class="bar"><i style="width:${consumed}%"></i></div><small>${escapeHtml(money(used, balance.currency))} used of ${escapeHtml(money(total, balance.currency))}</small></section>`;
};

const formatNumber = (value) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
const actionsMeter = (usage) => {
  const available = percentage(usage);
  if (available === null) return `<section class="usage unavailable"><span>Actions minutes</span><strong>—</strong><small>no data</small></section>`;
  const consumed = 100 - available;
  const quantity = Number.isFinite(usage.used) && Number.isFinite(usage.included)
    ? `<strong>${consumed}%</strong><div><b>used</b><small>${formatNumber(usage.used)} / ${formatNumber(usage.included)} min</small></div>`
    : `<strong>${consumed}%</strong><div><b>consumed</b><small>${available}% available</small></div>`;
  const billed = Number.isFinite(usage.billedAmount) ? `<small class="billed">Billed this month: $${usage.billedAmount.toFixed(2)}</small>` : '';
  return `<section class="usage"><span>Actions minutes</span><div class="figure">${quantity}</div><div class="bar"><i style="width:${consumed}%"></i></div><small>${available}% available</small><small>${resetText(usage)}</small>${billed}</section>`;
};

const providerLogo = (id) => {
  if (id === 'deepseek') return '<img class="provider-logo deepseek" src="../imgs/logo_deepseek.svg" alt="DeepSeek" />';
  const logo = id === 'codex' ? 'chatgpt.svg' : id === 'copilot' ? 'copilot.png' : 'claude.svg';
  return `<img class="provider-logo ${id}" src="../imgs/logo_${logo}" alt="" />`;
};

const activeProviderIds = () => new Set(state.settings.enabledProviders);

function alertsEnabledFor(providerId) {
  return state.settings?.alerts?.providers?.[providerId]?.enabled === true
    && state.settings?.alerts?.failureMinutes !== null;
}

function card(provider) {
  const health = providerConnectionHealth(state.collector, provider.id);
  const apiConnect = provider.id === 'deepseek' ? `<button class="connect-api" data-action="set-deepseek-funding">Funding</button><button class="connect-api" data-action="connect-deepseek">${state.collector?.providers?.deepseek?.configured ? 'API key' : 'Connect'}</button>` : '';
  const reconnect = health.state === 'expired' ? ' <button class="health-action" data-action="integrate">Reconnect</button>' : '';
  // Offer to stop the repeating failure alert only while one can actually be
  // firing: alerts on for this provider, a failing state, and not yet silenced.
  const silenceable = alertsEnabledFor(provider.id)
    && FAILING_HEALTH_STATES.has(health.state)
    && state.alertState?.failures?.[provider.id]?.silenced !== true;
  const silence = silenceable ? ` <button class="health-action" data-action="silence-alerts" data-provider="${provider.id}" title="Stop repeating this alert until ${escapeHtml(provider.name)} updates again">Silence</button>` : '';
  return `<article class="card ${provider.id}" style="--accent:${escapeHtml(provider.accent)}">
    <div class="card-heading">${providerLogo(provider.id)}<h1>${escapeHtml(provider.name)}</h1>${apiConnect}<button class="refresh" data-action="refresh-provider" data-provider="${provider.id}" title="Refresh ${escapeHtml(provider.name)}">↻</button></div>
    <div class="usage-row ${provider.id === 'deepseek' ? 'single-usage' : ''}">${provider.id === 'copilot' ? `${meter(provider.monthly, provider.monthly?.label || 'Premium requests')}${actionsMeter(provider.actionsMinutes)}` : provider.id === 'deepseek' ? balanceMeter(provider.balance) : `${meter(provider.session, 'Session')}${meter(provider.weekly, 'Weekly')}`}</div>
    <p class="note health ${health.state}">${escapeHtml(health.message)}${reconnect}${silence}</p>
  </article>`;
}

function desktopIntegrationNotice() {
  const integration = state.desktopIntegration;
  if (!integration?.supported || (integration.enabled && !integration.needsMigration)) return '';
  const migrating = integration.needsMigration === true;
  return `<section class="desktop-integration"><div><b>${migrating ? 'Update GNOME desktop integration' : 'Enable GNOME desktop integration'}</b><small>${migrating ? 'Replace the older per-user extension with the version included in this AI Widgets package.' : 'The installed AI Widgets package includes the top-panel menu and desktop cards.'}</small>${desktopIntegrationError ? `<small class="desktop-integration-error">${escapeHtml(desktopIntegrationError)}</small>` : ''}</div><button data-action="enable-desktop-integration" ${enablingDesktopIntegration ? 'disabled' : ''}>${enablingDesktopIntegration ? 'Working…' : migrating ? 'Use bundled version' : 'Enable'}</button></section>`;
}

function integrationPanel(providerIds = ['claude', 'codex', 'copilot', 'deepseek']) {
  const info = state.collector;
  if (!info) return '<section id="integration"><p>Loading account connection…</p></section>';
  const row = (id) => {
    const provider = info.providers[id];
    const health = providerConnectionHealth(info, id);
    if (id === 'deepseek') {
      const lastSync = provider.lastSync ? new Intl.DateTimeFormat('en-US', { timeStyle: 'short', dateStyle: 'short' }).format(new Date(provider.lastSync)) : 'not updated yet';
      return `<article class="account-row"><div><h3>DeepSeek API</h3><p>${escapeHtml(health.message)}</p><small>${provider.configured ? `API key stored securely · ${lastSync}` : 'Not connected yet.'}</small></div><div class="account-actions"><button data-action="connect-deepseek">${provider.configured ? 'Replace API key' : 'Connect DeepSeek'}</button>${provider.configured ? '<button class="danger" data-action="disconnect-provider" data-provider="deepseek">Disconnect</button>' : ''}</div><small class="account-destination">API balance · key encrypted locally</small></article>`;
    }
    if (id === 'copilot') {
      const lastSync = [provider.premium, provider.actions].map((source) => source.lastSync).filter(Boolean).sort().at(-1);
      const updated = lastSync ? new Intl.DateTimeFormat('en-US', { timeStyle: 'short', dateStyle: 'short' }).format(new Date(lastSync)) : 'not updated yet';
      const connected = provider.premium.configured || provider.actions.configured;
      return `<article class="account-row"><div><h3>GitHub Copilot</h3><p>${escapeHtml(health.message)}</p><small>${connected ? `Connected GitHub account · ${updated}` : 'Not connected yet.'}</small></div><div class="account-actions"><button data-action="open-provider" data-provider="copilot" data-source="premium">${connected ? 'Reconnect GitHub' : 'Connect GitHub'}</button>${connected ? '<button class="danger" data-action="disconnect-provider" data-provider="copilot">Disconnect</button>' : ''}</div><small class="account-destination">Premium requests and Actions minutes</small></article>`;
    }
    const lastSync = provider.lastSync ? new Intl.DateTimeFormat('en-US', { timeStyle: 'short', dateStyle: 'short' }).format(new Date(provider.lastSync)) : 'not updated yet';
    const name = state.providers.find((item) => item.id === id)?.name || id;
    const destination = 'Settings / Usage';
    return `<article class="account-row"><div><h3>${escapeHtml(name)}</h3><p>${escapeHtml(health.message)}</p><small>${provider.configured ? `Connected account · ${lastSync}` : 'Not connected yet.'}</small></div><div class="account-actions"><button data-action="open-provider" data-provider="${id}">${provider.configured ? `Reconnect ${escapeHtml(name)}` : `Connect ${escapeHtml(name)}`}</button>${provider.configured ? `<button class="danger" data-action="disconnect-provider" data-provider="${id}">Disconnect</button>` : ''}</div><small class="account-destination">${destination}</small></article>`;
  };
  const selectedSetup = setupProviderIds !== null;
  return `<section id="integration"><h2>${selectedSetup ? 'Connect selected accounts' : 'Connect subscriptions'}</h2>
    <p>Sign in once to each account, or connect DeepSeek with an API key. Browser sessions and API keys stay local to AI Widgets.</p>
    ${providerIds.map(row).join('')}
    <footer><button data-action="refresh-providers">Update now</button></footer>
    <p class="bridge-status">Sessions stay local to AI Widgets. Configured sources are refreshed every minute; conversations and page text are not retained.</p>
  </section>`;
}

function deepSeekConnectPanel() {
  return `<form id="deepseek-connect" class="setup-panel"><h2>Connect DeepSeek API</h2><p>Paste an API key with permission to read your balance. It is encrypted with your operating system's secure storage and saved separately from usage data.</p><label class="api-key-field"><span>DeepSeek API key</span><input name="api-key" type="password" autocomplete="off" required /></label>${onboardingError ? `<p class="form-error">${escapeHtml(onboardingError)}</p>` : ''}<footer><button type="button" data-action="cancel-deepseek">Cancel</button><button class="primary" type="submit">Connect</button></footer></form>`;
}

function deepSeekFundingPanel() {
  const balance = state.providers.find((provider) => provider.id === 'deepseek')?.balance;
  const current = Number.isFinite(balance?.fundedBalance) ? balance.fundedBalance : balance?.totalBalance;
  return `<form id="deepseek-funding" class="setup-panel"><h2>DeepSeek funded balance</h2><p>Set the total amount funded so far in ${escapeHtml(balance?.currency || 'USD')}. AI Widgets derives usage from this total and automatically adds future balance increases as top-ups.</p><label class="api-key-field"><span>Total funded (${escapeHtml(balance?.currency || 'USD')})</span><input name="funded-balance" type="number" min="0" step="0.01" value="${Number.isFinite(current) ? current : ''}" required /></label>${onboardingError ? `<p class="form-error">${escapeHtml(onboardingError)}</p>` : ''}<footer><button type="button" data-action="cancel-deepseek-funding">Cancel</button><button class="primary" type="submit">Save funded balance</button></footer></form>`;
}

function onboardingPanel() {
  return `<form id="onboarding" class="setup-panel"><h2>Choose providers</h2>
    <p>Select the AI services whose usage you want to see. Nothing is enabled until you choose it; the next step lets you sign in to each selected account.</p>
    ${state.providers.map((provider) => `<label class="provider-choice"><input type="checkbox" name="provider" value="${provider.id}" /><span>${providerLogo(provider.id)}</span><span><b>${escapeHtml(provider.name)}</b><small>${provider.id === 'copilot' ? 'Premium requests and Actions minutes' : provider.id === 'deepseek' ? 'API balance via encrypted API key' : 'Session and weekly usage'}</small></span></label>`).join('')}
    ${onboardingError ? `<p class="form-error">${escapeHtml(onboardingError)}</p>` : ''}
    <footer><button class="primary" type="submit">Continue to sign in</button></footer>
  </form>`;
}

function providerPanel() {
  const selected = activeProviderIds();
  return `<form id="provider-settings"><h2>Visible providers</h2><p>Only selected providers are shown in the app, desktop widget, and panel menu. Selected providers are also the only ones refreshed automatically.</p>
    ${state.providers.map((provider) => `<label class="provider-choice"><input type="checkbox" name="provider" value="${provider.id}" ${selected.has(provider.id) ? 'checked' : ''} /><span>${providerLogo(provider.id)}</span><span><b>${escapeHtml(provider.name)}</b><small>${provider.id === 'copilot' ? 'Premium requests and Actions minutes' : provider.id === 'deepseek' ? 'API balance via encrypted API key' : 'Session and weekly usage'}</small></span></label>`).join('')}
    <footer><button type="button" data-action="cancel-providers">Cancel</button><button type="button" class="danger" data-action="reset-onboarding">Reset first-time setup</button><button class="primary" type="submit">Save providers</button></footer>
  </form>`;
}

function alertPanel() {
  const alerts = alertDraft ?? state.settings.alerts;
  const quotaSummary = (providerId) => providerId === 'deepseek'
    ? `when available balance is at or below ${alerts.deepseekLowBalance}`
    : PROVIDER_QUOTAS[providerId]
    .map((quota) => `${quota.label} at ${quota.steps.join('%, ')}%`)
    .join(' · ');
  const failureChoice = (minutes, label) => `<option value="${minutes ?? ''}" ${alerts.failureMinutes === minutes ? 'selected' : ''}>${label}</option>`;
  return `<form id="alert-settings"><h2>Usage alerts</h2>
    <p>A local notification when a quota crosses a threshold, once per quota and reset period. Nothing is sent anywhere; alerts are off until you turn them on.</p>
    ${state.providers.map((provider) => `<label class="provider-choice"><input type="checkbox" name="alert-provider" value="${provider.id}" ${alerts.providers[provider.id]?.enabled ? 'checked' : ''} /><span>${providerLogo(provider.id)}</span><span><b>${escapeHtml(provider.name)}</b><small>${escapeHtml(quotaSummary(provider.id))}</small></span></label>`).join('')}
    <label class="alert-cadence"><span>DeepSeek low-balance threshold</span><input name="deepseek-low-balance" type="number" min="0" step="0.01" value="${escapeHtml(alerts.deepseekLowBalance)}" /></label>
    <label class="alert-cadence"><span>Tell me when a provider stops updating</span><select name="failure-minutes">
      ${failureChoice(null, 'Never')}
      ${FAILURE_MINUTES_CHOICES.map((minutes) => failureChoice(minutes, `After ${minutes} min, repeating`)).join('')}
    </select></label>
    <p class="alert-note">${alertsSupported
      ? 'A failing provider keeps reminding you at that interval until it updates again or you silence it from its card.'
      : 'This system does not accept notifications from AI Widgets, so nothing will be shown.'}</p>
    <p class="alert-note">If notifications are turned off for AI Widgets in your operating system settings, these alerts stay silent and the app cannot tell.</p>
    <footer><button type="button" data-action="cancel-alerts">Cancel</button><button class="primary" type="submit">Save alerts</button></footer>
  </form>`;
}

// A compact, axis-less trend line: x is spaced by real elapsed time (not by
// sample index), so an uneven gap between two readings — the app closed for a
// week, say — reads as a long flat stretch instead of being silently
// compressed to the same width as any other step. Hit circles are sized to
// the accessibility floor (>=24px) even though the visible marks are much
// smaller, and carry a native <title> so the exact reading and time are
// reachable on hover without any custom tooltip code. The geometry itself
// (the real-time axis, the flat-line and zero-span guards, downsampling)
// lives in history.mjs, where it can be tested without a DOM; this function
// only turns that geometry into markup.
function sparkline(points, accent) {
  const geo = sparklineGeometry(points);
  if (!geo) return '<p class="history-empty">Not enough data yet.</p>';
  const { width, height, padX, padY, coords, last, totalCount } = geo;
  const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const line = coords.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const area = `${padX.toFixed(1)},${(height - padY).toFixed(1)} ${line} ${(width - padX).toFixed(1)},${(height - padY).toFixed(1)}`;
  const dots = coords.map((point) => `<circle class="history-hit" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="12"><title>${escapeHtml(dateFormat.format(new Date(point.t)))} — ${point.v}%</title></circle>`).join('');
  return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Trend over ${totalCount} readings, currently ${last.v}%">
    <polygon class="history-area" points="${area}" fill="${escapeHtml(accent)}" />
    <polyline class="history-line" points="${line}" fill="none" stroke="${escapeHtml(accent)}" />
    <circle class="history-end" cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="4" fill="${escapeHtml(accent)}" stroke="#141822" stroke-width="2" />
    ${dots}
  </svg>`;
}

function historyQuotaCard(quota, points) {
  const last = points.at(-1);
  const range = points.length >= 2 ? (() => { const { min, max } = minMax(points.map((point) => point.v)); return `<small class="history-range">${min}%–${max}% over ${points.length} readings</small>`; })() : '';
  return `<div class="history-quota">
    <div class="history-quota-head"><b>${escapeHtml(quota.label)}</b>${last ? `<strong>${last.v}%</strong>` : ''}</div>
    ${sparkline(points, 'var(--accent)')}
    ${range}
  </div>`;
}

function historyPanel() {
  const history = state.history || { retentionDays: 30, samples: {} };
  const providerRows = state.providers
    .filter((provider) => activeProviderIds().has(provider.id))
    .map((provider) => {
      const quotas = PROVIDER_QUOTAS[provider.id] || [];
      const rows = quotas.map((quota) => historyQuotaCard(quota, history.samples[`${provider.id}.${quota.key}`] || [])).join('');
      return `<article class="history-provider" style="--accent:${escapeHtml(provider.accent)}"><h3>${providerLogo(provider.id)}${escapeHtml(provider.name)}</h3><div class="history-quotas">${rows}</div></article>`;
    }).join('');
  return `<section id="history" class="setup-panel"><h2>Usage history</h2>
    <p>A local record of how each quota has moved over time, kept only on this machine. A reading is added whenever a value changes, so the file stays small; nothing is sent anywhere.</p>
    <label class="history-retention"><span>Keep history for</span><select name="history-retention">
      ${RETENTION_DAYS_CHOICES.map((days) => `<option value="${days}" ${history.retentionDays === days ? 'selected' : ''}>${days} days</option>`).join('')}
    </select></label>
    ${history.error ? `<p class="form-error">${escapeHtml(history.error)} — showing what could still be read; nothing has been overwritten.</p>` : ''}
    ${providerRows || '<p class="empty-state">No providers selected.</p>'}
    ${historyStatus ? `<p class="alert-note">${escapeHtml(historyStatus)}</p>` : ''}
    <footer><button type="button" data-action="close-history">Close</button><button type="button" data-action="export-history">Export as JSON…</button><button type="button" class="danger" data-action="clear-history">Clear history</button></footer>
  </section>`;
}

function privacyConfirmationPanel() {
  const resetting = privacyConfirmation?.kind === 'reset';
  const clearingHistory = privacyConfirmation?.kind === 'clear-history';
  const provider = resetting || clearingHistory ? null : state.providers.find((item) => item.id === privacyConfirmation?.providerId);
  const name = provider?.name || 'this provider';
  const title = clearingHistory ? 'Clear usage history?' : resetting ? 'Reset first-time setup?' : `Disconnect ${name}?`;
  const action = clearingHistory ? 'Clear history' : resetting ? 'Reset setup and sign out' : 'Disconnect account';
  const explanation = clearingHistory
    ? 'This permanently deletes the local trend history for every provider. Current usage, connections, and alerts are not affected.'
    : resetting
    ? 'This removes all local provider sessions, cookies, site storage, and connection settings. AI Widgets will return to provider selection on the next screen. No remote account settings are changed.'
    : `This removes the local ${name} session, cookies, site storage, and connection settings. Shared social-login sessions (such as Google, Apple, or Microsoft) are not changed. The provider stays visible so its last saved usage can remain available. No remote account settings are changed.`;
  const usageLabel = resetting ? 'Also delete all saved usage snapshots.' : `Also delete saved ${name} usage data.`;
  return `<form id="privacy-confirmation" class="setup-panel privacy-confirmation"><h2>${escapeHtml(title)}</h2>
    <p>${escapeHtml(explanation)}</p>
    ${clearingHistory ? '' : `<label class="privacy-choice"><input type="checkbox" name="clear-usage" ${privacyConfirmation?.clearUsage ? 'checked' : ''} ${privacyConfirmation?.busy ? 'disabled' : ''}/><span>${escapeHtml(usageLabel)}</span></label>`}
    ${privacyError ? `<p class="form-error">${escapeHtml(privacyError)}</p>` : ''}
    <footer><button type="button" data-action="cancel-privacy" ${privacyConfirmation?.busy ? 'disabled' : ''}>Cancel</button><button class="danger" type="submit" ${privacyConfirmation?.busy ? 'disabled' : ''}>${privacyConfirmation?.busy ? 'Working…' : escapeHtml(action)}</button></footer>
  </form>`;
}

function render() {
  if (!state) return;
  const onboarding = state.settings?.onboardingComplete === false;
  const updated = state.updatedAt ? new Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(state.updatedAt)) : 'not updated yet';
  const visibleProviders = state.providers.filter((provider) => activeProviderIds().has(provider.id));
  const navigation = onboarding
    ? '<button class="minimize" data-action="minimize" title="Minimize">—</button><button class="close" data-action="close" title="Hide window">×</button>'
    : `<button data-action="providers">Providers</button><button data-action="alerts">Alerts</button><button data-action="history">History</button><button data-action="integrate">${integrating ? 'Close connection' : 'Connect accounts'}</button><button class="minimize" data-action="minimize" title="Minimize">—</button><button class="close" data-action="close" title="Hide window">×</button>`;
  app.innerHTML = `<header class="drag"><span class="title">AI Widgets</span><span class="subtitle">${onboarding ? 'First-time setup' : `Settings and connection · ${updated}`}</span><nav class="no-drag">${navigation}</nav></header>
    ${onboarding ? onboardingPanel() : privacyConfirmation ? privacyConfirmationPanel() : connectingDeepSeek ? deepSeekConnectPanel() : editingDeepSeekFunding ? deepSeekFundingPanel() : integrating ? integrationPanel(setupProviderIds ?? undefined) : managingProviders ? providerPanel() : managingAlerts ? alertPanel() : managingHistory ? historyPanel() : `${desktopIntegrationNotice()}<section class="cards">${visibleProviders.map(card).join('') || '<p class="empty-state">No providers selected.</p>'}</section>`}`;
  requestAnimationFrame(() => {
    const height = Math.ceil(app.scrollHeight);
    if (height === lastRequestedHeight) return;
    lastRequestedHeight = height;
    window.aiwidgets?.resizeControl(height);
  });
}

function showError(error) {
  app.innerHTML = `<section id="fatal"><h1>AI Widgets could not start the interface</h1><p>${escapeHtml(error.message || String(error))}</p><p>Restart the app. If the problem persists, install an updated package.</p></section>`;
}

async function load() {
  try {
    if (!window.aiwidgets) throw new Error('The Electron secure bridge did not load.');
    state = await window.aiwidgets.read();
    if (!state.collector || integrating) state.collector = await window.aiwidgets.collectorInfo();
    render();
  } catch (error) { showError(error); }
}
app.addEventListener('click', async (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'refresh-provider') {
    const providerId = event.target.closest('[data-provider]')?.dataset.provider;
    if (providerId) await window.aiwidgets.refreshProvider(providerId);
    return load();
  }
  if (action === 'connect-deepseek') { connectingDeepSeek = true; integrating = false; onboardingError = ''; return render(); }
  if (action === 'cancel-deepseek') { connectingDeepSeek = false; integrating = true; onboardingError = ''; return render(); }
  if (action === 'set-deepseek-funding') { editingDeepSeekFunding = true; onboardingError = ''; return render(); }
  if (action === 'cancel-deepseek-funding') { editingDeepSeekFunding = false; onboardingError = ''; return render(); }
  if (action === 'minimize') return window.aiwidgets.minimize();
  if (action === 'close') return window.aiwidgets.close();
  if (action === 'providers') { managingProviders = !managingProviders; integrating = false; managingAlerts = false; managingHistory = false; setupProviderIds = null; privacyConfirmation = null; return render(); }
  if (action === 'cancel-providers') { managingProviders = false; return render(); }
  if (action === 'alerts') {
    managingAlerts = !managingAlerts; managingProviders = false; integrating = false; managingHistory = false; setupProviderIds = null; privacyConfirmation = null;
    alertDraft = managingAlerts ? structuredClone(state.settings.alerts) : null;
    if (managingAlerts) alertsSupported = await window.aiwidgets.alertsSupported();
    return render();
  }
  if (action === 'cancel-alerts') { managingAlerts = false; alertDraft = null; return render(); }
  if (action === 'silence-alerts') {
    const providerId = event.target.closest('[data-provider]')?.dataset.provider;
    if (providerId) state = await window.aiwidgets.silenceAlerts(providerId);
    return render();
  }
  if (action === 'history') {
    managingHistory = !managingHistory; managingProviders = false; managingAlerts = false; integrating = false; setupProviderIds = null; privacyConfirmation = null; historyStatus = '';
    return render();
  }
  if (action === 'enable-desktop-integration') {
    enablingDesktopIntegration = true; desktopIntegrationError = ''; render();
    try { state.desktopIntegration = await window.aiwidgets.enableDesktopIntegration(); }
    catch (error) { desktopIntegrationError = error.message || 'Could not enable GNOME desktop integration.'; }
    finally { enablingDesktopIntegration = false; }
    return render();
  }
  if (action === 'close-history') { managingHistory = false; historyStatus = ''; return render(); }
  if (action === 'export-history') {
    const result = await window.aiwidgets.exportHistory();
    historyStatus = result.exported ? `Exported to ${result.filePath}.` : '';
    return render();
  }
  if (action === 'clear-history') { privacyConfirmation = { kind: 'clear-history', busy: false }; privacyError = ''; return render(); }
  if (action === 'integrate') { integrating = !integrating; managingProviders = false; managingAlerts = false; managingHistory = false; setupProviderIds = null; privacyConfirmation = null; if (integrating) state.collector = await window.aiwidgets.collectorInfo(); return render(); }
  if (action === 'open-provider') { const target = event.target.closest('[data-provider]'); state.collector = await window.aiwidgets.openProvider(target.dataset.provider, target.dataset.source); return render(); }
  if (action === 'refresh-providers') { await window.aiwidgets.refreshProviders(); return load(); }
  if (action === 'disconnect-provider') {
    privacyConfirmation = { kind: 'disconnect', providerId: event.target.closest('[data-provider]')?.dataset.provider, clearUsage: false, busy: false };
    privacyError = '';
    return render();
  }
  if (action === 'reset-onboarding') { privacyConfirmation = { kind: 'reset', clearUsage: false, busy: false }; privacyError = ''; return render(); }
  if (action === 'cancel-privacy') { privacyConfirmation = null; privacyError = ''; return render(); }
});

app.addEventListener('change', async (event) => {
  if (event.target.name === 'clear-usage' && privacyConfirmation && !privacyConfirmation.busy) {
    privacyConfirmation.clearUsage = event.target.checked;
  }
  if (event.target.name === 'history-retention') {
    // A single control with no other fields on the panel: applied right away
    // rather than staged like the multi-field alert form, so there is no
    // separate "unsaved" state to protect from a background refresh.
    state = await window.aiwidgets.saveHistoryRetention(Number(event.target.value));
    return render();
  }
  if (!alertDraft) return;
  if (event.target.name === 'alert-provider') alertDraft.providers[event.target.value] = { enabled: event.target.checked };
  if (event.target.name === 'failure-minutes') alertDraft.failureMinutes = event.target.value ? Number(event.target.value) : null;
  if (event.target.name === 'deepseek-low-balance') alertDraft.deepseekLowBalance = Number(event.target.value);
});

app.addEventListener('submit', async (event) => {
  if (!['provider-settings', 'onboarding', 'privacy-confirmation', 'alert-settings', 'deepseek-connect', 'deepseek-funding'].includes(event.target.id)) return;
  event.preventDefault();
  if (event.target.id === 'deepseek-connect') {
    try {
      state = await window.aiwidgets.connectDeepSeek(event.target.elements['api-key'].value);
      connectingDeepSeek = false;
      integrating = true;
      onboardingError = '';
      state.collector = await window.aiwidgets.collectorInfo();
      return render();
    } catch (error) {
      onboardingError = `Could not connect DeepSeek: ${error.message || String(error)}`;
      return render();
    }
  }
  if (event.target.id === 'deepseek-funding') {
    try {
      state = await window.aiwidgets.saveDeepSeekFundedBalance(event.target.elements['funded-balance'].value);
      editingDeepSeekFunding = false;
      onboardingError = '';
      return render();
    } catch (error) {
      onboardingError = `Could not save funded balance: ${error.message || String(error)}`;
      return render();
    }
  }
  if (event.target.id === 'alert-settings') {
    state = await window.aiwidgets.saveAlerts(alertDraft ?? state.settings.alerts);
    managingAlerts = false;
    alertDraft = null;
    return render();
  }
  if (event.target.id === 'privacy-confirmation') {
    if (!privacyConfirmation || privacyConfirmation.busy) return;
    privacyConfirmation.clearUsage = event.target.querySelector('input[name="clear-usage"]')?.checked === true;
    privacyConfirmation.busy = true;
    render();
    const returningToHistory = privacyConfirmation.kind === 'clear-history';
    try {
      state = returningToHistory
        ? await window.aiwidgets.clearHistory()
        : privacyConfirmation.kind === 'reset'
        ? await window.aiwidgets.resetOnboarding(privacyConfirmation.clearUsage)
        : await window.aiwidgets.disconnectProvider(privacyConfirmation.providerId, privacyConfirmation.clearUsage);
      privacyConfirmation = null;
      privacyError = '';
      // Clearing history is opened from the history panel itself; land back
      // on it (now empty) instead of the disconnect/reset flows' default of
      // returning to the main card view.
      integrating = false;
      managingProviders = false;
      managingHistory = returningToHistory;
      return render();
    } catch (error) {
      privacyConfirmation.busy = false;
      privacyError = `Could not complete this privacy action: ${error.message || String(error)}`;
      return render();
    }
  }
  const providers = [...event.target.querySelectorAll('input[name="provider"]:checked')].map((input) => input.value);
  if (event.target.id === 'onboarding' && providers.length === 0) {
    onboardingError = 'Choose at least one provider to continue.';
    return render();
  }
  const completingOnboarding = event.target.id === 'onboarding';
  try {
    state = await window.aiwidgets.saveEnabledProviders(providers, completingOnboarding);
    onboardingError = '';
    setupProviderIds = completingOnboarding ? providers : null;
    managingProviders = false;
    integrating = completingOnboarding;
    if (integrating) state.collector = await window.aiwidgets.collectorInfo();
    render();
  } catch (error) {
    if (completingOnboarding) {
      onboardingError = `Could not save your provider selection: ${error.message || String(error)}`;
      render();
      return;
    }
    showError(error);
  }
});

load().then(() => {
  if (!state) return;
  clearInterval(timer);
  timer = setInterval(load, 60_000);
});
window.aiwidgets?.onUsageChanged(() => load());
window.aiwidgets?.onCollectorChanged(() => { if (integrating) load(); });
