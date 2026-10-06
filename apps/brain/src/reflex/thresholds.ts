/**
 * Every bar the reflex uses, in one place. They start from Bash's measured bars
 * (apps/server/src/services/jev/thresholds.ts) and are swept on Go's own test sets (Task 5 and 16)
 * before a question acts live. A bar measured on a noul never carries to a Choice.
 */
export const BARS = {
  /** Q1. Bash moment-vs-work: moment 0.9 with work at most 0.1 (149-row corpus, 0 wrong). */
  for_go: { chatterMin: 0.9, addressedMaxForChatter: 0.2, addressedMin: 0.9, chatterMaxForAddressed: 0.1 },
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
};
export type Bars = typeof BARS;
