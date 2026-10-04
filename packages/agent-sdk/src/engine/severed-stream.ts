/**
 * severed-stream.ts — deploy-seam ladder 1: the mid-stream severance re-issue
 * (NATIVE_STREAM_SEVERED_RETRY, opt-in, ships dark).
 *
 * Every Railway restart (= every staging merge) severs ALL in-flight native model
 * streams at the Anthropic proxy (ANTHROPIC_BASE_URL → /api/proxy/anthropic). The
 * SSE dies mid-stream and the throw used to escape iterateTurn's round catch to the
 * terminal catch-all model_error — no retry, the whole turn burned (incident
 * a7ea0665, 2026-07-08). Classification lives in native-termination.ts
 * (isSeveredStreamError → kind 'network_error', raw.subtype 'stream_severed'); this
 * module owns the ENGINE side: the re-issue gate, the partial seal, the journaled
 * continuation marker, and the bounded abort-respecting backoff. The gate keys on
 * the transport-neutral `network_error` KIND (isReissuableRoundError) so every
 * lane's classifier arms it — the OpenAI-dialect arm lives in
 * transports/openai-responses-termination.ts (isOpenAISeveredStreamError). iterateTurn's
 * round catch calls `reissueSeveredRound` and either continues the same turn with
 * the returned history or rethrows.
 *
 * BILLING: the severed round folded NO cost and journaled NO usage entry — in
 * runOneRound both the cost fold and the settlement-ordered usage append sit AFTER
 * the stream drive, and a severed stream never reaches `done` — so a re-issue
 * cannot double-bill by construction. The severed attempt's own provider-side
 * partial tokens are unmeasurable (no `done`) and never counted — the same
 * accepted edge as the subagent settle-on-abort path.
 *
 * Pinned by: native-harness.severed-stream.test.ts.
 */
import type { HarnessContext } from '../contract/harness.js';
import type { ContentBlock } from '../contract/blocks.js';
import type { NativeConfig } from './native-config.js';
import type { ProviderHistory, Transport } from './transport.js';
import type { TurnOutcome } from '../contract/turn-outcome.js';
import { abortableSleep, RETRYABLE_KINDS, type RoundState } from './round-engine.js';
import { appendAssistantEntry, appendInjectedUserEntry } from './native-journal.js';
import { STREAM_SEVERED_CONTINUE_MARKER } from '../contract/injected-user-text.js';
import { severedStreamRetryEnabled } from '../policy/feature-flags.js';
import { projectWire, type FrozenElision } from './context-elision.js';

/**
 * Is a round that threw THIS classified error re-issuable?
 *
 * Keyed on transport-NEUTRAL `kind`s, never on a dialect's `raw.subtype`.
 * That distinction IS the 2026-08-20 bug (staging task 47faf57f): the belt
 * originally gated on `raw.subtype === 'stream_severed'`, a subtype only
 * `classifyAnthropicError` ever stamped — so every OpenAI-dialect lane (Chat
 * Completions = GLM/Luna, DeepSeek, Fireworks, Kimi …; and Responses) carried a
 * belt that could never buckle, and died permanently on a mid-turn transport
 * drop. A subtype is a per-dialect telemetry detail; the KIND is the contract.
 *
 * `network_error` re-issues at ANY point: a transport-layer disconnect (severed
 * stream, socket death, premature end, `fetch failed`) produced no `done`
 * whether or not content had streamed, so re-issuing is leak-free by the module
 * doc's construction. The other transient kinds (RETRYABLE_KINDS: an in-stream
 * overload / rate-limit / server-error frame) are admitted ONLY once the round
 * holds partial output (H9 W2 4b): with NO content streamed the same failure
 * throws inside startStreamWithRetry's boundary, which owns the pre-commit
 * budget — admitting it here too would stack the belt's re-asks on top of that
 * budget. AFTER partial content the frame bypasses that boundary entirely and
 * used to burn the turn with merely a better label. Every non-transient kind
 * (auth / billing / context / model_error) stays terminal: not a severance,
 * never silently re-asked.
 */
export function isReissuableRoundError(outcome: TurnOutcome, hasPartialOutput = false): boolean {
  if (outcome.kind === 'network_error') return true;
  return hasPartialOutput && RETRYABLE_KINDS.has(outcome.kind);
}

/**
 * Cap on mid-stream severance re-issues per turn. Kept small: a severance that
 * persists past two re-issues is an outage, not a restart blip — surface it
 * (network_error, Retry CTA). The counter deliberately never resets mid-turn —
 * the cap bounds the whole turn's severance tolerance, not each round's.
 */
export const SEVERED_STREAM_MAX_REISSUES = 2;

/** Default per-attempt backoff before a severed re-issue; cfg.retry.backoffMs overrides. */
export const SEVERED_STREAM_BACKOFF_MS = 250;

/**
 * JOURNALED continuation marker appended after a severed round's partial seal (the
 * appendSteerEntry marker discipline — NOT the in-memory-only EMPTY_RECOVERY_NUDGE
 * one): the post-tool-batch re-projection would silently drop an in-memory nudge,
 * and role-alternation must hold on every later projection (the sealed partial is
 * an assistant entry; a user entry must follow it before the next model call).
 */
export { STREAM_SEVERED_CONTINUE_MARKER } from '../contract/injected-user-text.js';

/** Per-turn re-issue counter, threaded by reference so the gate reads/advances one place. */
export interface SeveredRetryState {
  reissues: number;
}

/** What the round catch does next: re-issue with this history, or rethrow. */
export type SeveredReissueDecision =
  | { reissue: false }
  | { reissue: true; history: ProviderHistory };

/**
 * Seal a SEVERED round so the re-issue CONTINUES instead of repeating: the partial
 * assistant text/thinking the dead stream already emitted is made durable EXACTLY
 * ONCE (journal + turnBlocks — the same D1 discipline as sealAbortedRound), a
 * journaled continuation marker (user entry, the appendSteerEntry discipline)
 * keeps role-alternation valid and tells the model to pick up where it left off,
 * and the history is re-projected so the re-issued call sees both. A severance
 * with NO partial output seals nothing — the re-issue is a byte-identical re-ask.
 * Sets `roundAppended` so the terminal catch can never double-append the same
 * partial if an abort lands during the re-issue backoff. No healOnError: a
 * severance is streaming-phase only, so the dead round journaled no tool_use
 * entries to orphan.
 */
export async function sealSeveredRound(
  cfg: NativeConfig,
  ctx: HarnessContext<NativeConfig>,
  transport: Transport,
  st: RoundState,
  turnBlocks: ContentBlock[],
  history: ProviderHistory,
  /** The turn's FROZEN elision — the sealed continuation re-projects through the
   *  SAME wire seam the turn head used. */
  elision: FrozenElision | null,
): Promise<ProviderHistory> {
  // A round already in the journal whole (TOOLS_MIDSTREAM_RW_V1: the teardown journaled the
  // calls that started early, with their results) re-projects, so the re-issue continues after
  // those results instead of re-asking the round they answered: the model would call the same
  // Edit again and it would run twice. The history ends on the results, so no marker is needed
  // (the model continues from them as after any batch). Without a journal the round's settle and
  // its batch already pushed into `history` itself.
  if (st.roundAppended) return cfg.journal ? projectWire(cfg.journal, transport, elision) : history;
  if (!st.assistantText && st.thinkingBlocks.length === 0) return history;
  const sealBlocks: ContentBlock[] = [
    ...st.thinkingBlocks,
    ...(st.assistantText ? [{ type: 'text', text: st.assistantText } as ContentBlock] : []),
  ];
  turnBlocks.push(...sealBlocks);
  if (cfg.journal) {
    await appendAssistantEntry(cfg.journal, ctx, sealBlocks, st.lastUsageModel, transport.api, transport.provider);
    await appendInjectedUserEntry(cfg.journal, ctx, STREAM_SEVERED_CONTINUE_MARKER, 'engine');
    st.roundAppended = true;
    return projectWire(cfg.journal, transport, elision);
  }
  transport.pushAssistant(history, sealBlocks);
  transport.pushUser(history, STREAM_SEVERED_CONTINUE_MARKER);
  st.roundAppended = true;
  return history;
}

/** The round streamed SOMETHING before dying — the mid-stream signal the widened
 *  gate keys on. Thinking DELTAS without a completed block leave no trace here; a
 *  round that died that early re-asks nothing and stays terminal (accepted edge —
 *  there is also nothing to seal). */
function hasPartialOutput(st: RoundState): boolean {
  return st.assistantText !== '' || st.thinkingBlocks.length > 0 || st.toolUses.length > 0;
}

/**
 * The round catch's severed-stream decision + execution (flag-gated): a SEVERED
 * model stream is re-issued instead of burning the turn. Keyed on the transport's
 * classification (a re-issuable KIND — see isReissuableRoundError, NOT a
 * per-dialect subtype), STREAMING phase only (a
 * tool-batch throw is never a severance), bounded per turn, and abort-checked on
 * BOTH sides of the backoff so an interrupt that raced the severance always wins —
 * every no-go path returns `{ reissue: false }` and the caller rethrows the
 * original error (an aborted signal then routes through classifyTerminalAbort to
 * user_aborted; #1592's classification untouched). Flag OFF ⇒ the FIRST gate
 * short-circuits ⇒ dead code, and every classifier's severed branch is dark too,
 * so the turn terminates byte-identically to today.
 */
export async function reissueSeveredRound(
  err: unknown,
  cfg: NativeConfig,
  ctx: HarnessContext<NativeConfig>,
  transport: Transport,
  st: RoundState,
  turnBlocks: ContentBlock[],
  history: ProviderHistory,
  state: SeveredRetryState,
  /** The turn's FROZEN elision — threaded to sealSeveredRound. */
  elision: FrozenElision | null,
): Promise<SeveredReissueDecision> {
  if (
    !severedStreamRetryEnabled() ||
    cfg.signal?.aborted === true ||
    st.inToolBatch ||
    // A round whose early-started calls could not be journaled: a re-issue would re-ask without
    // their results and the model would run them again (TOOLS_MIDSTREAM_RW_V1).
    st.salvageFailed === true ||
    state.reissues >= SEVERED_STREAM_MAX_REISSUES ||
    !isReissuableRoundError(transport.classifyError(err), hasPartialOutput(st))
  ) {
    return { reissue: false };
  }
  state.reissues += 1;
  console.warn(
    `[NativeHarness] model stream severed mid-round; re-issuing (${state.reissues}/${SEVERED_STREAM_MAX_REISSUES})`,
    err,
  );
  const sealedHistory = await sealSeveredRound(cfg, ctx, transport, st, turnBlocks, history, elision);
  await abortableSleep((cfg.retry?.backoffMs ?? SEVERED_STREAM_BACKOFF_MS) * state.reissues, cfg.signal);
  if (cfg.signal?.aborted) return { reissue: false };
  return { reissue: true, history: sealedHistory };
}
