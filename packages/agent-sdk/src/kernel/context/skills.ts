// nami episode-log record. The frequency-ranked lexical clusterer that turned
// episodes into procedural skill candidates (the `detectSkillCandidates` detector +
// its `SkillCompiler` seam) was DELETED in Brain v2 Slice 1: surprise/novelty, not
// recurrence-frequency, is the encode signal, and procedural skills are deferred to
// the Later skills slice (roadmap). What remains here is the pure `Episode` type —
// the record the CAPTURE path appends to `.nami/episodes.jsonl` and the dream's
// ENCODE pass reads back. Open-taxonomy: an episode is free text, no fixed categories.

export interface Episode {
  id: string;
  text: string;
  outcome?: 'success' | 'failure';
  /**
   * ISO timestamp the episode was appended to the log (the dream's since-cursor
   * gate keys off this). OPTIONAL so legacy episodes written before the field
   * existed still parse — a legacy episode with no `appendedAt` is treated as
   * NEW (cannot prove it predates the cursor), bounded by the per-pass cap.
   * Mirrors the `sourceClaimIds`-optional precedent for forward-compatible parse.
   */
  appendedAt?: string;
  /** P1: provenance tag ('task_firsthand', later app_gmail, corpus_obsidian, ...). */
  source?: string;
  /** P1: identity | relationship | commitment | preference | project_state | correction | other. */
  epistemic?: string;
}
