// @ts-check
import Anthropic from '@anthropic-ai/sdk';

/** @typedef {{ system: string, text: string, image?: string, signal?: AbortSignal }} ModelRequest `image` is a data URL. */
/** @typedef {{ text: string, refused: boolean, model: string, usage: unknown }} ModelReply */
/** @typedef {{ id: string, complete: (request: ModelRequest) => Promise<ModelReply> }} Model */

// Only these SDK models accept effort and server-side fallbacks; any other model answers 400.
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

/** A failed model call. `kind` tells the caller what to say: 'busy' (rate limited), 'auth' (bad or missing credentials) or 'failed'. */
export class ModelError extends Error {
  /** @param {'busy' | 'auth' | 'failed'} kind @param {string} message @param {ErrorOptions} [options] */
  constructor(kind, message, options) {
    super(message, options);
    this.name = 'ModelError';
    this.kind = kind;
  }
}

/** Messages along the cause chain, so logs show e.g. "fetch failed: connect ECONNREFUSED 127.0.0.1:11434". */
function reason(/** @type {unknown} */ err) {
  const parts = [];
  for (let e = err; e instanceof Error && parts.length < 5; e = e.cause) parts.push(e.message);
  return parts.join(': ') || String(err);
}

/** Wrap a provider error as a ModelError, except after the caller aborted: then the original passes through untouched. */
function wrap(/** @type {unknown} */ err, /** @type {AbortSignal | undefined} */ signal, /** @type {ModelError['kind']} */ kind = 'failed') {
  return signal?.aborted || err instanceof ModelError ? err : new ModelError(kind, reason(err), { cause: err });
}

/**
 * Build one model per `provider/model` entry of the comma-separated `env.MODELS`; none when it is unset, which turns
 * prompt generation off. The provider is the text before the first slash, so model ids may contain slashes. The
 * `anthropic` provider uses its SDK; every other provider is called through its Chat Completions endpoint at
 * `<PROVIDER>_BASE_URL` with the optional `<PROVIDER>_API_KEY`.
 * @param {Record<string, string | undefined>} env
 * @param {{ anthropic?: Pick<Anthropic, 'beta'> }} [options] `anthropic` replaces the SDK client, for tests.
 * @returns {Model[]}
 */
export function createModels(env, { anthropic } = {}) {
  const ids = (env.MODELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return ids.map((id) => {
    const slash = id.indexOf('/');
    const provider = id.slice(0, slash), model = id.slice(slash + 1);
    if (slash < 1 || !model) throw new Error(`MODELS entry "${id}" must look like provider/model.`);
    if (provider === 'anthropic') return { id, complete: anthropicModel((anthropic ??= new Anthropic()), model) };
    const name = provider.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const baseURL = env[`${name}_BASE_URL`]?.replace(/\/$/, '');
    if (!baseURL) throw new Error(`Model "${id}" needs ${name}_BASE_URL, the provider's Chat Completions API URL (ending before /chat/completions).`);
    return { id, complete: chatModel(baseURL, env[`${name}_API_KEY`], model) };
  });
}

/** @returns {Model['complete']} */
function anthropicModel(/** @type {Pick<Anthropic, 'beta'>} */ client, /** @type {string} */ model) {
  const extra = FALLBACK_MODELS.has(model) ? { output_config: { effort: /** @type {const} */ ('medium') }, betas: ['server-side-fallback-2026-07-01'], fallbacks: /** @type {const} */ ('default') } : {};
  return async ({ system, text, image, signal }) => {
    /** @type {Anthropic.Beta.BetaContentBlockParam[]} */
    const content = [{ type: 'text', text }];
    if (image) {
      const [, mediaType, data] = /^data:([^;]+);base64,(.*)$/s.exec(image) ?? [];
      content.unshift({ type: 'image', source: { type: 'base64', media_type: /** @type {Anthropic.Beta.BetaBase64ImageSource['media_type']} */ (mediaType), data } });
    }
    try {
      const message = await client.beta.messages.stream({ model, max_tokens: 16000, ...extra, system, messages: [{ role: 'user', content }] }, { signal }).finalMessage();
      return { text: message.content.map((b) => (b.type === 'text' ? b.text : '')).join(''), refused: message.stop_reason === 'refusal', model: message.model, usage: message.usage };
    } catch (err) {
      const kind = err instanceof Anthropic.RateLimitError ? 'busy'
        : err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError
          || /Could not resolve authentication method/.test(reason(err)) ? 'auth' : 'failed'; // the SDK's error for a missing key
      throw wrap(err, signal, kind);
    }
  };
}

/** @returns {Model['complete']} */
function chatModel(/** @type {string} */ baseURL, /** @type {string | undefined} */ apiKey, /** @type {string} */ model) {
  return async ({ system, text, image, signal }) => {
    try {
      // No max_tokens: providers disagree on its name and limits, and their defaults fit an SVG.
      const res = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey && { authorization: `Bearer ${apiKey}` }) },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: image ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: image } }] : text }] }),
        signal,
      });
      const body = await res.text();
      if (!res.ok) {
        const kind = res.status === 429 ? 'busy' : res.status === 401 || res.status === 403 ? 'auth' : 'failed';
        throw new ModelError(kind, `${res.status} ${body.slice(0, 500)}`);
      }
      const data = JSON.parse(body);
      const choice = data?.choices?.[0], content = choice?.message?.content, failure = data?.error ?? choice?.error;
      if (failure) throw new ModelError('failed', `${res.status} ${JSON.stringify(failure).slice(0, 500)}`); // some gateways report failures inside a 200
      const answer = typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => (part?.type === 'text' ? part.text : '')).join('') : '';
      const thought = answer.lastIndexOf('</think>'); // some models reason inline first; the opening tag may be in the template
      return {
        text: thought < 0 ? answer : answer.slice(thought + 8),
        refused: Boolean(choice?.message?.refusal) || choice?.finish_reason === 'content_filter',
        model: data?.model ?? model,
        usage: data?.usage,
      };
    } catch (err) {
      throw wrap(err, signal);
    }
  };
}
