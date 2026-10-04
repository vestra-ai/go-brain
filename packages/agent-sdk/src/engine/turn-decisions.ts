/**
 * turn-decisions.ts — the separable policy blocks the native iterate loop
 * (native-harness.ts `iterateTurn`) used to inline, lifted out so the
 * highest-churn abort/steer paths are independently testable WITHOUT
 * re-driving the whole harness. Behaviour-preserving (byte-identical goldens):
 * `iterateTurn` orchestrates (call → apply the decision/effect), these own the
 * policy.
 *
 *  - abort-sealing classification: `isAbortShapedError`, `isRoundAbort`,
 *    `classifyTerminalAbort`, `collectRunningToolUseIds`.
 *  - structured-output epilogue refusal: `epilogueRefusalShortCircuit`.
 *  - compaction-trigger fold: `foldCompactionResult` (the billing invariant).
 *  - per-round Nami recall: `consultRecall`.
 *  - mid-turn steer injection: `appendSteerEntry`, `injectStagedSteer`.
 */
// VALUE imports (not just types) — isAbortShapedError needs the wrapper classes
// themselves for instanceof identity. Both are direct deps of this package, and
// these are the SAME installed module instances the transports throw from.
import { APIUserAbortError as AnthropicAPIUserAbortError } from '@anthropic-ai/sdk';
import { APIUserAbortError as OpenAIAPIUserAbortError } from 'openai';
import type { HarnessContext } from '../contract/harness.js';
import type { ContentBlock } from '../contract/blocks.js';
import type { TurnOutcome } from '../contract/turn-outcome.js';
import type { NativeConfig } from './native-config.js';
import type { ProviderHistory, Transport } from './transport.js';
import { appendUserEntry, appendInjectedUserEntry } from './native-journal.js';
import { STEER_MARKER_PREFIX, frameQueuedAdditions } from '../contract/injected-user-text.js';
import { projectWire, type FrozenElision } from './context-elision.js';
import {
  buildRecallQuery,
  fetchRecall,
  clampRecall,
  fenceRecall,
  RECALL_DEADLINE_MS_DEFAULT,
  RECALL_MAX_CHARS_DEFAULT,
  RECALL_MAX_PER_TURN_DEFAULT,
  type RecallSeam,
  type RecallConsultSample,
} from './recall.js';

// ── abort-sealing: classification ────────────────────────────────────────────

/** True for the abort-shaped throws a killed provider stream surfaces: the
 *  platform 'AbortError' (undici/DOMException — what mocks and bare fetch throw)
 *  AND the SDK wrappers' APIUserAbortError (Anthropic/OpenAI clients wrap an
 *  aborted stream in their own class — same shape subagent-runner's
 *  SETTLE-ON-ABORT note calls out). The live-fire steer drill caught the narrow
 *  'AbortError'-only check missing the real SDK shape — the round-abort escaped
 *  to the terminal catch with a live root signal and misclassified as
 *  model_error. The name-based patch for that drill matched NOTHING in practice:
 *  NEITHER SDK's APIUserAbortError class sets `.name`, so a real instance
 *  reports `.name === 'Error'` (verified empirically on both) — only hand-rolled
 *  test doubles that set `.name = 'APIUserAbortError'` ever passed the name arm.
 *  Hence instanceof against the SAME installed module instances the transports
 *  throw from — exact and minification-proof — PLUS the name arms, kept because
 *  they still cover raw DOMException aborts and duck-typed doubles.
 *  Exported for tests. */
export function isAbortShapedError(err: unknown): boolean {
  if (err instanceof OpenAIAPIUserAbortError || err instanceof AnthropicAPIUserAbortError) return true;
  const name = (err as { name?: string } | null)?.name;
  return name === 'AbortError' || name === 'APIUserAbortError';
}

/**
 * The round-abort classifier (P3.5 "abort now, continue same stream"): the
 * sandbox's steer-interrupt swaps the LIVE run scope BEFORE aborting the old
 * one, so an abort-shaped throw whose live signal is NOT aborted is a
 * round-abort (kill the in-flight stream/batch and continue the SAME turn), not
 * a terminal stop. A real interrupt (live signal aborted) or a non-abort throw
 * is NOT a round-abort. Keyed on `signalAborted === false` (never
 * `!signalAborted`): an ABSENT signal (undefined) rethrows to the terminal
 * catch, byte-identical to the plain hard-stop path.
 */
export function isRoundAbort(err: unknown, signalAborted: boolean | undefined): boolean {
  return isAbortShapedError(err) && signalAborted === false;
}

/** What the terminal catch classifies an unwinding turn into. */
export interface TerminalAbortClassification {
  outcome: TurnOutcome;
  /** The abort condition I4 uses to stamp the 'interrupted' tool card — only a
   *  genuine user-abort seals with "Interrupted by user."; a non-abort terminal
   *  error heals with a NEUTRAL empty-blocks result. */
  userAborted: boolean;
}

/**
 * The terminal catch's outcome decision (never-throw): an abort is a CLEAN stop
 * (`user_aborted` with the streaming/tools phase); any other throw maps onto the
 * shared taxonomy via `classifyError` so errors get the same Retry UX as the
 * other arms. `classifyError` is injected (a `transport.classifyError` closure)
 * so this stays a pure decision over the abort signal + error shape.
 */
export function classifyTerminalAbort(args: {
  err: unknown;
  signalAborted: boolean | undefined;
  inToolBatch: boolean;
  classifyError: (err: unknown) => TurnOutcome;
}): TerminalAbortClassification {
  const abortShaped = isAbortShapedError(args.err);
  const outcome: TurnOutcome =
    args.signalAborted || abortShaped
      ? { kind: 'user_aborted', abortPhase: args.inToolBatch ? 'tools' : 'streaming', raw: { subtype: 'aborted', errors: [] } }
      : args.classifyError(args.err);
  const userAborted = args.signalAborted === true || abortShaped;
  return { outcome, userAborted };
}

/**
 * The killed round's still-running tool cards (founder-visible pill heal, P3.5).
 * Captured BEFORE the seal flips their status to 'interrupted', so the caller
 * can emit each one's interrupted tool_result through the SAME block→sink path a
 * settled tool uses (otherwise a killed round's cards spin until the turn's
 * terminal — the steered continuation can run for minutes).
 */
export function collectRunningToolUseIds(turnBlocks: ContentBlock[]): string[] {
  return turnBlocks
    .filter((b) => b.type === 'tool_use' && (b as { status?: string }).status === 'running')
    .map((b) => (b as { toolUseId?: string }).toolUseId)
    .filter((id): id is string => id !== undefined);
}

/**
 * The structured-output epilogue's REFUSAL short-circuit (pure, outcome-driven).
 * Fires ONLY on a genuine refusal signal (`stopReason ∈ {refusal, content_filter}`),
 * never bare emptiness — a benign empty completion must still flow into the JSON.parse
 * retry loop (a later attempt can succeed). Returns a `refused` outcome, else null.
 * Why refusal-only (vs the old parse-loop that triple-billed a refusal):
 * docs/learnings/native-harness-history.md (structured-output epilogue).
 * Pinned by: structured-output-epilogue.refusal.test.ts.
 */
export function epilogueRefusalShortCircuit(
  stopReason: string | null,
  text: string,
): Extract<TurnOutcome, { kind: 'refused' }> | null {
  const isRefusal = stopReason === 'refusal' || stopReason === 'content_filter';
  if (!isRefusal) return null;
  return {
    kind: 'refused',
    // Carry the refusal text when present; a refusal that carries NO text gets a
    // stable explanatory message so the bubble is never blank.
    text: text.trim() !== '' ? text : 'The model declined to produce a structured response.',
    raw: { subtype: 'refusal', errors: [] },
  };
}

// ── compaction-trigger: the cost/usage fold ──────────────────────────────────

/** The billing deltas + usage entry a non-null compaction result folds into. */
export interface CompactionFold {
  cumulativeDeltaUsd: number;
  parentOwnDeltaUsd: number;
  usageEntry: {
    costUsd: number;
    model: string;
    source: 'compaction';
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Fold a compaction summarize round into the turn's billing (pure). The cost
 * folds into cumulative → the next turn_end's billing, AND — Agent v2 (Task 4)
 * — advances the parent-OWN accumulator in LOCKSTEP (auto-compaction is the
 * parent's own model work, never the child fold). The usage entry mirrors the
 * summarize call's raw usage + model with source:'compaction' so the journal
 * records the fold. Both accumulators move by the same amount: the additive
 * `0 + 0 === 0` identity is why zeroed billing must be caught elsewhere (the
 * positive-spend tripwire), but the LOCKSTEP is pinned here.
 */
export function foldCompactionResult(result: {
  compactionCostUsd: number;
  compactionModel: string;
  compactionUsage: { inputTokens: number; outputTokens: number };
}): CompactionFold {
  return {
    cumulativeDeltaUsd: result.compactionCostUsd,
    parentOwnDeltaUsd: result.compactionCostUsd,
    usageEntry: {
      costUsd: result.compactionCostUsd,
      model: result.compactionModel,
      source: 'compaction',
      inputTokens: result.compactionUsage.inputTokens,
      outputTokens: result.compactionUsage.outputTokens,
    },
  };
}

// ── per-round Nami recall (read-on-relevance) ────────────────────────────────

/**
 * Turn-scoped recall state (mutated in place across the turn's rounds).
 * `count` bounds this turn's appended fences (maxPerTurn); `lastQuery`/`lastMissed`
 * implement the duplicate-consult short-circuit (an unchanged query whose previous
 * consult produced a miss/duplicate skips the RPC until the query changes).
 */
export interface RecallTurnState {
  count: number;
  lastQuery: string | undefined;
  lastMissed: boolean;
}

/** Fresh per-turn recall state. */
export function newRecallTurnState(): RecallTurnState {
  return { count: 0, lastQuery: undefined, lastMissed: false };
}

/**
 * P5 Task 2 — the per-round Nami consult (read-on-relevance). Deadline-raced
 * (run-signal-aware): a slow port delays the round by at most deadlineMs, then
 * proceeds without recall; an abort resolves the race immediately.
 *
 * CACHE-HONEST DELIVERY (fleet major, PR #1347): the fence is appended as a
 * FIRST-CLASS user journal entry and enters via re-projection — never an
 * in-memory pin (which re-wrote the hit turn's whole span into cache every later
 * request). A journaled fence costs ONE bounded append and is reproduced
 * byte-identically by every later projection; dedupe is DURABLE (a fence already
 * in the projection is never re-appended). Mutates `state` and returns the
 * (possibly re-projected) history. Caller invokes ONLY when the seam is present;
 * a missing journal or an already-aborting signal is a no-op. Never-throw: a
 * consult failure is swallowed unless the signal aborted (→ user_aborted).
 */
export async function consultRecall(
  recallSeam: RecallSeam,
  cfg: NativeConfig,
  ctx: HarnessContext<NativeConfig>,
  transport: Transport,
  state: RecallTurnState,
  history: ProviderHistory,
  /** The turn's FROZEN elision — the fence re-projection rides the SAME wire seam
   *  the turn head used, or the round after a recall hit ships raw bodies where the
   *  round before it shipped stubs and busts the whole cached prefix. */
  elision: FrozenElision | null,
): Promise<ProviderHistory> {
  if (!cfg.journal || cfg.signal?.aborted) return history;
  try {
    if (state.count < (recallSeam.maxPerTurn ?? RECALL_MAX_PER_TURN_DEFAULT)) {
      // Time the WHOLE consult (race + append + re-project) for the observer.
      const consultStart = Date.now();
      let consultOutcome: RecallConsultSample['outcome'] | undefined;
      // Warm O(1) — the projection cache is hot from the round head's reads.
      const projected = (await cfg.journal.project()).messages;
      const recallQuery = buildRecallQuery(projected);
      // Duplicate-consult short-circuit: same query as last consult AND it
      // produced nothing new → skip the RPC; a query change re-arms.
      const shortCircuit = recallQuery === state.lastQuery && state.lastMissed;
      if (recallQuery && !shortCircuit) {
        const hit = await fetchRecall(
          recallSeam.readRelevant,
          recallQuery,
          recallSeam.deadlineMs ?? RECALL_DEADLINE_MS_DEFAULT,
          cfg.signal,
        );
        const fenced = fenceRecall(clampRecall(hit, recallSeam.maxChars ?? RECALL_MAX_CHARS_DEFAULT));
        // Durable dedupe: an identical fence anywhere in the projection is never
        // re-appended (the journal is the memory of what the model was shown).
        const alreadyShown =
          fenced !== '' &&
          projected.some(
            (e) =>
              e.payload.type === 'user' &&
              e.payload.blocks.some((b) => b.type === 'text' && b.text === fenced),
          );
        state.lastQuery = recallQuery;
        state.lastMissed = fenced === '' || alreadyShown;
        consultOutcome = fenced === '' ? 'empty' : alreadyShown ? 'duplicate' : undefined;
        if (fenced && !alreadyShown && !cfg.signal?.aborted) {
          await appendInjectedUserEntry(cfg.journal, ctx, fenced, 'engine');
          history = await projectWire(cfg.journal, transport, elision);
          state.count += 1;
          consultOutcome = 'appended';
        }
      } else if (recallQuery && shortCircuit) {
        consultOutcome = 'short-circuit';
      }
      if (consultOutcome && recallSeam.onConsult) {
        try {
          recallSeam.onConsult({ waitMs: Date.now() - consultStart, outcome: consultOutcome });
        } catch {
          /* a throwing observer never affects the turn */
        }
      }
    }
  } catch (recallErr) {
    if (cfg.signal?.aborted) throw recallErr; // route to user_aborted
    console.warn('[NativeHarness] recall consult failed — skipping', recallErr);
  }
  return history;
}

// ── mid-turn steer injection ─────────────────────────────────────────────────

/**
 * Append a drained steer as the `[User steered mid-task]: …` FIRST-CLASS user
 * entry and return the history the next model call must see. Journal path: a
 * durable append + re-project (a resume replays it; within-turn prefixes stay
 * cache-stable). In-memory path: fold into the provider history. ONE marker
 * discipline for all three consult sites (round head, tool-round boundary,
 * round-abort catch) — they can never drift.
 */
export async function appendSteerEntry(
  cfg: NativeConfig,
  ctx: HarnessContext<NativeConfig>,
  transport: Transport,
  history: ProviderHistory,
  text: string,
  /** The turn's FROZEN elision — see consultRecall. */
  elision: FrozenElision | null,
): Promise<ProviderHistory> {
  const steerMsg = `${STEER_MARKER_PREFIX}${text}`;
  if (cfg.journal) {
    await appendUserEntry(cfg.journal, ctx, steerMsg);
    // Re-project so the steer is in the history the NEXT model call sees.
    // (The top-of-loop compaction re-project is conditional; do it here so
    // a non-compacting next round still picks up the steer.)
    return projectWire(cfg.journal, transport, elision);
  }
  transport.pushUser(history, steerMsg);
  return history;
}

/** Outcome of a staged-steer poll: the (possibly re-projected) history and
 *  whether a steer landed (the caller flips `nextRoundKind` to 'steer'). */
export interface StagedSteerResult {
  history: ProviderHistory;
  steered: boolean;
}

/**
 * Inject staged steers at a safe round boundary. Two flavours share this ONE
 * discipline so the round head and the post-tool-batch boundary can't drift:
 *  - `drainSteerText` (P3 STEER V2 — the interrupt-with-queued-message drain):
 *    a user ESC that found staged messages armed this instead of retiring the
 *    turn; the drained text lands as the marker-tagged user entry so the model
 *    sees a mid-task steer, not a new request, and the SAME turn continues.
 *  - `pollSteer` (K6 A2b — priority:'now', boundary only) when `includePoll`:
 *    message(s) staged mid-turn, taken NON-BLOCKINGLY (the lane drains its whole
 *    'now' lane at once) and injected as ONE user entry FRAMED by
 *    frameQueuedAdditions — the frame states the additive semantics ("adds to,
 *    does not replace; answer everything asked this turn") because the earlier
 *    unframed form read as a fresh ask that SUPERSEDED the ones before it
 *    (incident bf9293df: three questions in one turn, only the newest answered).
 *    The next model call STEERS (it does NOT abort).
 * Both are abort-guarded: a steer appended while the signal is already aborting
 * would pollute an unwinding turn's journal, so a poll on an aborted signal is
 * skipped and its message left for the unwinding turn. The abort guard is
 * re-read per seam (an abort can fire during the drain's append await). Absent
 * seam / not armed / nothing staged → { steered:false } → byte-identical.
 */
export async function injectStagedSteer(
  cfg: NativeConfig,
  ctx: HarnessContext<NativeConfig>,
  transport: Transport,
  history: ProviderHistory,
  includePoll: boolean,
  /** The turn's FROZEN elision — see consultRecall. */
  elision: FrozenElision | null,
): Promise<StagedSteerResult> {
  let steered = false;
  const drained = !cfg.signal?.aborted ? cfg.drainSteerText?.() : undefined;
  if (drained) {
    history = await appendSteerEntry(cfg, ctx, transport, history, drained, elision);
    steered = true;
  }
  if (includePoll) {
    const polled = !cfg.signal?.aborted ? cfg.pollSteer?.() : undefined;
    // The frame's mint returns '' on whitespace-only input — skip the append
    // (an empty drain must never write an empty user entry or flip the round
    // kind to 'steer').
    const framed = polled ? frameQueuedAdditions(polled.texts ?? [polled.text]) : '';
    if (framed) {
      steered = true;
      if (cfg.journal) {
        await appendUserEntry(cfg.journal, ctx, framed);
        history = await projectWire(cfg.journal, transport, elision);
      } else {
        transport.pushUser(history, framed);
      }
    }
  }
  return { history, steered };
}
