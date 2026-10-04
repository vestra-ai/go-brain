/**
 * ONE ERROR AUTHORITY — cross-arm conformance.
 *
 * For each dialect spec, every kind the spec can produce is reached by at least one
 * SDK-FAITHFUL error object (the real SDK class wherever one exists; for Gemini —
 * which has no SDK — the transport's own throw shape), and the status-less
 * in-stream shape of an overload / rate limit classifies to a kind the engine's
 * retry belt treats as transient. This is the same precedent the severed-rail
 * conformance set: ask the property of EVERY arm, so a fix can never again land in
 * one classifier and miss the default one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  APIError as AnthropicAPIError,
  APIUserAbortError as AnthropicAbort,
  APIConnectionError as AnthropicConn,
} from '@anthropic-ai/sdk';
import {
  APIError as OpenAIAPIError,
  APIUserAbortError as OpenAIAbort,
  APIConnectionError as OpenAIConn,
} from 'openai';
import {
  classifyProviderError,
  STREAM_SEVERED_SUBTYPE,
  type ProviderErrorSpec,
} from '../../engine/error-authority.js';
import {
  ANTHROPIC_ERROR_SPEC,
  classifyAnthropicError,
} from '../../engine/native-termination.js';
import {
  OPENAI_ERROR_SPEC,
  classifyOpenAIResponsesError,
} from '../openai-responses-termination.js';
import { GEMINI_ERROR_SPEC, GeminiTransport } from '../gemini-transport.js';
import { ChatCompletionsTransport } from '../chat-completions-transport.js';
import { GEMINI_SEVERED_STREAM_MESSAGE } from '../../engine/severed-recognizer.js';
import { RETRYABLE_KINDS } from '../../engine/round-engine.js';
import type { TurnOutcome } from '../../contract/turn-outcome.js';

const FLAG = 'NATIVE_STREAM_SEVERED_RETRY';
afterEach(() => {
  delete process.env[FLAG];
});

const envelope = (type: string, message = type) => ({ type: 'error', error: { type, message } });

/** Byte-for-byte what @anthropic-ai/sdk core/streaming.js throws for an SSE `event: error` frame. */
const anthropicInStream = (type: string, message = type) =>
  new AnthropicAPIError(undefined, envelope(type, message), undefined, new Headers(), type as never);

/** The exact shape transports/gemini-transport.ts throws for a non-2xx REST reply. */
const geminiHttp = (status: number, canonical: string, message: string) =>
  Object.assign(new Error('Gemini ' + status + ': {"error":{"code":' + status + ',"message":"' + message + '","status":"' + canonical + '"}}'), {
    status,
    code: canonical,
    headers: new Headers(),
  });

interface Fixture {
  label: string;
  err: unknown;
  kind: TurnOutcome['kind'];
  /** Set to run the case with the severed-retry flag ON. */
  flag?: true;
}

const ANTHROPIC_FIXTURES: Fixture[] = [
  { label: 'APIUserAbortError', err: new AnthropicAbort(), kind: 'user_aborted' },
  { label: 'HTTP 429 rate_limit_error', err: new AnthropicAPIError(429, envelope('rate_limit_error'), undefined, new Headers(), 'rate_limit_error' as never), kind: 'rate_limited' },
  { label: 'in-stream rate_limit_error frame', err: anthropicInStream('rate_limit_error'), kind: 'rate_limited' },
  { label: 'HTTP 401 authentication_error', err: new AnthropicAPIError(401, envelope('authentication_error'), undefined, new Headers(), 'authentication_error' as never), kind: 'auth_error' },
  { label: 'HTTP 403 permission_error', err: new AnthropicAPIError(403, envelope('permission_error'), undefined, new Headers(), 'permission_error' as never), kind: 'auth_error' },
  { label: 'in-stream billing_error frame', err: anthropicInStream('billing_error'), kind: 'billing_error' },
  { label: '400 credit-balance wording (the real-wire 400 invalid_request_error)', err: new AnthropicAPIError(400, envelope('invalid_request_error', 'Your credit balance is too low to access the Anthropic API'), undefined, new Headers(), 'invalid_request_error' as never), kind: 'billing_error' },
  { label: 'HTTP 413 request_too_large', err: new AnthropicAPIError(413, envelope('request_too_large', 'Request body is too large'), undefined, new Headers(), 'request_too_large' as never), kind: 'context_exceeded' },
  { label: 'in-stream request_too_large frame', err: anthropicInStream('request_too_large'), kind: 'context_exceeded' },
  { label: '400 context wording', err: new AnthropicAPIError(400, envelope('invalid_request_error', 'prompt is too long: context window exceeded'), undefined, new Headers(), 'invalid_request_error' as never), kind: 'context_exceeded' },
  { label: '400 too-many-images wording', err: new AnthropicAPIError(400, envelope('invalid_request_error', 'A maximum of 100 images is allowed per request, but 142 were provided'), undefined, new Headers(), 'invalid_request_error' as never), kind: 'context_exceeded' },
  { label: '400 thinking-replay wording (the 09-16 wedge — SDK-faithful shape)', err: new AnthropicAPIError(400, envelope('invalid_request_error', 'messages.19.content.1: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.'), undefined, new Headers(), 'invalid_request_error' as never), kind: 'request_invalid' },
  { label: '400 image-rejection wording', err: new AnthropicAPIError(400, envelope('invalid_request_error', 'Could not process image attachment'), undefined, new Headers(), 'invalid_request_error' as never), kind: 'image_error' },
  { label: 'HTTP 529 overloaded_error', err: new AnthropicAPIError(529, envelope('overloaded_error', 'Overloaded'), undefined, new Headers(), 'overloaded_error' as never), kind: 'model_unavailable' },
  { label: 'in-stream overloaded_error frame', err: anthropicInStream('overloaded_error', 'Overloaded'), kind: 'model_unavailable' },
  { label: 'HTTP 404 not_found_error', err: new AnthropicAPIError(404, envelope('not_found_error'), undefined, new Headers(), 'not_found_error' as never), kind: 'model_unavailable' },
  { label: 'SDK connection wrapper (flag ON → severed)', err: new AnthropicConn({ cause: new Error('socket hang up') }), kind: 'network_error', flag: true },
  { label: 'undici terminated (wording net, flag OFF)', err: new Error('terminated'), kind: 'network_error' },
  { label: 'unknown in-stream type', err: anthropicInStream('invalid_request_error', 'bad field'), kind: 'model_error' },
];

const OPENAI_FIXTURES: Fixture[] = [
  { label: 'APIUserAbortError', err: new OpenAIAbort(), kind: 'user_aborted' },
  { label: 'HTTP 429 (generate → RateLimitError)', err: OpenAIAPIError.generate(429, { error: { message: 'Rate limit reached' } }, undefined, new Headers()), kind: 'rate_limited' },
  { label: 'status-less code rate_limit_exceeded (SSE re-throw)', err: new OpenAIAPIError(undefined, { code: 'rate_limit_exceeded', message: 'Rate limit reached' }, undefined, undefined), kind: 'rate_limited' },
  { label: 'status-less code insufficient_quota (verified live shape)', err: new OpenAIAPIError(undefined, { code: 'insufficient_quota', message: 'You exceeded your current quota' }, undefined, undefined), kind: 'billing_error' },
  { label: 'HTTP 401 (generate → AuthenticationError)', err: OpenAIAPIError.generate(401, { error: { message: 'Incorrect API key provided' } }, undefined, new Headers()), kind: 'auth_error' },
  { label: 'HTTP 402', err: OpenAIAPIError.generate(402, { error: { message: 'Payment required' } }, undefined, new Headers()), kind: 'billing_error' },
  { label: 'HTTP 413', err: OpenAIAPIError.generate(413, { error: { message: 'Request body is too large' } }, undefined, new Headers()), kind: 'context_exceeded' },
  { label: 'code context_length_exceeded, status-less', err: new OpenAIAPIError(undefined, { code: 'context_length_exceeded', message: "This model's maximum context length is 272000 tokens" }, undefined, undefined), kind: 'context_exceeded' },
  { label: 'code invalid_image_url (the image-code family)', err: new OpenAIAPIError(undefined, { code: 'invalid_image_url', message: 'Error while downloading the image from the URL' }, undefined, undefined), kind: 'image_error' },
  { label: '400 image wording', err: OpenAIAPIError.generate(400, { error: { message: 'You uploaded an unsupported image type' } }, undefined, new Headers()), kind: 'image_error' },
  { label: 'code server_error, status-less (the 08-19 triage shape)', err: Object.assign(new Error('The server had an error while processing your request'), { code: 'server_error' }), kind: 'model_unavailable' },
  { label: 'HTTP 503', err: OpenAIAPIError.generate(503, { error: { message: 'Service unavailable' } }, undefined, new Headers()), kind: 'model_unavailable' },
  { label: 'HTTP 404 model-not-found', err: OpenAIAPIError.generate(404, { error: { message: 'The model does not exist' } }, undefined, new Headers()), kind: 'model_unavailable' },
  { label: 'SDK connection wrapper (flag ON → severed)', err: new OpenAIConn({ cause: new Error('socket hang up') }), kind: 'network_error', flag: true },
  { label: 'undici terminated (wording net)', err: new Error('terminated'), kind: 'network_error' },
  { label: 'schema 400 (terminal refinement keeps model_error)', err: OpenAIAPIError.generate(400, { error: { message: "Invalid schema for response_format 'x': 'required' must be supplied" } }, undefined, new Headers()), kind: 'model_error' },
  { label: 'plain failure', err: new Error('the model produced an unparseable response'), kind: 'model_error' },
];

const GEMINI_FIXTURES: Fixture[] = [
  { label: 'platform AbortError (fetch abort; no SDK wrapper exists)', err: new DOMException('The operation was aborted.', 'AbortError'), kind: 'user_aborted' },
  { label: '429 RESOURCE_EXHAUSTED', err: geminiHttp(429, 'RESOURCE_EXHAUSTED', 'Resource has been exhausted'), kind: 'rate_limited' },
  { label: '402 RESOURCE_EXHAUSTED (the empty prepaid balance, staging 2026-10-01): the 402 wins', err: geminiHttp(402, 'RESOURCE_EXHAUSTED', 'Your prepayment credits are depleted'), kind: 'billing_error' },
  { label: '401 UNAUTHENTICATED', err: geminiHttp(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials'), kind: 'auth_error' },
  { label: '403 PERMISSION_DENIED', err: geminiHttp(403, 'PERMISSION_DENIED', 'The caller does not have permission'), kind: 'auth_error' },
  { label: '400 FAILED_PRECONDITION (free tier not available — enable billing)', err: geminiHttp(400, 'FAILED_PRECONDITION', 'Gemini API free tier is not available in your country. Please enable billing'), kind: 'billing_error' },
  { label: '400 INVALID_ARGUMENT with token-count wording', err: geminiHttp(400, 'INVALID_ARGUMENT', 'The input token count exceeds the maximum number of tokens allowed'), kind: 'context_exceeded' },
  { label: '400 INVALID_ARGUMENT with image wording', err: geminiHttp(400, 'INVALID_ARGUMENT', 'Unable to process input image'), kind: 'image_error' },
  { label: '400 INVALID_ARGUMENT plain validation', err: geminiHttp(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument'), kind: 'model_error' },
  { label: '404 NOT_FOUND', err: geminiHttp(404, 'NOT_FOUND', 'Requested entity was not found'), kind: 'model_unavailable' },
  { label: '500 INTERNAL', err: geminiHttp(500, 'INTERNAL', 'An internal error has occurred'), kind: 'model_unavailable' },
  { label: '503 UNAVAILABLE', err: geminiHttp(503, 'UNAVAILABLE', 'The model is overloaded'), kind: 'model_unavailable' },
  { label: '504 DEADLINE_EXCEEDED', err: geminiHttp(504, 'DEADLINE_EXCEEDED', 'The service was unable to finish within the deadline'), kind: 'model_unavailable' },
  { label: 'premature-end sentinel (flag ON → severed)', err: new Error(GEMINI_SEVERED_STREAM_MESSAGE), kind: 'network_error', flag: true },
  { label: 'fetch failed (undici connection failure)', err: new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') }), kind: 'network_error' },
  { label: 'non-JSON error body (proxy HTML) falls to the ladder', err: Object.assign(new Error('Gemini 500: <html>bad gateway</html>'), { status: 500, headers: new Headers() }), kind: 'model_unavailable' },
  { label: 'plain failure', err: new Error('unexpected wire shape'), kind: 'model_error' },
];

/** Every kind a spec's tables/rules can produce, plus the shared-policy floor. */
function reachableKinds(spec: ProviderErrorSpec): Set<string> {
  const kinds = new Set<string>([
    'user_aborted', 'rate_limited', 'auth_error', 'billing_error', 'context_exceeded',
    'model_unavailable', 'network_error', 'model_error',
  ]);
  for (const rule of Object.values(spec.codes)) kinds.add(rule.kind);
  for (const rule of spec.codeFamilies ?? []) kinds.add(rule.kind);
  for (const rule of spec.messageRules) kinds.add(rule.kind);
  for (const rule of spec.terminalRules ?? []) kinds.add(rule.kind);
  return kinds;
}

const ARMS: Array<[string, ProviderErrorSpec, Fixture[], (err: unknown) => TurnOutcome]> = [
  ['anthropic', ANTHROPIC_ERROR_SPEC, ANTHROPIC_FIXTURES, (err) => classifyAnthropicError(err)],
  ['openai', OPENAI_ERROR_SPEC, OPENAI_FIXTURES, (err) => classifyOpenAIResponsesError(err)],
  ['gemini', GEMINI_ERROR_SPEC, GEMINI_FIXTURES, (err) => GeminiTransport.prototype.classifyError.call({}, err)],
];

describe.each(ARMS)('%s — every reachable kind, from SDK-faithful shapes', (_name, spec, fixtures, wrapper) => {
  it.each(fixtures.map((f) => [f.label, f] as const))('%s', (_label, f) => {
    if (f.flag) process.env[FLAG] = 'true';
    expect(classifyProviderError(f.err, spec).kind).toBe(f.kind);
    // The arm's PUBLIC classifier is a wrapper over the same spec — never a fork.
    expect(wrapper(f.err).kind).toBe(f.kind);
  });

  it('the fixture table covers every kind this spec can produce', () => {
    const covered = new Set(fixtures.map((f) => f.kind));
    for (const kind of reachableKinds(spec)) expect(covered, kind).toContain(kind);
  });

  it('the status-less overload and rate-limit shapes classify RETRYABLE (the belt arms)', () => {
    const statusless: Record<string, [unknown, unknown]> = {
      anthropic: [anthropicInStream('overloaded_error', 'Overloaded'), anthropicInStream('rate_limit_error')],
      openai: [
        Object.assign(new Error('Our servers are currently overloaded'), { code: 'server_error' }),
        new OpenAIAPIError(undefined, { code: 'rate_limit_exceeded', message: 'Rate limit reached' }, undefined, undefined),
      ],
      // No in-stream error frames exist on the hand-rolled Gemini lane today (a dead
      // stream ends at the severed sentinel instead) — these are the transport's
      // throw shape MINUS the status, so a future in-stream lift lands on the same
      // rows without touching the rail.
      gemini: [
        Object.assign(new Error('The model is overloaded'), { code: 'UNAVAILABLE' }),
        Object.assign(new Error('Resource has been exhausted'), { code: 'RESOURCE_EXHAUSTED' }),
      ],
    };
    for (const shape of statusless[_name]) {
      const out = classifyProviderError(shape, spec);
      expect(RETRYABLE_KINDS.has(out.kind), _name + ' ' + out.kind).toBe(true);
    }
  });
});

describe('the chat-completions lane rides the OpenAI spec (Fireworks / xAI wire shapes)', () => {
  const classify = (err: unknown): TurnOutcome => ChatCompletionsTransport.prototype.classifyError.call({}, err);

  it('a Fireworks-SHAPED 429 body (no code field) classifies rate_limited via the status ladder', () => {
    // Shape-plausible, not live-verified (the brief notes Fireworks bodies are unverified):
    // OpenAI-compatible envelope, no `code`, the 429 carries the meaning.
    const err = OpenAIAPIError.generate(
      429,
      { error: { object: 'error', type: 'invalid_request_error', message: 'You have exceeded your requests per minute rate limit' } },
      undefined,
      new Headers({ 'retry-after': '7' }),
    );
    expect(classify(err).kind).toBe('rate_limited');
  });

  it('an xAI-SHAPED 401 (error is a bare STRING, code is prose) classifies auth_error and crashes nothing', () => {
    // xAI's body is not OpenAI-shaped: {"code":"<prose>","error":"Incorrect API key provided: xai-…"}.
    // The SDK stores the string in .error, .code stays prose — the exact-row table must
    // not match prose, and the 401 ladder must win.
    const err = OpenAIAPIError.generate(
      401,
      { code: 'Client specified an invalid argument', error: 'Incorrect API key provided: xai-abc123. You can obtain an API key from https://console.x.ai.' },
      undefined,
      new Headers(),
    );
    const out = classify(err);
    expect(out.kind).toBe('auth_error');
    expect(out.raw.api_error_status).toBe(401);
  });
});

describe('severed classification stays the flag-gated single branch on every arm', () => {
  it.each(ARMS.map(([name, spec]) => [name, spec] as const))('%s: sentinel severs ON, stays terminal OFF', (_name, spec) => {
    process.env[FLAG] = 'true';
    const on = classifyProviderError(new Error(GEMINI_SEVERED_STREAM_MESSAGE), spec);
    expect(on.kind).toBe('network_error');
    expect(on.raw.subtype).toBe(STREAM_SEVERED_SUBTYPE);
    delete process.env[FLAG];
    const off = classifyProviderError(new Error(GEMINI_SEVERED_STREAM_MESSAGE), spec);
    expect(off.kind).toBe('model_error');
  });
});

/**
 * Task 4b's fault, as a unit fixture: the in-stream `overloaded_error` frame that
 * arrives AFTER partial content. The replay rail (#2756) cannot place a fault
 * mid-round yet — its README lists "a fault that arrives after partial content"
 * under "not replayable yet" — so the harness-level proof lives in
 * native-harness.severed-stream.test.ts over this exact frame, and this constant is
 * the error the future `__fixtures__/replay/03-multi-round-with-error-frame.jsonl`
 * after-partial variant (harvest.mjs inject --after-text, once the rail grows the
 * directive) will throw at that point.
 */
export const AFTER_PARTIAL_OVERLOAD_FRAME = (): InstanceType<typeof AnthropicAPIError> => anthropicInStream('overloaded_error', 'Overloaded');

describe('the after-partial overload frame (Task 4b fixture)', () => {
  it('classifies to a RETRYABLE kind on the Anthropic arm — what the widened belt gate keys on', () => {
    const out = classifyAnthropicError(AFTER_PARTIAL_OVERLOAD_FRAME());
    expect(out.kind).toBe('model_unavailable');
    expect(RETRYABLE_KINDS.has(out.kind)).toBe(true);
  });
});
