#!/usr/bin/env node
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const unpacked = path.join(dist, 'linux-unpacked');
const stage = path.join(dist, '.deb-staging');
const appIcon = path.join(root, 'imgs', 'logo_app.svg');
const gnomeExtension = path.join(root, 'gnome-extension', 'aiwidgets@fdipietro.dev');
const gnomeExtensionTarget = path.join('usr', 'share', 'gnome-shell', 'extensions', 'aiwidgets@fdipietro.dev');
const gnomeExtensionAssets = ['logo_chatgpt.svg', 'logo_claude.svg', 'logo_copilot.png', 'logo_deepseek.svg'];
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const output = path.join(dist, `aiwidgets_${metadata.version}_amd64.deb`);

const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
});

const control = `Package: aiwidgets
Version: ${metadata.version}
Section: utils
Priority: optional
Architecture: amd64
Maintainer: AI Widgets
Depends: libasound2t64 | libasound2, libatk-bridge2.0-0, libatk1.0-0, libc6, libcairo2, libdrm2, libgbm1, libglib2.0-0, libgtk-3-0, libnss3, libpango-1.0-0, libx11-6, libx11-xcb1, libxcb1, libxcomposite1, libxdamage1, libxext6, libxfixes3, libxkbcommon0, libxrandr2, libxss1, libxtst6, xdg-utils
Description: Local subscription usage widgets for AI services
 Electron control window for Claude, Codex, GitHub Copilot, and DeepSeek API usage,
 including the bundled GNOME Shell desktop widget and top-panel menu.
`;
const postinst = `#!/bin/sh
set -e
if [ -e "/opt/aiwidgets/chrome-sandbox" ]; then
  chown root:root "/opt/aiwidgets/chrome-sandbox"
  chmod 4755 "/opt/aiwidgets/chrome-sandbox"
fi
update-alternatives --install /usr/bin/aiwidgets aiwidgets /opt/aiwidgets/aiwidgets 100
`;
const postrm = `#!/bin/sh
set -e
case "$1" in
  remove|purge|upgrade|failed-upgrade|abort-install|abort-upgrade|disappear)
    update-alternatives --remove aiwidgets /opt/aiwidgets/aiwidgets || true
    ;;
esac
`;
const desktop = `[Desktop Entry]
Type=Application
Name=AI Widgets
Comment=Local subscription usage widgets for AI services
Exec=aiwidgets
Icon=aiwidgets
Terminal=false
Categories=Utility;
`;
const autostart = `[Desktop Entry]
Type=Application
Name=AI Widgets background refresh
Comment=Refresh AI Widgets usage data after sign-in
Exec=aiwidgets --background
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
`;

try {
  await rm(stage, { recursive: true, force: true });
  await mkdir(path.join(stage, 'DEBIAN'), { recursive: true });
  await mkdir(path.join(stage, 'opt'), { recursive: true });
  await mkdir(path.join(stage, 'usr', 'share', 'applications'), { recursive: true });
  await mkdir(path.join(stage, 'etc', 'xdg', 'autostart'), { recursive: true });
  await mkdir(path.join(stage, 'usr', 'share', 'icons', 'hicolor', 'scalable', 'apps'), { recursive: true });
  await cp(unpacked, path.join(stage, 'opt', 'aiwidgets'), { recursive: true, preserveTimestamps: true });
  await cp(gnomeExtension, path.join(stage, gnomeExtensionTarget), { recursive: true, preserveTimestamps: true });
  await Promise.all(gnomeExtensionAssets.map((asset) => cp(path.join(root, 'imgs', asset), path.join(stage, gnomeExtensionTarget, asset))));
  await cp(appIcon, path.join(stage, 'usr', 'share', 'icons', 'hicolor', 'scalable', 'apps', 'aiwidgets.svg'));
  await Promise.all([
    writeFile(path.join(stage, 'DEBIAN', 'control'), control),
    writeFile(path.join(stage, 'DEBIAN', 'postinst'), postinst),
    writeFile(path.join(stage, 'DEBIAN', 'postrm'), postrm),
    writeFile(path.join(stage, 'usr', 'share', 'applications', 'aiwidgets.desktop'), desktop),
    writeFile(path.join(stage, 'etc', 'xdg', 'autostart', 'aiwidgets.desktop'), autostart),
  ]);
  await Promise.all([
    chmod(path.join(stage, 'DEBIAN', 'postinst'), 0o755),
    chmod(path.join(stage, 'DEBIAN', 'postrm'), 0o755),
  ]);
  await run('dpkg-deb', ['--build', '--root-owner-group', '-Zgzip', '-z1', stage, output]);
} finally {
  await rm(stage, { recursive: true, force: true });
}
