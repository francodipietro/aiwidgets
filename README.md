# AI Widgets

Local, privacy-preserving subscription-usage widgets for Claude, Codex, and GitHub Copilot. AI Widgets shows session and weekly usage for Claude and Codex, plus monthly Premium requests and GitHub Actions minutes for Copilot.

Ubuntu GNOME is the current native-widget target: it provides desktop cards and a top-panel menu. macOS is a first-class target for the project: the Electron control window already packages for macOS, while the native macOS menu-bar and desktop-widget integration is the next adaptation step.

The app uses its own persistent, isolated browser profile to read the Claude and Codex usage pages. Chrome does not need to be open. Copilot is read from GitHub's authenticated Billing API through the local GitHub CLI. AI Widgets stores normalized usage values locally; it does not store conversations, page text, or GitHub tokens.

## Requirements

- Node.js 20 or newer
- Ubuntu with GNOME Shell 46 for the native desktop widget and top-panel menu
- macOS for the Electron control window; native menu-bar and desktop widgets are planned
- [GitHub CLI](https://cli.github.com/) (`gh`) for GitHub Copilot data

## Run locally

```bash
npm install
npm start
```

The control window starts in English and creates its data file at:

```text
~/.config/aiwidgets/usage.json
```

## Connect subscriptions

1. Open **Connect accounts**.
2. For Claude or Codex, select its **Open** button, sign in in the isolated window, open **Settings / Usage**, then select **Use current page**.
3. For Copilot, authenticate the local GitHub CLI once:

   ```bash
   gh auth login -h github.com
   gh auth refresh -h github.com -s user
   ```

   AI Widgets reads the authenticated account's official Billing API. The token remains in GitHub CLI's keyring and is never copied into AI Widgets.

AI Widgets refreshes configured sources every minute while it is running. Copilot Pro annual is calculated from GitHub's reported Premium request usage and its documented 300-request monthly entitlement. GitHub Actions is calculated from the Billing API's runner costs, normalized to the included quota for the authenticated GitHub plan.

On Ubuntu, the Debian package installs an XDG autostart entry. AI Widgets starts hidden after sign-in, performs an immediate refresh, and continues refreshing once per minute. Opening AI Widgets from the app menu shows the control window; **Exit AI Widgets** stops it until the next sign-in.

Use **Providers** in the control window to choose which services are shown and refreshed. Copilot is disabled by default.

## GNOME desktop widget

The extension reads `~/.config/aiwidgets/usage.json` once per minute and adds an **AI** item to the top panel. Its menu contains the selected usage cards and controls for showing, hiding, moving, resizing, and re-anchoring the desktop cards.

To install the extension during development:

```bash
npm run package:gnome
gnome-extensions install --force dist/aiwidgets-gnome-shell.zip
gnome-extensions enable aiwidgets@fdipietro.dev
```

Use **Edit position and size** in the panel menu before dragging a card. Hold `Ctrl` and use the mouse wheel over a card to resize it. **Anchor at top right** restores automatic positioning on the active primary monitor.

## Local data format

The example schema is in [data/usage.example.json](data/usage.example.json). `available` is a percentage from `0` to `100`; the UI displays the inverse as consumed usage.

You can update the local data file from a script:

```bash
node scripts/aiwidgets-usage.mjs codex --session 61 --weekly 39 --reset "2026-09-09T07:58:00-03:00"
```

The helper only writes local JSON. It does not authenticate with or call any provider.

## Terminal usage CLI

The usage CLI prints the already synchronized values for enabled providers. It
only reads the local data file: it does not open a browser, sign in, or contact
any provider.

```bash
# From a development checkout
npm run usage

# From an installed package
aiwidgets usage

# Machine-readable output, including disabled providers
npm run --silent usage -- --json --all
aiwidgets usage --json --all
```

## Validation and packaging

```bash
npm run check
npm run package:linux
npm run package:mac
```

`dist/` and `node_modules/` are generated locally and ignored by Git. macOS packaging builds the Electron control window; the GNOME extension is Ubuntu-specific and is not included on macOS. The macOS-native widget and menu-bar integration is intentionally tracked as future work.
