/**
 * SWEEP_PREFIX_PARITY_V1, the review fixes that gate the staging flip (#4148 review, 2 Oct).
 *
 *  1. A parity sweep cut before `done` is never metered as zero: the provider billed the
 *     stream, so the row carries the usage it reported or else an estimate, and one cut by its
 *     own 30 s bound says 'timeout'. Parity reasons at the loop's effort with an 8192 cap, so
 *     its tail runs longer than the floored sweep's did.
 *  2. (b) The parity sweep's trailing message asks for no deliberation (outside the prefix).
 *     (c) An Anthropic row thinking at high effort or above keeps today's floored request.
 *  4. The request the sweep rides is the one the loop SENT, on the model that served it: a
 *     fallback that took over the round must not leave the sweep on the dead primary.
 *
 * Flag off, each path is pinned byte-identical to today.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEMORY_SWEEP_PROMPT,
  MEMORY_SWEEP_PROMPT_PARITY,
  SWEEP_PARITY_MAX_TOKENS,
  SWEEP_TIMEOUT_MS,
  SWEEP_CUT_OUTPUT_TOKENS_PER_S,
  SWEEP_CUT_FIRST_TOKEN_MS,
  estimateSweepSpend,
  runOffloopSweep,
  sweepParityPaysOff,
} from '../memory-sweep.js';
import { sweepCall } from '../post-turn-off-path.js';
import { laneUsageEvent } from '../offloop-usage.js';
import { NativeHarness } from '../native-harness.js';
import { mainRunCacheKey } from '../main-run-cache-key.js';
import type { LoopRequest } from '../round-engine.js';
import { FakeTransport, type ProviderStream, type StreamEvent } from '../transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { TurnOutcome } from '../../contract/turn-outcome.js';
import type { NativeConfig } from '../native-config.js';
import type { RawToolOptions, OnAuthHalt } from '../../tools/tool-types.js';
import type { ToolHost } from '../../ports/tool-host-port.js';

const FLAG = 'SWEEP_PREFIX_PARITY_V1';
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env[FLAG];
});

type CallParams = Parameters<FakeTransport['callModel']>[0];

function emptyJournal(): Journal {
  const taskId = `t-parity-fix-${Math.random().toString(36).slice(2)}`;
  return new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(join(tmpdir(), `sweep-parity-fix-${process.pid}`, `${taskId}.jsonl`)),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2026-10-02T00:00:00.000Z'),
  });
}

async function journalWith(text: string): Promise<Journal> {
  const journal = emptyJournal();
  const taskId = journal.taskId;
  await journal.append({
    taskId, rootTaskId: taskId, spawnDepth: 0, workspaceId: 'w', agentId: 'native', timestamp: '',
    principal: { kind: 'user', userId: 'u' },
    payload: { type: 'user', blocks: [{ type: 'text', text }] },
  });
  return journal;
}

/** Streams `before`, then holds the stream open until the request is aborted, and throws as a provider does. */
class HangingTransport extends FakeTransport {
  params: CallParams[] = [];
  constructor(private readonly before: StreamEvent[]) {
    super([]);
  }
  override callModel(p: CallParams): ProviderStream {
    this.params.push(p);
    return p.signal;
  }
  override async *readStream(stream: ProviderStream): AsyncIterable<StreamEvent> {
    const signal = stream as AbortSignal;
    for (const ev of this.before) yield ev;
    await new Promise<never>((_resolve, reject) => {
      const fail = () => reject(Object.assign(new Error('Request was aborted.'), { name: 'AbortError' }));
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    });
  }
}

/** Records every callModel param object whole and answers with one FACT line. */
class ParamsTransport extends FakeTransport {
  params: CallParams[] = [];
  constructor() {
    super([
      { kind: 'text', text: 'FACT [relationship] (user_direct) Priya is the cofounder of Acme.\n' },
      { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 900, outputTokens: 40 } },
    ]);
  }
  override callModel(p: CallParams) {
    this.params.push(p);
    return super.callModel(p);
  }
}

const LOOP_REQUEST: LoopRequest = { model: 'gpt-6.1-sol', system: 'the loop system', tools: [], cacheKey: 'u-0123456789abcdef' };
const LOOP_INPUT = { inputTokens: 40_000, outputTokens: 300 };
const STREAMED: StreamEvent[] = [
  { kind: 'thinking', text: 'weighing what matters' },
  { kind: 'text', text: 'FACT [identity] (user_direct) The user b' },
];
/** What a timed-out parity sweep meters for the thinking it never streamed. */
const TIMEOUT_THINKING = Math.ceil(((SWEEP_TIMEOUT_MS - SWEEP_CUT_FIRST_TOKEN_MS) / 1000) * SWEEP_CUT_OUTPUT_TOKENS_PER_S);
/** Every streamed char of thinking and text, the output estimate's input. */
const STREAMED_CHARS = STREAMED.reduce((n, ev) => n + (ev.kind === 'text' || ev.kind === 'thinking' ? ev.text.length : 0), 0);

/**
 * Wait (real I/O turns, the fake clock still) until the sweep's request has gone out. The
 * journal projection is real file I/O, so the bound is a WALL-CLOCK deadline, never a count
 * of turns (a slow CI box under coverage needs more of them).
 */
async function untilSent(t: { params: unknown[] }): Promise<void> {
  const giveUpAt = performance.now() + 10_000;
  while (t.params.length === 0 && performance.now() < giveUpAt) await new Promise<void>((r) => setImmediate(r));
  expect(t.params).toHaveLength(1);
}

describe('finding 1: a parity sweep cut before done is metered, and its own bound says timeout', () => {
  it('the 30 s bound: status timeout, carrying the estimate (the loop prefix read from the cache, the tail, the streamed output)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const transport = new HangingTransport(STREAMED);
    const pending = runOffloopSweep({
      transport, journal: await journalWith('Priya runs Acme with me.'), elision: null,
      model: 'gpt-6.1-sol', system: 'S', providerTools: [],
      loopRequest: LOOP_REQUEST, loopInput: LOOP_INPUT,
    });
    await untilSent(transport);
    await vi.advanceTimersByTimeAsync(SWEEP_TIMEOUT_MS);
    const result = await pending;
    // MED-3/MED-C of the #4381 review: the output counts the thinking that never streamed, at the
    // fastest measured rate over the bound after the first-token wait (the streamed count alone is ~16).
    const estimate = {
      inputTokens: LOOP_INPUT.outputTokens + Math.ceil(MEMORY_SWEEP_PROMPT_PARITY.length / 4),
      cacheReadInputTokens: LOOP_INPUT.inputTokens,
      outputTokens: TIMEOUT_THINKING,
    };
    expect(result).toEqual({ facts: [], status: 'timeout', model: 'gpt-6.1-sol', usage: estimate });
    // The row says timeout and carries the estimate, never zero.
    const row = laneUsageEvent('sweep', result, 'task-1', 3);
    expect(row).toMatchObject({ kind: 'usage', lane: 'sweep', laneStatus: 'timeout', usage: estimate });
  });

  it('a cut (the next message, the run abort) stays error with the estimate as spent, so a cancelled row is never zero', async () => {
    const transport = new HangingTransport(STREAMED);
    const cut = new AbortController();
    const pending = runOffloopSweep({
      transport, journal: await journalWith('Priya runs Acme with me.'), elision: null,
      model: 'gpt-6.1-sol', system: 'S', providerTools: [], signal: cut.signal,
      loopRequest: LOOP_REQUEST, loopInput: LOOP_INPUT,
    });
    await untilSent(transport);
    cut.abort();
    const result = await pending;
    expect(result.status).toBe('error');
    expect(result.usage).toBeUndefined(); // the error row itself stays zero, as ever
    // MED-C: a row the next message cut meters what streamed, no time floor (usually cut inside the first-token wait).
    expect(result.spent).toEqual({
      inputTokens: LOOP_INPUT.outputTokens + Math.ceil(MEMORY_SWEEP_PROMPT_PARITY.length / 4),
      cacheReadInputTokens: LOOP_INPUT.inputTokens,
      outputTokens: Math.ceil(STREAMED_CHARS / 4),
    });
  });

  it('a refusal before anything streamed (not a cut) was never billed: error, no spent', async () => {
    class Refusing extends FakeTransport {
      override callModel(): ProviderStream {
        throw Object.assign(new Error('400 output_config.effort requires a model that supports per-turn effort'), { status: 400 });
      }
    }
    const result = await runOffloopSweep({
      transport: new Refusing([]), journal: await journalWith('Priya runs Acme with me.'), elision: null,
      model: 'claude-fable-5', system: 'S', providerTools: [],
      loopRequest: { ...LOOP_REQUEST, model: 'claude-fable-5' }, loopInput: LOOP_INPUT,
    });
    // Mutation: estimate on every failure → a refused call is metered as a whole sweep.
    expect(result).toEqual({ facts: [], status: 'error', model: 'claude-fable-5' });
  });

  it('flag off (no loop request): the bound is error with no usage and no spent, byte-identical to today', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const transport = new HangingTransport(STREAMED);
    const pending = runOffloopSweep({
      transport, journal: await journalWith('Priya runs Acme with me.'), elision: null,
      model: 'gpt-6.1-sol', system: 'S', providerTools: [], loopInput: LOOP_INPUT,
    });
    await untilSent(transport);
    await vi.advanceTimersByTimeAsync(SWEEP_TIMEOUT_MS);
    expect(await pending).toEqual({ facts: [], status: 'error', model: 'gpt-6.1-sol' });
  });

  it('no count of the loop request: nothing to estimate from, so the timeout row reports zero rather than a guess', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const transport = new HangingTransport(STREAMED);
    const pending = runOffloopSweep({
      transport, journal: await journalWith('Priya runs Acme with me.'), elision: null,
      model: 'gpt-6.1-sol', system: 'S', providerTools: [], loopRequest: LOOP_REQUEST,
    });
    await untilSent(transport);
    await vi.advanceTimersByTimeAsync(SWEEP_TIMEOUT_MS);
    expect(await pending).toEqual({ facts: [], status: 'timeout', model: 'gpt-6.1-sol' });
  });

  const loop = { inputTokens: 12_000, outputTokens: 80 };
  it('estimateSweepSpend off Anthropic: prefix as cached input, final reply plus prompt as fresh input', () => {
    expect(estimateSweepSpend(loop, { model: 'gpt-6.1-sol', promptChars: 400, streamedChars: 9, timedOut: false })).toEqual({
      inputTokens: 180,
      cacheReadInputTokens: 12_000,
      outputTokens: 3,
    });
    expect(estimateSweepSpend(undefined, { model: 'gpt-6.1-sol', promptChars: 400, streamedChars: 9, timedOut: false })).toBeUndefined();
  });

  it('estimateSweepSpend on Anthropic: the tail is a cache write, booked as a real row books it (no 5m/1h split)', () => {
    expect(estimateSweepSpend(loop, { model: 'claude-fable-5', promptChars: 400, streamedChars: 9, timedOut: false })).toEqual({
      inputTokens: 0,
      cacheCreationInputTokens: 180,
      cacheReadInputTokens: 12_000,
      outputTokens: 3,
    });
  });

  it('MED-3/MED-C: a timed-out row counts unstreamed thinking at the fastest measured rate after the first-token wait; a cut row meters what streamed', () => {
    const out = (streamedChars: number, timedOut: boolean) =>
      estimateSweepSpend(loop, { model: 'claude-fable-5', promptChars: 400, streamedChars, timedOut })!.outputTokens;
    // Mutation: drop the time floor → a 30 s high-effort timeout that streamed a short summary meters 3 tokens.
    expect(out(9, true)).toBe(TIMEOUT_THINKING);
    expect(TIMEOUT_THINKING).toBe(2_884); // (30 s - 2 s) x 103 tokens/s
    // Mutation: apply the floor to every cut → a follow-up that cut the sweep 1 s in meters ~2,900 tokens.
    expect(out(9, false)).toBe(3);
    expect(out(20_000, true)).toBe(5_000); // what streamed, when that is more
    expect(out(40_000, true)).toBe(SWEEP_PARITY_MAX_TOKENS); // never past the request's own cap
    expect(SWEEP_CUT_OUTPUT_TOKENS_PER_S).toBe(103); // the fastest measured (agent_turns, 45 days), never above it
    expect(SWEEP_CUT_FIRST_TOKEN_MS).toBe(2_000);
  });

  it('MED-3 through the sweep: an Anthropic parity sweep cut by its bound meters the time floor and the tail as a cache write', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const transport = new HangingTransport(STREAMED);
    const pending = runOffloopSweep({
      transport, journal: await journalWith('Priya runs Acme with me.'), elision: null,
      model: 'claude-fable-5', system: 'S', providerTools: [],
      loopRequest: { ...LOOP_REQUEST, model: 'claude-fable-5' }, loopInput: LOOP_INPUT,
    });
    await untilSent(transport);
    await vi.advanceTimersByTimeAsync(SWEEP_TIMEOUT_MS);
    const result = await pending;
    const tail = LOOP_INPUT.outputTokens + Math.ceil(MEMORY_SWEEP_PROMPT_PARITY.length / 4);
    expect(result).toEqual({
      facts: [], status: 'timeout', model: 'claude-fable-5',
      usage: {
        inputTokens: 0, cacheCreationInputTokens: tail,
        cacheReadInputTokens: LOOP_INPUT.inputTokens, outputTokens: TIMEOUT_THINKING,
      },
    });
  });
});

describe('finding 2(b): the parity sweep asks for no deliberation, in its own trailing message', () => {
  it('the parity prompt is today\'s with one line added to the opener; today\'s prompt is unchanged', () => {
    const line = 'Reply directly; no deliberation is needed.';
    expect(MEMORY_SWEEP_PROMPT).not.toContain(line);
    expect(MEMORY_SWEEP_PROMPT_PARITY).toBe(
      MEMORY_SWEEP_PROMPT.replace('before the session closes.\n\n', `before the session closes. ${line}\n\n`),
    );
    expect(MEMORY_SWEEP_PROMPT_PARITY).not.toContain('—');
    expect(MEMORY_SWEEP_PROMPT_PARITY).not.toContain('–');
  });

  it('rides the trailing message only when the sweep rides the loop request', async () => {
    const parity = new ParamsTransport();
    await runOffloopSweep({
      transport: parity, journal: await journalWith('Priya runs Acme with me.'), elision: null,
      model: 'x', system: 'S', providerTools: [], loopRequest: LOOP_REQUEST,
    });
    const today = new ParamsTransport();
    await runOffloopSweep({
      transport: today, journal: await journalWith('Priya runs Acme with me.'), elision: null,
      model: 'gpt-6.1-sol', system: 'S', providerTools: [],
    });
    const last = (t: ParamsTransport) => {
      const history = t.params[0].history as Array<{ text?: string }>;
      return history[history.length - 1]?.text;
    };
    expect(last(parity)).toBe(MEMORY_SWEEP_PROMPT_PARITY);
    expect(last(today)).toBe(MEMORY_SWEEP_PROMPT);
  });
});

describe('finding 2(c): an Anthropic row thinking at high effort or above keeps the floored sweep', () => {
  it('reads the registry: high-effort Anthropic rows do not pay; medium, budgeted and other providers do', () => {
    expect(sweepParityPaysOff('claude-fable-5-1')).toBe(false);
    expect(sweepParityPaysOff('claude-mythos-5')).toBe(false);
    expect(sweepParityPaysOff('claude-opus-4-8')).toBe(false);
    expect(sweepParityPaysOff('claude-opus-5-5')).toBe(true); // effort medium
    expect(sweepParityPaysOff('claude-sonnet-5-5')).toBe(true);
    expect(sweepParityPaysOff('claude-haiku-4-5')).toBe(true); // budgeted, no effort
    expect(sweepParityPaysOff('gpt-6-luna')).toBe(true); // high, but not the $50/M output row
    expect(sweepParityPaysOff('gemini-3.8-flash')).toBe(true);
  });

  const inputs = (transport: ParamsTransport, journal: Journal, loopRequest: LoopRequest) => ({
    cfg: { journal, namiOffloopSweep: true } as unknown as NativeConfig,
    taskId: 't', model: loopRequest.model, transport, system: 'S', wireTools: () => [], elision: null,
    loopRequest, loopInput: LOOP_INPUT, signal: new AbortController().signal, turnNumber: 2, clean: true,
    userTurn: { text: 'Priya runs Acme with me.' },
  });

  it('flag on, claude-fable-5-1: today\'s request (the low floor, the 2048 cap, no cache key)', async () => {
    process.env[FLAG] = 'true';
    const transport = new ParamsTransport();
    const fable = { ...LOOP_REQUEST, model: 'claude-fable-5-1' };
    await sweepCall(inputs(transport, await journalWith('Priya runs Acme with me.'), fable), new AbortController().signal);
    expect(transport.params[0]).toMatchObject({ model: 'claude-fable-5-1', system: 'S', maxTokens: 2048, reasoningEffort: 'low' });
    expect(transport.params[0].cacheKey).toBeUndefined();
  });

  it('flag on, claude-sonnet-5-5: the loop request, the parity cap, no floor', async () => {
    process.env[FLAG] = 'true';
    const transport = new ParamsTransport();
    const sonnet = { ...LOOP_REQUEST, model: 'claude-sonnet-5-5' };
    await sweepCall(inputs(transport, await journalWith('Priya runs Acme with me.'), sonnet), new AbortController().signal);
    const { history: _h, signal: _s, ...sent } = transport.params[0];
    expect(sent).toEqual({ ...sonnet, maxTokens: SWEEP_PARITY_MAX_TOKENS });
  });
});

/** The primary model is down; the configured fallback serves the round. */
class FallbackTransport extends FakeTransport {
  sent: Array<{ model: string; cacheKey: string | undefined; reasoningEffort: 'low' | undefined; maxTokens: number }> = [];
  constructor() {
    super([
      { kind: 'text', text: 'Priya is your cofounder at Acme.' },
      { kind: 'done', stopReason: 'end_turn', usage: { inputTokens: 900, outputTokens: 40 } },
    ]);
  }
  override callModel(p: CallParams) {
    this.sent.push({ model: p.model, cacheKey: p.cacheKey, reasoningEffort: p.reasoningEffort, maxTokens: p.maxTokens });
    if (p.model === 'primary-model') throw new Error('primary down');
    return super.callModel(p);
  }
  override classifyError(err: unknown): TurnOutcome {
    return { kind: 'network_error', message: err instanceof Error ? err.message : String(err), raw: { subtype: 'network_error', errors: [] } };
  }
}

describe('finding 4: the sweep rides the request the loop sent, on the model that served it', () => {
  it('a fallback that served the last round: the sweep goes to the fallback with the cache key that round carried', async () => {
    process.env[FLAG] = 'true';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const transport = new FallbackTransport();
    const journal = emptyJournal();
    const toolHost: ToolHost = {
      async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
        return { tools: [], onAuthHalt: async () => {} };
      },
    };
    const runtimeConfig = { userId: 'user-1' };
    const cfg = {
      onAttached: () => {},
      maxTurns: 4,
      transport,
      toolHost,
      journal,
      systemPrompt: 'You are the agent.',
      runtimeConfig,
      namiOffloopSweep: true,
      retry: { maxAttempts: 1, backoffMs: 0, fallbackModel: 'fallback-model' },
    } as unknown as NativeConfig;
    const taskId = journal.taskId;
    const ctx: HarnessContext<NativeConfig> = {
      taskId, sessionId: 's-fallback', cwd: '/tmp', model: 'primary-model',
      signal: new AbortController().signal, config: cfg,
    };
    const input = (async function* (): AsyncIterable<UserTurn> {
      yield { text: 'Who is Priya? She runs Acme with me.' };
    })();
    const events: HarnessEvent[] = [];
    for await (const ev of new NativeHarness().run(input, ctx)) events.push(ev);
    expect(events.find((e) => e.kind === 'turn_end')).toMatchObject({ outcome: { kind: 'completed' } });

    // primary (down), fallback (served the round), then the sweep.
    expect(transport.sent.map((s) => s.model)).toEqual(['primary-model', 'fallback-model', 'fallback-model']);
    const [, served, sweep] = transport.sent;
    expect(sweep.reasoningEffort).toBeUndefined(); // the parity request, not the floored one
    expect(sweep.cacheKey).toBe(served.cacheKey); // the shard that round wrote
    expect(served.cacheKey).toBe(mainRunCacheKey(runtimeConfig as never, taskId, 'primary-model'));
    const row = events.find((e) => e.kind === 'usage' && e.lane === 'sweep');
    expect(row).toMatchObject({ model: 'fallback-model' });
  });
});
