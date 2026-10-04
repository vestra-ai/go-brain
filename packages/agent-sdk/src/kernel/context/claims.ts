// nami open-taxonomy claim ledger.
//
// FOUNDER DIRECTIVE (2026-06-21): the brain has NO fixed categories. A claim is a
// (subject, predicate, object) triple where subject/predicate/object are OPEN
// vocabulary (free strings) — anything can link to anything, types/relations are
// emergent, never a closed enum. This deliberately supersedes the shipped
// user_memory 4-category model (preference|fact|decision|entity).
//
// Bi-temporal: validFrom/validTo (valid-time) + observedAt (transaction-time).
// Contradictions INVALIDATE the old claim (validTo + supersededBy), never delete it.
// Pure + dependency-free so the curator (server) and the wiki can both build on it.

import { semanticKey } from './predicate-registry.js';

export type DecayClass = 'immutable' | 'semi-stable' | 'transient';

/**
 * Common claim categories (Slice 1 capture-quality), documented for reference ONLY.
 * `claimType` is OPEN vocabulary — a SHORT free-form label the extractor chooses, with
 * NO fixed list, so the field's type is `string` (not this union). This union merely
 * enumerates frequently-seen values for readability; it never restricts what may be
 * stored. ('correction' is the one value the §3d quarantine logic treats specially.)
 */
export type ClaimType =
  | 'correction'
  | 'user-fact'
  | 'preference'
  | 'procedure'
  | 'recurring-task'
  | 'duty'
  | 'entity-attribute'
  | 'environment'
  | 'other';

/** Where a claim came from. kind/ref are OPEN (e.g. 'call'|'email'|'file'|'task'). */
export interface ClaimSource {
  kind: string;
  ref: string;
  date: string;
}

export interface Claim {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  sources: ClaimSource[];
  /** valid-time: when the fact became / stopped being true */
  validFrom: string;
  validTo: string | null;
  /** transaction-time: when nami recorded it */
  observedAt: string;
  /** id of the claim that retired this one (null = current) */
  supersededBy: string | null;
  confidence: number;
  decay: DecayClass;
  /** v2 capture-quality metadata (Slice 1) — all optional, back-compatible.
   *  `claimType` is OPEN vocabulary (free-form string; see {@link ClaimType} for common values). */
  claimType?: string;
  quarantined?: boolean;
  sourceTaskId?: string;
  evidenceSpanHash?: string;
  /** judge's self-scored novelty vs a frontier model's priors (0..1); §3d quarantine
   *  input + later recall-scoring signal. */
  noveltyToFrontier?: number;
  /** P2-M3 open loops: ISO instant a commitment/expectation is due (unset when undated). */
  dueAt?: string;
  /** P2-M3 open loops: human-readable recurrence rule for `rhythm` claims. */
  recurrence?: string;
}

/** What an extractor emits before merge into the ledger. */
export interface RawClaim {
  subject: string;
  predicate: string;
  object: string;
  source: ClaimSource;
  confidence?: number;
  decay?: DecayClass;
  validFrom?: string;
  /** OPEN vocabulary (free-form string; see {@link ClaimType} for common values). */
  claimType?: string;
  quarantined?: boolean;
  sourceTaskId?: string;
  evidenceSpanHash?: string;
  noveltyToFrontier?: number;
  /** P2-M3 open loops (see Claim.dueAt / Claim.recurrence). */
  dueAt?: string;
  recurrence?: string;
}

export interface MergeResult {
  claims: Claim[];
  added: boolean;
  /** id of a claim this merge retired (a contradiction), if any */
  superseded: string | null;
  /** id of a claim this merge reinforced (a duplicate), if any */
  reinforced: string | null;
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** A claim is "current" when it has not expired and has not been superseded. */
export function isActive(c: Claim): boolean {
  return c.validTo === null && c.supersededBy === null;
}

function dedupeSources(sources: ClaimSource[]): ClaimSource[] {
  const seen = new Set<string>();
  const out: ClaimSource[] = [];
  for (const s of sources) {
    const k = `${norm(s.kind)}|${norm(s.ref)}|${s.date}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/**
 * Merge one raw claim into the ledger.
 *  - same (subject, predicate, object) on an active claim  -> REINFORCE (add source, bump confidence)
 *  - same (subject, predicate) but a DIFFERENT object       -> SUPERSEDE the active one(s) (bi-temporal
 *                                                              invalidate: set validTo + supersededBy), add new
 *  - otherwise                                              -> ADD a new active claim
 * Predicate is open vocabulary — supersession works for ANY relation, not a fixed set.
 * The (subject, predicate) IDENTITY is the canonical `semanticKey` (so a reworded
 * subject/predicate folds into the same claim); the object match stays string-`norm`.
 */
export function mergeClaim(existing: Claim[], incoming: RawClaim, now: string, newId: string): MergeResult {
  const incomingKey = semanticKey(incoming.subject, incoming.predicate);
  const activeSameSP = existing.filter((c) => isActive(c) && semanticKey(c.subject, c.predicate) === incomingKey);

  const exact = activeSameSP.find((c) => norm(c.object) === norm(incoming.object));
  if (exact) {
    const claims = existing.map((c) => {
      if (c.id !== exact.id) return c;
      const sources = dedupeSources([...c.sources, incoming.source]);
      // §3d corroboration: once a claim's sources span >=2 DISTINCT refs (a second,
      // independent episode), it is no longer single-episode — clear any quarantine.
      // Only write the field when the claim WAS quarantined; a never-quarantined claim
      // (no novelty signal / v1) must stay field-unset to preserve byte-identical flag-OFF.
      const corroborated = new Set(sources.map((s) => norm(s.ref))).size >= 2;
      return {
        ...c,
        sources,
        confidence: Math.min(1, Math.max(c.confidence, incoming.confidence ?? c.confidence) + 0.05),
        ...(corroborated && c.quarantined ? { quarantined: false } : {}),
        // P2-M3 (whole-branch review F3): a verbatim re-statement that ADDS or
        // corrects an open-loop date/rule must not silently drop it.
        ...(incoming.dueAt !== undefined ? { dueAt: incoming.dueAt } : {}),
        ...(incoming.recurrence !== undefined ? { recurrence: incoming.recurrence } : {}),
      };
    });
    return { claims, added: false, superseded: null, reinforced: exact.id };
  }

  // §3d quarantine: a single-episode, high-novelty user-fact is written but withheld
  // from the future recall index until a second episode corroborates it (Slice 2 reads
  // this flag). A correction carries user-supplied ground truth, so it enters directly.
  const novelty = incoming.noveltyToFrontier;
  const quarantined = novelty !== undefined && novelty >= 0.7 && incoming.claimType !== 'correction';

  const newClaim: Claim = {
    id: newId,
    subject: incoming.subject.trim(),
    predicate: incoming.predicate.trim(),
    object: incoming.object.trim(),
    sources: [incoming.source],
    validFrom: incoming.validFrom ?? now,
    validTo: null,
    observedAt: now,
    supersededBy: null,
    confidence: incoming.confidence ?? 0.7,
    decay: incoming.decay ?? 'semi-stable',
    ...(incoming.claimType !== undefined ? { claimType: incoming.claimType } : {}),
    // record the quarantine decision only when there's a signal to base it on; a claim
    // with no claimType/novelty stays byte-identical to the pre-v2 ledger (field unset).
    ...(novelty !== undefined || incoming.claimType !== undefined ? { quarantined } : {}),
    ...(novelty !== undefined ? { noveltyToFrontier: novelty } : {}),
    ...(incoming.sourceTaskId !== undefined ? { sourceTaskId: incoming.sourceTaskId } : {}),
    ...(incoming.evidenceSpanHash !== undefined ? { evidenceSpanHash: incoming.evidenceSpanHash } : {}),
    ...(incoming.dueAt !== undefined ? { dueAt: incoming.dueAt } : {}),
    ...(incoming.recurrence !== undefined ? { recurrence: incoming.recurrence } : {}),
  };

  let superseded: string | null = null;
  const supersededIds = new Set(activeSameSP.map((c) => c.id));
  const claims = existing.map((c) => {
    if (supersededIds.has(c.id)) {
      superseded = c.id;
      return { ...c, validTo: now, supersededBy: newId };
    }
    return c;
  });
  claims.push(newClaim);
  return { claims, added: true, superseded, reinforced: null };
}

/**
 * Compile the "what's true now" hot core from the ACTIVE claims, grouped by
 * emergent entity (subject) — no fixed categories. Deterministic ordering so the
 * output is stable (and prompt-cache friendly). Returns '' when nothing is active.
 */
export function compileHotCore(claims: Claim[]): string {
  const active = claims.filter(isActive);
  if (active.length === 0) return '';

  const groups = new Map<string, { subject: string; claims: Claim[] }>();
  for (const c of active) {
    const key = norm(c.subject);
    const g = groups.get(key) ?? { subject: c.subject.trim(), claims: [] };
    g.claims.push(c);
    groups.set(key, g);
  }

  return [...groups.values()]
    .sort((a, b) => (norm(a.subject) < norm(b.subject) ? -1 : norm(a.subject) > norm(b.subject) ? 1 : 0))
    .map((g) => {
      const lines = g.claims
        .slice()
        .sort((a, b) =>
          a.predicate < b.predicate ? -1 : a.predicate > b.predicate ? 1 : a.object < b.object ? -1 : a.object > b.object ? 1 : 0,
        )
        .map((c) => `- ${c.predicate}: ${c.object}`);
      return `## ${g.subject}\n${lines.join('\n')}`;
    })
    .join('\n\n');
}
