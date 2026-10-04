/**
 * native-harness.recall.test.ts — P5 Task 2: the per-round Nami consult,
 * post-fleet redesign (PR #1347): CACHE-HONEST journaled delivery.
 *
 * The fence is appended as a FIRST-CLASS user journal entry (the mid-turn
 * steer discipline) and enters via re-projection. Proven here against a REAL
 * journal projection (rebuilt every round, exactly like production):
 *
 *  1. OFF (no cfg.recall) → zero consults, request bodies fence-free.
 *  2. ON + fast recall → the fence is its OWN user message immediately after
 *     the turn's user message; identical across the turn's rounds; deduped.
 *  3. CROSS-TURN CACHE HONESTY (the fleet major's pinned evidence): turn 2's
 *     first request replays turn 1's span BYTE-IDENTICALLY — the fence is in
 *     the durable projection, so no prefix divergence, no span re-write.
 *  4. Bounded fossilization: the journal carries the fence exactly ONCE.
 *  5. HUNG recall → rounds proceed at the deadline; turn completes.
 *  6. ABORT during a hung recall (fleet item 1) → user_aborted finalizes
 *     WITHOUT sitting out the deadline; no fence; no post-abort RPC.
 *  7. maxPerTurn bounds appends AND further consults.
 *  8. Duplicate-consult short-circuit (fleet item 4): unchanged query + a
 *     missed/duplicate consult → no RPC that round (5 rounds → 2 RPCs).
 *  9. Cache discipline: cachePrefixHint + system prompt identical ON vs OFF.
 * 10. No journal → no consult.
 */
import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage, type ProviderHistory } from '../transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { JournalEntry } from '../../contract/journal.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { NativeConfig } from '../native-config.js';
import type { RecallSeam } from '../recall.js';
import type { ToolHost } from '../../ports/tool-host-port.js';
import type { RawToolOptions, OnAuthHalt } from '../../tools/tool-types.js';

function usage(costUsd: number): NormalizedUsage {
  return { inputTokens: 10, outputTokens: 5, costUsd } as NormalizedUsage;
}

type FakeMsg = { role: string; text?: string; toolUseId?: string };

class RecallScriptTransport extends FakeTransport {
  private idx = 0;
  readonly requestHistories: FakeMsg[][] = [];
  readonly systems: string[] = [];
  constructor(private readonly rounds: StreamEvent[][]) {
    super([]);
  }
  /** REAL projection over the fake shape so re-projection mechanics run as in prod. */
  override historyFromJournal(entries: JournalEntry[]): ProviderHistory {
    const out: FakeMsg[] = [];
    for (const e of entries) {
      const p = e.payload;
      if (p.type === 'user' || p.type === 'assistant') {
        const text = p.blocks
          .map((b) => (b.type === 'text' ? b.text : ''))
          .filter(Boolean)
          .join('\n');
        if (text) out.push({ role: p.type, text });
      } else if (p.type === 'tool_result') {
        out.push({ role: 'tool', toolUseId: p.toolUseId });
      }
    }
    return out;
  }
  override callModel(p: { history: unknown; system: string }): StreamEvent[] {
    this.requestHistories.push(JSON.parse(JSON.stringify(p.history)) as FakeMsg[]);
    this.systems.push(p.system);
    const round = this.rounds[Math.min(this.idx, this.rounds.length - 1)];
    this.idx += 1;
    return round;
  }
  override computeCostUsd(u: NormalizedUsage): number {
    return (u as { costUsd?: number }).costUsd ?? 0;
  }
}

const USER_TEXT = 'deploy the web app';
const FACT_A = '- keshav prefers: staging-only deploys (task 2026-06-12)';
const FENCED_A = `<recalled_memory authority="curated" source="nami">\n${FACT_A}\n</recalled_memory>`;

/** N tool rounds then a final text round → N+1 model calls per turn. */
function script(toolRounds: number, finalText = 'deployed'): StreamEvent[][] {
  const rounds: StreamEvent[][] = [];
  for (let i = 0; i < toolRounds; i++) {
    rounds.push([
      { kind: 'tool_use', toolUse: { id: `tu-${i + 1}`, name: 'noop', input: {} } },
      { kind: 'done', stopReason: 'tool_use', usage: usage(0.01) },
    ]);
  }
  rounds.push([
    { kind: 'text', text: finalText },
    { kind: 'done', stopReason: 'end_turn', usage: usage(0.02) },
  ]);
  return rounds;
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
    `recall-${process.pid}-${Math.random().toString(36).slice(2)}`,
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
  recall?: RecallSeam;
  journal?: Journal;
  controller?: AbortController;
}): HarnessContext<NativeConfig> {
  const controller = opts.controller ?? new AbortController();
  const cfg = {
    onAttached: () => {},
    maxTurns: 10,
    transport: opts.transport,
    toolHost: noopToolHost(),
    signal: controller.signal,
    ...(opts.recall ? { recall: opts.recall } : {}),
    ...(opts.journal ? { journal: opts.journal } : {}),
  } as unknown as NativeConfig;
  return {
    taskId: opts.taskId,
    sessionId: 's-recall',
    cwd: '/tmp',
    model: 'fake-model',
    signal: controller.signal,
    config: cfg,
  };
}

async function runTurns(ctx: HarnessContext<NativeConfig>, turns: string[]): Promise<HarnessEvent[]> {
  const input = (async function* (): AsyncIterable<UserTurn> {
    for (const t of turns) yield { text: t };
  })();
  const events: HarnessEvent[] = [];
  for await (const ev of new NativeHarness().run(input, ctx)) events.push(ev);
  return events;
}

function turnEnds(events: HarnessEvent[]): Array<Extract<HarnessEvent, { kind: 'turn_end' }>> {
  return events.filter((e): e is Extract<HarnessEvent, { kind: 'turn_end' }> => e.kind === 'turn_end');
}

function fenceMessages(h: FakeMsg[]): FakeMsg[] {
  return h.filter((m) => m.role === 'user' && (m.text ?? '').startsWith('<recalled_memory '));
}

describe('P5 Task 2 — per-round Nami consult (cache-honest journaled delivery)', () => {
  it('OFF (no cfg.recall): request bodies free of any recall fence', async () => {
    const transport = new RecallScriptTransport(script(1));
    const events = await runTurns(
      buildCtx({ taskId: 't-r-off', transport, journal: makeJournal('t-r-off') }),
      [USER_TEXT],
    );
    expect(turnEnds(events)[0]?.outcome.kind).toBe('completed');
    for (const h of transport.requestHistories) {
      expect(JSON.stringify(h)).not.toContain('recalled_memory');
    }
  });

  it('ON + fast recall: the fence is its OWN user message right after the turn user message; identical across rounds; deduped', async () => {
    const readRelevant = vi.fn(async (_q: string) => FACT_A);
    const transport = new RecallScriptTransport(script(1));
    const events = await runTurns(
      buildCtx({
        taskId: 't-r-on',
        transport,
        journal: makeJournal('t-r-on'),
        recall: { readRelevant },
      }),
      [USER_TEXT],
    );
    expect(turnEnds(events)[0]?.outcome.kind).toBe('completed');
    expect(transport.requestHistories.length).toBe(2);

    // Round 1: [userN, fence] — the fence directly follows the turn's user message.
    const r1 = transport.requestHistories[0];
    expect(r1[0]).toEqual({ role: 'user', text: USER_TEXT });
    expect(r1[1]).toEqual({ role: 'user', text: FENCED_A });
    expect(fenceMessages(r1).length).toBe(1);

    // Round 2: the same two messages BYTE-IDENTICAL at the same positions,
    // still exactly one fence (durable dedupe — round 2's consult re-fetched
    // the same fact and skipped the append).
    const r2 = transport.requestHistories[1];
    expect(JSON.stringify(r2.slice(0, 2))).toBe(JSON.stringify(r1.slice(0, 2)));
    expect(fenceMessages(r2).length).toBe(1);

    // Consulted round 1 (hit) and round 2 (query changed — tool names landed).
    expect(readRelevant).toHaveBeenCalledTimes(2);
    expect(readRelevant.mock.calls[0][0]).toContain(USER_TEXT);
    // The appended fence never becomes the query (feedback-loop guard).
    expect(readRelevant.mock.calls[1][0]).toContain(USER_TEXT);
    expect(readRelevant.mock.calls[1][0]).not.toContain('recalled_memory');
  });

  it('CROSS-TURN CACHE HONESTY: turn 2 replays turn 1 (fence included) byte-identically — no prefix divergence', async () => {
    const readRelevant = vi
      .fn<(q: string) => Promise<string | null>>()
      .mockResolvedValueOnce(FACT_A)
      .mockResolvedValue(null);
    const transport = new RecallScriptTransport(script(1));
    const events = await runTurns(
      buildCtx({
        taskId: 't-r-xturn',
        transport,
        journal: makeJournal('t-r-xturn'),
        recall: { readRelevant },
      }),
      [USER_TEXT, 'now update the docs'],
    );
    expect(turnEnds(events).length).toBe(2);
    // Turn 1 = requests 0..1; turn 2's first request = request 2.
    const turn1Final = transport.requestHistories[1];
    const turn2First = transport.requestHistories[2];
    // Turn 2's request EXTENDS turn 1's final request byte-for-byte (the fence
    // is journal-durable, so the shared prefix never diverges — the property
    // whose absence was the fleet major: the in-memory pin re-projected turn
    // 1's user message CLEAN here, re-writing the whole span into cache).
    expect(JSON.stringify(turn2First.slice(0, turn1Final.length))).toBe(JSON.stringify(turn1Final));
  });

  it('bounded fossilization: the journal carries the fence exactly once', async () => {
    const journal = makeJournal('t-r-journal');
    const transport = new RecallScriptTransport(script(1));
    await runTurns(
      buildCtx({ taskId: 't-r-journal', transport, journal, recall: { readRelevant: async () => FACT_A } }),
      [USER_TEXT],
    );
    let fences = 0;
    for await (const e of journal.read()) {
      if (JSON.stringify(e).includes('recalled_memory')) fences += 1;
    }
    expect(fences).toBe(1);
  });

  it('HUNG recall: rounds proceed at the deadline; turn completes; no fence', async () => {
    const readRelevant = vi.fn((): Promise<string | null> => new Promise<never>(() => {}));
    const transport = new RecallScriptTransport(script(1));
    const events = await runTurns(
      buildCtx({
        taskId: 't-r-hang',
        transport,
        journal: makeJournal('t-r-hang'),
        recall: { readRelevant, deadlineMs: 25 },
      }),
      [USER_TEXT],
    );
    expect(turnEnds(events)[0]?.outcome.kind).toBe('completed');
    expect(transport.requestHistories.length).toBe(2);
    for (const h of transport.requestHistories) {
      expect(JSON.stringify(h)).not.toContain('recalled_memory');
    }
  });

  it('ABORT during a hung recall: user_aborted finalizes without the deadline wait; no post-abort RPC', async () => {
    const controller = new AbortController();
    const readRelevant = vi.fn((): Promise<string | null> => {
      // Abort arrives while the consult race is pending.
      setTimeout(() => controller.abort(), 5);
      return new Promise<never>(() => {});
    });
    const transport = new RecallScriptTransport(script(1));
    const started = Date.now();
    const events = await runTurns(
      buildCtx({
        taskId: 't-r-abort',
        transport,
        journal: makeJournal('t-r-abort'),
        controller,
        // A deliberately HUGE deadline: finishing fast proves the abort — not
        // the deadline — resolved the race.
        recall: { readRelevant, deadlineMs: 60_000 },
      }),
      [USER_TEXT],
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(turnEnds(events)[0]?.outcome.kind).toBe('user_aborted');
    expect(readRelevant).toHaveBeenCalledTimes(1);
    for (const h of transport.requestHistories) {
      expect(JSON.stringify(h)).not.toContain('recalled_memory');
    }
  });

  it('maxPerTurn bounds appends AND further consults', async () => {
    let n = 0;
    const readRelevant = vi.fn(async () => `- distinct fact number ${++n}`);
    const transport = new RecallScriptTransport(script(3)); // 4 model rounds
    await runTurns(
      buildCtx({
        taskId: 't-r-max',
        transport,
        journal: makeJournal('t-r-max'),
        recall: { readRelevant, maxPerTurn: 2 },
      }),
      [USER_TEXT],
    );
    expect(transport.requestHistories.length).toBe(4);
    expect(readRelevant).toHaveBeenCalledTimes(2);
    const last = transport.requestHistories[3];
    expect(fenceMessages(last).length).toBe(2);
    expect(JSON.stringify(last)).toContain('- distinct fact number 1');
    expect(JSON.stringify(last)).toContain('- distinct fact number 2');
    expect(JSON.stringify(last)).not.toContain('- distinct fact number 3');
  });

  it('duplicate-consult short-circuit: repeating fact over 5 rounds → 2 RPCs, not 5', async () => {
    const readRelevant = vi.fn(async (_q: string) => FACT_A);
    const transport = new RecallScriptTransport(script(4)); // 5 model rounds
    await runTurns(
      buildCtx({
        taskId: 't-r-dup',
        transport,
        journal: makeJournal('t-r-dup'),
        recall: { readRelevant },
      }),
      [USER_TEXT],
    );
    expect(transport.requestHistories.length).toBe(5);
    // Round 1 (hit, appended) + round 2 (query gained the tool name → re-armed,
    // duplicate → miss recorded). Rounds 3-5: query unchanged + last consult
    // missed → short-circuited, ZERO further RPCs.
    expect(readRelevant).toHaveBeenCalledTimes(2);
    expect(fenceMessages(transport.requestHistories[4]).length).toBe(1);
  });

  it('cache discipline: cachePrefixHint sequence and system prompt identical with recall ON', async () => {
    const on = new RecallScriptTransport(script(1));
    await runTurns(
      buildCtx({ taskId: 't-r-hint-on', transport: on, journal: makeJournal('t-r-hint-on'), recall: { readRelevant: async () => FACT_A } }),
      [USER_TEXT],
    );
    const off = new RecallScriptTransport(script(1));
    await runTurns(
      buildCtx({ taskId: 't-r-hint-off', transport: off, journal: makeJournal('t-r-hint-off') }),
      [USER_TEXT],
    );
    expect(on.cachePrefixHints).toEqual(off.cachePrefixHints);
    expect(on.systems).toEqual(off.systems);
    expect(JSON.stringify(on.systems)).not.toContain('recalled_memory');
  });

  it('no journal → no consult (the in-memory path is outside the seam)', async () => {
    const readRelevant = vi.fn(async () => FACT_A);
    const transport = new RecallScriptTransport(script(1));
    const events = await runTurns(
      buildCtx({ taskId: 't-r-nojournal', transport, recall: { readRelevant } }),
      [USER_TEXT],
    );
    expect(turnEnds(events)[0]?.outcome.kind).toBe('completed');
    expect(readRelevant).not.toHaveBeenCalled();
  });
});

// ── P5 T5-extension: the dark onConsult observability hook ──────────────────
// The eval's in-loop arm needs the ENGINE's bounded wait (wrapping readRelevant
// only sees fetch time, not the race). onConsult reports each consulting
// round's total added latency + outcome. ABSENT → zero calls (every other test
// in this file runs without it — the byte-identical axis).
describe('RecallSeam.onConsult (dev-only observability)', () => {
  it('reports appended → duplicate → short-circuit outcomes with bounded waitMs', async () => {
    const samples: Array<{ waitMs: number; outcome: string }> = [];
    const readRelevant = vi.fn(async (_q: string) => FACT_A);
    const transport = new RecallScriptTransport(script(4)); // 5 model rounds
    await runTurns(
      buildCtx({
        taskId: 't-r-obs',
        transport,
        journal: makeJournal('t-r-obs'),
        recall: { readRelevant, onConsult: (s) => samples.push(s) },
      }),
      [USER_TEXT],
    );
    // Round 1 hit+append; round 2 re-armed query → duplicate; rounds 3-5 short-circuit.
    expect(samples.map((s) => s.outcome)).toEqual([
      'appended',
      'duplicate',
      'short-circuit',
      'short-circuit',
      'short-circuit',
    ]);
    for (const s of samples) {
      expect(s.waitMs).toBeGreaterThanOrEqual(0);
      expect(s.waitMs).toBeLessThan(1_000);
    }
  });

  it('a HUNG recall reports empty with waitMs ≈ the deadline (the bounded wait, not fetch time)', async () => {
    const samples: Array<{ waitMs: number; outcome: string }> = [];
    const readRelevant = vi.fn((): Promise<string | null> => new Promise<never>(() => {}));
    const transport = new RecallScriptTransport(script(1));
    await runTurns(
      buildCtx({
        taskId: 't-r-obs-hang',
        transport,
        journal: makeJournal('t-r-obs-hang'),
        recall: { readRelevant, deadlineMs: 40, onConsult: (s) => samples.push(s) },
      }),
      [USER_TEXT],
    );
    expect(samples.length).toBe(2);
    for (const s of samples) {
      expect(s.outcome).toBe('empty');
      expect(s.waitMs).toBeGreaterThanOrEqual(35);
      expect(s.waitMs).toBeLessThan(1_000);
    }
  });

  it('a THROWING onConsult never breaks the turn (guarded)', async () => {
    const transport = new RecallScriptTransport(script(1));
    const events = await runTurns(
      buildCtx({
        taskId: 't-r-obs-throw',
        transport,
        journal: makeJournal('t-r-obs-throw'),
        recall: {
          readRelevant: async () => FACT_A,
          onConsult: () => {
            throw new Error('observer boom');
          },
        },
      }),
      [USER_TEXT],
    );
    expect(turnEnds(events)[0]?.outcome.kind).toBe('completed');
    // The fence still landed despite the throwing observer.
    expect(JSON.stringify(transport.requestHistories[0])).toContain('recalled_memory');
  });
});
