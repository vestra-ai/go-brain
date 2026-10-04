/**
 * RETRY_BY_CAUSE_V1 (harness-to-nine L3): the model-call retry boundary sorts each failure
 * by cause. A usage limit is never retried; a rate limit waits the provider's hint, else a
 * full-jitter exponential backoff from 500 ms; an overload keeps today's bounded schedule and
 * then the configured fallback model; a dropped connection re-asks on a fresh connection.
 *
 * The per-provider facts are the recorded error bodies below, driven through each lane's
 * REAL classifier (the ProviderErrorSpec rows are the provider tables; the cause is read off
 * what they classify). The loop is the real startStreamWithRetry; setTimeout is recorded
 * rather than slept through, so every schedule is asserted as the code asked for it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APIError as AnthropicAPIError } from '@anthropic-ai/sdk';
import { APIError as OpenAIAPIError } from 'openai';
import { startStreamWithRetry, retryWaitLine, type RetryWait } from '../round-engine.js';
import { retryCause, causeWaitMs, RATE_LIMIT_MAX_ATTEMPTS, type RetryCause } from '../error-authority.js';
import { classifyAnthropicError } from '../native-termination.js';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport } from '../transport.js';
import { classifyOpenAIResponsesError } from '../../transports/openai-responses-termination.js';
import { ChatCompletionsTransport } from '../../transports/chat-completions-transport.js';
import { GeminiTransport } from '../../transports/gemini-transport.js';
import { GeminiInteractionsTransport } from '../../transports/gemini-interactions-transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { TurnOutcome } from '../../contract/turn-outcome.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { NativeConfig } from '../native-config.js';
import type { ToolHost } from '../../ports/tool-host-port.js';
import type { RawToolOptions, OnAuthHalt } from '../../tools/tool-types.js';
import type { NormalizedUsage, ProviderHistory, ProviderStream, StreamEvent, Transport } from '../transport.js';

const FLAG = 'RETRY_BY_CAUSE_V1';
afterEach(() => {
  delete process.env[FLAG];
  vi.restoreAllMocks();
});

// ── recorded error bodies, built the way each lane's SDK or transport throws them ──

const anthropicErr = (status: number, type: string, message: string, headers: Record<string, string> = {}) =>
  new AnthropicAPIError(status, { type: 'error', error: { type, message } }, undefined, new Headers(headers), type as never);
const anthropic429 = (retryAfter?: string) =>
  anthropicErr(429, 'rate_limit_error', 'This request would exceed the rate limit for your organization of 400,000 input tokens per minute.', retryAfter ? { 'retry-after': retryAfter } : {});
const anthropic529 = () => anthropicErr(529, 'overloaded_error', 'Overloaded');

const openaiErr = (status: number, error: Record<string, unknown>, headers: Record<string, string> = {}) =>
  OpenAIAPIError.generate(status, { error }, undefined, new Headers(headers));
const openaiQuota = () =>
  openaiErr(429, { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', param: null, code: 'insufficient_quota' });
const openaiRateLimit = (headers: Record<string, string> = {}) =>
  openaiErr(429, { message: 'Rate limit reached for gpt-5.6 on tokens per min (TPM): Limit 30000, Used 29800, Requested 1200.', type: 'tokens', param: null, code: 'rate_limit_exceeded' }, headers);
/** Fireworks rides the OpenAI envelope with no `code` (shape-plausible; see the conformance suite). */
const fireworks429 = (retryAfter?: string) =>
  openaiErr(429, { object: 'error', type: 'invalid_request_error', message: 'You have exceeded your requests per minute rate limit' }, retryAfter ? { 'retry-after': retryAfter } : {});

/** Google's documented RESOURCE_EXHAUSTED details: a QuotaFailure naming the quota, and RetryInfo. */
const googleDetails = (quotaId: string, retryDelay: string) => [
  { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_requests', quotaId }] },
  { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay },
];
const googleBody = (quotaId: string, retryDelay: string) =>
  JSON.stringify({
    error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details.', status: 'RESOURCE_EXHAUSTED', details: googleDetails(quotaId, retryDelay) },
  });
/** What gemini-transport.ts throws on a non-2xx reply: status, headers, the lifted code and details. */
const geminiErr = (quotaId: string, retryDelay: string) =>
  Object.assign(new Error(`Gemini 429: ${googleBody(quotaId, retryDelay)}`), {
    status: 429, headers: new Headers(), code: 'RESOURCE_EXHAUSTED', details: googleDetails(quotaId, retryDelay),
  });
const geminiPerMinute = () => geminiErr('GenerateRequestsPerMinutePerProjectPerModel', '12s');
const geminiPerDay = () => geminiErr('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '33s');
const geminiUnavailable = () =>
  Object.assign(new Error('Gemini 503: {"error":{"code":503,"message":"The model is overloaded.","status":"UNAVAILABLE"}}'), { status: 503, headers: new Headers(), code: 'UNAVAILABLE' });

type Classify = (err: unknown) => TurnOutcome;
const anthropic: Classify = (e) => classifyAnthropicError(e);
const openai: Classify = (e) => classifyOpenAIResponsesError(e);
const fireworks: Classify = (e) => ChatCompletionsTransport.prototype.classifyError.call({}, e);
const gemini: Classify = (e) => GeminiTransport.prototype.classifyError.call({}, e);
const geminiInteractions: Classify = (e) => GeminiInteractionsTransport.prototype.classifyError.call({}, e);

describe('retry cause: one row per provider fact, from recorded error bodies', () => {
  const rows: Array<[string, Classify, () => unknown, RetryCause | undefined]> = [
    ['Anthropic 429 rate_limit_error', anthropic, () => anthropic429('12'), 'rate_limit'],
    ['Anthropic 529 overloaded_error', anthropic, anthropic529, 'overload'],
    ['Anthropic 400 credit balance', anthropic, () => anthropicErr(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'), 'usage_limit'],
    ['OpenAI 429 insufficient_quota', openai, openaiQuota, 'usage_limit'],
    ['OpenAI 429 billing_hard_limit_reached', openai, () => openaiErr(429, { message: 'Billing hard limit has been reached', type: 'invalid_request_error', param: null, code: 'billing_hard_limit_reached' }), 'usage_limit'],
    ['OpenAI 429 rate_limit_exceeded', openai, () => openaiRateLimit(), 'rate_limit'],
    ['OpenAI 503', openai, () => openaiErr(503, { message: 'Service unavailable' }), 'overload'],
    ['Fireworks 429 (no code)', fireworks, () => fireworks429('7'), 'rate_limit'],
    ['Gemini RESOURCE_EXHAUSTED per minute', gemini, geminiPerMinute, 'rate_limit'],
    ['Gemini RESOURCE_EXHAUSTED per day', gemini, geminiPerDay, 'usage_limit'],
    ['Gemini Interactions RESOURCE_EXHAUSTED per day', geminiInteractions, () => geminiErr('GenerateRequestsPerDayPerProjectPerModel', '40s'), 'usage_limit'],
    ['a per-day quota named only in the message (no details) stays a rate limit', gemini, () => Object.assign(new Error(`Gemini 429: ${googleBody('GenerateRequestsPerDayPerProjectPerModel', '1s')}`), { status: 429, code: 'RESOURCE_EXHAUSTED' }), 'rate_limit'],
    ['Gemini 503 UNAVAILABLE', gemini, geminiUnavailable, 'overload'],
    ['undici terminated (any lane)', anthropic, () => new Error('terminated'), 'dropped_connection'],
    ['fetch failed (Gemini lane)', gemini, () => new TypeError('fetch failed', { cause: new Error('connect ECONNRESET') }), 'dropped_connection'],
    ['Anthropic 401 is no retry cause', anthropic, () => anthropicErr(401, 'authentication_error', 'invalid x-api-key'), undefined],
  ];
  it.each(rows)('%s', (_label, classify, make, cause) => {
    const err = make();
    expect(retryCause(classify(err), err)).toBe(cause);
  });
});

describe('both Gemini lanes lift the details off the RAW body onto the thrown error', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  const thrownBy = async (t: Transport, body: string): Promise<unknown> => {
    vi.stubEnv('GEMINI_API_KEY', 'k');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 429 })));
    try {
      for await (const _ev of t.readStream(t.callModel({ model: 'm', maxTokens: 10, system: 's', tools: [], history: t.emptyHistory() }))) {
        // drain
      }
    } catch (err) {
      return err;
    }
    throw new Error('expected the call to throw');
  };

  it('generateContent: the JSON body', async () => {
    const t = new GeminiTransport();
    const err = await thrownBy(t, googleBody('GenerateRequestsPerDayPerProjectPerModel', '33s'));
    expect(retryCause(t.classifyError(err), err)).toBe('usage_limit');
  });

  it('Interactions: an SSE-framed body with two events (the message is flattened; the details are not)', async () => {
    const t = new GeminiInteractionsTransport();
    const first = '{"error":{"code":429,"message":"first","status":"RESOURCE_EXHAUSTED"}}';
    const body = `event: error\ndata: ${first}\n\nevent: error\ndata: ${googleBody('GenerateRequestsPerDayPerProjectPerModel', '40s')}\n\n`;
    const err = await thrownBy(t, body);
    expect(retryCause(t.classifyError(err), err)).toBe('usage_limit');
  });
});

describe('causeWaitMs: what each cause waits', () => {
  it('rate limit: the hint is capped at 30 s; a zero hint falls to the jitter', () => {
    expect(causeWaitMs('rate_limit', anthropic429('999'), undefined, 1, 750).waitMs).toBe(30_000);
    expect(causeWaitMs('rate_limit', anthropic429('0'), undefined, 1, 750, () => 0.5)).toEqual({ waitMs: 250, hinted: undefined });
  });

  it('rate limit without a hint: full jitter, exponential from 500 ms, capped at 30 s', () => {
    const top = () => 0.999_999;
    const ceilings = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => causeWaitMs('rate_limit', openaiRateLimit(), undefined, n, 750, top).waitMs);
    expect(ceilings).toEqual([499, 999, 1_999, 3_999, 7_999, 15_999, 29_999, 29_999]);
    expect(causeWaitMs('rate_limit', openaiRateLimit(), undefined, 3, 750, () => 0).waitMs).toBe(0);
  });

  it('dropped connection: the same jitter, never a hint', () => {
    expect(causeWaitMs('dropped_connection', new Error('terminated'), undefined, 2, 750, () => 0.5)).toEqual({ waitMs: 500, hinted: undefined });
  });

  it("overload: today's schedule, unchanged (linear, stretched by Retry-After)", () => {
    expect(causeWaitMs('overload', anthropic529(), undefined, 2, 750)).toEqual({ waitMs: 1_500, hinted: undefined });
  });
});

// ── the loop ──

/** A transport whose first `errs.length` calls throw, in order; every request is recorded. */
function scripted(errs: unknown[], classify: Classify) {
  const requests: Array<Record<string, unknown>> = [];
  const t = {
    api: 'scripted',
    provider: 'scripted',
    defaultModel: () => 'primary',
    emptyHistory: () => [] as unknown as ProviderHistory,
    callModel(req: Record<string, unknown>): ProviderStream {
      requests.push(req);
      if (requests.length <= errs.length) throw errs[requests.length - 1];
      return [{ kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }] as unknown as ProviderStream;
    },
    readStream: async function* (s: ProviderStream): AsyncIterable<StreamEvent> {
      for (const ev of s as unknown as StreamEvent[]) yield ev;
    },
    classifyError: classify,
  };
  return { transport: t as unknown as Transport, requests };
}

const params = { model: 'primary', maxTokens: 100, system: 'sys', tools: [] as never[], history: [] as unknown as ProviderHistory };

/** Record every backoff the loop ASKS for, and fire it at once. */
function recordBackoffs(): number[] {
  const delays: number[] = [];
  const real = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    return real(fn, 0);
  }) as typeof setTimeout);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return delays;
}

const settle = (p: Promise<unknown>) => p.then(() => 'resolved' as const, (e: unknown) => e);

describe('retry: usage limit is not retried', () => {
  it('Gemini per-day quota: one call, no fallback, the error goes to the terminal catch', async () => {
    process.env[FLAG] = 'true';
    const delays = recordBackoffs();
    const { transport, requests } = scripted([geminiPerDay()], gemini);
    const out = await settle(startStreamWithRetry(params, transport, { retry: { fallbackModel: 'fallback' } }));
    expect(out).toBeInstanceOf(Error);
    expect(requests.map((r) => r.model)).toEqual(['primary']);
    expect(delays).toEqual([]);
  });

  it('OpenAI 429 insufficient_quota: one call (and it never was retried; pinned both ways)', async () => {
    for (const on of [true, false]) {
      if (on) process.env[FLAG] = 'true';
      else delete process.env[FLAG];
      const { transport, requests } = scripted([openaiQuota()], openai);
      await settle(startStreamWithRetry(params, transport, {}));
      expect(requests).toHaveLength(1);
    }
  });
});

describe('retry: a rate limit waits the hint, else full jitter from 500 ms', () => {
  it('Anthropic 429 with Retry-After: 12 waits exactly 12 s', async () => {
    process.env[FLAG] = 'true';
    const delays = recordBackoffs();
    const { transport, requests } = scripted([anthropic429('12')], anthropic);
    await startStreamWithRetry(params, transport, {});
    expect(requests).toHaveLength(2);
    expect(delays).toEqual([12_000]);
  });

  it('Gemini per-minute quota waits its RetryInfo (12 s)', async () => {
    process.env[FLAG] = 'true';
    const delays = recordBackoffs();
    const { transport } = scripted([geminiPerMinute()], gemini);
    await startStreamWithRetry(params, transport, {});
    expect(delays).toEqual([12_000]);
  });

  it('Fireworks 429 with Retry-After: 7 waits 7 s', async () => {
    process.env[FLAG] = 'true';
    const delays = recordBackoffs();
    const { transport } = scripted([fireworks429('7')], fireworks);
    await startStreamWithRetry(params, transport, {});
    expect(delays).toEqual([7_000]);
  });

  it('OpenAI 429 with no hint: jittered, doubling from 500 ms', async () => {
    process.env[FLAG] = 'true';
    const delays = recordBackoffs();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { transport, requests } = scripted([openaiRateLimit(), openaiRateLimit(), openaiRateLimit()], openai);
    await startStreamWithRetry(params, transport, {});
    expect(requests).toHaveLength(4);
    expect(delays).toEqual([250, 500, 1_000]);
  });

  it(`gets ${RATE_LIMIT_MAX_ATTEMPTS} attempts and never moves to the fallback model`, async () => {
    process.env[FLAG] = 'true';
    recordBackoffs();
    const errs = Array.from({ length: 10 }, () => openaiRateLimit());
    const { transport, requests } = scripted(errs, openai);
    const out = await settle(startStreamWithRetry(params, transport, { retry: { fallbackModel: 'fallback' } }));
    expect(out).toBeInstanceOf(Error);
    expect(requests.map((r) => r.model)).toEqual(Array(RATE_LIMIT_MAX_ATTEMPTS).fill('primary'));
  });
});

describe('retry: an overload is retried on the bounded schedule, then the fallback model', () => {
  it('Anthropic 529 four times: 750, 1500, 2250, then one attempt on the fallback', async () => {
    process.env[FLAG] = 'true';
    const delays = recordBackoffs();
    const { transport, requests } = scripted([anthropic529(), anthropic529(), anthropic529(), anthropic529()], anthropic);
    const started = await startStreamWithRetry(params, transport, { retry: { fallbackModel: 'fallback' } });
    expect(started.model).toBe('fallback');
    expect(requests.map((r) => r.model)).toEqual(['primary', 'primary', 'primary', 'primary', 'fallback']);
    expect(delays).toEqual([750, 1_500, 2_250]);
  });
});

describe('retry: a dropped connection re-asks on a fresh connection', () => {
  it('jittered, bounded, and never blamed on the model (no fallback)', async () => {
    process.env[FLAG] = 'true';
    const delays = recordBackoffs();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const errs = Array.from({ length: 4 }, () => new Error('terminated'));
    const { transport, requests } = scripted(errs, anthropic);
    const out = await settle(startStreamWithRetry(params, transport, { retry: { fallbackModel: 'fallback' } }));
    expect(out).toBeInstanceOf(Error);
    expect(requests.map((r) => r.model)).toEqual(['primary', 'primary', 'primary', 'primary']);
    expect(delays).toEqual([250, 500, 1_000]);
  });
});

describe('retry off: schedule byte-identical', () => {
  it("today's four linear attempts (750, 1500, 2250), the same request each time, then the error", async () => {
    const delays = recordBackoffs();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const errs = Array.from({ length: 5 }, () => openaiRateLimit());
    const { transport, requests } = scripted(errs, openai);
    const out = await settle(startStreamWithRetry(params, transport, {}));
    expect(out).toBeInstanceOf(Error);
    expect(delays).toEqual([750, 1_500, 2_250]);
    expect(requests).toHaveLength(4);
    for (const r of requests) expect(r).toEqual({ ...params, model: 'primary' });
  });

  it("a daily quota is still retried four times and a rate limit still falls back, as today", async () => {
    recordBackoffs();
    const daily = scripted([geminiPerDay(), geminiPerDay(), geminiPerDay(), geminiPerDay(), geminiPerDay()], gemini);
    await settle(startStreamWithRetry(params, daily.transport, {}));
    expect(daily.requests).toHaveLength(4);
    const limited = scripted([openaiRateLimit(), openaiRateLimit(), openaiRateLimit(), openaiRateLimit()], openai);
    const started = await startStreamWithRetry(params, limited.transport, { retry: { fallbackModel: 'fallback' } });
    expect(started.model).toBe('fallback');
  });
});

// ── no silent waits: each retry wait is one live line ──

describe('retry: every wait is told live', () => {
  it('the hook hears each wait with its cause, the attempt about to run and the budget; off, never', async () => {
    recordBackoffs();
    for (const on of [true, false]) {
      if (on) process.env[FLAG] = 'true';
      else delete process.env[FLAG];
      const heard: RetryWait[] = [];
      const { transport } = scripted([anthropic529(), anthropic529()], anthropic);
      await startStreamWithRetry(params, transport, {}, { onRetryWait: (w) => heard.push(w) });
      expect(heard).toEqual(on ? [
        { cause: 'overload', waitMs: 750, attempt: 2, cap: 4 },
        { cause: 'overload', waitMs: 1_500, attempt: 3, cap: 4 },
      ] : []);
    }
  });

  it('the line reads plainly', () => {
    expect(retryWaitLine({ cause: 'rate_limit', waitMs: 12_000, attempt: 2, cap: 6 })).toBe('Model is busy; retrying in 12 s (attempt 2 of 6)');
    expect(retryWaitLine({ cause: 'dropped_connection', waitMs: 250, attempt: 2, cap: 4 })).toBe('Connection dropped; retrying now (attempt 2 of 4)');
  });

  class OverloadedTwice extends FakeTransport {
    attempts = 0;
    constructor() { super([]); }
    override callModel(): StreamEvent[] {
      this.attempts += 1;
      if (this.attempts <= 2) throw anthropic529();
      return [
        { kind: 'text', text: 'back' },
        { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
      ] as StreamEvent[];
    }
    override computeCostUsd(_u: NormalizedUsage): number { return 0; }
    override classifyError(err: unknown): TurnOutcome { return classifyAnthropicError(err); }
  }

  /** A whole turn through NativeHarness; only the two overload backoffs are fired at once. */
  async function thinkingLinesOfATurn(): Promise<string[]> {
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) =>
      real(fn, ms === 750 || ms === 1_500 ? 0 : ms)) as typeof setTimeout);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const taskId = `retry-lines-${Math.random().toString(36).slice(2)}`;
    const toolHost: ToolHost = {
      async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
        return { tools: [], onAuthHalt: async () => {} };
      },
    };
    const cfg = {
      onAttached: () => {},
      maxTurns: 10,
      transport: new OverloadedTwice(),
      toolHost,
      journal: new Journal({
        taskId, workspaceId: 'w',
        jsonl: new JsonlStore(join(tmpdir(), `retry-lines-${process.pid}-${taskId}`, `${taskId}.jsonl`)),
        mirror: new InMemorySessionStore(),
        clock: sequentialClock('2026-09-30T00:00:00.000Z'),
      }),
    } as unknown as NativeConfig;
    const ctx: HarnessContext<NativeConfig> = {
      taskId, sessionId: 's-retry-lines', cwd: '/tmp', model: 'gpt-5.6-luna', signal: new AbortController().signal, config: cfg,
    };
    const input = (async function* (): AsyncIterable<UserTurn> { yield { text: 'go' }; })();
    const lines: string[] = [];
    for await (const ev of new NativeHarness().run(input, ctx)) {
      if (ev.kind === 'block' && ev.block.type === 'thinking') lines.push(ev.block.thinking);
    }
    return lines;
  }

  it('on: the turn shows one thinking line per wait before the answer streams', async () => {
    process.env[FLAG] = 'true';
    expect(await thinkingLinesOfATurn()).toEqual([
      'Model is overloaded; retrying in 1 s (attempt 2 of 4)',
      'Model is overloaded; retrying in 2 s (attempt 3 of 4)',
    ]);
  });

  it('off: the same turn shows nothing', async () => {
    expect(await thinkingLinesOfATurn()).toEqual([]);
  });
});
