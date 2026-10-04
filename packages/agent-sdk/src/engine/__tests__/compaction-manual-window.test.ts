/**
 * T9b fix round 1 — THE MANUAL KEEP-WINDOW MUST FIND A ROUND, NOT ONLY A USER TURN.
 *
 * T9b widened the planner's CUT to {user, assistant}, but `runManualCompaction` still
 * sized its keep-window from the last `user` entry onward. On the one-ask agentic shape
 * that entry IS the head (the ask; after a prior compaction, the summary), so the window
 * covered the WHOLE projection, the token walk never exceeded it, and the plan refused
 * with `no_valid_cut` — on every path that goes through it:
 *
 *   · the cold `/compact` control command,
 *   · the warm `/compact` control turn,
 *   · the DEFERRED-OVERFLOW / `context_exceeded` reactive recovery — the OOM path T9b
 *     exists to fix.
 *
 * The window is now "the most recent turn, or the most recent ROUND when the only `user`
 * entry is the head". A chat keeps the window it always had, byte for byte.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  runManualCompaction,
  runRecoveryCompaction,
  runCompaction,
  refusalEvents,
  foldRefusedCompactionSpend,
  compactAtRoundHead,
  COMPACTION_FAILED_EVENT,
  COMPACTION_MAX_TOKENS,
  COMPACTION_REASONING_HEADROOM_TOKENS,
  compactionMaxTokens,
  compactionUsageEvent,
  summarizeSpan,
  type CompactionDeps,
} from '../compaction-run.js';
import { armCompactionRetry, billedSpendOf, compactionRetryPending, inflightEstimateOf, openCompactionRetryForTurn } from '../compaction-refusal.js';
import { deterministicUsageId } from '../round-stream.js';
import { projectTokenCount, estimateTokens, CompactionPlanError } from '../../kernel/index.js';
import { recoverFromOverflow } from '../compaction-recovery.js';
import { recoverRoundFailure } from '../native-iterate-round.js';
import { FakeTransport, type StreamEvent, type NormalizedUsage } from '../transport.js';
import { Journal } from '../../kernel/journal/journal.js';
import { JsonlStore } from '../../kernel/journal/jsonl-store.js';
import { InMemorySessionStore } from '../../kernel/journal/session-store.js';
import { sequentialClock } from '../../kernel/journal/clock.js';
import type { JournalEntry, NewEntry } from '../../contract/journal.js';
import type { ContentBlock } from '../../contract/blocks.js';
import { fenceRecall } from '../recall.js';
import { COMPACTION_SPLIT_TURN_SECTION, isLiveSplitTurn } from '../../contract/compaction-prompt.js';
import { COMPACTION_SPLIT_TURN_CONTINUE_MARKER } from '../../contract/injected-user-text.js';
import { appendInjectedUserEntry } from '../native-journal.js';

const BODY = 'word '.repeat(400); // ~520 estimated tokens per entry

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

beforeEach(() => {
  process.env.COMPACTION_V2 = '1';
});
afterEach(() => {
  delete process.env.COMPACTION_V2;
});

const base = (taskId: string): Omit<NewEntry, 'payload'> => ({
  taskId,
  rootTaskId: taskId,
  spawnDepth: 0,
  workspaceId: 'w',
  agentId: 'native',
  principal: { kind: 'agent', agentId: 'native' },
  timestamp: '',
});

async function makeJournal(taskId: string): Promise<Journal> {
  const dir = await mkdtemp(join(tmpdir(), `t9b-manual-${process.pid}-`));
  dirs.push(dir);
  return new Journal({
    taskId,
    workspaceId: 'w',
    jsonl: new JsonlStore(join(dir, `${taskId}.jsonl`)),
    mirror: new InMemorySessionStore(),
    clock: sequentialClock('2024-01-01T00:00:00.000Z'),
  });
}

const user = (j: Journal, t: string, text: string) =>
  j.append({
    ...base(t),
    principal: { kind: 'user', userId: 'u' },
    payload: { type: 'user', blocks: [{ type: 'text', text } as ContentBlock] },
  });
const assistant = (j: Journal, t: string, text: string) =>
  j.append({
    ...base(t),
    payload: {
      type: 'assistant',
      blocks: [{ type: 'text', text } as ContentBlock],
      api: 'anthropic_messages',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    },
  });

/**
 * A Nami RECALL FENCE, through the PRODUCTION mint (`appendInjectedUserEntry`), so the
 * entry carries `payload.injected` exactly as a live journal's would. `stamped: false`
 * writes the same bytes WITHOUT the field — a journal from before it existed, which a
 * warm task carries across a deploy.
 */
const fence = (j: Journal, t: string, text: string, stamped = true) =>
  stamped
    ? appendInjectedUserEntry(
        j,
        { taskId: t, config: { runtimeConfig: { userId: 'u' } } } as never,
        fenceRecall(text),
        'engine',
      )
    : j.append({
        ...base(t),
        principal: { kind: 'user', userId: 'u' },
        payload: { type: 'user', blocks: [{ type: 'text', text: fenceRecall(text) } as ContentBlock] },
      });

/** ONE `user` entry (the ask), then `rounds` real rounds. The agentic shape. */
async function oneAskJournal(taskId: string, rounds: number): Promise<Journal> {
  const j = await makeJournal(taskId);
  await user(j, taskId, `the one ask ${BODY}`);
  for (let i = 0; i < rounds; i++) {
    await assistant(j, taskId, `step ${i} ${BODY}`);
    await j.append({
      ...base(taskId),
      payload: { type: 'tool_use', toolUseId: `tu-${i}`, name: 'Read', input: { path: `/f${i}` } },
    });
    await j.append({
      ...base(taskId),
      payload: {
        type: 'tool_result',
        toolUseId: `tu-${i}`,
        blocks: [{ type: 'text', text: `result ${i} ${BODY}` } as ContentBlock],
      },
    });
  }
  return j;
}

/** A CHAT that ENDS ON AN ASSISTANT entry — the shape a blind "last boundary" swap breaks. */
async function chatEndingOnAssistant(taskId: string, turns: number): Promise<Journal> {
  const j = await makeJournal(taskId);
  for (let i = 0; i < turns; i++) {
    await user(j, taskId, `q${i} ${BODY}`);
    await assistant(j, taskId, `a${i} ${BODY}`);
  }
  return j;
}

function summarizingTransport(summary: string): FakeTransport {
  class T extends FakeTransport {
    constructor() {
      super([
        { kind: 'text', text: summary },
        {
          kind: 'done',
          stopReason: 'end_turn',
          usage: { inputTokens: 500, outputTokens: 30 } as NormalizedUsage,
        } as StreamEvent,
      ]);
    }
    override computeCostUsd(): number {
      return 0.03;
    }
  }
  return new T();
}

function makeDeps(
  journal: Journal,
  taskId: string,
  transport: FakeTransport,
  compaction: Record<string, unknown> = {},
): CompactionDeps {
  const cfg = { journal, compaction, runtimeConfig: { sessionId: 's', userId: 'u' } };
  return {
    ctx: { taskId, model: 'claude-sonnet-4-5', config: cfg },
    transport,
    dispatcher: { dispatch: async () => [] },
    compactionBase: () => base(taskId),
    runSignal: () => new AbortController().signal,
  } as unknown as CompactionDeps;
}

/** The `compact_boundary`'s first-kept entry, read back off the journal. */
async function firstKeptEntry(j: Journal): Promise<JournalEntry> {
  const all = await j.snapshot();
  const boundary = all.find((e) => e.payload.type === 'compact_boundary')!;
  const id = (boundary.payload as { firstKeptId: string }).firstKeptId;
  return all.find((e) => e.uuid === id)!;
}

describe('runManualCompaction — the one-ask shape (RED before the fix: no_valid_cut)', () => {
  it('cuts at a ROUND boundary when the only `user` entry is the head', async () => {
    const taskId = 'manual-one-ask';
    const j = await oneAskJournal(taskId, 6);

    const result = await runManualCompaction(
      makeDeps(j, taskId, summarizingTransport('SUMMARY OF THE ASK')),
    );

    expect(result).not.toBeNull();
    const kept = await firstKeptEntry(j);
    // Pre-fix this path threw `no valid turn-boundary cut`. The window is now the most
    // recent ROUND, so the cut lands on that round's assistant entry.
    expect(kept.payload.type).toBe('assistant');
  });

  it('the `context_exceeded` reactive recovery now compacts instead of refusing', async () => {
    const taskId = 'manual-reactive';
    const j = await oneAskJournal(taskId, 6);
    const transport = summarizingTransport('SUMMARY OF THE ASK');
    // The PRODUCTION helper and a window this ~6,800-token journal exceeds. (At the 20k
    // default the journal fits and the recovery correctly declines — see the N-4 note.)
    const deps = makeDeps(j, taskId, transport, { keepWindowTokens: 2_000 });
    const cfg = deps.ctx.config;
    const rc = {
      billing: { cumulativeCostUsd: 0, parentOwnCostUsd: 0, roundCounter: { value: 2 } },
    };

    const recovery = await recoverFromOverflow({
      err: Object.assign(new Error('request too large'), { status: 413 }),
      ctx: deps.ctx,
      cfg,
      transport: transport as never,
      rc: rc as never,
      alreadyAttempted: false,
      runRecovery: () => runRecoveryCompaction(deps),
      onRefused: (err) => refusalEvents(deps, rc as never, 'manual', err),
      elision: null,
    });

    expect(recovery.attempted).toBe(true);
    expect(recovery.retry).toBe(true); // RED before the fix: the plan refused, so retry was false
    // …and the summarize it spent is folded into the turn's billing, as on any success.
    expect(rc.billing.cumulativeCostUsd).toBeGreaterThan(0);

    // ONCE, not once per round: the turn-scoped latch is what stops a compaction loop on a
    // journal that is still too big for the model after the cut.
    const second = await recoverFromOverflow({
      err: Object.assign(new Error('request too large'), { status: 413 }),
      ctx: deps.ctx,
      cfg,
      transport: transport as never,
      rc: rc as never,
      alreadyAttempted: true,
      runRecovery: () => runRecoveryCompaction(deps),
      onRefused: async () => [],
      elision: null,
    });
    expect(second.attempted).toBe(false);
    expect(second.retry).toBe(false);
  });
});

describe('runManualCompaction — the CHAT window is unchanged (equivalence pin)', () => {
  it('a chat ending on an assistant entry keeps the same window: the cut is its last `user` entry', async () => {
    const taskId = 'manual-chat';
    const j = await chatEndingOnAssistant(taskId, 3);

    // Captured BEFORE the compaction: the splice appends the summary as its own `user`
    // entry, so "the last user entry" is a different entry afterwards.
    const before = (await j.project()).messages;
    const lastUserBefore = [...before].reverse().find((e) => e.payload.type === 'user')!;

    const result = await runManualCompaction(
      makeDeps(j, taskId, summarizingTransport('SUMMARY OF EARLIER WORK')),
    );

    expect(result).not.toBeNull();
    const kept = await firstKeptEntry(j);
    // The window is sized from the LAST `user` entry, exactly as before T9b. A blind swap
    // to "the last boundary of either kind" would size it from the trailing ASSISTANT
    // instead — a strictly smaller window that keeps LESS context.
    expect(kept.payload.type).toBe('user');
    expect(kept.uuid).toBe(lastUserBefore.uuid);
  });
});

// ─── A REFUSAL AFTER A BILLED SUMMARIZE IS RECORDED, AND ITS SPEND IS KEPT ────────
//
// `summarizeSpan` is a real, billed model call. When `planCompaction` then refuses —
// Hermes's `summary_not_smaller` guard is the reachable case, on a short `/compact`
// span — the throw used to discard the accumulated cost and usage: the money was spent,
// the live ledger was charged, and nothing reached `turn_end.billing` or the journal.
// "Meter every cost surface" says a billed call may never vanish.

describe('a compaction refused AFTER its summarize still meters what it spent', () => {
  /** A chat whose manual window leaves a ONE-TOKEN dropped span — the guard's case. */
  async function tinySpanJournal(taskId: string): Promise<Journal> {
    const j = await makeJournal(taskId);
    await user(j, taskId, 'u0'); // the entire dropped span: ~1 token
    await user(j, taskId, `q ${BODY}`);
    await assistant(j, taskId, `a ${BODY}`);
    return j;
  }

  it('records the refusal by name, journals the summarize usage, and folds its cost', async () => {
    const taskId = 'refused-but-billed';
    const j = await tinySpanJournal(taskId);
    // A summary far larger than the 1-token span it would replace → summary_not_smaller.
    // The window is 1,042 (exactly the last two entries) so a cut EXISTS and the summarize
    // actually runs — at the 20k default the whole journal fits and the recovery declines
    // for free, which would make "it still meters what it spent" vacuous.
    const transport = summarizingTransport('S'.repeat(400));
    const deps = makeDeps(j, taskId, transport, { keepWindowTokens: 1_042 });
    const rc = {
      billing: { cumulativeCostUsd: 0, parentOwnCostUsd: 0, roundCounter: { value: 2 } },
    };

    const recovery = await recoverFromOverflow({
      err: Object.assign(new Error('request too large'), { status: 413 }),
      ctx: deps.ctx,
      cfg: deps.ctx.config,
      transport: transport as never,
      rc: rc as never,
      alreadyAttempted: false,
      runRecovery: () => runRecoveryCompaction(deps),
      // VERBATIM what native-iterate-round.ts passes, BOTH fields. A slot named `runRecovery`
      // that was handed the MANUAL helper is exactly how B-2 hid; nothing here reads the
      // opposite of what it does. `onRefused` is REQUIRED, so tsc stops a caller dropping it.
      onRefused: (err) => refusalEvents(deps, rc as never, 'manual', err),
      elision: null,
    });

    expect(recovery.attempted).toBe(true);
    expect(recovery.retry).toBe(false); // the compaction really was refused

    const all = await j.snapshot();
    // 1. The refusal is NAMED and durable (was: console.warn only).
    const failure = all.find(
      (e) => (e.payload as { key?: string }).key === 'compaction_failed',
    );
    expect(failure).toBeDefined();
    expect((failure!.payload as { data: { reason: string } }).data.reason).toBe('summary_not_smaller');

    // 2. The billed summarize lands in the journal on the `compaction` lane
    //    (appendUsageEntry nests the accounting under `payload.raw`).
    const usage = all.find(
      (e) => (e.payload as { raw?: { source?: string } }).raw?.source === 'compaction',
    );
    expect(usage).toBeDefined();
    expect((usage!.payload as { raw: { costUsd: number } }).raw.costUsd).toBeGreaterThan(0);

    // 3. …and in the turn's accumulators, exactly as a successful compaction would.
    expect(rc.billing.cumulativeCostUsd).toBeGreaterThan(0);
    expect(rc.billing.parentOwnCostUsd).toBe(rc.billing.cumulativeCostUsd);
  });
});

describe('runManualCompaction — a SHORT conversation still has nothing to compact', () => {
  it('refuses on a one-ask journal with a SINGLE round: the ask alone is not worth summarizing', async () => {
    // The ROUND fallback needs a whole round on the dropped side. With one round the only
    // thing there is the user's own words — replacing them with a model summary while
    // keeping the reply is strictly worse than the "nothing to compact yet" notice.
    const taskId = 'manual-single-round';
    const j = await oneAskJournal(taskId, 1);

    const err = await runManualCompaction(
      makeDeps(j, taskId, summarizingTransport('SUMMARY')),
    ).catch((e: unknown) => e);

    expect((err as { reason?: string }).reason).toBe('no_valid_cut');
  });
});

// ─── S-R1: the RECOVERY window is "make it fit", not "keep the current turn" ──────
//
// The two recovery callers — the deferred-overflow latch and the reactive
// `context_exceeded` handler — were sharing the MANUAL window, which is a UX rule ("keep
// what you were just doing"). On the ordinary long task that is far too much to keep: the
// retry ships almost the whole projection again and overflows a second time, and the turn
// dies of the very error the recovery exists to clear. They now size the window the AUTO
// trigger does, so the point is to make the next request FIT.

/** The ordinary shape: one ask, a round, a STEER, then more rounds. Two `user` entries, so
 *  the manual rule sizes the window from the steer onward — nearly the whole journal. */
async function askSteerRounds(taskId: string, roundsAfter: number): Promise<Journal> {
  const j = await makeJournal(taskId);
  await user(j, taskId, `the one ask ${BODY}`);
  await assistant(j, taskId, `step 0 ${BODY}`);
  await j.append({
    ...base(taskId),
    payload: { type: 'tool_use', toolUseId: 'tu-0', name: 'Read', input: { path: '/f0' } },
  });
  await j.append({
    ...base(taskId),
    payload: { type: 'tool_result', toolUseId: 'tu-0', blocks: [{ type: 'text', text: `result 0 ${BODY}` } as ContentBlock] },
  });
  await user(j, taskId, `actually, also check this ${BODY}`); // the steer
  for (let i = 1; i <= roundsAfter; i++) {
    await assistant(j, taskId, `step ${i} ${BODY}`);
    await j.append({
      ...base(taskId),
      payload: { type: 'tool_use', toolUseId: `tu-${i}`, name: 'Read', input: { path: `/f${i}` } },
    });
    await j.append({
      ...base(taskId),
      payload: { type: 'tool_result', toolUseId: `tu-${i}`, blocks: [{ type: 'text', text: `result ${i} ${BODY}` } as ContentBlock] },
    });
  }
  return j;
}

describe('the recovery window makes the retry FIT (RED: it kept almost everything)', () => {
  it('an ask + a steer + 6 rounds: the retry is inside the compaction window, not just non-empty', async () => {
    const taskId = 'recovery-steer';
    const j = await askSteerRounds(taskId, 6);
    const transport = summarizingTransport('SUMMARY OF EARLIER WORK');
    // The window the AUTO trigger uses — small, because the point is to fit.
    const deps = makeDeps(j, taskId, transport, { keepWindowTokens: 2_000 });
    const rc = { billing: { cumulativeCostUsd: 0, parentOwnCostUsd: 0, roundCounter: { value: 2 } } };

    const recovery = await recoverFromOverflow({
      err: Object.assign(new Error('request too large'), { status: 413 }),
      ctx: deps.ctx,
      cfg: deps.ctx.config,
      transport: transport as never,
      rc: rc as never,
      alreadyAttempted: false,
      runRecovery: () => runRecoveryCompaction(deps),
      onRefused: async () => [],
      elision: null,
    });

    expect(recovery.retry).toBe(true);
    // THE POINT: what survives must fit the window. Pre-fix this kept ~6,330 of 7,878 tokens
    // and the retry overflowed again.
    const kept = projectTokenCount((await j.project()).messages).messages;
    expect(kept).toBeLessThanOrEqual(2_000);
  });

  it('an ask + ONE round still compacts — the manual rule refused it outright', async () => {
    const taskId = 'recovery-one-round';
    const j = await oneAskJournal(taskId, 1);
    const transport = summarizingTransport('SUMMARY OF THE ASK');
    // [ask 520, assistant 520, tool_use 3, tool_result 520]. A window of 1,200 holds the
    // ROUND but not the ask, so cutting at the assistant is what fits — the case the manual
    // rule refused outright. (A window larger than the whole journal refuses, correctly:
    // there is nothing to gain by compacting a journal that already fits.)
    const deps = makeDeps(j, taskId, transport, { keepWindowTokens: 1_200 });

    const result = await runRecoveryCompaction(deps);

    expect(result).not.toBeNull();
    const kept = await firstKeptEntry(j);
    expect(kept.payload.type).toBe('assistant');
  });
});

// ─── S-R3: the refusal's BILLED spend must reach the re-price leg ─────────────────
//
// The server re-prices from the socket's usage EVENTS (`task_turn_usage`), never from journal
// entries — so a billed-then-refused compaction reached the accumulator and the journal but
// was invisible to billing. It now emits the same `compaction`-lane usage event a success
// does, with an id that cannot collide with that success in the same round.

describe('a refused-after-summarize compaction emits its usage EVENT, not just the journal leg', () => {
  /** Drive a refusal that has already paid for a summarize (Hermes's guard). */
  async function refusalWithSpend(taskId: string): Promise<{ err: unknown; deps: CompactionDeps; rc: { billing: { cumulativeCostUsd: number; parentOwnCostUsd: number; roundCounter: { value: number } } } }> {
    const j = await makeJournal(taskId);
    await user(j, taskId, 'u0'); // the whole dropped span: ~1 token
    await user(j, taskId, `q ${BODY}`);
    await assistant(j, taskId, `a ${BODY}`);
    const deps = makeDeps(j, taskId, summarizingTransport('S'.repeat(400)), {
      keepWindowTokens: 1_042,
    });
    const rc = { billing: { cumulativeCostUsd: 0, parentOwnCostUsd: 0, roundCounter: { value: 4 } } };
    const err = await runManualCompaction(deps).catch((e: unknown) => e);
    return { err, deps, rc };
  }

  it('emits a `compaction`-lane usage event whose id cannot collide with a SUCCESS in the same round', async () => {
    const taskId = 'refusal-usage-event';
    const { err, deps, rc } = await refusalWithSpend(taskId);
    expect((err as { reason?: string }).reason).toBe('summary_not_smaller');

    const events = await refusalEvents(deps, rc as never, 'manual', err);

    const usage = events.find((e) => e.kind === 'usage') as
      | { lane: string; usage: { inputTokens: number; outputTokens: number }; messageId: string }
      | undefined;
    expect(usage).toBeDefined();
    expect(usage!.lane).toBe('compaction'); // the lane the repricer reads stays `compaction`
    expect(usage!.usage.inputTokens).toBeGreaterThan(0);

    // THE COLLISION: `deterministicUsageId(taskId, round, lane)` is what
    // `agent-usage-handler.ts` de-duplicates on. A refused recovery that falls through to a
    // SUCCESSFUL `maybeCompact` puts both in one round — if the ids matched, one row (possibly
    // the success) would be silently dropped.
    const successId = deterministicUsageId(taskId, 4, 'compaction');
    expect(usage!.messageId).not.toBe(successId);
  });

  it('a deferred (manual) refusal and an auto refusal in ONE round get different ids', async () => {
    // The fall-through puts both in the same round: the deferred recovery refuses, then the
    // proactive trigger refuses. Without the TRIGGER in the id they would collide and
    // `agent-usage-handler` would elide the second row — the same under-billing the
    // success-vs-refusal discriminator exists to prevent.
    const taskId = 'refusal-ids-by-trigger';
    const a = await refusalWithSpend(taskId);
    const manual = await refusalEvents(a.deps, a.rc as never, 'manual', a.err);

    const b = await refusalWithSpend(`${taskId}-2`);
    // Same task id and round as the first, so ONLY the trigger differs.
    (b.deps.ctx as { taskId: string }).taskId = taskId;
    const auto = await refusalEvents(b.deps, b.rc as never, 'auto', b.err);

    const idOf = (evts: Awaited<ReturnType<typeof refusalEvents>>): string =>
      (evts.find((e) => e.kind === 'usage') as { messageId: string }).messageId;
    expect(idOf(manual)).not.toBe(idOf(auto));
  });

  // Review of #4284, LOW-4: a refused recovery was recorded `manual` while its own PreCompact input
  // and boundary said `auto`. It now records `auto`, and the site keeps the usage ids apart.
  it('a refused recovery records the auto trigger, and the four refusal sites keep four usage ids in one round', async () => {
    const taskId = 'refusal-ids-by-site';
    const ids: string[] = [];
    let recoveryTrigger: unknown;
    for (const [trigger, site] of [['auto', undefined], ['manual', undefined], ['auto', 'recovery'], ['auto', 'reactive']] as const) {
      const r = await refusalWithSpend(`${taskId}-${site ?? trigger}`);
      (r.deps.ctx as { taskId: string }).taskId = taskId; // same task and round: only the site differs
      const events = await refusalEvents(r.deps, r.rc as never, trigger, r.err, site);
      ids.push((events.find((e) => e.kind === 'usage') as { messageId: string }).messageId);
      if (site === 'recovery') recoveryTrigger = (events[0] as { data?: { trigger?: unknown } }).data?.trigger;
    }
    expect(new Set(ids).size).toBe(4);
    expect(recoveryTrigger).toBe('auto');
  });

  it('folding the same refusal twice bills it ONCE', async () => {
    const taskId = 'fold-once';
    const { err, rc } = await refusalWithSpend(taskId);

    foldRefusedCompactionSpend(rc as never, err);
    const afterFirst = rc.billing.cumulativeCostUsd;
    expect(afterFirst).toBeGreaterThan(0);

    foldRefusedCompactionSpend(rc as never, err);
    expect(rc.billing.cumulativeCostUsd).toBe(afterFirst);
    expect(rc.billing.parentOwnCostUsd).toBe(afterFirst);
  });
});

// ─── NEW-R1: the deferred fall-through must not DROP the first refusal's events ───
//
// `compactAtRoundHead` records the deferred recovery's refusal, then falls through to
// `maybeCompact`. But `maybeCompact` uses the SAME window over the SAME projection, so if
// the recovery refused and the ledger is still over the trigger it refuses IDENTICALLY —
// this is the ordinary case, not a race. Awaiting it inside the returned object literal
// meant its throw escaped and the first refusal's events went with it: two paid summarizes,
// one reaching the re-price leg.

describe('a deferred refusal followed by a proactive refusal yields BOTH records', () => {
  it('carries the first refusal\'s events out with the second\'s (RED: the throw dropped them)', async () => {
    const taskId = 'double-refusal';
    // A journal whose dropped span is ~1 token but whose summary is long: BOTH the recovery
    // and the proactive trigger refuse with `summary_not_smaller`, after paying to summarize.
    const j = await makeJournal(taskId);
    await user(j, taskId, 'u0');
    await user(j, taskId, `q ${BODY}`);
    await assistant(j, taskId, `a ${BODY}`);

    const transport = summarizingTransport('S'.repeat(400));
    // 1,042 = exactly the last two entries ('q '+BODY and 'a '+BODY, 521 each), so the cut
    // lands on entry 1 and the dropped span is the 1-token 'u0' alone. Both passes therefore
    // SUMMARIZE (paying 0.03 each) and only then hit Hermes's guard — otherwise one would
    // refuse for free and the "both usage events" half of this pin would be vacuous.
    // thresholdPct 0.0001 puts `maybeCompact` over the trigger so it really runs.
    const deps = makeDeps(j, taskId, transport, { keepWindowTokens: 1_042, thresholdPct: 0.0001 });
    const rc = {
      pendingOverflow: { model: 'claude-sonnet-4-5', seq: 0 },
      billing: { cumulativeCostUsd: 0, parentOwnCostUsd: 0, roundCounter: { value: 3 } },
    };

    const head = await compactAtRoundHead(deps, rc as never, 'system', [], null);

    expect(head.result).toBeNull();
    // S-1 RE-RULE: after `summary_not_smaller` the fall-through is SKIPPED. The recovery
    // window equals the auto window, so `maybeCompact` would re-plan the identical cut over
    // the identical projection and pay a SECOND summarize for the identical refusal. Exactly
    // one refusal, one paid summarize, one set of events.
    const refusals = head.pendingEvents.filter(
      (e) => e.kind === 'raw' && (e as { event: string }).event === COMPACTION_FAILED_EVENT,
    );
    expect(refusals).toHaveLength(1);
    expect((refusals[0] as { data: { reason: string } }).data.reason).toBe('summary_not_smaller');
    expect(head.pendingEvents.filter((e) => e.kind === 'usage')).toHaveLength(1);
    expect(rc.billing.cumulativeCostUsd).toBeCloseTo(0.03, 9); // ONE summarize, not two
  });

  it('still falls through — carrying the first refusal\'s events — when a re-plan could change the answer', async () => {
    // `no_valid_cut` attaches no spend and a re-plan CAN differ (the proactive path measures
    // the ledger, not just the window), so the fall-through stands and both refusals' events
    // must survive it. This is the never-drop half of NEW-R1.
    const taskId = 'double-refusal-no-cut';
    const j = await makeJournal(taskId);
    await user(j, taskId, `only the ask ${BODY}`);

    const transport = summarizingTransport('SUMMARY');
    const deps = makeDeps(j, taskId, transport, { keepWindowTokens: 20_000, thresholdPct: 0.0001 });
    const rc = {
      pendingOverflow: { model: 'claude-sonnet-4-5', seq: 0 },
      billing: { cumulativeCostUsd: 0, parentOwnCostUsd: 0, roundCounter: { value: 3 } },
    };

    const head = await compactAtRoundHead(deps, rc as never, 'system', [], null);

    expect(head.result).toBeNull();
    const refusals = head.pendingEvents.filter(
      (e) => e.kind === 'raw' && (e as { event: string }).event === COMPACTION_FAILED_EVENT,
    );
    expect(refusals).toHaveLength(2); // the deferred one AND the proactive one
    for (const r of refusals) {
      expect((r as { data: { reason: string } }).data.reason).toBe('no_valid_cut');
    }
    expect(rc.billing.cumulativeCostUsd).toBe(0); // neither paid: no cut, no summarize
  });
});

// ─── B-2: the PRODUCTION WIRING, not an injected helper (Ruling 75) ──────────────
//
// My round-2 pin passed `runRecoveryCompaction` into `recoverFromOverflow` by hand. That
// proved the helper and nothing about the wiring — and the wiring was still passing the
// MANUAL window, so the reactive `context_exceeded` path (the one a 413 actually takes) kept
// the whole projection and the retry overflowed again. This drives `recoverRoundFailure`,
// which is what the round loop calls, and asserts what survives FITS.

describe('recoverRoundFailure — the reactive 413 path, driven through the real generator', () => {
  it('compacts to inside the window on the ordinary ask+steer+rounds shape', async () => {
    const taskId = 'wiring-reactive';
    const j = await askSteerRounds(taskId, 6);
    const transport = summarizingTransport('SUMMARY OF EARLIER WORK');
    const compactionDeps = makeDeps(j, taskId, transport, { keepWindowTokens: 2_000 });
    const rc = {
      billing: { cumulativeCostUsd: 0, parentOwnCostUsd: 0, roundCounter: { value: 2 } },
      elision: null,
      elisionCut: null,
    };
    const deps = {
      ctx: compactionDeps.ctx,
      cfg: compactionDeps.ctx.config,
      transport,
      rc,
      elision: null,
      makeCompactionDeps: () => compactionDeps,
      runSignal: () => new AbortController().signal,
    };

    const gen = recoverRoundFailure(
      deps as never,
      Object.assign(new Error('request too large'), { status: 413 }),
      { inToolBatch: false } as never,
      [],
      {} as never,
      async () => undefined,
      false, // not yet attempted this turn
      [],
      'continuation' as never,
    );
    let result: { stop?: string } | undefined;
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        result = next.value as { stop?: string };
        break;
      }
    }

    // The round continues (the recovery healed it) …
    expect(result?.stop).toBe('continue');
    // … and what survived FITS the window, which is the whole point of a recovery.
    // Pre-fix this kept ~62,490 of 78,078 tokens and the retry overflowed again.
    const kept = projectTokenCount((await j.project()).messages).messages;
    expect(kept).toBeLessThanOrEqual(2_000);
  });
});

// ─── D4: an engine-minted user entry is not a turn ───────────────────────────
//
// Staging task 7f3c560a, runner build e4bb8de3e. `/compact` on a two-entry chat whose
// journal was [custom, user(ask), user(recall fence), assistant("ok")]. `manualKeepIndex`
// took the FENCE as "the last user turn" (lastUserIdx = 1 > 0), sized the window from it,
// left the user's 10-token ask as the whole dropped span, RAN a summarize (579 in / 632
// out, $0.00087) and then refused `summary_not_smaller` (185 tok >= 10). The refusal
// record itself was correct — the T9b legs work. The WINDOW was wrong.

describe('runManualCompaction — D4: the recall fence is not the last user turn', () => {
  it('refuses `no_valid_cut` and makes ZERO model calls on D4\'s exact shape', async () => {
    const taskId = 'd4-fence-window';
    const j = await makeJournal(taskId);
    await user(j, taskId, 'summarise the last 3 emails from stripe');
    await fence(j, taskId, 'keshav is in delhi; prefers IST timestamps');
    await assistant(j, taskId, 'ok');

    const transport = summarizingTransport('A SUMMARY NOBODY SHOULD HAVE PAID FOR');
    await expect(runManualCompaction(makeDeps(j, taskId, transport))).rejects.toMatchObject({
      reason: 'no_valid_cut',
    });
    // THE MONEY LEG. Pre-fix this shape billed a real summarize before Hermes refused it.
    expect(transport.systems).toHaveLength(0);
  });

  it('refuses identically when the fence predates `payload.injected` (byte fallback)', async () => {
    // A warm task resumes across a deploy; its earlier entries can never gain the field.
    const taskId = 'd4-fence-unstamped';
    const j = await makeJournal(taskId);
    await user(j, taskId, 'summarise the last 3 emails from stripe');
    await fence(j, taskId, 'keshav is in delhi; prefers IST timestamps', false);
    await assistant(j, taskId, 'ok');

    const transport = summarizingTransport('A SUMMARY NOBODY SHOULD HAVE PAID FOR');
    await expect(runManualCompaction(makeDeps(j, taskId, transport))).rejects.toMatchObject({
      reason: 'no_valid_cut',
    });
    expect(transport.systems).toHaveLength(0);
  });

  it('a chat sizes its window from the last REAL turn, not a fence appended after it', async () => {
    // EQUIVALENCE, stated as the difference it makes: with the fence counted as a turn
    // the window was [fence] alone and the cut landed one turn too late.
    const taskId = 'd4-chat-fence';
    const j = await makeJournal(taskId);
    await user(j, taskId, `q0 ${BODY}`);
    await assistant(j, taskId, `a0 ${BODY}`);
    await user(j, taskId, `q1 ${BODY}`);
    await assistant(j, taskId, `a1 ${BODY}`);
    await fence(j, taskId, 'a late hit');

    const result = await runManualCompaction(
      makeDeps(j, taskId, summarizingTransport('SUMMARY OF EARLIER WORK')),
    );

    expect(result).not.toBeNull();
    const kept = await firstKeptEntry(j);
    // q1 — the most recent REAL turn. Pre-fix the window started at the fence, so the
    // walk reached back only as far as a0 and cut there instead.
    expect(kept.payload.type).toBe('user');
    expect((kept.payload as { blocks: Array<{ text: string }> }).blocks[0].text).toContain('q1');
  });
});

describe('splitTurn — D4: a cut landing ON a fence is a SPLIT turn', () => {
  it('tells the summarize prompt the turn was split, and mints the continuation marker', async () => {
    // The fence stays a legal CUT BOUNDARY — it heads a wire request fine — but the
    // retained span it opens holds no user message, so the turn IS split. Before the
    // predicate, `firstKept.payload.type !== 'user'` said otherwise: no split-turn
    // clause, and (T9c) no continuation marker on the very shape that needs it.
    const taskId = 'd4-split-on-fence';
    const j = await makeJournal(taskId);
    await user(j, taskId, `the one ask ${BODY}`);
    await assistant(j, taskId, `step 0 ${BODY}`);
    await j.append({
      ...base(taskId),
      payload: { type: 'tool_use', toolUseId: 'tu-0', name: 'Read', input: { path: '/f0' } },
    });
    await j.append({
      ...base(taskId),
      payload: {
        type: 'tool_result',
        toolUseId: 'tu-0',
        blocks: [{ type: 'text', text: `result 0 ${BODY}` } as ContentBlock],
      },
    });
    await fence(j, taskId, `a big recall hit ${BODY}`);
    await assistant(j, taskId, `step 1 ${BODY}`);
    await j.append({
      ...base(taskId),
      payload: { type: 'tool_use', toolUseId: 'tu-1', name: 'Read', input: { path: '/f1' } },
    });
    await j.append({
      ...base(taskId),
      payload: {
        type: 'tool_result',
        toolUseId: 'tu-1',
        blocks: [{ type: 'text', text: `result 1 ${BODY}` } as ContentBlock],
      },
    });

    const transport = summarizingTransport('SUMMARY OF THE PREFIX');
    // Sized so the backward walk stops ON the fence (asserted below, so a drift in the
    // arithmetic fails loudly rather than passing on a different cut).
    const result = await runRecoveryCompaction(makeDeps(j, taskId, transport, { keepWindowTokens: 1_800 }));

    expect(result).not.toBeNull();
    const kept = await firstKeptEntry(j);
    expect(kept.payload.type).toBe('user');
    expect((kept.payload as { blocks: Array<{ text: string }> }).blocks[0].text).toContain('recalled_memory');
    // The split-turn clause reached the model.
    expect(transport.systems.some((sys) => sys.includes(COMPACTION_SPLIT_TURN_SECTION))).toBe(true);
    // …and the resume carries the T9c marker.
    const all = await j.snapshot();
    expect(
      all.some(
        (e) =>
          e.payload.type === 'user' &&
          (e.payload as { blocks: Array<{ text?: string }> }).blocks.some(
            (b) => b.text === COMPACTION_SPLIT_TURN_CONTINUE_MARKER,
          ),
      ),
    ).toBe(true);
  });
});

describe('the continuation marker is minted only when a turn actually RESUMES', () => {
  const hasMarker = async (j: Journal): Promise<boolean> =>
    (await j.snapshot()).some(
      (e) =>
        e.payload.type === 'user' &&
        (e.payload as { blocks: Array<{ text?: string }> }).blocks.some(
          (b) => b.text === COMPACTION_SPLIT_TURN_CONTINUE_MARKER,
        ),
    );

  it('a manual `/compact` on a one-ask journal splits a turn but mints NOTHING', async () => {
    // `/compact` is a CONTROL turn: it ends immediately and nothing resumes. On the
    // one-ask shape the cut still lands on an assistant, so `plan.splitTurn` is true —
    // and gating the mint on that alone left the journal with a standing "do not end
    // the turn until the original request is complete" as its last user-role entry,
    // with the user's NEXT real message landing after it.
    const taskId = 'manual-compact-no-marker';
    const j = await oneAskJournal(taskId, 6);

    const result = await runManualCompaction(
      makeDeps(j, taskId, summarizingTransport('SUMMARY OF THE ASK')),
    );

    expect(result).not.toBeNull();
    // The cut really did split a turn, or this leg would pass for the wrong reason.
    expect((await firstKeptEntry(j)).payload.type).toBe('assistant');
    expect(await hasMarker(j)).toBe(false);
  });

  it('the RECOVERY compaction on the same journal DOES mint it — the turn is mid-flight', async () => {
    // The negative control for the gate. `runRecoveryCompaction` is the deferred-overflow
    // latch and the reactive `context_exceeded` handler: both fire inside a live turn that
    // is about to re-issue its round, which is exactly the case the marker exists for.
    // A gate keyed on `trigger` alone would get this path wrong: since X1 both run on
    // `trigger: 'auto'`, the proactive trigger's own.
    const taskId = 'recovery-compact-marker';
    const j = await oneAskJournal(taskId, 6);

    const result = await runRecoveryCompaction(
      makeDeps(j, taskId, summarizingTransport('SUMMARY OF THE ASK'), { keepWindowTokens: 2_000 }),
    );

    expect(result).not.toBeNull();
    expect((await firstKeptEntry(j)).payload.type).toBe('assistant');
    expect(await hasMarker(j)).toBe(true);
  });

  it('the compaction RECORD counts the marker in postTokens', async () => {
    // The record is read as truth elsewhere. `plan.postTokens` is computed before the
    // marker exists, so a record that took it verbatim under-reported the projection it
    // describes by the marker's own bytes.
    const withTaskId = 'postTokens-with-marker';
    const withJ = await oneAskJournal(withTaskId, 6);
    await runRecoveryCompaction(
      makeDeps(withJ, withTaskId, summarizingTransport('SUMMARY OF THE ASK'), { keepWindowTokens: 2_000 }),
    );

    const withoutTaskId = 'postTokens-no-marker';
    const withoutJ = await oneAskJournal(withoutTaskId, 6);
    await runManualCompaction(
      makeDeps(withoutJ, withoutTaskId, summarizingTransport('SUMMARY OF THE ASK'), { keepWindowTokens: 2_000 }),
    );

    const postOf = async (j: Journal): Promise<number> =>
      ((await j.snapshot()).find((e) => e.payload.type === 'compact_boundary')!.payload as {
        postTokens: number;
      }).postTokens;

    // Same journal, same summary, same window — the ONLY difference is the marker.
    expect(await postOf(withJ)).toBe(
      (await postOf(withoutJ)) + estimateTokens(COMPACTION_SPLIT_TURN_CONTINUE_MARKER),
    );
  });
});

describe('B1/S1 — the marker asserts a precondition, so it is minted only when that holds', () => {
  const markersIn = async (j: Journal): Promise<number> =>
    (await j.snapshot()).filter(
      (e) =>
        e.payload.type === 'user' &&
        (e.payload as { blocks: Array<{ text?: string }> }).blocks.some(
          (b) => b.text === COMPACTION_SPLIT_TURN_CONTINUE_MARKER,
        ),
    ).length;

  it('B1 — a compaction at round 0 of a NEW turn keeps the fresh ask, so NO marker is minted', async () => {
    // THE ADVERSARY'S HISTORY. A turn ends on a text reply, so it has no next round head:
    // the previous turn's growth is only noticed at the NEXT turn's first head. The cut
    // then lands inside the COMPLETED previous turn — `splitTurn` is true — while the
    // user's fresh ask sits in the RETAINED span. A marker there tells the model to
    // continue the previous request, immediately after the user asked for something else.
    //
    // `plan.splitTurn` never meant "the LIVE turn was split", and `resumesTurn` cannot see
    // this either: the round head genuinely is mid-run. Only the retained span can answer.
    const taskId = 'b1-round-zero';
    const j = await oneAskJournal(taskId, 6);
    await assistant(j, taskId, 'DONE 30 — every file has been read.');
    await user(j, taskId, 'now list the migrations folder');

    const result = await runRecoveryCompaction(
      makeDeps(j, taskId, summarizingTransport('SUMMARY OF TURN 1'), { keepWindowTokens: 2_000 }),
    );

    expect(result).not.toBeNull();
    // The cut really did land inside the completed turn, or this leg proves nothing.
    expect((await firstKeptEntry(j)).payload.type).toBe('assistant');
    // …and the fresh ask survived it, which is the whole reason no marker is due.
    const kept = await j.project();
    expect(
      kept.messages.some(
        (e) =>
          e.payload.type === 'user' &&
          (e.payload as { blocks: Array<{ text?: string }> }).blocks.some((b) =>
            b.text?.includes('now list the migrations folder'),
          ),
      ),
    ).toBe(true);
    expect(await markersIn(j)).toBe(0);
  });

  it('S1 — a second compaction cutting ON the old marker leaves ONE marker, not two', async () => {
    // The marker is a user-role entry, so it is a legal cut boundary and can BE the
    // first kept entry. It is then already leading the retained span and doing its job;
    // minting another put two of them in the projection.
    const taskId = 's1-double-marker';
    const j = await oneAskJournal(taskId, 4);
    // First compaction: mid-turn, so the marker is minted.
    await runRecoveryCompaction(
      makeDeps(j, taskId, summarizingTransport('SUMMARY ONE'), { keepWindowTokens: 2_000 }),
    );
    expect(await markersIn(j)).toBe(1);

    // More work, then a second compaction whose cut lands ON that marker.
    for (let i = 0; i < 3; i++) await assistant(j, taskId, `later step ${i} ${BODY}`);
    const before = (await j.project()).messages;
    const markerIdx = before.findIndex(
      (e) =>
        e.payload.type === 'user' &&
        (e.payload as { blocks: Array<{ text?: string }> }).blocks.some(
          (b) => b.text === COMPACTION_SPLIT_TURN_CONTINUE_MARKER,
        ),
    );
    expect(markerIdx).toBeGreaterThan(0);
    const keepWindowTokens = projectTokenCount(before.slice(markerIdx)).messages;

    await runRecoveryCompaction(
      makeDeps(j, taskId, summarizingTransport('SUMMARY TWO'), { keepWindowTokens }),
    );

    const after = (await j.project()).messages;
    const inProjection = after.filter(
      (e) =>
        e.payload.type === 'user' &&
        (e.payload as { blocks: Array<{ text?: string }> }).blocks.some(
          (b) => b.text === COMPACTION_SPLIT_TURN_CONTINUE_MARKER,
        ),
    ).length;
    expect(inProjection).toBe(1);
  });
});

describe('Ruling 85 — the split-turn SECTION is driven by the same truth as the marker', () => {
  const sentSection = (t: FakeTransport): boolean =>
    t.systems.some((sys) => sys.includes(COMPACTION_SPLIT_TURN_SECTION));

  it('a between-turns `/compact` is NOT told the turn is still in progress', async () => {
    // `plan.splitTurn` alone drove the section, so on a COMPLETED one-ask task the
    // summarizer was told "the turn is still in progress … do not describe it as
    // finished" and the summary misreported state to the next model call. The marker
    // already refuses this shape; the section has to refuse it for the same reason.
    const taskId = 'r85-manual-no-section';
    const j = await oneAskJournal(taskId, 6);
    const transport = summarizingTransport('SUMMARY OF THE ASK');

    const result = await runManualCompaction(makeDeps(j, taskId, transport));

    expect(result).not.toBeNull();
    // The cut DID split a turn — the section's old trigger fired — so this is the case.
    expect((await firstKeptEntry(j)).payload.type).toBe('assistant');
    expect(sentSection(transport)).toBe(false);
  });

  it('a round-0 compaction whose fresh ask is retained is NOT told the turn is in progress', async () => {
    const taskId = 'r85-round-zero-no-section';
    const j = await oneAskJournal(taskId, 6);
    await assistant(j, taskId, 'DONE 30 — every file has been read.');
    await user(j, taskId, 'now list the migrations folder');
    const transport = summarizingTransport('SUMMARY OF TURN 1');

    await runRecoveryCompaction(makeDeps(j, taskId, transport, { keepWindowTokens: 2_000 }));

    expect((await firstKeptEntry(j)).payload.type).toBe('assistant');
    expect(sentSection(transport)).toBe(false);
  });

  it('a genuine mid-turn split still gets the section', async () => {
    // The positive control: without it the two legs above pass by the section never
    // being sent at all.
    const taskId = 'r85-live-split-section';
    const j = await oneAskJournal(taskId, 6);
    const transport = summarizingTransport('SUMMARY OF THE PREFIX');

    await runRecoveryCompaction(makeDeps(j, taskId, transport, { keepWindowTokens: 2_000 }));

    expect((await firstKeptEntry(j)).payload.type).toBe('assistant');
    expect(sentSection(transport)).toBe(true);
  });
});

describe('isLiveSplitTurn — ONE rule, shared with the eval (S9)', () => {
  // The eval builds its own summarize request and was keying the split-turn section on
  // `meta.splitTurn` alone, so it sent the section on shapes the engine now withholds it
  // from — measuring a request production never makes. It now calls THIS function, so
  // there is one rule rather than two that have to be kept in step.
  const plan = (splitTurn: boolean, retainedHasRealUserTurn: boolean) => ({
    splitTurn,
    retainedHasRealUserTurn,
  });

  it('true only when the cut split a turn, the turn is live, and no real ask survived', () => {
    expect(isLiveSplitTurn(plan(true, false), true)).toBe(true);
  });

  it('false on a chat cut that landed on a real user turn', () => {
    expect(isLiveSplitTurn(plan(false, false), true)).toBe(false);
  });

  it('false when the caller says no turn resumes — `/compact`', () => {
    expect(isLiveSplitTurn(plan(true, false), false)).toBe(false);
  });

  it('false when a real ask survived the cut — round 0 of a new turn', () => {
    expect(isLiveSplitTurn(plan(true, true), true)).toBe(false);
  });
});

// ─── B1: A COMPACTION NEVER FAILS SILENTLY ────────────────────────────────────────
//
// gpt-6-luna's summarize inherited the task's effort 'max' under a 4096 output cap. Reasoning
// ate the cap, the summary came back EMPTY, and `runCompaction` returned null: no usage row,
// no journal entry, no failure record. The context never shrank, so the next round head paid
// for the same empty answer again (task 9472b042: 42 attempts on 09-27, stuck at 449K, every
// later request above OpenAI's 272K premium line).

/** A summarize that REASONS and writes nothing: thinking, then `done` with usage and NO text. */
function reasoningOnlyTransport(): FakeTransport {
  class T extends FakeTransport {
    constructor() {
      super([
        { kind: 'thinking_start' },
        { kind: 'thinking', text: 'Considering the transcript at length before writing anything.' },
        {
          kind: 'done',
          stopReason: 'max_output_tokens',
          usage: {
            inputTokens: 1_000,
            outputTokens: 4_096,
            cacheReadInputTokens: 30_000,
          } as NormalizedUsage,
        } as StreamEvent,
      ]);
    }
    override computeCostUsd(): number {
      return 0.05;
    }
  }
  return new T();
}

/** A summarize that succeeds and reports every bucket a provider can bill. */
function summarizingWithCacheTransport(): FakeTransport {
  class T extends FakeTransport {
    constructor() {
      super([
        { kind: 'text', text: 'SUMMARY OF EARLIER WORK' },
        {
          kind: 'done',
          stopReason: 'end_turn',
          usage: {
            inputTokens: 700,
            outputTokens: 900,
            cacheReadInputTokens: 12_000,
            cacheCreationInputTokens: 300,
            // Anthropic's TTL split of the writes: all 1h (the proxy's TTL), priced 2x input.
            cacheCreation5mInputTokens: 0,
            cacheCreation1hInputTokens: 300,
            reasoningTokens: 250,
          } as NormalizedUsage,
        } as StreamEvent,
      ]);
    }
    override computeCostUsd(): number {
      return 0.02;
    }
  }
  return new T();
}

type Rc = {
  pendingOverflow?: { model: string; seq: number };
  compactionRetry?: { failures: number; notBeforeRound: number } | null;
  billing: { cumulativeCostUsd: number; parentOwnCostUsd: number; roundCounter: { value: number } };
};

const newRc = (round: number): Rc => ({
  billing: { cumulativeCostUsd: 0, parentOwnCostUsd: 0, roundCounter: { value: round } },
});

/** One round head, exactly as `compactTurnHead` drives it. */
const roundHead = (deps: CompactionDeps, rc: Rc) =>
  compactAtRoundHead(deps, rc as never, 'system', [], null);

const failuresIn = (events: Array<{ kind: string }>) =>
  events.filter(
    (e) => e.kind === 'raw' && (e as unknown as { event: string }).event === COMPACTION_FAILED_EVENT,
  ) as unknown as Array<{ data: { reason: string; usage?: NormalizedUsage } }>;

describe('B1 — an EMPTY summary is a metered, journaled refusal, never a silent null', () => {
  // Every refusal here warns by design ('[NativeHarness] compaction failed'); keep the run quiet.
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('meters the reasoning-only summarize, journals the refusal by name, and compacts nothing', async () => {
    const taskId = 'b1-empty-summary';
    const j = await oneAskJournal(taskId, 8);
    const transport = reasoningOnlyTransport();
    // thresholdPct 0.0001 puts the proactive trigger over the line so it really fires.
    const deps = makeDeps(j, taskId, transport, { keepWindowTokens: 2_000, thresholdPct: 0.0001 });
    const rc = newRc(3);

    const head = await roundHead(deps, rc);

    expect(head.result).toBeNull();
    expect(transport.systems).toHaveLength(1); // the summarize really ran, and was billed

    // 1. The refusal is NAMED (was: nothing at all).
    const failures = failuresIn(head.pendingEvents);
    expect(failures).toHaveLength(1);
    expect(failures[0].data.reason).toBe('empty_summary');

    // 2. The usage EVENT the server re-prices from — lane `compaction`, every bucket.
    const usage = head.pendingEvents.find((e) => e.kind === 'usage') as
      | { lane: string; usage: NormalizedUsage }
      | undefined;
    expect(usage).toBeDefined();
    expect(usage!.lane).toBe('compaction');
    expect(usage!.usage.outputTokens).toBe(4_096);
    expect(usage!.usage.cacheReadInputTokens).toBe(30_000);

    // 3. The durable legs: the `compaction_failed` record and the compaction usage row.
    const all = await j.snapshot();
    const record = all.find((e) => (e.payload as { key?: string }).key === 'compaction_failed');
    expect((record!.payload as { data: { reason: string } }).data.reason).toBe('empty_summary');
    const row = all.find((e) => (e.payload as { raw?: { source?: string } }).raw?.source === 'compaction');
    expect((row!.payload as { raw: { costUsd: number } }).raw.costUsd).toBeCloseTo(0.05, 9);

    // 4. The turn's accumulators carry it, and nothing was spliced.
    expect(rc.billing.cumulativeCostUsd).toBeCloseTo(0.05, 9);
    expect(rc.billing.parentOwnCostUsd).toBeCloseTo(0.05, 9);
    expect(all.some((e) => e.payload.type === 'compact_boundary')).toBe(false);
  });

  it('the NEXT round head does not re-fire — the retry waits 2, then 4 rounds, each attempt metered', async () => {
    const taskId = 'b1-no-refire';
    const j = await oneAskJournal(taskId, 8);
    const transport = reasoningOnlyTransport();
    const deps = makeDeps(j, taskId, transport, { keepWindowTokens: 2_000, thresholdPct: 0.0001 });
    const rc = newRc(3);

    await roundHead(deps, rc); // round 3: attempt 1, refused
    expect(transport.systems).toHaveLength(1);

    // Round 4 — the very next head. Was: a second paid summarize for the same empty answer.
    rc.billing.roundCounter.value = 4;
    const next = await roundHead(deps, rc);
    expect(next.result).toBeNull();
    expect(next.pendingEvents).toHaveLength(0); // a wait is not an attempt: nothing to record
    expect(transport.systems).toHaveLength(1);

    // Round 5 — the first wait (2 rounds) is over: attempt 2, metered and journaled.
    rc.billing.roundCounter.value = 5;
    const second = await roundHead(deps, rc);
    expect(transport.systems).toHaveLength(2);
    expect(failuresIn(second.pendingEvents)[0].data.reason).toBe('empty_summary');
    expect(second.pendingEvents.some((e) => e.kind === 'usage')).toBe(true);

    // The wait doubles: rounds 6, 7, 8 are quiet, round 9 tries again.
    for (const round of [6, 7, 8]) {
      rc.billing.roundCounter.value = round;
      await roundHead(deps, rc);
    }
    expect(transport.systems).toHaveLength(2);
    rc.billing.roundCounter.value = 9;
    await roundHead(deps, rc);
    expect(transport.systems).toHaveLength(3);
    expect(rc.billing.cumulativeCostUsd).toBeCloseTo(0.15, 9); // three attempts, three charges
  });

  it('a compaction that lands resets the wait', async () => {
    const taskId = 'b1-reset';
    const j = await oneAskJournal(taskId, 8);
    const rc = newRc(3);
    await roundHead(
      makeDeps(j, taskId, reasoningOnlyTransport(), { keepWindowTokens: 2_000, thresholdPct: 0.0001 }),
      rc,
    );
    expect(rc.compactionRetry).toEqual({ failures: 1, notBeforeRound: 5 });

    rc.billing.roundCounter.value = 5;
    const head = await roundHead(
      makeDeps(j, taskId, summarizingWithCacheTransport(), { keepWindowTokens: 2_000, thresholdPct: 0.0001 }),
      rc,
    );

    expect(head.result).not.toBeNull();
    expect(rc.compactionRetry).toBeNull();
  });

  it('the deferred-overflow recovery does NOT wait: the provider already said it does not fit', async () => {
    const taskId = 'b1-deferred-ungated';
    const j = await oneAskJournal(taskId, 8);
    const transport = summarizingWithCacheTransport();
    const deps = makeDeps(j, taskId, transport, { keepWindowTokens: 2_000 });
    const rc: Rc = {
      ...newRc(4),
      pendingOverflow: { model: 'claude-sonnet-4-5', seq: 0 },
      compactionRetry: { failures: 1, notBeforeRound: 5 }, // mid-wait
    };

    const head = await roundHead(deps, rc);

    expect(transport.systems).toHaveLength(1);
    expect(head.result).not.toBeNull();
    expect(rc.compactionRetry).toBeNull();
  });
});

describe('B1 — the retry bound arms only on a refusal that reached the summarize', () => {
  const err = (reason: 'no_valid_cut' | 'aborted' | 'empty_summary' | 'summarize_failed' | 'summary_not_smaller') =>
    new CompactionPlanError(reason, reason);

  it('`no_valid_cut` (no model call) and `aborted` (a steer) arm nothing', () => {
    const rc = newRc(7);
    armCompactionRetry(rc as never, err('no_valid_cut'));
    armCompactionRetry(rc as never, err('aborted'));
    expect(rc.compactionRetry).toBeUndefined();
  });

  it('every paid refusal doubles the wait, capped at 32 rounds', () => {
    const rc = newRc(10);
    const waits: number[] = [];
    for (const reason of ['empty_summary', 'summarize_failed', 'summary_not_smaller', 'empty_summary', 'empty_summary', 'empty_summary', 'empty_summary'] as const) {
      armCompactionRetry(rc as never, err(reason));
      waits.push(rc.compactionRetry!.notBeforeRound - rc.billing.roundCounter.value);
    }
    expect(waits).toEqual([2, 4, 8, 16, 32, 32, 32]);
    // An unnamed throw (a journal write that failed after the summarize) is paid for too.
    const fresh = newRc(1);
    armCompactionRetry(fresh as never, new Error('disk full'));
    expect(fresh.compactionRetry).toEqual({ failures: 1, notBeforeRound: 3 });
  });

  it('a new USER turn ends the wait but keeps the count: one attempt now, then the doubling resumes', () => {
    // Five paid refusals: the wait is 32 rounds — 32 USER turns on a one-round-a-turn chat.
    const rc = newRc(40);
    rc.compactionRetry = { failures: 5, notBeforeRound: 72 };
    expect(compactionRetryPending(rc as never)).toBe(true);

    openCompactionRetryForTurn(rc as never);

    expect(compactionRetryPending(rc as never)).toBe(false); // this turn's head may try
    expect(rc.compactionRetry).toEqual({ failures: 5, notBeforeRound: 40 });
    armCompactionRetry(rc as never, err('empty_summary')); // …and if it fails, the sixth
    expect(rc.compactionRetry).toEqual({ failures: 6, notBeforeRound: 72 });
  });

  it('a turn with nothing refused opens nothing', () => {
    const rc = newRc(3);
    openCompactionRetryForTurn(rc as never);
    expect(rc.compactionRetry).toBeUndefined();
  });
});

describe('B1 — the summarize request cannot be starved by reasoning', () => {
  it('pins effort `low` and adds reasoning headroom on a reasoning row (gpt-6-luna)', async () => {
    const taskId = 'b1-effort';
    const j = await oneAskJournal(taskId, 2);
    const transport = summarizingWithCacheTransport();
    const deps = makeDeps(j, taskId, transport);
    (deps.ctx as { model: string }).model = 'gpt-6-luna';

    await summarizeSpan(deps, (await j.project()).messages);

    expect(transport.reasoningEfforts).toEqual(['low']);
    expect(transport.maxTokensSeen).toEqual([COMPACTION_MAX_TOKENS + COMPACTION_REASONING_HEADROOM_TOKENS]);
  });

  it('a row that does not reason keeps exactly the 4096 cap', () => {
    // No seed row is `thinking.mode: 'none'` today; an unknown id resolves to it.
    expect(compactionMaxTokens('acme-plain-1')).toBe(COMPACTION_MAX_TOKENS);
    expect(compactionMaxTokens('gpt-6-luna')).toBe(8_192);
    expect(compactionMaxTokens('claude-opus-5-5')).toBe(8_192);
  });

  it('the env kill switches do not shrink the cap: an always_on row thinks with NATIVE_THINKING off', () => {
    // A 4096 fallback keyed on the switch would starve exactly the models that ignore it.
    process.env.NATIVE_THINKING = 'off';
    process.env.OPENAI_REASONING = 'off';
    try {
      expect(compactionMaxTokens('claude-opus-5-5')).toBe(8_192); // thinking: always_on
      expect(compactionMaxTokens('gpt-6-luna')).toBe(8_192);
    } finally {
      delete process.env.NATIVE_THINKING;
      delete process.env.OPENAI_REASONING;
    }
  });
});

describe('B1 — compaction usage keeps its cache buckets', () => {
  it('a successful compaction reports cache reads, cache writes and reasoning on its usage event', async () => {
    const taskId = 'b1-cache';
    const j = await oneAskJournal(taskId, 8);
    const deps = makeDeps(j, taskId, summarizingWithCacheTransport(), { keepWindowTokens: 2_000 });

    const result = await runRecoveryCompaction(deps);

    expect(result!.compactionUsage).toEqual({
      inputTokens: 700,
      outputTokens: 900,
      cacheReadInputTokens: 12_000,
      cacheCreationInputTokens: 300,
      cacheCreation5mInputTokens: 0,
      cacheCreation1hInputTokens: 300,
      reasoningTokens: 250,
    });
    const event = compactionUsageEvent(result!, taskId, 6) as { lane: string; usage: NormalizedUsage };
    expect(event.lane).toBe('compaction');
    expect(event.usage.cacheReadInputTokens).toBe(12_000);
    expect(event.usage.cacheCreationInputTokens).toBe(300);
    // The split survives the fold, so the server prices the summarize's 1h writes at 2x, not 5m.
    expect(event.usage.cacheCreation5mInputTokens).toBe(0);
    expect(event.usage.cacheCreation1hInputTokens).toBe(300);
  });

  it('a usage that never reported a cache bucket keeps its shape (no invented zeros)', async () => {
    const taskId = 'b1-cache-absent';
    const j = await oneAskJournal(taskId, 8);
    const deps = makeDeps(j, taskId, summarizingTransport('SUMMARY'), { keepWindowTokens: 2_000 });

    const result = await runRecoveryCompaction(deps);

    expect(result!.compactionUsage).toEqual({ inputTokens: 500, outputTokens: 30 });
  });
});

describe('B1 item 3 — the round-head check fires when REAL input crosses 244.8K (c00b391e)', () => {
  it('estimate grows by the tool pair, real by +7,459 a round: quiet below the line, fires on the crossing round', async () => {
    const taskId = 'b1-c00b391e';
    const j = await oneAskJournal(taskId, 8);
    const transport = summarizingTransport('SUMMARY OF EARLIER WORK');
    const deps = makeDeps(j, taskId, transport, { keepWindowTokens: 2_000 });
    (deps.ctx as { model: string }).model = 'gpt-6-luna'; // trigger = 0.9 x 272K = 244,800
    const rc = {
      ...newRc(0),
      elision: null,
      lastRoundInput: null as unknown,
    };
    const TRIGGER = 244_800;
    const REAL_GROWTH = 7_459;
    let counted = 200_000; // what the provider billed for the round that just ran
    let fired = -1;

    for (let round = 1; round <= 12 && fired < 0; round++) {
      // The round settles: its assistant entry, and the count the provider reported for it…
      const settled = await assistant(j, taskId, `r${round}`);
      // …then its tool pair: all the estimate sees grow (a few dozen tokens).
      const pair = [
        await j.append({
          ...base(taskId),
          payload: { type: 'tool_use', toolUseId: `c-${round}`, name: 'Bash', input: { command: 'ls' } },
        }),
        await j.append({
          ...base(taskId),
          payload: { type: 'tool_result', toolUseId: `c-${round}`, blocks: [{ type: 'text', text: 'ok' } as ContentBlock] },
        }),
      ];
      // The call's arguments are part of the reply's output tokens; only its result is new input.
      const appended = projectTokenCount([pair[1]], { countImages: true }).messages;
      // The reply (encrypted reasoning, replayed next round) makes real grow by exactly 7,459.
      rc.lastRoundInput = {
        model: 'gpt-6-luna',
        inputTokens: counted,
        outputTokens: REAL_GROWTH - appended,
        atSeq: settled.seq,
        elisionCut: { result: 0, image: 0 },
      };
      const nextReal = counted + REAL_GROWTH;
      rc.billing.roundCounter.value = round;

      const before = transport.systems.length;
      const head = await roundHead(deps, rc as never);

      // The estimate alone stays nowhere near the line the whole way.
      expect(projectTokenCount((await j.project()).messages).messages).toBeLessThan(20_000);
      if (transport.systems.length > before) {
        fired = round;
        expect(nextReal).toBeGreaterThanOrEqual(TRIGGER);
        expect(head.result).not.toBeNull();
      } else {
        expect(nextReal).toBeLessThan(TRIGGER);
      }
      counted = nextReal;
    }

    // 200,000 + 7,459 x 6 = 244,754 (under); x 7 = 252,213 (over) — round 7 is the crossing.
    expect(fired).toBe(7);
  });
});

describe('X1 (HOOK_PARITY_V1): a PreCompact block never stops a context-limit recovery', () => {
  afterEach(() => { delete process.env.HOOK_PARITY_V1; });
  /** The same deps, with a PreCompact hook that always blocks (exit 2). */
  const blocking = (deps: CompactionDeps): CompactionDeps => ({
    ...deps,
    dispatcher: {
      dispatch: async (event: string) => (event === 'PreCompact'
        ? { decision: 'halt', blocked: true, stopReason: 'never compact' }
        : { decision: 'continue' }),
    },
  }) as unknown as CompactionDeps;

  it('a recovery compacts anyway, journaled and announced as auto; /compact is refused by name', async () => {
    process.env.HOOK_PARITY_V1 = 'true';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const j = await oneAskJournal('recovery-precompact-block', 6);
    const result = await runRecoveryCompaction(
      blocking(makeDeps(j, 'recovery-precompact-block', summarizingTransport('SUMMARY OF THE ASK'), { keepWindowTokens: 2_000 })),
    );
    expect(result?.event).toMatchObject({ data: { trigger: 'auto' } });
    const boundary = (await j.snapshot()).find((e) => e.payload.type === 'compact_boundary')!;
    expect(boundary.payload).toMatchObject({ trigger: 'auto' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('never compact'));

    const j2 = await oneAskJournal('manual-precompact-block', 6);
    await expect(runManualCompaction(blocking(makeDeps(j2, 'manual-precompact-block', summarizingTransport('SUMMARY OF THE ASK')))))
      .rejects.toMatchObject({ reason: 'hook_blocked' });
    warn.mockRestore();
  });

  // Review of #4284, LOW-7: the recovery's trigger is `auto` with the flag OFF too (production): its
  // only visible effect is the transient "Context auto-compacted" label; nothing branches on it.
  it('flag off: a recovery is journaled and announced as auto as well', async () => {
    const j = await oneAskJournal('recovery-trigger-flag-off', 6);
    const result = await runRecoveryCompaction(makeDeps(j, 'recovery-trigger-flag-off', summarizingTransport('SUMMARY OF THE ASK'), { keepWindowTokens: 2_000 }));
    expect(result?.event).toMatchObject({ data: { trigger: 'auto' } });
    const boundary = (await j.snapshot()).find((e) => e.payload.type === 'compact_boundary')!;
    expect(boundary.payload).toMatchObject({ trigger: 'auto' });
  });
});

describe('COMPACTION_POST_TURN_V1: each path names itself on the O1 rail', () => {
  it('a recovery says recovery (it runs on the auto trigger since X1), a manual one says manual', async () => {
    const jr = await oneAskJournal('reason-recovery', 6);
    const recovery = await runRecoveryCompaction(makeDeps(jr, 'reason-recovery', summarizingTransport('SUMMARY'), { keepWindowTokens: 2_000 }));
    // Mutation: derive the reason from the trigger alone → a recovery reads as round_head.
    expect(recovery?.info?.reason).toBe('recovery');
    const jm = await oneAskJournal('reason-manual', 6);
    const manual = await runManualCompaction(makeDeps(jm, 'reason-manual', summarizingTransport('SUMMARY')));
    expect(manual?.info?.reason).toBe('manual');
  });
});

describe('COMPACTION_POST_TURN_V1: a cut that came before the send', () => {
  afterEach(() => {
    delete process.env.COMPACTION_POST_TURN_V1;
  });
  it('sends nothing and carries nothing to bill (no estimate, no billed spend)', async () => {
    process.env.COMPACTION_POST_TURN_V1 = 'true';
    const j = await oneAskJournal('cut-before-send', 6);
    const transport = summarizingTransport('SUMMARY OF THE ASK');
    const cut = new AbortController();
    cut.abort();
    const err = await runCompaction(makeDeps(j, 'cut-before-send', transport, { keepWindowTokens: 2_000 }), (await j.project()).messages, {
      trigger: 'auto', keepWindowTokens: 2_000, resumesTurn: false, signal: cut.signal, reason: 'post_turn',
    }).catch((e: unknown) => e);
    // Mutation: drop the pre-send check → the request goes out (this fake ignores the signal, so
    // the compaction even succeeds) and a real provider would bill it.
    expect(err).toBeInstanceOf(Error);
    expect(transport.noCacheWrites).toHaveLength(0);
    expect(inflightEstimateOf(err)).toBeUndefined();
    expect(billedSpendOf(err)?.usage.inputTokens ?? 0).toBe(0);
  });
});
