/**
 * UNIT B — reactive compact-on-overflow (self-healing).
 *
 * Compaction used to fire ONLY proactively at 80%; a round that terminated with a
 * `context_exceeded` outcome ended the turn with no recovery. These prove the
 * reactive path: a `context_exceeded` round runs the manual compaction path
 * (bypassing the 80% gate) ONCE per turn and retries the round.
 *
 *  - overflow → compact → retry → success (one extra summarize model call; the
 *    compaction cost is journaled source:'compaction').
 *  - overflow → compact → overflow → terminal context_exceeded (compaction runs
 *    exactly once; no loop).
 *  - no compaction configured → terminal context_exceeded immediately (no summarize).
 *  - an interrupt during the reactive compaction still seals user_aborted.
 */
import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeHarness } from '../native-harness.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { JournalEntry, NewEntry } from '../../contract/journal.js';
import type { ContentBlock } from '../../contract/blocks.js';
import type { HarnessContext, UserTurn } from '../../contract/harness.js';
import type { HarnessEvent } from '../../contract/events.js';
import type { TurnOutcome } from '../../contract/turn-outcome.js';
import type { NativeConfig } from '../native-config.js';

// Inlined literal (equals EVENTS.SESSION_COMPACTED; the SDK engine emits this raw
// event name — pinned equal to the product constant by the compaction conformance suite).
const SESSION_COMPACTED_EVENT = 'session:compacted';

function usage(costUsd: number): NormalizedUsage {
  return { inputTokens: 10, outputTokens: 5, costUsd } as NormalizedUsage;
}
function doneEvent(costUsd: number): StreamEvent {
  return { kind: 'done', stopReason: 'end_turn', usage: usage(costUsd) };
}

/** Marks the scripted error the transport classifies as a context overflow. */
const OVERFLOW = Symbol('overflow');
/** Marks a scripted step that aborts the run signal mid-compaction, then throws. */
const ABORT = Symbol('abort');
type Step = StreamEvent[] | typeof OVERFLOW | typeof ABORT;

class OverflowError extends Error {}

/**
 * Serves scripted model calls in order. A round can be a normal StreamEvent[], an
 * OVERFLOW (callModel throws an error classified as `context_exceeded`), or an ABORT
 * (aborts the shared controller, then throws — the interrupt-during-compaction case).
 */
class OverflowTransport extends FakeTransport {
  calls = 0;
  constructor(
    private readonly steps: Step[],
    private readonly controller?: AbortController,
  ) {
    super([]);
  }
  override callModel(): StreamEvent[] {
    const step = this.steps[Math.min(this.calls, this.steps.length - 1)];
    this.calls += 1;
    if (step === OVERFLOW) throw new OverflowError('prompt is too long: 250000 > 200000 tokens');
    if (step === ABORT) {
      this.controller?.abort();
      const err = new Error('Request was aborted.');
      err.name = 'AbortError';
      throw err;
    }
    return step;
  }
  override classifyError(err: unknown): TurnOutcome {
    if (err instanceof OverflowError) {
      return { kind: 'context_exceeded', raw: { subtype: 'context', errors: [] } };
    }
    return super.classifyError(err);
  }
  override computeCostUsd(u: NormalizedUsage): number {
    return (u as { costUsd?: number }).costUsd ?? 0;
  }
}

const base = (taskId: string): Omit<NewEntry, 'payload'> => ({
  taskId,
  rootTaskId: taskId,
  spawnDepth: 0,
  workspaceId: 'w',
  agentId: 'native',
  principal: { kind: 'agent', agentId: 'native' },
  timestamp: '',
});

function makeJournal(taskId: string): Journal {
  const path = join(tmpdir(), `reactive-${process.pid}-${Math.random().toString(36).slice(2)}`, `${taskId}.jsonl`);
  return new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(path),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2024-01-01T00:00:00.000Z'),
  });
}

/** Seed N real user/assistant turns so manual compaction has a valid turn-boundary cut. */
async function seedTurns(j: Journal, taskId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await j.append({
      ...base(taskId),
      principal: { kind: 'user', userId: 'u' },
      payload: { type: 'user', blocks: [{ type: 'text', text: `q${i}: some real earlier context` } as ContentBlock] },
    });
    await j.append({
      ...base(taskId),
      payload: {
        type: 'assistant',
        blocks: [{ type: 'text', text: `a${i}: an earlier answer worth summarizing` } as ContentBlock],
        api: 'anthropic_messages',
        provider: 'anthropic',
        model: 'fake-model',
      },
    });
  }
}

async function runOverflow(opts: {
  taskId: string;
  journal: Journal;
  steps: Step[];
  configureCompaction: boolean;
  controller?: AbortController;
}): Promise<{ events: HarnessEvent[]; transport: OverflowTransport }> {
  const transport = new OverflowTransport(opts.steps, opts.controller);
  const cfg = {
    onAttached: () => {},
    maxTurns: 10,
    transport,
    journal: opts.journal,
    // High threshold → proactive maybeCompact NEVER fires; only the reactive path
    // (which bypasses the gate) can compact. Isolates Unit B from the 80% trigger.
    ...(opts.configureCompaction ? { compaction: { thresholdPct: 0.99, keepWindowTokens: 50 } } : {}),
    ...(opts.controller ? { signal: opts.controller.signal } : {}),
  } as unknown as NativeConfig;
  const ctx: HarnessContext<NativeConfig> = {
    taskId: opts.taskId,
    sessionId: 's-reactive',
    cwd: '/tmp',
    model: 'fake-model',
    signal: opts.controller?.signal ?? new AbortController().signal,
    config: cfg,
  };
  const input = (async function* (): AsyncIterable<UserTurn> {
    yield { text: 'do the thing' };
  })();
  const events: HarnessEvent[] = [];
  for await (const ev of new NativeHarness().run(input, ctx)) events.push(ev);
  return { events, transport };
}

function terminal(events: HarnessEvent[]): Extract<HarnessEvent, { kind: 'turn_end' }> {
  const ends = events.filter((e): e is Extract<HarnessEvent, { kind: 'turn_end' }> => e.kind === 'turn_end');
  if (ends.length !== 1) throw new Error(`expected exactly one turn_end, got ${ends.length}`);
  return ends[0];
}
function compactions(events: HarnessEvent[]): HarnessEvent[] {
  return events.filter((e) => e.kind === 'raw' && (e as { event?: string }).event === SESSION_COMPACTED_EVENT);
}
async function usageEntries(j: Journal, source: string): Promise<JournalEntry[]> {
  const out: JournalEntry[] = [];
  for await (const e of j.read()) {
    if (e.payload.type !== 'usage') continue;
    if ((e.payload.raw as { source?: string } | undefined)?.source === source) out.push(e);
  }
  return out;
}

// RE-RULED by T9b fix round 3 (B-2): the seed is 6 turns, not 2. A recovery now sizes its
// window to `compaction.keepWindowTokens` — "make the next request fit" — instead of to the
// most recent turn, so a journal that ALREADY fits that window has nothing to gain by
// compacting and correctly refuses `no_valid_cut` (a 413 on such a journal is system + tools
// or images, not history). Two turns is ~36 tokens against a 50-token window; six exceeds it,
// so these tests exercise the recovery they are about. Nothing else in them changed.
describe('UNIT B — reactive compact-on-overflow', () => {
  it('overflow → compact → retry → success (one extra summarize call; cost journaled)', async () => {
    const taskId = 't-reactive-ok';
    const j = makeJournal(taskId);
    await seedTurns(j, taskId, 6);
    const { events, transport } = await runOverflow({
      taskId,
      journal: j,
      configureCompaction: true,
      // #1 overflow → reactive compaction; #2 summarize; #3 retry succeeds.
      steps: [OVERFLOW, [{ kind: 'text', text: 'REACTIVE SUMMARY' }, doneEvent(0.02)], [{ kind: 'text', text: 'done' }, doneEvent(0.01)]],
    });

    expect(transport.calls).toBe(3); // overflow + summarize + retry
    expect(terminal(events).outcome.kind).toBe('completed');
    expect(compactions(events)).toHaveLength(1); // exactly one SESSION_COMPACTED
    // The summarize call bills/journals like every other compaction path.
    const journaled = await usageEntries(j, 'compaction');
    expect(journaled).toHaveLength(1);
    const raw = (journaled[0].payload as { raw?: { costUsd?: number } }).raw;
    expect(raw?.costUsd).toBeCloseTo(0.02, 9);
    // Turn billing includes the summarize (0.02) + the retry round (0.01).
    expect(terminal(events).billing?.cumulativeCostUsd ?? 0).toBeCloseTo(0.03, 9);
  });

  it('overflow → compact → overflow → terminal context_exceeded (compaction runs once, no loop)', async () => {
    const taskId = 't-reactive-twice';
    const j = makeJournal(taskId);
    await seedTurns(j, taskId, 6);
    const { events, transport } = await runOverflow({
      taskId,
      journal: j,
      configureCompaction: true,
      // #1 overflow → compact; #2 summarize; #3 retry ALSO overflows → terminal.
      steps: [OVERFLOW, [{ kind: 'text', text: 'REACTIVE SUMMARY' }, doneEvent(0.02)], OVERFLOW],
    });

    expect(transport.calls).toBe(3); // overflow + summarize + overflow-retry (no 2nd compaction)
    expect(terminal(events).outcome.kind).toBe('context_exceeded');
    expect(compactions(events)).toHaveLength(1); // reactive compaction fired exactly once
  });

  it('no compaction configured → terminal context_exceeded immediately (no summarize)', async () => {
    const taskId = 't-reactive-unconfigured';
    const j = makeJournal(taskId);
    await seedTurns(j, taskId, 6);
    const { events, transport } = await runOverflow({
      taskId,
      journal: j,
      configureCompaction: false,
      steps: [OVERFLOW, [{ kind: 'text', text: 'never reached' }, doneEvent(0.01)]],
    });

    expect(transport.calls).toBe(1); // the overflow only — no reactive summarize
    expect(terminal(events).outcome.kind).toBe('context_exceeded');
    expect(compactions(events)).toHaveLength(0);
  });

  it('an interrupt during the reactive compaction still seals user_aborted', async () => {
    const taskId = 't-reactive-abort';
    const j = makeJournal(taskId);
    await seedTurns(j, taskId, 6);
    const controller = new AbortController();
    const { events, transport } = await runOverflow({
      taskId,
      journal: j,
      configureCompaction: true,
      controller,
      // #1 overflow → reactive compaction; #2 summarize aborts the signal + throws.
      steps: [OVERFLOW, ABORT, [{ kind: 'text', text: 'unreached' }, doneEvent(0.01)]],
    });

    expect(transport.calls).toBe(2); // overflow + the aborting summarize
    expect(terminal(events).outcome.kind).toBe('user_aborted');
    expect(compactions(events)).toHaveLength(0); // aborted before the splice/emit
  });
});
