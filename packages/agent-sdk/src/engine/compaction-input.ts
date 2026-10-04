/**
 * compaction-input.ts — what the compaction TRIGGER measures and what the SUMMARIZE sends.
 *
 * Both numbers were wrong in the same direction on gpt-6-luna (B1, 2026-09-29):
 *
 *   THE TRIGGER read the chars/4 estimate over text blocks. It never sees replayed
 *   encrypted reasoning and undercounts dense tool output (~2.7 chars/token), so it ran at
 *   60-65% of the real input and the 244.8K trigger first fired at 330-410K real. Task
 *   c00b391e crossed OpenAI's 272K long-context line at round 18 and compacted at round
 *   31. The provider counts every request already; that count is the truth and the
 *   estimate is a hint (kernel/compaction/trigger.ts `measuredInputTokens`).
 *
 *   THE SUMMARIZE sent the whole dropped span, encrypted reasoning included: ~443K per
 *   attempt on task 9472b042, every one of them billed above the 272K line.
 *
 * Split out of compaction-run.ts under the 1100-line file-size ratchet.
 */

import type { JournalEntry } from '../contract/journal.js';
import type { NormalizedUsage } from './transport.js';
import type { RunContext } from './run-context.js';
import { resolveCapabilities } from '../contract/model-capabilities.js';
import { projectTokenCount, type ReportedInput } from '../kernel/index.js';
import { lastCompactionSeq } from './compaction-recovery.js';

// ─── The trigger's input: the provider's count ───────────────────────────────

/**
 * Record what the provider counted for a settled MAIN-loop round. Called once per round,
 * right after its assistant entry is journaled, so `atSeq` splits the journal into "what
 * that request carried" and "what was appended since".
 */
export function recordRoundInput(rc: RunContext, usage: NormalizedUsage, model: string, atSeq: number): void {
  rc.lastRoundInput = {
    model,
    inputTokens: usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0),
    outputTokens: usage.outputTokens,
    atSeq,
    elisionCut: elisionCutOf(rc),
  };
}

/** What the turn's frozen elision removes, as its two cuts (0 when nothing is elided). */
function elisionCutOf(rc: RunContext): { result: number; image: number } {
  return { result: rc.elision?.cut.resultCutTokens ?? 0, image: rc.elision?.cut.imageCutTokens ?? 0 };
}

/**
 * The last request's count, plus what the journal gained since — or undefined when that
 * count no longer describes the context the next request will send. Three ways it goes
 * stale, each read off current state rather than cleared at the sites that cause it:
 *
 *   · a MODEL switch — another tokenizer, and a cross-issuer switch drops the reasoning
 *     the count included, so it would overstate;
 *   · an ELISION cut that went DOWN — less is elided, so the wire GREW under the count and
 *     it would understate. Not a new map as such: `prepareElision` mints one every user
 *     turn, and within an uncompacted span the cut only ratchets up, so a new map with the
 *     same or a higher cut only shrinks the wire and the count errs high, the safe side;
 *   · a COMPACTION after it — it counted a context that is gone (the same seq test the
 *     overflow latch's Guard 2 uses).
 *
 * The appended estimate skips `tool_use` entries: every one after the counted assistant
 * entry is that round's own call, whose arguments are already in `outputTokens`.
 */
export function reportedInputSince(
  rc: RunContext,
  messages: JournalEntry[],
  summaryLeading: boolean | undefined,
  model: string,
): ReportedInput | undefined {
  const last = rc.lastRoundInput;
  if (!last || last.model !== model) return undefined;
  const cut = elisionCutOf(rc);
  if (cut.result < last.elisionCut.result || cut.image < last.elisionCut.image) return undefined;
  const compactedAt = lastCompactionSeq(messages, summaryLeading);
  if (compactedAt !== null && compactedAt > last.atSeq) return undefined;
  let from = messages.length;
  while (from > 0 && messages[from - 1].seq > last.atSeq) from--;
  const appended = messages.slice(from).filter((e) => e.payload.type !== 'tool_use');
  return {
    inputTokens: last.inputTokens,
    outputTokens: last.outputTokens,
    appendedTokens: projectTokenCount(appended, { countImages: true }).messages,
  };
}

// ─── The summarize request: no reasoning, and under the pricing line ─────────

/**
 * The span as the SUMMARIZER needs it: replayed reasoning removed. The summary is written
 * from what was said and done; the encrypted reasoning behind it is opaque to the
 * summarizer, and on gpt-6-luna it was the bulk of the request.
 *
 * OpenAI Responses channels only — the sealed `responsesOutput` reasoning items and the
 * per-record `reasoning` fields — where a request without them is accepted: it is exactly
 * what the `invalid_encrypted_content` recovery sends (request-validity.ts preflight, the
 * kill switch; ids accepted without reasoning, probed 2026-09-23). Anthropic signed thinking
 * is left alone: with thinking on, a tool-use turn must carry its thinking back. Pure.
 */
export function withoutReplayedReasoning(entries: JournalEntry[]): JournalEntry[] {
  return entries.map((e) => {
    const p = e.payload;
    if (p.type === 'tool_use' && p.reasoning) {
      const { reasoning: _reasoning, ...rest } = p;
      return { ...e, payload: rest };
    }
    if (p.type === 'assistant' && (p.reasoning || p.responsesOutput)) {
      const { reasoning: _reasoning, responsesOutput, ...rest } = p;
      const items = responsesOutput?.items.filter((item) => item.type !== 'reasoning') ?? [];
      // An output that held nothing but reasoning is dropped whole; the projection then
      // rebuilds the round from its text and its tool_use entries.
      return {
        ...e,
        payload: items.length > 0 ? { ...rest, responsesOutput: { ...responsesOutput, items } } : rest,
      };
    }
    return e;
  });
}

/**
 * How far the estimate undercounts what is left once reasoning is gone: dense tool output
 * runs ~2.7 chars/token against the estimate's 4, so real ≈ 1.48x the estimate.
 */
const ESTIMATE_UNDERCOUNT = 1.5;

/**
 * The summarize request's budget in ESTIMATED tokens, or undefined when the model declares
 * no long-context pricing line (Anthropic bills its whole window at one rate, and the window
 * itself is the provider's to enforce).
 */
export function summarizeInputBudget(model: string): number | undefined {
  const line = resolveCapabilities(model).premiumInputThreshold;
  return line === undefined ? undefined : Math.floor(line / ESTIMATE_UNDERCOUNT);
}

/**
 * Keep the summarize request under the model's pricing line. Oldest first, the span loses
 * whole rounds until it fits, and the dropped entries are not lost: the compaction archives
 * the FULL span and the summary points at the archive.
 *
 *   · The HEAD always survives. It is the user's ask or the previous summary, and the
 *     summary's "Open request" (formerly "Latest request") is read from it; lose it and
 *     the task is replaced by whatever the rest suggests (the T9c drill).
 *   · The cut lands on an ASSISTANT entry, so a round travels with its tool calls and the
 *     head is never followed by a second user message. A kept result whose call was left
 *     out (a paused call answered rounds later) is left out with it, never sent orphaned.
 *   · Bounded by construction: one pass. A span with no assistant entry late enough to fit
 *     is sent as the head alone; a head that alone exceeds the budget still goes, because
 *     a summary of the ask beats no summary.
 *
 * `fixedTokens` is what rides every request regardless (system prompt, instruction).
 */
export function boundSummarizeSpan(
  span: JournalEntry[],
  budget: number | undefined,
  fixedTokens: number,
): { span: JournalEntry[]; omitted: number } {
  if (budget === undefined || span.length <= 1) return { span, omitted: 0 };
  const tokens = span.map((e) => projectTokenCount([e], { countImages: true }).messages);
  let used = fixedTokens + tokens.reduce((a, b) => a + b, 0);
  if (used <= budget) return { span, omitted: 0 };
  // Walk the oldest non-head entries out until the rest fits.
  let first = 1;
  while (first < span.length && used > budget) used -= tokens[first++];
  while (first < span.length && span[first].payload.type !== 'assistant') first++;
  const kept = [span[0], ...span.slice(first)];
  const calls = new Set(kept.flatMap((e) => (e.payload.type === 'tool_use' ? [e.payload.toolUseId] : [])));
  const paired = kept.filter((e) => e.payload.type !== 'tool_result' || calls.has(e.payload.toolUseId));
  return { span: paired, omitted: span.length - paired.length };
}

/**
 * The system-prompt note a TRIMMED summarize carries, so the summary does not describe the
 * part it was shown as the whole. Absent when nothing was left out, so every untrimmed
 * request (and the eval-bound prompt) stays byte-identical.
 */
export function withTrimmedSpanNote(system: string, omitted: number): string {
  if (omitted === 0) return system;
  return `${system}\n\nTo keep this request within its size limit, ${omitted} of the oldest entries after the opening message were left out of the conversation above. They are archived in full. Summarize what is shown, say that earlier work was omitted, and do not guess at it.`;
}
