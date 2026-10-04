/**
 * recall.ts — P5 Task 2 (Nami in the loop): per-round read-on-relevance
 * primitives for the AUTOMATIC memory consult.
 *
 * The round loop (native-harness iterateTurn) deadline-races `readRelevant`
 * at each round head and delivers a non-empty result IN-BAND as a FIRST-CLASS
 * user journal entry (the mid-turn steer discipline) — CACHE-HONEST across
 * rounds AND turns: every later projection reproduces the fence
 * byte-identically, so request prefixes never diverge (the fleet-verified
 * failure of the earlier in-memory pin design: the next turn re-projected the
 * hit turn's user message CLEAN and re-wrote that turn's whole span into
 * cache). Never the system prompt (the memory layers never move mid-session:
 * layer 9 `nami_pull` is STATIC per deploy, layer 12 `nami` is SESSION_FROZEN
 * — instruction-stack.ts). Fossilization is bounded
 * (maxPerTurn × maxChars per turn; compaction attenuates) and deduped
 * durably: an identical fence already in the projection is never re-appended.
 *
 * DEGRADE-SAFE (non-negotiable, the P5 deadline-race discipline): expiry,
 * error, sync throw, null — ALL render '' (skip + proceed) and never throw
 * into the turn. The deadline timer is unref'd so a pending race never keeps
 * the process alive, and a late rejection is pre-handled (no unhandled
 * rejection after the race resolves).
 *
 * The SDK reads no env: the product supplies the seam via
 * `NativeConfig.recall` (NAMI_RETRIEVAL_ENABLED='server' → namiRetrievalArm()
 * → namiRecallSeamForConfig, apps/sandbox native-config-factory.ts),
 * composed over the EXISTING server recall route (POST
 * /api/internal/nami/recall — the full memory store the `context_query` pull
 * arm reads) — never a second retrieval stack. The NAMI_IN_LOOP flag this
 * header once named is retired (unread, undelivered, swept from dashboards).
 */
import type { JournalEntry } from '../contract/journal.js';
// The fence — its opener, its closer, the MINT (`fenceRecall`) and the predicate
// that recognises it — lives in contract/, the ONE registry of engine-minted user
// text: policy/ needs the same answer and may never import engine/, and a test in
// any package can then build a fixture by CALLING the mint. Re-exported here so
// this module's callers keep their import path.
import { isRealUserTurn } from '../contract/injected-user-text.js';
export { fenceRecall, isRecallFence } from '../contract/injected-user-text.js';

/**
 * The product-supplied consult seam (NativeConfig.recall). `readRelevant`
 * returns the recall text for a query, or null to abstain — it should be
 * fast-or-empty; the loop deadline-races it and drops the result on expiry.
 */
export interface RecallSeam {
  readRelevant: (query: string) => Promise<string | null>;
  /** Max ms a round waits on the consult before proceeding without it. */
  deadlineMs?: number;
  /** Max chars of ONE recall text (clamped with a truncation marker). */
  maxChars?: number;
  /** Max DISTINCT injections per turn — each new one eats one bounded cache break. */
  maxPerTurn?: number;
  /**
   * Observability (P5 T5-extension — the eval's in-loop arm; now also the
   * product's flip instrument on the sandbox server-recall arm). Called once
   * per CONSULTING round with the ENGINE's total added latency for the round
   * (the bounded race + append + re-project — what wrapping readRelevant alone
   * cannot see) and the outcome. Guarded: a throwing observer never affects the
   * turn. ABSENT (the default) → zero calls → byte-identical. Not a metering
   * surface — no cost rides this.
   */
  onConsult?: (sample: RecallConsultSample) => void;
}

/** One consulting round's observation (RecallSeam.onConsult). */
export interface RecallConsultSample {
  /** Engine-side wall ms the consult added to the round (all paths). */
  waitMs: number;
  /**
   * 'appended' — a new fence entered the journal (one bounded cache break);
   * 'duplicate' — the fetch returned a fence already in the projection;
   * 'empty' — abstention OR deadline expiry ('' contract — indistinguishable
   *           by design; the fixture side disambiguates in the eval);
   * 'short-circuit' — unchanged query after a miss/duplicate: no RPC.
   */
  outcome: 'appended' | 'duplicate' | 'empty' | 'short-circuit';
}

export const RECALL_DEADLINE_MS_DEFAULT = 250;
export const RECALL_MAX_CHARS_DEFAULT = 2000;
export const RECALL_MAX_PER_TURN_DEFAULT = 2;
export const RECALL_TRUNCATION_MARKER = '\n[recalled memory truncated]';

/** How many recent distinct tool names ride the query alongside the user text. */
const RECALL_QUERY_TOOL_NAMES = 4;

/**
 * Build the consult query from the turn's freshest working set — the LAST user
 * entry's text (a mid-turn steer, being a first-class user entry, naturally
 * becomes the query) plus the most recent distinct tool names (chronological).
 * Pure; '' when there is no user text (nothing to consult on).
 */
export function buildRecallQuery(entries: JournalEntry[]): string {
  let userText = '';
  for (let i = entries.length - 1; i >= 0; i--) {
    const p = entries[i].payload;
    if (p.type === 'user') {
      const text = p.blocks
        .map((b) => (b.type === 'text' ? b.text : ''))
        .filter(Boolean)
        .join('\n')
        .trim();
      // Skip EVERY engine-minted user entry (journaled recall fences, the T9c
      // split-turn continuation marker, a hook's continueContext) — all of it is
      // text the LOOP wrote, not user intent, and querying on it feeds the consult
      // back on itself. This asked for `isRecallFence` alone until the marker
      // arrived: after a split-turn compaction the marker is the last user entry
      // for the whole rest of the turn, so every consult from the compaction onward
      // queried on its boilerplate — at the exact moment the real ask had just been
      // summarized away. A STEER stays visible: it is the person speaking.
      if (!isRealUserTurn(entries[i])) continue;
      userText = text;
      break;
    }
  }
  if (!userText) return '';
  const toolNames: string[] = [];
  for (let i = entries.length - 1; i >= 0 && toolNames.length < RECALL_QUERY_TOOL_NAMES; i--) {
    const p = entries[i].payload;
    if (p.type === 'tool_use' && !toolNames.includes(p.name)) toolNames.push(p.name);
  }
  return toolNames.length
    ? `${userText}\n[tools: ${toolNames.reverse().join(', ')}]`
    : userText;
}

/**
 * The deadline race: resolve `readRelevant(query)` or '' at `deadlineMs`,
 * whichever comes first. Never rejects; a late settlement of the losing
 * promise is pre-handled (no unhandled rejection); the timer is unref'd and
 * cleared when the port wins.
 */
export async function fetchRecall(
  readRelevant: (query: string) => Promise<string | null>,
  query: string,
  deadlineMs: number,
  // Fleet fix (PR #1347 item 1): the run signal joins the race — an abort
  // mid-wait resolves '' IMMEDIATELY (the turn is unwinding; never sit out the
  // deadline), and an already-aborted signal skips the RPC entirely.
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) return '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    // Wrap in an async IIFE so BOTH a sync throw and an async rejection land in
    // the same pre-attached catch — handled even when the deadline wins the race.
    const guarded = (async () => (await readRelevant(query)) ?? '')().catch(() => '');
    const expiry = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve(''), deadlineMs);
      timer.unref?.();
      if (signal) {
        onAbort = () => resolve('');
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    return await Promise.race([guarded, expiry]);
  } catch {
    return '';
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Bound one recall text to `maxChars` CODEPOINTS, marking the cut. Codepoint-
 * safe (fleet fix, PR #1347 item 2): `Array.from` iterates codepoints, so the
 * cut can never split a surrogate pair (the step-memo clampResultText idiom).
 */
export function clampRecall(text: string, maxChars: number): string {
  const codepoints = Array.from(text);
  if (codepoints.length <= maxChars) return text;
  return codepoints.slice(0, maxChars).join('') + RECALL_TRUNCATION_MARKER;
}
