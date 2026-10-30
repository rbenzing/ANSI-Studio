// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { createModels, ModelError } from '../ai.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const REQUEST = { system: 'sys', text: 'Draw: cat' };
const SDK = { MODELS: 'anthropic/claude-opus-5-5' }; // the provider id that selects the SDK adapter

/** A fake SDK client that records each stream call and answers with `reply(params, options)`. */
function fakeAnthropic(/** @type {(params: any, options: any) => any} */ reply = () => message({})) {
  /** @type {{ params: any, options: any }[]} */
  const calls = [];
  const stream = (/** @type {any} */ params, /** @type {any} */ options) => ({ finalMessage: async () => { calls.push({ params, options }); return reply(params, options); } });
  return { calls, client: /** @type {any} */ ({ beta: { messages: { stream } } }) };
}

const message = (/** @type {object} */ extra) => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { output_tokens: 7 }, content: [{ type: 'text', text: '<svg>' }, { type: 'thinking', thinking: 'hm' }, { type: 'text', text: '</svg>' }], ...extra });

/** Start a local Chat Completions server; `respond` gets each request and its parsed body. */
async function chatServer(/** @type {(req: http.IncomingMessage, body: any, res: http.ServerResponse) => void} */ respond) {
  /** @type {{ method?: string, url?: string, headers: http.IncomingHttpHeaders, body: any }[]} */
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    respond(req, body, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(null)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { requests, url: `http://127.0.0.1:${port}/v1`, close: () => { server.closeAllConnections(); server.close(); } };
}

const json = (/** @type {http.ServerResponse} */ res, /** @type {number} */ status, /** @type {unknown} */ body) =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
const completion = (/** @type {object} */ message, extra = {}) => ({ model: 'served', usage: { total_tokens: 3 }, choices: [{ finish_reason: 'stop', message: { role: 'assistant', ...message } }], ...extra });

test('MODELS lists provider/model entries, split at the first slash; without it there are none', () => {
  const { client } = fakeAnthropic();
  assert.deepEqual(createModels({}), [], 'no MODELS turns prompt generation off');
  assert.deepEqual(createModels({ MODELS: ' , ' }), []);
  const env = { MODELS: ' gateway/org/model:free , ,local/model:8b,\tanthropic/claude-sonnet-5-5 ', GATEWAY_BASE_URL: 'http://gateway/v1', LOCAL_BASE_URL: 'http://localhost:1234/v1' };
  const models = createModels(env, { anthropic: client });
  assert.deepEqual(models.map((m) => m.id), ['gateway/org/model:free', 'local/model:8b', 'anthropic/claude-sonnet-5-5']);
  for (const model of models) assert.equal(typeof model.complete, 'function');
});

test('MODELS mistakes fail at startup with the setting to fix', () => {
  assert.throws(() => createModels({ MODELS: 'studio/model' }), /STUDIO_BASE_URL/);
  assert.throws(() => createModels({ MODELS: 'my-host/model' }), /MY_HOST_BASE_URL/);
  assert.throws(() => createModels({ MODELS: 'model' }), /"model" must look like provider\/model/);
  assert.throws(() => createModels({ MODELS: '/model' }), /provider\/model/);
  assert.throws(() => createModels({ MODELS: 'local/' }), /provider\/model/);
  assert.equal(createModels({ MODELS: 'studio/model', STUDIO_BASE_URL: 'http://localhost:1234/v1' }).length, 1);
});

test('SDK models send the documented request and read the reply', async () => {
  const { client, calls } = fakeAnthropic();
  const [model] = createModels(SDK, { anthropic: client });
  const signal = new AbortController().signal;
  assert.deepEqual(await model.complete({ ...REQUEST, signal }), { text: '<svg></svg>', refused: false, model: 'claude-opus-5-5', usage: { output_tokens: 7 } });
  assert.deepEqual(calls[0].params, {
    model: 'claude-opus-5-5', max_tokens: 16000, output_config: { effort: 'medium' }, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'Draw: cat' }] }],
  });
  assert.equal(calls[0].options.signal, signal);

  await model.complete({ ...REQUEST, image: 'data:image/jpeg;base64,/9j/4A==' });
  assert.deepEqual(calls[1].params.messages[0].content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4A==' } },
    { type: 'text', text: 'Draw: cat' },
  ]);

  const refusing = createModels(SDK, { anthropic: fakeAnthropic(() => message({ stop_reason: 'refusal', content: [] })).client })[0];
  assert.deepEqual(await refusing.complete(REQUEST), { text: '', refused: true, model: 'claude-opus-5-5', usage: { output_tokens: 7 } });
});

test('SDK effort and fallbacks go only to the models that support them', async () => {
  const { client, calls } = fakeAnthropic();
  const supported = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'];
  const others = ['claude-haiku-4-5', 'claude-opus-4-1', 'claude-sonnet-5'];
  const models = createModels({ MODELS: [...supported, ...others].map((m) => `anthropic/${m}`).join(',') }, { anthropic: client });
  for (const model of models) await model.complete(REQUEST);
  for (const { params } of calls) {
    const expected = supported.includes(params.model);
    for (const key of ['output_config', 'betas', 'fallbacks']) assert.equal(key in params, expected, `${params.model} ${key}`);
    assert.equal(params.max_tokens, 16000);
  }
  assert.deepEqual(calls.map((c) => c.params.model), [...supported, ...others]);
});

test('SDK errors are classified, keeping the original as the cause', async () => {
  const cases = [
    [new Anthropic.RateLimitError(429, {}, 'x', new Headers()), 'busy'],
    [new Anthropic.AuthenticationError(401, {}, 'x', new Headers()), 'auth'],
    [new Anthropic.PermissionDeniedError(403, {}, 'x', new Headers()), 'auth'],
    // What SDK 1.3.0 throws before sending anything when no API key or auth token is configured.
    [new Anthropic.AnthropicError('Could not resolve authentication method. Expected either apiKey or authToken to be set.'), 'auth'],
    [new Anthropic.InternalServerError(500, {}, 'x', new Headers()), 'failed'],
    [new Anthropic.APIConnectionError({ message: 'offline' }), 'failed'],
    // How the SDK's stream surfaces a connection cut mid-response (checked against SDK 1.3.0).
    [Object.assign(new Anthropic.AnthropicError('terminated'), { cause: new TypeError('terminated') }), 'failed'],
  ];
  for (const [error, kind] of cases) {
    const [model] = createModels(SDK, { anthropic: fakeAnthropic(() => { throw error; }).client });
    await assert.rejects(model.complete(REQUEST), (err) => {
      assert.ok(err instanceof ModelError);
      assert.equal(err.kind, kind, String(error));
      assert.equal(err.cause, error);
      return true;
    });
  }
});

test('SDK calls rethrow the original error once the caller aborted', async () => {
  const controller = new AbortController();
  const original = new Anthropic.APIUserAbortError();
  const [model] = createModels(SDK, { anthropic: fakeAnthropic(() => { controller.abort(); throw original; }).client });
  await assert.rejects(model.complete({ ...REQUEST, signal: controller.signal }), (err) => err === original);
});

test('Chat Completions models post chat completions to the provider base URL', async (t) => {
  const server = await chatServer((_, __, res) => json(res, 200, completion({ content: '<svg></svg>' })));
  t.after(server.close);
  const env = { MODELS: 'local/vendor/model:7b', LOCAL_BASE_URL: `${server.url}/`, LOCAL_API_KEY: 'secret' };
  const [model] = createModels(env);
  assert.deepEqual(await model.complete(REQUEST), { text: '<svg></svg>', refused: false, model: 'served', usage: { total_tokens: 3 } });
  const [first] = server.requests;
  assert.equal(first.method, 'POST');
  assert.equal(first.url, '/v1/chat/completions', 'trailing slash stripped');
  assert.equal(first.headers.authorization, 'Bearer secret');
  assert.match(first.headers['content-type'] ?? '', /^application\/json/);
  assert.deepEqual(first.body, { model: 'vendor/model:7b', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Draw: cat' }] });

  const [keyless] = createModels({ ...env, LOCAL_API_KEY: '' });
  await keyless.complete({ ...REQUEST, image: PNG });
  const [, second] = server.requests;
  assert.equal(second.headers.authorization, undefined, 'no key, no header');
  assert.deepEqual(second.body.messages[1], { role: 'user', content: [{ type: 'text', text: 'Draw: cat' }, { type: 'image_url', image_url: { url: PNG } }] });
});

test('Chat Completions replies are read from string or part content, and refusals from either signal', async (t) => {
  /** @type {object[]} */
  const replies = [
    completion({ content: [{ type: 'text', text: '<svg>' }, { type: 'image_url' }, { type: 'text', text: '</svg>' }] }),
    completion({ content: null, refusal: 'I cannot help with that.' }),
    { choices: [{ finish_reason: 'content_filter', message: { content: '' } }] },
    { choices: [] },
  ];
  const server = await chatServer((_, __, res) => json(res, 200, replies.shift()));
  t.after(server.close);
  const [model] = createModels({ MODELS: 'local/m', LOCAL_BASE_URL: server.url });
  assert.deepEqual(await model.complete(REQUEST), { text: '<svg></svg>', refused: false, model: 'served', usage: { total_tokens: 3 } });
  assert.equal((await model.complete(REQUEST)).refused, true);
  assert.deepEqual(await model.complete(REQUEST), { text: '', refused: true, model: 'm', usage: undefined });
  assert.deepEqual(await model.complete(REQUEST), { text: '', refused: false, model: 'm', usage: undefined });
});

test('Chat Completions replies skip reasoning and surface errors reported inside a 200', async (t) => {
  /** @type {object[]} */
  const replies = [
    completion({ content: [{ type: 'thinking', text: '<svg>draft</svg>' }, { type: 'text', text: '<svg>final</svg>' }] }),
    completion({ content: '<think>maybe <svg>draft</svg></think>\n<svg>final</svg>' }),
    completion({ content: 'the template opened the thought <svg>draft</svg></think><svg>final</svg>' }),
    { error: { message: 'upstream overloaded', code: 502 } },
    { choices: [{ finish_reason: 'error', error: { message: 'provider died' }, message: { content: '<svg' } }] },
  ];
  const server = await chatServer((_, __, res) => json(res, 200, replies.shift()));
  t.after(server.close);
  const [model] = createModels({ MODELS: 'local/m', LOCAL_BASE_URL: server.url });
  assert.equal((await model.complete(REQUEST)).text, '<svg>final</svg>', 'only text parts count');
  assert.equal((await model.complete(REQUEST)).text.trim(), '<svg>final</svg>', 'inline <think> blocks are dropped');
  assert.equal((await model.complete(REQUEST)).text, '<svg>final</svg>', 'so is reasoning whose <think> the chat template sent');
  for (const message of ['upstream overloaded', 'provider died']) {
    await assert.rejects(model.complete(REQUEST), (err) => err instanceof ModelError && err.kind === 'failed' && err.message.includes(message));
  }
});

test('Chat Completions errors are classified', async (t) => {
  const server = await chatServer((_, body, res) => (body.model === 'html' ? res.end('<html>oops</html>') : json(res, Number(body.model), { error: { message: 'nope' } })));
  t.after(server.close);
  for (const [status, kind] of [['429', 'busy'], ['401', 'auth'], ['403', 'auth'], ['500', 'failed'], ['404', 'failed'], ['html', 'failed']]) {
    const [model] = createModels({ MODELS: `local/${status}`, LOCAL_BASE_URL: server.url });
    await assert.rejects(model.complete(REQUEST), (err) => {
      assert.ok(err instanceof ModelError);
      assert.equal(err.kind, kind, status);
      if (status !== 'html') assert.match(err.message, new RegExp(`^${status} .*nope`), 'the log shows the status and provider message');
      return true;
    });
  }
});

test('Chat Completions connection failures are classified as failed', async () => {
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', () => resolve(null)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (closed.address());
  await new Promise((resolve) => closed.close(resolve));
  const [model] = createModels({ MODELS: 'local/m', LOCAL_BASE_URL: `http://127.0.0.1:${port}/v1` });
  await assert.rejects(model.complete(REQUEST), (err) => {
    assert.ok(err instanceof ModelError);
    assert.equal(err.kind, 'failed');
    assert.ok(err.cause instanceof TypeError);
    assert.match(err.message, /ECONNREFUSED/, 'the log shows why');
    return true;
  });
});

test('Chat Completions calls rethrow the original error when the caller aborts', async (t) => {
  const server = await chatServer(() => {}); // never answers
  t.after(server.close);
  const [model] = createModels({ MODELS: 'local/m', LOCAL_BASE_URL: server.url });
  const controller = new AbortController();
  const reason = new Error('client went away');
  const pending = model.complete({ ...REQUEST, signal: controller.signal });
  while (!server.requests.length) await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort(reason);
  await assert.rejects(pending, (err) => err === reason);
});
