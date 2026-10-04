import { describe, it, expect } from 'vitest';
import { applyRawClaims, applyRawClaimsAsync, defaultIdGen, type ContradictionDetector } from '../curator.js';
import { isActive, type RawClaim } from '../claims.js';

const raw = (subject: string, predicate: string, object: string): RawClaim => ({
  subject,
  predicate,
  object,
  source: { kind: 'task', ref: 'demo', date: '2026-06-01' },
});

// A fake detector standing in for the Haiku step: retires any candidate whose
// predicate looks employment-related — i.e. it understands "works at" and
// "current employer" are the SAME relation despite different wording.
const employmentDetector: ContradictionDetector = {
  async detect({ candidates }) {
    return candidates.filter((c) => /works at|employer|employed/i.test(c.predicate)).map((c) => c.id);
  },
};

describe('cross-predicate contradiction detection (the demo bug, fixed)', () => {
  it('supersedes a stale claim phrased with a DIFFERENT predicate', async () => {
    const start = applyRawClaims([], [raw('user', 'works at', 'Acme')], '2026-06-01', defaultIdGen('2026-06-01')).claims;
    const r = await applyRawClaimsAsync(
      start,
      [raw('user', 'current employer', 'Vestra')],
      '2026-06-02',
      defaultIdGen('2026-06-02'),
      employmentDetector,
    );
    const acme = r.claims.find((c) => c.object === 'Acme')!;
    expect(isActive(acme)).toBe(false); // retired despite "works at" ≠ "current employer"
    expect(acme.supersededBy).not.toBeNull();
    expect(r.hotCore).toContain('Vestra');
    expect(r.hotCore).not.toContain('Acme'); // stale fact no longer in the compiled truth
    expect(r.stats.superseded).toBeGreaterThanOrEqual(1);
  });

  it('WITHOUT a detector, the cross-predicate stale claim lingers (the v0 behavior the demo exposed)', async () => {
    const start = applyRawClaims([], [raw('user', 'works at', 'Acme')], '2026-06-01', defaultIdGen('2026-06-01')).claims;
    const r = await applyRawClaimsAsync(start, [raw('user', 'current employer', 'Vestra')], '2026-06-02', defaultIdGen('2026-06-02'));
    expect(r.hotCore).toContain('Vestra');
    expect(r.hotCore).toContain('Acme'); // lingers — exactly why the detector is needed
  });

  it('a detector failure degrades safe (deterministic result, ledger intact)', async () => {
    const start = applyRawClaims([], [raw('user', 'works at', 'Acme')], '2026-06-01', defaultIdGen('2026-06-01')).claims;
    const boom: ContradictionDetector = { async detect() { throw new Error('detector down'); } };
    const r = await applyRawClaimsAsync(start, [raw('user', 'current employer', 'Vestra')], '2026-06-02', defaultIdGen('2026-06-02'), boom);
    expect(r.hotCore).toContain('Acme'); // not retired (detector failed), but nothing corrupted
    expect(r.hotCore).toContain('Vestra');
    expect(r.claims.filter(isActive).length).toBe(2);
  });

  it('the detector can only retire subject-scoped candidates (cannot retire arbitrary claims)', async () => {
    let claims = applyRawClaims([], [raw('user', 'works at', 'Acme')], '2026-06-01', defaultIdGen('2026-06-01')).claims;
    claims = applyRawClaims(claims, [raw('CompanyX', 'status', 'active')], '2026-06-01', defaultIdGen('x')).claims;
    // a rogue detector tries to retire EVERY claim id
    const rogue: ContradictionDetector = { async detect({ candidates }) { return candidates.map((c) => c.id); } };
    const r = await applyRawClaimsAsync(claims, [raw('user', 'current employer', 'Vestra')], '2026-06-02', defaultIdGen('2026-06-02'), rogue);
    // CompanyX is a different subject → never a candidate → still active
    expect(r.claims.find((c) => c.subject === 'CompanyX')!).toMatchObject({ validTo: null });
    expect(isActive(r.claims.find((c) => c.subject === 'CompanyX')!)).toBe(true);
  });
});
