// @ts-check
import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join } from 'node:path';
import { createModels, ModelError } from './ai.js';
import { MAX_CELLS, MAX_COLS, MAX_PROMPT, MAX_ROWS, PALETTE } from './public/ansi.js';

const PUBLIC_DIR = join(import.meta.dirname, 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' blob: data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
};
const DEADLINE_MS = 180_000; // whole generation, including streaming and SDK retries
const WINDOW_MS = 3_600_000; // rate-limit window
const MAX_BODY = 1_500_000; // bytes: room for a reference image and the current picture
const MAX_PREVIOUS = 200_000;
const MAX_IMAGE = 1_400_000;
const IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/; // the formats every vision provider accepts
const HEX = PALETTE.map((c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()).join(' ');

const system = (/** @type {number} */ w, /** @type {number} */ h) => `You illustrate classic 1990s BBS-scene ANSI art. Draw the user's subject as one SVG for a ${w}x${h} pixel canvas. Every SVG unit becomes one pixel of 16-color block art, so design for that low resolution.
- Reply with only the SVG: start with <svg and end with </svg>. No prose, no markdown fences.
- When a current picture is given, reply with the complete revised SVG.
- Root element: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">.
- Paint the full canvas, beginning with a background rect.
- Use only these colors: ${HEX}. Gradients between them are allowed for shading; they will be dithered.
- Bold silhouettes, thick outlines, strong contrast, no detail smaller than 2 units.
- Include text only if the user asks for it: big bold monospace lettering.
- No images, external references, scripts, filters, opacity or foreignObject.`;

/**
 * @param {{ models: import('./ai.js').Model[], limit?: number, trustProxy?: boolean }} options
 */
export async function createApp({ models, limit = 20, trustProxy = false }) {
  /** @type {Map<string, { type: string, body: Buffer, etag: string }>} */
  const files = new Map();
  for (const name of await readdir(PUBLIC_DIR)) {
    const body = await readFile(join(PUBLIC_DIR, name));
    const type = TYPES[/** @type {keyof typeof TYPES} */ (extname(name))] ?? 'application/octet-stream';
    files.set(`/${name}`, { type: `${type}; charset=utf-8`, body, etag: `"${createHash('sha1').update(body).digest('base64url')}"` });
  }
  files.set('/', /** @type {any} */ (files.get('/index.html')));

  /** @type {Map<string, { n: number, reset: number }>} */
  const hits = new Map();
  const sweep = setInterval(() => { for (const [ip, h] of hits) if (h.reset <= Date.now()) hits.delete(ip); }, WINDOW_MS);
  sweep.unref();

  /** @type {(res: import('node:http').ServerResponse, status: number, body: object | string, headers?: object) => void} */
  const send = (res, status, body, headers = {}) => {
    const json = typeof body === 'object';
    res.writeHead(status, { ...HEADERS, 'content-type': json ? 'application/json' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(json ? JSON.stringify(body) : body);
  };

  /** @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} */
  async function generate(req, res) {
    // Requiring JSON forces a CORS preflight, so other sites cannot spend generations from their visitors' browsers.
    if (!String(req.headers['content-type']).startsWith('application/json')) return send(res, 415, { error: 'Send JSON.' });
    let raw = '', bytes = 0;
    req.setEncoding('utf8');
    for await (const chunk of req) {
      raw += chunk;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BODY) return send(res, 413, { error: 'Request too large.' });
    }
    let input;
    try { input = JSON.parse(raw); } catch { return send(res, 400, { error: 'Body must be JSON.' }); }
    const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : '';
    const { cols, rows, model: id, previous, image } = input ?? {};
    if (!prompt || prompt.length > MAX_PROMPT) return send(res, 400, { error: `Describe the art in 1-${MAX_PROMPT} characters.` });
    if (![[cols, MAX_COLS], [rows, MAX_ROWS]].every(([v, max]) => Number.isInteger(v) && v >= 1 && v <= max) || cols * rows > MAX_CELLS) {
      return send(res, 400, { error: `Size must be 1-${MAX_COLS} columns by 1-${MAX_ROWS} rows, at most ${MAX_CELLS} cells.` });
    }
    const model = id === undefined ? models[0] : models.find((m) => m.id === id);
    if (!model) return send(res, 400, { error: 'Unknown model.' });
    if (previous !== undefined && !(typeof previous === 'string' && previous.length <= MAX_PREVIOUS && /^<svg/i.test(previous))) {
      return send(res, 400, { error: 'The current picture must be an SVG.' });
    }
    if (image !== undefined && !(typeof image === 'string' && image.length <= MAX_IMAGE && IMAGE.test(image))) {
      return send(res, 400, { error: 'The reference image must be a PNG, JPEG or WebP data URL of at most 1 MB.' });
    }

    // Check and count in one synchronous step so concurrent requests cannot slip past the limit.
    const ip = (trustProxy && String(req.headers['x-forwarded-for'] ?? '').split(',').pop()?.trim()) || req.socket.remoteAddress || '?';
    const now = Date.now(), h = hits.get(ip);
    if (!h || h.reset <= now) hits.set(ip, { n: 1, reset: now + WINDOW_MS });
    else if (h.n >= limit) return send(res, 429, { error: 'Generation limit reached. Try again later.' }, { 'retry-after': String(Math.ceil((h.reset - now) / 1000)) });
    else h.n++;

    const text = [
      previous && `Current picture:\n${previous}`,
      image && 'Use the attached image as the reference for the picture.',
      `${previous ? 'Revise the current picture' : 'Draw'}: ${prompt}`,
    ].filter(Boolean).join('\n\n');
    const disconnected = new AbortController();
    res.on('close', () => disconnected.abort());
    try {
      const reply = await model.complete({ system: system(cols, rows * 2), text, image, signal: AbortSignal.any([disconnected.signal, AbortSignal.timeout(DEADLINE_MS)]) });
      console.log(JSON.stringify({ event: 'generate', model: model.id, served: reply.model, refused: reply.refused, usage: reply.usage, ms: Date.now() - now }));
      if (reply.refused) return send(res, 422, { error: 'That prompt was declined. Try describing something else.' });
      const start = reply.text.search(/<svg/i); // anchoring the match keeps it linear on replies full of unclosed tags
      const svg = start < 0 ? undefined : /^[\s\S]*<\/svg>/i.exec(reply.text.slice(start))?.[0];
      if (!svg) return send(res, 502, { error: 'No picture came back. Try again.' });
      send(res, 200, { svg });
    } catch (err) {
      if (disconnected.signal.aborted) return;
      const kind = err instanceof ModelError ? err.kind : 'failed';
      console.error(JSON.stringify({ event: 'generate_failed', model: model.id, kind, error: String(err), ms: Date.now() - now }));
      if (kind === 'busy') return send(res, 503, { error: 'The art model is busy. Try again in a minute.' });
      if (kind === 'auth') return send(res, 503, { error: 'Prompt generation is not available on this server.' });
      send(res, 502, { error: 'Generation failed. Try again.' });
    }
  }

  return createServer(async (req, res) => {
    const started = Date.now();
    const path = URL.parse(req.url ?? '/', 'http://x')?.pathname ?? '';
    res.on('close', () => console.log(JSON.stringify({ method: req.method, path, status: res.writableFinished ? res.statusCode : 'aborted', ms: Date.now() - started })));
    try {
      if (path === '/api/generate') return req.method === 'POST' ? await generate(req, res) : send(res, 405, { error: 'Use POST.' }, { allow: 'POST' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { allow: 'GET, HEAD' });
      if (path === '/healthz') return send(res, 200, 'ok');
      if (path === '/api/models') return send(res, 200, { models: models.map((m) => m.id) });
      const file = files.get(path);
      if (!file) return send(res, 404, 'Not found');
      const headers = { ...HEADERS, 'content-type': file.type, 'cache-control': 'no-cache', etag: file.etag };
      if (req.headers['if-none-match'] === file.etag) return void res.writeHead(304, headers).end();
      res.writeHead(200, headers).end(file.body);
    } catch (err) {
      console.error(JSON.stringify({ event: 'request_failed', path, error: String(err) }));
      if (!res.headersSent) send(res, 500, { error: 'Internal error.' });
    }
  });
}

if (import.meta.main) {
  const env = process.env;
  const { version } = JSON.parse(await readFile(join(import.meta.dirname, 'package.json'), 'utf8'));
  const models = createModels(env);
  const server = await createApp({
    models,
    limit: Number(env.RATE_LIMIT_PER_HOUR) || undefined,
    trustProxy: env.TRUST_PROXY === '1',
  });
  server.listen(Number(env.PORT) || 3000, () => console.log(JSON.stringify({ event: 'listening', version, address: server.address(), models: models.map((m) => m.id) })));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
