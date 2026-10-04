/**
 * context-elision.ts — the engine-side glue for CONTEXT_ELISION_V1.
 *
 * The POLICY (what to elide, and the quantized cut that makes it cache-safe) is
 * pure and lives in kernel/compaction/elide.ts. This module is the thin impure
 * shell around it: it reads the flag, resolves the model's context window,
 * freezes one decision per user turn, and performs the one piece of I/O the
 * policy cannot — spilling elided bodies to the offload dir.
 *
 * Two functions, used together by the native harness:
 *
 *   prepareElision()  ONCE per user turn, before the first projection.
 *   wireMessages()    at EVERY site that builds provider history or measures the
 *                     context ledger.
 *
 * The second is the coherence seam: because the wire and the ledger both read
 * the same frozen map, the bytes that ship and the number the compaction trigger
 * sees cannot drift. The inverted-prune failure — measure the shrunken copy,
 * ship the full one — is unrepresentable when there is only one view.
 */

import {
  computeElisionCut,
  elideProjection,
  applyElision,
  clampCutMonotonic,
  projectTokenCount,
  pruneToolResults,
  DEFAULT_ELISION_POLICY,
  type ElisionCut,
  type PruneConfig,
} from '../kernel/index.js';
import { resolveCompactionBudget } from './compaction-budget.js';
import { spillElidedResults } from './context-offload.js';
import { appendElisionShapeEntry } from './native-journal.js';
import { contextElisionEnabled } from '../policy/feature-flags.js';
import type { JournalEntry } from '../contract/journal.js';
import type { Journal } from '../kernel/index.js';
import type { ProviderHistory, Transport } from './transport.js';
import type { HarnessContext } from '../contract/harness.js';
import type { NativeConfig } from './native-config.js';
import type { RunContext } from './run-context.js';

/**
 * One user turn's frozen elision decision. `replacements` is keyed by journal
 * `seq`; entries absent from it ride verbatim.
 */
export interface FrozenElision {
  replacements: ReadonlyMap<number, JournalEntry>;
  cut: ElisionCut;
  elidedResults: number;
  elidedImages: number;
  freedTokens: number;
}

/**
 * Compute this user turn's elision and FREEZE it.
 *
 * Called ONCE per user turn, at the top of iterateTurn, before the first history
 * projection. Everything downstream — every mid-turn re-projection after a tool
 * batch, the compaction ledger, the context-usage meter — applies this same
 * frozen map, which is what makes the wire bytes identical across the many tool
 * rounds of a single turn. A turn that re-decided per round would bust the
 * prompt cache on every round, the exact failure this design exists to avoid.
 *
 * Freezing at turn start is also COMPLETE: entries appended during the turn are
 * by construction the newest, so they sit inside the live window and can never
 * cross the cut mid-turn. That completeness is what lets the TURN EPILOGUE reuse
 * the same map: the off-loop sweep runs after the last round, on entries the map
 * does not name, so it reproduces that round's prefix exactly.
 *
 * The decision is also PARKED ON rc, next to the monotonic cut it already owns,
 * because the epilogue's side calls are issued from run() and cannot see
 * iterateTurn's local. rc.elision is cleared FIRST, before any early return, so a
 * turn that elides nothing never inherits the previous turn's map.
 *
 * NEVER-THROWS: elision is an optimization. A failure returns null and the turn
 * runs on the raw projection — a smaller wire is worth having, never worth a
 * dropped turn.
 */
export async function prepareElision(
  ctx: HarnessContext<NativeConfig>,
  cfg: NativeConfig,
  rc: RunContext,
): Promise<FrozenElision | null> {
  rc.elision = null;
  if (!contextElisionEnabled() || !cfg.journal) return null;
  try {
    const messages = (await cfg.journal.project()).messages;
    // THE BUDGET IS THE COMPACTION TRIGGER, not the context window. Elision only
    // ever acts in the span below where compaction rewrites history, so sizing the
    // live window and the stride against the window sized them against a number
    // three times too large on every 1M lane — the mechanism could not fire before
    // compaction made it moot. Same resolver `maybeCompact` reads, so the two can
    // no longer drift apart (compaction-budget.ts).
    // The monotonic ratchet is handed THIS projection, not just the previous cut:
    // it carries the cut forward only while the span that cut covered is still
    // there. A compaction between two turns re-heads the projection, so the carry
    // releases on its own — nothing at any compaction call site has to say so.
    const cut = clampCutMonotonic(
      computeElisionCut(
        messages,
        resolveCompactionBudget(ctx.model, cfg.compaction),
        DEFAULT_ELISION_POLICY,
      ),
      rc.elisionCut,
      messages,
    );
    if (cut.resultCutTokens <= 0 && cut.imageCutTokens <= 0) return null;
    rc.elisionCut = cut;

    const outcome = elideProjection(messages, cut, { taskId: ctx.taskId });
    if (outcome.replacements.size === 0) return null;

    // WRITE-BEFORE-STUB: the full bodies must be on disk before a stub naming
    // them can reach the wire (the offload primitive's ordering contract).
    if (cfg.workingDir) await spillElidedResults(outcome.spills, cfg.workingDir);

    rc.elision = {
      replacements: outcome.replacements,
      cut,
      elidedResults: outcome.elidedResults,
      elidedImages: outcome.elidedImages,
      freedTokens: outcome.freedTokens,
    };
    // Make the decision OBSERVABLE. Until this line the only durable evidence
    // elision had ever run was the spill files on the sandbox's disk, so "did it
    // fire on this turn?" could not be answered from the record at all. Awaited
    // inside the existing try/catch, which is the never-throws boundary — the
    // helper additionally swallows its own errors, so neither the append nor a
    // journal outage can cost the turn its elision.
    await appendElisionShapeEntry(cfg.journal, ctx, {
      round: rc.billing.roundCounter.value,
      model: ctx.model,
      elidedResults: outcome.elidedResults,
      elidedImages: outcome.elidedImages,
      freedTokens: outcome.freedTokens,
      resultCutTokens: cut.resultCutTokens,
      imageCutTokens: cut.imageCutTokens,
      strideTokens: cut.strideTokens,
    });
    return rc.elision;
  } catch {
    return null;
  }
}

/**
 * Project journal entries onto their WIRE form.
 *
 * THE coherence seam — see the module header. Elision absent (flag OFF, or
 * nothing yet elidable) ⇒ the raw array, by the same reference.
 */
export function wireMessages(
  messages: JournalEntry[],
  elision: FrozenElision | null,
): JournalEntry[] {
  return elision ? applyElision(messages, elision.replacements) : messages;
}

/**
 * THE canonical wire projection: journal → elided view → provider history.
 *
 * `project()` → {@link wireMessages} → `historyFromJournal` is the exact path the
 * turn head builds `history` from, and the path a cold resume reproduces. Every
 * in-turn rebuild MUST use it, because a rebuild that skips the seam sends the RAW
 * bodies where the previous round sent stubs — and prompt caches match an exact
 * prefix, so that single substitution invalidates the whole cached prefix, then the
 * next turn head re-projects elided and invalidates it again. A session that steers
 * or recalls regularly ends up paying a 1.25x write on every turn where it was
 * paying a 0.1x read. That is the documented cause of the 2026-08-13
 * CONTEXT_ELISION_V1 rollback, and it is why this is one function and not a
 * convention: the raw form should be unreachable from the loop, not merely
 * discouraged.
 *
 * It also keeps ledger coherence honest in the other direction — a raw rebuild
 * ships bytes the compaction trigger never measured.
 *
 * Elision absent (flag off, or nothing yet elidable) ⇒ byte-identical to the raw
 * projection, because {@link wireMessages} returns the same array by reference.
 */
export async function projectWire(
  journal: Journal,
  transport: Pick<Transport, 'historyFromJournal'>,
  elision: FrozenElision | null,
): Promise<ProviderHistory> {
  return transport.historyFromJournal(wireMessages((await journal.project()).messages, elision));
}

/**
 * The compaction trigger's `messages` bucket — measured off what actually goes
 * on the wire.
 *
 * ON (elision present): measure `wireMessages(...)`, the exact array the model
 * call is built from, and charge images, which are real wire bytes the text-only
 * ledger cannot see. Wire and measurement are the same object; they cannot drift.
 *
 * OFF: the pre-existing prune path, unchanged and byte-identical. Worth naming
 * what that path does, because it is the failure mode this feature must not
 * copy: `pruneToolResults` shrinks a COPY used for the trigger ledger ONLY —
 * the compaction body is handed the ORIGINAL projection, and every wire
 * projection in iterateTurn re-projects the journal raw. So the prune tier
 * lowers the measurement while the full bytes ride the wire: compaction fires
 * LATER than it should, and the prune buys back no context at all. Turning the
 * flag ON fixes that inversion (the elided view is both measured and shipped);
 * the OFF path is deliberately left alone so it stays a true byte-identical
 * control.
 */
export function measureWireMessages(
  messages: JournalEntry[],
  elision: FrozenElision | null,
  pruneCfg: PruneConfig,
): number {
  if (elision) {
    return projectTokenCount(wireMessages(messages, elision), { countImages: true }).messages;
  }
  return projectTokenCount(pruneToolResults(messages, pruneCfg)).messages;
}
