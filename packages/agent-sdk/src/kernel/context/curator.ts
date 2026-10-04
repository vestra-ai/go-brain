// nami curator: the "brain writes itself" loop, in pure form.
//
// Folds extracted raw claims into the open-taxonomy ledger (merge/supersede/
// reinforce) and recompiles the hot core. The LLM extraction step is an injected
// `Extractor` seam, so the orchestration is deterministic + unit-testable, and a
// failed extraction NEVER corrupts the ledger (degrade-safe).

import { mergeClaim, compileHotCore, isActive, type Claim, type RawClaim } from './claims.js';
import type { CaptureEpisode } from './episode.js';

export interface CuratorStats {
  added: number;
  superseded: number;
  reinforced: number;
}

export interface CuratorResult {
  claims: Claim[];
  hotCore: string;
  stats: CuratorStats;
}

export type IdGen = (raw: RawClaim, index: number) => string;

/** Turns a transcript into candidate claims (the LLM step — swappable). */
export interface Extractor {
  extract(input: { transcript: string; now: string }): Promise<RawClaim[]>;
}

/**
 * The nami brain v2 §3c capture seam: judges a finished, full-fidelity
 * CaptureEpisode (the causal journal, not a flat transcript) into candidate
 * claims via the predict-then-residual judge. Added ALONGSIDE {@link Extractor}
 * (v1) — the NAMI_CAPTURE_V2 flag selects which seam runs, so flag-OFF keeps the
 * byte-identical v1 path.
 */
export interface CaptureJudge {
  judge(input: { episode: CaptureEpisode; dedupList?: string; now: string }): Promise<RawClaim[]>;
}

/**
 * Decides which of a subject's existing claims a new claim retires — ACROSS
 * differently-worded predicates (e.g. "works at" vs "current employer" vs
 * "former_employer"), which exact-match merge cannot catch. Returns ids drawn
 * from `candidates`. The LLM step; open-taxonomy supersession depends on it.
 */
export interface ContradictionDetector {
  detect(args: {
    incoming: { subject: string; predicate: string; object: string };
    candidates: Claim[];
    now: string;
  }): Promise<string[]>;
}

const normSubject = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Active claims about a subject (case-insensitive), excluding one id. */
export function activeClaimsForSubject(claims: Claim[], subject: string, excludeId?: string): Claim[] {
  const s = normSubject(subject);
  return claims.filter((c) => isActive(c) && normSubject(c.subject) === s && c.id !== excludeId);
}

export interface AliasMapResult {
  claims: Claim[];
  /** number of claims that had at least one field (subject and/or object) rewritten. */
  rewritten: number;
}

/**
 * Rewrite each claim's `subject` (and `object` IFF it EXACTLY equals an alias key)
 * to its canonical per `canonicalByAlias`. Entity-alias resolution: differently-named
 * references to the SAME real-world entity ("the user" / "Keshav" / "you"; a full org
 * name vs its abbreviation) collapse onto one canonical subject so the ledger / wiki
 * stops treating them as separate entities.
 *
 * Pure, no I/O, no domain assumptions — the alias map is supplied by the caller (the
 * LLM resolver decides co-reference). IDEMPOTENT: a canonical mapped to itself, or a
 * subject/object absent from the map, is a no-op, so re-applying the same map rewrites
 * nothing. The OBJECT is rewritten only on an EXACT alias-key match (never a substring),
 * so a value that merely contains an alias as text is left untouched. Never mutates the
 * input array or its claims (returns a fresh array with new objects only where rewritten).
 */
export function applyAliasMap(claims: Claim[], canonicalByAlias: Map<string, string>): AliasMapResult {
  if (canonicalByAlias.size === 0) {
    return { claims, rewritten: 0 };
  }
  let rewritten = 0;
  const out = claims.map((c) => {
    const subjCanon = canonicalByAlias.get(c.subject);
    const objCanon = canonicalByAlias.get(c.object);
    const newSubject = subjCanon !== undefined && subjCanon !== c.subject ? subjCanon : c.subject;
    const newObject = objCanon !== undefined && objCanon !== c.object ? objCanon : c.object;
    if (newSubject === c.subject && newObject === c.object) return c;
    rewritten += 1;
    return { ...c, subject: newSubject, object: newObject };
  });
  return { claims: out, rewritten };
}

/** Retire specific active claims (bi-temporal invalidate: validTo + supersededBy). Pure. */
export function supersedeClaims(claims: Claim[], idsToRetire: string[], retiredBy: string, now: string): Claim[] {
  const retire = new Set(idsToRetire);
  return claims.map((c) => (retire.has(c.id) && isActive(c) ? { ...c, validTo: now, supersededBy: retiredBy } : c));
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Deterministic content-addressed claim ids for a curator pass at time `now`. */
export function defaultIdGen(now: string): IdGen {
  return (raw, index) => `clm_${hash(`${raw.subject}|${raw.predicate}|${raw.object}|${now}|${index}`)}`;
}

/** Fold raw claims into the ledger (merge each in order), then recompile the hot core. Pure. */
export function applyRawClaims(existing: Claim[], rawClaims: RawClaim[], now: string, idGen: IdGen): CuratorResult {
  let claims = existing;
  const stats: CuratorStats = { added: 0, superseded: 0, reinforced: 0 };
  rawClaims.forEach((raw, i) => {
    const res = mergeClaim(claims, raw, now, idGen(raw, i));
    claims = res.claims;
    if (res.added) stats.added += 1;
    if (res.superseded) stats.superseded += 1;
    if (res.reinforced) stats.reinforced += 1;
  });
  return { claims, hotCore: compileHotCore(claims), stats };
}

/**
 * Async fold with optional LLM contradiction-detection. Same deterministic merge
 * as applyRawClaims, then — for each genuinely NEW claim — asks the detector which
 * of the subject's OTHER active claims it retires (cross-predicate supersession).
 * The detector may only retire claims in the subject-scoped candidate set, and a
 * detector failure degrades to the deterministic result (never corrupts the ledger).
 */
export async function applyRawClaimsAsync(
  existing: Claim[],
  rawClaims: RawClaim[],
  now: string,
  idGen: IdGen,
  detector?: ContradictionDetector,
): Promise<CuratorResult> {
  let claims = existing;
  const stats: CuratorStats = { added: 0, superseded: 0, reinforced: 0 };
  for (let i = 0; i < rawClaims.length; i += 1) {
    const raw = rawClaims[i];
    const newId = idGen(raw, i);
    const res = mergeClaim(claims, raw, now, newId);
    claims = res.claims;
    if (res.added) stats.added += 1;
    if (res.superseded) stats.superseded += 1;
    if (res.reinforced) stats.reinforced += 1;

    if (res.added && detector) {
      const candidates = activeClaimsForSubject(claims, raw.subject, newId);
      if (candidates.length > 0) {
        let ids: string[] = [];
        try {
          ids = await detector.detect({ incoming: { subject: raw.subject, predicate: raw.predicate, object: raw.object }, candidates, now });
        } catch {
          ids = [];
        }
        const allowed = new Set(candidates.map((c) => c.id));
        const toRetire = ids.filter((id) => allowed.has(id));
        if (toRetire.length > 0) {
          claims = supersedeClaims(claims, toRetire, newId, now);
          stats.superseded += toRetire.length;
        }
      }
    }
  }
  return { claims, hotCore: compileHotCore(claims), stats };
}

export interface ReconcileClaimsOptions {
  /**
   * transaction-time watermark: only claims observed AFTER this are processed
   * (null = all). An ISO timestamp string, matching `Claim.observedAt`.
   */
  sinceCursor: string | null;
  /** max claims to process this pass (bounds detector calls + cost). */
  cap: number;
  /** wall-clock for any retirement timestamps. MUST NOT be used as the watermark. */
  now: string;
  detector?: ContradictionDetector;
}

export interface ReconcileClaimsResult {
  claims: Claim[];
  /** number of times the detector was actually invoked (<= cap). */
  detectorCalls: number;
  /**
   * Watermark = the max observedAt of any claim actually processed this pass
   * (so the next pass can resume `observedAt > processedThrough`). The empty-pass
   * value is the incoming `sinceCursor`. NEVER `now` — a "nothing-changed" pass
   * must not advance the cursor past unprocessed claims. An ISO string (or null).
   *
   * INVARIANT: candidates past the cursor are processed OLDEST-first and capped, so
   * the watermark only ever advances over a CONTIGUOUS prefix of the unprocessed
   * claims. When there are more than `cap` claims past the cursor, the watermark
   * stops at the newest claim in the processed (oldest) slice — the un-sliced newer
   * claims stay strictly above it and are picked up on the next pass. This is what
   * makes the cap safe at scale: it never jumps the cursor past an unprocessed claim.
   */
  processedThrough: string | null;
}

/** Max detector (Haiku) calls in flight at once during a reconcile pass. */
const RECONCILE_DETECTOR_CONCURRENCY = 8;

/**
 * Run `tasks` with at most `width` in flight at once, preserving result order.
 * A tiny inline bounded-concurrency limiter (no p-limit dependency) so the dream's
 * many read-only detector calls fan out concurrently instead of serializing.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  width: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  const lanes = Array.from({ length: Math.min(Math.max(1, width), items.length || 1) }, () => worker());
  await Promise.all(lanes);
  return results;
}

/**
 * Is `observedAt` strictly AFTER the reconcile watermark `cursor`? Compares by parsed
 * INSTANT, not raw string. `observedAt` is a JS `toISOString()` value ("…Z"), but the
 * persisted cursor (nami's `last_dream_at`) round-trips through a Postgres TIMESTAMPTZ
 * column and comes back in Postgres's offset encoding ("…+00:00"). Those encode the SAME
 * instant yet do NOT compare equal lexically ("Z" 0x5A > "+" 0x2B), so a raw `>` re-selects
 * the exact-watermark claim on EVERY dream — the AUDIT-7 idle re-billing loop (detector
 * re-billed, cursor frozen at the watermark). Parsing to epoch millis reconciles the
 * encodings; the strict `>` then IS the deterministic tie rule: a claim observed AT the
 * cursor instant is already-processed and is excluded. A null cursor means "process all".
 */
export function observedAfterCursor(observedAt: string, cursor: string | null): boolean {
  return cursor === null || Date.parse(observedAt) > Date.parse(cursor);
}

/**
 * The dream's batch contradiction+reweight pass. Re-examines recently-observed
 * active claims (transaction-time > sinceCursor) and lets the detector retire stale
 * same-subject claims it now contradicts — using the SAME supersession primitive as
 * capture. Pure, idempotent, open-vocabulary (no domain gates).
 *
 * CONCURRENT + ORDER-INDEPENDENT: the detector is READ-ONLY ("which existing ids does
 * this incoming claim supersede"), so we compute every processed claim's same-subject
 * candidate set from the SINGLE READ snapshot, run all detect() calls CONCURRENTLY
 * (bounded width), collect the supersession decisions, THEN apply them deterministically
 * (newest-claim-first — capture's direction) against the snapshot. Because the candidate
 * sets are read-snapshot-derived (not mutated mid-pass) and application order is fixed,
 * the result is independent of detector completion order and idempotent: a re-run over
 * an already-reconciled set makes zero new supersessions (retired claims are no longer
 * active candidates and are never offered to the detector).
 *
 * The full delta past the cursor is processed up to `cap` — a SAFETY CEILING for
 * pathological backlogs, not a per-pass throttle. A normal daily delta is far below it
 * and is processed in full, so the next dream starts fresh. When the ceiling IS hit, the
 * OLDEST contiguous prefix is processed and the watermark stops there so newer claims are
 * picked up next pass (never dropped).
 *
 * `processedThrough` is a transaction-time watermark, not `now`.
 */
export async function reconcileClaims(claims: Claim[], opts: ReconcileClaimsOptions): Promise<ReconcileClaimsResult> {
  const { sinceCursor, cap, now, detector } = opts;
  const nowStr = now;

  // The cursor watermark. The persisted cursor round-trips through a Postgres TIMESTAMPTZ
  // (last_dream_at) and returns in offset encoding, so it is compared by parsed INSTANT
  // (observedAfterCursor), never by raw string — see that helper for the AUDIT-7 loop.
  const cursor: string | null = sinceCursor ?? null;
  const cursorMs: number | null = cursor === null ? null : Date.parse(cursor);
  const afterCursor = (observedAt: string): boolean => observedAfterCursor(observedAt, cursor);

  // SELECT the OLDEST `cap` claims past the cursor (a CONTIGUOUS prefix of the
  // unprocessed delta). `cap` is a safety ceiling, not a throttle: a normal daily delta
  // is far below it and fully selected. Selecting the OLDEST slice is what keeps the
  // watermark safe when the ceiling IS hit — it advances only over that contiguous
  // prefix, so any newer claims beyond the cap stay strictly above processedThrough and
  // are picked up next pass (never a silent drop of the OLDEST claims).
  // (A non-positive cap selects nothing — no detector calls, no watermark advance.)
  const selected = claims
    .filter((c) => isActive(c) && afterCursor(c.observedAt))
    .sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0))
    .slice(0, Math.max(0, cap));

  // Watermark = the max observedAt of the SELECTED slice (the contiguous oldest-`cap`
  // prefix), computed up front from the slice BOUNDARY — not from which claims happen
  // to stay active during the pass. Everything at/below it was selected, everything
  // above it stays > processedThrough for the next pass. An empty slice leaves the
  // watermark at the incoming cursor (no advance). NEVER `now`. Compared by parsed
  // INSTANT (same Postgres-encoding caveat as the cursor above).
  let processedThrough: string | null = cursor;
  let processedThroughMs: number | null = cursorMs;
  for (const c of selected) {
    const ms = Date.parse(c.observedAt);
    if (processedThroughMs === null || ms > processedThroughMs) {
      processedThrough = c.observedAt;
      processedThroughMs = ms;
    }
  }

  if (!detector || selected.length === 0) {
    return { claims, detectorCalls: 0, processedThrough };
  }

  // Each processed claim that has same-subject peers in the READ snapshot is a detector
  // candidate. Candidate sets are derived from `claims` (the read snapshot) ONCE, so the
  // concurrent detect() calls all see the same input and the result is order-independent.
  const toAsk = selected
    .map((c) => ({ claim: c, candidates: activeClaimsForSubject(claims, c.subject, c.id) }))
    .filter((p) => p.candidates.length > 0);

  // Run every detector call CONCURRENTLY (bounded). Read-only: collect decisions, never
  // mutate the ledger here. A detector failure degrades to "retires nothing" for that
  // claim (never corrupts the ledger).
  const decisions = await mapWithConcurrency(
    toAsk,
    RECONCILE_DETECTOR_CONCURRENCY,
    async ({ claim: c, candidates }) => {
      let ids: string[] = [];
      try {
        ids = await detector.detect({
          incoming: { subject: c.subject, predicate: c.predicate, object: c.object },
          candidates,
          now: nowStr,
        });
      } catch {
        ids = [];
      }
      const allowed = new Set(candidates.map((x) => x.id));
      return { retiredBy: c, toRetire: ids.filter((id) => allowed.has(id)) };
    },
  );

  // APPLY deterministically, NEWEST-claim-first so supersession flows newest-over-older
  // (capture's direction). A decision is honored only while ITS retiring claim is still
  // active: once a newer claim retires an older one, that older claim's own decision is
  // dropped (a retired claim can no longer retire others). This makes the applied result
  // independent of the concurrent detect() completion order and idempotent across re-runs.
  const ordered = [...decisions].sort((a, b) =>
    a.retiredBy.observedAt < b.retiredBy.observedAt
      ? 1
      : a.retiredBy.observedAt > b.retiredBy.observedAt
        ? -1
        : 0,
  );
  let out = claims;
  for (const d of ordered) {
    if (d.toRetire.length === 0) continue;
    // Skip a decision whose retiring claim was itself retired earlier this pass — a
    // stale claim must not supersede anything (newest-wins, order-independent).
    const retirer = out.find((x) => x.id === d.retiredBy.id);
    if (!retirer || !isActive(retirer)) continue;
    out = supersedeClaims(out, d.toRetire, d.retiredBy.id, nowStr);
  }

  return { claims: out, detectorCalls: toAsk.length, processedThrough };
}

/** The full curator pass: extract from the transcript, then fold into the ledger. */
export async function runCuratorPass(
  existing: Claim[],
  transcript: string,
  extractor: Extractor,
  now: string,
  idGen: IdGen,
  detector?: ContradictionDetector,
): Promise<CuratorResult> {
  let raws: RawClaim[];
  try {
    raws = await extractor.extract({ transcript, now });
  } catch {
    // A failed/timed-out extraction must never corrupt or drop the existing ledger.
    raws = [];
  }
  return applyRawClaimsAsync(existing, raws, now, idGen, detector);
}
