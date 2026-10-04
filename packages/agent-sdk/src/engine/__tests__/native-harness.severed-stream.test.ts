/**
 * Deploy-seam ladder 1 — the severed-stream re-issue (NATIVE_STREAM_SEVERED_RETRY).
 *
 * A mid-stream severance (the Anthropic-proxy restart kill, incident a7ea0665)
 * used to burn the whole turn: the throw escaped to the terminal catch as
 * model_error, no retry. Under the flag, the round catch seals the already-emitted
 * partial text EXACTLY ONCE (journal + turnBlocks), appends a journaled
 * continuation marker (user entry — role-alternation stays valid on every later
 * projection), and re-issues the round, bounded per turn.
 *
 * BILLING INVARIANT proved here: a severed round folds NO cost and journals NO
 * usage entry — the stream never reached `done`, and runOneRound's fold + usage
 * append both sit AFTER the stream drive. So the re-issue cannot double-bill by
 * construction: exactly ONE source:'round' usage entry exists after a severed +
 * re-issued round, and turn_end's cost equals the successful attempt's cost alone.
 * (Same accepted edge as the subagent settle-on-abort path: the severed attempt's
 * own partial tokens are unmeasurable — no `done` — and are never counted.)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicError } from '@anthropic-ai/sdk';
import {
  NativeHarness,
  STREAM_SEVERED_CONTINUE_MARKER,
  SEVERED_STREAM_MAX_REISSUES,
} from '../native-harness.js';
import {
  classifyAnthropicError,
  ANTHROPIC_SEVERED_STREAM_MESSAGE,
  STREAM_SEVERED_SUBTYPE,
} from '../native-termination.js';
import {
  classifyOpenAIResponsesError,
  CHAT_COMPLETIONS_SEVERED_STREAM_MESSAGE,
} from '../../transports/openai-responses-termination.js';
import {
  FakeTransport,
  type StreamEvent,
  type NormalizedUsage,
  type ProviderStream,
} from '../transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { TurnOutcome } from '../../contract/turn-outcome.js';
import type { ContentBlock } from '../../contract/blocks.js';
import type { JournalEntry, JournalPayload } from '../../contract/journal.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { NativeConfig } from '../native-config.js';
import type { ToolHost } from '../../ports/tool-host-port.js';
import type { RawToolOptions, OnAuthHalt } from '../../tools/tool-types.js';

const MODEL = 'claude-sonnet-4-6';
const FLAG = 'NATIVE_STREAM_SEVERED_RETRY';

afterEach(() => {
  delete process.env[FLAG];
});

// ── scripted transport: a round can sever (throw) after yielding events ────────

const severedError = (): AnthropicError => new AnthropicError(ANTHROPIC_SEVERED_STREAM_MESSAGE);

function doneEvent(costUsd: number, inputTokens: number, outputTokens: number): StreamEvent {
  return { kind: 'done', stopReason: 'end_turn', usage: { inputTokens, outputTokens, costUsd } as NormalizedUsage };
}

interface ScriptedRound {
  events: StreamEvent[];
  /** Thrown after the round's events are exhausted (the mid-stream severance). */
  thenThrow?: unknown;
  /** Fired just before the throw — lets a test race an interrupt against the severance. */
  onSever?: () => void;
}

class SeveredScriptTransport extends FakeTransport {
  calls = 0;
  /**
   * `classify` swaps the DIALECT under test. Default = the real Anthropic
   * classifier (the a7ea0665 arm). The chat-lane suite passes
   * classifyOpenAIResponsesError — the SAME function the live GLM/Luna,
   * DeepSeek, Fireworks and Responses transports use — so the belt is proved
   * against the real classification, never a stub.
   */
  constructor(
    private readonly rounds: ScriptedRound[],
    private readonly classify: (err: unknown) => TurnOutcome = classifyAnthropicError,
  ) {
    super([]);
  }
  override callModel(): ProviderStream {
    const round = this.rounds[Math.min(this.calls, this.rounds.length - 1)];
    this.calls += 1;
    return round;
  }
  override async *readStream(stream: ProviderStream): AsyncIterable<StreamEvent> {
    const round = stream as ScriptedRound;
    for (const ev of round.events) yield ev;
    if (round.thenThrow !== undefined) {
      round.onSever?.();
      throw round.thenThrow;
    }
  }
  /** The REAL dialect classifier — proves the severed classification end-to-end. */
  override classifyError(err: unknown): TurnOutcome {
    return this.classify(err);
  }
  override computeCostUsd(usage: NormalizedUsage): number {
    return (usage as { costUsd?: number }).costUsd ?? 0;
  }
}

class NoopToolHost implements ToolHost {
  async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
    const tool: RawToolOptions = {
      name: 'noop',
      description: 'no-op tool that keeps the turn going for a second round',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      execute: () => 'ok',
    };
    return { tools: [tool], onAuthHalt: async () => {} };
  }
}

// ── journal + ctx + drive helpers ───────────────────────────────────────────

const dir = join(tmpdir(), `severed-stream-${process.pid}`);
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const makeJournal = (taskId: string): Journal =>
  new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2026-01-01T00:00:00.000Z'),
  });

function buildCtx(
  taskId: string,
  transport: FakeTransport,
  journal: Journal,
  extra: Partial<NativeConfig> = {},
): HarnessContext<NativeConfig> {
  const cfg = {
    onAttached: () => {},
    maxTurns: 10,
    transport,
    toolHost: new NoopToolHost(),
    journal,
    abilities: [],
    // Fast severed-backoff in tests; maxAttempts:1 disables the PRE-commit retry
    // so attempt counts isolate the mid-stream (post-commit) re-issue path.
    retry: { maxAttempts: 1, backoffMs: 1 },
    ...extra,
  } as unknown as NativeConfig;
  return { taskId, sessionId: `s-${taskId}`, cwd: '/tmp', model: MODEL, signal: new AbortController().signal, config: cfg };
}

async function drive(ctx: HarnessContext<NativeConfig>): Promise<HarnessEvent[]> {
  const harness = new NativeHarness();
  const input = (async function* (): AsyncIterable<UserTurn> {
    yield { text: 'go' };
  })();
  const events: HarnessEvent[] = [];
  for await (const ev of harness.run(input, ctx)) events.push(ev);
  return events;
}

async function readEntries(j: Journal): Promise<JournalEntry[]> {
  const all: JournalEntry[] = [];
  for await (const e of j.read()) all.push(e);
  return all;
}

const turnEnd = (events: HarnessEvent[]): Extract<HarnessEvent, { kind: 'turn_end' }> => {
  const te = events.filter((e): e is Extract<HarnessEvent, { kind: 'turn_end' }> => e.kind === 'turn_end');
  expect(te.length).toBeGreaterThan(0);
  return te[te.length - 1];
};

/** Emitted text blocks (the live deltas the user sees). */
const textBlocks = (events: HarnessEvent[]): string[] =>
  events
    .filter((e): e is Extract<HarnessEvent, { kind: 'block' }> => e.kind === 'block')
    .map((e) => e.block as ContentBlock)
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text);

const usagePayloads = (entries: JournalEntry[]): Array<Extract<JournalPayload, { type: 'usage' }>> =>
  entries.filter((e) => e.payload.type === 'usage').map((e) => e.payload as Extract<JournalPayload, { type: 'usage' }>);

/** Assistant entries whose text includes `needle`. */
const assistantEntriesWith = (entries: JournalEntry[], needle: string): JournalEntry[] =>
  entries.filter(
    (e) =>
      e.payload.type === 'assistant' &&
      (e.payload as { blocks: ContentBlock[] }).blocks.some((b) => b.type === 'text' && b.text.includes(needle)),
  );

/** Every marker entry must be stamped as ENGINE-minted at the mint, so the
 *  injection screen reads a FIELD rather than guessing the loop wrote it. */
const expectAllMintedEngine = (entries: JournalEntry[]): void => {
  expect(entries.length).toBeGreaterThan(0);
  for (const e of entries) {
    expect((e.payload as { injected?: string }).injected).toBe('engine');
  }
};

/** User entries carrying the severed-continuation marker. */
const markerEntries = (entries: JournalEntry[]): JournalEntry[] =>
  entries.filter(
    (e) =>
      e.payload.type === 'user' &&
      (e.payload as { blocks: ContentBlock[] }).blocks.some(
        (b) => b.type === 'text' && b.text === STREAM_SEVERED_CONTINUE_MARKER,
      ),
  );

// ── flag ON: the re-issue ───────────────────────────────────────────────────

describe('severed stream re-issue — flag ON', () => {
  it('seals the partial once, re-issues, completes; one usage entry; no duplicate emit; no double-bill', async () => {
    process.env[FLAG] = 'true';
    const j = makeJournal('sev-happy');
    const transport = new SeveredScriptTransport([
      { events: [{ kind: 'text', text: 'Hello, wor' }], thenThrow: severedError() },
      { events: [{ kind: 'text', text: 'Continuing to the end.' }, doneEvent(0.01, 50, 5)] },
    ]);
    const events = await drive(buildCtx('sev-happy', transport, j));

    // The turn completed — the severance did not burn it.
    const te = turnEnd(events);
    expect(te.outcome.kind).toBe('completed');
    expect(transport.calls).toBe(2);

    // No duplicate user-visible emit: the partial streamed exactly once; the
    // engine never re-emits it on the re-issue.
    const texts = textBlocks(events);
    expect(texts.filter((t) => t === 'Hello, wor')).toHaveLength(1);
    expect(texts.filter((t) => t === 'Continuing to the end.')).toHaveLength(1);

    // The partial is durable EXACTLY ONCE, followed by the journaled continuation marker.
    const entries = await readEntries(j);
    expect(assistantEntriesWith(entries, 'Hello, wor')).toHaveLength(1);
    expect(markerEntries(entries)).toHaveLength(1);
    expectAllMintedEngine(markerEntries(entries));
    expect(assistantEntriesWith(entries, 'Continuing to the end.')).toHaveLength(1);

    // BILLING: the severed attempt journaled NO usage (never reached `done`);
    // exactly one source:'round' usage entry, carrying only the successful cost.
    const usage = usagePayloads(entries);
    expect(usage).toHaveLength(1);
    expect(usage[0].raw).toMatchObject({ costUsd: 0.01, source: 'round' });
    if (te.outcome.kind === 'completed') expect(te.outcome.costUsd).toBeCloseTo(0.01, 9);
  });

  it('a severance with NO partial output re-issues with no seal and no marker (clean re-ask)', async () => {
    process.env[FLAG] = 'true';
    const j = makeJournal('sev-nopartial');
    const transport = new SeveredScriptTransport([
      { events: [], thenThrow: severedError() },
      { events: [{ kind: 'text', text: 'fresh answer' }, doneEvent(0.02, 40, 4)] },
    ]);
    const events = await drive(buildCtx('sev-nopartial', transport, j));

    expect(turnEnd(events).outcome.kind).toBe('completed');
    expect(transport.calls).toBe(2);
    const entries = await readEntries(j);
    expect(markerEntries(entries)).toHaveLength(0);
    expect(usagePayloads(entries)).toHaveLength(1);
  });

  it('respects the re-issue cap: after the last re-issue severs, the turn ends network_error/stream_severed', async () => {
    process.env[FLAG] = 'true';
    const j = makeJournal('sev-cap');
    const sever = (n: number): ScriptedRound => ({
      events: [{ kind: 'text', text: `partial ${n}` }],
      thenThrow: severedError(),
    });
    const transport = new SeveredScriptTransport([sever(0), sever(1), sever(2)]);
    const events = await drive(buildCtx('sev-cap', transport, j));

    // 1 original + SEVERED_STREAM_MAX_REISSUES re-issues, then terminal.
    expect(transport.calls).toBe(1 + SEVERED_STREAM_MAX_REISSUES);
    const te = turnEnd(events);
    expect(te.outcome.kind).toBe('network_error');
    expect(te.outcome.raw.subtype).toBe(STREAM_SEVERED_SUBTYPE);

    // Each re-issued severance sealed its partial + marker; the FINAL severance
    // seals via the terminal catch (no marker). Nothing ever billed.
    const entries = await readEntries(j);
    expect(markerEntries(entries)).toHaveLength(SEVERED_STREAM_MAX_REISSUES);
    expect(usagePayloads(entries)).toHaveLength(0);
  });

  it('an interrupt that raced the severance WINS: no re-issue, terminal user_aborted', async () => {
    process.env[FLAG] = 'true';
    const controller = new AbortController();
    const j = makeJournal('sev-abort');
    const transport = new SeveredScriptTransport([
      {
        events: [{ kind: 'text', text: 'partial before abort' }],
        thenThrow: severedError(),
        onSever: () => controller.abort(),
      },
      { events: [{ kind: 'text', text: 'must never run' }, doneEvent(0.01, 1, 1)] },
    ]);
    const events = await drive(
      buildCtx('sev-abort', transport, j, { signal: controller.signal } as Partial<NativeConfig>),
    );

    expect(transport.calls).toBe(1); // never re-issued
    expect(turnEnd(events).outcome.kind).toBe('user_aborted');
    expect(markerEntries(await readEntries(j))).toHaveLength(0);
  });

  it('flag ON leaves a clean (never-severed) turn unchanged vs flag OFF (base behavior axis)', async () => {
    const script = (): ScriptedRound[] => [
      { events: [{ kind: 'tool_use', toolUse: { id: 'tu-0', name: 'noop', input: {} } }, doneEvent(0.03, 100, 20)] },
      { events: [{ kind: 'text', text: 'done' }, doneEvent(0.01, 50, 5)] },
    ];

    process.env[FLAG] = 'true';
    const jOn = makeJournal('clean-on');
    const tOn = new SeveredScriptTransport(script());
    const onEvents = await drive(buildCtx('clean-on', tOn, jOn));

    delete process.env[FLAG];
    const jOff = makeJournal('clean-off');
    const tOff = new SeveredScriptTransport(script());
    const offEvents = await drive(buildCtx('clean-off', tOff, jOff));

    // Identical journal payload sequences and identical terminal outcome.
    const payloadShape = (entries: JournalEntry[]): unknown[] => entries.map((e) => e.payload);
    expect(payloadShape(await readEntries(jOn))).toEqual(payloadShape(await readEntries(jOff)));
    expect(turnEnd(onEvents).outcome.kind).toBe('completed');
    expect(turnEnd(onEvents).outcome).toMatchObject({ kind: turnEnd(offEvents).outcome.kind });
    expect(tOn.calls).toBe(tOff.calls);
  });

  it('a PRE-commit severance (zero events, retry budget available) retries in place via startStreamWithRetry', async () => {
    process.env[FLAG] = 'true';
    const j = makeJournal('sev-precommit');
    const transport = new SeveredScriptTransport([
      { events: [], thenThrow: severedError() },
      { events: [{ kind: 'text', text: 'recovered' }, doneEvent(0.01, 10, 2)] },
    ]);
    // maxAttempts 2 → the pre-commit retry path is live (severed classifies as
    // the RETRYABLE network_error kind, so startStreamWithRetry handles it
    // before the round ever commits — no seal, no marker).
    const events = await drive(
      buildCtx('sev-precommit', transport, j, { retry: { maxAttempts: 2, backoffMs: 1 } } as Partial<NativeConfig>),
    );

    expect(turnEnd(events).outcome.kind).toBe('completed');
    expect(transport.calls).toBe(2);
    expect(markerEntries(await readEntries(j))).toHaveLength(0);
  });
});

// ── flag OFF: byte-identical to today ───────────────────────────────────────

describe('severed stream — flag OFF (byte-identical to today)', () => {
  it('a mid-stream severance still burns the turn as model_error: one attempt, no marker, no usage', async () => {
    delete process.env[FLAG];
    const j = makeJournal('sev-off');
    const transport = new SeveredScriptTransport([
      { events: [{ kind: 'text', text: 'Hello, wor' }], thenThrow: severedError() },
      { events: [{ kind: 'text', text: 'must never run' }, doneEvent(0.01, 1, 1)] },
    ]);
    const events = await drive(buildCtx('sev-off', transport, j));

    expect(transport.calls).toBe(1); // no re-issue of any kind
    const te = turnEnd(events);
    expect(te.outcome.kind).toBe('model_error');

    const entries = await readEntries(j);
    expect(markerEntries(entries)).toHaveLength(0);
    expect(usagePayloads(entries)).toHaveLength(0);
    // Today's terminal seal still preserves the partial (existing behavior).
    expect(assistantEntriesWith(entries, 'Hello, wor')).toHaveLength(1);
  });
});

// ── the CHAT-COMPLETIONS lane (GLM/Luna, DeepSeek, Fireworks, Kimi) ──────────
//
// The belt shipped keyed on `raw.subtype === 'stream_severed'`, a subtype ONLY
// classifyAnthropicError ever stamped. Every OpenAI-dialect lane therefore died
// permanently on a mid-turn transport drop: staging task 47faf57f (2026-08-20
// 13:30:04Z) streamed healthily for two rounds, settled one X tool call, then
// lost its stream mid-round and burned the turn `network_error` with ZERO
// assistant text. These pin the belt over the SAME classifier those lanes run.

/** The undici shape a real mid-stream socket death arrives in. */
function undiciSocketDeath(): Error {
  const cause = new Error('other side closed') as Error & { code: string };
  cause.code = 'UND_ERR_SOCKET';
  return new TypeError('terminated', { cause });
}

/** A severance with NO structural signal — only the classifier's wording net
 *  recognizes it, so it classifies network_error with subtype 'network'. */
const wordingOnlySeverance = (): Error => new Error('fetch failed');

const chatTransport = (rounds: ScriptedRound[]): SeveredScriptTransport =>
  new SeveredScriptTransport(rounds, classifyOpenAIResponsesError);

describe('severed stream re-issue — the chat-completions lane (flag ON)', () => {
  it('re-issues an undici mid-stream socket death: seals the partial once, completes, bills once', async () => {
    process.env[FLAG] = 'true';
    const j = makeJournal('chat-sev-socket');
    const transport = chatTransport([
      { events: [{ kind: 'text', text: 'Searching X for ' }], thenThrow: undiciSocketDeath() },
      { events: [{ kind: 'text', text: 'the latest posts.' }, doneEvent(0.014, 60, 6)] },
    ]);
    const events = await drive(buildCtx('chat-sev-socket', transport, j));

    const te = turnEnd(events);
    expect(te.outcome.kind).toBe('completed');
    expect(transport.calls).toBe(2);

    const texts = textBlocks(events);
    expect(texts.filter((t) => t === 'Searching X for ')).toHaveLength(1);
    expect(texts.filter((t) => t === 'the latest posts.')).toHaveLength(1);

    const entries = await readEntries(j);
    expect(assistantEntriesWith(entries, 'Searching X for ')).toHaveLength(1);
    expect(markerEntries(entries)).toHaveLength(1);

    // BILLING: the severed attempt never reached `done`, so it folded nothing —
    // exactly one usage entry, carrying only the successful attempt's cost.
    const usage = usagePayloads(entries);
    expect(usage).toHaveLength(1);
    expect(usage[0].raw).toMatchObject({ costUsd: 0.014, source: 'round' });
    if (te.outcome.kind === 'completed') expect(te.outcome.costUsd).toBeCloseTo(0.014, 9);
  });

  it("re-issues the transport's OWN premature-end sentinel (the SSE ended with no terminal chunk)", async () => {
    process.env[FLAG] = 'true';
    const j = makeJournal('chat-sev-sentinel');
    const transport = chatTransport([
      { events: [{ kind: 'text', text: 'partial' }], thenThrow: new Error(CHAT_COMPLETIONS_SEVERED_STREAM_MESSAGE) },
      { events: [{ kind: 'text', text: 'recovered' }, doneEvent(0.01, 20, 3)] },
    ]);
    const events = await drive(buildCtx('chat-sev-sentinel', transport, j));

    expect(turnEnd(events).outcome.kind).toBe('completed');
    expect(transport.calls).toBe(2);
    expect(markerEntries(await readEntries(j))).toHaveLength(1);
  });

  it('THE INCIDENT: a severance on the CONTINUATION round after a settled tool call re-issues, and the turn completes with text', async () => {
    process.env[FLAG] = 'true';
    const j = makeJournal('chat-sev-continuation');
    const transport = chatTransport([
      // Round 1 — a clean, fully-billed tool round (the X search that DID land).
      { events: [{ kind: 'tool_use', toolUse: { id: 'tu-x', name: 'noop', input: {} } }, doneEvent(0.02, 100, 10)] },
      // Round 2 — the continuation stream dies mid-flight. This was terminal.
      { events: [], thenThrow: undiciSocketDeath() },
      { events: [{ kind: 'text', text: 'Here are the posts I found.' }, doneEvent(0.01, 40, 8)] },
    ]);
    const events = await drive(buildCtx('chat-sev-continuation', transport, j));

    const te = turnEnd(events);
    expect(te.outcome.kind).toBe('completed');
    expect(transport.calls).toBe(3);
    // The user gets REAL text instead of a silent, textless failed turn.
    expect(textBlocks(events)).toContain('Here are the posts I found.');
    // The settled tool round's cost survives; the severed round billed nothing.
    const usage = usagePayloads(await readEntries(j));
    expect(usage).toHaveLength(2);
    expect(usage.reduce((s, u) => s + ((u.raw as { costUsd?: number }).costUsd ?? 0), 0)).toBeCloseTo(0.03, 9);
  });

  it('re-issues a severance the classifier only recognizes by WORDING (kind, not subtype, is the gate)', async () => {
    process.env[FLAG] = 'true';
    const j = makeJournal('chat-sev-wording');
    // This classifies network_error with subtype 'network' — NOT 'stream_severed'.
    // The belt must still fire: the transport-neutral KIND is the re-issue key.
    expect(classifyOpenAIResponsesError(wordingOnlySeverance()).raw.subtype).toBe('network');
    const transport = chatTransport([
      { events: [{ kind: 'text', text: 'half' }], thenThrow: wordingOnlySeverance() },
      { events: [{ kind: 'text', text: 'whole' }, doneEvent(0.01, 10, 2)] },
    ]);
    const events = await drive(buildCtx('chat-sev-wording', transport, j));

    expect(turnEnd(events).outcome.kind).toBe('completed');
    expect(transport.calls).toBe(2);
  });

  it('respects the SAME per-turn cap and terminates network_error when the severance persists', async () => {
    process.env[FLAG] = 'true';
    const j = makeJournal('chat-sev-cap');
    const sever = (n: number): ScriptedRound => ({
      events: [{ kind: 'text', text: `partial ${n}` }],
      thenThrow: undiciSocketDeath(),
    });
    const transport = chatTransport([sever(0), sever(1), sever(2)]);
    const events = await drive(buildCtx('chat-sev-cap', transport, j));

    expect(transport.calls).toBe(1 + SEVERED_STREAM_MAX_REISSUES);
    const te = turnEnd(events);
    expect(te.outcome.kind).toBe('network_error');
    expect(te.outcome.raw.subtype).toBe(STREAM_SEVERED_SUBTYPE);
    expect(usagePayloads(await readEntries(j))).toHaveLength(0);
  });

  it('an interrupt that raced the severance WINS on this lane too', async () => {
    process.env[FLAG] = 'true';
    const controller = new AbortController();
    const j = makeJournal('chat-sev-abort');
    const transport = chatTransport([
      {
        events: [{ kind: 'text', text: 'partial before abort' }],
        thenThrow: undiciSocketDeath(),
        onSever: () => controller.abort(),
      },
      { events: [{ kind: 'text', text: 'must never run' }, doneEvent(0.01, 1, 1)] },
    ]);
    const events = await drive(
      buildCtx('chat-sev-abort', transport, j, { signal: controller.signal } as Partial<NativeConfig>),
    );

    expect(transport.calls).toBe(1);
    expect(turnEnd(events).outcome.kind).toBe('user_aborted');
    expect(markerEntries(await readEntries(j))).toHaveLength(0);
  });

  it('a TOOL-BATCH throw is never a severance (streaming phase only) — no re-issue', async () => {
    process.env[FLAG] = 'true';
    const j = makeJournal('chat-sev-toolphase');
    // The throw lands with events already drained INCLUDING `done`, i.e. the
    // round committed; a later in-batch failure must not look like a severance.
    const transport = chatTransport([
      { events: [{ kind: 'text', text: 'ok' }, doneEvent(0.01, 10, 2)] },
      { events: [], thenThrow: undiciSocketDeath() },
      { events: [{ kind: 'text', text: 'never reached by a batch throw' }, doneEvent(0.01, 1, 1)] },
    ]);
    const events = await drive(buildCtx('chat-sev-toolphase', transport, j));
    // Round 1 has no tool calls, so the turn ends there — the guard under test is
    // simply that a clean round is untouched by the belt.
    expect(turnEnd(events).outcome.kind).toBe('completed');
    expect(transport.calls).toBe(1);
  });
});

describe('severed stream — the chat-completions lane, flag OFF (byte-identical to today)', () => {
  it('a mid-stream socket death still burns the turn: one attempt, no marker, no usage', async () => {
    delete process.env[FLAG];
    const j = makeJournal('chat-sev-off');
    const transport = chatTransport([
      { events: [{ kind: 'text', text: 'Searching X for ' }], thenThrow: undiciSocketDeath() },
      { events: [{ kind: 'text', text: 'must never run' }, doneEvent(0.01, 1, 1)] },
    ]);
    const events = await drive(buildCtx('chat-sev-off', transport, j));

    expect(transport.calls).toBe(1);
    // Today's wording net already classified this network_error; with the flag
    // OFF the engine must NOT act on it.
    expect(turnEnd(events).outcome.kind).toBe('network_error');
    const entries = await readEntries(j);
    expect(markerEntries(entries)).toHaveLength(0);
    expect(usagePayloads(entries)).toHaveLength(0);
  });

  it("the transport's premature-end sentinel stays a terminal model_error", async () => {
    delete process.env[FLAG];
    const j = makeJournal('chat-sev-off-sentinel');
    const transport = chatTransport([
      { events: [{ kind: 'text', text: 'partial' }], thenThrow: new Error(CHAT_COMPLETIONS_SEVERED_STREAM_MESSAGE) },
      { events: [{ kind: 'text', text: 'must never run' }, doneEvent(0.01, 1, 1)] },
    ]);
    const events = await drive(buildCtx('chat-sev-off-sentinel', transport, j));

    expect(transport.calls).toBe(1);
    expect(turnEnd(events).outcome.kind).toBe('model_error');
  });
});

// ── mid-stream RETRYABLE failures after partial content (H9 W2 Task 4b) ──────
//
// startStreamWithRetry's boundary is callModel + the FIRST event, so an in-stream
// `overloaded_error` frame arriving AFTER partial content bypasses it and reaches
// the belt — whose gate admitted `network_error` only. After Wave 1 C the frame
// classifies model_unavailable (a RETRYABLE kind), yet the turn still burned:
// a better label on the same dead turn. The widened gate admits any
// RETRYABLE_KINDS failure once the round has partial output (the same leak-free
// construction: no `done` was reached, so nothing folded or billed), keeps the
// same per-turn bound, and journals the same continuation marker. The replay
// rail cannot place a fault after partial content yet (its README lists the
// shape under "not replayable yet"), so this is the harness-level proof over the
// REAL classifier and the exact frame the future 03 --after-text fixture variant
// will throw (see error-authority.conformance.test.ts AFTER_PARTIAL_OVERLOAD_FRAME).

import { APIError as AnthropicAPIError } from '@anthropic-ai/sdk';

/** Byte-for-byte the SDK's in-stream `event: error` overload frame (no HTTP status). */
const overloadFrame = (): AnthropicAPIError =>
  new AnthropicAPIError(
    undefined,
    { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    undefined,
    new Headers(),
    'overloaded_error' as never,
  );

describe('mid-stream overload after partial content — flag ON (Task 4b)', () => {
  it('re-issues instead of burning the turn: seals the partial once, journals the marker, bills once', async () => {
    process.env[FLAG] = 'true';
    const j = makeJournal('ms-overload');
    const transport = new SeveredScriptTransport([
      { events: [{ kind: 'text', text: 'Hello, wor' }], thenThrow: overloadFrame() },
      { events: [{ kind: 'text', text: 'Continuing to the end.' }, doneEvent(0.01, 50, 5)] },
    ]);
    const events = await drive(buildCtx('ms-overload', transport, j));

    const te = turnEnd(events);
    expect(te.outcome.kind).toBe('completed');
    expect(transport.calls).toBe(2);

    const texts = textBlocks(events);
    expect(texts.filter((t) => t === 'Hello, wor')).toHaveLength(1);
    expect(texts.filter((t) => t === 'Continuing to the end.')).toHaveLength(1);

    const entries = await readEntries(j);
    expect(assistantEntriesWith(entries, 'Hello, wor')).toHaveLength(1);
    expect(markerEntries(entries)).toHaveLength(1);
    const usage = usagePayloads(entries);
    expect(usage).toHaveLength(1);
    expect(usage[0].raw).toMatchObject({ costUsd: 0.01, source: 'round' });
  });

  it('a PRE-commit rate limit stays OUT of the belt: no partial output, terminal rate_limited', async () => {
    process.env[FLAG] = 'true';
    const j = makeJournal('ms-precommit-429');
    // Zero events → the throw fires on the FIRST read, inside startStreamWithRetry's
    // boundary; maxAttempts 1 exhausts it immediately. Rate limiting owns its own
    // retry budget — the belt must not add re-asks on top of it.
    const transport = new SeveredScriptTransport([
      { events: [], thenThrow: Object.assign(new Error('slow down'), { status: 429 }) },
      { events: [{ kind: 'text', text: 'must never run' }, doneEvent(0.01, 1, 1)] },
    ]);
    const events = await drive(buildCtx('ms-precommit-429', transport, j));

    expect(transport.calls).toBe(1);
    expect(turnEnd(events).outcome.kind).toBe('rate_limited');
    expect(markerEntries(await readEntries(j))).toHaveLength(0);
  });

  it('respects the SAME per-turn cap: persistent mid-stream overload ends model_unavailable', async () => {
    process.env[FLAG] = 'true';
    const j = makeJournal('ms-cap');
    const sever = (n: number): ScriptedRound => ({
      events: [{ kind: 'text', text: `partial ${n}` }],
      thenThrow: overloadFrame(),
    });
    const transport = new SeveredScriptTransport([sever(0), sever(1), sever(2)]);
    const events = await drive(buildCtx('ms-cap', transport, j));

    expect(transport.calls).toBe(1 + SEVERED_STREAM_MAX_REISSUES);
    expect(turnEnd(events).outcome.kind).toBe('model_unavailable');
    expect(markerEntries(await readEntries(j))).toHaveLength(SEVERED_STREAM_MAX_REISSUES);
    expect(usagePayloads(await readEntries(j))).toHaveLength(0);
  });
});

describe('mid-stream overload after partial content — flag OFF (byte-identical to today)', () => {
  it('still burns the turn terminal model_unavailable: one attempt, no marker, no usage', async () => {
    delete process.env[FLAG];
    const j = makeJournal('ms-off');
    const transport = new SeveredScriptTransport([
      { events: [{ kind: 'text', text: 'Hello, wor' }], thenThrow: overloadFrame() },
      { events: [{ kind: 'text', text: 'must never run' }, doneEvent(0.01, 1, 1)] },
    ]);
    const events = await drive(buildCtx('ms-off', transport, j));

    expect(transport.calls).toBe(1);
    expect(turnEnd(events).outcome.kind).toBe('model_unavailable');
    const entries = await readEntries(j);
    expect(markerEntries(entries)).toHaveLength(0);
    expect(usagePayloads(entries)).toHaveLength(0);
    expect(assistantEntriesWith(entries, 'Hello, wor')).toHaveLength(1);
  });
});
