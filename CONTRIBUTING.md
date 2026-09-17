# Contributing to AI Widgets

Thanks for helping improve AI Widgets.

## Before you start

- Check existing issues and pull requests before opening a new one.
- Keep changes focused and explain the user-visible behavior they affect.
- Never include provider cookies, API keys, personal usage data, or real
  screenshots in a commit. Use the synthetic data under `docs/demo-data/` and
  `test/fixtures/` instead.

## Local checks

```bash
npm install
npm test
npm run check
git diff --check
```

When testing first-run behavior, use an isolated temporary profile and do not
reuse your normal AI Widgets data directory. The development workflow in
`ROADMAP.md` shows the supported environment variable for that purpose.

## Pull requests

Describe the problem, the change, and how it was tested. Include screenshots
for visual changes when useful, using synthetic data only. Do not commit
generated `dist/` or `node_modules/` contents.
