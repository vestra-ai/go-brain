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
   * is sure no one spoke to Go in is not for Go either, chatter or not (a fact, a plan, friends asking each other); a line
   * about money always wakes. 0.25 on two live runs' Jev answers (the definitive run 37488230324 and #127's run
   * 37572657366): every line 0.25 skips that 0.1 woke is labelled not for Go, and the nearest line Go may answer reads 0.28
   * and 0.30 ("6:30 se pehle wali flight mat dekhna yaar"). On Go's set the lowest answer on a line labelled for Go that
   * does not name it is 0.61. The other three are Bash's.
   *
   * planMin: a line in which no one spoke to Go still wakes it when question 6 reads it as a question to the group about
   * the plan or as agreeing to one, at least this sure (Keshav, 2026-10-08: "go should be proactive bro, whenever it can intervene
   * it should"). On the same two live runs, the plan questions the "not spoken to Go" bar dropped read 0.72 to 0.85
   * ("who's bringing the speaker?" 0.72, "scooty rent karenge na?" 0.78 and 0.85, "Birthday dinner on the 7th somewhere
   * nice? Not a shack pls" 0.85) and the agreements 0.71 to 0.93 ("+1 pool" 0.82, "agreed, pool villa it is" 0.93); "anyone up?" (0.60, 0.63) and
   * "manager approved 🙏" (0.60) stay below. Chatter is read first, so "Finallyyyy 😭🙌" (agreed 0.71, chatter 0.93) stays quiet.
   */
  for_go: { chatterMin: 0.85, addressedMaxForChatter: 0.2, notAddressedMax: 0.25, addressedMin: 0.9, chatterMaxForAddressed: 0.1, planMin: 0.7 },
  /**
   * Q2, for a line that names Go only (read.ts readComplete). Answering mid-thought is visible; unsure only costs the 2 s
   * wait. On Go's set (Jev 1.13.0, two recordings on 2026-10-07) lines to Go cut short read 0.04 to 0.41 and whole asks
   * 0.52 to 0.74: 0.4 makes wrong answers ("Go suno"), 0.5 none.
   */
  complete: { namedMin: 0.5, noMax: 0.1 },
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
   * Q10, a Choice. Bash's Mac recipe pick is the winner at least 0.6 and every other option below 0.3 (recipe-reader.ts
   * RECIPE_BARS.recipe, RECIPE_RIVAL_BAR). On Go's set (Jev 1.13.0, two recordings on 2026-10-07) one search ask is read
   * as the wrong kind, "sleeper availability Mumbai to Goa" as buses, at 0.76 and 0.81: every bar up to 0.8 makes a wrong
   * pick on at least one recording, and 0.85 clears it by 0.04. 0.9 leaves room for answers moving by up to 0.10 between
   * runs (recall 0.91 and 0.90, no wrong pick on either). Recorded again on 2026-10-10 with question 10's twelve choices
   * beyond the searches (17 options with none): no wrong pick on two runs at these bars, live recall 0.87 and search
   * recall 0.94, and a whole Jev call still 134 ms at the middle and 161 ms at p90.
   */
  recipe: { pickMin: 0.9, rivalMax: 0.3 },
};
export type Bars = typeof BARS;
