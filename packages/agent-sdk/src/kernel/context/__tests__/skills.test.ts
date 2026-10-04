import { describe, it, expect } from 'vitest';
import * as skills from '../skills.js';
import type { Episode } from '../skills.js';

// Brain v2 Slice 1 deleted the frequency-ranked lexical clusterer (the disease):
// `detectSkillCandidates` + `jaccard` + the `SkillCandidate`/`DetectOptions`/
// `SkillCompiler` seam. This guards that the detector stays deleted and that the
// surviving `Episode` record type still imports for the capture/encode path.
describe('skills module (Slice 1 — detector deleted)', () => {
  it('no longer exports the frequency-ranked skill detector', () => {
    expect((skills as Record<string, unknown>).detectSkillCandidates).toBeUndefined();
  });

  it('still exposes the Episode record type used by capture + encode', () => {
    const ep: Episode = { id: 'e1', text: 'did the thing', appendedAt: '2026-06-24T10:00:00.000Z' };
    expect(ep.id).toBe('e1');
  });
});
