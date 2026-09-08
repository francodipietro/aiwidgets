import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// Electron's Linux userData directory is ~/.config/aiwidgets. Keep this in
// sync with src/main.js so the desktop extension renders the live data that
// the background application updates.
const DATA_PATH = GLib.build_filenamev([GLib.get_user_config_dir(), 'aiwidgets', 'usage.json']);
const LAYOUT_PATH = GLib.build_filenamev([GLib.get_user_config_dir(), 'aiwidgets', 'desktop-widget.json']);
const RUNTIME_PATH = GLib.build_filenamev([GLib.get_user_config_dir(), 'aiwidgets', 'runtime.json']);
const LAYOUT_VERSION = 3;
const DEFAULT_LAYOUT = { version: LAYOUT_VERSION, x: null, y: null, cardWidth: 170, desktopVisible: true, editing: false, autoPosition: true };
const PROVIDER_IDS = ['claude', 'codex', 'copilot'];

function enabledProviderIds(data) {
  const configured = data.settings?.enabledProviders;
  return Array.isArray(configured) ? configured.filter((id) => PROVIDER_IDS.includes(id)) : ['claude', 'codex'];
}

function usageBlock(usage, label, width) {
  const block = new St.BoxLayout({ vertical: true, style_class: 'aiwidgets-quota' });
  block.add_child(new St.Label({ text: label, style_class: 'aiwidgets-quota-label' }));
  if (!usage || typeof usage.available !== 'number') {
    block.add_child(new St.Label({ text: '— no data', style_class: 'aiwidgets-quota-empty' }));
    return block;
  }
  const available = Math.round(usage.available);
  const consumed = 100 - available;
  const summary = new St.BoxLayout({ style_class: 'aiwidgets-quota-summary' });
  const hasQuantity = Number.isFinite(usage.used) && Number.isFinite(usage.included);
  const number = value => new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
  summary.add_child(new St.Label({ text: `${consumed}%`, style_class: 'aiwidgets-quota-value' }));
  summary.add_child(new St.Label({ text: hasQuantity ? `${number(usage.used)} / ${number(usage.included)} min used` : 'consumed', style_class: 'aiwidgets-quota-consumed' }));
  block.add_child(summary);
  const barWidth = Math.max(48, width - 24);
  const bar = new St.BoxLayout({ style_class: 'aiwidgets-quota-bar', style: `width: ${barWidth}px;` });
  bar.add_child(new St.Widget({ style_class: 'aiwidgets-quota-fill', style: `width: ${Math.max(2, Math.round(barWidth * consumed / 100))}px;` }));
  block.add_child(bar);
  block.add_child(new St.Label({ text: `${available}% available`, style_class: 'aiwidgets-quota-available' }));
  const reset = usage.resetLabel || (usage.resetsAt ? `Resets ${new Date(usage.resetsAt).toLocaleString('en-US')}` : 'No reset date');
  block.add_child(new St.Label({ text: reset, style_class: 'aiwidgets-quota-reset' }));
  if (Number.isFinite(usage.billedAmount)) block.add_child(new St.Label({ text: `Billed this month: $${usage.billedAmount.toFixed(2)}`, style_class: 'aiwidgets-quota-reset' }));
  return block;
}

function cardHeader(name, id, scope, extensionPath) {
  const header = new St.BoxLayout({ style_class: `aiwidgets-${scope}-header` });
  header.add_child(new St.Label({ text: name, x_expand: true, style_class: `aiwidgets-${scope}-title` }));
  const logo = id === 'claude' ? 'logo_claude.svg' : id === 'copilot' ? 'logo_copilot.png' : 'logo_chatgpt.svg';
  header.add_child(new St.Icon({
    gicon: new Gio.FileIcon({ file: Gio.File.new_for_path(GLib.build_filenamev([extensionPath, logo])) }),
    icon_size: 22,
    style_class: `aiwidgets-${scope}-logo ${id}`,
  }));
  return header;
}

export default class AIWidgetsDesktopExtension extends Extension {
  enable() {
    this._file = Gio.File.new_for_path(DATA_PATH);
    this._layoutFile = Gio.File.new_for_path(LAYOUT_PATH);
    this._runtimeFile = Gio.File.new_for_path(RUNTIME_PATH);
    this._runtimeActive = true;
    this._layout = { ...DEFAULT_LAYOUT };
    this._widget = new St.BoxLayout({
      vertical: false,
      reactive: true,
      track_hover: true,
      style_class: 'aiwidgets-desktop-root',
      x_expand: false,
      y_expand: false,
    });
    this._createPanelIndicator();

    // Clutter.DragAction was removed from GNOME 46's introspection bindings.
    // Use actor pointer events directly so dragging works on Ubuntu GNOME 46.
    this._dragBeginId = this._widget.connect('button-press-event', (_actor, event) => {
      if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
      const [eventX, eventY] = global.get_pointer();
      const [x, y] = this._widget.get_position();
      this._dragOffset = { x: eventX - x, y: eventY - y };
      this._layout.autoPosition = false;
      this._dragging = true;
      return Clutter.EVENT_STOP;
    });
    this._dragMotionId = this._widget.connect('motion-event', () => {
      if (!this._dragging) return Clutter.EVENT_PROPAGATE;
      const [pointerX, pointerY] = global.get_pointer();
      this._layout.x = Math.round(pointerX - this._dragOffset.x);
      this._layout.y = Math.round(pointerY - this._dragOffset.y);
      this._applyLayout();
      return Clutter.EVENT_STOP;
    });
    this._dragEndId = this._widget.connect('button-release-event', (_actor, event) => {
      if (event.get_button() !== 1 || !this._dragging) return Clutter.EVENT_PROPAGATE;
      this._dragging = false;
      this._saveLayout();
      return Clutter.EVENT_STOP;
    });
    this._scrollId = this._widget.connect('scroll-event', (_actor, event) => this._resizeFromScroll(event));

    this._placeOnDesktopLayer();
    this._monitorChangedId = Main.layoutManager.connect('monitors-changed', () => this._position());
    this._windowCreatedId = global.display.connect('window-created', () => {
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { this._placeOnDesktopLayer(); return GLib.SOURCE_REMOVE; });
    });
    this._monitor = this._file.monitor_file(Gio.FileMonitorFlags.NONE, null);
    this._monitorChangedFileId = this._monitor.connect('changed', () => this._refresh());
    this._runtimeMonitor = this._runtimeFile.monitor_file(Gio.FileMonitorFlags.NONE, null);
    this._runtimeChangedId = this._runtimeMonitor.connect('changed', () => this._syncRuntimeState());
    this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
      this._refresh();
      return GLib.SOURCE_CONTINUE;
    });
    this._position();
    this._loadLayout();
    this._syncRuntimeState();
  }

  disable() {
    if (this._timerId) GLib.source_remove(this._timerId);
    if (this._monitorChangedFileId) this._monitor?.disconnect(this._monitorChangedFileId);
    this._monitor?.cancel();
    if (this._runtimeChangedId) this._runtimeMonitor?.disconnect(this._runtimeChangedId);
    this._runtimeMonitor?.cancel();
    if (this._monitorChangedId) Main.layoutManager.disconnect(this._monitorChangedId);
    if (this._windowCreatedId) global.display.disconnect(this._windowCreatedId);
    if (this._dragBeginId) this._widget?.disconnect(this._dragBeginId);
    if (this._dragMotionId) this._widget?.disconnect(this._dragMotionId);
    if (this._dragEndId) this._widget?.disconnect(this._dragEndId);
    if (this._scrollId) this._widget?.disconnect(this._scrollId);
    this._panelButton?.destroy();
    this._widget?.destroy();
    this._timerId = this._monitorChangedFileId = this._runtimeChangedId = this._monitorChangedId = this._windowCreatedId = 0;
    this._dragBeginId = this._dragMotionId = this._dragEndId = this._scrollId = 0;
    this._monitor = this._runtimeMonitor = this._runtimeFile = this._widget = this._layoutFile = this._panelButton = null;
    this._dragging = false;
  }

  _position() {
    const monitor = Main.layoutManager.primaryMonitor;
    if (this._layout.autoPosition !== false || this._layout.x === null || this._layout.y === null) {
      const providerCount = Math.max(1, enabledProviderIds(this._lastData || {}).length);
      const totalWidth = this._widget?.get_width() || ((this._layout.cardWidth * providerCount) + (20 * (providerCount - 1)));
      this._layout.x = monitor.x + monitor.width - totalWidth - 28;
      this._layout.y = monitor.y + (Main.panel?.height || 32) + 18;
    }
    this._applyLayout();
  }

  _loadLayout() {
    try {
      const [success, contents] = this._layoutFile.load_contents(null);
      if (!success) throw new Error('Could not read the saved layout.');
      const stored = JSON.parse(new TextDecoder().decode(contents));
      // Reset the one-off layout from older builds: those cards were too
      // large and started on top of Desktop Icons NG.
      this._layout = stored.version === LAYOUT_VERSION ? { ...DEFAULT_LAYOUT, ...stored, editing: false } : { ...DEFAULT_LAYOUT };
    } catch { /* Default position and size on first launch. */ }
    this._position();
  }

  _applyLayout() {
    this._layout.cardWidth = Math.max(150, Math.min(360, Number(this._layout.cardWidth) || DEFAULT_LAYOUT.cardWidth));
    this._widget?.set_position(this._layout.x, this._layout.y);
    if (this._runtimeActive === false || this._layout.desktopVisible === false) this._widget?.hide();
    else this._widget?.show();
    this._widget?.get_children().forEach(card => card.set_style(`width: ${this._layout.cardWidth}px;`));
  }

  _saveLayout() {
    GLib.mkdir_with_parents(GLib.path_get_dirname(LAYOUT_PATH), 0o700);
    const contents = new TextEncoder().encode(JSON.stringify(this._layout));
    try {
      this._layoutFile.replace_contents(contents, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    } catch (error) {
      console.warn(`AI Widgets: could not save the layout: ${error.message}`);
    }
  }

  _syncRuntimeState() {
    let active = true;
    try {
      const [success, contents] = this._runtimeFile.load_contents(null);
      if (success) active = JSON.parse(new TextDecoder().decode(contents)).active !== false;
    } catch { /* Before the first app launch, keep the setup widget visible. */ }
    this._runtimeActive = active;
    if (!active) {
      this._widget?.hide();
      this._panelButton?.menu.close(false);
      this._panelButton?.hide();
      return;
    }
    this._panelButton?.show();
    this._applyLayout();
    this._refresh();
  }

  _requestExit() {
    try {
      GLib.mkdir_with_parents(GLib.path_get_dirname(RUNTIME_PATH), 0o700);
      const contents = new TextEncoder().encode(JSON.stringify({ active: false, updatedAt: new Date().toISOString() }));
      this._runtimeFile.replace_contents(contents, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
      this._syncRuntimeState();
      const executable = GLib.find_program_in_path('aiwidgets');
      if (!executable) throw new Error('The AI Widgets launcher was not found.');
      Gio.Subprocess.new([executable, '--quit'], Gio.SubprocessFlags.NONE);
    } catch (error) { console.warn(`AI Widgets: could not exit: ${error.message}`); }
  }

  _resizeFromScroll(event) {
    if (!(event.get_state() & Clutter.ModifierType.CONTROL_MASK)) return Clutter.EVENT_PROPAGATE;
    const direction = event.get_scroll_direction();
    if (direction === Clutter.ScrollDirection.UP) this._layout.cardWidth += 10;
    else if (direction === Clutter.ScrollDirection.DOWN) this._layout.cardWidth -= 10;
    else return Clutter.EVENT_STOP;
    this._applyLayout();
    this._saveLayout();
    return Clutter.EVENT_STOP;
  }

  _createPanelIndicator() {
    this._panelButton = new PanelMenu.Button(0.0, 'AI Widgets', false);
    // A text badge has a guaranteed natural size in the Ubuntu/Yaru panel.
    // The previous SVG actor was visible but received no usable allocation.
    this._panelButton.add_child(new St.Label({ text: 'AI', style_class: 'aiwidgets-panel-indicator', y_align: Clutter.ActorAlign.CENTER }));
    this._panelButton.reactive = true;
    this._panelButton.track_hover = true;
    Main.panel.addToStatusArea('aiwidgets-panel', this._panelButton, 0, 'right');
  }

  _renderPanel(data) {
    if (!this._panelButton || this._runtimeActive === false) return;
    this._panelButton.menu.removeAll();
    const heading = new PopupMenu.PopupMenuItem('AI Widgets · usage', { reactive: false, can_focus: false });
    heading.label.style = 'font-weight: bold;';
    this._panelButton.menu.addMenuItem(heading);

    const providers = new Map((data.providers || []).map(provider => [provider.id, provider]));
    for (const id of enabledProviderIds(data)) {
      const provider = providers.get(id);
      this._panelButton.menu.addMenuItem(this._createPanelCard(provider, id));
    }
    this._panelButton.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    const action = new PopupMenu.PopupMenuItem(this._layout.desktopVisible === false ? 'Show desktop cards' : 'Hide desktop cards');
    action.connect('activate', () => {
      this._layout.desktopVisible = this._layout.desktopVisible === false;
      this._applyLayout();
      this._saveLayout();
      this._renderPanel(this._lastData || data);
    });
    this._panelButton.menu.addMenuItem(action);
    const editor = new PopupMenu.PopupMenuItem(this._layout.editing ? 'Pin cards to desktop' : 'Edit position and size');
    editor.connect('activate', () => {
      this._layout.editing = !this._layout.editing;
      this._placeOnDesktopLayer();
      if (!this._layout.editing) this._saveLayout();
      this._renderPanel(this._lastData || data);
    });
    this._panelButton.menu.addMenuItem(editor);
    const anchor = new PopupMenu.PopupMenuItem('Anchor at top right');
    anchor.connect('activate', () => {
      this._layout.autoPosition = true;
      this._layout.x = this._layout.y = null;
      this._position();
      this._saveLayout();
    });
    this._panelButton.menu.addMenuItem(anchor);
    const settings = new PopupMenu.PopupMenuItem('Open settings');
    settings.connect('activate', () => {
      try {
        const appInfo = Gio.DesktopAppInfo.new('aiwidgets.desktop');
        if (appInfo) appInfo.launch([], null);
        else {
          const executable = GLib.find_program_in_path('aiwidgets');
          if (!executable) throw new Error('The AI Widgets launcher was not found.');
          Gio.Subprocess.new([executable], Gio.SubprocessFlags.NONE);
        }
      }
      catch (error) { console.warn(`AI Widgets: could not open settings: ${error.message}`); }
    });
    this._panelButton.menu.addMenuItem(settings);
    this._panelButton.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    const exit = new PopupMenu.PopupMenuItem('Exit AI Widgets');
    exit.connect('activate', () => this._requestExit());
    this._panelButton.menu.addMenuItem(exit);
  }

  _createPanelCard(provider, id) {
    const card = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false, style_class: `aiwidgets-panel-card ${id}` });
    const body = new St.BoxLayout({ vertical: true, x_expand: true });
    const name = provider?.name || (id === 'claude' ? 'Claude' : id === 'copilot' ? 'GitHub Copilot' : 'Codex');
    body.add_child(cardHeader(name, id, 'panel', this.path));
    if (id === 'copilot') {
      body.add_child(usageBlock(provider?.monthly, provider?.monthly?.label || 'Premium requests', 238));
      body.add_child(usageBlock(provider?.actionsMinutes, 'Actions minutes', 238));
    }
    else {
      body.add_child(usageBlock(provider?.session, 'Session', 238));
      body.add_child(usageBlock(provider?.weekly, 'Weekly', 238));
    }
    card.add_child(body);
    return card;
  }

  _placeOnDesktopLayer() {
    if (!this._widget) return;
    // Ubuntu's Desktop Icons NG creates a desktop-type window above the shell
    // background. Insert immediately over it so the widget stays on the
    // wallpaper, while ordinary application windows still cover it.
    const desktopActors = global.get_window_actors().filter(actor =>
      actor.meta_window?.get_window_type() === Meta.WindowType.DESKTOP);
    const parent = this._widget.get_parent();
    if (parent) parent.remove_child(this._widget);
    if (this._layout?.editing) {
      // DING owns pointer events on the wallpaper. In edit mode the cards are
      // temporarily placed in GNOME's interactive layer; normal windows will
      // cover them again as soon as the user selects “Pin cards to desktop”.
      Main.uiGroup.add_child(this._widget);
      this._widget.raise_top();
      this._position();
      return;
    }
    if (desktopActors.length > 0) {
      global.window_group.add_child(this._widget);
      global.window_group.set_child_above_sibling(this._widget, desktopActors[desktopActors.length - 1]);
    } else {
      Main.layoutManager._backgroundGroup.add_child(this._widget);
    }
    this._position();
  }

  _refresh() {
    try {
      const [success, contents] = this._file.load_contents(null);
      if (!success) throw new Error('Could not read usage.json.');
      this._render(JSON.parse(new TextDecoder().decode(contents)));
    } catch (error) {
      console.warn(`AI Widgets: could not read usage.json: ${error.message}`);
      this._render({ providers: [], error: 'Open AI Widgets to create the data source.' });
    }
  }

  _render(data) {
    this._lastData = data;
    this._widget.get_children().forEach(child => child.destroy());
    const providers = new Map((data.providers || []).map(provider => [provider.id, provider]));
    for (const id of enabledProviderIds(data)) {
      const fallbackName = id === 'claude' ? 'Claude' : id === 'copilot' ? 'GitHub Copilot' : 'Codex';
      const provider = providers.get(id) || { name: fallbackName, note: data.error || 'No data.' };
      const card = new St.BoxLayout({ vertical: true, style_class: `aiwidgets-desktop-card ${id}`, style: `width: ${this._layout.cardWidth}px;` });
      card.add_child(cardHeader(provider.name, id, 'desktop', this.path));
      if (id === 'copilot') {
        card.add_child(usageBlock(provider.monthly, provider.monthly?.label || 'Premium requests', this._layout.cardWidth - 22));
        card.add_child(usageBlock(provider.actionsMinutes, 'Actions minutes', this._layout.cardWidth - 22));
      }
      else {
        card.add_child(usageBlock(provider.session, 'Session', this._layout.cardWidth - 22));
        card.add_child(usageBlock(provider.weekly, 'Weekly', this._layout.cardWidth - 22));
      }
      card.add_child(new St.Label({ text: provider.note || '', style_class: 'aiwidgets-desktop-note' }));
      this._widget.add_child(card);
    }
    this._position();
    this._renderPanel(data);
  }
}
