import { describe, it, expect } from 'vitest';
import { mergeClaim, compileHotCore, isActive, type Claim, type RawClaim } from '../claims.js';

const src = (ref: string, date = '2026-06-01'): RawClaim['source'] => ({ kind: 'task', ref, date });
const raw = (subject: string, predicate: string, object: string, ref = 'r1'): RawClaim => ({
  subject,
  predicate,
  object,
  source: src(ref),
});

describe('mergeClaim (open taxonomy, bi-temporal)', () => {
  it('adds a new claim into an empty ledger', () => {
    const r = mergeClaim([], raw('Priya', 'works at', 'Acme'), '2026-06-01', 'c1');
    expect(r.added).toBe(true);
    expect(r.claims).toHaveLength(1);
    expect(isActive(r.claims[0])).toBe(true);
    expect(r.claims[0]).toMatchObject({ subject: 'Priya', predicate: 'works at', object: 'Acme' });
  });

  it('reinforces (not adds) on an exact (subject,predicate,object) repeat — adds source, bumps confidence', () => {
    const first = mergeClaim([], { ...raw('Priya', 'works at', 'Acme'), confidence: 0.7 }, '2026-06-01', 'c1').claims;
    const r = mergeClaim(first, { ...raw('priya', 'WORKS AT', 'acme', 'r2'), confidence: 0.7 }, '2026-06-02', 'c2');
    expect(r.added).toBe(false);
    expect(r.reinforced).toBe('c1');
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0].sources).toHaveLength(2);
    expect(r.claims[0].confidence).toBeGreaterThan(0.7);
  });

  it('supersedes the old claim when the object changes for the same (subject,predicate) — invalidate, never delete', () => {
    const first = mergeClaim([], raw('Priya', 'deal status', 'in procurement'), '2026-05-11', 'c1').claims;
    const r = mergeClaim(first, raw('Priya', 'deal status', 'signed', 'r2'), '2026-05-13', 'c2');
    expect(r.added).toBe(true);
    expect(r.superseded).toBe('c1');
    expect(r.claims).toHaveLength(2); // old kept, not deleted
    const old = r.claims.find((c) => c.id === 'c1')!;
    expect(old.validTo).toBe('2026-05-13');
    expect(old.supersededBy).toBe('c2');
    expect(isActive(old)).toBe(false);
    const cur = r.claims.find((c) => c.id === 'c2')!;
    expect(cur.object).toBe('signed');
    expect(isActive(cur)).toBe(true);
  });

  it('treats predicate as OPEN vocabulary — an arbitrary relation is a first-class claim', () => {
    const r = mergeClaim([], raw('The user', 'gets anxious about', 'meetings over 30 minutes'), '2026-06-01', 'c1');
    expect(r.added).toBe(true);
    expect(r.claims[0].predicate).toBe('gets anxious about');
  });
});

describe('mergeClaim — semantic-key dedup (§G: canonical entity+predicate identity)', () => {
  it('semantic-key dedup: reworded subject+predicate folds into one active claim', () => {
    const now = '2026-06-29T00:00:00Z';
    const first = mergeClaim([], raw('the user', 'works at', 'Acme'), now, 'c1').claims;
    // a later dream rewords the SAME fact (subject + predicate both reworded)
    const r = mergeClaim(first, raw('user', 'employed by', 'Acme', 'r2'), now, 'c2');
    const active = r.claims.filter(isActive);
    expect(active).toHaveLength(1); // folded, not duplicated
    expect(r.added).toBe(false); // reinforced, not added
    expect(r.reinforced).toBe('c1');
  });

  it('semantic-key supersede: same key, changed object retires the old', () => {
    const now = '2026-06-29T00:00:00Z';
    const first = mergeClaim([], raw('project Atlas', 'deadline is', 'March 1'), now, 'c1').claims;
    const r = mergeClaim(first, raw('Atlas', 'has deadline', 'March 15', 'r2'), now, 'c2');
    const active = r.claims.filter(isActive);
    expect(active).toHaveLength(1);
    expect(active[0].object).toBe('March 15');
    expect(r.claims.find((c) => c.object === 'March 1')?.supersededBy).toBeTruthy();
  });
});

describe('§3d quarantine on apply (single-episode high-novelty guard)', () => {
  it('quarantines a first-sighting high-novelty non-correction user-fact', () => {
    const r = mergeClaim(
      [],
      { ...raw('Priya', 'is cofounder of', 'Acme'), claimType: 'user-fact', noveltyToFrontier: 0.9 },
      '2026-06-01',
      'c1',
    );
    expect(r.added).toBe(true);
    expect(r.claims[0].quarantined).toBe(true);
  });

  it('a correction enters directly (quarantined false) even when high-novelty', () => {
    const r = mergeClaim(
      [],
      { ...raw('Priya', 'role', 'CTO'), claimType: 'correction', noveltyToFrontier: 0.95 },
      '2026-06-01',
      'c1',
    );
    expect(r.added).toBe(true);
    expect(r.claims[0].quarantined).toBe(false);
  });

  it('a second corroborating episode (different source ref) clears the quarantine', () => {
    const first = mergeClaim(
      [],
      { ...raw('Priya', 'is cofounder of', 'Acme', 'task-1'), claimType: 'user-fact', noveltyToFrontier: 0.9 },
      '2026-06-01',
      'c1',
    ).claims;
    expect(first[0].quarantined).toBe(true);
    // a second, independent episode (different sourceTaskId/ref) sees the same fact
    const r = mergeClaim(
      first,
      { ...raw('Priya', 'is cofounder of', 'Acme', 'task-2'), claimType: 'user-fact', noveltyToFrontier: 0.9 },
      '2026-06-02',
      'c2',
    );
    expect(r.reinforced).toBe('c1');
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0].sources).toHaveLength(2);
    expect(r.claims[0].quarantined).toBe(false);
  });

  it('does NOT clear quarantine when reinforced by the SAME source ref (not corroboration)', () => {
    const first = mergeClaim(
      [],
      { ...raw('Priya', 'is cofounder of', 'Acme', 'task-1'), claimType: 'user-fact', noveltyToFrontier: 0.9 },
      '2026-06-01',
      'c1',
    ).claims;
    const r = mergeClaim(
      first,
      { ...raw('Priya', 'is cofounder of', 'Acme', 'task-1'), claimType: 'user-fact', noveltyToFrontier: 0.9 },
      '2026-06-02',
      'c2',
    );
    expect(r.reinforced).toBe('c1');
    expect(r.claims[0].sources).toHaveLength(1); // same ref+date deduped
    expect(r.claims[0].quarantined).toBe(true); // still single-episode
  });

  it('byte-identical flag-OFF: a no-signal claim reinforced by a 2nd distinct ref has quarantined UNSET', () => {
    // No claimType, no noveltyToFrontier — this is a v1 / flag-OFF claim.
    // The §3d corroboration path must NOT introduce a quarantined:false field because the
    // ADD path never set it; the ledger must stay byte-identical under flag-OFF.
    const first = mergeClaim([], raw('Priya', 'works at', 'Acme', 'task-1'), '2026-06-01', 'c1').claims;
    expect(Object.prototype.hasOwnProperty.call(first[0], 'quarantined')).toBe(false);
    const r = mergeClaim(first, raw('Priya', 'works at', 'Acme', 'task-2'), '2026-06-02', 'c2');
    expect(r.reinforced).toBe('c1');
    expect(r.claims[0].sources).toHaveLength(2); // two distinct refs → corroborated
    expect(Object.prototype.hasOwnProperty.call(r.claims[0], 'quarantined')).toBe(false); // field stays absent
    expect(r.claims[0].quarantined).toBeUndefined();
  });

  it('a low-novelty claim is not quarantined', () => {
    const r = mergeClaim(
      [],
      { ...raw('Paris', 'is capital of', 'France'), claimType: 'user-fact', noveltyToFrontier: 0.2 },
      '2026-06-01',
      'c1',
    );
    expect(r.claims[0].quarantined).toBe(false);
  });

  it('a claim with no novelty signal stays back-compatible (quarantined unset)', () => {
    const r = mergeClaim([], raw('Priya', 'works at', 'Acme'), '2026-06-01', 'c1');
    expect(r.claims[0].quarantined).toBeUndefined();
  });
});

describe('§3a/§3c schema completions on merge', () => {
  it('persists noveltyToFrontier onto the merged Claim (later recall scoring signal)', () => {
    const r = mergeClaim(
      [],
      { ...raw('Priya', 'is cofounder of', 'Acme'), noveltyToFrontier: 0.83 },
      '2026-06-01',
      'c1',
    );
    expect(r.claims[0].noveltyToFrontier).toBe(0.83);
  });

  it('accepts a free-form claimType (open vocabulary, no fixed list)', () => {
    const r = mergeClaim(
      [],
      { ...raw('Chapter 3', 'belongs to', 'the manuscript'), claimType: 'manuscript' },
      '2026-06-01',
      'c1',
    );
    expect(r.claims[0].claimType).toBe('manuscript');
  });
});

describe('compileHotCore', () => {
  const build = (): Claim[] => {
    let claims: Claim[] = [];
    claims = mergeClaim(claims, raw('Priya', 'role', 'procurement lead'), '2026-02-13', 'c1').claims;
    claims = mergeClaim(claims, raw('Priya', 'role', 'contract approver', 'r2'), '2026-05-13', 'c2').claims; // supersedes c1
    claims = mergeClaim(claims, raw('The user', 'prefers', 'TypeScript'), '2026-06-01', 'c3').claims;
    return claims;
  };

  it('renders only ACTIVE claims, grouped by emergent entity, deterministically', () => {
    const out = compileHotCore(build());
    expect(out).toBe(
      ['## Priya', '- role: contract approver', '', '## The user', '- prefers: TypeScript'].join('\n'),
    );
    expect(out).not.toContain('procurement lead'); // superseded, excluded from the compiled truth
  });

  it('returns empty string when there are no active claims', () => {
    expect(compileHotCore([])).toBe('');
  });
});

// ─── P2-M3: open-loop fields ride the merge ─────────────────────────────────

describe('P2-M3 open-loop fields (dueAt/recurrence)', () => {
  it('mergeClaim carries dueAt + recurrence from the raw onto the new claim (unset stays unset)', () => {
    const now = '2026-07-03T00:00:00.000Z';
    const withLoop = mergeClaim([], {
      subject: 'the user', predicate: 'owes Sasha', object: 'the board deck',
      source: { kind: 'task', ref: 't1', date: now },
      claimType: 'commitment', dueAt: '2026-07-10T00:00:00.000Z',
    }, now, 'clm_loop').claims[0];
    expect(withLoop.dueAt).toBe('2026-07-10T00:00:00.000Z');
    expect(withLoop.recurrence).toBeUndefined();

    const without = mergeClaim([], {
      subject: 's', predicate: 'p', object: 'o',
      source: { kind: 'task', ref: 't1', date: now },
    }, now, 'clm_plain').claims[0];
    expect('dueAt' in without).toBe(false);
    expect('recurrence' in without).toBe(false);
  });

  it('exact-match reinforce carries a NEWLY-stated dueAt/recurrence onto the existing claim (review F3)', () => {
    const now = '2026-07-03T00:00:00.000Z';
    const first = mergeClaim([], {
      subject: 'the user', predicate: 'owes Sasha', object: 'the board deck',
      source: { kind: 'task', ref: 't1', date: now }, claimType: 'commitment',
    }, now, 'clm_1').claims;
    expect(first[0].dueAt).toBeUndefined();

    // Verbatim re-statement, now WITH a deadline: the reinforce must not drop it.
    const later = '2026-07-04T00:00:00.000Z';
    const r = mergeClaim(first, {
      subject: 'the user', predicate: 'owes Sasha', object: 'the board deck',
      source: { kind: 'task', ref: 't2', date: later }, claimType: 'commitment',
      dueAt: '2026-07-10T00:00:00.000Z',
    }, later, 'clm_2');
    expect(r.reinforced).toBe('clm_1');
    expect(r.claims[0].dueAt).toBe('2026-07-10T00:00:00.000Z');
  });
});
