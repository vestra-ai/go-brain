// packages/agent-sdk/src/engine/native-run-turn.ts
//
// The per-user-turn phases of NativeHarness.run(), lifted verbatim out of the
// 594-line method so the loop reads as the sequence of gates it actually is.
//
// Every phase here YIELDS, so each is an async generator the caller drives with
// `yield*`. What cannot cross a function boundary is `continue`/`break`, so each
// phase RETURNS the control signal instead and the caller acts on it. That
// substitution is the only non-verbatim change in this file, and each site says so.
//
// `yield*` forwards `.return()` and `.throw()` to the delegate, so an aborting
// driver still unwinds these phases exactly as it did when they were inline —
// including the `finally` that clears the runaway trip latch.
//
// No module-scope mutable state (R2's rule, honoured here even though that lint
// only scans apps/server/src/services): every phase takes the state it touches as
// an argument, so two sessions sharing this process never share a byte of it.

import type { HarnessContext, UserTurn } from '../contract/harness.js';
import type { HarnessEvent } from '../contract/events.js';
import type { ChildCostRecord } from '../contract/child-cost.js';
import type { NativeConfig } from './native-config.js';
import type { Transport, NormalizedUsage } from './transport.js';
import type { RunContext } from './run-context.js';
import type { MessageOrigin } from '../contract/harness.js';
import type { TurnOutcome } from '../contract/turn-outcome.js';
import type { ContentBlock, ImageBlock, MediaBlock } from '../contract/blocks.js';
import type { ProviderHistory } from './transport.js';
import type { HookDispatcher } from '../kernel/index.js';
import type { RunPrologue } from './native-run-open.js';
import type { TurnIterationResult } from './turn-iteration-result.js';
import { resolveCapabilities } from '../contract/model-capabilities.js';
import { getAmbientFuelTank, defaultNodeReserveUsd } from './fuel-tank.js';
import { COMPACTION_NOOP_NOTICE } from '../contract/compaction-prompt.js';
import { type CompactionResult } from './compaction-recovery.js';
import { openCompactionRetryForTurn } from './compaction-refusal.js';
import {
  runManualCompaction,
  compactionUsageEvent,
  refusalEvents,
  yieldIfPresent,
  type CompactionDeps,
} from './compaction-run.js';
import { appendUserEntry, appendInjectedUserEntry, appendInitiativeMarker, appendUsageEntry } from './native-journal.js';
import { dispatchLifecycle, buildUserPromptSubmitInput, continueContext } from './native-hooks.js';
import { blockedCompactionNotice } from './hook-parity.js';

/** The empty usage a gate reports — it ran no model call. */
export const ZERO_USAGE: NormalizedUsage = { inputTokens: 0, outputTokens: 0 };

/** The per-turn billing delta closure the epilogue and the gates both read. */
export type PerTurnBilling = () => {
  turnDeltaUsd: number;
  parentOwnCostUsd: number;
  childUsage: ChildCostRecord[];
};

/**
 * What the turn head decided. `continue`/`break` are the caller's loop keywords,
 * returned rather than executed because they cannot cross a function boundary.
 */
export type TurnHeadResult =
  | { stop: 'continue' }
  | { stop: 'break' }
  | { stop: 'proceed'; perTurnBilling: PerTurnBilling; isInitiative: boolean };

/**
 * Open the turn: snapshot the billing baselines, then the two gates that can end
 * the turn before any model call — the ambient fuel bucket and the budget cap.
 *
 * The caller must set its own `seedChildUsagePending = false` after this returns;
 * the original did it inline here, and nothing between the read and the write can
 * observe the difference.
 */
export async function* openTurn(
  ctx: HarnessContext<NativeConfig>,
  cfg: NativeConfig,
  transport: Transport,
  rc: RunContext,
  userTurn: UserTurn,
  seedChildUsagePending: boolean,
  ambientSpentUsd: number,
): AsyncGenerator<HarnessEvent, TurnHeadResult> {
  // Per-user-turn billing boundary: snapshot the run-monotonic baselines and RESET
  // the attributed child list so every turn_end reports its cost as a DELTA against
  // THIS turn's start (taken BEFORE the budget gate → a capped turn reports 0). On
  // the first querying turn of a HITL re_execute resume, childUsage is seeded from
  // the replay's records and their own-cost subtracted from the baseline so the
  // replay cost lands in this turn's delta and the keystone holds across the resume.
  // History: docs/learnings/native-harness-history.md (Billing).
  const seeded = seedChildUsagePending ? (ctx.config.initialChildUsage ?? []) : [];
  const seededSum = seeded.reduce((acc, r) => acc + r.costUsd, 0);
  rc.billing.childUsage = [...seeded];
  // Media turn-settle (CONTENT_ENGINE_V1): clear the per-turn lock at every user-turn
  // boundary so a new user message is a clean slate — the agent is then fully free
  // again (including fresh media calls for iteration). The lock persists across a
  // turn's rounds AND its Stop re-feeds (same user turn), reset only here. No-op when
  // the flag is off (the round engine never arms it). Keeps the state per-turn on top
  // of RunContext's per-session ownership.
  rc.mediaTurnSettled = false;
  // Orchestration walls (root wall): the serial-spawn streak is per USER TURN, not per run
  // — "one helper, then another" is a story about one turn's plan. Reset here with the
  // media lock so a fresh user message starts clean. No-op when the walls are off.
  rc.lastRoundWasLoneSpawn = false;
  // Follow-up C item 3: and the turn's refusal budget with it, or turn 2 would open on a
  // cap turn 1 had already spent and wave its very first drip-fed hand-off through.
  rc.serialRootRefusals = 0;
  // R129: and the turn's declared-hand-off budget, or a chain that spent it in turn 1 would
  // find every later turn's first declaration already judged as a bare spawn.
  rc.serialRootDependents = 0;
  // Follow-up B item 2: the wrap-up nudge is per USER TURN too — a helper resumed after a
  // pause gets its own warning rather than inheriting a spent one. No-op when no cap is set.
  rc.turnWrapUpPushed = false;
  // B1: and a compaction that has been refusing gets one attempt at this turn's head —
  // the wait resets, the failure count does not (compaction-refusal.ts).
  openCompactionRetryForTurn(rc);
  // The per-turn spend ceiling's baseline, taken with the other billing baselines:
  // the ledger is RUN-scoped, so without a mark here turn 2 of a warm session would
  // start already past the line. No ledger ⇒ no-op (the ceiling needs both).
  cfg.liveSpend?.markTurnStart();
  // L5 — the owner's per-turn state resets here (rounds, spend, ended), with the other
  // baselines: a warm turn on the same run starts clean; the root controller is unchanged.
  cfg.budget?.beginTurn();
  const turnStartCumulative = rc.billing.cumulativeCostUsd - seededSum;
  const turnStartParentOwn = rc.billing.parentOwnCostUsd;
  const perTurnBilling = (): {
    turnDeltaUsd: number;
    parentOwnCostUsd: number;
    childUsage: ChildCostRecord[];
  } => ({
    turnDeltaUsd: rc.billing.cumulativeCostUsd - turnStartCumulative,
    parentOwnCostUsd: rc.billing.parentOwnCostUsd - turnStartParentOwn,
    childUsage: rc.billing.childUsage,
  });

  // Ambient fuel gate: a self-initiated (initiative) turn bills a SEPARATE bucket so
  // a runaway anticipation loop can't eat the user's foreground capability. Checked
  // at the turn head, ahead of the foreground gate; gates the tank's remaining()
  // against the run-local ambient ledger (ambient turns are sequential → no
  // in-flight reserve). Deny → finalize max_budget + `ambient_fuel_exhausted` and
  // CONTINUE (never break). Needs an initiative origin AND the knob → else byte-id.
  // History: docs/learnings/native-harness-history.md (Preemption & ambient fuel).
  const isInitiative = userTurn.origin?.kind === 'initiative';
  if (isInitiative && cfg.ambientFuelTankUsd !== undefined) {
    const ambientTank = getAmbientFuelTank(ctx.taskId, cfg.ambientFuelTankUsd);
    const reserve = defaultNodeReserveUsd(ctx.model, resolveCapabilities(ctx.model).maxOutputTokens);
    if (ambientTank.remaining(ambientSpentUsd) < reserve) {
      cfg.budget?.end('ambient_fuel_exhausted');
      yield {
        kind: 'turn_end',
        outcome: {
          kind: 'max_budget',
          costUsd: rc.billing.cumulativeCostUsd,
          triggeredBy: 'credits',
          raw: { subtype: 'ambient_fuel_exhausted', errors: [] },
        },
        blocks: [],
        stopReason: 'end_turn',
        exitReason: 'ambient_fuel_exhausted',
        billing: {
          cumulativeCostUsd: rc.billing.cumulativeCostUsd,
          modelUsage: transport.buildModelUsage(ZERO_USAGE, ctx.model),
          ...(cfg.journalSeedUsd ? { journalSeedUsd: cfg.journalSeedUsd } : {}),
          // Ran no model call → a clean 0 delta (parity with the max_budget gate).
          ...perTurnBilling(),
        },
      };
      return { stop: 'continue' }; // was: continue;
    }
  }

  // Budget gate — once NEW spend under this budget crosses the cap, stop BEFORE
  // the next model call and finalize with the recoverable max_budget outcome.
  //
  // NEW spend, not lifetime. `maxBudgetUsd` is minted per message from the LIVE
  // balance ("what the account can afford from here"); the run's cumulative is
  // task-LIFETIME (the resume seed restores history so re-billing is impossible).
  // Comparing lifetime-spent against remaining-balance double-counts every dollar
  // — once already deducted from the balance, once again as a claim against what
  // is left — so any long task locked itself the moment its history outgrew the
  // wallet and told a funded user "out of credits" (prod incident 14a935ea,
  // 2026-08-27: 1,840 credits in hand ⇒ $14.72 affordable, task history $15.37 ⇒
  // instant $0.00 max_budget trips). The live ledger's turn mark is the seed-free
  // turn-scoped figure (the ceiling gate's exact discipline); the fallback derives
  // the same span from the billing baselines when no ledger is wired.
  const budgetSpentUsd =
    cfg.liveSpend?.readTurnUsd() ??
    rc.billing.cumulativeCostUsd - turnStartCumulative - seededSum;
  // LIVE mint first: a warm run's construction snapshot goes stale while the
  // freeze rail keeps it alive, so each turn head adopts the freshest frame's
  // mint; the statics remain the cold-resume/legacy fallback.
  const liveMint = cfg.getBudgetMint?.();
  const budgetUsd = liveMint?.usd ?? cfg.maxBudgetUsd;
  const budgetSource = liveMint?.source ?? cfg.maxBudgetSource;
  if (budgetUsd !== undefined && budgetSpentUsd >= budgetUsd) {
    // NB: does not reuse `terminalTurnEnd` because exitReason is 'max_budget'
    // whereas the helper hard-codes `stop(${terminalStopReason})`.
    cfg.budget?.end('max_budget');
    yield {
      kind: 'turn_end',
      outcome: {
        kind: 'max_budget',
        costUsd: rc.billing.cumulativeCostUsd,
        // Name the binding constraint so the card is honest: the user's own
        // per-task limit → "Task budget reached · Adjust limit"; the wallet →
        // the recharge card. Absent (old server frame) keeps the wallet copy.
        triggeredBy: budgetSource === 'task_limit' ? 'task_limit' : 'credits',
        raw: { subtype: 'max_budget', errors: [] },
      },
      blocks: [],
      stopReason: 'end_turn',
      exitReason: 'max_budget',
      billing: {
        cumulativeCostUsd: rc.billing.cumulativeCostUsd,
        modelUsage: transport.buildModelUsage(ZERO_USAGE, ctx.model),
        // P2.1 (Task 5): carry the seeded-resume marker here too — a seeded run
        // that trips the budget cap on its first turn must still suppress the
        // server's restart reset. Absent (non-seeded) → byte-identical.
        ...(cfg.journalSeedUsd ? { journalSeedUsd: cfg.journalSeedUsd } : {}),
        // Agent v2 (Task 4): a capped turn ran no model call → a clean 0 delta.
        ...perTurnBilling(),
      },
    };
    // Any buffered stagedTexts are dropped here: they were never journaled,
    // so the user re-sends on retry (no data loss — the model never saw them).
    return { stop: 'break' }; // was: break;
  }

  // WARM_CONNECTIONS_V1: the gates passed, so this turn will call the model. Open the
  // connection now, so its handshake overlaps the prompt build (hooks, journal,
  // projection, recall) instead of delaying the first token. The flag lives in the
  // transport's HTTP layer; a transport without `prewarm` is untouched.
  transport.prewarm?.(ctx.model);

  return { stop: 'proceed', perTurnBilling, isInitiative };
}

/** The instance methods the remaining turn phases reach for, passed in not imported. */
export type RunTurnDeps = {
  terminalTurnEnd: (
    transport: Transport,
    ctx: HarnessContext<NativeConfig>,
    outcome: TurnOutcome,
    cumulativeCostUsd: number,
    turnResult?: TurnIterationResult,
    blocksOverride?: ContentBlock[],
    perTurnBilling?: { turnDeltaUsd: number; parentOwnCostUsd: number; childUsage: ChildCostRecord[] },
    exitReasonOverride?: string,
    origin?: MessageOrigin,
  ) => HarnessEvent;
  compactionDeps: (
    ctx: HarnessContext<NativeConfig>,
    transport: Transport,
    dispatcher: HookDispatcher,
  ) => CompactionDeps;
  runSignal: (ctx: HarnessContext<NativeConfig>) => AbortSignal;
};

/**
 * The warm `/compact` CONTROL turn. Returns `true` when it handled the turn — the
 * caller then runs its `continue`, which is what the inline block's trailing
 * `continue;` did.
 */
export async function* runCompactControlTurn(
  ctx: HarnessContext<NativeConfig>,
  cfg: NativeConfig,
  transport: Transport,
  prologue: RunPrologue,
  rc: RunContext,
  userTurn: UserTurn,
  perTurnBilling: PerTurnBilling,
  deps: RunTurnDeps,
): AsyncGenerator<HarnessEvent, boolean> {
  // ── WARM `/compact` CONTROL turn ────────────────────────────────────────
  // A control:'compact' turn forces an immediate MANUAL compaction at the turn
  // boundary instead of a model turn. It runs INSIDE this loop (the SOLE journal
  // writer) so the splice is serialized with every other write — no single-writer
  // race. Shares runCompaction with the cold `/compact` (compactNow) so they never
  // drift; never-throw (a failure degrades to a finalized turn); drives NO model
  // call. History: docs/learnings/native-harness-history.md (Compaction).
  if (userTurn.control === 'compact') {
    let compacted: CompactionResult | null = null;
    let notice = COMPACTION_NOOP_NOTICE; // X1: a PreCompact hook's block says why instead
    // Journal-gated AND config-gated, identical to compactNow: a manual compact
    // needs a journal to splice and an opt-in `compaction` config on this arm.
    // Absent → no-op (still finalizes below; never hangs).
    if (cfg.journal && cfg.compaction) {
      try {
        compacted = await runManualCompaction(deps.compactionDeps(ctx, transport, prologue.dispatcher));
      } catch (compactErr) {
        if (cfg.signal?.aborted) throw compactErr; // route to user_aborted upstream
        // The path a live user actually hits when they type `/compact`. Record the planner's
        // NAMED reason, keep any summarize it already paid for, and EMIT both legs — the
        // usage event is the one the server's re-price reads, and this path emitted none.
        console.warn('[NativeHarness] warm /compact failed', compactErr);
        notice = blockedCompactionNotice(compactErr) ?? notice;
        for (const ev of await refusalEvents(
          deps.compactionDeps(ctx, transport, prologue.dispatcher),
          rc,
          'manual',
          compactErr,
        )) {
          yield ev;
        }
      }
    }
    if (compacted) {
      // Bill the compaction summarize cost — cumulativeCostUsd (run()'s local)
      // is in scope and the terminalTurnEnd yield below carries it through
      // turn_end.billing → AGENT_RESULT → the server's delta-deduct.
      rc.billing.cumulativeCostUsd += compacted.compactionCostUsd;
      // Agent v2 (Task 4): a /compact summarize call is the PARENT's own model
      // work → advance the independent parent-own accumulator in lockstep.
      rc.billing.parentOwnCostUsd += compacted.compactionCostUsd;
      // P2.1 (Task 4): journal the summarize round's usage at the fold.
      // Guarded (PR-1300 review): this block's NEVER-THROW contract must hold —
      // an append failure (disk full) after a successful compaction degrades to
      // a journal under-count (safe direction), never an unfinalized turn.
      try {
        await appendUsageEntry(cfg.journal, ctx, {
          costUsd: compacted.compactionCostUsd,
          model: compacted.compactionModel,
          source: 'compaction',
          inputTokens: compacted.compactionUsage.inputTokens,
          outputTokens: compacted.compactionUsage.outputTokens,
        });
      } catch (usageErr) {
        console.warn(`[NativeHarness] /compact usage append failed (journal under-counts, billing unaffected): ${String(usageErr)}`);
      }
      yield* yieldIfPresent(compactionUsageEvent(compacted, ctx.taskId, rc.billing.roundCounter.value));
      yield compacted.event;
    }
    // Finalize the control turn so the driver emits AGENT_END (never-hang). A
    // successful compaction's SESSION_COMPACTED → CompactionBlock is the feedback; a
    // NO-OP (null) surfaces a brief notice block so warm `/compact` is never total
    // silence, and carries a valid (empty) modelUsage. suggestNextPrompt does not
    // fire (no new exchange to predict from).
    // History: docs/learnings/native-harness-history.md (Compaction).
    yield deps.terminalTurnEnd(
      transport,
      ctx,
      {
        kind: 'completed',
        summary: '',
        costUsd: rc.billing.cumulativeCostUsd,
        numTurns: 0,
        durationMs: 0,
        modelUsage: transport.buildModelUsage(ZERO_USAGE, ctx.model),
        raw: { subtype: 'success', errors: [] },
      },
      rc.billing.cumulativeCostUsd,
      undefined,
      compacted ? undefined : [{ type: 'text', text: notice }],
      perTurnBilling(),
      undefined, // no exitReasonOverride (P4 Task 3)
      userTurn.origin,
    );
    return true; // was: continue; // the run stays WARM, parked for the next user turn
  }
  return false;
}

/**
 * Ingest the user message: coalesce staged text/images/media, run the
 * UserPromptSubmit seam, journal the entry. Returns `true` when a hook HALTED the
 * prompt — the caller then runs its `continue`, which is what the inline
 * `continue;` did.
 */
export async function* ingestUserTurn(
  ctx: HarnessContext<NativeConfig>,
  cfg: NativeConfig,
  transport: Transport,
  prologue: RunPrologue,
  rc: RunContext,
  userTurn: UserTurn,
  inMemoryHistory: ProviderHistory,
  stagedTexts: string[],
  stagedImages: ImageBlock[],
  stagedMedia: MediaBlock[],
  perTurnBilling: PerTurnBilling,
  deps: RunTurnDeps,
): AsyncGenerator<HarnessEvent, boolean> {
  // Append the user message to the journal (first-class entry); no journal → push
  // to the in-memory ProviderHistory. A CONTINUE turn appends NO user entry — the
  // paused tool_use's resolution was already materialized in place, so skipping
  // appendUserEntry IS the auto-query suppression. Buffered staged texts are
  // prepended here so they merge into this turn's single user entry (empty on the
  // normal path → byte-identical).
  // History: docs/learnings/native-harness-history.md (Coalescing; HITL continue).
  if (!userTurn.continueInteraction) {
    let mergedText =
      stagedTexts.length > 0
        ? [...stagedTexts, userTurn.text].join('\n')
        : userTurn.text;
    stagedTexts.length = 0; // consumed — the next turn starts fresh
    // Coalesce staged images (if any) ahead of this turn's own images, then
    // clear. No staging → mergedImages === userTurn.images → byte-identical.
    const mergedImages =
      stagedImages.length > 0
        ? [...stagedImages, ...(userTurn.images ?? [])]
        : userTurn.images;
    stagedImages.length = 0;
    // Same coalescing for the turn's media pointers (VIDEO_UNDERSTANDING_V1). No
    // staging AND no media on this turn → undefined → byte-identical.
    const mergedMedia =
      stagedMedia.length > 0
        ? [...stagedMedia, ...(userTurn.media ?? [])]
        : userTurn.media;
    stagedMedia.length = 0;

    // UserPromptSubmit seam — fires as the user turn is ingested, before it is
    // journaled/driven. A `halt` REFUSES the prompt (not journaled, no model call,
    // but ONE terminal turn_end — never-hang); `additionalContext` AUGMENTS the
    // merged text. No callback → no-field continue → byte-identical.
    // History: docs/learnings/native-harness-history.md (Hooks lifecycle).
    const ups = await dispatchLifecycle(
      prologue.dispatcher,
      buildUserPromptSubmitInput(mergedText),
      deps.runSignal(ctx),
      ctx.sessionId,
    );
    if (ups.decision === 'halt') {
      yield deps.terminalTurnEnd(
        transport,
        ctx,
        {
          kind: 'refused',
          text: ups.stopReason ?? 'Prompt refused by hook.',
          raw: { subtype: 'refused', errors: [] },
        },
        rc.billing.cumulativeCostUsd,
        undefined,
        undefined,
        perTurnBilling(), // a refused prompt drove no model call → 0 delta
        undefined, // no exitReasonOverride (P4 Task 3)
        userTurn.origin,
      );
      return true; // was: continue; // the next user turn (if any) starts fresh
    }
    const upsCtx = continueContext(ups);
    if (upsCtx) mergedText = `${mergedText}\n\n${upsCtx}`;

    if (cfg.journal) {
      await appendUserEntry(cfg.journal, ctx, mergedText, mergedImages, mergedMedia);
      // P4 Task 4: durable initiative marker alongside the user entry, so a
      // fresh-process resume re-derives "this turn is ambient". No-op for a
      // non-initiative origin → byte-identical journal.
      await appendInitiativeMarker(cfg.journal, ctx, userTurn.origin);
    } else {
      transport.pushUser(inMemoryHistory, mergedText, mergedImages, mergedMedia);
    }
    // Phase 3 (spec 2026-09-05-orchestration-teamwork §4.8) — the host's one-line
    // turn-head note, AFTER the person's entry and before the first model call. Its own
    // entry, never a prefix on the person's text: the loop must not put words inside a
    // person's message. `injected: 'engine'` is what keeps it out of every turn count
    // and every rail that reaches back for "the ask". Consecutive user-role entries are
    // legal by construction — the projection's validity floor merges a run of them into
    // one wire turn (engine/request-validity.ts mergeConsecutiveUserTurns, and the Gemini
    // twin), which is the same floor the wrap-up nudge behind a tool_result already
    // rides. No seam, or a null answer → nothing is appended → byte-identical.
    const headNote = await cfg.turnHeadNote?.();
    if (headNote) {
      if (cfg.journal) await appendInjectedUserEntry(cfg.journal, ctx, headNote, 'engine');
      else transport.pushUser(inMemoryHistory, headNote);
    }
  }
  return false;
}
