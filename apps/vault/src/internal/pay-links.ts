import { Id, verifySpendApproval } from '@go/contract';
import type pg from 'pg';
import { z } from 'zod';
import type { VaultEnv } from '../env.js';
import { createPayLink } from '../links.js';
import { ensurePerson } from '../store/people.js';

export const PayLinkBody = z.object({
  approval: z.string().min(1).max(4096),
  approval_id: Id,
  trip_id: Id,
  payer_person_id: Id,
  payer_name: z.string().min(1).max(80).nullish(),
  hold: z.object({
    hold_id: z.string().min(1).max(200),
    amount_minor: z.int().positive().max(2_147_483_647),
    currency: z.string().regex(/^[A-Z]{3}$/),
    merchant: z.string().min(1).max(120),
    payment_kind: z.enum(['fake', 'stripe_test', 'ixigo']),
    expires_at: z.iso.datetime({ offset: true }),
  }),
});
export type PayLinkBody = z.infer<typeof PayLinkBody>;

export type PayLinkRefusal =
  | 'bad_approval'
  | 'expired'
  | 'wrong_trip'
  | 'wrong_payer'
  | 'currency_mismatch'
  | 'over_amount'
  | 'hold_expiring'
  | 'rail_not_ready'
  | 'used';

/** Why an approval was refused as bad, in words an operator can act on. */
const BAD_APPROVAL: Record<'malformed' | 'bad_signature' | 'invalid_claims' | 'not_yet_valid', string> = {
  malformed: 'the approval is not a signed approval token',
  bad_signature: "the approval's signature is not valid for this vault's GO_SPEND_PUBLIC_KEY",
  invalid_claims: "the approval's claims are not valid",
  not_yet_valid: 'the approval is not valid yet (its iat is ahead of the clock)',
};

/** Checks the Server's approval and the hold, then makes a pay link for the payer. A refusal says why in `detail`. */
export async function openPayLink(
  db: pg.Pool,
  env: VaultEnv,
  now: Date,
  body: PayLinkBody,
): Promise<{ ok: true; url: string; expiresAt: Date } | { ok: false; reason: PayLinkRefusal; detail?: string }> {
  const refuse = (reason: PayLinkRefusal, detail?: string) => ({ ok: false, reason, ...(detail ? { detail } : {}) }) as const;
  const check = verifySpendApproval(body.approval, env.GO_SPEND_PUBLIC_KEY, Math.floor(now.getTime() / 1000));
  if (!check.ok) return check.reason === 'expired' ? refuse('expired', 'the approval has expired') : refuse('bad_approval', BAD_APPROVAL[check.reason]);
  const c = check.claims;
  if (c.iss !== 'server' || c.aud !== 'go-vault') return refuse('bad_approval', 'the approval was not issued by the Server for the vault');
  if (c.jti !== body.approval_id) return refuse('bad_approval', "the approval's jti is not the approval_id Go sent");
  if (c.trip_id !== body.trip_id) return refuse('wrong_trip');
  if (c.payer_person_id !== body.payer_person_id) return refuse('wrong_payer');
  if (body.hold.currency !== c.currency) return refuse('currency_mismatch');
  if (body.hold.amount_minor > c.amount_minor) return refuse('over_amount');
  if (Date.parse(body.hold.expires_at) <= now.getTime() + 60_000) return refuse('hold_expiring');
  if (body.hold.payment_kind === 'ixigo') return refuse('rail_not_ready');
  if (!env.VAULT_RAILS.includes(body.hold.payment_kind)) return refuse('rail_not_ready');
  const used = await db.query('select 1 from used_approvals where jti = $1', [c.jti]);
  if ((used.rowCount ?? 0) > 0) return refuse('used');
  const voided = await db.query('select 1 from voided_approvals where approval_id = $1', [body.approval_id]);
  if ((voided.rowCount ?? 0) > 0) return refuse('used');

  await ensurePerson(db, body.payer_person_id, now, body.payer_name ?? undefined);
  await db.query(
    `insert into pay_requests (approval_id, jti, trip_id, payer_person_id, approval, amount_minor, currency, merchant, hold_id,
       hold_expires_at, payment_kind, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) on conflict (approval_id) do nothing`,
    [
      body.approval_id, c.jti, c.trip_id, c.payer_person_id, body.approval, body.hold.amount_minor, body.hold.currency,
      body.hold.merchant, body.hold.hold_id, new Date(body.hold.expires_at), body.hold.payment_kind, now,
    ],
  );
  const stored = await db.query<{ jti: string; hold_id: string; amount_minor: number; approval: string }>(
    'select jti, hold_id, amount_minor, approval from pay_requests where approval_id = $1',
    [body.approval_id],
  );
  const row = stored.rows[0];
  if (!row || row.jti !== c.jti || row.hold_id !== body.hold.hold_id || row.amount_minor !== body.hold.amount_minor || row.approval !== body.approval) {
    return refuse('bad_approval', 'this approval was first sent with another hold or amount');
  }
  const link = await createPayLink(db, now, { personId: c.payer_person_id, approvalId: body.approval_id, notAfter: new Date(c.exp * 1000) });
  return { ok: true, url: `${env.VAULT_PUBLIC_URL}/p/${link.token}`, expiresAt: link.expiresAt };
}

/** Go let this payment go: every pay link for the approval stops working, and no new one is made. Safe to repeat. */
export async function voidPayLinks(db: pg.Pool, now: Date, approvalId: string): Promise<number> {
  await db.query('insert into voided_approvals (approval_id, voided_at) values ($1, $2) on conflict do nothing', [approvalId, now]);
  const r = await db.query("update links set used_at = $2 where approval_id = $1 and kind = 'pay' and used_at is null", [approvalId, now]);
  return r.rowCount ?? 0;
}
