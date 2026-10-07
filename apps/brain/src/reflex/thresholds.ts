/**
 * Every bar the reflex uses, in one place. They start from Bash's measured bars
 * (apps/server/src/services/jev/thresholds.ts) and are swept on Go's own test sets (Task 5 and 16)
 * before a question acts live. A bar measured on a noul never carries to a Choice.
 */
export const BARS = {
  /**
   * Q1. Bash moment-vs-work: moment 0.9 with work at most 0.1 (149-row corpus, 0 wrong). Chatter is 0.85 on Go's own set
   * (Jev 1.13.0, recorded 2026-10-06: recall 0.77, 0 wrong of 13). 0.8 also had no wrong answer, but an ask read as chatter
   * goes unanswered while a needless wake costs one model call, so the bar keeps the margin. notAddressedMax: a line Jev
   * is sure no one spoke to Go in is not for Go either, chatter or not (a fact, a plan); on the same recordings it skips
   * 18 of 50 lines (a line about money always wakes) and none labelled for Go, whose lowest answer was 0.57. The other
   * three are Bash's.
   */
  for_go: { chatterMin: 0.85, addressedMaxForChatter: 0.2, notAddressedMax: 0.1, addressedMin: 0.9, chatterMaxForAddressed: 0.1 },
  /** Q2. Answering mid-thought is visible; unsure only costs the 2 s wait. */
  complete: { yesMin: 0.85, noMax: 0.1 },
  /** Q3. Bash moment-vs-work: work 0.9 with every moment noul at most 0.1. */
  size: { kindMin: 0.9, otherMax: 0.1 },
  /** Q4. Bash task pick: pick 0.85, own noul 0.4, lead over the loudest other 0.25. */
  task: { pickMin: 0.85, ownMin: 0.4, gapMin: 0.25, noneMin: 0.85, noneOwnMax: 0.1 },
  /** Q5. Starting point 0.8 (Bash closed parameters); a wrong flag costs one side call, never a wrong fact. */
  fact: { yesMin: 0.8, noMax: 0.1 },
  /** Q6. Exactly one kind clears; the code checker still decides the line. */
  record: { kindMin: 0.8, otherMax: 0.3, noneMax: 0.1 },
  /** Q7. A reaction is visible: Bash's "acted on" bar, 0.9 with a 0.3 margin. */
  reaction: { pickMin: 0.9, marginMin: 0.3 },
  /** Q8. Raise-only. Bash browser lane riskMin 0.5 (35 of 36 caught, 0 of 11 false alarms). */
  risky: { raiseAt: 0.5 },
  /** Q9. Nominates a wake only; the composer decides. */
  opening: { yesMin: 0.9, noMax: 0.1 },
  /**
   * Q10, a Choice. Bash's Mac recipe pick (recipe-reader.ts RECIPE_BARS.recipe, RECIPE_RIVAL_BAR): the winner at least 0.6
   * and every other option below 0.3. A wrong pick costs one ixigo page load; none stops a search the parser would start.
   */
  recipe: { pickMin: 0.6, rivalMax: 0.3 },
};
export type Bars = typeof BARS;
