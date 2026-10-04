import { describe, it, expect } from 'vitest';
import { passesPrefilter, prefilterScore, type SalienceVector } from '../salience.js';

const NONE: SalienceVector = {
  toolHardError: null,
  silentFailure: null,
  turnFailed: null,
  userRedirected: null,
  userDeclined: null,
  hitlPauses: null,
  rewindOnTask: null,
  supersedes: null,
  userAbort: null,
  convoCorrection: null,
};

describe('prefilter', () => {
  it('habituates a zero-salience episode', () => {
    expect(passesPrefilter(NONE)).toBe(false);
  });
  it('forces to judge on a free-text correction even with no score', () => {
    expect(passesPrefilter({ ...NONE, convoCorrection: 1 })).toBe(true);
  });
  it('forces on user redirect regardless of score', () => {
    expect(passesPrefilter({ ...NONE, userRedirected: 1 })).toBe(true);
  });
  it('treats null as UNKNOWN (0 contribution), never as a negative signal', () => {
    expect(prefilterScore({ ...NONE, toolHardError: 2 })).toBeGreaterThan(0);
  });
  it('routes a hard-error episode whose score clears theta', () => {
    expect(passesPrefilter({ ...NONE, toolHardError: 2 })).toBe(true);
  });
});
