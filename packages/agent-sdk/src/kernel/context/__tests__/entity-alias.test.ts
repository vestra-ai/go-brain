import { describe, it, expect } from 'vitest';
import { applyAliasMap } from '../curator.js';
import type { Claim } from '../claims.js';

const claim = (id: string, subject: string, predicate: string, object: string): Claim => ({
  id,
  subject,
  predicate,
  object,
  sources: [{ kind: 'task', ref: id, date: '2026-06-01' }],
  validFrom: '2026-06-01',
  validTo: null,
  observedAt: '2026-06-01',
  supersededBy: null,
  confidence: 0.7,
  decay: 'semi-stable',
});

describe('applyAliasMap', () => {
  it('rewrites a claim subject that is an alias to its canonical', () => {
    const claims = [claim('c1', 'the user', 'prefers', 'TypeScript')];
    const map = new Map([['the user', 'Keshav']]);
    const r = applyAliasMap(claims, map);
    expect(r.claims[0].subject).toBe('Keshav');
    expect(r.rewritten).toBe(1);
  });

  it('leaves a non-alias subject untouched', () => {
    const claims = [claim('c1', 'Priya', 'works at', 'Acme')];
    const map = new Map([['the user', 'Keshav']]);
    const r = applyAliasMap(claims, map);
    expect(r.claims[0].subject).toBe('Priya');
    expect(r.rewritten).toBe(0);
  });

  it('rewrites the object ONLY on an exact alias match', () => {
    const claims = [
      // object exactly equals an alias key -> rewritten
      claim('c1', 'Priya', 'reports to', 'the user'),
      // object merely CONTAINS an alias key -> NOT rewritten
      claim('c2', 'Priya', 'note', 'the user manual is outdated'),
    ];
    const map = new Map([['the user', 'Keshav']]);
    const r = applyAliasMap(claims, map);
    expect(r.claims[0].object).toBe('Keshav');
    expect(r.claims[1].object).toBe('the user manual is outdated');
    // c1 subject (Priya) unchanged, only its object rewritten => 1 rewrite.
    expect(r.rewritten).toBe(1);
  });

  it('rewrites BOTH subject and object of one claim (counts once)', () => {
    const claims = [claim('c1', 'the user', 'is', 'you')];
    const map = new Map([
      ['the user', 'Keshav'],
      ['you', 'Keshav'],
    ]);
    const r = applyAliasMap(claims, map);
    expect(r.claims[0].subject).toBe('Keshav');
    expect(r.claims[0].object).toBe('Keshav');
    expect(r.rewritten).toBe(1);
  });

  it('is a no-op when the canonical maps to itself (idempotent on canonical)', () => {
    const claims = [claim('c1', 'Keshav', 'prefers', 'TypeScript')];
    const map = new Map([['Keshav', 'Keshav']]);
    const r = applyAliasMap(claims, map);
    expect(r.claims[0].subject).toBe('Keshav');
    expect(r.rewritten).toBe(0);
  });

  it('is idempotent: a second apply over already-canonical claims rewrites nothing', () => {
    const claims = [claim('c1', 'the user', 'prefers', 'TypeScript')];
    const map = new Map([
      ['the user', 'Keshav'],
      ['Keshav', 'Keshav'],
    ]);
    const once = applyAliasMap(claims, map);
    expect(once.rewritten).toBe(1);
    const twice = applyAliasMap(once.claims, map);
    expect(twice.rewritten).toBe(0);
    expect(twice.claims[0].subject).toBe('Keshav');
  });

  it('an empty map returns claims equal to the input (no rewrites)', () => {
    const claims = [claim('c1', 'the user', 'prefers', 'TypeScript')];
    const r = applyAliasMap(claims, new Map());
    expect(r.rewritten).toBe(0);
    expect(r.claims).toEqual(claims);
  });

  it('does not mutate the input array or its claims', () => {
    const claims = [claim('c1', 'the user', 'prefers', 'TypeScript')];
    const map = new Map([['the user', 'Keshav']]);
    applyAliasMap(claims, map);
    expect(claims[0].subject).toBe('the user');
  });
});
