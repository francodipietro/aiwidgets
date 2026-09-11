const app = document.querySelector('#app');
let state;
let integrating = false;
let managingProviders = false;
let setupProviderIds = null;
let onboardingError = '';
let timer;
let lastRequestedHeight;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[char]));
const percentage = (usage) => usage ? Math.round(usage.available) : null;
const resetTimestamp = (label) => Date.parse(String(label)
  .replace(/^\s*(?:resets?|renews?)\s*(?:on|at)?\s*/i, '')
  .replace(/\s+at\s+/ig, ' '));
const resetText = (usage) => {
  const label = usage?.resetLabel;
  if (label) {
    const timestamp = resetTimestamp(label);
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
  const logo = id === 'codex' ? 'chatgpt.svg' : id === 'copilot' ? 'copilot.png' : 'claude.svg';
  return `<img class="provider-logo ${id}" src="../imgs/logo_${logo}" alt="" />`;
};

const activeProviderIds = () => new Set(state.settings.enabledProviders);

function card(provider) {
  return `<article class="card ${provider.id}" style="--accent:${escapeHtml(provider.accent)}">
    <div class="card-heading">${providerLogo(provider.id)}<h1>${escapeHtml(provider.name)}</h1><button class="refresh" data-action="refresh" title="Refresh">↻</button></div>
    <div class="usage-row">${provider.id === 'copilot' ? `${meter(provider.monthly, provider.monthly?.label || 'Premium requests')}${actionsMeter(provider.actionsMinutes)}` : `${meter(provider.session, 'Session')}${meter(provider.weekly, 'Weekly')}`}</div>
    <p class="note">${escapeHtml(provider.note || 'Updated from your local source.')}</p>
  </article>`;
}

function integrationPanel(providerIds = ['claude', 'codex', 'copilot']) {
  const info = state.collector;
  if (!info) return '<section id="integration"><p>Loading account connection…</p></section>';
  const row = (id) => {
    const provider = info.providers[id];
    if (id === 'copilot') {
      const status = [provider.premium, provider.actions].map((source) => source.status).find((value) => value && value !== 'Not connected.') || 'Not updated yet.';
      const lastSync = [provider.premium, provider.actions].map((source) => source.lastSync).filter(Boolean).sort().at(-1);
      const updated = lastSync ? new Intl.DateTimeFormat('en-US', { timeStyle: 'short', dateStyle: 'short' }).format(new Date(lastSync)) : 'not updated yet';
      return `<article class="account-row"><div><h3>GitHub Copilot</h3><p>${escapeHtml(status)}</p><small>${provider.premium.configured ? `Connected GitHub account · ${updated}` : 'Not connected yet.'}</small></div><div class="account-actions"><button data-action="open-provider" data-provider="copilot" data-source="premium">${provider.premium.configured ? 'Reconnect GitHub' : 'Connect GitHub'}</button></div><small class="account-destination">Premium requests and Actions minutes</small></article>`;
    }
    const lastSync = provider.lastSync ? new Intl.DateTimeFormat('en-US', { timeStyle: 'short', dateStyle: 'short' }).format(new Date(provider.lastSync)) : 'not updated yet';
    const name = state.providers.find((item) => item.id === id)?.name || id;
    const destination = 'Settings / Usage';
    return `<article class="account-row"><div><h3>${escapeHtml(name)}</h3><p>${escapeHtml(provider.status)}</p><small>${provider.configured ? `Connected account · ${lastSync}` : 'Not connected yet.'}</small></div><div class="account-actions"><button data-action="open-provider" data-provider="${id}">${provider.configured ? `Reconnect ${escapeHtml(name)}` : `Connect ${escapeHtml(name)}`}</button></div><small class="account-destination">${destination}</small></article>`;
  };
  const selectedSetup = setupProviderIds !== null;
  return `<section id="integration"><h2>${selectedSetup ? 'Connect selected accounts' : 'Connect subscriptions'}</h2>
    <p>Sign in once to each account. AI Widgets opens each provider's usage view, detects it automatically, and keeps its browser session private—Chrome and GitHub CLI are not required.</p>
    ${providerIds.map(row).join('')}
    <footer><button data-action="refresh-providers">Update now</button></footer>
    <p class="bridge-status">Sessions stay local to AI Widgets. Configured sources are refreshed every minute; conversations and page text are not retained.</p>
  </section>`;
}

function onboardingPanel() {
  return `<form id="onboarding" class="setup-panel"><h2>Choose providers</h2>
    <p>Select the AI services whose usage you want to see. Nothing is enabled until you choose it; the next step lets you sign in to each selected account.</p>
    ${state.providers.map((provider) => `<label class="provider-choice"><input type="checkbox" name="provider" value="${provider.id}" /><span>${providerLogo(provider.id)}</span><span><b>${escapeHtml(provider.name)}</b><small>${provider.id === 'copilot' ? 'Premium requests and Actions minutes' : 'Session and weekly usage'}</small></span></label>`).join('')}
    ${onboardingError ? `<p class="form-error">${escapeHtml(onboardingError)}</p>` : ''}
    <footer><button class="primary" type="submit">Continue to sign in</button></footer>
  </form>`;
}

function providerPanel() {
  const selected = activeProviderIds();
  return `<form id="provider-settings"><h2>Visible providers</h2><p>Only selected providers are shown in the app, desktop widget, and panel menu. Selected providers are also the only ones refreshed automatically.</p>
    ${state.providers.map((provider) => `<label class="provider-choice"><input type="checkbox" name="provider" value="${provider.id}" ${selected.has(provider.id) ? 'checked' : ''} /><span>${providerLogo(provider.id)}</span><span><b>${escapeHtml(provider.name)}</b><small>${provider.id === 'copilot' ? 'Premium requests and Actions minutes' : 'Session and weekly usage'}</small></span></label>`).join('')}
    <footer><button type="button" data-action="cancel-providers">Cancel</button><button class="primary" type="submit">Save providers</button></footer>
  </form>`;
}

function render() {
  if (!state) return;
  const onboarding = state.settings?.onboardingComplete === false;
  const updated = state.updatedAt ? new Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(state.updatedAt)) : 'not updated yet';
  const visibleProviders = state.providers.filter((provider) => activeProviderIds().has(provider.id));
  const navigation = onboarding
    ? '<button class="minimize" data-action="minimize" title="Minimize">—</button><button class="close" data-action="close" title="Hide window">×</button>'
    : `<button data-action="providers">Providers</button><button data-action="integrate">${integrating ? 'Close connection' : 'Connect accounts'}</button><button class="minimize" data-action="minimize" title="Minimize">—</button><button class="close" data-action="close" title="Hide window">×</button>`;
  app.innerHTML = `<header class="drag"><span class="title">AI Widgets</span><span class="subtitle">${onboarding ? 'First-time setup' : `Settings and connection · ${updated}`}</span><nav class="no-drag">${navigation}</nav></header>
    ${onboarding ? onboardingPanel() : integrating ? integrationPanel(setupProviderIds || undefined) : managingProviders ? providerPanel() : `<section class="cards">${visibleProviders.map(card).join('') || '<p class="empty-state">No providers selected.</p>'}</section>`}`;
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
    if (integrating) state.collector = await window.aiwidgets.collectorInfo();
    render();
  } catch (error) { showError(error); }
}
app.addEventListener('click', async (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'refresh') { await window.aiwidgets.refreshProviders(); return load(); }
  if (action === 'minimize') return window.aiwidgets.minimize();
  if (action === 'close') return window.aiwidgets.close();
  if (action === 'providers') { managingProviders = !managingProviders; integrating = false; setupProviderIds = null; return render(); }
  if (action === 'cancel-providers') { managingProviders = false; return render(); }
  if (action === 'integrate') { integrating = !integrating; managingProviders = false; setupProviderIds = null; if (integrating) state.collector = await window.aiwidgets.collectorInfo(); return render(); }
  if (action === 'open-provider') { const target = event.target.closest('[data-provider]'); state.collector = await window.aiwidgets.openProvider(target.dataset.provider, target.dataset.source); return render(); }
  if (action === 'refresh-providers') { state.collector = await window.aiwidgets.refreshProviders(); return render(); }
});

app.addEventListener('submit', async (event) => {
  if (!['provider-settings', 'onboarding'].includes(event.target.id)) return;
  event.preventDefault();
  const providers = [...event.target.querySelectorAll('input[name="provider"]:checked')].map((input) => input.value);
  if (event.target.id === 'onboarding' && providers.length === 0) {
    onboardingError = 'Choose at least one provider to continue.';
    return render();
  }
  const completingOnboarding = event.target.id === 'onboarding';
  state = await window.aiwidgets.saveEnabledProviders(providers, completingOnboarding);
  onboardingError = '';
  setupProviderIds = completingOnboarding ? providers : null;
  managingProviders = false;
  integrating = completingOnboarding;
  if (integrating) state.collector = await window.aiwidgets.collectorInfo();
  render();
});

load().then(() => {
  if (!state) return;
  clearInterval(timer);
  timer = setInterval(load, 60_000);
});
window.aiwidgets?.onUsageChanged(() => load());
window.aiwidgets?.onCollectorChanged(() => { if (integrating) load(); });
