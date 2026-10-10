import { createHash, randomBytes } from 'node:crypto';
import type { Db } from './store/people.js';

export const LINK_TTL_MS = 5 * 60_000;
/** Where the vault home opens. No add_login: logins are not stored this week (master §9). */
export type LinkStart = 'home' | 'add_card' | 'add_travel';

export interface LinkRow {
  link_id: string;
  kind: 'home' | 'pay';
  person_id: string;
  start: LinkStart;
  approval_id: string | null;
  expires_at: Date;
  used_at: Date | null;
  session_hash: Buffer | null;
  session_until: Date | null;
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function mint(): { token: string; hash: Buffer; linkId: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token), linkId: `lk_${randomBytes(9).toString('base64url')}` };
}

export async function createHomeLink(db: Db, now: Date, o: { personId: string; start: LinkStart }): Promise<{ token: string; expiresAt: Date }> {
  const { token, hash, linkId } = mint();
  const expiresAt = new Date(now.getTime() + LINK_TTL_MS);
  await db.query(
    "insert into links (link_id, token_hash, kind, person_id, start, expires_at, created_at) values ($1, $2, 'home', $3, $4, $5, $6)",
    [linkId, hash, o.personId, o.start, expiresAt, now],
  );
  return { token, expiresAt };
}

/** A pay link lives 5 minutes, and never past its approval's expiry. */
export async function createPayLink(
  db: Db,
  now: Date,
  o: { personId: string; approvalId: string; notAfter: Date },
): Promise<{ token: string; expiresAt: Date }> {
  const { token, hash, linkId } = mint();
  const expiresAt = new Date(Math.min(now.getTime() + LINK_TTL_MS, o.notAfter.getTime()));
  await db.query(
    "insert into links (link_id, token_hash, kind, person_id, approval_id, expires_at, created_at) values ($1, $2, 'pay', $3, $4, $5, $6)",
    [linkId, hash, o.personId, o.approvalId, expiresAt, now],
  );
  return { token, expiresAt };
}

export async function findLink(db: Db, token: string): Promise<LinkRow | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const r = await db.query<LinkRow>(
    'select link_id, kind, person_id, start, approval_id, expires_at, used_at, session_hash, session_until from links where token_hash = $1',
    [hashToken(token)],
  );
  return r.rows[0] ?? null;
}

export function linkProblem(link: LinkRow | null, now: Date): 'link_invalid' | 'link_used' | 'link_expired' | null {
  if (!link) return 'link_invalid';
  if (link.used_at) return 'link_used';
  if (link.expires_at.getTime() <= now.getTime()) return 'link_expired';
  return null;
}
