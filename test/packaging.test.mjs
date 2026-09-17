import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('the macOS menu-bar tray uses packaged PNG template assets', async () => {
  const mainSource = await readFile(path.join(root, 'src', 'main.js'), 'utf8');
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

  assert.match(mainSource, /nativeImage\.createFromBuffer\(await readFile\(iconPath\)\)/);
  assert.match(mainSource, /retinaIcon\.toBitmap\(\)/);
  assert.match(mainSource, /width: retinaSize\.width/);
  assert.match(mainSource, /height: retinaSize\.height/);
  assert.match(mainSource, /menu-bar-iconTemplate\.png/);
  assert.doesNotMatch(mainSource, /trayRef\.setTitle\(['"]AI['"]\)/);
  assert.doesNotMatch(mainSource, /createFromPath\([^)]*menu-bar-iconTemplate\.svg/);
  assert.ok(packageJson.build.files.includes('imgs/**/*'));
  assert.equal(packageJson.build.mac.artifactName, 'AI-Widgets-${version}-${arch}-${os}.${ext}');
  const icon = await readFile(path.join(root, 'imgs', 'menu-bar-iconTemplate.png'));
  const retinaIcon = await readFile(path.join(root, 'imgs', 'menu-bar-iconTemplate@2x.png'));
  assert.equal(icon.readUInt32BE(16), 16);
  assert.equal(icon.readUInt32BE(20), 16);
  assert.equal(retinaIcon.readUInt32BE(16), 32);
  assert.equal(retinaIcon.readUInt32BE(20), 32);
});

test('the macOS tray panel keeps layout and desktop-card controls visible', async () => {
  const widgetSource = await readFile(path.join(root, 'src', 'widget.js'), 'utf8');
  const widgetCss = await readFile(path.join(root, 'src', 'widget.css'), 'utf8');
  const mainSource = await readFile(path.join(root, 'src', 'main.js'), 'utf8');
  const preloadSource = await readFile(path.join(root, 'src', 'widget-preload.cjs'), 'utf8');

  assert.match(widgetSource, /panel-layout-options/);
  assert.doesNotMatch(widgetSource, /<select data-action="panel-layout"/);
  assert.match(widgetSource, /panel-actions details.*addEventListener\('toggle'/s);
  assert.match(widgetSource, /fitPanelToDisplay\(\{ preserveCurrentHeight: event\.target\.open \}\)/);
  assert.doesNotMatch(widgetSource, /measureWorstCasePanelHeight/);
  assert.match(widgetSource, /panelNeedsInitialFit/);
  assert.match(widgetSource, /onDisplayChanged\(\(\) => \{ fitPanelToDisplay\(\); \}\)/);
  assert.match(widgetSource, /onOpened\(\(\) => \{/);
  assert.doesNotMatch(widgetSource, /window\.addEventListener\('resize', fitPanelToDisplay\)/);
  assert.match(widgetSource, /const resizeRequest = \(\) => \(\{ height: Math\.ceil\(contentHeight\)/);
  assert.match(widgetSource, /preserveCurrentHeight/);
  assert.match(widgetSource, /Number\.isFinite\(appliedBounds\?\.height\)/);
  assert.match(preloadSource, /resizePanel: \(size\) => ipcRenderer\.invoke\('desktop-widget:resize-panel', size\)/);
  assert.match(preloadSource, /onOpened: \(callback\) => ipcRenderer\.on\('desktop-widget:opened', callback\)/);
  assert.match(mainSource, /ipcMain\.handle\('desktop-widget:resize-panel'/);
  assert.match(mainSource, /preserveCurrentHeight/);
  assert.match(mainSource, /display-metrics-changed/);
  assert.match(mainSource, /notifyTrayDisplayChanged/);
  assert.match(widgetCss, /\.desktop-root \.widget-card \{ min-height: 258px; height: auto; overflow: visible; \}/);
  assert.match(widgetCss, /\.panel-cards\.two-columns \.panel-card\.deepseek \{ grid-column: 1 \/ -1; \}/);
  assert.match(mainSource, /const MAC_WIDGET_HEIGHT = 320;/);
  assert.match(mainSource, /const MAC_PANEL_INITIAL_HEIGHT = 280;/);
});
