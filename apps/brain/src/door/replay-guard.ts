import type pg from 'pg';

/**
 * Remembers each upgrade signature for 10 minutes, twice the 300 s skew, so it opens the socket once.
 * The key is the HMAC (v1) alone: it already binds t and the target, so a header reworded around a used
 * v1 (an extra t=, spaces, the header sent twice) is still the same signature. Memory answers first;
 * Postgres covers restarts and other copies of the service.
 */
export function createReplayGuard(o: { pool: pg.Pool; now: () => Date; keepMs?: number }) {
  const keepMs = o.keepMs ?? 10 * 60_000;
  const seen = new Map<string, number>();
  return {
    /** True the first time this signature is seen; false on any repeat. */
    async claim(t: number, v1: string): Promise<boolean> {
      if (seen.has(v1)) return false;
      seen.set(v1, o.now().getTime());
      const r = await o.pool.query('insert into seen_signatures (v1, t, seen_at) values ($1, $2, $3) on conflict do nothing', [v1, t, o.now()]);
      return r.rowCount === 1;
    },
    async prune(): Promise<void> {
      const cutoff = o.now().getTime() - keepMs;
      for (const [k, at] of seen) if (at < cutoff) seen.delete(k);
      await o.pool.query('delete from seen_signatures where seen_at < $1', [new Date(cutoff)]);
    },
  };
}
export type ReplayGuard = ReturnType<typeof createReplayGuard>;
