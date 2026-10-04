/**
 * The validity floor for the Gemini Interactions `input` shape — the SAME
 * invariant set every dialect applies (engine/request-validity.ts): never an empty
 * user turn, never an empty tool result, never an orphaned tool call, one user turn
 * where the API wants one. Lives beside the wire types rather than in the engine
 * file because the shape is this dialect's own.
 *
 * Two functions, two seams (the Gemini generateContent lane's split):
 *   - ensureValidGeminiInteractionsSteps — per-slice + whole-history normalizer.
 *   - stripOrphanedGeminiInteractionsCalls — WHOLE-HISTORY only (a pair may span a
 *     live slice). Pairs by `call_id`, which Interactions carries — no positional
 *     or by-name matching.
 *
 * Plus one rule this dialect alone needs: a model turn that calls a function MUST
 * open with a thought step. Google validates the signature on stateless replay and
 * answers a bare function_call with `400 invalid_request` (probed 2026-09-04: the
 * same turn is a 200 with a thought in front). The turns that arrive bare are
 * exactly the ones we cannot sign: a journal written before the channel existed or
 * while it was broken (staging task 7717fe8a), a handoff from another model's tool
 * calls, or a future capture miss. Google documents a sentinel signature for
 * precisely this case — "function calls that did not originate from Gemini" — and
 * the wire accepts it (probed: 200).
 */
import {
  GEMINI_SENTINEL_THOUGHT_SIGNATURE,
  PLACEHOLDER_EMPTY_CONTENT,
  PLACEHOLDER_NO_OUTPUT,
} from '../engine/request-validity.js';
import type {
  GeminiInteractionsContent,
  GeminiInteractionsStep,
  GeminiFunctionResultStep,
} from './gemini-interactions-wire.js';

function nonEmpty(content: GeminiInteractionsContent[] | undefined): GeminiInteractionsContent[] {
  return (content ?? []).filter((c) => c.type !== 'text' || c.text !== '');
}

/**
 * The placeholder is a FALLBACK, never an item: a user turn that holds real
 * content carries no `(no content)` alongside it, and a turn with nothing real
 * left carries exactly one. Applied at the merge, so two empty turns folding
 * together still collapse to a single placeholder.
 *
 * "Real" is everything that is not the placeholder itself — never a list of the
 * kinds that count. A media-only turn ("watch this", with the clip attached and
 * nothing typed) is a real turn, and papering it over would hide the video.
 */
function withPlaceholderFallback(content: GeminiInteractionsContent[]): GeminiInteractionsContent[] {
  const real = content.filter((c) => !(c.type === 'text' && c.text === PLACEHOLDER_EMPTY_CONTENT));
  return real.length > 0 ? real : [{ type: 'text', text: PLACEHOLDER_EMPTY_CONTENT }];
}

/**
 * Google's documented escape for a function call the model did not sign: the
 * validator skips a thought carrying this signature. Sent only where no real
 * signature exists; a signed turn is never touched. Shared with the
 * generateContent lane (one value, defined beside that lane's floor).
 */
export { GEMINI_SENTINEL_THOUGHT_SIGNATURE };

export function ensureValidGeminiInteractionsSteps(steps: GeminiInteractionsStep[]): GeminiInteractionsStep[] {
  const out: GeminiInteractionsStep[] = [];
  // Whether the CURRENT model turn (everything since the last user_input or
  // function_result) has opened with a thought. Idempotent: the sentinel is a
  // thought, so a second pass over the same steps inserts nothing.
  let turnHasThought = false;
  // Where the current model turn BEGINS in `out`. The sentinel is spliced in
  // there — at the head of the turn, ahead of any text — never just before the
  // call: Google requires a turn that carries a thought to START with it (probed
  // 2026-09-04: text → thought → call is a 400 "must start with a thought block";
  // thought → text → call is a 200). A turn with no call gets nothing.
  let turnStart = 0;
  for (const s of steps) {
    switch (s.type) {
      case 'user_input': {
        turnHasThought = false;
        const prev = out[out.length - 1];
        // Consecutive user turns fold into ONE (parallel tool results + the next
        // user message, or two staged turns).
        const merging = prev !== undefined && prev.type === 'user_input';
        const content = withPlaceholderFallback([...(merging ? prev.content : []), ...nonEmpty(s.content)]);
        if (merging) out[out.length - 1] = { ...prev, content };
        else out.push({ ...s, content });
        turnStart = out.length;
        break;
      }
      case 'model_output': {
        const content = nonEmpty(s.content);
        // A text-less model turn (tool-only) is carried by its function_call steps;
        // an EMPTY model_output is dropped rather than placeholdered.
        if (content.length > 0) out.push(content.length === s.content.length ? s : { ...s, content });
        break;
      }
      case 'function_result': {
        turnHasThought = false;
        const result = nonEmpty(s.result);
        out.push(result.length > 0 ? (result.length === s.result.length ? s : { ...s, result }) : {
          ...s,
          result: [{ type: 'text', text: PLACEHOLDER_NO_OUTPUT }],
        });
        turnStart = out.length;
        break;
      }
      case 'thought':
        turnHasThought = true;
        out.push(s);
        break;
      case 'function_call':
        if (!turnHasThought) {
          out.splice(turnStart, 0, { type: 'thought', signature: GEMINI_SENTINEL_THOUGHT_SIGNATURE });
          turnHasThought = true;
        }
        out.push(s);
        break;
      default:
        out.push(s);
    }
  }
  return out;
}

export function stripOrphanedGeminiInteractionsCalls(steps: GeminiInteractionsStep[]): GeminiInteractionsStep[] {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const s of steps) {
    if (s.type === 'function_call') callIds.add(s.id);
    if (s.type === 'function_result') resultIds.add(s.call_id);
  }
  const needsSynth = [...callIds].some((id) => !resultIds.has(id));
  const hasGhost = [...resultIds].some((id) => !callIds.has(id));
  if (!needsSynth && !hasGhost) return steps;

  const out: GeminiInteractionsStep[] = [];
  let pendingSynth: GeminiFunctionResultStep[] = [];
  const flush = () => {
    out.push(...pendingSynth);
    pendingSynth = [];
  };
  for (const s of steps) {
    if (s.type === 'function_call') {
      out.push(s);
      if (!resultIds.has(s.id)) {
        pendingSynth.push({
          type: 'function_result',
          call_id: s.id,
          name: s.name,
          result: [{ type: 'text', text: PLACEHOLDER_NO_OUTPUT }],
        });
      }
      continue;
    }
    // The call run ended: answer its unanswered calls before whatever comes next.
    flush();
    if (s.type === 'function_result' && !callIds.has(s.call_id)) continue; // ghost result
    out.push(s);
  }
  flush();
  return out;
}
