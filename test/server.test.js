// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ModelError } from '../ai.js';
import { MAX_CELLS, MAX_COLS } from '../public/ansi.js';
import { createApp } from '../create-app.js';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 50"><rect width="80" height="50" fill="#0000AA"/></svg>';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

/** Start the app on a random port with two fake models; returns request helpers and the recorded calls. */
async function start(/** @type {(request: import('../ai.js').ModelRequest) => any} */ reply, options = {}) {
  /** @type {any[]} */
  const calls = [];
  const fake = (/** @type {string} */ id) => ({ id, complete: async (/** @type {import('../ai.js').ModelRequest} */ request) => { calls.push({ id, ...request }); return reply(request); } });
  const server = await createApp({ models: [fake('fake/one'), fake('fake/two')], ...options });
  await new Promise((resolve) => server.listen(0, () => resolve(null)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const request = (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) => fetch(`http://127.0.0.1:${port}${path}`, init);
  const generate = (/** @type {unknown} */ body, headers = {}, /** @type {AbortSignal | undefined} */ signal = undefined) =>
    request('/api/generate', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body), signal });
  /** Send bytes over a raw socket, for requests fetch would normalize. */
  const raw = (/** @type {string} */ text) => new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.end(text));
    let data = '';
    socket.on('data', (chunk) => { data += chunk; }).on('end', () => resolve(data)).on('error', reject);
  });
  return { request, generate, raw, calls, port, close: () => server.close() };
}

const OK = { prompt: 'cat', cols: 80, rows: 25 };

const answer = (/** @type {object} */ extra) => ({ text: `Here you go:\n${SVG}\nEnjoy`, refused: false, model: 'served-model', usage: {}, ...extra });

test('serves the app with security headers, caching validators and no directory traversal', async (t) => {
  const app = await start(() => answer({}));
  t.after(app.close);
  const page = await app.request('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await page.text(), /<canvas id="canvas"/);

  const script = await app.request('/app.js');
  assert.match(script.headers.get('content-type') ?? '', /^text\/javascript/);
  const etag = script.headers.get('etag') ?? '';
  assert.equal((await app.request('/app.js', { headers: { 'if-none-match': etag } })).status, 304);

  assert.equal((await app.request('/healthz')).status, 200);
  assert.equal((await app.request('/server.js')).status, 404);
  assert.match(String(await app.raw('GET /../server.js HTTP/1.1\r\nHost: x\r\n\r\n')), /^HTTP\/1\.1 404/);
  assert.match(String(await app.raw('GET /%2e%2e/package.json HTTP/1.1\r\nHost: x\r\n\r\n')), /^HTTP\/1\.1 404/);
  assert.equal((await app.request('/', { method: 'DELETE' })).status, 405);
  assert.equal((await app.request('/api/generate')).status, 405);
});

test('with no models configured, prompts are unavailable and everything else still works', async (t) => {
  const server = await createApp({ models: [] });
  await new Promise((resolve) => server.listen(0, () => resolve(null)));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  assert.deepEqual(await (await fetch(`${base}/api/models`)).json(), { models: [] });
  const res = await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OK) });
  assert.deepEqual([res.status, (await res.json()).error], [503, 'Prompt generation is not available on this server.']);
  assert.equal((await fetch(`${base}/`)).status, 200);
});

test('lists the configured models', async (t) => {
  const app = await start(() => answer({}));
  t.after(app.close);
  const res = await app.request('/api/models');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { models: ['fake/one', 'fake/two'] });
  assert.equal((await app.request('/api/models', { method: 'POST' })).status, 405);
});

test('generate returns the SVG and asks the first model for the requested canvas size', async (t) => {
  const app = await start(() => answer({}));
  t.after(app.close);
  const res = await app.generate({ prompt: '  a blue square  ', cols: 80, rows: 25 });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { svg: SVG });
  const [call] = app.calls;
  assert.equal(call.id, 'fake/one');
  assert.match(call.system, /viewBox="0 0 80 50"/);
  assert.equal(call.text, 'Draw: a blue square');
  assert.equal(call.image, undefined);
  assert.ok(call.signal instanceof AbortSignal, 'the call can be cancelled');
});

test('generate uses the requested model and rejects unknown ones', async (t) => {
  const app = await start(() => answer({}));
  t.after(app.close);
  assert.equal((await app.generate({ ...OK, model: 'fake/two' })).status, 200);
  assert.equal(app.calls[0].id, 'fake/two');
  for (const model of ['fake/three', 'two', '', null, 1]) {
    const res = await app.generate({ ...OK, model });
    assert.equal(res.status, 400, JSON.stringify(model));
    assert.equal((await res.json()).error, 'Unknown model.');
  }
  assert.equal(app.calls.length, 1);
});

test('generate sends the current picture and reference image with the prompt', async (t) => {
  const app = await start(() => answer({}));
  t.after(app.close);
  assert.equal((await app.generate({ ...OK, prompt: 'make it red', previous: SVG, image: PNG })).status, 200);
  const [call] = app.calls;
  assert.equal(call.text, `Current picture:\n${SVG}\n\nUse the attached image as the reference for the picture.\n\nRevise the current picture: make it red`);
  assert.equal(call.image, PNG);
  assert.match(call.system, /complete revised SVG/);

  assert.equal((await app.generate({ ...OK, previous: SVG })).status, 200);
  assert.equal(app.calls[1].text, `Current picture:\n${SVG}\n\nRevise the current picture: cat`);
  assert.equal(app.calls[1].image, undefined);

  assert.equal((await app.generate({ ...OK, image: PNG })).status, 200);
  assert.equal(app.calls[2].text, 'Use the attached image as the reference for the picture.\n\nDraw: cat');
});

test('generate validates the current picture and reference image', async (t) => {
  const app = await start(() => answer({}));
  t.after(app.close);
  const svg = (/** @type {number} */ length) => '<SVG ' + ' '.repeat(length - 6) + '>';
  const png = (/** @type {number} */ length) => 'data:image/png;base64,' + 'A'.repeat(length - 22);
  for (const previous of [svg(200_000), '<svg/>']) assert.equal((await app.generate({ ...OK, previous })).status, 200);
  for (const image of [png(1_400_000), 'data:image/jpeg;base64,/9j/4A==', 'data:image/webp;base64,UklGRg==']) {
    assert.equal((await app.generate({ ...OK, image })).status, 200, image.slice(0, 30));
  }
  assert.equal(app.calls.length, 5);
  for (const previous of [svg(200_001), ' <svg/>', '<html>', '', null, ['<svg/>']]) {
    assert.equal((await app.generate({ ...OK, previous })).status, 400, String(previous).slice(0, 30));
  }
  for (const image of [png(1_400_001), 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png,iVBORw0KGgo=', 'data:image/png;base64,iVBOR w0KGgo=',
    'data:image/png;base64,', 'https://example.com/cat.png', '', null, 'data:image/gif;base64,R0lGODlh']) {
    assert.equal((await app.generate({ ...OK, image })).status, 400, String(image).slice(0, 30));
  }
  assert.equal(app.calls.length, 5);
});

test('generate cancels the model call when the client disconnects', async (t) => {
  const app = await start(({ signal }) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')))));
  t.after(app.close);
  const client = new AbortController();
  const pending = app.generate(OK, {}, client.signal).catch(() => 'aborted');
  while (!app.calls.length) await new Promise((resolve) => setTimeout(resolve, 5));
  client.abort();
  assert.equal(await pending, 'aborted');
  while (!app.calls[0].signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5));
});

test('generate rejects bad input before calling the model', async (t) => {
  const app = await start(() => answer({}));
  t.after(app.close);
  const tall = Math.floor(MAX_CELLS / MAX_COLS) + 1;
  for (const body of ['not json', {}, { prompt: ' ', cols: 80, rows: 25 }, { prompt: 'x'.repeat(501), cols: 80, rows: 25 },
    { prompt: 'cat', cols: 0, rows: 25 }, { prompt: 'cat', cols: 80, rows: 1001 }, { prompt: 'cat', cols: 8.5, rows: 25 }, { prompt: 'cat', cols: '80', rows: 25 },
    { prompt: 'cat', cols: MAX_COLS, rows: tall }]) {
    assert.equal((await app.generate(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await app.generate('x'.repeat(1_500_001))).status, 413);
  assert.equal((await app.generate('é'.repeat(750_001))).status, 413, 'the limit counts bytes, not characters');
  const plain = await app.request('/api/generate', { method: 'POST', body: JSON.stringify({ prompt: 'cat', cols: 80, rows: 25 }) });
  assert.equal(plain.status, 415, 'non-JSON content types would let other sites post without a CORS preflight');
  assert.equal(app.calls.length, 0);
  assert.equal((await app.generate({ prompt: 'cat', cols: MAX_COLS, rows: tall - 1 })).status, 200, 'the largest canvas is allowed');
  assert.equal((await app.generate({ ...OK, prompt: 'x'.repeat(500) })).status, 200, 'the longest prompt the page allows is accepted');
});

test('a client that disconnects mid-upload does not take the server down', async (t) => {
  const app = await start(() => answer({}));
  t.after(app.close);
  await new Promise((resolve) => {
    const socket = net.connect(app.port, '127.0.0.1', () => {
      socket.write('POST /api/generate HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n{"prompt":');
      setTimeout(() => resolve(socket.destroy()), 20);
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 50)); // let the aborted upload fail inside the server
  assert.equal((await app.request('/healthz')).status, 200);
  assert.equal(app.calls.length, 0);
});

test('generate decodes UTF-8 split across body chunks', async (t) => {
  const app = await start(() => answer({}));
  t.after(app.close);
  const body = Buffer.from(JSON.stringify({ prompt: 'café skull', cols: 80, rows: 25 }));
  const split = body.indexOf(0xc3) + 1; // inside the two-byte é
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ port: app.port, method: 'POST', path: '/api/generate', headers: { 'content-type': 'application/json' } }, (res) => resolve(res.statusCode));
    req.on('error', reject);
    req.write(body.subarray(0, split));
    setTimeout(() => req.end(body.subarray(split)), 20);
  });
  assert.equal(status, 200);
  assert.equal(app.calls[0].text, 'Draw: café skull');
});

test('a malformed request target gets an error response instead of crashing the server', async (t) => {
  const app = await start(() => answer({}));
  t.after(app.close);
  assert.match(String(await app.raw('GET http://a:99999/ HTTP/1.1\r\nHost: x\r\n\r\n')), /^HTTP\/1\.1 404/);
  assert.equal((await app.request('/healthz')).status, 200, 'still serving');
});

test('generate maps model outcomes to clear errors', async (t) => {
  const busy = 'The art model is busy. Try again in a minute.', refused = 'The model provider refused this server\'s API key or its access to the model. The server log has the provider\'s reason.', failed = 'Generation failed. Try again.';
  const cases = [
    [() => answer({ refused: true, text: '' }), 422, 'That prompt was declined. Try describing something else.'],
    [() => answer({ text: 'I cannot draw that.' }), 502, 'No picture came back. Try again.'],
    [() => answer({ text: '<svg viewBox="0 0 1 1"><rect' }), 502, 'No picture came back. Try again.'],
    [() => { throw new ModelError('busy', '429'); }, 503, busy],
    [() => { throw new ModelError('auth', '401'); }, 503, refused],
    [() => { throw new ModelError('failed', '500'); }, 502, failed],
    [() => { throw Object.assign(new Error('not a ModelError'), { kind: 'busy' }); }, 502, failed],
  ];
  for (const [reply, status, error] of cases) {
    const app = await start(/** @type {any} */ (reply));
    t.after(app.close);
    const res = await app.generate({ prompt: 'cat', cols: 80, rows: 25 });
    assert.equal(res.status, status);
    assert.equal((await res.json()).error, error);
  }
});

test('generate is rate limited per client', async (t) => {
  const app = await start(() => answer({}), { limit: 2 });
  t.after(app.close);
  const ok = { prompt: 'cat', cols: 80, rows: 25 };
  assert.equal((await app.generate(ok)).status, 200);
  assert.equal((await app.generate({ prompt: '' })).status, 400, 'invalid requests do not use quota');
  assert.equal((await app.generate({ ...ok, model: 'nope' })).status, 400, 'invalid requests do not use quota');
  assert.equal((await app.generate(ok)).status, 200);
  const limited = await app.generate(ok);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal(app.calls.length, 2);
});

test('the rate limit window resets', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const app = await start(() => answer({}), { limit: 1 });
  t.after(app.close);
  assert.equal((await app.generate(OK)).status, 200);
  assert.equal((await app.generate(OK)).status, 429);
  t.mock.timers.tick(3_600_000);
  assert.equal((await app.generate(OK)).status, 200);
});

test('the rate limit trusts X-Forwarded-For only behind a proxy, and then only its last hop', async (t) => {
  const direct = await start(() => answer({}), { limit: 1 });
  t.after(direct.close);
  assert.equal((await direct.generate(OK, { 'x-forwarded-for': '198.51.100.1' })).status, 200);
  assert.equal((await direct.generate(OK, { 'x-forwarded-for': '198.51.100.2' })).status, 429, 'spoofed header ignored');

  const proxied = await start(() => answer({}), { limit: 1, trustProxy: true });
  t.after(proxied.close);
  assert.equal((await proxied.generate(OK, { 'x-forwarded-for': 'spoof-a, 203.0.113.7' })).status, 200);
  assert.equal((await proxied.generate(OK, { 'x-forwarded-for': 'spoof-b, 203.0.113.7' })).status, 429, 'client-written hops ignored');
  assert.equal((await proxied.generate(OK, { 'x-forwarded-for': '203.0.113.8' })).status, 200, 'other clients keep their quota');
});

test('concurrent requests cannot slip past the rate limit', async (t) => {
  const app = await start(() => answer({}), { limit: 2 });
  t.after(app.close);
  const statuses = await Promise.all(Array.from({ length: 8 }, () => app.generate({ prompt: 'cat', cols: 80, rows: 25 }).then((r) => r.status)));
  assert.deepEqual(statuses.toSorted(), [200, 200, 429, 429, 429, 429, 429, 429]);
  assert.equal(app.calls.length, 2);
});

// Hosts start the entry file through their own loader, with import() or with require(); both must end up listening.
for (const [how, loader] of /** @type {[string, string[]][]} */ ([
  ['imports', ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../server.js', import.meta.url).href)});`]],
  ['requires', ['-e', `require(${JSON.stringify(fileURLToPath(new URL('../server.js', import.meta.url)))});`]],
])) test(`server.js starts listening when a host wrapper ${how} it`, async () => {
  const child = spawn(process.execPath, loader, { env: { ...process.env, PORT: '0', MODELS: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const listening = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += chunk;
        const line = out.split('\n').find((l) => l.includes('"listening"'));
        if (line) resolve(JSON.parse(line));
      });
      child.on('exit', (code) => reject(new Error(`server.js exited with ${code} without listening`)));
    });
    assert.equal((await fetch(`http://127.0.0.1:${listening.address.port}/healthz`)).status, 200);
  } finally {
    child.kill();
  }
});
