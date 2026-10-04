import { describe, it, expect } from 'vitest';
import {
  applyRawClaims,
  runCuratorPass,
  reconcileClaims,
  defaultIdGen,
  type Extractor,
  type ContradictionDetector,
} from '../curator.js';
import type { Claim, RawClaim } from '../claims.js';

const raw = (subject: string, predicate: string, object: string): RawClaim => ({
  subject,
  predicate,
  object,
  source: { kind: 'task', ref: 't1', date: '2026-06-01' },
});
const idGen = (_r: RawClaim, i: number) => `c${i}`;

describe('applyRawClaims', () => {
  it('folds multiple raw claims, counts adds, and compiles the hot core', () => {
    const r = applyRawClaims([], [raw('Priya', 'works at', 'Acme'), raw('The user', 'prefers', 'TS')], '2026-06-01', idGen);
    expect(r.stats).toEqual({ added: 2, superseded: 0, reinforced: 0 });
    expect(r.hotCore).toContain('## Priya');
    expect(r.hotCore).toContain('## The user');
  });

  it('counts supersession when a later claim contradicts an earlier one', () => {
    const r = applyRawClaims(
      [],
      [raw('Priya', 'deal status', 'in procurement'), raw('Priya', 'deal status', 'signed')],
      '2026-06-01',
      idGen,
    );
    expect(r.stats.added).toBe(2);
    expect(r.stats.superseded).toBe(1);
    expect(r.hotCore).toContain('signed');
    expect(r.hotCore).not.toContain('in procurement');
  });

  it('counts reinforcement on a duplicate', () => {
    const r = applyRawClaims([], [raw('Priya', 'works at', 'Acme'), raw('priya', 'works at', 'acme')], '2026-06-01', idGen);
    expect(r.stats).toEqual({ added: 1, superseded: 0, reinforced: 1 });
  });
});

describe('runCuratorPass', () => {
  it('extracts via the injected extractor then folds into the ledger', async () => {
    const extractor: Extractor = { extract: async () => [raw('Maya', 'owns', 'Atlas architecture')] };
    const r = await runCuratorPass([], 'transcript text', extractor, '2026-06-01', defaultIdGen('2026-06-01'));
    expect(r.stats.added).toBe(1);
    expect(r.hotCore).toContain('## Maya');
  });

  it('degrades safe: a throwing extractor leaves the ledger untouched', async () => {
    const existing = applyRawClaims([], [raw('Priya', 'works at', 'Acme')], '2026-06-01', idGen).claims;
    const boom: Extractor = { extract: async () => { throw new Error('extractor down'); } };
    const r = await runCuratorPass(existing, 'transcript', boom, '2026-06-02', defaultIdGen('2026-06-02'));
    expect(r.stats).toEqual({ added: 0, superseded: 0, reinforced: 0 });
    expect(r.claims).toEqual(existing);
  });
});

// Build a fully-formed active claim with explicit observedAt (the watermark axis).
const claim = (id: string, subject: string, predicate: string, object: string, observedAt: string): Claim => ({
  id,
  subject,
  predicate,
  object,
  sources: [{ kind: 'task', ref: id, date: observedAt }],
  validFrom: observedAt,
  validTo: null,
  observedAt,
  supersededBy: null,
  confidence: 0.7,
  decay: 'semi-stable',
});

// A detector that counts how many times it is invoked and retires every same-predicate
// candidate whose object differs from the incoming one (open-vocabulary, no domain gate).
function countingDetector(): ContradictionDetector & { calls: number } {
  return {
    calls: 0,
    async detect({ incoming, candidates }) {
      this.calls += 1;
      return candidates
        .filter((c) => c.predicate === incoming.predicate && c.object !== incoming.object)
        .map((c) => c.id);
    },
  };
}

describe('reconcileClaims', () => {
  it('caps detector calls and reports a watermark (the max observedAt processed, never now)', async () => {
    const claims = [
      claim('a', 'Priya', 'deal status', 'lead', '2026-06-01T00:00:00Z'),
      claim('b', 'Priya', 'deal status', 'in procurement', '2026-06-02T00:00:00Z'),
      claim('c', 'Maya', 'owns', 'Atlas', '2026-06-03T00:00:00Z'),
      claim('d', 'Priya', 'deal status', 'signed', '2026-06-04T00:00:00Z'),
    ];
    const detector = countingDetector();
    const r = await reconcileClaims(claims, {
      sinceCursor: null,
      cap: 2,
      now: '2026-06-09T00:00:00Z',
      detector,
    });

    // cap=2 → OLDEST-first, so only the two oldest (a @06-01, b @06-02) are processed.
    expect(detector.calls).toBeLessThanOrEqual(2);
    expect(r.detectorCalls).toBe(detector.calls);
    // watermark = newest observedAt of the processed (oldest) slice, NOT `now`.
    expect(r.processedThrough).toBe('2026-06-02T00:00:00Z');
    expect(r.processedThrough).not.toBe('2026-06-09T00:00:00Z');
  });

  it('caps OLDEST-first so the watermark never skips unprocessed old claims (no silent drop)', async () => {
    // 5 claims past the cursor, cap 2. Oldest-first processes the contiguous prefix
    // (06-01, 06-02); the watermark must stop at 06-02 so 06-03/06-04/06-05 stay
    // strictly above it and get picked up on the next pass (never dropped).
    const claims = [
      claim('e', 'Eve', 'role', 'lead', '2026-06-05T00:00:00Z'),
      claim('a', 'Ann', 'role', 'pm', '2026-06-01T00:00:00Z'),
      claim('c', 'Cal', 'role', 'eng', '2026-06-03T00:00:00Z'),
      claim('d', 'Dot', 'role', 'ops', '2026-06-04T00:00:00Z'),
      claim('b', 'Bea', 'role', 'pm', '2026-06-02T00:00:00Z'),
    ];
    const first = await reconcileClaims(claims, {
      sinceCursor: null,
      cap: 2,
      now: '2026-06-09T00:00:00Z',
      detector: countingDetector(),
    });
    // Watermark = newest of the oldest-2 slice, NOT the newest overall (06-05).
    expect(first.processedThrough).toBe('2026-06-02T00:00:00Z');

    // The next pass resumes strictly above the watermark and picks up the rest in order.
    const second = await reconcileClaims(first.claims, {
      sinceCursor: first.processedThrough,
      cap: 2,
      now: '2026-06-09T00:00:00Z',
      detector: countingDetector(),
    });
    // 06-03 and 06-04 are the next-oldest two — none of the older claims was skipped.
    expect(second.processedThrough).toBe('2026-06-04T00:00:00Z');
  });

  it('only considers active claims with observedAt > sinceCursor', async () => {
    const claims = [
      claim('old', 'Priya', 'deal status', 'lead', '2026-06-01T00:00:00Z'),
      claim('new', 'Priya', 'deal status', 'signed', '2026-06-04T00:00:00Z'),
    ];
    const detector = countingDetector();
    const r = await reconcileClaims(claims, {
      sinceCursor: '2026-06-02T00:00:00Z',
      cap: 10,
      now: '2026-06-09T00:00:00Z',
      detector,
    });
    // 'old' is at/below the cursor → not a processing candidate; only 'new' drives.
    expect(r.processedThrough).toBe('2026-06-04T00:00:00Z');
    // But 'old' is still an active same-subject candidate the detector may retire.
    const old = r.claims.find((c) => c.id === 'old')!;
    expect(old.supersededBy).toBe('new');
  });

  it('is idempotent: re-running over an already-reconciled set makes 0 new supersessions', async () => {
    const claims = [
      claim('a', 'Priya', 'deal status', 'lead', '2026-06-01T00:00:00Z'),
      claim('b', 'Priya', 'deal status', 'signed', '2026-06-04T00:00:00Z'),
    ];
    const first = await reconcileClaims(claims, {
      sinceCursor: null,
      cap: 10,
      now: '2026-06-09T00:00:00Z',
      detector: countingDetector(),
    });
    // 'a' got retired by 'b' in pass 1.
    expect(first.claims.find((c) => c.id === 'a')!.supersededBy).toBe('b');

    const detector2 = countingDetector();
    const second = await reconcileClaims(first.claims, {
      sinceCursor: null,
      cap: 10,
      now: '2026-06-10T00:00:00Z',
      detector: detector2,
    });
    // No active contradiction remains → no new supersessions, equal claims.
    expect(second.claims).toEqual(first.claims);
    const newlySuperseded = second.claims.filter(
      (c) => c.supersededBy && !first.claims.find((p) => p.id === c.id)!.supersededBy,
    );
    expect(newlySuperseded).toHaveLength(0);
  });

  it('processes the FULL delta in ONE pass when it fits under the ceiling (no throttle)', async () => {
    // 100 active claims, all past a null cursor, ceiling far above. A normal daily
    // delta must be FULLY processed in one pass: one detector call per active claim,
    // and the watermark advances to the NEWEST claim (next dream starts fresh).
    const claims: Claim[] = [];
    for (let i = 0; i < 100; i += 1) {
      const day = String((i % 27) + 1).padStart(2, '0');
      const observedAt = `2026-06-${day}T00:00:0${i % 10}Z`;
      // Distinct subjects → no same-subject peers → no supersessions, but the detector
      // is still invoked once per processed claim only when a peer exists. To force a
      // detector call per claim we give every claim a same-subject sibling pair is not
      // needed; instead assert the watermark + that ALL are processed via the in-flight
      // recorder below. Use a shared subject in pairs so each has a candidate.
      claims.push(claim(`c${i}`, `Subj${Math.floor(i / 2)}`, 'role', `r${i}`, observedAt));
    }
    const newest = claims
      .map((c) => c.observedAt)
      .sort()
      .at(-1)!;

    // A detector that records concurrency AND every claim it was asked about.
    let inFlight = 0;
    let maxInFlight = 0;
    const askedAbout = new Set<string>();
    const detector: ContradictionDetector = {
      async detect({ incoming }) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        askedAbout.add(`${incoming.subject}|${incoming.object}`);
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        return [];
      },
    };

    const r = await reconcileClaims(claims, {
      sinceCursor: null,
      cap: 250,
      now: '2026-07-01T00:00:00Z',
      detector,
    });

    // Each of the 100 claims has a same-subject peer (paired Subj0..Subj49), so each
    // is a processing candidate with candidates.length > 0 → exactly 100 detector calls.
    expect(r.detectorCalls).toBe(100);
    expect(askedAbout.size).toBe(100);
    // Full delta processed → watermark is the NEWEST claim (next dream starts fresh).
    expect(r.processedThrough).toBe(newest);
    // Ran CONCURRENTLY (bounded): more than one in flight at once, never exceeding 8.
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(8);
  });

  it('bounds detector concurrency to at most 8 in flight at once', async () => {
    const claims: Claim[] = [];
    for (let i = 0; i < 40; i += 1) {
      const day = String((i % 27) + 1).padStart(2, '0');
      claims.push(claim(`x${i}`, `Pair${Math.floor(i / 2)}`, 'role', `v${i}`, `2026-06-${day}T00:00:0${i % 10}Z`));
    }
    let inFlight = 0;
    let maxInFlight = 0;
    let totalCalls = 0;
    const detector: ContradictionDetector = {
      async detect() {
        inFlight += 1;
        totalCalls += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight -= 1;
        return [];
      },
    };
    await reconcileClaims(claims, { sinceCursor: null, cap: 250, now: '2026-07-01T00:00:00Z', detector });
    expect(totalCalls).toBe(40);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(8);
  });

  it('is order-independent + idempotent across the full concurrent delta', async () => {
    // Three claims about one subject, observed oldest→newest. The newest (signed)
    // should retire the older two regardless of concurrent detect() ordering.
    const claims = [
      claim('a', 'Priya', 'deal status', 'lead', '2026-06-01T00:00:00Z'),
      claim('b', 'Priya', 'deal status', 'in procurement', '2026-06-02T00:00:00Z'),
      claim('d', 'Priya', 'deal status', 'signed', '2026-06-04T00:00:00Z'),
    ];
    const first = await reconcileClaims(claims, {
      sinceCursor: null,
      cap: 250,
      now: '2026-06-09T00:00:00Z',
      detector: countingDetector(),
    });
    // Newest-wins: a and b retired (by whichever newer same-subject claim), d active.
    expect(first.claims.find((c) => c.id === 'd')!.supersededBy).toBeNull();
    expect(first.claims.find((c) => c.id === 'a')!.supersededBy).not.toBeNull();
    expect(first.claims.find((c) => c.id === 'b')!.supersededBy).not.toBeNull();
    expect(first.processedThrough).toBe('2026-06-04T00:00:00Z');

    // Idempotent re-run → zero NEW supersessions, equal claims.
    const second = await reconcileClaims(first.claims, {
      sinceCursor: null,
      cap: 250,
      now: '2026-06-10T00:00:00Z',
      detector: countingDetector(),
    });
    expect(second.claims).toEqual(first.claims);
  });

  it('caps at the ceiling on a pathological backlog: oldest prefix processed, newer deferred', async () => {
    // 5 claims, ceiling 3 → only the oldest 3 processed; watermark stops at the 3rd
    // oldest so the newest 2 are picked up next pass (the safety-ceiling invariant).
    const claims = [
      claim('e', 'Eve', 'role', 'lead', '2026-06-05T00:00:00Z'),
      claim('a', 'Ann', 'role', 'pm', '2026-06-01T00:00:00Z'),
      claim('c', 'Cal', 'role', 'eng', '2026-06-03T00:00:00Z'),
      claim('d', 'Dot', 'role', 'ops', '2026-06-04T00:00:00Z'),
      claim('b', 'Bea', 'role', 'pm', '2026-06-02T00:00:00Z'),
    ];
    const first = await reconcileClaims(claims, {
      sinceCursor: null,
      cap: 3,
      now: '2026-06-09T00:00:00Z',
      detector: countingDetector(),
    });
    // Oldest 3 = 06-01, 06-02, 06-03 → watermark stops at 06-03.
    expect(first.processedThrough).toBe('2026-06-03T00:00:00Z');
    const second = await reconcileClaims(first.claims, {
      sinceCursor: first.processedThrough,
      cap: 3,
      now: '2026-06-09T00:00:00Z',
      detector: countingDetector(),
    });
    // The remaining 06-04, 06-05 are picked up next pass — none dropped.
    expect(second.processedThrough).toBe('2026-06-05T00:00:00Z');
  });

  it('skips already-superseded claims — never passes them to the detector', async () => {
    // 'a' is already retired (supersededBy='b'); it must not be a processing candidate
    // nor appear in the detector's candidate set.
    const retired: Claim = { ...claim('a', 'Priya', 'deal status', 'lead', '2026-06-05T00:00:00Z'), validTo: '2026-06-05T00:00:00Z', supersededBy: 'b' };
    const claims = [
      retired,
      claim('b', 'Priya', 'deal status', 'signed', '2026-06-04T00:00:00Z'),
      claim('c', 'Priya', 'deal status', 'closed', '2026-06-06T00:00:00Z'),
    ];
    const seen: string[] = [];
    const detector: ContradictionDetector = {
      async detect({ candidates }) {
        for (const c of candidates) seen.push(c.id);
        return [];
      },
    };
    await reconcileClaims(claims, { sinceCursor: null, cap: 10, now: '2026-06-09T00:00:00Z', detector });
    // The retired 'a' is never offered as a candidate.
    expect(seen).not.toContain('a');
  });

  it('does not re-process the watermark claim when the persisted cursor round-trips through Postgres (Z vs +00:00 tie)', async () => {
    // AUDIT-7 idle re-billing loop. The dream persists `processedThrough` into a
    // TIMESTAMPTZ column (last_dream_at); supabase-js reads it BACK in Postgres's offset
    // encoding ("…+00:00"), NOT the JS toISOString "…Z" form the ledger writes. Same
    // instant, DIFFERENT string — and "Z" (0x5A) > "+" (0x2B) lexically, so a raw string
    // compare re-selects the exact-watermark claim on EVERY dream (detector re-billed,
    // cursor never advances). Two same-subject peers at the watermark instant so a
    // re-selection WOULD fire detector calls; different predicates so neither retires the
    // other (the store stays unchanged across dreams — the production signature).
    const watermark = '2026-07-01T02:00:00.414Z';
    const claims = [
      claim('w1', 'Priya', 'role', 'PM', watermark),
      claim('w2', 'Priya', 'team', 'growth', watermark),
    ];
    const first = await reconcileClaims(claims, {
      sinceCursor: null,
      cap: 250,
      now: '2026-07-02T07:00:00Z',
      detector: countingDetector(),
    });
    expect(first.processedThrough).toBe(watermark);

    // The SAME instant, in the encoding Postgres/PostgREST returns for a timestamptz.
    const cursorFromDb = '2026-07-01T02:00:00.414+00:00';
    const detector2 = countingDetector();
    const second = await reconcileClaims(claims, {
      sinceCursor: cursorFromDb,
      cap: 250,
      now: '2026-07-02T08:00:00Z',
      detector: detector2,
    });
    // Nothing observed strictly AFTER the watermark instant → ZERO detector calls and the
    // watermark does not spuriously re-advance.
    expect(detector2.calls).toBe(0);
    expect(second.detectorCalls).toBe(0);
    expect(second.processedThrough).toBe(cursorFromDb);
  });
});
