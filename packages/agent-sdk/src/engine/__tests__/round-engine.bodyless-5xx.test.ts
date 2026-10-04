/**
 * Follow-up B item 3 — the retry boundary must give a bodyless 5xx more than one look
 * (staging tasks 6cffd831 and b2d2b365, wave-2 drills 2026-09-04).
 *
 * An edge or proxy that is briefly gone answers "502 status code (no body)": no body, so
 * no code, so nothing for the classifier to read but the wording. Unread, it landed on the
 * terminal model_error and the turn burned on the first attempt.
 *
 * The retry itself is #3247's — ONE bounded loop around callModel plus the first stream
 * read, which is the last point where a retry is leak-free. This class only asks for more
 * patience than the generic linear backoff gives: an edge coming back takes seconds, not
 * milliseconds, so it waits 1 s, then 3 s, then 8 s. Four failures still end the turn
 * exactly as they do today.
 *
 * Drives startStreamWithRetry with the REAL OpenAI classifier and a transport that fails
 * the way production did. setTimeout is recorded rather than slept through, so the schedule
 * is asserted as the code ASKED for it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StreamEvent, Transport, ProviderHistory, ProviderStream, NormalizedUsage } from '../transport.js';
import { FakeTransport } from '../transport.js';
import { startStreamWithRetry } from '../round-engine.js';
import { NativeHarness } from '../native-harness.js';
import { classifyOpenAIResponsesError } from '../../transports/openai-responses-termination.js';
import { BODYLESS_5XX_BACKOFF_MS } from '../error-authority.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { NativeConfig } from '../native-config.js';
import type { ToolHost } from '../../ports/tool-host-port.js';
import type { RawToolOptions, OnAuthHalt } from '../../tools/tool-types.js';

/** The relayed frame production saw: the message, no status, no code, no type. */
function bodylessFrame(): unknown {
  return new Error('502 status code (no body)');
}

/** A transport whose first `failures` stream reads throw the bodyless frame. */
function flakyTransport(failures: number): Transport & { attempts: number } {
  const t = {
    attempts: 0,
    api: 'openai_responses',
    provider: 'openai',
    defaultModel: () => 'gpt-5.6-luna',
    emptyHistory: () => [] as unknown as ProviderHistory,
    pushUser: () => {},
    pushAssistant: () => {},
    pushToolResult: () => {},
    buildTools: (raw: unknown) => raw as unknown[],
    callModel: () => ({ attempt: ++t.attempts }) as unknown as ProviderStream,
    readStream: async function* (stream: unknown): AsyncIterable<StreamEvent> {
      if ((stream as { attempt: number }).attempt <= failures) throw bodylessFrame();
      yield { kind: 'text', text: 'the edge came back' };
      yield { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    },
    computeCostUsd: () => 0,
    classifyError: (err: unknown) => classifyOpenAIResponsesError(err),
  };
  return t as unknown as Transport & { attempts: number };
}

const params = (t: Transport) => ({
  model: 'gpt-5.6-luna', maxTokens: 100, system: 's', tools: [], history: t.emptyHistory(),
});

/** Record every backoff the loop ASKS for, and fire it immediately. */
function recordBackoffs(): number[] {
  const delays: number[] = [];
  const real = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    return real(fn, 0);
  }) as typeof setTimeout);
  return delays;
}

/** Count only the RETRY line — asserting on every console.warn would pin unrelated noise. */
function retryLines(): () => number {
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  return () => spy.mock.calls.filter((c) => String(c[0]).includes('retrying model call')).length;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('startStreamWithRetry — a bodyless 5xx is re-asked, patiently', () => {
  it('two 502s then success: the round streams the third attempt', async () => {
    recordBackoffs();
    const transport = flakyTransport(2);
    const started = await startStreamWithRetry(params(transport), transport, {});
    const events: StreamEvent[] = [];
    for await (const ev of started.stream) events.push(ev);

    expect(transport.attempts).toBe(3);
    expect(events.map((e) => e.kind)).toEqual(['text', 'done']);
  });

  it('the backoff is 1 s, then 3 s, then 8 s', async () => {
    const delays = recordBackoffs();
    const transport = flakyTransport(2);
    await startStreamWithRetry(params(transport), transport, {});

    expect(delays).toEqual([...BODYLESS_5XX_BACKOFF_MS].slice(0, 2));
    expect([...BODYLESS_5XX_BACKOFF_MS]).toEqual([1_000, 3_000, 8_000]);
  });

  it('four 502s: the three retries are spent and the turn fails as model_unavailable', async () => {
    const delays = recordBackoffs();
    const retries = retryLines();
    const transport = flakyTransport(4);

    await expect(startStreamWithRetry(params(transport), transport, {})).rejects.toThrow(
      '502 status code (no body)',
    );
    expect(transport.attempts).toBe(4);                 // one try plus three retries
    expect(delays).toEqual([...BODYLESS_5XX_BACKOFF_MS]);
    expect(retries()).toBe(3);                          // one line per retry, no more
    // What the iterate loop's outer catch then classifies the rethrow into.
    expect(transport.classifyError(bodylessFrame()).kind).toBe('model_unavailable');
  });

  it('an ordinary transient keeps the generic linear backoff, not this schedule', async () => {
    // The patience is for the class that earned it. A 429 stays on backoffMs * attempt.
    const delays = recordBackoffs();
    const transport = flakyTransport(1);
    let thrown = 0;
    transport.readStream = async function* (stream: unknown): AsyncIterable<StreamEvent> {
      if ((stream as { attempt: number }).attempt === 1) {
        thrown += 1;
        const err = new Error('rate limited') as Error & Record<string, unknown>;
        err.status = 429;
        throw err;
      }
      yield { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    };

    await startStreamWithRetry(params(transport), transport, { retry: { backoffMs: 750 } });
    expect(thrown).toBe(1);
    expect(delays).toEqual([750]);
  });
});

/**
 * R112 — the same bare-Error shape driven all the way to a TURN, because "the turn burned"
 * is the thing the drills reported and the retry boundary alone cannot say it. What a person
 * sees is the turn_end: a blip it rode out ends `completed`, and one it could not ends
 * `model_unavailable` (the Retry UX), never the terminal `model_error` it used to end as.
 */
class BodylessTransport extends FakeTransport {
  attempts = 0;
  constructor(private readonly failures: number) { super([]); }
  override callModel(): StreamEvent[] {
    this.attempts += 1;
    if (this.attempts <= this.failures) throw bodylessFrame();
    return [
      { kind: 'text', text: 'the edge came back' },
      { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
    ] as StreamEvent[];
  }
  override computeCostUsd(_u: NormalizedUsage): number { return 0; }
  override classifyError(err: unknown): ReturnType<typeof classifyOpenAIResponsesError> {
    return classifyOpenAIResponsesError(err);
  }
}

/**
 * Fire ONLY the bodyless backoffs immediately; every other timer keeps its real delay, so
 * the loop's own guards (the stream-stall watchdog above all) behave as they do live.
 */
function shortCircuitBodylessBackoffs(): number[] {
  const seen: number[] = [];
  const real = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    if (ms !== undefined && BODYLESS_5XX_BACKOFF_MS.includes(ms)) {
      seen.push(ms);
      return real(fn, 0);
    }
    return real(fn, ms);
  }) as typeof setTimeout);
  return seen;
}

async function runOneTurn(failures: number): Promise<{ events: HarnessEvent[]; transport: BodylessTransport }> {
  const taskId = `bodyless-${failures}-${Math.random().toString(36).slice(2)}`;
  const transport = new BodylessTransport(failures);
  const toolHost: ToolHost = {
    async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
      return { tools: [], onAuthHalt: async () => {} };
    },
  };
  const cfg = {
    onAttached: () => {},
    maxTurns: 10,
    transport,
    toolHost,
    journal: new Journal({
      taskId, workspaceId: 'w',
      jsonl: new JsonlStore(join(tmpdir(), `bodyless-${process.pid}-${taskId}`, `${taskId}.jsonl`)),
      mirror: new InMemorySessionStore(),
      clock: sequentialClock('2026-09-04T00:00:00.000Z'),
    }),
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = {
    taskId, sessionId: 's-bodyless', cwd: '/tmp', model: 'gpt-5.6-luna',
    signal: new AbortController().signal, config: cfg,
  };
  const input = (async function* (): AsyncIterable<UserTurn> { yield { text: 'what changed?' }; })();
  const events: HarnessEvent[] = [];
  for await (const ev of new NativeHarness().run(input, ctx)) events.push(ev);
  return { events, transport };
}

const turnEnd = (events: HarnessEvent[]): Extract<HarnessEvent, { kind: 'turn_end' }> => {
  const ends = events.filter((e): e is Extract<HarnessEvent, { kind: 'turn_end' }> => e.kind === 'turn_end');
  expect(ends).toHaveLength(1);
  return ends[0]!;
};

describe('the TURN, on the bare-Error shape production sent', () => {
  it('two failures then success: the turn completes, and the person never sees the blip', async () => {
    const delays = shortCircuitBodylessBackoffs();
    const retries = retryLines();
    const { events, transport } = await runOneTurn(2);

    expect(transport.attempts).toBe(3);
    expect(delays).toEqual([1_000, 3_000]);
    expect(retries()).toBe(2);                        // one line per retry
    expect(turnEnd(events).outcome).toMatchObject({ kind: 'completed' });
  });

  it('the fourth failure ends the turn as model_unavailable, never as terminal model_error', async () => {
    const delays = shortCircuitBodylessBackoffs();
    retryLines();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { events, transport } = await runOneTurn(99);

    expect(transport.attempts).toBe(4);               // one try plus the three retries
    expect(delays).toEqual([1_000, 3_000, 8_000]);
    const end = turnEnd(events);
    expect(end.outcome?.kind).toBe('model_unavailable');
    expect(end.outcome?.kind).not.toBe('model_error');
  });
});
