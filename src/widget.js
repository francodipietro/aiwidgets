const root = document.querySelector('#widget-app');
const surface = new URLSearchParams(location.search).get('surface') || 'desktop';
let state;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[char]));
const providerLogo = (id) => id === 'claude' ? '../imgs/logo_claude.svg' : id === 'copilot' ? '../imgs/logo_copilot.png' : '../imgs/logo_chatgpt.svg';
const providerName = (id) => id === 'claude' ? 'Claude' : id === 'copilot' ? 'GitHub Copilot' : 'Codex';
const formatNumber = (value) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);

function quota(usage, label) {
  if (!usage || !Number.isFinite(usage.available)) return `<section class="quota"><div class="quota-label">${escapeHtml(label)}</div><div class="quota-summary"><strong class="quota-value">—</strong><span class="quota-consumed">no data</span></div></section>`;
  const available = Math.max(0, Math.min(100, Math.round(usage.available)));
  const consumed = 100 - available;
  const quantity = Number.isFinite(usage.used) && Number.isFinite(usage.included) ? `${formatNumber(usage.used)} / ${formatNumber(usage.included)} min used` : 'consumed';
  const reset = usage.resetLabel || (usage.resetsAt ? `Resets ${new Date(usage.resetsAt).toLocaleString('en-US')}` : 'No reset date');
  const billed = Number.isFinite(usage.billedAmount) ? `<div class="quota-meta quota-reset">Billed this month: $${usage.billedAmount.toFixed(2)}</div>` : '';
  return `<section class="quota"><div class="quota-label">${escapeHtml(label)}</div><div class="quota-summary"><strong class="quota-value">${consumed}%</strong><span class="quota-consumed">${escapeHtml(quantity)}</span></div><div class="quota-bar"><i class="quota-fill" style="width:${consumed}%"></i></div><div class="quota-meta">${available}% available</div><div class="quota-meta quota-reset">${escapeHtml(reset)}</div>${billed}</section>`;
}

function card(provider, id, panel) {
  const name = provider?.name || providerName(id);
  const blocks = id === 'copilot'
    ? `${quota(provider?.monthly, provider?.monthly?.label || 'Premium requests')}${quota(provider?.actionsMinutes, 'Actions minutes')}`
    : `${quota(provider?.session, 'Session')}${quota(provider?.weekly, 'Weekly')}`;
  const note = panel ? '' : `<div class="widget-note">${escapeHtml(provider?.note || 'No data.')}</div>`;
  return `<article class="widget-card ${panel ? 'panel-card' : ''} ${id}"><header class="widget-header"><h2>${escapeHtml(name)}</h2><img class="widget-logo" src="${providerLogo(id)}" alt="" /></header>${blocks}${note}</article>`;
}

function render() {
  if (!state) return;
  const providers = new Map((state.data?.providers || []).map((provider) => [provider.id, provider]));
  const ids = Array.isArray(state.data?.settings?.enabledProviders) ? state.data.settings.enabledProviders : ['claude', 'codex'];
  const cards = ids.filter((id) => ['claude', 'codex', 'copilot'].includes(id)).map((id) => card(providers.get(id), id, surface === 'panel')).join('');
  document.body.classList.toggle('editing', surface === 'desktop' && state.layout?.editing === true);
  if (surface === 'desktop') {
    root.innerHTML = `<section class="desktop-root" style="--card-width:${Math.max(150, Number(state.layout?.cardWidth) || 170)}px">${cards}</section>${state.layout?.editing ? '<div class="desktop-edit-hint">Drag cards to move · Hold Control and scroll to resize</div>' : ''}`;
    return;
  }
  const editLabel = state.layout?.editing ? 'Pin cards to desktop' : 'Edit position and size';
  const visibilityLabel = state.layout?.desktopVisible === false ? 'Show desktop cards' : 'Hide desktop cards';
  root.innerHTML = `<section class="panel-root"><div class="panel-heading">AI Widgets · usage</div>${cards}<div class="panel-actions"><button data-action="refresh">Update now</button><button data-action="toggle-visible">${visibilityLabel}</button><button data-action="edit">${editLabel}</button><button data-action="anchor">Anchor at top right</button><button data-action="settings">Open settings</button><button class="danger" data-action="exit">Exit AI Widgets</button></div></section>`;
}

root.addEventListener('click', async (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  if (action === 'refresh') {
    state = await window.desktopWidgets.refresh();
  } else if (action === 'toggle-visible') {
    await window.desktopWidgets.toggleVisible();
    state = await window.desktopWidgets.state();
  } else if (action === 'edit') {
    await window.desktopWidgets.setEditing(!state.layout?.editing);
    state = await window.desktopWidgets.state();
  } else if (action === 'anchor') {
    await window.desktopWidgets.anchor();
    state = await window.desktopWidgets.state();
  } else if (action === 'settings') {
    await window.desktopWidgets.openSettings();
    state = await window.desktopWidgets.state();
  } else if (action === 'exit') {
    await window.desktopWidgets.exit();
    return;
  }
  render();
});

window.addEventListener('wheel', async (event) => {
  if (surface !== 'desktop' || state?.layout?.editing !== true || !event.ctrlKey) return;
  event.preventDefault();
  await window.desktopWidgets.resize(event.deltaY < 0 ? 10 : -10);
  state = await window.desktopWidgets.state();
  render();
}, { passive: false });

window.desktopWidgets.onState((nextState) => { state = nextState; render(); });
window.desktopWidgets.state().then((nextState) => { state = nextState; render(); });
