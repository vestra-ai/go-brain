// nami brain v2 — §3a salience prefilter: the cheap "encode on surprise" gate
// that runs BEFORE we spend a judge call on an episode.
//
// A SalienceVector is the structural surprise signal read off a finished episode.
// Each field is a count (or 0/1 flag) of a surprise marker. CRITICAL: `null` means
// UNKNOWN (the signal was not measured), which is NOT the same as 0 (measured-absent).
// A null never adds to — and never subtracts from — the prefilter score.

export interface SalienceVector {
  toolHardError: number | null;
  silentFailure: number | null;
  turnFailed: number | null;
  userRedirected: number | null;
  userDeclined: number | null;
  hitlPauses: number | null;
  rewindOnTask: number | null;
  supersedes: number | null;
  userAbort: number | null;
  convoCorrection: number | null;
}

/**
 * Labels that ROUTE an episode to the judge categorically — a single occurrence
 * forces capture regardless of the numeric score (a user correction/redirect is
 * the highest-value thing to remember). Their routing is fully captured by the
 * forcing clause in `passesPrefilter`, so they carry weight 0 in the score sum to
 * avoid double-counting.
 */
export const FORCING_LABELS: (keyof SalienceVector)[] = [
  'userRedirected',
  'rewindOnTask',
  'supersedes',
  'convoCorrection',
];

/**
 * Per-signal weight in the prefilter sum. Provisional: Task 15 re-tunes these on
 * the §7 HUMAN labels. Forcing labels weigh 0 (see FORCING_LABELS); the remaining
 * structural-failure signals each weigh 1.
 */
export const DEFAULT_SALIENCE_WEIGHTS: Record<keyof SalienceVector, number> = {
  toolHardError: 1,
  silentFailure: 1,
  turnFailed: 1,
  userRedirected: 0,
  userDeclined: 1,
  hitlPauses: 1,
  rewindOnTask: 0,
  supersedes: 0,
  userAbort: 1,
  convoCorrection: 0,
};

/**
 * Prefilter threshold. Provisional `1.0`; Task 15 re-tunes it on the §7 HUMAN
 * labels (not on judge output).
 */
export const DEFAULT_THETA_REPLAY = 1.0;

/** Σ (v[k] ?? 0) * w[k]. null is treated as 0 (UNKNOWN, never a negative signal). */
export function prefilterScore(
  v: SalienceVector,
  w: Record<keyof SalienceVector, number> = DEFAULT_SALIENCE_WEIGHTS,
): number {
  let sum = 0;
  for (const key of Object.keys(w) as (keyof SalienceVector)[]) {
    sum += (v[key] ?? 0) * w[key];
  }
  return sum;
}

/** Routes to the judge when the score clears theta OR any forcing label fired. */
export function passesPrefilter(v: SalienceVector, theta: number = DEFAULT_THETA_REPLAY): boolean {
  return prefilterScore(v) >= theta || FORCING_LABELS.some((k) => (v[k] ?? 0) > 0);
}
