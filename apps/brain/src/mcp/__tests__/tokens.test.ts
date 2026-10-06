import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { createTokenStore, hashToken } from '../tokens.js';

let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
});
afterAll(async () => {
  await db.drop();
});

describe('trip tokens', () => {
  it('mints a token that names its trip, keeping only its hash', async () => {
    const tokens = createTokenStore(db.pool, () => new Date('2026-10-07T12:00:00Z'));
    const token = await tokens.mint('t_goa');
    expect(token).toMatch(/^gtt_[A-Za-z0-9_-]{43}$/);
    expect(await tokens.tripFor(token)).toBe('t_goa');
    const { rows } = await db.pool.query<{ token_hash: string }>('select token_hash from trip_tokens');
    expect(rows.map((r) => r.token_hash)).toContain(hashToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('refuses a wrong, malformed or revoked token, and keeps trips apart', async () => {
    const tokens = createTokenStore(db.pool, () => new Date('2026-10-07T12:00:00Z'));
    const goa = await tokens.mint('t_goa2');
    const other = await tokens.mint('t_manali');
    expect(await tokens.tripFor(`gtt_${'x'.repeat(43)}`)).toBeNull();
    expect(await tokens.tripFor('not-a-token')).toBeNull();
    expect(await tokens.revokeAll('t_goa2')).toBe(1);
    expect(await tokens.tripFor(goa)).toBeNull();
    expect(await tokens.tripFor(other)).toBe('t_manali');
  });
});
