/**
 * telemetry-entries — the journal appends that exist ONLY to be queried later.
 *
 * Both entries here are CONTEXT_POLICY:false `custom` payloads: they never replay
 * into the model's context, so wire bodies stay byte-identical, and both are
 * best-effort and never-throw, because observing a mechanism must never be able to
 * cost the turn it observes. They are grouped because that contract is the concept
 * — a future third observability append belongs beside them, not back in
 * native-journal.ts, which only ratchets down (apps/reconciler file-size lint).
 *
 * Their consumers live in apps/server/src/services/alerts/ and share one reader
 * (journal-telemetry.ts). Adding an entry here without adding a consumer there
 * recreates the exact defect both of these were written to close: telemetry that
 * is armed, dark, and quietly rotting.
 */
import { base } from './journal-entry-base.js';
import type { Journal } from '../kernel/index.js';
import type { HarnessContext } from '../contract/harness.js';
import type { NativeConfigLike } from './native-config-like.js';

/**
 * The queryable per-round record of what `partitionToolBatch` DECIDED: how many
 * tool_uses the model emitted, how many were run-eligible, and the width of every
 * concurrent run that formed — tagged with the arm + model that produced them.
 *
 * WHY IT EXISTS. Nothing recorded a round's segment shape, so "did the parallel
 * subagents actually run in parallel?" could only be answered by reconstructing
 * round boundaries by hand from `usage source:'round'` entries. That forensics is
 * both expensive and easy to get WRONG in a specific, load-bearing way: the
 * `messages` table is TURN-shaped, so consecutive tool blocks there look like one
 * batch when they are N separate model rounds — and grouping journal entries
 * without filtering `agentPath` folds a SUBAGENT's own Agent calls into its
 * parent's round. Both mistakes have been made on this exact question, in opposite
 * directions. This entry answers it in one SQL predicate instead:
 *
 *   data->>'agents' >= 2 AND jsonb_array_length(data->'widths') > 0   -- batch ran
 *   data->>'agents'  = 1                                              -- a LONE Agent
 *                                                                        round: the
 *                                                                        model
 *                                                                        declined to
 *                                                                        batch
 *
 * MAIN LOOP ONLY (the caller gates on `deps.sub === undefined`). A subagent batch
 * NEVER forms a concurrent run — `partitionToolBatch` hard-returns one sequential
 * segment when `!mainLoop` — so there is no decision to observe there, and NOT
 * writing those rows removes the scope-mixing hazard by construction rather than by
 * a filter every future query has to remember.
 *
 * CONTEXT_POLICY:false (the billing-tripwire precedent — a FROZEN `custom` kind that
 * never replays into the model context), so projections and wire bodies stay
 * byte-identical. Best-effort + never-throws: a telemetry write must never disturb
 * the batch it is describing. No-op when the journal is absent.
 */
export async function appendToolBatchShapeEntry(
  j: Journal | undefined,
  ctx: HarnessContext<NativeConfigLike>,
  data: {
    /** 1-based round index within the run (rc.billing.roundCounter). */
    round: number;
    /** The ARM — `transport.api` (e.g. 'openai_responses' | 'anthropic_messages'). */
    api: string;
    /** The model that committed this round. */
    model: string;
    /** tool_uses the model emitted this round. */
    tools: number;
    /** …of which run-eligible (Agent | concurrencySafe-declared). */
    eligible: number;
    /** …of which `Agent` — the subagent-parallelism signal specifically. */
    agents: number;
    /** Width of each CONCURRENT run that formed, in batch order. `[]` = all sequential. */
    widths: number[];
  },
): Promise<void> {
  if (!j) return;
  try {
    await j.append({
      ...base(ctx),
      principal: { kind: 'system' },
      payload: {
        type: 'custom',
        key: 'tool_batch_shape',
        data,
      },
    });
  } catch {
    /* best-effort: a telemetry write must never disturb the batch it describes */
  }
}

/**
 * Record what CONTEXT_ELISION_V1 actually did this user turn.
 *
 * The mechanism was armed on staging with no way to tell whether it fired: a
 * drill had to prove it by listing spill files in `.kernel-offload/<taskId>/`,
 * because `elidedResults` / `elidedImages` / `freedTokens` were computed in
 * elide.ts, parked on `rc.elision`, and read by nothing outside
 * context-elision.ts — no log line, no trace field, no event, zero rows in
 * `log_events`. "Did elision fire on this turn?" was unanswerable from any
 * durable record. This entry answers it:
 *
 *   data->>'elidedResults' > 0     -- elision fired
 *   sum((data->>'freedTokens')::int)  -- what it bought, over a window
 *
 * ONE PER USER TURN, not per round: `prepareElision` freezes a single decision at
 * turn start and every downstream projection applies that same frozen map, so a
 * per-round row would be N copies of one fact and would misreport the turn count
 * that every rate below divides by.
 *
 * ONLY WHEN SOMETHING WAS ELIDED. `prepareElision` returns early — before this
 * call — when the flag is off, when the cut is zero, or when the replacement map
 * is empty, so a turn that elided nothing writes no row. That keeps the leg cheap,
 * and it is why the consumer's "did it fire?" denominator has to come from a
 * DIFFERENT subsystem (agent_turns) rather than from a ratio of these rows.
 *
 * CONTEXT_POLICY:false, best-effort, never-throws — same contract as
 * {@link appendToolBatchShapeEntry}. Elision is an optimization; observing it must
 * never be able to cost a turn.
 */
export async function appendElisionShapeEntry(
  j: Journal | undefined,
  ctx: HarnessContext<NativeConfigLike>,
  data: {
    /** rc.billing.roundCounter at turn start — which round this turn opened on. */
    round: number;
    /** The model whose context window sized the cut. */
    model: string;
    /** tool_results replaced by a stub this turn. */
    elidedResults: number;
    /** image blocks replaced this turn. */
    elidedImages: number;
    /** Estimated prompt tokens freed by both. */
    freedTokens: number;
    /** The quantized cut that produced them — the cache-safety grid. */
    resultCutTokens: number;
    imageCutTokens: number;
    strideTokens: number;
  },
): Promise<void> {
  if (!j) return;
  try {
    await j.append({
      ...base(ctx),
      principal: { kind: 'system' },
      payload: {
        type: 'custom',
        key: 'context_elision',
        data,
      },
    });
  } catch {
    /* best-effort: observing the optimization must never disturb the turn */
  }
}
