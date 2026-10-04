/**
 * LANE_FALLBACK_V1 (harness to nine, LOOP): a model lane that keeps failing moves to its second
 * route (Codex core/src/responses_retry.rs: once a stream request has spent its retries, the
 * session falls back from WebSockets to HTTPS, once, and the retry count starts again).
 *
 * The move is for a LANE fault only: a dropped connection, or a bodyless 5xx (an edge answering
 * for a proxy that is briefly gone). A provider's own error (an overload) is the same on every
 * route, so it never moves. The request gets a fresh bounded budget on the second route, once;
 * the next exhaustion ends the request exactly as today (the fallback model, or the error).
 *
 * The loop is the real startStreamWithRetry with the real classifiers; setTimeout is recorded.
 *
 * Revert proof: drop the lane branch and the "a long drop moves" case ends in an error after 4
 * attempts; drop the once-latch and the "fails on the second route too" case asks the transport
 * twice; drop the lane-fault test and the overload case moves the lane.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { APIError as AnthropicAPIError } from '@anthropic-ai/sdk';
import { startStreamWithRetry, retryWaitLine, type RetryWait } from '../round-engine.js';
import { classifyAnthropicError } from '../native-termination.js';
import { classifyOpenAIResponsesError } from '../../transports/openai-responses-termination.js';
import type { ProviderHistory, ProviderStream, StreamEvent, Transport } from '../transport.js';

const FLAG = 'LANE_FALLBACK_V1';
afterEach(() => {
  delete process.env[FLAG];
  vi.restoreAllMocks();
});

/** What undici throws when the connection drops before anything answered. */
const dropped = (): Error => new Error('terminated');
/** The relayed frame an edge sends for a proxy that is briefly gone (no body, no code). */
const bodyless = (): Error => new Error('502 status code (no body)');
const overloaded = (): Error =>
  new AnthropicAPIError(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, undefined, new Headers(), 'overloaded_error' as never);

/** A transport whose first `errs.length` calls throw, in order; then one clean answer. */
function scripted(errs: unknown[], opts: { classify?: (e: unknown) => unknown; secondRoute?: boolean } = {}) {
  const requests: Array<Record<string, unknown>> = [];
  const fallBackLane = vi.fn((_model: string) => opts.secondRoute ?? true);
  const t = {
    api: 'scripted', provider: 'scripted', defaultModel: () => 'primary',
    emptyHistory: () => [] as unknown as ProviderHistory,
    callModel(req: Record<string, unknown>): ProviderStream {
      requests.push(req);
      if (requests.length <= errs.length) throw errs[requests.length - 1];
      return [{ kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }] as unknown as ProviderStream;
    },
    readStream: async function* (s: ProviderStream): AsyncIterable<StreamEvent> {
      for (const ev of s as unknown as StreamEvent[]) yield ev;
    },
    classifyError: opts.classify ?? ((e: unknown) => classifyAnthropicError(e)),
    fallBackLane,
  };
  return { transport: t as unknown as Transport, requests, fallBackLane };
}

const params = { model: 'primary', maxTokens: 100, system: 'sys', tools: [] as never[], history: [] as unknown as ProviderHistory };

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

describe('a lane that keeps failing moves to its second route, once', () => {
  it('a long drop: the bounded schedule, then the move (no extra wait), then a fresh budget that answers', async () => {
    process.env[FLAG] = 'true';
    const delays = recordBackoffs();
    const heard: RetryWait[] = [];
    const { transport, requests, fallBackLane } = scripted(Array.from({ length: 5 }, dropped));
    const started = await startStreamWithRetry(params, transport, {}, { onRetryWait: (w) => heard.push(w) });
    expect(started.model).toBe('primary');
    expect(fallBackLane).toHaveBeenCalledTimes(1);
    expect(fallBackLane).toHaveBeenCalledWith('primary');
    expect(requests).toHaveLength(6);
    // 3 waits on the lane, the move, then the second route's own first wait.
    expect(delays).toEqual([750, 1_500, 2_250, 750]);
    expect(heard.filter((w) => w.switchedLane === true).map(retryWaitLine)).toEqual([
      'The connection to the model kept failing; switched to a backup route for this session',
    ]);
  });

  it('a bodyless 5xx (an edge answering for a proxy that is gone) moves the same way', async () => {
    process.env[FLAG] = 'true';
    recordBackoffs();
    const { transport, requests, fallBackLane } = scripted(Array.from({ length: 4 }, bodyless), { classify: classifyOpenAIResponsesError });
    await startStreamWithRetry(params, transport, {});
    expect(fallBackLane).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(5);
  });

  it('fails on the second route too: asked once, then the request ends as today (the fallback model)', async () => {
    process.env[FLAG] = 'true';
    recordBackoffs();
    const { transport, requests, fallBackLane } = scripted(Array.from({ length: 8 }, dropped));
    const started = await startStreamWithRetry(params, transport, { retry: { fallbackModel: 'fallback' } });
    expect(fallBackLane).toHaveBeenCalledTimes(1);
    expect(requests.map((r) => r.model)).toEqual([...Array(8).fill('primary'), 'fallback']);
    expect(started.model).toBe('fallback');
  });
});

describe('everything else is unchanged', () => {
  it('a provider\'s own error (an overload) never moves the lane', async () => {
    process.env[FLAG] = 'true';
    recordBackoffs();
    const { transport, requests, fallBackLane } = scripted(Array.from({ length: 10 }, overloaded));
    const out = await settle(startStreamWithRetry(params, transport, {}));
    expect(out).toBeInstanceOf(Error);
    expect(fallBackLane).not.toHaveBeenCalled();
    expect(requests).toHaveLength(4);
  });

  it('a lane with no second route: the request ends as today', async () => {
    process.env[FLAG] = 'true';
    recordBackoffs();
    const heard: RetryWait[] = [];
    const { transport, requests, fallBackLane } = scripted(Array.from({ length: 10 }, dropped), { secondRoute: false });
    const out = await settle(startStreamWithRetry(params, transport, {}, { onRetryWait: (w) => heard.push(w) }));
    expect(out).toBeInstanceOf(Error);
    expect(fallBackLane).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(4);
    expect(heard.some((w) => w.switchedLane === true)).toBe(false);
  });

  it('flag off: the transport is never asked; 4 attempts, then the error (byte-identical)', async () => {
    const delays = recordBackoffs();
    const { transport, requests, fallBackLane } = scripted(Array.from({ length: 10 }, dropped));
    const out = await settle(startStreamWithRetry(params, transport, {}));
    expect(out).toBeInstanceOf(Error);
    expect(fallBackLane).not.toHaveBeenCalled();
    expect(requests).toHaveLength(4);
    expect(delays).toEqual([750, 1_500, 2_250]);
  });
});
