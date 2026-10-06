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
  /** A fresh token for the trip, good until `expiresAt` unless it is revoked first. */
  mint(tripId: string, expiresAt: Date): Promise<string>;
  tripFor(token: string): Promise<string | null>;
  revokeAll(tripId: string): Promise<number>;
  /** The trips that still hold a token that is neither revoked nor expired. */
  liveTrips(): Promise<string[]>;
}

export function createTokenStore(pool: pg.Pool, now: () => Date): TokenStore {
  return {
    async mint(tripId, expiresAt) {
      const token = mintTripToken();
      await pool.query('insert into trip_tokens (token_hash, trip_id, created_at, expires_at) values ($1, $2, $3, $4)', [hashToken(token), tripId, now(), expiresAt]);
      return token;
    },
    async tripFor(token) {
      if (!TRIP_TOKEN_PATTERN.test(token)) return null;
      const { rows } = await pool.query<{ trip_id: string }>(
        'select trip_id from trip_tokens where token_hash = $1 and revoked_at is null and expires_at > $2',
        [hashToken(token), now()],
      );
      return rows[0]?.trip_id ?? null;
    },
    async revokeAll(tripId) {
      const r = await pool.query('update trip_tokens set revoked_at = $2 where trip_id = $1 and revoked_at is null', [tripId, now()]);
      return r.rowCount ?? 0;
    },
    async liveTrips() {
      const { rows } = await pool.query<{ trip_id: string }>('select distinct trip_id from trip_tokens where revoked_at is null and expires_at > $1', [now()]);
      return rows.map((r) => r.trip_id);
    },
  };
}
