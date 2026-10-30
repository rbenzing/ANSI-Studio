# ANSI Studio

[![CI](https://github.com/rbenzing/ANSI-Studio/actions/workflows/ci.yml/badge.svg)](https://github.com/rbenzing/ANSI-Studio/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/rbenzing/ANSI-Studio)](https://github.com/rbenzing/ANSI-Studio/releases)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

A small website for making classic 16-color `.ans` art, the kind you see on 16colors.net. Every way in lands in the same editable canvas of real text cells, each a CP437 character with a foreground and background color.

- **Describe it.** A model draws an SVG for your prompt and the browser converts it to block art. Use Claude or any OpenAI-compatible provider: OpenAI, Gemini, Ollama, OpenRouter, Groq, Mistral or a local server. You can revise the last picture, or hand the model the loaded image as a reference.
- **Drop an image.** It is scaled to your width, adjusted for brightness, contrast and saturation, dithered to the VGA palette, and cleaned of stray pixels. Dithering can be diffusion or ordered. The image can also stay on screen as a tracing overlay.
- **Draw and type.**
  - **Pixel tools:** pencil, fill, line, box and ellipse work on half-block pixels.
  - **Character tools:** the character brush paints shading and line-drawing characters, and the text tool types with F1-F10 for the common block characters.
  - **Aids:** mirror mode, a cell grid, and undo and redo.
- **Open and letter.** Open an existing `.ans` to edit it, or load a TheDraw font (`.tdf`) and place logo text.

Export a real `.ans` file with a SAUCE record, a PNG, or UTF-8 ANSI for modern terminals. You can also copy a share link that carries the art inside the URL. Work is autosaved in the browser.

## Run it

```sh
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start   # http://localhost:3000
```

Drawing, images, files and sharing run entirely in the browser. Only prompt generation needs a model.

| Variable | Default | Purpose |
|---|---|---|
| `MODELS` | `anthropic/claude-opus-5-5` | Comma-separated `provider/model` list offered for prompts; the first is the default. The provider is the text before the first slash, e.g. `openai/gpt-5`, `gemini/gemini-2.5-flash`, `ollama/qwen3:8b`, `openrouter/meta-llama/llama-4-maverick`. `anthropic` uses the Anthropic SDK; every other provider uses its OpenAI-compatible Chat Completions API |
| `ANTHROPIC_API_KEY` | none | Key for `anthropic/...` models |
| `<PROVIDER>_API_KEY` | none | Bearer key for an OpenAI-compatible provider, e.g. `OPENAI_API_KEY`. `<PROVIDER>` is the provider name in upper case, with characters other than letters and digits replaced by `_`. Ollama and most local servers need none |
| `<PROVIDER>_BASE_URL` | built in for `openai`, `gemini`, `ollama`, `openrouter`, `groq`, `mistral` | API URL ending before `/chat/completions`. Required for any other provider, e.g. `LMSTUDIO_BASE_URL=http://localhost:1234/v1` or a vLLM server; the server refuses to start without it |
| `RATE_LIMIT_PER_HOUR` | `20` | Prompt generations per client IP per hour |
| `TRUST_PROXY` | off | Set to `1` behind one reverse proxy so the limit uses `X-Forwarded-For` |
| `PORT` | `3000` | Listen port |

The image reference only works with models that accept images.

## Deploy

```sh
docker build -t ansi-studio .
docker run -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... ansi-studio
```

The container runs as a non-root user and has a health check on `/healthz`. Logs are one JSON object per line. Each generation logs its model and token usage, never the prompt. Terminate TLS at your proxy or platform.

The rate limiter lives in memory, so each instance counts separately, and an IPv6 client can rotate addresses within its network. Set a spend limit with your model provider as the hard cost ceiling.

## Develop

```sh
npm run check   # lint, type check, tests
```

| File | Role |
|---|---|
| `public/ansi.js` | Palette, CP437, cells, pixel tools, image conversion, the `.ans` encoder and decoder, and UTF-8 export. Shared by browser, server and tests |
| `public/tdf.js` | TheDraw font parser and text renderer |
| `public/app.js` | Browser UI: VGA glyph rendering, tools, files, autosave and sharing |
| `public/vga.f16` | IBM VGA 8x16 font, 256 glyphs of 16 bytes |
| `server.js` | Static files, `GET /api/models`, `POST /api/generate`, rate limiting and security headers |
| `ai.js` | Model adapters: Anthropic SDK and OpenAI-compatible Chat Completions |
| `test/` | Node test runner suites |

## How the art works

Pixel tools treat each cell as two square pixels, the upper and lower half-block. The encoder writes each block cell as a space, full block, upper or lower half, whichever needs the fewest color changes. Text, shading and line-drawing cells are written as they are. Bold gives bright foregrounds. Bright backgrounds need iCE colors, so the encoder avoids them when a cell allows it and sets the SAUCE iCE flag only when needed. With iCE colors off, bright backgrounds are darkened for BBS software that would blink them.

Full-width rows carry no line breaks, because ANSI viewers wrap immediately at the last column and a CR LF there would add a blank line. The SAUCE record declares the width, height, the 8-pixel IBM VGA font and square pixels. Widths other than 80 render correctly only in viewers that read SAUCE, such as 16colors, PabloDraw, Moebius and ansilove.js.

Opening a file follows what those viewers do: SAUCE width, immediate wrap, classic and extended color codes mapped to the palette, cursor movement, and SUB as the end of the text.

## Contributing and versioning

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and the release process, and [SECURITY.md](SECURITY.md) to report a vulnerability privately. Releases follow [Semantic Versioning](https://semver.org/), and every change is listed in [CHANGELOG.md](CHANGELOG.md).

## License

ANSI Studio is licensed under the [Apache License 2.0](LICENSE). The bundled VGA font comes from libansilove under the BSD 2-Clause license; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
