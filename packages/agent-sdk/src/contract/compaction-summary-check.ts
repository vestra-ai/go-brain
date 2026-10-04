/**
 * A DETERMINISTIC check on a compaction summary's "Latest request" section.
 *
 * WHY THIS EXISTS. The compaction-eval's model judge is a containment test — "does this
 * document contain enough information to answer?" — and the D2 drill's own summary passes
 * it: the instruction sits under "## Latest request" while the Goal section still
 * describes the real task, so a judge reading the whole document answers YES. The failure
 * that shipped is therefore invisible to the thing built to catch it (the adversary's
 * "answered, not fixed").
 *
 * So this reads the SECTION, not the document. Section 1 is the one the resuming model
 * treats as its objective, and the whole T9c prompt change is about what may appear
 * there. Two questions, both byte-exact and both cheap:
 *
 *   · does it name the user's actual ask (a distinctive token the caller supplies)?
 *   · is it free of the summarizer's own instruction?
 *
 * It lives beside {@link COMPACTION_SYSTEM} because it checks that prompt's own output
 * contract, and here rather than in `scripts/compaction-eval` because this package is
 * what CI runs: a checker whose pins never execute is not a gate.
 *
 * WHAT IT CANNOT SEE, stated so nobody reads a pass as proof: a FLUENT misattribution.
 * A summary that writes "the user asked me to summarize the conversation so far" under
 * section 1 names none of the forbidden tokens and may still contain the ask's token
 * elsewhere in the section. Only a verbatim-ish quote trips this. It is a floor, not a
 * proof, and the staging drill remains the real evidence.
 */

/**
 * The optional markup a section label can be wearing at the start of its line: an ATX
 * hash run, a bold opener, a `1.`/`1)` ordinal, in any combination. Models render the
 * schema's numbered list every one of these ways, and a checker that recognises only
 * some of them FAILS correct summaries — which is worse than useless, because it trains
 * everyone to ignore the gate.
 */
const LABEL_PREFIX = String.raw`[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*[ \t]*)?(?:\d+[.)][ \t]*)?`;

/** What may sit between a label and its content: bold close, colon, dash. */
const LABEL_SUFFIX = String.raw`[ \t]*(?:\*\*)?[ \t]*:?[ \t]*(?:\*\*)?[ \t]*[—–-]?[ \t]*`;

/**
 * Section 1's label, in any of the forms above. TWO spellings, deliberately: the schema
 * now asks for "Open request" (a state, not an act of asking — 2026-09-02 finding 7), and
 * every summary written before that carries "Latest request". Journals outlive prompt
 * changes, and the eval's recorded D2 summary is one of them; a checker that recognised
 * only the new label would fail the very record it exists to fail on the right grounds.
 */
const SECTION_ONE_LABELS = ['Open request', 'Latest request'] as const;
const LATEST_REQUEST_HEADING = new RegExp(
  `^${LABEL_PREFIX}(?:${SECTION_ONE_LABELS.join('|')})\\b${LABEL_SUFFIX}`,
  'im',
);

/**
 * The schema's OWN section names ({@link COMPACTION_SYSTEM}). The terminator is built
 * from these rather than from "anything that looks like a heading", and that is the
 * fix for a real false-fail: a summary that spells the ask out as numbered steps, or
 * opens with a bold lead-in, was being cut off at its first list item — taking the ask
 * token with it and reading as a mis-attributed section when the summary was correct.
 */
const SECTION_LABELS = [
  ...SECTION_ONE_LABELS,
  'Goal and intent',
  'What happened',
  'Decisions and open questions',
  'Next step',
  'Files and code',
  'Errors and fixes',
  'Environment and state',
];

/**
 * Where section 1 ends: the next SCHEMA section in any form, or any ATX heading (which
 * a summary only uses for headings), or EOF. A numbered list item or a bold run that is
 * not one of the schema's labels is section CONTENT and keeps its place.
 */
const NEXT_SECTION = new RegExp(
  `^(?:${LABEL_PREFIX}(?:${SECTION_LABELS.join('|')})\\b|[ \\t]*#{1,6}[ \\t])`,
  'im',
);

/**
 * The summarizer's own instruction, in the forms it has actually been seen wearing.
 * Matched case-insensitively as substrings of the SECTION only — a summary is free to
 * mention any of this elsewhere (the "What happened" section legitimately might).
 */
export const LATEST_REQUEST_FORBIDDEN: readonly string[] = [
  'structured summary',
  'section format',
  'output only the summary',
  'system directive',
  'instruction that follows',
  'summarize the conversation',
];

/**
 * The text of section 1, or `null` when the summary has no such section.
 *
 * The LABEL is consumed, not the whole heading LINE: the schema's own numbered form puts
 * the content on the same line (`1. Latest request — read the routes`), so eating the
 * line would return an empty section and every check over it would pass vacuously.
 */
export function latestRequestSection(summary: string): string | null {
  const m = LATEST_REQUEST_HEADING.exec(summary);
  if (!m) return null;
  const after = summary.slice(m.index + m[0].length);
  const next = NEXT_SECTION.exec(after);
  return (next ? after.slice(0, next.index) : after).trim();
}

export interface LatestRequestVerdict {
  ok: boolean;
  /** Empty when `ok`. One line per failed condition, naming what and why. */
  reasons: string[];
  /** The extracted section, for a report to quote. `null` when none was found. */
  section: string | null;
}

/**
 * Check section 1 against the ask it should be carrying.
 *
 * `mustContain` is OR, not AND: any one distinctive token of the real ask is enough (a
 * summary is free to paraphrase around it). The forbidden set is AND — every one of them
 * must be absent.
 */
export function checkLatestRequest(
  summary: string,
  opts: { mustContain: readonly string[]; forbidden?: readonly string[] },
): LatestRequestVerdict {
  const section = latestRequestSection(summary);
  if (section === null) {
    return { ok: false, reasons: ['no "Open request" (or legacy "Latest request") section found in the summary'], section: null };
  }
  const lower = section.toLowerCase();
  const reasons: string[] = [];

  if (opts.mustContain.length > 0 && !opts.mustContain.some((t) => lower.includes(t.toLowerCase()))) {
    reasons.push(
      `section names none of the ask's tokens: ${opts.mustContain.map((t) => JSON.stringify(t)).join(', ')}`,
    );
  }
  for (const phrase of opts.forbidden ?? LATEST_REQUEST_FORBIDDEN) {
    if (lower.includes(phrase.toLowerCase())) {
      reasons.push(`section carries the summarizer's own instruction: ${JSON.stringify(phrase)}`);
    }
  }
  return { ok: reasons.length === 0, reasons, section };
}
