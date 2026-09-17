# AI Widgets — Product roadmap

AI Widgets is a local-first desktop app for keeping AI service usage visible
without sending usage data to a central service.

## Principles

- Privacy first: cookies, metrics, credentials, and history stay on the user's
  machine.
- No provider is enabled or connected without explicit user choice.
- Every card makes the freshness and health of its data clear.
- macOS and Ubuntu keep the same data model while using native integrations on
  each platform.

## Phase 1 — First-run onboarding

Goal: guide a new installation from explicit provider selection to account
connection.

- [x] Start new profiles with no enabled providers.
- [x] Persist onboarding completion without interrupting existing users.
- [x] Keep Claude, Codex, and GitHub Copilot disabled on first launch.
- [x] Continue to sign-in actions for selected providers.
- [x] Validate the first-run flow with an isolated profile.

Acceptance criterion: a new profile shows no provider cards and performs no
refresh until the user selects a provider. Existing installations keep their
active providers.

## Phase 2 — Quality and regression coverage

Goal: detect provider-page changes before they reach a release.

- [x] Extract pure usage and reset-date parsing functions.
- [x] Add anonymized fixtures for Claude, Codex, and GitHub Copilot.
- [x] Test percentages, missing quotas, expired dates, and partially loaded
  pages.
- [x] Test migration of profiles created before onboarding.
- [x] Include the test suite in the local validation checklist.

Acceptance criterion: parser changes require coverage for all supported sources
and the main error cases.

## Phase 3 — Connection health

Goal: make every card's data trustworthy and actionable.

- [x] Store the last successful refresh, last attempt, and normalized provider
  error.
- [x] Show fresh, stale, and failed states with actionable recovery guidance.
- [x] Add individual and global retry actions.
- [x] Distinguish disconnected accounts, expired sessions, and changed pages.

Acceptance criterion: every card explains whether its value is current and how
to recover when it is not.

## Phase 4 — Privacy and account management

Goal: make switching accounts complete and understandable.

- [x] Add a **Disconnect** action for each provider.
- [x] Clear the provider's isolated cookies and configuration.
- [x] Let users choose whether to keep or delete stored metrics.
- [x] Add an intentional **Reset first-time setup** action.

Acceptance criterion: changing accounts never reuses the previous account's
cookies or data by accident.

## Phase 5 — Optional local alerts

Goal: notify users only when usage or connection health needs attention.

- [x] Add opt-in thresholds by provider and quota type.
- [x] Notify once per quota and reset period when a threshold is crossed.
- [x] Optionally notify when a provider stops updating, with configurable
  repetition and episode silencing.
- [x] Respect operating-system notification preferences.

Acceptance criterion: no quota alert is sent without opt-in, and alerts do not
repeat for the same quota and reset period.

## Phase 6 — Local history

Goal: show usage trends without telemetry.

- [x] Store compact usage samples only when a value changes.
- [x] Support configurable 7-, 30-, and 90-day retention.
- [x] Show compact sparklines with a real time axis.
- [x] Export and delete local history, globally or by provider.

Acceptance criterion: history works without additional network services, and its
retention and size remain transparent to the user.

## Phase 7 — Distribution and updates

Goal: install and update safely on both supported platforms.

- [x] Define versioning and release notes.
- [ ] Sign and notarize macOS packages before offering direct installation.
- [x] Prepare versioned Ubuntu `.deb` packages with the GNOME extension
  included.
- [ ] Publish a signed APT repository so `apt update` and `apt upgrade` receive
  new versions.
- [ ] Create a one-line installer that detects macOS or Ubuntu, downloads the
  correct artifact, and validates its SHA-256 checksum.
- [ ] Add integrated macOS updates after signing and notarization are
  available.

Acceptance criterion: macOS installs without Gatekeeper warnings, and Ubuntu
receives updates through its package manager without requiring Node.js or the
GitHub CLI.

## Phase 8 — DeepSeek API provider

Goal: support a provider that reports an API balance instead of subscription
quotas, while establishing a pattern for future API-based providers.

- [x] Store the API key encrypted with Electron `safeStorage`, separately from
  `usage.json`.
- [x] Read the balance from DeepSeek's balance API.
- [x] Track a local funded total and derive usage from the available balance.
- [x] Treat increases in the balance as top-ups rather than negative usage.
- [x] Show percentage used, a consumption bar, and available funds.
- [x] Add a configurable low-balance threshold and opt-in alert.
- [x] Add onboarding, connect, and disconnect flows for the API key.
- [x] Show DeepSeek metrics in the app, desktop cards, GNOME panel, and macOS
  menu-bar panel.
- [x] Add fixtures and parser tests for balances, top-ups, currencies, and
  invalid keys.

Acceptance criterion: the API key is never stored in plain text, and the
available balance, funded total, usage percentage, and provider status remain
consistent across supported views.

## Future backlog

- [ ] Internationalization and localized date formats.
- [ ] Accessibility improvements, including keyboard focus, labels, and
  contrast.
- [ ] Additional providers only when a stable source and the same local-first
  privacy model are available.
- [ ] Consent-based, anonymized diagnostics export for support.
