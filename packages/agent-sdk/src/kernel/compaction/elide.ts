/**
 * elide.ts — the eliding projection (CONTEXT_ELISION_V1).
 *
 * The journal keeps full fidelity forever; the WIRE view shrinks. Old, large
 * `tool_result` bodies are replaced by a one-line stub naming the tool and the
 * spill file that still holds the full bytes, and old images are replaced by a
 * text placeholder naming what they were.
 *
 * ─── WHY THIS IS NOT A SLIDING WINDOW (the cache argument) ────────────────────
 *
 * The obvious implementation — "elide anything older than K turns" — re-writes a
 * DIFFERENT message every single turn. Anthropic's prompt cache matches on an
 * exact prefix, so a mid-history edit invalidates every cached block from that
 * point on. A per-turn edit near the FRONT of history therefore busts the whole
 * cached prefix on EVERY request, and a bust costs (1.25 - 0.1) = 1.15x base
 * input on everything it invalidates. Elision that saves 0.1x on the bytes it
 * removes while paying 1.15x on everything it keeps is a net LOSS.
 *
 * So the cut is a STEP FUNCTION on a fixed grid, never a slide:
 *
 *   cutTokens = floor(min(total - liveWindow, keepTurnsFloor) / stride) * stride
 *
 * Both inputs grow monotonically while the PROJECTION only grows, and
 * `floor(x/stride)*stride` is monotone non-decreasing. That yields the two
 * properties the cache needs:
 *
 *   MONOTONE   — an entry that is elided stays elided. The elided form is the
 *                durable wire form from then on (pi's rewrite-once pattern),
 *                so the prefix RE-STABILIZES after a single bust.
 *   QUANTIZED  — the cut is ALWAYS a multiple of `stride`, so it moves only once
 *                per `stride` tokens of journal growth. Between steps the wire
 *                bytes are identical and the cache is undisturbed.
 *
 * "The projection only grows" is NOT the same claim as "the journal is
 * append-only". The JSONL is append-only; `journal.project()` is not — it splices
 * on the journal's own rewrite markers (`applyCompaction` re-heads the list with a
 * summary and drops the summarized span; `applyRewind` drops an abandoned middle
 * span). Across either of those the prefix sums a cut was measured against are
 * gone, and carrying the cut forward would elide against positions that now hold
 * different content. `clampCutMonotonic` below detects exactly that and releases;
 * see its doc for why the detection is derived from the rewrite instead of
 * signalled by its callers.
 *
 * The cost model that picks the defaults, using measured production numbers
 * (1,034 turns / 7d: 4.4k tokens of context growth per turn, hit_rate 0.70,
 * 29% of input already riding at full price):
 *
 *   bust cost      = 1.15 x (tokens kept)            — once per step
 *   saving         = (blended input rate) x (tokens elided) — every turn after
 *   break-even     = 1.15 x kept / (rate x elided) turns
 *
 * Break-even in TURNS is scale-invariant: `kept` and `elided` both scale with
 * the budget, so their ratio does not move when the budget does. That is what
 * lets the base change below without re-deriving the model.
 *
 * ─── THE BASE IS THE COMPACTION TRIGGER, NOT THE CONTEXT WINDOW ───────────────
 *
 * Every fraction here used to be taken against `resolveMaxContextTokens(model)`.
 * That is the wrong number, and it made the whole mechanism inert.
 *
 * Elision only ever gets to act in the span BELOW where compaction rewrites
 * history. The compaction trigger (kernel/compaction/trigger.ts) is
 * `min(0.8 x window, 0.9 x preferredMaxInputTokens)` — and on every model that
 * declares a preferred ceiling that pins it at 180,000 (or 244,800) NO MATTER
 * how large the window is, while `0.55 x window` scales with the window. On a
 * 1M lane compaction rewrites at 180,000 while elision's first cut wanted
 * 550,000: a 3x gap the mechanism could never cross. Measured 2026-08-22:
 * 0 of 12,178 staging calls and at most 19 of 5,054 prod calls in 60 days would
 * have produced a non-zero cut.
 *
 * So `budgetTokens` is the compaction trigger (engine/compaction-budget.ts
 * resolves it, from the same function compaction itself reads). The fractions
 * are UNCHANGED — only what they are a fraction OF has changed:
 *
 *   design point, 200k window, C = 0.8 x 200,000 = 160,000
 *     first cut, old base W: 0.55 x 200,000 = 110,000
 *     first cut, new base C: 0.55 x 160,000 =  88,000
 *
 * ─── WHY 0.55 x C AND NOT 1.0 x C ─────────────────────────────────────────────
 *
 * The trigger and this cut do not measure the same thing. The trigger reads
 * `projectTokenCount(wire, {countImages:true}) + system + tool schemas`; the cut
 * reads `entryTokens`, which is TEXT BLOCKS ONLY. So this ruler runs low by
 * X = system + tools + images. Measured on claude-sonnet-5
 * (scripts/harness-evals/results/AB-CONTEXT-FLAGS-2026-08-12.md): turn-1 wire is
 * 45,323 tokens against a 2-token user message, i.e. X is about 45,300 for
 * system + tools alone. A cut placed AT the trigger would therefore land ~45k
 * AFTER compaction had already fired.
 *
 *   dominant lane, C = 180,000
 *     first cut at journal text   0.55 x 180,000 = 99,000
 *     compaction at journal text  180,000 - 45,300 = 134,700
 *     headroom                    35,700  (~8 turns at 4.4k/turn)
 *
 * At the policy's own 200k design point the same arithmetic gave 110,000 vs
 * 114,700 — 4,700, about ONE turn. Re-basing therefore leaves roughly 7.5x more
 * headroom than the policy ever had where it was derived, which is the argument
 * for keeping the fractions and changing only the base.
 *
 * PURITY CONTRACT (mirrors prune.ts, its predecessor):
 *   - No I/O, no clock, no provider SDK, no `process.env`.
 *   - Imports only the sibling token-ledger + the journal contract type.
 *   - Never throws — degenerate input is tolerated silently.
 *
 * The FULL text of every elided result is handed back to the caller in `spills`
 * so the engine can write it to the offload dir; this module stays pure. The
 * stub names the spill path UNCONDITIONALLY (a deterministic function of taskId
 * + toolUseId), never "the path if the write succeeded" — a stub whose text
 * depended on I/O success would differ between two projections of the same
 * journal and re-introduce exactly the cache instability this design exists to
 * avoid. A missing spill file degrades the same way the pre-existing offload
 * machinery already documents: `Read` returns its ordinary not-found.
 *
 * PAIR-SAFE: a `tool_result` entry is never dropped and its `toolUseId` is never
 * touched — only the CONTENT of its blocks is replaced, so every tool_use /
 * tool_result pairing on the wire stays structurally valid.
 */

import type { JournalEntry } from '../../contract/journal.js';
import { estimateTokens, IMAGE_TOKEN_ESTIMATE } from '../journal/token-ledger.js';
import { isRealUserTurn } from '../../contract/injected-user-text.js';

// ─── Policy ───────────────────────────────────────────────────────────────────

export interface ElisionPolicy {
  /** Never elide inside the last N `user` turns, whatever the token math says.
   *  NOT a budget fraction — it counts user messages.
   *
   *  T9b: what actually grows in an agentic lane is tool ROUNDS, and such a lane has
   *  exactly ONE `user` turn (a Nami dream pass; every long single-ask Bash task), so
   *  counting user messages protected the whole journal and this was the gate those
   *  tasks died on. The SAME N is now also read as a count of ROUNDS, and the floor
   *  picks whichever unit the journal actually has — see the floor note in
   *  {@link computeElisionCut}. One number, two units, no new constant: the claim
   *  "protect the last four things the user could still be working inside" is the
   *  same claim in both shapes. */
  keepTurns: number;
  /** Never elide the newest fraction of the BUDGET (the compaction trigger).
   *  The working set: what the model must still see verbatim. Its natural unit is
   *  turns of real work — at the header's measured 4.4k tokens/turn, 0.25 is ~10
   *  turns on today's dominant lane and was ~11 at the 200k design point. */
  liveBudgetFraction: number;
  /** The cut advances in steps this large (as a fraction of the BUDGET). One
   *  prompt-cache bust per step, so this is the ONLY knob that trades cache
   *  stability against wire size. 0.30 is a step every ~12 turns. */
  strideFraction: number;
  /** Results smaller than this are left alone — the stub would not pay for itself.
   *  THE ONE KNOB THAT IS NOT A BUDGET FRACTION, deliberately: it is stub
   *  economics. The stub is ~202 chars => max(round(202/4), round(28*1.3)) = 51
   *  tokens, so at 500 the worst stub still nets 449 saved, a ~10x return. That
   *  arithmetic never mentions the window or the trigger, so it does not scale
   *  with either. */
  minResultTokens: number;
  /** Images age ahead of tool results by this much extra BUDGET fraction. Applied
   *  ONLY once the result cut is non-zero, and re-quantized onto the same grid, so
   *  it never adds a step of its own (see computeElisionCut).
   *
   *  MUST BE >= strideFraction TO DO ANYTHING. `resultCut` is by construction
   *  `k * stride`; `quantize(k*stride + bonus, stride) === k*stride` for any
   *  `bonus < stride`, and the floor-clipped branch collapses to the same value.
   *  At the original 0.15 against a 0.30 stride, `imageCut === resultCut` on every
   *  input — the field had never once fired. Set equal to `strideFraction` it means
   *  exactly what this comment says (one stride ahead) at zero extra cache busts. */
  imageBonusFraction: number;
}

/** Defaults derived in the header's cost model, taken against the COMPACTION
 *  TRIGGER (see the header's base note), not the context window. */
export const DEFAULT_ELISION_POLICY: ElisionPolicy = {
  keepTurns: 4,
  liveBudgetFraction: 0.25,
  strideFraction: 0.3,
  minResultTokens: 500,
  imageBonusFraction: 0.3,
};

/**
 * The identity of the projected span a cut covers, so a later turn can tell an
 * APPEND (carry the cut — the ratchet) from a REWRITE (release it).
 *
 * Two scalars, both read in O(1), and between them they are exact:
 *
 *   `index`/`seq`  the LAST entry the cut covers, by POSITION and by identity.
 *                  Removing any entry at or before it shifts that position, so
 *                  `entries[index].seq` stops matching. This is what catches an
 *                  `applyRewind` splice, whose head is untouched.
 *   `headSeq`      the projection head's identity. `applyCompaction` re-heads the
 *                  list with a summary entry that did not exist when the cut was
 *                  taken, so this ALWAYS changes across a compaction — by
 *                  construction, not by arithmetic that a `keepWindowTokens`
 *                  change could invalidate.
 *
 * Text shrinking INSIDE surviving entries (pruneSnapshots) moves neither, which
 * is the point: that case is what the ratchet exists for and must still hold.
 */
export interface CutAnchor {
  /** Index, in the projection this cut was computed over, of the last covered entry. */
  index: number;
  /** That entry's journal `seq`. */
  seq: number;
  /** The projection head's journal `seq`. */
  headSeq: number;
}

/** The frozen cut for one user turn. Both cuts are always multiples of `strideTokens`. */
export interface ElisionCut {
  /** Elide eligible tool_results whose prefix-token offset is below this. */
  resultCutTokens: number;
  /** Elide image blocks whose entry's prefix-token offset is below this. */
  imageCutTokens: number;
  /** The grid the two cuts live on (exported for the invariant test + observability). */
  strideTokens: number;
  /** What the cut covers, for {@link clampCutMonotonic}. Null on a zero cut (it
   *  covers nothing) — and a null anchor never ratchets, so "unverifiable" reads
   *  as "release", the safe default for a field nobody can forget to fill in. */
  anchor: CutAnchor | null;
}

/** The stub prefix, used to detect an already-elided entry (idempotence). */
const STUB_PREFIX = '[elided:';
/** prune.ts's stub prefix — an entry it already shrank is left alone. */
const PRUNE_STUB_PREFIX = '[pruned:';

// ─── Per-entry token weight ───────────────────────────────────────────────────

/**
 * Heuristic token weight of one journal entry — the RULER the cut is measured
 * with, deliberately TEXT-ONLY.
 *
 * Images are excluded here even though they are real tokens (the ledger charges
 * them; see IMAGE_TOKEN_ESTIMATE), because this ruler has a stricter job than
 * being accurate: it has to be MONOTONE. `journal.project()` already chains
 * `pruneScreenshots` (keep the newest 2 image-bearing tool_results, stub the
 * rest) ahead of us, so an entry that held an image this turn holds a short text
 * placeholder the next. Charging 1,200 tokens for that image would make the
 * entry's weight DROP as the conversation grew, the prefix sums shrink, and the
 * cut slide BACKWARD — un-eliding entries and busting the cache in both
 * directions. Counting text only means that swap slightly INCREASES the weight,
 * which is the safe direction.
 *
 * The cut is a position selector, not a cost measure; the ledger is the cost
 * measure. They are allowed to use different rulers, and each uses the right one.
 * `clampCutMonotonic` is the backstop for any other upstream pass that shrinks
 * text WITHOUT removing entries (pruneSnapshots does exactly that).
 */
function entryTokens(e: JournalEntry): number {
  const p = e.payload;
  if (p.type === 'tool_use') return estimateTokens(JSON.stringify(p.input));
  if (p.type === 'system') return estimateTokens(p.event + JSON.stringify(p.data ?? ''));
  if (
    p.type === 'user' ||
    p.type === 'assistant' ||
    p.type === 'custom_message' ||
    p.type === 'tool_result'
  ) {
    const blocks = p.blocks as Array<{ type: string; text?: string }>;
    let text = '';
    for (const b of blocks) if (b.type === 'text' && b.text) text += b.text + ' ';
    return estimateTokens(text);
  }
  return 0;
}

/** Text length of a tool_result body, in estimated tokens. */
function bodyTokens(blocks: ReadonlyArray<{ type: string; text?: string }>): number {
  let text = '';
  for (const b of blocks) if (b.type === 'text' && b.text) text += b.text + ' ';
  return estimateTokens(text);
}

function isAlreadyStub(blocks: ReadonlyArray<{ type: string; text?: string }>): boolean {
  for (const b of blocks) {
    if (
      b.type === 'text' &&
      typeof b.text === 'string' &&
      (b.text.startsWith(STUB_PREFIX) || b.text.startsWith(PRUNE_STUB_PREFIX))
    ) {
      return true;
    }
  }
  return false;
}

function hasImage(blocks: ReadonlyArray<{ type: string }>): boolean {
  for (const b of blocks) if (b.type === 'image') return true;
  return false;
}

/**
 * Prefix offset of the `n`th-from-last entry of `type`, or undefined when the
 * projection holds fewer than `n` of them. The floor's one primitive, read twice
 * (see the floor note in {@link computeElisionCut}) so the two units cannot drift.
 */
function nthFromLastOffset(
  entries: ReadonlyArray<JournalEntry>,
  before: ReadonlyArray<number>,
  type: 'user' | 'assistant',
  n: number,
): number | undefined {
  let seen = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    // D4 — the `user` arm counts real TURNS. Nami's per-round consult appends a
    // `<recalled_memory …>` fence as a user-role entry, and counting those corrupted the
    // floor in BOTH directions on a one-ask journal: keepTurns fences flipped the rule to
    // the USER floor whose nth-from-last is the head (a zero cut — elision disabled on the
    // lane it exists for), while one more pushed the floor PAST the protected tail and
    // elided the very rounds it protects. The `assistant` arm is unchanged.
    const hit =
      type === 'user' ? isRealUserTurn(entries[i]) : entries[i].payload.type === 'assistant';
    if (!hit) continue;
    seen++;
    if (seen === n) return before[i];
  }
  return undefined;
}

/** floor to the grid, never negative. */
function quantize(x: number, stride: number): number {
  if (!Number.isFinite(x) || x <= 0 || stride <= 0) return 0;
  return Math.floor(x / stride) * stride;
}

// ─── Cut anchors ──────────────────────────────────────────────────────────────

/** {@link CutAnchor} for `coverTokens`, from prefix sums already in hand. */
function anchorFromPrefix(
  entries: ReadonlyArray<JournalEntry>,
  before: ReadonlyArray<number>,
  coverTokens: number,
): CutAnchor | null {
  if (entries.length === 0 || coverTokens <= 0) return null;
  // `before` is non-decreasing, so the first hit scanning backwards is the LAST
  // entry the cut covers. Index 0 always qualifies (`before[0]` is 0 and
  // `coverTokens` is positive here), so the scan can stop above it and the
  // function has no unreachable no-match branch.
  let index = 0;
  for (let i = entries.length - 1; i > 0; i--) {
    if (before[i] < coverTokens) {
      index = i;
      break;
    }
  }
  return { index, seq: entries[index].seq, headSeq: entries[0].seq };
}

/**
 * {@link CutAnchor} for `coverTokens` over a projection whose prefix sums are not
 * already computed. Exported for the clamp's raise path and the invariant tests.
 */
export function anchorFor(
  entries: ReadonlyArray<JournalEntry>,
  coverTokens: number,
): CutAnchor | null {
  const before: number[] = new Array(entries.length);
  let running = 0;
  for (let i = 0; i < entries.length; i++) {
    before[i] = running;
    running += entryTokens(entries[i]);
  }
  return anchorFromPrefix(entries, before, coverTokens);
}

/** True iff `entries` still holds the span `anchor` was taken over. O(1). */
function anchorHolds(anchor: CutAnchor | null, entries: ReadonlyArray<JournalEntry>): boolean {
  if (!anchor || entries.length === 0) return false;
  return entries[0].seq === anchor.headSeq && entries[anchor.index]?.seq === anchor.seq;
}

// ─── computeElisionCut ────────────────────────────────────────────────────────

/**
 * The monotone, quantized cut for a projection. Pure; never throws.
 *
 * `budgetTokens` is THE COMPACTION TRIGGER for the running model — the point at
 * which history stops growing because something rewrites it — resolved by
 * `engine/compaction-budget.ts` from the same function compaction itself reads.
 * It is deliberately NOT the context window: see the base note in the header for
 * why that made the whole mechanism inert on every 1M lane.
 *
 * Returns an all-zero cut (⇒ elide nothing) whenever the journal is too short to
 * have anything safely elidable — which since T9b means fewer than
 * `policy.keepTurns` user turns AND fewer than `policy.keepTurns` rounds (see the
 * floor note in the body).
 */
export function computeElisionCut(
  entries: ReadonlyArray<JournalEntry>,
  budgetTokens: number,
  policy: ElisionPolicy = DEFAULT_ELISION_POLICY,
): ElisionCut {
  const stride = Math.max(1, Math.round(budgetTokens * policy.strideFraction));
  const empty: ElisionCut = {
    resultCutTokens: 0,
    imageCutTokens: 0,
    strideTokens: stride,
    anchor: null,
  };
  const n = entries.length;
  if (n === 0) return empty;

  // Prefix sums over the RAW projection. Prefix-stable: the journal is append-only,
  // so before[i] for an existing entry never changes as the journal grows. This is
  // what makes the cut monotone, and it is why the cut must NEVER be computed off
  // an already-elided view (that would shrink as elision advanced, and the cut
  // would oscillate).
  const before: number[] = new Array(n);
  let running = 0;
  for (let i = 0; i < n; i++) {
    before[i] = running;
    running += entryTokens(entries[i]);
  }
  const total = running;

  // ── The keepTurns floor ────────────────────────────────────────────────────
  //
  // FIRST CHOICE, unchanged: the prefix offset of the Nth-from-last `user` entry.
  // A journal that holds `keepTurns` user entries computes exactly the cut it
  // always did.
  //
  // T9b FALLBACK: a journal with FEWER than `keepTurns` user entries is an agentic
  // loop, not a chat — one ask, many rounds — and the user floor protected all of it
  // forever. There the protected tail is the last `keepTurns` ROUNDS, mirroring
  // Hermes's `protect_last_n_turns` (trajectory_compressor.py:743-889). A round
  // STARTS at its `assistant` entry (the journal appends the assistant entry, then
  // that round's `tool_use` entries, then their `tool_result`s), so the Nth-from-last
  // assistant's prefix offset IS the start of the Nth-from-last round — which is why
  // the tail is measured there and not at the results.
  //
  // MONOTONE, both units: `before[i]` for an existing entry never changes (the
  // projection is append-only between rewrites), and appending rounds only moves the
  // Nth-from-last assistant LATER, so the floor only rises. A round start's prefix
  // offset never moves.
  //
  // SWITCH-OVER: when the `keepTurns`-th `user` entry finally arrives the rule
  // changes unit and the RAW floor RETREATS (with exactly `keepTurns` users the
  // Nth-from-last user is the head, whose offset is 0 ⇒ a zero cut). That retreat is
  // held by the run-scoped ratchet — nothing was spliced, so the anchor still
  // reconciles and `clampCutMonotonic` carries the previous cut forward. See its doc
  // for why the release is derived from the rewrite and never signalled.
  const floorTokens =
    nthFromLastOffset(entries, before, 'user', policy.keepTurns) ??
    nthFromLastOffset(entries, before, 'assistant', policy.keepTurns);
  if (floorTokens === undefined) return empty;

  const live = Math.round(budgetTokens * policy.liveBudgetFraction);
  const resultCutTokens = quantize(Math.min(total - live, floorTokens), stride);
  if (resultCutTokens <= 0) return empty;

  // Images age ahead of results by exactly ONE stride (imageBonusFraction ===
  // strideFraction), but ONLY by re-landing on the same grid and never past the
  // keepTurns floor — so imageCut still changes exactly when resultCut does. A
  // separate image clock would double the number of cache busts to save ~1.2k
  // tokens per image, which does not pay. A bonus SMALLER than the stride is not
  // a gentler version of this: it quantizes back down to resultCut and the whole
  // branch becomes a no-op (see the field's comment).
  const bonus = Math.round(budgetTokens * policy.imageBonusFraction);
  const imageCutTokens = Math.max(
    resultCutTokens,
    quantize(Math.min(resultCutTokens + bonus, floorTokens), stride),
  );

  return {
    resultCutTokens,
    imageCutTokens,
    strideTokens: stride,
    // Anchored at the WIDER cut: the two are justified together, so the whole
    // covered span is what a later turn has to find intact.
    anchor: anchorFromPrefix(entries, before, imageCutTokens),
  };
}

/**
 * Monotonic backstop: never let a freshly computed cut retreat behind the one
 * this run already used — FOR AS LONG AS THEY MEASURE THE SAME HISTORY.
 *
 * The ratchet is load-bearing. The quantized cut is monotone as long as the prefix
 * sums it reads are, and the text-only ruler above makes that true for the passes
 * we know about; this makes it true unconditionally, because an upstream pass that
 * shrinks text (`pruneSnapshots` does exactly that) could otherwise walk the cut
 * backward, and an un-elided entry is strictly worse than an elided one: it
 * re-inflates the wire AND busts the whole cached prefix to do it. That backward
 * step is the documented cause of the 2026-08-13 rollback.
 *
 * ─── WHY IT ALSO HAS TO LET GO ────────────────────────────────────────────────
 *
 * The ratchet's premise is that the projection only ever grows. Compaction breaks
 * it: `applyCompaction` re-heads the list with a summary and drops the summarized
 * span, so a cut of 216,000 taken before the splice lands in the middle of a
 * 30,000-token projection afterwards. The raw policy correctly returns a ZERO cut
 * there (fewer than `keepTurns` user entries survive) and an unconditional ratchet
 * OVERRIDES that zero — stubbing the very `keepWindowTokens` slice the compactor
 * ran in order to preserve. `applyRewind` breaks it the same way from the middle.
 *
 * So the carry is CONDITIONAL on the anchor still reconciling (see {@link CutAnchor}).
 * The condition is DERIVED FROM THE REWRITE'S EFFECT ON THE PROJECTION, never
 * signalled by whoever performed it, and that is deliberate: compaction is reached
 * from four sites in native-harness.ts, one more in compaction-run.ts, and one in
 * apps/sandbox/src/harness/native-hooks-register.ts:187-245 (the arm's PostCompact
 * observer) — not even in this package. A release that had to be remembered at each would
 * be one `journal.compact()` away from silently regressing, forever. Here there is
 * nothing to remember: any splice that moves the covered span releases the cut, and
 * a future splice pass nobody has written yet is covered by construction.
 *
 * Run-scoped, not global — it rides RunContext, so parallel sessions in one
 * process never share a cut.
 */
export function clampCutMonotonic(
  next: ElisionCut,
  previous: ElisionCut | null,
  entries: ReadonlyArray<JournalEntry>,
): ElisionCut {
  if (!previous || !anchorHolds(previous.anchor, entries)) return next;
  const resultCutTokens = Math.max(next.resultCutTokens, previous.resultCutTokens);
  const imageCutTokens = Math.max(next.imageCutTokens, previous.imageCutTokens);
  // Nothing carried ⇒ `next` is already the answer, anchor included (no second walk).
  if (resultCutTokens === next.resultCutTokens && imageCutTokens === next.imageCutTokens) {
    return next;
  }
  return {
    resultCutTokens,
    imageCutTokens,
    strideTokens: next.strideTokens,
    // The RAISED cut covers more than `next.anchor` describes, so re-anchor it
    // against the current projection — otherwise the next turn would verify a
    // narrower span than the one it is about to carry.
    anchor: anchorFor(entries, imageCutTokens),
  };
}

// ─── elideProjection ──────────────────────────────────────────────────────────

/** Full text of one elided result, for the engine to spill to disk. */
export interface ElisionSpill {
  toolUseId: string;
  text: string;
  /** Path RELATIVE to workingDir — the same namespace the offload primitive uses. */
  path: string;
}

export interface ElisionOutcome {
  /** seq → the replacement entry. Entries absent from the map ride verbatim. */
  replacements: Map<number, JournalEntry>;
  /** Full bodies the caller should write to the offload dir (best-effort). */
  spills: ElisionSpill[];
  elidedResults: number;
  elidedImages: number;
  /** Estimated tokens removed from the wire by this elision. */
  freedTokens: number;
}

/** The deterministic spill path for a tool call — mirrors context-offload.ts. */
export function spillPathFor(taskId: string, toolUseId: string): string {
  return `.kernel-offload/${taskId}/${toolUseId}.txt`;
}

/** Describe an image block for its placeholder, using whatever self-description it carries. */
function describeImage(b: {
  mediaType?: string;
  filename?: string;
  sizeBytes?: number;
  url?: string;
}): string {
  const parts: string[] = [];
  if (b.filename) parts.push(b.filename);
  if (b.mediaType) parts.push(b.mediaType);
  if (typeof b.sizeBytes === 'number' && b.sizeBytes > 0) {
    parts.push(`${Math.round(b.sizeBytes / 1024)} KB`);
  }
  const what = parts.length > 0 ? parts.join(', ') : 'image';
  return b.url ? `${what} — ${b.url}` : what;
}

/**
 * Build the replacement map for one frozen cut. Pure; never throws.
 *
 * The result is a MAP KEYED BY `seq`, not a transformed array, so the engine can
 * compute it ONCE per user turn and apply it to every re-projection inside that
 * turn with a cheap lookup — which is also what guarantees the wire bytes are
 * identical across the many tool rounds of a single turn.
 */
export function elideProjection(
  entries: ReadonlyArray<JournalEntry>,
  cut: ElisionCut,
  opts: { taskId: string; policy?: ElisionPolicy },
): ElisionOutcome {
  const policy = opts.policy ?? DEFAULT_ELISION_POLICY;
  const out: ElisionOutcome = {
    replacements: new Map(),
    spills: [],
    elidedResults: 0,
    elidedImages: 0,
    freedTokens: 0,
  };
  if (cut.resultCutTokens <= 0 && cut.imageCutTokens <= 0) return out;

  // toolUseId → toolName, so a stub can name the tool it answered.
  const toolNames = new Map<string, string>();
  for (const e of entries) {
    const p = e.payload;
    if (p.type === 'tool_use') toolNames.set(p.toolUseId, p.name);
  }

  let running = 0;
  for (const e of entries) {
    const at = running;
    running += entryTokens(e);
    const p = e.payload;

    // ── tool_result bodies ──────────────────────────────────────────────────
    if (p.type === 'tool_result' && at < cut.resultCutTokens) {
      const blocks = p.blocks as Array<{ type: string; text?: string }>;
      if (isAlreadyStub(blocks)) continue;
      const size = bodyTokens(blocks);
      if (size > policy.minResultTokens) {
        let text = '';
        for (const b of blocks) if (b.type === 'text' && b.text) text += b.text;
        const path = spillPathFor(opts.taskId, p.toolUseId);
        const tool = toolNames.get(p.toolUseId);
        const stub =
          `${STUB_PREFIX} ${size.toLocaleString('en-US')} tokens of ` +
          `${tool ? `${tool} ` : ''}output. Full content: ${path} — ` +
          `use Read with that path (offset/limit to page) to re-read it]`;
        out.replacements.set(e.seq, {
          ...e,
          payload: { ...p, blocks: [{ type: 'text', text: stub }] },
        });
        out.spills.push({ toolUseId: p.toolUseId, text, path });
        out.elidedResults++;
        out.freedTokens += size - estimateTokens(stub);
        continue;
      }
      // Too small to stub — it may still carry an agedimage, handled below.
    }

    // ── image blocks ────────────────────────────────────────────────────────
    if (at >= cut.imageCutTokens) continue;
    if (
      p.type !== 'tool_result' &&
      p.type !== 'user' &&
      p.type !== 'assistant' &&
      p.type !== 'custom_message'
    ) {
      continue;
    }
    const blocks = p.blocks as Array<{ type: string; text?: string; [k: string]: unknown }>;
    if (!hasImage(blocks)) continue;
    let replacedHere = 0;
    const next = blocks.map((b) => {
      if (b.type !== 'image') return b;
      replacedHere++;
      return {
        type: 'text',
        text: `${STUB_PREFIX} image (${describeImage(b as never)}) — re-run the tool that produced it to see it again]`,
      };
    });
    out.replacements.set(e.seq, { ...e, payload: { ...p, blocks: next } as typeof p });
    out.elidedImages += replacedHere;
    out.freedTokens += replacedHere * IMAGE_TOKEN_ESTIMATE;
  }

  return out;
}

/**
 * Apply a frozen replacement map to a projection. Pure, O(n) with a Map lookup,
 * no token re-estimation — cheap enough to run on every re-projection inside a
 * turn, which is exactly what keeps the wire byte-stable across tool rounds.
 * Unchanged entries are returned by the SAME reference (no churn for callers).
 */
export function applyElision(
  entries: ReadonlyArray<JournalEntry>,
  replacements: ReadonlyMap<number, JournalEntry>,
): JournalEntry[] {
  if (replacements.size === 0) return entries as JournalEntry[];
  const out: JournalEntry[] = new Array(entries.length);
  for (let i = 0; i < entries.length; i++) {
    out[i] = replacements.get(entries[i].seq) ?? entries[i];
  }
  return out;
}
