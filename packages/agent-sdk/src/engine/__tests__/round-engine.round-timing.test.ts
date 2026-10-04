/**
 * MODEL_CALL_EVENTS_V1 (harness-to-nine O1) — a round's whole clock on its usage event.
 *
 * #4166 put `ttftMs` and `latencyMs` on each round's usage event. This adds the rest of the
 * ruler, every reading from the same request start: when the first answer text showed
 * (`firstTextMs`), and the whole call split at the moment the committed attempt was handed to
 * the transport, named for WHEN, not whose: `beforeSendMs` (the build, every failed attempt,
 * the waits) and `afterSendMs` (the committed attempt to its last event), with `attempts`. The
 * engine reads a monotonic clock (monotonic-clock.ts); here that clock is driven by hand, so
 * every number below is exact.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GateResult, ToolCall } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { StreamEvent, Transport, NormalizedUsage, ProviderHistory, ProviderStream } from '../transport.js';
import { createRunContext } from '../run-context.js';
import { createNativeHookDispatcher } from '../native-hooks.js';
import { runOneRound, startStreamWithRetry, type RoundDeps, type RoundState } from '../round-engine.js';
import { driveRoundStream, roundTiming } from '../round-stream.js';

const clock = vi.hoisted(() => ({ now: 0 }));
vi.mock('../monotonic-clock.js', () => ({ monotonicMs: () => clock.now }));

/** A stream event and the clock reading at which it arrives. */
type Timed = { at: number; ev: StreamEvent };

/**
 * One scripted round per callModel. `failFirst` makes the first attempt throw a retryable
 * error after `failFirst` ms (a failed attempt the round pays for before the committed one).
 */
function clockedTransport(rounds: Timed[][], opts: { failFirst?: number } = {}): Transport & { sentAt: number[] } {
  let i = 0;
  const sentAt: number[] = [];
  const t: Partial<Transport> & { sentAt: number[] } = {
    sentAt,
    api: 'fake',
    provider: 'fake',
    defaultModel: () => 'm',
    emptyHistory: () => [] as unknown as ProviderHistory,
    pushUser: (h) => { (h as unknown[]).push({ role: 'user' }); },
    pushAssistant: (h, blocks) => { (h as unknown[]).push({ role: 'assistant', blocks }); },
    pushToolResult: (h, r) => { (h as unknown[]).push({ role: 'tool_result', r }); },
    buildTools: (raw) => raw as unknown[],
    callModel: () => {
      sentAt.push(clock.now);
      if (opts.failFirst !== undefined && sentAt.length === 1) {
        clock.now += opts.failFirst;
        throw new Error('429 slow down');
      }
      return (rounds[i++] ?? []) as unknown as ProviderStream;
    },
    readStream: async function* (stream) {
      for (const { at, ev } of stream as unknown as Timed[]) {
        clock.now = at;
        yield ev;
      }
    },
    computeCostUsd: (u: NormalizedUsage) => (u.inputTokens + u.outputTokens) * 0.00001,
    classifyError: () => ({ kind: 'rate_limited', raw: { subtype: 'rate_limited', errors: [] } }) as never,
  };
  return t as Transport & { sentAt: number[] };
}

const allowHarness = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };

const freshState = (): RoundState => ({
  assistantText: '',
  thinkingBlocks: [],
  toolUses: [],
  roundAppended: false,
  inToolBatch: false,
  stopReason: null,
  lastUsage: { inputTokens: 0, outputTokens: 0 },
  lastUsageModel: 'm',
});

function mainDeps(transport: Transport): RoundDeps {
  return {
    ctx: { taskId: 't', sessionId: 's', cwd: '', model: 'm', config: {}, signal: new AbortController().signal },
    // An immediate retry: the failed attempt's own time is the only overhead it adds.
    cfg: { retry: { maxAttempts: 3, backoffMs: 0 } },
    transport,
    rc: createRunContext('t'),
    harness: allowHarness,
    dispatcher: createNativeHookDispatcher(allowHarness),
    tools: [],
    providerTools: [],
    system: 'sys',
    onPause: async () => 'PAUSED',
    onAuthHalt: undefined,
    requestedModel: 'm',
    cachePrefixHint: undefined,
    history: transport.emptyHistory(),
    turnBlocks: [],
    pendingTodoBlocks: [],
  } as RoundDeps;
}

async function usageOf(deps: RoundDeps): Promise<Extract<HarnessEvent, { kind: 'usage' }>> {
  const events: HarnessEvent[] = [];
  const gen = runOneRound(deps, freshState());
  for (let n = await gen.next(); !n.done; n = await gen.next()) events.push(n.value);
  const usage = events.find((e): e is Extract<HarnessEvent, { kind: 'usage' }> => e.kind === 'usage');
  if (!usage) throw new Error('the round yielded no usage event');
  return usage;
}

const done = (stop = 'end_turn'): StreamEvent => ({ kind: 'done', stopReason: stop, usage: { inputTokens: 10, outputTokens: 5 } });

beforeEach(() => {
  clock.now = 1_000;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SUBAGENT_USAGE_LEDGER_V1;
});

describe('roundTiming: one ruler from the request start', () => {
  it('splits the call at the committed send and places the first text on the same ruler', () => {
    expect(roundTiming({ requestStartMs: 1_000, sentAtMs: 1_300, firstTextAtMs: 2_100, endMs: 4_000 })).toEqual({
      latencyMs: 3_000,
      beforeSendMs: 300,
      afterSendMs: 2_700,
      firstTextMs: 1_100,
    });
  });

  it('whole milliseconds on the wire, and the split still sums exactly', () => {
    const t = roundTiming({ requestStartMs: 0.4, sentAtMs: 10.7, firstTextAtMs: 20.2, endMs: 30.9 });
    expect(t).toEqual({ latencyMs: 31, beforeSendMs: 10, afterSendMs: 21, firstTextMs: 20 });
  });

  it('a round that wrote no text has no firstTextMs at all', () => {
    const t = roundTiming({ requestStartMs: 0, sentAtMs: 0, firstTextAtMs: undefined, endMs: 900 });
    expect(t).toEqual({ latencyMs: 900, beforeSendMs: 0, afterSendMs: 900 });
    expect('firstTextMs' in t).toBe(false);
  });
});

describe('driveRoundStream: the first answer text, never thinking or a tool call', () => {
  it('returns when the first non-empty text arrived', async () => {
    const stream = (async function* (): AsyncIterable<StreamEvent> {
      clock.now = 1_200;
      yield { kind: 'thinking_start' };
      clock.now = 1_400;
      yield { kind: 'thinking', text: 'let me look' };
      clock.now = 1_500;
      yield { kind: 'text', text: '' };
      clock.now = 1_900;
      yield { kind: 'text', text: 'Here it is.' };
      clock.now = 2_500;
      yield { kind: 'text', text: ' More.' };
      clock.now = 3_000;
      yield done();
    })();
    const gen = driveRoundStream(stream, freshState());
    let n = await gen.next();
    while (!n.done) n = await gen.next();
    expect(n.value).toEqual({ firstTextAtMs: 1_900 });
  });

  it('a tool-only stream reports no first text', async () => {
    const stream = (async function* (): AsyncIterable<StreamEvent> {
      clock.now = 1_300;
      yield { kind: 'tool_use', toolUse: { id: 'tu-1', name: 'Read', input: {} } };
      yield done('tool_use');
    })();
    const gen = driveRoundStream(stream, freshState());
    let n = await gen.next();
    while (!n.done) n = await gen.next();
    expect(n.value).toEqual({ firstTextAtMs: undefined });
  });
});

describe('startStreamWithRetry: told of every attempt it sends', () => {
  it('once per attempt, just before it goes out: the failed one, then the committed one', async () => {
    const transport = clockedTransport([[{ at: 1_500, ev: done() }]], { failFirst: 300 });
    const told: number[] = [];
    await startStreamWithRetry(
      { model: 'm', maxTokens: 100, system: 's', tools: [], history: transport.emptyHistory() },
      transport,
      { retry: { maxAttempts: 3, backoffMs: 0 } },
      { onAttempt: () => told.push(clock.now) },
    );
    expect(told).toEqual([1_000, 1_300]);
    expect(transport.sentAt).toEqual(told);
  });
});

describe("runOneRound: the round's usage event carries the whole clock", () => {
  it('a text round after a refused attempt: ttft, first text, latency, its split at the committed send, and 2 attempts', async () => {
    const transport = clockedTransport(
      [[
        { at: 1_500, ev: { kind: 'thinking', text: 'hmm' } },
        { at: 2_100, ev: { kind: 'text', text: 'Done.' } },
        { at: 4_000, ev: done() },
      ]],
      { failFirst: 300 },
    );
    const usage = await usageOf(mainDeps(transport));
    expect(usage).toMatchObject({
      ttftMs: 500,
      firstTextMs: 1_100,
      latencyMs: 3_000,
      // The provider's refusal (and its wait) is BEFORE the committed send: attempts says why.
      beforeSendMs: 300,
      afterSendMs: 2_700,
      attempts: 2,
    });
    expect(usage.beforeSendMs! + usage.afterSendMs!).toBe(usage.latencyMs);
  });

  it('a round that only calls a tool carries the split but no first text', async () => {
    const transport = clockedTransport([[
      { at: 1_250, ev: { kind: 'tool_use', toolUse: { id: 'tu-1', name: 'Missing', input: {} } } },
      { at: 1_800, ev: done('tool_use') },
    ]]);
    const usage = await usageOf(mainDeps(transport));
    expect(usage).toMatchObject({ ttftMs: 250, latencyMs: 800, beforeSendMs: 0, afterSendMs: 800, attempts: 1 });
    expect('firstTextMs' in usage).toBe(false);
  });

  it("a subagent's round (SUBAGENT_USAGE_LEDGER_V1) carries the same clock on its 'subagent' lane", async () => {
    process.env.SUBAGENT_USAGE_LEDGER_V1 = 'true';
    const transport = clockedTransport(
      [[{ at: 1_400, ev: { kind: 'text', text: 'child says' } }, { at: 2_000, ev: done() }]],
      { failFirst: 100 },
    );
    const { rc: _rc, dispatcher: _d, ...base } = mainDeps(transport) as RoundDeps & { rc: unknown; dispatcher: unknown };
    const deps = {
      ...base,
      sub: { foldRoundCost: vi.fn(), persistRound: vi.fn(async () => {}), execCtx: {} as never },
    } as unknown as RoundDeps;
    const usage = await usageOf(deps);
    expect(usage).toMatchObject({
      lane: 'subagent',
      ttftMs: 400,
      firstTextMs: 400,
      latencyMs: 1_000,
      beforeSendMs: 100,
      afterSendMs: 900,
      attempts: 2,
    });
  });
});
