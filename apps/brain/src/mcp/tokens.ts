/**
 * Trip tokens: what a job on the trip's computer sends to Go's MCP server, so Go knows which trip is asking. Minted
 * fresh before every job, stored only as a sha256 hash, revoked when the trip's last running job ends.
 */
import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';

export const TRIP_TOKEN_PATTERN = /^gtt_[A-Za-z0-9_-]{43}$/;

export function mintTripToken(): string {
  return `gtt_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface TokenStore {
  mint(tripId: string): Promise<string>;
  tripFor(token: string): Promise<string | null>;
  revokeAll(tripId: string): Promise<number>;
}

export function createTokenStore(pool: pg.Pool, now: () => Date): TokenStore {
  return {
    async mint(tripId) {
      const token = mintTripToken();
      await pool.query('insert into trip_tokens (token_hash, trip_id, created_at) values ($1, $2, $3)', [hashToken(token), tripId, now()]);
      return token;
    },
    async tripFor(token) {
      if (!TRIP_TOKEN_PATTERN.test(token)) return null;
      const { rows } = await pool.query<{ trip_id: string }>('select trip_id from trip_tokens where token_hash = $1 and revoked_at is null', [hashToken(token)]);
      return rows[0]?.trip_id ?? null;
    },
    async revokeAll(tripId) {
      const r = await pool.query('update trip_tokens set revoked_at = $2 where trip_id = $1 and revoked_at is null', [tripId, now()]);
      return r.rowCount ?? 0;
    },
  };
}
