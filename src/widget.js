const root = document.querySelector('#widget-app');
const surface = new URLSearchParams(location.search).get('surface') || 'desktop';
let state;
let panelFitFrame = 0;
let panelFitRevision = 0;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[char]));
const providerLogo = (id) => id === 'claude' ? '../imgs/logo_claude.svg' : id === 'copilot' ? '../imgs/logo_copilot.png' : '../imgs/logo_chatgpt.svg';
const providerName = (id) => id === 'claude' ? 'Claude' : id === 'copilot' ? 'GitHub Copilot' : 'Codex';
const formatNumber = (value) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
const resetTimestamp = (label) => Date.parse(String(label)
  .replace(/^\s*(?:resets?|renews?)\s*(?:on|at)?\s*/i, '')
  .replace(/\s+at\s+/ig, ' '));

function resetText(usage) {
  const label = usage?.resetLabel;
  if (label) {
    const timestamp = resetTimestamp(label);
    if (!Number.isFinite(timestamp) || timestamp >= Date.now() - 60_000) return label;
  }
  if (usage?.resetsAt) {
    const timestamp = Date.parse(usage.resetsAt);
    if (Number.isFinite(timestamp) && timestamp >= Date.now() - 60_000) return `Resets ${new Date(timestamp).toLocaleString('en-US')}`;
  }
  return 'No reset date';
}

function quota(usage, label, unit = '') {
  if (!usage || !Number.isFinite(usage.available)) return `<section class="quota"><div class="quota-label">${escapeHtml(label)}</div><div class="quota-summary"><strong class="quota-value">—</strong><span class="quota-consumed">no data</span></div></section>`;
  const available = Math.max(0, Math.min(100, Math.round(usage.available)));
  const consumed = 100 - available;
  const quantity = Number.isFinite(usage.used) && Number.isFinite(usage.included) ? `${formatNumber(usage.used)} / ${formatNumber(usage.included)}${unit ? ` ${unit}` : ''} used` : 'consumed';
  const reset = resetText(usage);
  const billed = Number.isFinite(usage.billedAmount) ? `<div class="quota-meta quota-reset">Billed this month: $${usage.billedAmount.toFixed(2)}</div>` : '';
  return `<section class="quota"><div class="quota-label">${escapeHtml(label)}</div><div class="quota-summary"><strong class="quota-value">${consumed}%</strong><span class="quota-consumed">${escapeHtml(quantity)}</span></div><div class="quota-bar"><i class="quota-fill" style="width:${consumed}%"></i></div><div class="quota-meta">${available}% available</div><div class="quota-meta quota-reset">${escapeHtml(reset)}</div>${billed}</section>`;
}

function card(provider, id, panel) {
  const name = provider?.name || providerName(id);
  const blocks = id === 'copilot'
    ? `${quota(provider?.monthly, provider?.monthly?.label || 'Premium requests', 'requests')}${quota(provider?.actionsMinutes, 'Actions minutes', 'min')}`
    : `${quota(provider?.session, 'Session')}${quota(provider?.weekly, 'Weekly')}`;
  const note = panel ? '' : `<div class="widget-note">${escapeHtml(provider?.note || 'No data.')}</div>`;
  return `<article class="widget-card ${panel ? 'panel-card' : ''} ${id}"><header class="widget-header"><h2>${escapeHtml(name)}</h2><img class="widget-logo" src="${providerLogo(id)}" alt="" /></header><div class="quota-list">${blocks}</div>${note}</article>`;
}

function fitPanelToDisplay() {
  if (surface !== 'panel') return;
  const revision = ++panelFitRevision;
  if (panelFitFrame) cancelAnimationFrame(panelFitFrame);
  root.classList.remove('panel-compact', 'panel-condensed');
  root.style.removeProperty('--panel-scale');
  root.style.removeProperty('--panel-unscaled-width');

  const isCurrent = () => revision === panelFitRevision;
  const resizeToContent = () => {
    if (!isCurrent()) return;
    const contentHeight = root.scrollHeight;
    const availableHeight = window.innerHeight;
    if (contentHeight <= availableHeight) {
      window.desktopWidgets.resizePanel(Math.ceil(contentHeight));
      return;
    }

    const scale = availableHeight / contentHeight;
    root.style.setProperty('--panel-scale', scale.toFixed(4));
    root.style.setProperty('--panel-unscaled-width', `${100 / scale}%`);
    panelFitFrame = requestAnimationFrame(() => {
      if (!isCurrent()) return;
      window.desktopWidgets.resizePanel(Math.min(availableHeight, Math.ceil(root.scrollHeight * scale)));
    });
  };

  panelFitFrame = requestAnimationFrame(() => {
    if (!isCurrent()) return;
    if (root.scrollHeight <= window.innerHeight) {
      resizeToContent();
      return;
    }
    root.classList.add('panel-compact');
    panelFitFrame = requestAnimationFrame(() => {
      if (!isCurrent()) return;
      if (root.scrollHeight > window.innerHeight) root.classList.add('panel-condensed');
      resizeToContent();
    });
  });
}

function render() {
  if (!state) return;
  const providers = new Map((state.data?.providers || []).map((provider) => [provider.id, provider]));
  const ids = Array.isArray(state.data?.settings?.enabledProviders) ? state.data.settings.enabledProviders : ['claude', 'codex'];
  const cards = ids.filter((id) => ['claude', 'codex', 'copilot'].includes(id)).map((id) => card(providers.get(id), id, surface === 'panel')).join('');
  const content = cards || '<section class="widget-empty">No providers selected. Open settings to choose one.</section>';
  document.body.classList.toggle('editing', surface === 'desktop' && state.layout?.editing === true);
  if (surface === 'desktop') {
    root.innerHTML = `<section class="desktop-root" style="--card-width:${Math.max(150, Number(state.layout?.cardWidth) || 170)}px">${content}</section>${state.layout?.editing ? '<div class="desktop-edit-hint">Drag cards to move · Hold Control and scroll to resize</div>' : ''}`;
    return;
  }
  const editLabel = state.layout?.editing ? 'Pin cards to desktop' : 'Edit position and size';
  const visibilityLabel = state.layout?.desktopVisible === false ? 'Show desktop cards' : 'Hide desktop cards';
  root.innerHTML = `<section class="panel-root"><div class="panel-heading">AI Widgets · usage</div>${content}<div class="panel-actions"><button data-action="refresh">Update now</button><button data-action="toggle-visible">${visibilityLabel}</button><button data-action="edit">${editLabel}</button><button data-action="anchor">Anchor at top right</button><button data-action="settings">Open settings</button><button class="danger" data-action="exit">Exit AI Widgets</button></div></section>`;
  fitPanelToDisplay();
}

function renderError(error) {
  console.error('AI Widgets: widget surface failed to load:', error);
  root.innerHTML = '<div class="panel-root"><div class="panel-heading">AI Widgets</div><p>Unable to load widget data. Try updating again.</p></div>';
  fitPanelToDisplay();
}

root.addEventListener('click', async (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  try {
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
  } catch (error) {
    renderError(error);
  }
});

window.addEventListener('wheel', async (event) => {
  if (surface !== 'desktop' || state?.layout?.editing !== true || !event.ctrlKey) return;
  event.preventDefault();
  try {
    await window.desktopWidgets.resize(event.deltaY < 0 ? 10 : -10);
    state = await window.desktopWidgets.state();
    render();
  } catch (error) {
    renderError(error);
  }
}, { passive: false });

window.addEventListener('resize', fitPanelToDisplay);

window.desktopWidgets.onState((nextState) => { state = nextState; render(); });
window.desktopWidgets.state().then((nextState) => { state = nextState; render(); }).catch(renderError);
