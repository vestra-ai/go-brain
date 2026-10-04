/**
 * offloop-usage — the epilogue SIDE CALLS and their metering.
 *
 * After a completed turn the harness makes up to two extra provider calls: the
 * Nami memory sweep (its own module, memory-sweep.ts) and the next-prompt
 * suggestion (here). Both used to DISCARD their usage as "absorbed product
 * cost", so a real recurring spend — the sweep re-sends the system prompt, the
 * tool schemas, and the whole journal projection every turn — appeared in no
 * cost table and no dashboard.
 *
 * This module owns the suggestion call and the shared shape both side calls
 * report through, so the harness only has to yield what they hand back.
 *
 * METERING IS NOT BILLING. Nothing here prices anything: no computeCostUsd, no
 * cumulativeCostUsd mutation, no buildModelUsage. The usage rides out on a
 * lane-tagged event; whether it is ever CHARGED is a server-side flag
 * (BILL_OFFLOOP_V1, default off).
 */
import type { HarnessEvent, NormalizedUsage, UsageLane, UsageLaneStatus } from '../contract/events.js';
import type { JournalEntry } from '../contract/journal.js';
import { SUGGESTION_SYSTEM } from '../contract/suggestion-prompt.js';
import { deterministicUsageId } from './round-engine.js';
import type { ProviderHistory, Transport } from './transport.js';
import { isRealUserTurn } from '../contract/injected-user-text.js';

/** Max output tokens for the one-shot next-prompt suggestion call (a short message). */
const SUGGESTION_MAX_TOKENS = 128;
/** Hard ceiling on the suggestion side-call — it must never delay the next turn. */
const SUGGESTION_TIMEOUT_MS = 8000;

const ZERO_USAGE: NormalizedUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * What one off-loop side call produced and what it cost. Mirrors
 * OffloopSweepResult (which carries `facts` instead of `text`) so both epilogue
 * calls feed {@link laneUsageEvent} through the same three-state contract:
 *  - 'ok'      : a call returned; `usage` is what it really cost.
 *  - 'error'   : a call WAS made and failed/timed out. Zero usage, but the
 *                attempt is real and must surface as a row, not a gap.
 *  - 'skipped' : no provider call happened at all (already-aborted run, or a
 *                failure before the request). Nothing was spent.
 */
export interface SideCallResult {
  text: string;
  status: 'ok' | 'error' | 'skipped';
  usage?: NormalizedUsage;
  model: string;
  /**
   * On 'error' only: usage the provider DID report before the call failed. Never put on the
   * 'error' row (that row stays zero, as above); a call cut on purpose reports it on its
   * 'cancelled' row (post-turn-off-path.ts).
   */
  spent?: NormalizedUsage;
}

/**
 * Build the usage event for an off-loop side call, or `undefined` when no
 * provider call happened ('skipped' — nothing spent, so nothing claimed).
 *
 * `turnNumber` deliberately REUSES the turn's current round counter rather than
 * bumping it: the side call belongs to that turn for per-turn grouping, and
 * advancing the counter would shift the main lane's numbering. Collision on the
 * UNIQUE sdk_message_uuid is avoided by the lane-keyed id instead.
 *
 * An 'error' call reports ZERO tokens on purpose — a failed request bills
 * nothing but must still leave a row, which is how a silently failing sweep
 * becomes visible instead of looking like a sweep that never ran.
 *
 * `latencyMs`, when the caller timed the call, is its wall time (the usage event's
 * latencyMs, read by the per-call model event); absent, the event is as before.
 */
export function laneUsageEvent(
  lane: UsageLane,
  result: { status: UsageLaneStatus | 'skipped'; usage?: NormalizedUsage; model: string },
  taskId: string,
  turnNumber: number,
  latencyMs?: number,
): HarnessEvent | undefined {
  if (result.status === 'skipped') return undefined;
  return {
    kind: 'usage',
    usage: result.usage ?? { ...ZERO_USAGE },
    messageId: deterministicUsageId(taskId, turnNumber, lane),
    turnNumber,
    model: result.model,
    lane,
    laneStatus: result.status,
    ...(latencyMs !== undefined && { latencyMs }),
  };
}

/**
 * Assemble the suggestion side-call's history from the (control-stripped)
 * projection: the last user + last assistant turn only — NOT the full
 * transcript, which keeps the side call genuinely cheap on long tasks — plus a
 * trailing synthetic user turn. The trimmed window ends in the ASSISTANT turn;
 * models reject prefill ("the conversation must end with a user message"), so
 * that trailer is what makes the request API-valid. SUGGESTION_SYSTEM carries
 * the full instruction. (Extracted from native-harness under its size ratchet;
 * behavior pinned by the suggestion/lane-usage suites.)
 */
export function suggestionHistoryFromProjection(projected: JournalEntry[]): JournalEntry[] {
  // The last REAL user turn, not merely the last user-role payload. An
  // engine-minted entry (a recall fence, the T9c split-turn continuation marker)
  // would otherwise become this side call's idea of what the person last said —
  // "what is my single most likely next message?" asked against loop boilerplate.
  const lastUser = [...projected].reverse().find((e) => isRealUserTurn(e));
  const lastAsst = [...projected].reverse().find((e) => e.payload.type === 'assistant');
  const trimmed = [lastUser, lastAsst].filter((e): e is JournalEntry => e !== undefined);
  return lastUser
    ? [
        ...trimmed,
        {
          ...lastUser,
          payload: {
            type: 'user',
            blocks: [{ type: 'text', text: 'Based on the exchange above, what is my single most likely next message?' }],
          },
        } as JournalEntry,
      ]
    : trimmed;
}

/**
 * The native next-prompt generator. A best-effort SIDE model call (produces no
 * second turn_end): trimmed history (last user + last assistant),
 * SUGGESTION_SYSTEM, no tools, small maxTokens. Never throws: any
 * failure/timeout/abort degrades to no chip.
 *
 * The usage is REPORTED but never PRICED, so the server's cumulative-delta
 * billing still cannot double-charge.
 * Pinned by: native-harness.suggestion.test.ts, native-harness.lane-usage.test.ts.
 */
export async function runSuggestionCall(deps: {
  trimmed: JournalEntry[];
  transport: Transport;
  model: string;
  signal?: AbortSignal;
  /**
   * POST_TURN_OFF_PATH_V1 only: the reasoning floor the sweep already rides (see
   * memory-sweep.ts SWEEP_REASONING_EFFORT). A 128-token reply needs no deliberation, and
   * on a top-effort default the reasoning can spend the whole cap. Absent: the request
   * carries no effort key, byte-identical.
   */
  reasoningEffort?: 'low';
}): Promise<SideCallResult> {
  const { transport, model, signal } = deps;
  let history: ProviderHistory;
  try {
    history = transport.historyFromJournal(deps.trimmed);
  } catch {
    return { text: '', status: 'skipped', model };
  }
  // Bound the side-call: a per-call timeout OR a user abort cancels it.
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) return { text: '', status: 'skipped', model };
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(), SUGGESTION_TIMEOUT_MS);
  let usage: NormalizedUsage | undefined;
  try {
    const stream = transport.callModel({
      model,
      maxTokens: SUGGESTION_MAX_TOKENS,
      system: SUGGESTION_SYSTEM,
      tools: [],
      history,
      signal: ac.signal,
      ...(deps.reasoningEffort !== undefined && { reasoningEffort: deps.reasoningEffort }),
    });
    let suggestion = '';
    for await (const ev of transport.readStream(stream)) {
      if (ev.kind === 'text') suggestion += ev.text;
      else if (ev.kind === 'done') usage = ev.usage;
    }
    return { text: suggestion.trim(), status: 'ok', ...(usage !== undefined && { usage }), model };
  } catch {
    // D9: a suggestion failure/hang must NEVER throw out of run() → no chip.
    return { text: '', status: 'error', model, ...(usage !== undefined && { spent: usage }) };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
