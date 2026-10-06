import { verifyRequest } from '@go/contract';
import type { Db } from '../store/people.js';

export const VAULT_SIGNATURE_HEADER = 'x-vault-signature';

/** Checks Go's signature (same format as the socket's, own secret) and accepts each signature once. */
export async function checkInternal(
  db: Db,
  secret: string,
  req: { method: string; url: string; headers: Record<string, string | string[] | undefined> },
  body: string,
  now: Date,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const sent = req.headers[VAULT_SIGNATURE_HEADER];
  const header = Array.isArray(sent) ? sent[0] : sent;
  const check = verifyRequest({ method: req.method, target: req.url, body }, header, secret, Math.floor(now.getTime() / 1000));
  if (!check.ok) return check;
  const fields = new Map((header ?? '').split(',').map((p) => p.split('=') as [string, string]));
  const r = await db.query('insert into internal_seen (t, v1, seen_at) values ($1, $2, $3) on conflict do nothing', [
    Number(fields.get('t')),
    fields.get('v1'),
    now,
  ]);
  if ((r.rowCount ?? 0) === 0) return { ok: false, reason: 'replayed' };
  return { ok: true };
}
