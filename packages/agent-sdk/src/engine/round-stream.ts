/**
 * round-stream.ts — the MODEL half of one round: what we check before sending,
 * what we send, how we drain the response, and how the result settles.
 *
 * Five phases `runOneRound` walks in order, each extracted VERBATIM from its
 * inline body (P2.2 Task 6 → the Harness-9 W4 decomposition):
 *
 *   1. checkRoundReconstruction — the journal-is-truth invariant on the history
 *      this round is about to SEND (main loop + journal path only).
 *   2. buildRoundRequest — the startStreamWithRetry params for this round.
 *   3. driveRoundStream — the normalized-stream drive: text/thinking yielded
 *      live, signed thinking + tool_use collected onto RoundState.
 *   4. settleRoundOutput — the settlement-ordered assistant + usage appends.
 *   5. emitRoundUsage — the per-round usage event (main loop only).
 *
 * The abort GUARDS deliberately stay at the call site: a mid-stream abort on the
 * subagent path returns a RoundResult (settle-on-abort, gate 1), which only the
 * round body can do.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { HarnessEvent, PromptBreakdown } from '../contract/events.js';
import type { ContentBlock } from '../contract/blocks.js';
import { resolveCapabilities } from '../contract/model-capabilities.js';
import { resolveModelProfile } from '../contract/model-profile.js';
import { mainRunCacheKey } from './main-run-cache-key.js';
import { buildPromptBreakdown } from './prompt-span.js';
import { measureWireMedia, measureRequestBytes } from './request-meter.js';
import {
  checkReconstruction,
  buildReconstructionMismatchPayload,
  RECONSTRUCTION_MISMATCH_EVENT,
  type ReconstructionMismatch,
} from './reconstruction-invariant.js';
import { wireMessages } from './context-elision.js';
import { withEmptyRecoverySeat } from './empty-recovery.js';
import { chatTailAfterToolsEnabled, contextElisionEnabled, responsesMemoryInputEnabled, subagentUsageLedgerEnabled } from '../policy/feature-flags.js';
import type { StreamEvent, Transport } from './transport.js';
import { appendAssistantEntry, appendUsageEntry } from './native-journal.js';
import { recordRoundInput } from './compaction-input.js';
import { replayChannels } from './replay-channels.js';
// Types only (erased at emit) — no runtime import edge back to round-engine.ts.
import type { RoundDeps, RoundState, startStreamWithRetry } from './round-engine.js';
import type { EarlyStart } from './tool-early-start.js';
import { monotonicMs } from './monotonic-clock.js';

/**
 * The encrypted-reasoning items captured off ONE round's stream. Derived from the
 * Transport port so the two can never drift.
 */
export type CapturedReasoning = ReturnType<NonNullable<Transport['capturedReasoning']>>;

/**
 * K4C-1 — DETERMINISTIC per-round usage id (the wire `sdk_message_uuid`).
 *
 * The native `done` stream event exposes NO provider message id, and the server's
 * `task_turn_usage.sdk_message_uuid` is a Postgres `uuid` column with a UNIQUE
 * idempotency key — so the id must be valid-uuid-shaped AND stable on replay
 * (a re-executed round must mint the SAME id so the upsert dedups). A RFC-4122
 * v5-style id derived from a stable per-round key satisfies both: unique per
 * round (turnNumber differs), stable on replay (deterministic). This mirrors the
 * Claude arm, which keys its DB row on the SDK envelope's own generated uuid
 * (not the Anthropic `msg_…` id). Self-contained (SHA-1 of the key, formatted) so
 * the pure engine adds no `uuid` dependency.
 *
 * `lane` discriminates the OFF-LOOP side calls (sweep / suggestion), which reuse
 * their turn's turn_number for grouping but must never collide with that turn's
 * main-round row on the UNIQUE sdk_message_uuid. Omitting it — every main-loop
 * caller — keeps the original key string, so main-lane ids are byte-identical.
 */
export function deterministicUsageId(taskId: string, turnNumber: number, lane?: string): string {
  const h = createHash('sha1')
    .update(
      lane === undefined
        ? `vestra-native-usage:${taskId}:${turnNumber}`
        : `vestra-native-usage:${lane}:${taskId}:${turnNumber}`,
    )
    .digest('hex');
  // Format as a v5 UUID: set version (5) + RFC-4122 variant bits.
  const v5 = (h.slice(0, 12) + '5' + h.slice(13, 16)).slice(0, 16);
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20);
  return `${v5.slice(0, 8)}-${v5.slice(8, 12)}-${v5.slice(12, 16)}-${variant}-${h.slice(20, 32)}`;
}

// Reconstruction invariant (Harness-9 W2). The journal is the source of truth: the
// history this round is about to SEND must equal what the journal re-derives through
// the canonical projection — project() → wireMessages → historyFromJournal, the
// exact path the turn head (iterateTurn) and a cold resume take. dsh byte-compares
// the outgoing wire against deriveMessages() on every request; this is that check
// at our one request site. A mismatch names an in-turn rebuild path that disagrees
// with the projection (the class that kept context elision off). MAIN loop +
// journal path only: a subagent's nested history lives in its own seam and the
// in-memory path has no second derivation. The check itself never costs a turn
// (a failure inside it warns and skips); only a GENUINE mismatch under 'throw'
// (tests, keyless replay) escapes. 'warn' — the production default — logs once per
// turn; the optional sink sees every mismatch in both modes. Without the turn's
// frozen elision the check cannot project through the seam the wire was built
// from; under CONTEXT_ELISION_V1 that would read as drift on every round, so it
// waits for the caller to thread `elision` rather than cry wolf (flag off ⇒ the raw
// projection IS the wire seam).
export async function* checkRoundReconstruction(
  deps: RoundDeps,
  st: RoundState,
): AsyncGenerator<HarnessEvent, void, void> {
  const { ctx, cfg, transport, history } = deps;
  const reconstructionMode = cfg.reconstructionCheck ?? 'warn';
  const canProject = deps.elision !== undefined || !contextElisionEnabled();
  if (reconstructionMode !== 'off' && canProject && deps.sub === undefined && cfg.journal) {
    let mismatch: ReconstructionMismatch | null = null;
    try {
      const projected = transport.historyFromJournal(
        wireMessages((await cfg.journal.project()).messages, deps.elision ?? null),
      );
      mismatch = checkReconstruction({
        round: deps.rc.billing.roundCounter.value + 1,
        incremental: history,
        projected,
      });
    } catch (checkErr) {
      console.warn('[NativeHarness] reconstruction check failed (skipped this round)', checkErr);
    }
    if (mismatch) {
      // The sink is product code: a throw there must not end the turn either.
      try {
        cfg.onReconstructionMismatch?.(mismatch);
      } catch (sinkErr) {
        console.warn('[NativeHarness] onReconstructionMismatch sink threw (ignored)', sinkErr);
      }
      if (reconstructionMode === 'throw') {
        throw new Error(`reconstruction mismatch: ${JSON.stringify(mismatch)}`);
      }
      if (!st.reconstructionWarned) {
        st.reconstructionWarned = true;
        console.warn(`[NativeHarness] reconstruction_mismatch ${JSON.stringify(mismatch)}`);
        // The DURABLE channel, once per turn on the same latch as the console line
        // (a 30-round diverged turn is ONE anomaly, not thirty rows). Server-consumed
        // → error_events; never forwarded to the frontend. 'throw' mode returned above:
        // it is tests + keyless replay only, where the thrown error IS the channel.
        yield {
          kind: 'raw',
          engine: 'native',
          event: RECONSTRUCTION_MISMATCH_EVENT,
          data: buildReconstructionMismatchPayload(mismatch, ctx.taskId, ctx.sessionId),
        };
      }
    }
  }
}

/**
 * The startStreamWithRetry params for THIS round. Every field is read off `deps`, and
 * each conditional spread keeps an absent hint OFF the request (byte-identical to the
 * pre-hint shape).
 *
 * ONE side effect, deliberately: it CONSUMES the empty-completion recovery latch
 * (`rc.recoverySeatArmed`). A round that came back empty is re-called with an
 * in-memory-only seat + nudge; those two items are never journaled, so overlaying them
 * onto a COPY here — rather than pushing them onto `deps.history` — is what keeps the
 * wire equal to what the journal re-derives. Consume-on-read is safe because the caller
 * builds the params ONCE and startStreamWithRetry reuses them across its retries; a
 * round that throws before this simply re-arms on the next one.
 */
export function buildRoundRequest(deps: RoundDeps): Parameters<typeof startStreamWithRetry>[0] {
  const {
    ctx, cfg, providerTools, system, requestedModel,
    cachePrefixHint, systemFleetPrefixChars,
  } = deps;
  let history = deps.history;
  if (deps.rc?.recoverySeatArmed === true) {
    deps.rc.recoverySeatArmed = false;
    history = withEmptyRecoverySeat(deps.transport, history);
  }
  // CHAT_TAIL_AFTER_TOOLS_V1 / RESPONSES_MEMORY_INPUT_V1 (each lane's own flag): the span the
  // run measured once at open (native-run-open.ts), so every round cuts the same bytes, and only
  // on the prompt it was measured on. A subagent's round has no run context and carries none.
  const laneFlag = resolveModelProfile(requestedModel).transport === 'openai_responses'
    ? responsesMemoryInputEnabled()
    : chatTailAfterToolsEnabled();
  const measured = laneFlag ? deps.rc?.systemMemorySpan : undefined;
  const systemMemorySpan = measured && measured.system === system ? measured.span : undefined;
  return {
  model: requestedModel,
  // Model-aware per-response output budget: read the real cap from the
  // capability registry (64k–128k for current models) so long outputs
  // finish in one shot. Unknown ids resolve to the 8192 fallback, so
  // behavior for un-hardcoded models is preserved.
  maxTokens: resolveCapabilities(requestedModel).maxOutputTokens,
  system,
  tools: providerTools,
  history,
  // exactOptionalPropertyTypes (SDK): omit `signal` when undefined.
  ...(cfg.signal !== undefined && { signal: cfg.signal }),
  // K4C-3 D2: omit when absent (no compaction) → byte-identical request.
  ...(cachePrefixHint !== undefined && { cachePrefixHint }),
  // CACHE_TIERING_V1: omit when absent (flag off) → byte-identical request.
  ...(systemFleetPrefixChars !== undefined && { systemFleetPrefixChars }),
  // CHAT_TAIL_AFTER_TOOLS_V1 / RESPONSES_MEMORY_INPUT_V1: omit when absent → byte-identical request.
  ...(systemMemorySpan !== undefined && { systemMemorySpan }),
  // OpenAI prompt-cache: a USER+MODEL-stable anchor so every main-loop
  // call of every one of a user's tasks routes to the SAME prefix-cache
  // shard (the ~29k system+tools prefix is byte-identical across a user's
  // tasks — see mainRunCacheKey for the warm-vs-cold TTFT rationale).
  // Anthropic ignores cacheKey → byte-identical there; the chat-completions
  // arm forwards it only for providers that model the field.
  //
  // P2.2 — the SUBAGENT caller overrides the anchor with its own
  // per-agent-type shard key (PR5 item 2: a nested run must never pollute
  // the parent task's shard), conditional-spread so an absent sub key
  // omits the field entirely (the legacy subagent request shape). The
  // main-caller helper is SHARED with the epilogue's cacheKey site in
  // native-harness — the two billed main-turn sites must agree on the key
  // or the epilogue would land on a cold shard.
  ...(deps.sub === undefined
    ? { cacheKey: mainRunCacheKey(ctx.config.runtimeConfig, ctx.taskId, requestedModel) }
    : deps.sub.cacheKey !== undefined
      ? { cacheKey: deps.sub.cacheKey }
      : {}),
  };
}

// Drive the normalized stream: text → live AGENT_TEXT_DELTA + accumulate,
// thinking → AGENT_THINKING_DELTA (live-only), thinking_block → the COMPLETED
// signed thinking block (collected for journaling, NOT re-emitted to the UI —
// the live deltas already rendered it), tool_use → collect, done →
// stopReason + usage. The loop never sees a provider event type.
// assistantText / thinkingBlocks / toolUses are HOISTED above the for-loop
// (D1) and reset at the top of each round — the abort catch reads the
// in-flight round off them. Completed signed thinking blocks accumulate in
// emission order; they are journaled + folded into history BEFORE the
// assistant text/tool_use so the NEXT request can replay thinking+signature
// (interleaved-thinking multi-turn correctness). Empty for arms/models
// without thinking → byte-identical to the pre-thinking path.
// P2.2 gate 1 (settle-on-abort, subagent only; Weave 2b §6.3 / AC-2b-3): a
// user/timeout abort MID-GENERATION makes readStream throw (the provider
// stream forwards the signal). On the subagent path we BREAK cleanly and let
// the nested loop return its accumulated cost — the aborted round's own
// partial tokens are unavailable (no `done` arrived), an accepted,
// unmeasurable edge; we never over-count it. A NON-abort throw still
// propagates unchanged, and the MAIN caller rethrows aborts too (its
// iterateTurn catch seals the in-flight round off `st`).
// L1 (TOOLS_MIDSTREAM_V1): a `tool_ready` heads-up goes to the round's early starts, which
// may start the call now (tool-early-start.ts). It is never collected: the same call still
// arrives as `tool_use`, and that is what the round journals and the batch runs. No early
// starts (flag off, a subagent) ⇒ ignored; flag off, no transport emits one at all.
// Returns when the first answer text arrived (the usage event's firstTextMs), undefined for a
// round that wrote none.
export async function* driveRoundStream(
  stream: AsyncIterable<StreamEvent>,
  st: RoundState,
  early?: Pick<EarlyStart, 'offer'>,
): AsyncGenerator<HarnessEvent, { firstTextAtMs: number | undefined }, void> {
  st.replay = undefined;
  let firstTextAtMs: number | undefined;
  for await (const ev of stream) {
    if (ev.kind === 'text') {
      if (firstTextAtMs === undefined && ev.text) firstTextAtMs = monotonicMs();
      st.assistantText += ev.text;
      // K3-T2: yield a text block; the CORE sink (emitHarnessEvent) routes
      // it through the shared DeltaBatcher → AGENT_TEXT_DELTA. No direct emit.
      yield { kind: 'block', block: { type: 'text', text: ev.text } };
    } else if (ev.kind === 'thinking_start') {
      // A thinking block OPENED (before its first fragment). Yield a
      // thinking_start HarnessEvent so the sink emits AGENT_THINKING_START and
      // the UI mounts the thinking pill + running timer now — Anthropic's
      // summarized adaptive thinking lags the block start by seconds. No text.
      yield { kind: 'thinking_start' };
    } else if (ev.kind === 'thinking') {
      // K3-T2: yield a thinking block; the sink emits AGENT_THINKING_DELTA
      // (live-only, not batched). No direct emit.
      yield { kind: 'block', block: { type: 'thinking', thinking: ev.text } };
    } else if (ev.kind === 'thinking_block') {
      // The completed signed thinking block — collected for journaling/history
      // (carries the verbatim signature). NOT yielded to the sink: the live
      // `thinking` deltas above already rendered this phase in the UI, and
      // re-emitting would duplicate it. Only signed blocks are replayable.
      st.thinkingBlocks.push(
        ev.signature
          ? { type: 'thinking', thinking: ev.thinking, signature: ev.signature }
          : { type: 'thinking', thinking: ev.thinking },
      );
    } else if (ev.kind === 'tool_use') {
      st.toolUses.push(ev.toolUse);
    } else if (ev.kind === 'tool_ready') {
      early?.offer(ev.toolUse);
    } else {
      // done
      st.stopReason = ev.stopReason;
      st.lastUsage = ev.usage;
      st.replay = ev.replay;
    }
  }
  return { firstTextAtMs };
}

/** One round's clock readings (monotonic-clock.ts ms), taken by runOneRound. */
export interface RoundClock {
  /** The round wanted a model response (before its request was built). */
  requestStartMs: number;
  /** The committed attempt (the last one sent) was handed to the transport. */
  sentAtMs: number;
  /** The first answer text arrived; absent when the round wrote none. */
  firstTextAtMs?: number | undefined;
  /** The stream's last event was read. */
  endMs: number;
}

/**
 * The usage event's whole-call timing from one round's clock (MODEL_CALL_EVENTS_V1 reads it):
 * the whole call, split at the moment the committed attempt was handed to the transport, and
 * when the first text showed. The two halves are named for WHEN, not whose:
 *   - `beforeSendMs`: building the request, every failed attempt (the provider's own 429 / 529 /
 *     5xx answers included) and the waits between them, a fallback switch;
 *   - `afterSendMs`: the committed attempt from hand-off to its last event, which holds the
 *     transport's own wire prep (serialization, a lazy file upload or image inlining) as well as
 *     the network and the provider, and our draining of the stream.
 * The usage event's `attempts` says how many tries went into beforeSendMs. All from the round's
 * request start, so firstTextMs sits beside ttftMs on one ruler; beforeSendMs + afterSendMs is
 * latencyMs, exactly.
 */
export function roundTiming(c: RoundClock): { latencyMs: number; beforeSendMs: number; afterSendMs: number; firstTextMs?: number } {
  // Whole milliseconds on the wire, as before; afterSendMs is the remainder, so the sum stays exact.
  const latencyMs = Math.round(c.endMs - c.requestStartMs);
  const beforeSendMs = Math.round(c.sentAtMs - c.requestStartMs);
  return {
    latencyMs,
    beforeSendMs,
    afterSendMs: latencyMs - beforeSendMs,
    ...(c.firstTextAtMs !== undefined && { firstTextMs: Math.round(c.firstTextAtMs - c.requestStartMs) }),
  };
}

/**
 * Settle the round's OUTPUT: the assistant content blocks (signed thinking first,
 * then text) onto `turnBlocks`, then the durable append — through the subagent's
 * own persistRound seam (gate 3), the main journal (assistant entry, then its
 * settlement-ordered usage entry), or the in-memory ProviderHistory fold.
 *
 * Returns the round's journal-entry uuid (the per-round usage idempotency key) and
 * the encrypted-reasoning items read off this stream — the tool batch attaches the
 * per-call ones to their tool_use entries, so the channel is read ONCE, here.
 */
export async function settleRoundOutput(
  deps: RoundDeps,
  st: RoundState,
  roundCostUsd: number,
  committedModel: string,
  // TOOLS_MIDSTREAM_RW_V1: a round settled at its teardown (round-engine journalStartedPrefix)
  // never reached `done`, so its usage is unknown: the entry carries zeros (st.lastUsage still
  // holds the previous round's) and nothing records it as the provider's count.
  opts: { salvaged?: true } = {},
): Promise<{ roundEntryUuid: string | undefined; capturedReasoning: CapturedReasoning }> {
  const { ctx, cfg, transport, history, turnBlocks } = deps;
  // Assistant content blocks for this round. Signed thinking blocks lead
  // (the order the model produced them + the order the next request must
  // replay them in for interleaved-thinking multi-turn correctness), then the
  // text. tool_use blocks are journaled separately + folded into history via
  // pushAssistant below. thinkingBlocks is empty for non-thinking arms/models
  // → asstBlocks === the prior text-only shape → byte-identical.
  const asstBlocks: ContentBlock[] = [
    ...st.thinkingBlocks,
    ...(st.assistantText ? [{ type: 'text', text: st.assistantText } as ContentBlock] : []),
  ];
  // turnBlocks → MESSAGE_COMPLETE: persist thinking + text so the assistant
  // message carries its reasoning on reload — PARITY with the Claude arm
  // (sdk/processor.ts folds thinking blocks into assistantBlocks). thinking
  // leads (emission order). Empty thinkingBlocks → text-only → byte-identical.
  turnBlocks.push(...asstBlocks);

  // Task 10: append the assistant response to the journal (first-class entry;
  // signed thinking + text). The thinking block carries its signature so a
  // resume/continuation replays it. When no journal: fold thinking + text +
  // tool_use into the in-memory ProviderHistory (thinking FIRST).
  // §4.3a / PR4 P2 — encrypted reasoning items captured off THIS round's stream,
  // each keyed by the function_call call_id it preceded (or callId:null for a
  // HEAD/orphan item that preceded no call). OpenAI/Sakana reasoning only;
  // Anthropic does not implement capturedReasoning → [] → no-op (byte-identical).
  // Read ONCE here so (a) the HEAD bucket rides the assistant entry below and (b)
  // the per-call items ride their tool_use entries in the tool batch — both echoed
  // before the right item by journalToOpenAIResponsesInput on reload.
  // P2.2 channel guard — the SUBAGENT never reads the per-stream reasoning
  // channel: it may share the parent's transport instance, and consuming the
  // channel here would steal the parent round's reasoning items (the parent
  // reads it after ITS stream). Legacy subagent behavior: never read.
  const capturedReasoning = deps.sub !== undefined ? [] : (transport.capturedReasoning?.() ?? []);
  // PR4 — carry the minting `issuer` onto the journaled reasoning item (absent
  // for Anthropic / non-issuer-stamping transports → byte-identical there).
  const headReasoning = capturedReasoning
    .filter((r) => r.callId === null)
    .map((r) => ({ id: r.id, encryptedContent: r.encryptedContent, ...(r.issuer ? { issuer: r.issuer } : {}) }));

  // The verbatim-replay channel for THIS round: the provider's message as sent, on
  // every round, filed under its dialect's journal field (Anthropic blocks, Gemini
  // generateContent parts, Gemini Interactions steps, OpenAI Responses output items,
  // the Chat Completions message). Off the round's own `done`
  // event first; the transport stash is the fallback for a transport that does not
  // carry it on the event (the replay transport) — and never read for a subagent
  // (P2.2 — same channel guard as capturedReasoning above).
  const { anthropicBlocks, geminiSteps: steps, ...channels } = replayChannels(st.replay);
  const orderedBlocks = anthropicBlocks ?? (deps.sub !== undefined ? undefined : transport.capturedOrderedBlocks?.());
  const geminiSteps = steps ?? (deps.sub !== undefined ? undefined : transport.capturedGeminiSteps?.());

  // K4C-1: capture the appended entry so its uuid keys the per-round usage.
  let roundEntryUuid: string | undefined;
  if (deps.sub !== undefined) {
    // P2.2 gate 3 — the subagent persists its round through its own seam: the
    // T10 scope-tagged assistant entry, the nested in-memory history push, and
    // the charter-(c) source:'subagent' usage entry (settlement-ordered inside
    // the seam: usage AFTER the assistant entry, mirroring the main discipline).
    // The main-journal branches below must never run for a subagent round —
    // `cfg.journal` here is the MAIN scope.
    await deps.sub.persistRound({
      assistantText: st.assistantText,
      toolUses: st.toolUses,
      roundCostUsd,
      usage: st.lastUsage,
      committedModel,
      ...(st.replay ? { replay: st.replay } : {}),
    });
  } else if (cfg.journal) {
    // PR1: skip journaling ONLY a TRULY-empty round (no thinking, no text, no
    // tools) — the recovery case. Such a round journals NOTHING, so the
    // recovered assistant entry always follows a user/tool_result (journal
    // role-alternation preserved) and there is no content-empty assistant
    // entry for the validity floor to rewrite to "(no content)" on reload. A
    // tool-bearing round STILL appends (even with empty asstBlocks) so its
    // per-round usage keeps the durable journal uuid (the dedup key) and the
    // tool_use fold-in has its anchor — behavior there is unchanged from before.
    if (asstBlocks.length > 0 || st.toolUses.length > 0) {
      const appended = await appendAssistantEntry(
        cfg.journal,
        ctx,
        asstBlocks,
        committedModel,
        transport.api,
        transport.provider,
        // PR4 P2 — HEAD/orphan reasoning persisted on the assistant entry
        // (absent for Anthropic / non-reasoning → byte-identical there).
        headReasoning.length ? headReasoning : undefined,
        // PR2 — the verbatim-replay channel (absent for non-interleaved turns
        // and non-Anthropic arms → byte-identical there).
        orderedBlocks,
        // Gemini Interactions — absent on every other dialect → byte-identical.
        geminiSteps,
        // Gemini generateContent / OpenAI Responses / Chat Completions — present-only.
        channels,
      );
      roundEntryUuid = appended?.uuid;
      // P2.1 (Task 4, ordering per PR-1300 review): journal the round's usage
      // AFTER its assistant entry, so the invariant "a usage entry exists ⟺
      // the round SETTLED durably" holds. Appending at the fold (before the
      // assistant entry) left a crash window where the usage line survived a
      // round whose output was lost — the re-run would re-bill and a future
      // journal-seed (Task 5) would count BOTH (double-billing direction).
      // With this order every failure mode is an under-count (safe: the spec's
      // "the in-flight round re-runs and re-bills by necessity"). A TRULY-empty
      // recovery round journals neither entry — its cost stays in cumulative
      // for THIS run's billing but is deliberately absent from the seed.
      // Guarded catch-warn: a usage-append failure must never unsettle a round
      // that already settled. No-op when no journal (in-memory path).
      try {
        await appendUsageEntry(cfg.journal, ctx, {
          costUsd: roundCostUsd,
          model: committedModel,
          source: 'round',
          inputTokens: opts.salvaged ? 0 : st.lastUsage.inputTokens,
          outputTokens: opts.salvaged ? 0 : st.lastUsage.outputTokens,
        });
      } catch (usageErr) {
        console.warn(`[NativeHarness] round usage append failed (journal under-counts, billing unaffected): ${String(usageErr)}`);
      }
      // The provider's count of THIS request — what the next round head's compaction
      // trigger reads instead of the chars/4 estimate alone (compaction-input.ts).
      if (appended && !opts.salvaged) recordRoundInput(deps.rc, st.lastUsage, committedModel, appended.seq);
      // D1: this round's assistant text/thinking is now durable. The abort
      // catch must NOT re-append it (double-append guard).
      st.roundAppended = true;
    }
  } else {
    // PR2: when the transport gated on the verbatim channel (interleaved
    // thinking + tool_use), the in-memory history must preserve emission order
    // too — the bucketed `[...asstBlocks, ...toolUses]` would reorder a later
    // thinking block ahead of an earlier tool_use and break its signature on
    // the next in-memory request. Project the ordered channel to ContentBlock[]
    // (pushAssistant preserves order). A redacted_thinking block has no
    // ContentBlock form, so it is dropped on this NO-JOURNAL path only — an
    // ephemeral/test-only edge (production always journals, where it round-trips
    // verbatim). Absent channel → the prior bucketed shape → byte-identical.
    const assistantBlocks: ContentBlock[] = orderedBlocks
      ? orderedBlocks.flatMap((b): ContentBlock[] => {
          if (b.type === 'text') return [{ type: 'text', text: b.text }];
          if (b.type === 'thinking') return [{ type: 'thinking', thinking: b.thinking, signature: b.signature }];
          if (b.type === 'tool_use') return [{ type: 'tool_use', toolUseId: b.id, toolName: b.name, toolInput: b.input ?? {} } as ContentBlock];
          return []; // redacted_thinking — unrepresentable in ContentBlock (no-journal only)
        })
      : [
          ...asstBlocks,
          ...st.toolUses.map(
            (tu) =>
              ({
                type: 'tool_use',
                toolUseId: tu.id,
                toolName: tu.name,
                toolInput: tu.input ?? {},
              }) as ContentBlock,
          ),
        ];
    // PR1: skip the push for a truly-empty round. Some transports'
    // pushAssistant([]) is NOT a no-op (Chat Completions injects a
    // "(no content)" assistant message), which would both reintroduce the
    // parrot string and break alternation against the recovery seat below.
    // The round's sealed output rides along: a transport that minted it sends it back
    // as sent (Gemini 3 400s a functionCall rebuilt without its thoughtSignature);
    // `assistantBlocks` is the fallback for a round that carried none.
    if (assistantBlocks.length > 0) transport.pushAssistant(history, assistantBlocks, st.replay);
  }
  return { roundEntryUuid, capturedReasoning };
}

// K4C-1: PER-ROUND cache observability. Yield ONE usage event for THIS
// round carrying its OWN cache read/write (intermediate rounds were billed
// but never surfaced → cache-blind native arm). The sink builds the
// canonical nested snake_case AGENT_USAGE; the host stamps sdk_version +
// sdk_cost_usd:0 (observability-only — the authoritative cumulative cost
// stays on terminal turn_end.billing).
//
// IDEMPOTENCY KEY (messageId → wire sdk_message_uuid): the round's JOURNAL
// ASSISTANT-ENTRY UUID — globally unique, append-only, and NEVER-REGRESSING
// (the native analogue of the Claude arm's `msg.uuid`). It does NOT derive
// from a counter, so a compaction (which collapses assistant entries into a
// user-typed summary and lowers the assistant-COUNT) can never make a later
// round reuse an earlier id → the server's onConflict upsert can never
// overwrite an earlier round's row. Re-DELIVERY of the same journaled round
// re-reads the SAME persisted uuid → dedups; a genuine re-EXECUTION is a new
// API call with new tokens → a new entry uuid → a new row (correct). The
// no-journal path (ephemeral/tests, never compacts) falls back to a
// deterministic per-round id. turn_number stays monotonic per task (seeded
// from the journal's never-regressing max seq) for server per-turn grouping.
// P2.2 gate 4 — MAIN loop only: the parent's roundCounter/AGENT_USAGE stream
// must never advance for a nested round (subagent token counts surface via
// SUBAGENT_END; nested cost bills once on the parent's turn_end).
export async function* emitRoundUsage(
  deps: RoundDeps,
  st: RoundState,
  round: {
    committedModel: string; ttftMs: number; latencyMs?: number; roundEntryUuid: string | undefined; billedAs?: string;
    firstTextMs?: number; beforeSendMs?: number; afterSendMs?: number; attempts?: number;
  },
): AsyncGenerator<HarnessEvent, void, void> {
  const { ctx, cfg, providerTools, system, history } = deps;
  const { committedModel, ttftMs, latencyMs, roundEntryUuid, billedAs } = round;
  // The rest of the round's clock (roundTiming), for the per-call model event. Each present-only.
  const split = {
    ...(round.firstTextMs !== undefined && { firstTextMs: round.firstTextMs }),
    ...(round.beforeSendMs !== undefined && { beforeSendMs: round.beforeSendMs }),
    ...(round.afterSendMs !== undefined && { afterSendMs: round.afterSendMs }),
    ...(round.attempts !== undefined && { attempts: round.attempts }),
  };
  if (deps.sub === undefined) {
    deps.rc.billing.roundCounter.value += 1;
    // Prompt-span (observability): attribute the fresh-prefill payload ONCE per task
    // birth. 'fresh' reseeds every user turn, so the run-scoped latch pins this to a
    // single emit (the cost cap: one [prompt-span] line per session). Built from the
    // SERVED bytes (system/tools/history) + the assembly-site per-layer sizes; the
    // builder never throws. Conditional-spread → every other round is byte-identical.
    let promptBreakdown: PromptBreakdown | undefined;
    if (deps.roundKind === 'fresh' && !deps.rc.promptSpanEmitted) {
      deps.rc.promptSpanEmitted = true;
      promptBreakdown = buildPromptBreakdown({
        system,
        providerTools,
        history,
        ...(cfg.promptLayerSizes !== undefined && { layerSizes: cfg.promptLayerSizes }),
      });
    }
    // Media-refs S0 — measure THIS round's request (bytes ≈ the JSON body each
    // lane serializes anyway; one extra stringify per round, ~ms at typical
    // history sizes). The meter never throws.
    const wireMedia = measureWireMedia(history);
    const requestMeta = {
      requestBytes: measureRequestBytes(system, providerTools, history),
      imageCount: wireMedia.imageCount,
      imageBytes: wireMedia.imageBytes,
    };
    yield {
      kind: 'usage',
      usage: st.lastUsage,
      requestMeta,
      messageId: roundEntryUuid ?? deterministicUsageId(ctx.taskId, deps.rc.billing.roundCounter.value),
      turnNumber: deps.rc.billing.roundCounter.value,
      model: committedModel,
      // Honest per-request TTFT + its cause (see the requestStartMs anchor above):
      // rides WITH the round's cache read/prefill so the server's [TTFT] line can
      // attribute latency (provider vs cache-cold) per API call. Additive —
      // roundKind conditional-spread so an untagged caller keeps the prior shape.
      ttftMs,
      // The whole call on the same clock (request start → last stream event), for the
      // per-call model event (MODEL_CALL_EVENTS_V1). Additive: absent ⇒ the prior shape.
      ...(latencyMs !== undefined && { latencyMs }),
      ...split,
      ...(deps.roundKind !== undefined && { roundKind: deps.roundKind }),
      ...(promptBreakdown !== undefined && { promptBreakdown }),
      // Sibling-lane round: the picked model this round bills at (see the event doc).
      ...(billedAs !== undefined && { billedAs }),
    };
  } else if (subagentUsageLedgerEnabled()) {
    // C5 (SUBAGENT_USAGE_LEDGER_V1): a subagent round's usage leaves the nested loop on the
    // 'subagent' lane (subagent-runner forwards it as a raw event, the Agent tool relays it
    // up the push chain), so the ledger gets the provider's numbers for it and the server's
    // re-priced total gets its cost, as the claimed total always did. No turn number: the
    // parent's sequence belongs to the main loop. The id is minted once here and rides the
    // payload, so a redelivery dedupes on it.
    yield {
      kind: 'usage',
      usage: st.lastUsage,
      messageId: randomUUID(),
      model: committedModel,
      ttftMs,
      ...(latencyMs !== undefined && { latencyMs }),
      ...split,
      lane: 'subagent',
      laneStatus: 'ok',
      ...(billedAs !== undefined && { billedAs }),
    };
  }
}
