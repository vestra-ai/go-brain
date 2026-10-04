import { describe, it, expect } from 'vitest';
import { transition, LEGAL_TRANSITIONS, TransitionError, type SessionPhase, type SessionState } from '../run-state.js';

const s = (phase: string, extra = {}): SessionState => ({ phase, ...extra } as SessionState);

describe('SessionState machine', () => {
  it('allows the happy path idle→starting→streaming→finalizing→idle', () => {
    let st = s('idle');
    for (const next of ['starting', 'streaming', 'finalizing', 'idle'] as const) {
      st = transition(st, s(next));
      expect(st.phase).toBe(next);
    }
  });
  it('allows streaming→awaiting_human→streaming (HITL) and streaming→compacting→streaming', () => {
    expect(transition(s('streaming'), s('awaiting_human', { interactionId: 'i1' })).phase).toBe('awaiting_human');
    expect(transition(s('awaiting_human', { interactionId: 'i1' }), s('streaming')).phase).toBe('streaming');
    expect(transition(s('streaming'), s('compacting')).phase).toBe('compacting');
  });
  it('cancelling is reachable from every active phase (P3 contract)', () => {
    for (const from of ['starting', 'streaming', 'awaiting_human', 'compacting', 'finalizing'] as const) {
      expect(LEGAL_TRANSITIONS[from]).toContain('cancelling');
    }
  });
  it('throws TransitionError on illegal transitions', () => {
    expect(() => transition(s('idle'), s('finalizing'))).toThrow(/illegal transition/i);
    expect(() => transition(s('done'), s('streaming'))).toThrow(/illegal transition/i);
  });

  // PR-1288 review finding 2 — table-driven totality: EVERY (from, to) pair not
  // in LEGAL_TRANSITIONS must throw, including self-loops (streaming→streaming)
  // and near-misses (finalizing→streaming, cancelling→streaming).
  it('throws on every (from, to) pair absent from LEGAL_TRANSITIONS (exhaustive)', () => {
    const mk = (phase: SessionPhase): SessionState => {
      if (phase === 'awaiting_human') return { phase, interactionId: 'i1' };
      if (phase === 'cancelling') return { phase, from: 'streaming' };
      return { phase } as SessionState;
    };
    const phases = Object.keys(LEGAL_TRANSITIONS) as SessionPhase[];
    let illegalPairs = 0;
    for (const from of phases) {
      for (const to of phases) {
        if (LEGAL_TRANSITIONS[from].includes(to)) {
          expect(transition(mk(from), mk(to)).phase, `${from} → ${to} should be legal`).toBe(to);
        } else {
          illegalPairs++;
          expect(() => transition(mk(from), mk(to)), `${from} → ${to} should throw`).toThrow(TransitionError);
        }
      }
    }
    // Sanity: the table is genuinely sparse — most of the 64 pairs are illegal.
    expect(illegalPairs).toBeGreaterThan(phases.length * phases.length / 2);
  });
});
