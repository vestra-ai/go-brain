/**
 * reconstruction-invariant.ts — the journal is the source of truth; the provider
 * history the loop is about to SEND on a round MUST equal what the journal
 * re-derives through the canonical projection. dsh byte-compares the outgoing wire
 * against deriveMessages() on every request; we do the same at our one request
 * site (round-engine.ts runOneRound, before callModel). A mismatch means an in-turn
 * rebuild path and the projection disagree — exactly the class that kept context
 * elision off. Pure: no I/O, no clock, never throws.
 *
 * Equality is STRUCTURAL with JSON semantics (key order never counts; an
 * undefined-valued key is absent; null is a value) — the wire is JSON, so that is
 * the equality that matters. The compare walks both sides with early exit and no
 * allocation; only the two diverging heads are serialized (sorted keys, capped) so
 * a warning can name the kind without shipping the content.
 */
/**
 * The raw HarnessEvent name a mismatch rides so the server can persist an
 * error_event. Mirrors `EVENTS.AGENT_RECONSTRUCTION_MISMATCH` in @bash/shared —
 * the engine imports no @bash/*, so the name is duplicated here exactly as
 * BILLING_TRIPWIRE_EVENT is, and pinned to the literal by test.
 *
 * WHY AN EVENT AND NOT JUST THE SINK: the check's only production channel was a
 * `console.warn` in the sandbox process, deduped once per turn, reachable only by
 * hand-pulling Blaxel logs — and `onReconstructionMismatch` is registered by no
 * product code. A mechanism that reports failure into a void is not a safety net.
 * The event follows the billing-tripwire rail: server-consumed, `forward: false`,
 * persisted as a durable `error_events` row.
 */
export const RECONSTRUCTION_MISMATCH_EVENT = 'agent:reconstruction_mismatch';

export interface ReconstructionMismatch {
  /** The round the check ran for (the per-task round counter the round's usage event carries). */
  round: number;
  firstDivergingIndex: number;
  incrementalLength: number;
  projectedLength: number;
  /** First 200 chars of the stable JSON of the first diverging element — enough to name the kind. */
  incrementalHead: string;
  projectedHead: string;
}

/** Stable JSON: object keys sorted at every depth, so property order never reads as drift. */
function stable(v: unknown): string | undefined {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : val,
  );
}

/** Structural equality under JSON semantics (see module header). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    const x = a as unknown[];
    const y = b as unknown[];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!same(x[i], y[i])) return false;
    return true;
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  let nx = 0;
  for (const k in x) {
    if (x[k] === undefined) continue; // absent in JSON
    nx++;
    if (!same(x[k], y[k])) return false;
  }
  let ny = 0;
  for (const k in y) if (y[k] !== undefined) ny++;
  return nx === ny;
}

/**
 * The wire/journal payload for a mismatch — the divergence shape plus the run
 * identity so an audit can locate the turn. The two heads are already capped at
 * 200 chars by {@link checkReconstruction}: enough to name the KIND of divergence,
 * never enough to ship transcript content.
 */
export interface ReconstructionMismatchPayload extends ReconstructionMismatch {
  taskId: string;
  sessionId: string;
}

/** Attach the run identity to a mismatch for the durable channel. */
export function buildReconstructionMismatchPayload(
  m: ReconstructionMismatch,
  taskId: string,
  sessionId: string,
): ReconstructionMismatchPayload {
  return { ...m, taskId, sessionId };
}

export function checkReconstruction(args: {
  round: number;
  incremental: unknown;
  projected: unknown;
}): ReconstructionMismatch | null {
  const a = Array.isArray(args.incremental) ? args.incremental : [args.incremental];
  const b = Array.isArray(args.projected) ? args.projected : [args.projected];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (!same(a[i], b[i])) return mismatch(args.round, i, a, b);
  }
  if (a.length !== b.length) return mismatch(args.round, n, a, b);
  return null;
}

function mismatch(round: number, i: number, a: unknown[], b: unknown[]): ReconstructionMismatch {
  return {
    round,
    firstDivergingIndex: i,
    incrementalLength: a.length,
    projectedLength: b.length,
    incrementalHead: (i < a.length ? (stable(a[i]) ?? 'undefined') : '<absent>').slice(0, 200),
    projectedHead: (i < b.length ? (stable(b[i]) ?? 'undefined') : '<absent>').slice(0, 200),
  };
}
