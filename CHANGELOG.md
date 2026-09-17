# Changelog

## 0.4.20 — 2026-09-17

- Fix the macOS menu-bar icon in packaged DMG/ZIP builds by loading PNG
  template assets through Electron buffers, including an explicit Retina
  representation.
- Keep the status item compact by removing the duplicated `AI` title next to
  the template icon.
- Keep the Layout menu open inside the tray panel and resize the panel when
  Desktop cards is expanded.
- Avoid shrinking the tray panel after launch by waiting for native resize
  completion before applying the display-height fallback.
- Use stable hyphenated macOS artifact names so `latest-mac.yml` points to the
  generated DMG and ZIP files.
- Reduce the menu-bar template icon to 16 px (32 px Retina) for a lighter
  status-bar footprint.

This release is a local unsigned test build. macOS signing and notarization
remain prerequisites for direct public distribution.
