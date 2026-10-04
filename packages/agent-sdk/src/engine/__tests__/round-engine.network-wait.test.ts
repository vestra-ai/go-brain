/**
 * NETWORK_WAIT_V1 (harness to nine, LOOP): a dropped connection on the main loop's model request
 * is not the provider's error. Once error-authority's `dropped_connection` cause has spent its own
 * bounded schedule, the request keeps waiting for the network (Codex core/src/responses_retry.rs:
 * no attempt cap, 5 s doubling to 60 s, a "waiting for network" notice), one live line per wait,
 * until it answers or the person stops the turn. Every other cause, a subagent's request and the
 * flag off keep today's bounded schedule.
 *
 * The loop is the real startStreamWithRetry with the real Anthropic classifier; setTimeout is
 * recorded rather than slept through, so every schedule is asserted as the code asked for it.
 *
 * The waits end at NETWORK_WAIT_CEILING_MS (12 minutes) from the first: on our box a waiting turn
 * keeps its work hold, vetoes the upgrade drain and keeps the stalled-turn watchdog quiet, so it
 * may not wait forever. Past the ceiling the request ends as an exhausted one does.
 *
 * Revert proof: drop the network branch and the long-outage case ends in an error after the
 * bounded schedule; drop the `waitForNetwork` gate and the subagent case waits unbounded; drop
 * the abortable sleep and the Stop case never returns; drop the ceiling and the 12-minute case
 * never ends.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { APIError as AnthropicAPIError } from '@anthropic-ai/sdk';
import { startStreamWithRetry, retryWaitLine, type RetryWait } from '../round-engine.js';
import { networkWaitMs, NETWORK_WAIT_MAX_MS, NETWORK_WAIT_CEILING_MS } from '../error-authority.js';
import { classifyAnthropicError } from '../native-termination.js';
import type { ProviderHistory, ProviderStream, StreamEvent, Transport } from '../transport.js';

const NETWORK = 'NETWORK_WAIT_V1';
const BY_CAUSE = 'RETRY_BY_CAUSE_V1';
afterEach(() => {
  delete process.env[NETWORK];
  delete process.env[BY_CAUSE];
  delete process.env.LANE_FALLBACK_V1;
  vi.restoreAllMocks();
});

/** What undici throws when the connection drops before anything answered. */
const dropped = (): Error => new Error('terminated');
const overloaded = (): Error =>
  new AnthropicAPIError(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, undefined, new Headers(), 'overloaded_error' as never);

/** A transport whose first `errs.length` calls throw, in order; then one clean answer. */
function scripted(errs: unknown[]) {
  const requests: Array<Record<string, unknown>> = [];
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
    classifyError: (e: unknown) => classifyAnthropicError(e),
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

describe('networkWaitMs: 5 s doubling to 60 s', () => {
  it('the schedule', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(networkWaitMs)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    expect(NETWORK_WAIT_MAX_MS).toBe(60_000);
  });
});

describe('a long outage on the main loop: the request waits for the network, then answers', () => {
  it('by cause: the bounded jitter first, then 5, 10, 20, 40, 60, 60 s, each wait told as waiting for the network', async () => {
    process.env[NETWORK] = 'true';
    process.env[BY_CAUSE] = 'true';
    const delays = recordBackoffs();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const heard: RetryWait[] = [];
    const { transport, requests } = scripted(Array.from({ length: 10 }, dropped));
    const started = await startStreamWithRetry(params, transport, {}, { onRetryWait: (w) => heard.push(w), waitForNetwork: true });
    expect(started.model).toBe('primary');
    expect(requests).toHaveLength(11);
    // The cause's own budget (3 jittered waits for 4 attempts), then the network waits.
    expect(delays).toEqual([250, 500, 1_000, 5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    const network = heard.filter((w) => w.waitingForNetwork === true);
    expect(network.map((w) => w.waitMs)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    expect(network.map(retryWaitLine)).toEqual([
      'Waiting for the network; retrying in 5 s',
      'Waiting for the network; retrying in 10 s',
      'Waiting for the network; retrying in 20 s',
      'Waiting for the network; retrying in 40 s',
      'Waiting for the network; retrying in 60 s',
      'Waiting for the network; retrying in 60 s',
      'Waiting for the network; retrying in 60 s',
    ]);
  });

  it('with RETRY_BY_CAUSE_V1 off: today\'s linear schedule first, then the same network waits', async () => {
    process.env[NETWORK] = 'true';
    const delays = recordBackoffs();
    const { transport, requests } = scripted(Array.from({ length: 6 }, dropped));
    await startStreamWithRetry(params, transport, {}, { waitForNetwork: true });
    expect(requests).toHaveLength(7);
    expect(delays).toEqual([750, 1_500, 2_250, 5_000, 10_000, 20_000]);
  });

  it('the attempt count holds at the cap: an overload after the network returns gets what an exhausted request gets', async () => {
    process.env[NETWORK] = 'true';
    process.env[BY_CAUSE] = 'true';
    recordBackoffs();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { transport, requests } = scripted([dropped(), dropped(), dropped(), dropped(), dropped(), overloaded()]);
    const started = await startStreamWithRetry(params, transport, { retry: { fallbackModel: 'fallback' } }, { waitForNetwork: true });
    // Three bounded waits, the fourth drop and the fifth wait for the network, then the overload
    // (its own budget long spent) goes straight to the fallback.
    expect(requests.map((r) => r.model)).toEqual(['primary', 'primary', 'primary', 'primary', 'primary', 'primary', 'fallback']);
    expect(started.model).toBe('fallback');
  });
});

describe('everything else stays bounded', () => {
  it('flag off: the bounded schedule, then the error (byte-identical)', async () => {
    const delays = recordBackoffs();
    const { transport, requests } = scripted(Array.from({ length: 10 }, dropped));
    const out = await settle(startStreamWithRetry(params, transport, {}, { waitForNetwork: true }));
    expect(out).toBeInstanceOf(Error);
    expect(requests).toHaveLength(4);
    expect(delays).toEqual([750, 1_500, 2_250]);
  });

  it('a subagent\'s request (no waitForNetwork): bounded even with the flag on', async () => {
    process.env[NETWORK] = 'true';
    const { transport, requests } = scripted(Array.from({ length: 10 }, dropped));
    recordBackoffs();
    const out = await settle(startStreamWithRetry(params, transport, {}));
    expect(out).toBeInstanceOf(Error);
    expect(requests).toHaveLength(4);
  });

  it('a provider error (an overload) is never waited on for the network', async () => {
    process.env[NETWORK] = 'true';
    process.env[BY_CAUSE] = 'true';
    recordBackoffs();
    const heard: RetryWait[] = [];
    const { transport, requests } = scripted(Array.from({ length: 10 }, overloaded));
    const out = await settle(startStreamWithRetry(params, transport, {}, { onRetryWait: (w) => heard.push(w), waitForNetwork: true }));
    expect(out).toBeInstanceOf(Error);
    expect(requests).toHaveLength(4);
    expect(heard.some((w) => w.waitingForNetwork === true)).toBe(false);
  });
});

describe('Stop ends the wait', () => {
  it('a Stop during a network wait returns at once as an abort, with no further request', async () => {
    process.env[NETWORK] = 'true';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { transport, requests } = scripted(Array.from({ length: 50 }, dropped));
      const run = settle(startStreamWithRetry({ ...params, signal: controller.signal }, transport, {}, { waitForNetwork: true }));
      // The bounded schedule (0.75 + 1.5 + 2.25 s), then into the first 5 s network wait.
      await vi.advanceTimersByTimeAsync(6_000);
      const before = requests.length;
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      const out = await run;
      expect((out as Error).name).toBe('AbortError');
      expect(requests.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the waits end at the ceiling', () => {
  it('a network that never comes back: 14 waits (5, 10, 20, 40, then 60 s), within 12 minutes, then the request ends', async () => {
    process.env[NETWORK] = 'true';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const heard: RetryWait[] = [];
      const { transport, requests } = scripted(Array.from({ length: 100 }, dropped));
      const run = settle(startStreamWithRetry(params, transport, {}, { onRetryWait: (w) => heard.push(w), waitForNetwork: true }));
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      const out = await run;
      expect(out).toBeInstanceOf(Error);
      expect((out as Error).message).toBe('terminated');
      const waits = heard.filter((w) => w.waitingForNetwork === true).map((w) => w.waitMs);
      expect(waits).toEqual([5_000, 10_000, 20_000, 40_000, ...Array(10).fill(60_000)]);
      expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(NETWORK_WAIT_CEILING_MS);
      // 4 bounded attempts, then one request after each of the 14 waits.
      expect(requests).toHaveLength(18);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('with LANE_FALLBACK_V1 on too: the backup route first, then the waits', () => {
  it('the bounded schedule, the move (a fresh budget there), its schedule, then the network waits', async () => {
    process.env[NETWORK] = 'true';
    process.env.LANE_FALLBACK_V1 = 'true';
    const delays = recordBackoffs();
    const heard: RetryWait[] = [];
    const { transport, requests } = scripted(Array.from({ length: 9 }, dropped));
    const fallBackLane = vi.fn(() => true);
    (transport as unknown as { fallBackLane: typeof fallBackLane }).fallBackLane = fallBackLane;
    await startStreamWithRetry(params, transport, {}, { onRetryWait: (w) => heard.push(w), waitForNetwork: true });
    expect(fallBackLane).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(10);
    expect(delays).toEqual([750, 1_500, 2_250, 750, 1_500, 2_250, 5_000, 10_000]);
    expect(heard.map((w) => (w.switchedLane ? 'switch' : w.waitingForNetwork ? 'network' : 'cause'))).toEqual(['switch', 'network', 'network']);
  });
});
