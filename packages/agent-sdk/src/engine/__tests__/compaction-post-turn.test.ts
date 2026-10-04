/**
 * COMPACTION_POST_TURN_V1 — Codex's turn-end compaction (codex-rs core/src/session/turn.rs:716).
 *
 * A turn that ends with its measured input at 85% of the compaction budget or more compacts in
 * the idle wait for the next message (POST_TURN_OFF_PATH_V1's lane), so the next turn starts
 * under budget instead of compacting at a round head mid-work. Every case drives the REAL
 * NativeHarness over a real Journal with a scripted transport whose summarize can hang until it
 * is aborted: the success path, a real cut by the next message, a real refusal, a due compaction
 * holding a message only until its bound, the box hold, and the inline path (which never runs one).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeHarness } from '../native-harness.js';
import { POST_TURN_COMPACT_SHARE } from '../compaction-post-turn.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { NewEntry } from '../../contract/journal.js';
import type { ContentBlock } from '../../contract/blocks.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { NativeConfig } from '../native-config.js';

const SESSION_COMPACTED = 'session:compacted';
const COMPACTION_FAILED = 'session:compaction_failed';
const FLAGS = ['COMPACTION_V2', 'COMPACTION_POST_TURN_V1', 'POST_TURN_OFF_PATH_V1', 'POST_TURN_COMPACT_TIMEOUT_MS'] as const;
afterEach(() => {
  for (const f of FLAGS) delete process.env[f];
});
function flags(on: { post: boolean; idle: boolean }): void {
  process.env.COMPACTION_V2 = 'true';
  if (on.post) process.env.COMPACTION_POST_TURN_V1 = 'true';
  if (on.idle) process.env.POST_TURN_OFF_PATH_V1 = 'true';
}

const done = (inputTokens = 1000): StreamEvent => ({ kind: 'done', stopReason: 'end_turn', usage: { inputTokens, outputTokens: 20 } as NormalizedUsage });
const text = (t: string, inputTokens?: number): StreamEvent[] => [{ kind: 'text', text: t }, done(inputTokens)];
const SUMMARY = text('SUMMARY OF EARLIER WORK');
const HANG = 'hang' as const;

/** Answers in call order; a 'hang' step streams nothing until its request is aborted. Every call costs $0.02. */
class ScriptedTransport extends FakeTransport {
  calls = 0;
  /** Resolves when a hanging call has started. */
  hanging: Promise<void>;
  private hung!: () => void;
  constructor(private readonly steps: Array<StreamEvent[] | typeof HANG>) {
    super([]);
    this.hanging = new Promise<void>((r) => (this.hung = r));
  }
  override callModel(p: Parameters<FakeTransport['callModel']>[0]): ReturnType<FakeTransport['callModel']> {
    super.callModel(p);
    const step = this.steps[Math.min(this.calls, this.steps.length - 1)]!;
    this.calls += 1;
    return (step === HANG ? { hang: p.signal } : step) as never;
  }
  override async *readStream(stream: Parameters<FakeTransport['readStream']>[0]): AsyncIterable<StreamEvent> {
    const s = stream as unknown as { hang?: AbortSignal };
    if (s && !Array.isArray(s) && 'hang' in s) {
      this.hung();
      await new Promise<void>((resolve) => {
        if (!s.hang || s.hang.aborted) return resolve();
        s.hang.addEventListener('abort', () => resolve(), { once: true });
      });
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    }
    yield* super.readStream(stream);
  }
  override computeCostUsd(): number {
    return 0.02;
  }
}

const base = (taskId: string): Omit<NewEntry, 'payload'> => ({
  taskId, rootTaskId: taskId, spawnDepth: 0, workspaceId: 'w', agentId: 'native', principal: { kind: 'agent', agentId: 'native' }, timestamp: '',
});
function makeJournal(taskId: string): Journal {
  const path = join(tmpdir(), `cpt-${process.pid}-${Math.random().toString(36).slice(2)}`, `${taskId}.jsonl`);
  return new Journal({ taskId, workspaceId: 'w', jsonl: new JsonlStore(path), mirror: new InMemorySessionStore(), clock: sequentialClock('2024-01-01T00:00:00.000Z') });
}
/** Turns totalling about `tokens` in the ledger's estimate (chars/4). */
async function seed(j: Journal, taskId: string, tokens: number): Promise<void> {
  const chunk = 'context '.repeat(500); // ~1000 tokens
  for (let i = 0; i < Math.ceil(tokens / 2000); i++) {
    await j.append({ ...base(taskId), principal: { kind: 'user', userId: 'u' }, payload: { type: 'user', blocks: [{ type: 'text', text: `q${i} ${chunk}` } as ContentBlock] } });
    await j.append({ ...base(taskId), payload: { type: 'assistant', blocks: [{ type: 'text', text: `a${i} ${chunk}` } as ContentBlock], api: 'anthropic_messages', provider: 'anthropic', model: 'claude-sonnet-5' } });
  }
}

interface Run { events: HarnessEvent[]; holds: number; releases: number; at: Map<HarnessEvent, number> }

/**
 * Two user turns on one warm run. The second message goes when `release` resolves; by default
 * once the first turn's compaction is seen (or, when none comes, a moment after its turn_end).
 */
async function twoTurns(taskId: string, j: Journal, transport: ScriptedTransport, release?: Promise<void>, opts: { stopAtFirstTurnEnd?: boolean } = {}): Promise<Run> {
  const stop = new AbortController();
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const input = (async function* (): AsyncIterable<UserTurn> {
    yield { text: 'first question' };
    await (release ?? gate);
    yield { text: 'second question' };
  })();
  const run: Run = { events: [], holds: 0, releases: 0, at: new Map() };
  const cfg = {
    onAttached: () => {}, maxTurns: 4, transport, journal: j, compaction: { keepWindowTokens: 2_000 }, signal: stop.signal,
    holdForPostTurnWork: () => { run.holds += 1; return () => { run.releases += 1; }; },
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = { taskId, sessionId: 's-cpt', cwd: '/tmp', model: 'claude-sonnet-5', signal: new AbortController().signal, config: cfg };
  let turnEnds = 0;
  for await (const ev of new NativeHarness().run(input, ctx)) {
    run.events.push(ev);
    run.at.set(ev, Date.now());
    if (ev.kind === 'turn_end' && ++turnEnds === 1) {
      if (opts.stopAtFirstTurnEnd) stop.abort(); // the person presses Stop as the turn ends
      setTimeout(open, 1000);
    }
    if (isRaw(ev, SESSION_COMPACTED)) open();
  }
  return run;
}

/** The second message goes when the summarize hangs, or after 5 s (a missed hang then fails the assertions, never the clock). */
const hangOrGiveUp = (t: ScriptedTransport): Promise<void> => Promise.race([t.hanging, new Promise<void>((r) => setTimeout(r, 5_000))]);
const isRaw = (e: HarnessEvent, name: string): boolean => e.kind === 'raw' && (e as { event?: string }).event === name;
type Row = HarnessEvent & { lane?: string; laneStatus?: string; usage: NormalizedUsage; compaction?: { reason: string; strategy: string; tokensBefore: number; tokensAfter: number } };
const rows = (events: HarnessEvent[], lane: string) => events.filter((e) => e.kind === 'usage' && (e as Row).lane === lane) as Row[];
const turnEndsOf = (events: HarnessEvent[]) => events.filter((e) => e.kind === 'turn_end') as Array<HarnessEvent & { billing?: { cumulativeCostUsd: number } }>;
const between = (events: HarnessEvent[], from: HarnessEvent, to: HarnessEvent) => events.slice(events.indexOf(from) + 1, events.indexOf(to));

// claude-sonnet-5 under COMPACTION_V2: its 200k preferred ceiling at the 0.9 safety share, a
// 180k budget (kernel/compaction/trigger.ts). 165k sits under it (no round-head compaction) and
// over 85% of it (153k): "early".
const BUDGET = 180_000;
const EARLY_TOKENS = 165_000;

describe('COMPACTION_POST_TURN_V1: the next turn starts under budget', () => {
  it('on: compacts after the turn ends and before the next, billed off-loop, never folded into a turn, with the box held', async () => {
    flags({ post: true, idle: true });
    const taskId = 'cpt-on';
    const j = makeJournal(taskId);
    await seed(j, taskId, EARLY_TOKENS);
    const transport = new ScriptedTransport([text('answer one'), SUMMARY, text('answer two')]);
    const { events, holds, releases } = await twoTurns(taskId, j, transport);

    // Mutation: drop the turn-end check → no compaction anywhere (the round head stays under budget).
    const compacted = events.filter((e) => isRaw(e, SESSION_COMPACTED));
    expect(compacted).toHaveLength(1);
    const [end1, end2] = turnEndsOf(events);
    expect(between(events, end1!, end2!)).toContain(compacted[0]);
    expect(transport.calls).toBe(3); // turn one, the summarize, turn two: no round-head compaction in turn two

    const lane = rows(events, 'post_turn_compaction');
    expect(lane).toHaveLength(1);
    expect(lane[0]!.laneStatus).toBe('ok');
    expect(lane[0]!.compaction).toMatchObject({ reason: 'post_turn', strategy: 'local' });
    expect(lane[0]!.compaction!.tokensAfter).toBeLessThan(lane[0]!.compaction!.tokensBefore);
    expect(rows(events, 'compaction')).toHaveLength(0);
    // Never folded into a turn: turn two's claimed cost is its one main call, not that plus the summarize.
    expect(end2!.billing!.cumulativeCostUsd - end1!.billing!.cumulativeCostUsd).toBeCloseTo(0.02, 6);
    expect((await j.project()).compactionSummaryLeading).toBe(true);
    // Mutation: drop the idle lane's hold → a cloud box stands by mid-summarize.
    expect(holds).toBeGreaterThanOrEqual(1);
    expect(releases).toBe(holds);
  });

  it('a real cut: the next message aborts the summarize mid-stream, its cancelled row carries the estimate, nothing is written', async () => {
    flags({ post: true, idle: true });
    const taskId = 'cpt-cut';
    const j = makeJournal(taskId);
    await seed(j, taskId, EARLY_TOKENS);
    // turn one, the post-turn summarize (hangs until cut), turn two, then the one after turn two.
    const transport = new ScriptedTransport([text('answer one'), HANG, text('answer two'), SUMMARY]);
    const { events, holds, releases } = await twoTurns(taskId, j, transport, hangOrGiveUp(transport));
    const [end1, end2] = turnEndsOf(events);
    const window = between(events, end1!, end2!);

    expect(window.filter((e) => isRaw(e, SESSION_COMPACTED))).toHaveLength(0);
    const cut = rows(window, 'post_turn_compaction');
    expect(cut).toHaveLength(1);
    expect(cut[0]!.laneStatus).toBe('cancelled');
    // Mutation: report the cut with zero usage (the provider bills the request it was sent).
    expect(cut[0]!.usage.inputTokens).toBeGreaterThan(50_000);
    expect(holds).toBe(releases);
  });

  it('a real refusal: recorded, billed on the lane with no journal usage leg, and the next turn end does not pay again', async () => {
    flags({ post: true, idle: true });
    const taskId = 'cpt-refused';
    const j = makeJournal(taskId);
    await seed(j, taskId, EARLY_TOKENS);
    // The summarize returns, billed, with no text: the planner refuses (empty_summary).
    const transport = new ScriptedTransport([text('answer one'), [done()], text('answer two'), SUMMARY]);
    const { events } = await twoTurns(taskId, j, transport);

    const failed = events.filter((e) => isRaw(e, COMPACTION_FAILED));
    expect(failed).toHaveLength(1);
    const lane = rows(events, 'post_turn_compaction');
    expect(lane).toHaveLength(1);
    expect(lane[0]!.laneStatus).toBe('error');
    expect(lane[0]!.usage.inputTokens).toBe(1000);
    // Mutation: journal the usage leg too → the journal's cost total counts the laned money twice.
    const journal = await j.snapshot();
    expect(journal.filter((e) => e.payload.type === 'usage' && (e.payload as { source?: string }).source === 'compaction')).toHaveLength(0);
    expect(journal.filter((e) => e.payload.type === 'custom' && (e.payload as { key?: string }).key === 'compaction_failed')).toHaveLength(1);
    // Mutation: ignore the retry bound → turn two's end pays another summarize (a fourth call).
    expect(transport.calls).toBe(3);
  });

  it('a due compaction holds a waking message only until its bound, then the turn runs and its own round head compacts', async () => {
    flags({ post: true, idle: true });
    process.env.POST_TURN_COMPACT_TIMEOUT_MS = '400';
    const taskId = 'cpt-due';
    const j = makeJournal(taskId);
    // The estimate (160k) is under the budget, so turn one's round head does not compact; the
    // provider then counts that request at 185k, over it, so at the turn's end the check is due
    // (the trigger reads the provider's own count: compaction/trigger.ts measuredInputTokens).
    await seed(j, taskId, EARLY_TOKENS - 5_000);
    const transport = new ScriptedTransport([text('answer one', 185_000), HANG, SUMMARY, text('answer two')]);
    const { events, at } = await twoTurns(taskId, j, transport, hangOrGiveUp(transport));
    const [end1, end2] = turnEndsOf(events);
    const window = between(events, end1!, end2!);
    const trail = events.map((e) => (e.kind === 'raw' ? (e as { event?: string }).event : e.kind === 'usage' ? `usage:${(e as Row).lane}:${(e as Row).laneStatus}` : e.kind)).join(' ');

    expect(transport.calls, trail).toBe(4); // turn one, the post-turn summarize (hung), turn two's head summarize, turn two
    const cut = rows(window, 'post_turn_compaction');
    expect(cut, trail).toHaveLength(1);
    expect(cut[0]!.laneStatus).toBe('cancelled');
    // Held (not cut by the message) until the bound: the cut row lands at least the bound after turn one.
    expect(at.get(cut[0]!)! - at.get(end1!)!).toBeGreaterThanOrEqual(350);
    // Turn two's own round head then compacted, as it would have without the turn end.
    expect(rows(window, 'compaction').map((r) => r.compaction?.reason)).toEqual(['round_head']);
    expect(window.filter((e) => isRaw(e, SESSION_COMPACTED))).toHaveLength(1);
  });

  it('a Stop before the turn-end compaction began: no summarize goes out, no row, no charge', async () => {
    flags({ post: true, idle: true });
    const taskId = 'cpt-stopped';
    const j = makeJournal(taskId);
    await seed(j, taskId, EARLY_TOKENS);
    // A real provider never sees a request sent on a cut signal, yet it was billed at its ~150k-token
    // estimate (the #4264 re-check MED). This fake ignores the signal, so a sent one would compact.
    const transport = new ScriptedTransport([text('answer one'), text('answer two')]);
    const { events, holds, releases } = await twoTurns(taskId, j, transport, undefined, { stopAtFirstTurnEnd: true });
    // Mutation: drop both the run's early return and the pre-send check → one summarize request
    // (noCacheWrite marks it: COMPACTION_V2), a row and a compaction.
    expect(transport.noCacheWrites.filter(Boolean)).toHaveLength(0);
    expect(rows(events, 'post_turn_compaction')).toHaveLength(0);
    expect(events.filter((e) => isRaw(e, SESSION_COMPACTED))).toHaveLength(0);
    expect(holds).toBe(releases);
  });

  it('inline (no POST_TURN_OFF_PATH_V1): a message never waits on a turn-end compaction, because none runs', async () => {
    flags({ post: true, idle: false });
    const taskId = 'cpt-inline';
    const j = makeJournal(taskId);
    await seed(j, taskId, EARLY_TOKENS);
    const transport = new ScriptedTransport([text('answer one'), text('answer two')]);
    // The next message is there at once.
    const { events } = await twoTurns(taskId, j, transport, Promise.resolve());
    expect(events.filter((e) => isRaw(e, SESSION_COMPACTED))).toHaveLength(0);
    expect(rows(events, 'post_turn_compaction')).toHaveLength(0);
    expect(transport.calls).toBe(2);
  });

  it('off: nothing after the turn, and the next turn runs as today', async () => {
    flags({ post: false, idle: true });
    const taskId = 'cpt-off';
    const j = makeJournal(taskId);
    await seed(j, taskId, EARLY_TOKENS);
    const transport = new ScriptedTransport([text('answer')]);
    const { events, holds } = await twoTurns(taskId, j, transport);
    expect(events.filter((e) => isRaw(e, SESSION_COMPACTED))).toHaveLength(0);
    expect(rows(events, 'post_turn_compaction')).toHaveLength(0);
    expect(transport.calls).toBe(2);
    // No idle work was scheduled (no chip, no sweep, no compaction), so nothing holds the box.
    expect(holds).toBe(0);
  });

  it('under the share: a turn that ends well under budget does not compact', async () => {
    flags({ post: true, idle: true });
    const taskId = 'cpt-under';
    const j = makeJournal(taskId);
    await seed(j, taskId, 100_000);
    expect(100_000).toBeLessThan(BUDGET * POST_TURN_COMPACT_SHARE);
    const transport = new ScriptedTransport([text('answer')]);
    const { events } = await twoTurns(taskId, j, transport);
    expect(events.filter((e) => isRaw(e, SESSION_COMPACTED))).toHaveLength(0);
    expect(transport.calls).toBe(2);
  });

  it('every compaction is stamped for the O1 rail under the flag: a round-head one says round_head', async () => {
    for (const post of [true, false]) {
      for (const f of FLAGS) delete process.env[f];
      flags({ post, idle: false });
      const taskId = `cpt-head-${post}`;
      const j = makeJournal(taskId);
      await seed(j, taskId, 260_000); // over the 180k budget: the first round head compacts
      const transport = new ScriptedTransport([SUMMARY, text('answer')]);
      const { events } = await twoTurns(taskId, j, transport);
      const lane = rows(events, 'compaction');
      expect(lane.length).toBeGreaterThanOrEqual(1);
      // Mutation: drop the stamp → no `compaction` field; flag off must carry none (byte-identical).
      if (post) expect(lane[0]!.compaction).toMatchObject({ reason: 'round_head', strategy: 'local' });
      else expect('compaction' in lane[0]!).toBe(false);
    }
  });
});
