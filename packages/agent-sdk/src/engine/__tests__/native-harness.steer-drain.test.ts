/**
 * P3 STEER V2 (Task 6) — the interrupt-with-queued-message drain CONTINUES the
 * same turn (inject, don't restart).
 *
 * The engine consults `cfg.drainSteerText` at the tool-round boundary (before
 * `pollSteer`, after the round's tool_results settle): text arriving there is
 * appended as a `[User steered mid-task]: …` user entry and the NEXT model call
 * of the SAME turn sees it — exactly ONE turn_end, no re-billed rounds (the
 * turn's cumulative keeps rising monotonically; a restart would re-bill round 1
 * as a fresh turn). Aborted-signal and absent-seam paths stay byte-identical.
 */
import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APIUserAbortError as OpenAIAPIUserAbortError } from 'openai';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { NativeConfig } from '../native-config.js';
import type { ToolHost } from '../../ports/tool-host-port.js';
import type { RawToolOptions, OnAuthHalt } from '../../tools/tool-types.js';

// ── scripted transport (captures each callModel's history snapshot) ───────────

function usage(costUsd: number): NormalizedUsage {
  return { inputTokens: 10, outputTokens: 5, costUsd } as NormalizedUsage;
}

/** A scripted round that ABORTS mid-stream: yields `partial`, then fires
 *  `trigger` (the test's interrupt — e.g. a live-scope swap+abort) and throws
 *  the same AbortError shape a real provider stream throws on an aborted signal. */
interface AbortRound {
  abortMidStream: StreamEvent[];
  trigger: () => void;
  /** Error name the killed stream throws. Defaults to the platform 'AbortError'.
   *  NOTE: the real Anthropic/OpenAI SDK wrappers do NOT set `.name` — a real
   *  APIUserAbortError reports `.name === 'Error'` — so this field only builds
   *  duck-typed named shapes; use `error` below to throw a REAL wrapper. */
  errorName?: string;
  /** Throw this EXACT object instead of building one from `errorName` — lets a
   *  test throw a REAL SDK APIUserAbortError instance (`.name === 'Error'`),
   *  the shape hand-rolled named mocks cannot reproduce. */
  error?: Error;
}
function isAbortRound(v: unknown): v is AbortRound {
  return typeof v === 'object' && v !== null && 'abortMidStream' in v;
}

class ScriptTransport extends FakeTransport {
  private idx = 0;
  /** Deep snapshot of the request history at every callModel, in call order. */
  readonly requestHistories: unknown[][] = [];
  /** Optional per-call hook (0-based round index) — lets a test arm a steer
   *  DURING a specific round (simulating the ESC arriving mid-round). */
  onCallModel?: (idx: number) => void;
  constructor(private readonly rounds: Array<StreamEvent[] | AbortRound>) {
    super([]);
  }
  override callModel(p: { history: unknown }): StreamEvent[] | AbortRound {
    this.requestHistories.push(JSON.parse(JSON.stringify(p.history)) as unknown[]);
    const round = this.rounds[Math.min(this.idx, this.rounds.length - 1)];
    this.onCallModel?.(this.idx);
    this.idx += 1;
    return round;
  }
  override async *readStream(stream: unknown): AsyncIterable<StreamEvent> {
    if (isAbortRound(stream)) {
      for (const ev of stream.abortMidStream) yield ev;
      stream.trigger();
      if (stream.error) throw stream.error;
      const err = new Error('Request was aborted.');
      err.name = stream.errorName ?? 'AbortError';
      throw err;
    }
    yield* super.readStream(stream);
  }
  override computeCostUsd(u: NormalizedUsage): number {
    return (u as { costUsd?: number }).costUsd ?? 0;
  }
}

const STEER_TEXT = 'wait — use the staging database instead';
const STEER_MARKER = `[User steered mid-task]: ${STEER_TEXT}`;

function twoRoundScript(): StreamEvent[][] {
  return [
    [
      { kind: 'tool_use', toolUse: { id: 'tu-1', name: 'noop', input: {} } },
      { kind: 'done', stopReason: 'tool_use', usage: usage(0.01) },
    ],
    [
      { kind: 'text', text: 'done, using staging' },
      { kind: 'done', stopReason: 'end_turn', usage: usage(0.02) },
    ],
  ];
}

function noopToolHost(): ToolHost {
  return {
    async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
      const noop: RawToolOptions = {
        name: 'noop',
        description: 'resolves immediately',
        parameters: { type: 'object', properties: {}, additionalProperties: true },
        execute: async () => 'ok',
      };
      return { tools: [noop], onAuthHalt: async () => {} };
    },
  };
}

function makeJournal(taskId: string): Journal {
  const path = join(
    tmpdir(),
    `steer-drain-${process.pid}-${Math.random().toString(36).slice(2)}`,
    `${taskId}.jsonl`,
  );
  return new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(path),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2024-01-01T00:00:00.000Z'),
  });
}

function buildCtx(opts: {
  taskId: string;
  transport: FakeTransport;
  drainSteerText: () => string | null;
  journal?: Journal;
  toolHost?: ToolHost;
  drainTimeoutMs?: number;
  /** LIVE run-scope read (the sandbox's round-abort getter): every cfg.signal
   *  read sees the CURRENT scope, while in-flight work keeps the one it captured. */
  liveSignal?: () => AbortSignal;
  signal?: AbortSignal;
}): HarnessContext<NativeConfig> {
  const cfg = {
    onAttached: () => {},
    maxTurns: 10,
    transport: opts.transport,
    toolHost: opts.toolHost ?? noopToolHost(),
    drainSteerText: opts.drainSteerText,
    ...(opts.journal ? { journal: opts.journal } : {}),
    ...(opts.drainTimeoutMs !== undefined ? { drainTimeoutMs: opts.drainTimeoutMs } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  } as unknown as NativeConfig;
  if (opts.liveSignal) Object.defineProperty(cfg, 'signal', { get: opts.liveSignal });
  return {
    taskId: opts.taskId,
    sessionId: 's-steer',
    cwd: '/tmp',
    model: 'fake-model',
    signal: new AbortController().signal,
    config: cfg,
  };
}

async function runOneUserTurn(ctx: HarnessContext<NativeConfig>): Promise<HarnessEvent[]> {
  const input = (async function* (): AsyncIterable<UserTurn> {
    yield { text: 'run the migration' };
  })();
  const events: HarnessEvent[] = [];
  for await (const ev of new NativeHarness().run(input, ctx)) events.push(ev);
  return events;
}

function turnEnds(events: HarnessEvent[]): Array<Extract<HarnessEvent, { kind: 'turn_end' }>> {
  return events.filter((e): e is Extract<HarnessEvent, { kind: 'turn_end' }> => e.kind === 'turn_end');
}

describe('P3 STEER V2 — drainSteerText continues the same turn', () => {
  it('injects the marker after round-1 tool_result and finishes as ONE turn (no restart, monotonic billing)', async () => {
    // Armed DURING round 1 (the ESC arrives while the model streams): the drain
    // delivers at the boundary between round 1 and round 2.
    let armed = false;
    let drains = 0;
    const drainSteerText = (): string | null => {
      if (!armed) return null;
      armed = false;
      drains += 1;
      return STEER_TEXT;
    };
    const transport = new ScriptTransport(twoRoundScript());
    transport.onCallModel = (idx): void => {
      if (idx === 0) armed = true;
    };
    // NO journal → the marker folds into the in-memory history (pushUser), so the
    // round-2 request body ordering is directly observable on the captured history.
    const events = await runOneUserTurn(buildCtx({ taskId: 't-steer-mem', transport, drainSteerText }));

    // The steer CONTINUED the turn: exactly one terminal turn_end, drained once.
    const ends = turnEnds(events);
    expect(ends.length).toBe(1);
    expect(ends[0].outcome.kind).toBe('completed');
    expect(drains).toBe(1);

    // No re-billed rounds: the single turn's cumulative carries BOTH rounds
    // (a retire-and-redrive would have finalized round 1 as its own turn and
    // reset the cumulative for a fresh one).
    expect(ends[0].billing?.cumulativeCostUsd).toBeCloseTo(0.03, 9);

    // The round-2 request body carries the marker AFTER round-1's tool_result.
    expect(transport.requestHistories.length).toBe(2);
    const round2 = transport.requestHistories[1] as Array<{ role: string; text?: string; toolUseId?: string }>;
    const toolResultIdx = round2.findIndex((m) => m.role === 'tool' && m.toolUseId === 'tu-1');
    const steerIdx = round2.findIndex((m) => m.role === 'user' && m.text === STEER_MARKER);
    expect(toolResultIdx).toBeGreaterThanOrEqual(0);
    expect(steerIdx).toBeGreaterThan(toolResultIdx);
  });

  it('journal path: the steer lands as a durable marker-tagged user entry (replay-visible)', async () => {
    let armed = true;
    const drainSteerText = (): string | null => {
      if (!armed) return null;
      armed = false;
      return STEER_TEXT;
    };
    const journal = makeJournal('t-steer-journal');
    const transport = new ScriptTransport(twoRoundScript());
    const events = await runOneUserTurn(
      buildCtx({ taskId: 't-steer-journal', transport, drainSteerText, journal }),
    );

    expect(turnEnds(events).length).toBe(1);
    const entries: JournalEntry[] = [];
    for await (const e of journal.read()) entries.push(e);
    const userTexts = entries
      .filter((e) => e.payload.type === 'user')
      .map((e) => {
        const blocks = (e.payload as { blocks?: Array<{ type: string; text?: string }> }).blocks ?? [];
        return blocks.find((b) => b.type === 'text')?.text ?? '';
      });
    // The original user turn AND the steer marker are both durable entries.
    expect(userTexts).toContain('run the migration');
    expect(userTexts).toContain(STEER_MARKER);
  });

  it('null drain (not armed) is byte-identical: no marker anywhere, one turn_end', async () => {
    const transport = new ScriptTransport(twoRoundScript());
    const events = await runOneUserTurn(
      buildCtx({ taskId: 't-steer-null', transport, drainSteerText: () => null }),
    );
    expect(turnEnds(events).length).toBe(1);
    for (const history of transport.requestHistories) {
      const hit = (history as Array<{ text?: string }>).some(
        (m) => typeof m.text === 'string' && m.text.startsWith('[User steered mid-task]'),
      );
      expect(hit).toBe(false);
    }
  });

  it('round-HEAD consult: a drain armed while NO round is in flight lands before the next model call (no abort needed)', async () => {
    // The between-rounds gap: an ESC+queue landing while the engine is between
    // rounds has nothing to abort — the head consult must still inject the steer
    // BEFORE the next model call instead of waiting a full round.
    let armed = true;
    let drains = 0;
    const drainSteerText = (): string | null => {
      if (!armed) return null;
      armed = false;
      drains += 1;
      return STEER_TEXT;
    };
    const transport = new ScriptTransport(twoRoundScript());
    const events = await runOneUserTurn(buildCtx({ taskId: 't-steer-head', transport, drainSteerText }));

    expect(turnEnds(events).length).toBe(1);
    expect(drains).toBe(1);
    // The marker rides the FIRST request (injected at the round head, pre-call).
    const round1 = transport.requestHistories[0] as Array<{ role: string; text?: string }>;
    expect(round1.some((m) => m.role === 'user' && m.text === STEER_MARKER)).toBe(true);
  });
});

// ── P3.5 round-abort — interrupt + queued message kills the in-flight round ──
//
// The sandbox's steer-interrupt aborts JUST the current round: it swaps the live
// run scope (cfg.signal reads fresh) and aborts the OLD scope that all in-flight
// work captured. The engine treats the resulting AbortError — with the LIVE
// signal un-aborted and a drainable steer — as "boundary now": seal the aborted
// round (partial text + orphan-heal), inject the steer, and CONTINUE the same
// turn. A plain interrupt (signal stays aborted) is byte-identical to today.

function liveScope(): { get: () => AbortSignal; abortRound: () => void } {
  let live = new AbortController();
  return {
    get: () => live.signal,
    // Swap FIRST so a racing engine read sees the fresh scope, then kill the old.
    abortRound: (): void => {
      const old = live;
      live = new AbortController();
      old.abort();
    },
  };
}

function hangingToolHost(onExecute: () => void): ToolHost {
  return {
    async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
      const hang: RawToolOptions = {
        name: 'hang',
        description: 'never resolves (the abandoned-dispatch case)',
        parameters: { type: 'object', properties: {}, additionalProperties: true },
        execute: (): Promise<string> => {
          onExecute();
          return new Promise<string>(() => {});
        },
      };
      return { tools: [hang], onAuthHalt: async () => {} };
    },
  };
}

async function journalRows(journal: Journal): Promise<Array<{ type: string; text: string }>> {
  const rows: Array<{ type: string; text: string }> = [];
  for await (const e of journal.read()) {
    const payload = e.payload as { type: string; blocks?: Array<{ type: string; text?: string }> };
    rows.push({
      type: payload.type,
      text: (payload.blocks ?? []).map((b) => b.text ?? '').join(''),
    });
  }
  return rows;
}

describe('P3.5 round-abort — steer-interrupt aborts the round, the SAME turn continues', () => {
  it('mid-STREAM abort with an armed drain: seals the partial round, injects the steer, one completed turn', async () => {
    const scope = liveScope();
    let armed = false;
    let drains = 0;
    const drainSteerText = (): string | null => {
      if (!armed) return null;
      armed = false;
      drains += 1;
      return STEER_TEXT;
    };
    const journal = makeJournal('t-round-abort-stream');
    const transport = new ScriptTransport([
      {
        // The founder repro: deep in a model stream, no tool boundary in sight.
        abortMidStream: [{ kind: 'text', text: 'partial thoughts' }],
        trigger: (): void => {
          armed = true;
          scope.abortRound();
        },
      },
      [
        { kind: 'text', text: 'done, using staging' },
        { kind: 'done', stopReason: 'end_turn', usage: usage(0.02) },
      ],
    ]);
    const events = await runOneUserTurn(
      buildCtx({ taskId: 't-round-abort-stream', transport, drainSteerText, journal, liveSignal: scope.get }),
    );

    // ONE terminal turn_end, COMPLETED — no user_aborted, no restart.
    const ends = turnEnds(events);
    expect(ends.length).toBe(1);
    expect(ends[0].outcome.kind).toBe('completed');
    expect(drains).toBe(1);
    // The continuation made a SECOND model call in the same turn.
    expect(transport.requestHistories.length).toBe(2);
    // Billing: the aborted round folded nothing (its `done` never arrived —
    // existing abort semantics); the continuation round billed normally.
    expect(ends[0].billing?.cumulativeCostUsd).toBeCloseTo(0.02, 9);
    // Journal: the aborted round's partial text is SEALED, and the steer marker
    // lands AFTER it — the next model call sees partial + steer in order.
    const rows = await journalRows(journal);
    const sealIdx = rows.findIndex((r) => r.type === 'assistant' && r.text.includes('partial thoughts'));
    const steerIdx = rows.findIndex((r) => r.type === 'user' && r.text === STEER_MARKER);
    expect(sealIdx).toBeGreaterThanOrEqual(0);
    expect(steerIdx).toBeGreaterThan(sealIdx);
  });

  it("real-SDK abort shape ('APIUserAbortError'): the round-catch still steers the same turn (drill-caught miss)", async () => {
    // The live-fire drill: cfg.signal wired to the SDK stream makes the Anthropic
    // client throw its own APIUserAbortError wrapper, NOT the platform AbortError
    // the mock used — the narrow name check missed it, the error escaped to the
    // terminal catch with a LIVE root signal, classified model_error, and the turn
    // FAILED with an error card instead of steering. This pins the widened check.
    const scope = liveScope();
    let armed = false;
    const drainSteerText = (): string | null => {
      if (!armed) return null;
      armed = false;
      return STEER_TEXT;
    };
    const journal = makeJournal('t-round-abort-sdkname');
    const transport = new ScriptTransport([
      {
        abortMidStream: [{ kind: 'text', text: 'partial thoughts' }],
        trigger: (): void => {
          armed = true;
          scope.abortRound();
        },
        errorName: 'APIUserAbortError',
      },
      [
        { kind: 'text', text: 'done, using staging' },
        { kind: 'done', stopReason: 'end_turn', usage: usage(0.02) },
      ],
    ]);
    const events = await runOneUserTurn(
      buildCtx({ taskId: 't-round-abort-sdkname', transport, drainSteerText, journal, liveSignal: scope.get }),
    );
    const ends = turnEnds(events);
    expect(ends.length).toBe(1);
    expect(ends[0].outcome.kind).toBe('completed'); // NOT model_error, NOT user_aborted
    expect(transport.requestHistories.length).toBe(2); // same-turn continuation ran
    const rows = await journalRows(journal);
    expect(rows.findIndex((r) => r.type === 'user' && r.text === STEER_MARKER)).toBeGreaterThan(-1);
  });

  it("real SDK wrapper INSTANCE (.name === 'Error'): the round-catch still steers the same turn", async () => {
    // The drill fix above was validated against a hand-rolled double that SET
    // `.name = 'APIUserAbortError'` — but the real SDK classes never set `.name`
    // (a real instance reports 'Error'), so the widened NAME check still matched
    // nothing on the wire: a steer on a chat-completions lane (GLM etc.) escaped
    // to the terminal catch and appended a model_error card. This throws the
    // REAL openai wrapper — the exact object a killed ChatCompletionStream
    // re-throws — pinning the instanceof arm end-to-end through the round-catch.
    const realAbort = new OpenAIAPIUserAbortError();
    expect(realAbort.name).toBe('Error'); // the shape no named mock reproduces
    const scope = liveScope();
    let armed = false;
    const drainSteerText = (): string | null => {
      if (!armed) return null;
      armed = false;
      return STEER_TEXT;
    };
    const journal = makeJournal('t-round-abort-sdkinstance');
    const transport = new ScriptTransport([
      {
        abortMidStream: [{ kind: 'text', text: 'partial thoughts' }],
        trigger: (): void => {
          armed = true;
          scope.abortRound();
        },
        error: realAbort,
      },
      [
        { kind: 'text', text: 'done, using staging' },
        { kind: 'done', stopReason: 'end_turn', usage: usage(0.02) },
      ],
    ]);
    const events = await runOneUserTurn(
      buildCtx({ taskId: 't-round-abort-sdkinstance', transport, drainSteerText, journal, liveSignal: scope.get }),
    );
    const ends = turnEnds(events);
    expect(ends.length).toBe(1);
    expect(ends[0].outcome.kind).toBe('completed'); // NOT model_error, NOT user_aborted
    expect(transport.requestHistories.length).toBe(2); // same-turn continuation ran
    const rows = await journalRows(journal);
    expect(rows.findIndex((r) => r.type === 'user' && r.text === STEER_MARKER)).toBeGreaterThan(-1);
  });

  it('tool-batch abort (drain expired): seals the hung tool_use, injects the steer, one completed turn', async () => {
    const scope = liveScope();
    let armed = false;
    let drains = 0;
    const drainSteerText = (): string | null => {
      if (!armed) return null;
      armed = false;
      drains += 1;
      return STEER_TEXT;
    };
    const journal = makeJournal('t-round-abort-tool');
    const transport = new ScriptTransport([
      [
        { kind: 'tool_use', toolUse: { id: 'tu-hang', name: 'hang', input: {} } },
        { kind: 'done', stopReason: 'tool_use', usage: usage(0.01) },
      ],
      [
        { kind: 'text', text: 'switched to staging' },
        { kind: 'done', stopReason: 'end_turn', usage: usage(0.02) },
      ],
    ]);
    const events = await runOneUserTurn(
      buildCtx({
        taskId: 't-round-abort-tool',
        transport,
        drainSteerText,
        journal,
        liveSignal: scope.get,
        drainTimeoutMs: 25, // tiny grace so the hung dispatch expires fast
        toolHost: hangingToolHost(() => {
          // The ESC fires while the tool is in flight — abort NOW, never wait.
          armed = true;
          scope.abortRound();
        }),
      }),
    );

    const ends = turnEnds(events);
    expect(ends.length).toBe(1);
    expect(ends[0].outcome.kind).toBe('completed');
    expect(drains).toBe(1);
    expect(transport.requestHistories.length).toBe(2);
    // The hung tool_use was sealed (journal replay-safe: every tool_use paired)
    // BEFORE the steer marker.
    const rows = await journalRows(journal);
    const resultIdx = rows.findIndex((r) => r.type === 'tool_result');
    const steerIdx = rows.findIndex((r) => r.type === 'user' && r.text === STEER_MARKER);
    expect(resultIdx).toBeGreaterThanOrEqual(0);
    expect(steerIdx).toBeGreaterThan(resultIdx);
    // Founder-visible pill heal: the killed tool's interrupted result is ALSO
    // emitted LIVE (the sink maps it to AGENT_TOOL_RESULT, which the FE folds) —
    // otherwise the pill would spin until the steered continuation's terminal.
    const liveResults = events.filter(
      (e): e is Extract<HarnessEvent, { kind: 'block' }> =>
        e.kind === 'block' && (e.block as { type?: string }).type === 'tool_result',
    );
    expect(
      liveResults.some((e) => (e.block as { toolUseId?: string }).toolUseId === 'tu-hang'),
    ).toBe(true);
  });

  it('PLAIN interrupt (no scope swap) stays a byte-identical hard stop: user_aborted, drain never consumed', async () => {
    const ac = new AbortController();
    let armed = false;
    let drains = 0;
    const drainSteerText = (): string | null => {
      if (!armed) return null;
      armed = false;
      drains += 1;
      return STEER_TEXT;
    };
    const journal = makeJournal('t-plain-abort');
    const transport = new ScriptTransport([
      {
        abortMidStream: [{ kind: 'text', text: 'partial thoughts' }],
        trigger: (): void => {
          armed = true; // queue staged, but this is a HARD stop (no swap) —
          ac.abort(); //   the engine must NOT consume the drain
        },
      },
    ]);
    const events = await runOneUserTurn(
      buildCtx({ taskId: 't-plain-abort', transport, drainSteerText, journal, signal: ac.signal }),
    );

    const ends = turnEnds(events);
    expect(ends.length).toBe(1);
    expect(ends[0].outcome.kind).toBe('user_aborted');
    expect(drains).toBe(0);
    expect(transport.requestHistories.length).toBe(1);
    const rows = await journalRows(journal);
    expect(rows.some((r) => r.text === STEER_MARKER)).toBe(false);
  });

  it('round-abort with NOTHING drainable falls through to the hard stop (user_aborted)', async () => {
    const scope = liveScope();
    const journal = makeJournal('t-round-abort-empty');
    const transport = new ScriptTransport([
      {
        abortMidStream: [{ kind: 'text', text: 'partial thoughts' }],
        trigger: (): void => scope.abortRound(),
      },
    ]);
    const events = await runOneUserTurn(
      buildCtx({ taskId: 't-round-abort-empty', transport, drainSteerText: () => null, journal, liveSignal: scope.get }),
    );

    const ends = turnEnds(events);
    expect(ends.length).toBe(1);
    expect(ends[0].outcome.kind).toBe('user_aborted');
  });
});
