/**
 * empty-recovery.ts — the empty-completion decision helpers and the OpenAI
 * strict-preflight, moved VERBATIM out of native-harness.ts (file-size
 * ratchet; the strangler precedent). Pure decisions only — the wiring (the
 * in-memory nudge re-call, the never-blank fallback, the structured-output
 * epilogue) stays in the iterate loop. native-harness.ts re-exports every
 * name here, so existing imports from './native-harness.js' are unchanged.
 * Pinned by: native-empty-recovery.test.ts,
 * structured-output-epilogue.strict-preflight.test.ts.
 */
import type { TurnOutcome } from '../contract/turn-outcome.js';
import type { ModelProvider } from '../contract/model-capabilities.js';
import type { JsonSchemaSubset } from '../contract/output-format.js';
import { isOpenAIStrictCompatible } from '../contract/openai-strict-schema.js';

/**
 * Cap on empty-completion re-calls per turn: weak models emit an empty round after
 * tool results; rather than finalize a blank turn the loop re-calls with a nudge up
 * to this many times, then surfaces a fallback.
 * History: docs/learnings/native-harness-history.md (empty-completion recovery).
 * Pinned by: native-empty-recovery.test.ts.
 */
export const MAX_EMPTY_RECOVERY_ATTEMPTS = 3;

/**
 * In-memory-only nudge before an empty-completion re-call. DELIBERATELY never
 * journaled — a journaled placeholder replays on resume and the model parrots it.
 * History: docs/learnings/native-harness-history.md (empty-completion recovery).
 */
export const EMPTY_RECOVERY_NUDGE =
  'It looks like your previous response was empty. Please continue and complete the task, or share your answer now.';

/**
 * In-memory-only assistant seat pushed BEFORE the nudge on a recovery re-call, to
 * preserve provider role-alternation (Anthropic 400s on a user message after a
 * user/tool_result turn). Never journaled/emitted; seen only in the re-call input.
 * History: docs/learnings/native-harness-history.md (empty-completion recovery).
 */
export const EMPTY_RECOVERY_SEAT = '...';

/**
 * The recovery seat + nudge as a REQUEST-SCOPED overlay: a COPY of the round's history
 * with the two in-memory-only items appended, so the durable `history` the loop carries
 * stays equal to what the journal re-derives.
 *
 * WHY A COPY AND NOT A PUSH. These two items are deliberately never journaled (a
 * journaled placeholder replays on resume and the model parrots it), so pushing them
 * onto `history` made the wire permanently un-re-derivable: it is the ONE in-turn
 * mutation on the journal path with no journal counterpart — every other one (steer,
 * PostToolBatch context, compaction, vision) appends an entry and re-projects. That is
 * exactly the class `checkRoundReconstruction` exists to catch, and it caught it: all
 * four `wire_reconstruction_desync` rows ever recorded are this overlay, each with
 * `firstDivergingIndex === projectedLength` (the extras sit at the tail) and
 * `incrementalLength − projectedLength` equal to the overlay's size — 3 on the
 * OpenAI-Responses arm, where `pushAssistant` also echoes the round's captured §4.3a
 * `reasoning` item ahead of the seat. Scoping the overlay to the ONE re-call it serves
 * keeps the nudge on the wire (the model still gets it) while `history` stays
 * journal-equal, so the invariant keeps every bit of its reach.
 *
 * A second consecutive empty round now overlays ONE seat+nudge onto a clean history
 * rather than stacking a second pair on top of the first.
 */
export function withEmptyRecoverySeat(
  transport: {
    emptyHistory(): unknown;
    pushAssistant(h: unknown, blocks: Array<{ type: 'text'; text: string }>): void;
    pushUser(h: unknown, text: string): void;
  },
  history: unknown,
): unknown {
  // Every Transport's history is an array (`emptyHistory()` returns `[]` in all arms);
  // building the copy THROUGH the transport keeps the dialect the transport's business.
  const copy = transport.emptyHistory() as unknown[];
  copy.push(...(history as unknown[]));
  transport.pushAssistant(copy, [{ type: 'text', text: EMPTY_RECOVERY_SEAT }]);
  transport.pushUser(copy, EMPTY_RECOVERY_NUDGE);
  return copy;
}

/**
 * Surfaced once when empty-completion recovery is exhausted, so an empty turn
 * never renders as a silent blank bubble. No em dashes (product copy rule).
 */
export const EMPTY_RESPONSE_FALLBACK_TEXT =
  "I wasn't able to produce a response just now. Please try again.";

export type EmptyRecoveryAction = 'complete' | 'recover' | 'giveup';

/**
 * A "clean" terminal stop where ZERO output is a glitch worth retrying, not intent.
 * Refusal/content_filter is a decline; max_tokens/length is truncation — both
 * finalize through the classifier and are NEVER recovered. `null` → treated as clean.
 * Pinned by: native-empty-recovery.test.ts.
 */
export function isRecoverableEmptyStop(stopReason: string | null): boolean {
  const s = stopReason ?? '';
  return s === '' || s === 'end_turn' || s === 'stop' || s === 'stop_sequence' || s === 'completed';
}

/**
 * Pure decision for the no-tool-call branch of the iterate loop. Consulted only when
 * a round emitted zero tool calls:
 *  - visible text, thinking-only, or truly-empty + NON-clean stop → 'complete'.
 *  - truly-empty + clean stop + under cap → 'recover'; at cap → 'giveup'.
 * Provider-neutral (text/thinking flags + stop reason + attempt count). Why
 * thinking-only isn't re-called, and what "truly-empty" guards in the journal:
 * docs/learnings/native-harness-history.md (empty-completion recovery).
 * Pinned by: native-empty-recovery.test.ts.
 */
export function emptyRecoveryDecision(args: {
  hasVisibleText: boolean;
  hasThinking: boolean;
  stopReason: string | null;
  attemptsSoFar: number;
  maxAttempts: number;
}): EmptyRecoveryAction {
  if (args.hasVisibleText) return 'complete';
  if (args.hasThinking) return 'complete';
  if (!isRecoverableEmptyStop(args.stopReason)) return 'complete';
  return args.attemptsSoFar < args.maxAttempts ? 'recover' : 'giveup';
}

/**
 * The structured-output STRICT preflight (pure, provider-gated). Fails CLOSED for
 * `provider === 'openai'` when the schema isn't strict-compatible (an optional field
 * 400s under OpenAI strict; Claude tolerates it), BEFORE any provider call. Returns
 * null (proceed) for every other provider → byte-identical. Never mutates the schema
 * or downgrades to strict:false. Why gate on provider value + full history:
 * docs/learnings/native-harness-history.md (structured-output epilogue).
 * Pinned by: structured-output-epilogue.strict-preflight.test.ts.
 */
export function openaiStrictPreflightFailure(
  provider: ModelProvider,
  schema: JsonSchemaSubset,
): Extract<TurnOutcome, { kind: 'max_structured_output_retries' }> | null {
  // OpenAI Responses has the strict structured-output 400 trap;
  // Anthropic + google are unaffected (Claude tolerates optional fields).
  if (provider !== 'openai') return null;
  // toResponsesTextFormat forwards `fmt.schema` VERBATIM as the json_schema (no
  // conversion), so the strict check runs on the same shape the provider sees.
  if (isOpenAIStrictCompatible(schema)) return null;
  return {
    kind: 'max_structured_output_retries',
    raw: {
      subtype: 'strict_schema_incompatible',
      errors: [
        'The requested output schema is not OpenAI strict-compatible: every ' +
          'property must be required and objects must set additionalProperties:false ' +
          '(optional fields and unsupported keyword constraints are rejected under ' +
          'strict structured outputs). The request was failed closed before any model ' +
          'call to avoid a guaranteed provider 400.',
      ],
    },
  };
}
