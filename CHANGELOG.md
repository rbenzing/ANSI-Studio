# Changelog

All notable changes to ANSI Studio are recorded here. Each release lists what was added, changed or fixed, newest first, and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is 0.x, a minor release may change behavior or configuration.

## [Unreleased]

### Fixed

- The server now starts when a host or process manager loads `server.js` through its own wrapper instead of running it directly. Before, it loaded without listening, so hosts that start apps this way answered every request with 503.

## [0.1.0] - 2026-10-30

First public release.

### Added

- Editable canvas of CP437 text cells with 16-color foregrounds and backgrounds, sized by presets or up to 320 columns and 100,000 cells.
- Prompt-to-art: a model draws an SVG that the browser converts to block art, with revising the last picture and using a loaded image as a reference. Model-agnostic: works with any hosted or local model that speaks the Chat Completions API, configured with `MODELS`. Without it, prompts are off and everything else works.
- Image conversion with brightness, contrast and saturation, diffusion or ordered dithering, noise cleanup and a tracing overlay.
- Drawing tools: pencil, fill, line, box and ellipse on half-block pixels, a character brush, a text tool with F1-F10 block characters, mirror mode, a cell grid, and undo and redo.
- Opening existing `.ans` files, including SAUCE metadata, extended color codes and cursor movement.
- TheDraw (`.tdf`) font support for logo lettering.
- Export to `.ans` with a SAUCE record and optional iCE colors, to PNG, and to UTF-8 ANSI for modern terminals.
- Share links that carry the art in the URL fragment, and autosave in the browser.
- Collapsible sidebar panels.
- Production server: security headers, per-IP rate limiting, request size limits, JSON logs without prompts, a `/healthz` endpoint and a non-root Docker image.

[Unreleased]: https://github.com/rbenzing/ANSI-Studio/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/rbenzing/ANSI-Studio/releases/tag/v0.1.0
