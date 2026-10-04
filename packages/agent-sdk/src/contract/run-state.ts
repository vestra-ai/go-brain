/**
 * P1 — the per-task session lifecycle, promoted from comments+fences to a type.
 * Exhaustive by construction: LEGAL_TRANSITIONS is Record<SessionPhase, …> —
 * adding a phase without classifying its edges is a COMPILE ERROR (the
 * CONTEXT_POLICY device, contract/journal.ts:160).
 */
export type SessionState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'streaming'; anticipating?: boolean }
  | { phase: 'awaiting_human'; interactionId: string }
  | { phase: 'compacting' }
  | { phase: 'finalizing' }
  | { phase: 'cancelling'; from: SessionPhase }
  | { phase: 'done' };

export type SessionPhase = SessionState['phase'];

export const LEGAL_TRANSITIONS: Record<SessionPhase, readonly SessionPhase[]> = {
  idle: ['starting', 'done'],
  starting: ['streaming', 'cancelling', 'finalizing'],
  streaming: ['awaiting_human', 'compacting', 'finalizing', 'cancelling'],
  awaiting_human: ['streaming', 'finalizing', 'cancelling'],
  compacting: ['streaming', 'finalizing', 'cancelling'],
  finalizing: ['idle', 'done', 'cancelling'],
  cancelling: ['finalizing'],
  done: [],
};

export class TransitionError extends Error {}

export function transition(from: SessionState, to: SessionState): SessionState {
  if (!LEGAL_TRANSITIONS[from.phase].includes(to.phase)) {
    throw new TransitionError(`illegal transition ${from.phase} → ${to.phase}`);
  }
  return to;
}
