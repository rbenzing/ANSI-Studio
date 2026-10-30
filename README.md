# ANSI Studio

<div align="center">

[![Release](https://img.shields.io/github/v/release/rbenzing/ANSI-Studio?style=for-the-badge)](https://github.com/rbenzing/ANSI-Studio/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/rbenzing/ANSI-Studio/ci.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/rbenzing/ANSI-Studio/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.18-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](#-quick-start)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=for-the-badge)](LICENSE)
[![Docker](https://img.shields.io/badge/docker-ready-2496ED?style=for-the-badge&logo=docker&logoColor=white)](#-deploy)
[![Live](https://img.shields.io/badge/live-ansi.studio-55FFFF?style=for-the-badge)](https://ansi.studio)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/russellbenzing)

**Make classic 16-color `.ans` art in the style of the 1990s BBS scene: draw it, type it, drop an image, or describe it**

🎨 **Real CP437 text cells** • 🖼️ **Image to ANSI** • ✍️ **Prompt to art, any model** • 📼 **Real `.ans` with SAUCE**

[Features](#-features) • [Quick start](#-quick-start) • [Configuration](#-configuration) • [Deploy](#-deploy) • [How the art works](#-how-the-art-works) • [Changelog](CHANGELOG.md)

</div>

---

**ANSI Studio** is a small website for making ANSI art. Every way in lands in the same editable canvas of
real text cells, each a CP437 character with a foreground and background color, and every way out is a file
that ANSI viewers and BBS software read as intended.

Try it at **[ansi.studio](https://ansi.studio)**. Your work is autosaved in your browser.

---

## ✨ Features

- **Describe it** — a model draws an SVG for your prompt and the browser converts it to block art. ANSI Studio is
  model-agnostic: point it at any hosted or local model that speaks the Chat Completions API. Revise the last picture,
  or hand the model a loaded image as a reference.
- **Drop an image** — scaled to your width, adjusted for brightness, contrast and saturation, dithered to the VGA
  palette (diffusion or ordered), and cleaned of stray pixels. Keep it on screen as a tracing overlay.
- **Draw** — pencil, fill, line, box and ellipse on half-block pixels, plus a character brush for shading and
  line-drawing characters, mirror mode and a cell grid.
- **Type** — a text tool with F1-F10 for the common block characters and a character palette for the rest.
- **Letter logos** — load a TheDraw font (`.tdf`) and place big logo text.
- **Open existing art** — `.ans`, `.asc`, `.diz`, `.nfo` and `.txt`, including SAUCE metadata, extended color codes
  and cursor movement.
- **Export** — a real `.ans` with a SAUCE record and optional iCE colors, a PNG, or UTF-8 ANSI for modern terminals.
- **Share** — copy a link that carries the whole picture inside the URL; nothing is uploaded.
- **Sizes** — presets for the classic DOS screen, 50-line VGA, scrollers, wide art and `FILE_ID.DIZ`, or any size up
  to 320 columns and 100,000 cells.

---

## 🚀 Quick start

You need Node.js 22.18 or later.

```sh
npm install
npm start   # http://localhost:3000
```

Drawing, images, files and sharing run entirely in the browser and need no configuration. To turn on prompt
generation, list one or more models:

```sh
MODELS=local/my-model LOCAL_BASE_URL=http://localhost:8080/v1 npm start
```

### Keyboard and mouse

| Input | Action |
|---|---|
| Click a color / right-click or Shift-click a color | Pick the foreground / background |
| Drag / right-drag on the canvas | Paint with the foreground / background (the character brush erases) |
| Text tool: click a cell, then type | Type at the cursor; Enter goes to the next line, arrows move, Esc stops |
| F1-F10 | Insert the first ten characters of the palette while typing |
| Ctrl+Z / Ctrl+Y or Ctrl+Shift+Z | Undo / redo |
| Drop a file on the page | Open `.ans` and text files, or convert an image |

---

## 🔧 Configuration

| Variable | Default | Purpose |
|---|---|---|
| `MODELS` | none (prompts off) | Comma-separated `provider/model` list offered for prompts; the first is the default. The provider is a name you choose, the text before the first slash; the rest is the model id the provider expects, which may contain slashes |
| `<PROVIDER>_BASE_URL` | none | The provider's Chat Completions API URL, ending before `/chat/completions`, e.g. `LOCAL_BASE_URL=http://localhost:8080/v1`. `<PROVIDER>` is the provider name in upper case, with characters other than letters and digits replaced by `_`. The server refuses to start without it, except for providers with a native adapter in `ai.js` |
| `<PROVIDER>_API_KEY` | none | The provider's API key, sent as a bearer token. Most local servers need none |
| `<PROVIDER>_MAX_TOKENS` | none | Caps each reply's length, sent as `max_completion_tokens`, which bounds the cost of a generation. Leave it unset for servers that reject that field. Reasoning models count their thinking toward it, so allow room, e.g. `16000` |
| `RATE_LIMIT_PER_HOUR` | `20` | Prompt generations per client IP per hour |
| `TRUST_PROXY` | off | Set to `1` behind one reverse proxy so the limit uses `X-Forwarded-For` |
| `PORT` | `3000` | Listen port |

The image reference only works with models that accept images. Set a spend limit with your model provider as the
hard cost ceiling.

---

## 🐳 Deploy

**Docker**

```sh
docker build -t ansi-studio .
docker run -p 3000:3000 \
  -e MODELS=hosted/model-id \
  -e HOSTED_BASE_URL=https://api.example.com/v1 \
  -e HOSTED_API_KEY=... \
  ansi-studio
```

The container runs as a non-root user and has a health check on `/healthz`.

**Any Node.js host** — no build step. Install dependencies, set the environment variables above, and use
`server.js` as the entry file. It starts the server however the host loads it, and listens on `PORT`.

Logs are one JSON object per line. Each generation logs its model and token usage, never the prompt. Terminate TLS
at your proxy or platform. The rate limiter lives in memory, so each instance counts separately.

---

## 🔒 Security

- Strict security headers on the page and API: a content security policy, no framing, `nosniff`, no referrer and
  HSTS.
- Only JSON requests reach the generation endpoint, so other sites cannot spend your quota through their visitors'
  browsers. Requests, prompts, pictures and images are size-limited, and each generation has a deadline.
- API keys stay on the server. Model output is only ever drawn as an image, never inserted as page content.
- Opened files are decoded with hard size limits, so a crafted `.ans` cannot freeze the page.

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

---

## 🎨 How the art works

Pixel tools treat each cell as two square pixels, the upper and lower half-block. The encoder writes each block cell
as a space, full block, upper or lower half, whichever needs the fewest color changes. Text, shading and
line-drawing cells are written as they are. Bold gives bright foregrounds. Bright backgrounds need iCE colors, so the
encoder avoids them when a cell allows it and sets the SAUCE iCE flag only when needed. With iCE colors off, bright
backgrounds are darkened for BBS software that would blink them.

Full-width rows carry no line breaks, because ANSI viewers wrap immediately at the last column and a CR LF there would
add a blank line. The SAUCE record declares the width, height, the 8-pixel VGA font and square pixels. Widths other
than 80 render correctly only in viewers that read SAUCE.

Opening a file follows what those viewers do: SAUCE width, immediate wrap, classic and extended color codes mapped to
the palette, cursor movement, and SUB as the end of the text.

---

## 💻 Develop

```sh
npm run check   # lint, type check, tests
```

| File | Role |
|---|---|
| `index.html` | The page. It lives outside `public/` so it is always served by the app with its security headers, even on hosts that serve `public/` themselves |
| `public/ansi.js` | Palette, CP437, cells, pixel tools, image conversion, the `.ans` encoder and decoder, and UTF-8 export. Shared by browser, server and tests |
| `public/tdf.js` | TheDraw font parser and text renderer |
| `public/app.js` | Browser UI: VGA glyph rendering, tools, files, autosave and sharing |
| `public/vga.f16` | VGA 8x16 font, 256 glyphs of 16 bytes |
| `server.js` | Entry point: reads the environment and starts the server |
| `create-app.js` | Static files, `GET /api/models`, `POST /api/generate`, rate limiting and security headers |
| `ai.js` | Model adapters: the Chat Completions API, plus native SDK adapters |
| `test/` | Node test runner suites |

---

## 🤝 Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and the release process.
Releases follow [Semantic Versioning](https://semver.org/), and every change is listed in [CHANGELOG.md](CHANGELOG.md).
Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

---

## 📄 License

ANSI Studio is licensed under the [Apache License 2.0](LICENSE). The bundled VGA font is third-party data under the
BSD 2-Clause license; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

## 👤 About the Author

Built by **[Russell Benzing](https://russellbenzing.com)**, the mad web scientist. ANSI Studio brings the 1990s ANSI
art scene to the browser, with a real `.ans` file at the end of every path.

---

## 🆘 Support

- **Issues**: [GitHub Issues](https://github.com/rbenzing/ANSI-Studio/issues)
- **Releases**: [github.com/rbenzing/ANSI-Studio/releases](https://github.com/rbenzing/ANSI-Studio/releases)
- **Live site**: [ansi.studio](https://ansi.studio)

If ANSI Studio is useful to you, you can support the work:

<div align="center">

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/russellbenzing)

</div>
