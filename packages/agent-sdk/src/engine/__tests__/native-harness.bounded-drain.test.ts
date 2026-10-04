/**
 * P3 (PR-3) — BOUNDED DRAIN in the engine loop (plan Task 4).
 *
 * A tool whose dispatch NEVER resolves must not hang the run past the abort:
 * after ctx.signal aborts, the in-flight dispatch gets `drainTimeoutMs`
 * (default 5s) to settle; on expiry the engine seals THAT tool_use with the
 * truthful elapsed wording (`Interrupted by user. [aborted after Ns; …]`,
 * isError:true) and rethrows AbortError so iterateTurn's existing catch
 * finalizes EXACTLY ONE user_aborted turn_end — even mid-tool.
 *
 * Covers all three round-engine dispatch sites:
 *   - the sequential main await (PushQueue chain),
 *   - the concurrent all-`Agent` PASS-2 collect (PushQueue chain per handle),
 *   - the subagent dispatch (NO queue): expiry SETTLES (seal-as-result + batch
 *     break) instead of throwing, preserving settle-on-abort's cost return.
 *
 * Fake timers throughout: the 5s grace advances instantly and the fake Date
 * makes the elapsed wording exact.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeHarness } from '../native-harness.js';
import { runSubagentLoop, type SubagentEvent } from '../subagent-runner.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage, type Transport } from '../transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { HarnessContext, UserTurn, GateResult, ToolCall } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { NativeConfig } from '../native-config.js';
import type { ToolHost } from '../../ports/tool-host-port.js';
import type { RawToolOptions, OnAuthHalt } from '../../tools/tool-types.js';

// ── scripted transport ────────────────────────────────────────────────────────

function toolUseRound(toolUses: Array<{ id: string; name: string }>): StreamEvent[] {
  return [
    ...toolUses.map((tu): StreamEvent => ({ kind: 'tool_use', toolUse: { id: tu.id, name: tu.name, input: {} } })),
    {
      kind: 'done',
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 5 } as NormalizedUsage,
    },
  ];
}

/** Serves scripted rounds in order (the round after the last repeats it). */
class ScriptTransport extends FakeTransport {
  private idx = 0;
  modelCalls = 0;
  constructor(private readonly rounds: StreamEvent[][]) {
    super([]);
  }
  override callModel(): StreamEvent[] {
    this.modelCalls += 1;
    const round = this.rounds[Math.min(this.idx, this.rounds.length - 1)];
    this.idx += 1;
    return round;
  }
}

// ── hanging tool host ─────────────────────────────────────────────────────────

/** A ToolHost whose named tools' execute() NEVER resolves; signals first entry. */
function hangingToolHost(names: string[]): { toolHost: ToolHost; toolEntered: Promise<void> } {
  let markEntered!: () => void;
  const toolEntered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const toolHost: ToolHost = {
    async buildTools(): Promise<{ tools: RawToolOptions[]; onAuthHalt: OnAuthHalt }> {
      const tools = names.map(
        (name): RawToolOptions => ({
          name,
          description: 'test tool whose dispatch never resolves (the drain target)',
          parameters: { type: 'object', properties: {}, additionalProperties: true },
          execute: () => {
            markEntered();
            return new Promise<never>(() => {});
          },
        }),
      );
      return { tools, onAuthHalt: async () => {} };
    },
  };
  return { toolHost, toolEntered };
}

// ── journal + ctx builders ────────────────────────────────────────────────────

function makeJournal(taskId: string): Journal {
  const path = join(
    tmpdir(),
    `bounded-drain-${process.pid}-${Math.random().toString(36).slice(2)}`,
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

async function readEntries(j: Journal): Promise<JournalEntry[]> {
  const out: JournalEntry[] = [];
  for await (const e of j.read()) out.push(e);
  return out;
}

function buildCtx(opts: {
  taskId: string;
  transport: FakeTransport;
  toolHost: ToolHost;
  journal: Journal;
  signal: AbortSignal;
}): HarnessContext<NativeConfig> {
  const cfg = {
    onAttached: () => {},
    maxTurns: 10,
    transport: opts.transport,
    toolHost: opts.toolHost,
    journal: opts.journal,
    signal: opts.signal,
  } as unknown as NativeConfig;
  return {
    taskId: opts.taskId,
    sessionId: 's-drain',
    cwd: '/tmp',
    model: 'fake-model',
    signal: opts.signal,
    config: cfg,
  };
}

function oneTurn(): AsyncIterable<UserTurn> {
  return (async function* () {
    yield { text: 'run a tool' } as UserTurn;
  })();
}

/** Drive run() to completion, collecting events (started BEFORE the abort). */
function collectRun(ctx: HarnessContext<NativeConfig>): { events: HarnessEvent[]; done: Promise<void> } {
  const events: HarnessEvent[] = [];
  const done = (async () => {
    for await (const ev of new NativeHarness().run(oneTurn(), ctx)) events.push(ev);
  })();
  return { events, done };
}

function turnEnds(events: HarnessEvent[]): Array<Extract<HarnessEvent, { kind: 'turn_end' }>> {
  return events.filter((e): e is Extract<HarnessEvent, { kind: 'turn_end' }> => e.kind === 'turn_end');
}

function sealedResults(entries: JournalEntry[]): Array<{ toolUseId: string; text: string }> {
  return entries
    .filter((e) => e.payload.type === 'tool_result' && (e.payload as { isError?: boolean }).isError === true)
    .map((e) => {
      const p = e.payload as { toolUseId: string; blocks?: Array<{ type: string; text?: string }> };
      return { toolUseId: p.toolUseId, text: p.blocks?.[0]?.text ?? '' };
    });
}

describe('P3 bounded drain — user_aborted finalizes within grace even mid-tool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('SEQUENTIAL: a never-resolving tool is sealed `[aborted after 5s…]` and the turn finalizes user_aborted', async () => {
    const controller = new AbortController();
    const { toolHost, toolEntered } = hangingToolHost(['Bash']);
    const transport = new ScriptTransport([toolUseRound([{ id: 'tu-hang', name: 'Bash' }])]);
    const journal = makeJournal('t-seq');
    const ctx = buildCtx({ taskId: 't-seq', transport, toolHost, journal, signal: controller.signal });

    const { events, done } = collectRun(ctx);
    await toolEntered; // the dispatch is in-flight — the drain window
    controller.abort();
    await vi.advanceTimersByTimeAsync(5_000); // the DRAIN_DEFAULT_MS grace
    await done;

    const ends = turnEnds(events);
    expect(ends.length).toBe(1);
    expect(ends[0].outcome.kind).toBe('user_aborted');
    if (ends[0].outcome.kind === 'user_aborted') expect(ends[0].outcome.abortPhase).toBe('tools');

    const sealed = sealedResults(await readEntries(journal));
    expect(sealed.length).toBe(1);
    expect(sealed[0].toolUseId).toBe('tu-hang');
    expect(sealed[0].text).toMatch(/^Interrupted by user\. \[aborted after 5s; the command may still be running\]$/);
    // Only one model call — the sealed run never re-drove the model.
    expect(transport.modelCalls).toBe(1);
  });

  it('SEQUENTIAL: cfg.drainTimeoutMs overrides the default grace (and the elapsed wording tracks it)', async () => {
    const controller = new AbortController();
    const { toolHost, toolEntered } = hangingToolHost(['Bash']);
    const transport = new ScriptTransport([toolUseRound([{ id: 'tu-hang', name: 'Bash' }])]);
    const journal = makeJournal('t-grace');
    const ctx = buildCtx({ taskId: 't-grace', transport, toolHost, journal, signal: controller.signal });
    (ctx.config as { drainTimeoutMs?: number }).drainTimeoutMs = 2_000;

    const { events, done } = collectRun(ctx);
    await toolEntered;
    controller.abort();
    await vi.advanceTimersByTimeAsync(2_000);
    await done;

    expect(turnEnds(events).length).toBe(1);
    const sealed = sealedResults(await readEntries(journal));
    expect(sealed[0].text).toMatch(/^Interrupted by user\. \[aborted after 2s/);
  });

  it('CONCURRENT (all-Agent batch): the expired handle seals with elapsed wording, the sibling heals, ONE user_aborted turn_end', async () => {
    const controller = new AbortController();
    const { toolHost, toolEntered } = hangingToolHost(['Agent']);
    const transport = new ScriptTransport([
      toolUseRound([
        { id: 'tu-a', name: 'Agent' },
        { id: 'tu-b', name: 'Agent' },
      ]),
    ]);
    const journal = makeJournal('t-conc');
    const ctx = buildCtx({ taskId: 't-conc', transport, toolHost, journal, signal: controller.signal });

    const { events, done } = collectRun(ctx);
    await toolEntered; // at least one dispatch in flight (both hang)
    controller.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    await done;

    const ends = turnEnds(events);
    expect(ends.length).toBe(1);
    expect(ends[0].outcome.kind).toBe('user_aborted');

    // BOTH tool_uses are answered in the journal (API-valid projection): the
    // drain-expired handle carries the elapsed wording; its sibling was healed
    // by the catch's healOrphanedToolUse with the plain interrupt seal.
    const sealed = sealedResults(await readEntries(journal));
    expect(sealed.length).toBe(2);
    const byId = new Map(sealed.map((s) => [s.toolUseId, s.text]));
    expect(byId.get('tu-a')).toMatch(/^Interrupted by user\. \[aborted after 5s/);
    expect(byId.get('tu-b')).toMatch(/^Interrupted by user\./);
    for (const text of byId.values()) expect(text).toMatch(/^Interrupted by user\./);
  });

  it('SUBAGENT (shared loop): drain expiry SETTLES — the sealed result surfaces, the loop breaks, and the accumulated cost survives', async () => {
    const controller = new AbortController();
    let markEntered!: () => void;
    const toolEntered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const hang: RawToolOptions = {
      name: 'hang',
      description: 'never resolves',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      execute: () => {
        markEntered();
        return new Promise<never>(() => {});
      },
    };
    // Round 0 costs $0.10 and calls the hanging tool; a round 1 would only be
    // reached if the loop failed to honor the aborted signal at the boundary.
    class SubTransport extends ScriptTransport {
      override computeCostUsd(): number {
        return 0.1;
      }
    }
    const transport = new SubTransport([toolUseRound([{ id: 'tu-hang', name: 'hang' }])]);
    const passHarness = { gateTool: async (_c: ToolCall): Promise<GateResult> => ({ decision: 'allow' as const }) };
    const subEvents: SubagentEvent[] = [];

    const resP = runSubagentLoop({
      transport: transport as Transport,
      model: 'fake-model',
      system: 's',
      userPrompt: 'p',
      tools: [hang],
      harness: passHarness,
      onPause: async () => 'PAUSED',
      signal: controller.signal,
      maxTurns: 5,
      onEvent: (ev) => {
        subEvents.push(ev);
      },
      childId: 'child-drain',
      sharedLoop: true,
    });

    await toolEntered; // the subagent's dispatch is in-flight
    controller.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    const res = await resP; // SETTLES — no throw (settle-on-abort preserved)

    // The completed round-0 model cost survived the drain expiry (AC-2b-3).
    expect(res.costUsd).toBeCloseTo(0.1, 9);
    // The expired tool surfaced the truthful sealed result on the event surface.
    const toolResults = subEvents.filter(
      (e): e is Extract<SubagentEvent, { kind: 'tool_result' }> => e.kind === 'tool_result',
    );
    expect(toolResults.length).toBe(1);
    expect(toolResults[0].isError).toBe(true);
    expect(toolResults[0].result).toMatch(/^Interrupted by user\. \[aborted after 5s/);
    // The loop broke at the boundary — no second model call against the aborted signal.
    expect(transport.modelCalls).toBe(1);
  });
});
