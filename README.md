# AI Widgets

Local, privacy-preserving subscription-usage widgets for Claude, Codex, and GitHub Copilot. AI Widgets shows session and weekly usage for Claude and Codex, plus monthly Premium requests and GitHub Actions minutes for Copilot.

Ubuntu GNOME and macOS both provide desktop cards and a top-bar integration. The Electron control window is shared; the native integrations render the same locally stored usage data.

The app uses its own persistent, isolated browser profile to read the Claude and Codex usage pages. Chrome does not need to be open. Copilot is read from GitHub's authenticated Billing API through the local GitHub CLI. AI Widgets stores normalized usage values locally; it does not store conversations, page text, or GitHub tokens.

## Requirements

- Node.js 20 or newer
- Ubuntu with GNOME Shell 46 for the native desktop widget and top-panel menu
- macOS for the Electron control window, menu-bar item, and desktop cards
- [GitHub CLI](https://cli.github.com/) (`gh`) for GitHub Copilot data

## Run locally

```bash
npm install
npm start
```

With npm 11, install scripts are opt-in. This project deliberately records
approval for Electron and electron-winstaller in `package.json`'s
`allowScripts` field, so their required platform-binary setup runs during
`npm install`. Check the approved scripts with `npm install-scripts ls`.

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

## macOS desktop widget and menu bar

On macOS, AI Widgets adds an **AI** item to the menu bar. Select it to see the same provider cards and actions as the GNOME panel menu: update usage, show or hide the desktop cards, edit their position and size, anchor them at the top right, open settings, or exit the app.

Use **Edit position and size** before dragging the cards. Hold `Control` and scroll over a card to resize it. Once pinned, cards sit on the desktop and normal application windows cover them, matching the GNOME behavior.

## Local data format

The example schema is in [data/usage.example.json](data/usage.example.json). `available` is a percentage from `0` to `100`; the UI displays the inverse as consumed usage.

You can update the local data file from a script:

```bash
node scripts/aiwidgets-usage.mjs codex --session 61 --weekly 39 --reset "2026-09-09T07:58:00-03:00"
```

The helper only writes local JSON. It does not authenticate with or call any provider.

## Terminal usage CLI

The usage CLI asks the running AI Widgets background collector to refresh the
configured providers, then prints enabled values. If no healthy collector is
running, it starts a short-lived hidden collector itself and reuses the local
provider sessions. This keeps relative Claude resets and all usage figures
current without a visible browser or a second sign-in. Use `--no-refresh` only
when intentionally reading the saved snapshot.

```bash
# From a development checkout (also works when the background app is stopped)
npm run usage

# Ubuntu-only fallback when the local Electron sandbox helper is not configured
npm run usage:linux

# From an installed package
aiwidgets usage

# Machine-readable output, including disabled providers
npm run --silent usage -- --json --all
aiwidgets usage --json --all

# Read the saved values without updating
aiwidgets usage --no-refresh
```

## Validation and packaging

```bash
npm run check
npm run package:linux
npm run package:mac
```

`dist/` and `node_modules/` are generated locally and ignored by Git. macOS packaging includes the Electron control window, menu-bar integration, and desktop cards. The GNOME extension is Ubuntu-specific and is not included on macOS.
