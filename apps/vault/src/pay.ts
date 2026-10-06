import { verifySpendApproval } from '@go/contract';
import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server';
import { chargeOnce, settle, type AttemptRow, type PayDeps } from './charge.js';
import { reportOutcome } from './go-callback.js';
import { findLink, linkProblem, type LinkRow } from './links.js';
import { authenticationOptions, hasPasskey, passkeyConfig, verifyAssertion } from './passkeys.js';
import type { RailFailReason, RailKind } from './rails/rail.js';
import { newestCard, type CardSummary } from './store/cards.js';
import type { Db } from './store/people.js';
import { logUnlock } from './store/unlock-log.js';

export type { PayDeps } from './charge.js';

export type PayRefusal =
  | 'link_invalid'
  | 'link_used'
  | 'link_expired'
  | 'passkey_failed'
  | 'not_the_payer'
  | 'bad_approval'
  | 'approval_expired'
  | 'wrong_audience'
  | 'wrong_trip'
  | 'used'
  | 'currency_mismatch'
  | 'over_amount'
  | 'hold_expiring'
  | 'no_card';

export type ApproveResult =
  | { state: 'paid'; railRef: string }
  | { state: 'failed'; reason: RailFailReason }
  | { state: 'refused'; reason: PayRefusal };

interface PayRequestRow {
  approval_id: string;
  jti: string;
  trip_id: string;
  payer_person_id: string;
  approval: string;
  amount_minor: number;
  currency: string;
  merchant: string;
  hold_expires_at: Date;
  payment_kind: RailKind;
}

async function payRequest(db: Db, approvalId: string): Promise<PayRequestRow | null> {
  const r = await db.query<PayRequestRow>(
    `select approval_id, jti, trip_id, payer_person_id, approval, amount_minor, currency, merchant, hold_expires_at, payment_kind
     from pay_requests where approval_id = $1`,
    [approvalId],
  );
  return r.rows[0] ?? null;
}

async function payLink(d: PayDeps, token: string): Promise<{ link: LinkRow; pr: PayRequestRow } | { problem: 'link_invalid' | 'link_used' | 'link_expired' }> {
  const link = await findLink(d.pool, token);
  const problem = linkProblem(link, d.now());
  if (problem) return { problem };
  if (!link || link.kind !== 'pay' || !link.approval_id) return { problem: 'link_invalid' };
  const pr = await payRequest(d.pool, link.approval_id);
  return pr ? { link, pr } : { problem: 'link_invalid' };
}

export type PayInfo =
  | { state: 'invalid' | 'expired' | 'used' }
  | {
      state: 'ready' | 'no_passkey' | 'no_card';
      merchant: string;
      purpose: string;
      amount_minor: number;
      currency: string;
      refundable_until: string | null;
      card: { brand: string; last4: string } | null;
      expires_at: string;
    };

/** What the pay page shows: read from the signed approval itself, and the amount the hold will charge. */
export async function payInfo(d: PayDeps, token: string): Promise<PayInfo> {
  const found = await payLink(d, token);
  if ('problem' in found) return { state: found.problem === 'link_used' ? 'used' : found.problem === 'link_expired' ? 'expired' : 'invalid' };
  const { link, pr } = found;
  const check = verifySpendApproval(pr.approval, d.env.GO_SPEND_PUBLIC_KEY, Math.floor(d.now().getTime() / 1000));
  if (!check.ok) return { state: check.reason === 'expired' ? 'expired' : 'invalid' };
  const card: CardSummary | null = await newestCard(d.pool, link.person_id);
  const shown = {
    merchant: check.claims.merchant,
    purpose: check.claims.purpose,
    amount_minor: pr.amount_minor,
    currency: pr.currency,
    refundable_until: check.claims.refundable_until ?? null,
    card: card ? { brand: card.brand, last4: card.last4 } : null,
    expires_at: link.expires_at.toISOString(),
  };
  if (!(await hasPasskey(d.pool, link.person_id))) return { state: 'no_passkey', ...shown };
  if (!card) return { state: 'no_card', ...shown };
  return { state: 'ready', ...shown };
}

/** The passkey challenge for this payment, for the payer's passkeys only. */
export async function payOptions(
  d: PayDeps,
  token: string,
): Promise<{ ok: true; challengeId: string; options: PublicKeyCredentialRequestOptionsJSON } | { ok: false; reason: PayRefusal }> {
  const found = await payLink(d, token);
  if ('problem' in found) return { ok: false, reason: found.problem };
  const opts = await authenticationOptions(d.pool, passkeyConfig(d.env), d.now(), {
    personId: found.link.person_id,
    linkId: found.link.link_id,
    purpose: 'pay',
  });
  return opts ? { ok: true, ...opts } : { ok: false, reason: 'passkey_failed' };
}

/** Marks the link used and the jti taken, with the attempt, in one transaction. */
async function startAttempt(d: PayDeps, now: Date, linkId: string, a: AttemptRow): Promise<'ok' | 'used' | 'link_used'> {
  const client = await d.pool.connect();
  try {
    await client.query('begin');
    const l = await client.query('update links set used_at = $2 where link_id = $1 and used_at is null and expires_at > $2', [linkId, now]);
    if ((l.rowCount ?? 0) === 0) {
      await client.query('rollback');
      return 'link_used';
    }
    try {
      await client.query(
        `insert into used_approvals (jti, approval_id, trip_id, payer_person_id, link_id, card_id, amount_minor, currency, merchant, rail, outcome, used_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'charging', $11)`,
        [a.jti, a.approval_id, a.trip_id, a.payer_person_id, linkId, a.card_id, a.amount_minor, a.currency, a.merchant, a.rail, now],
      );
    } catch (e) {
      await client.query('rollback');
      if ((e as { code?: string }).code === '23505') return 'used';
      throw e;
    }
    await logUnlock(client, now, {
      personId: a.payer_person_id,
      kind: 'pay_attempt',
      cardId: a.card_id,
      approvalId: a.approval_id,
      tripId: a.trip_id,
      amountMinor: a.amount_minor,
      currency: a.currency,
      merchant: a.merchant,
      passkeyOk: true,
      approvalOk: true,
      rail: a.rail,
    });
    await client.query('commit');
    return 'ok';
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** The pay check. Every step runs in this order and the first failure stops the payment. */
export async function approvePayment(
  d: PayDeps,
  input: { token: string; challengeId: string; response: AuthenticationResponseJSON },
): Promise<ApproveResult> {
  const now = d.now();
  // 1. The link is valid, unused and unexpired.
  const found = await payLink(d, input.token);
  if ('problem' in found) return { state: 'refused', reason: found.problem };
  const { link, pr } = found;

  const refuse = async (reason: PayRefusal, personId: string, keys: { passkey: boolean; approval: boolean }): Promise<ApproveResult> => {
    await logUnlock(d.pool, now, {
      personId,
      kind: 'pay_refused',
      approvalId: pr.approval_id,
      tripId: pr.trip_id,
      amountMinor: pr.amount_minor,
      currency: pr.currency,
      merchant: pr.merchant,
      passkeyOk: keys.passkey,
      approvalOk: keys.approval,
      reason,
    });
    d.log.warn({ approval_id: pr.approval_id, reason }, 'the vault refused a payment');
    return { state: 'refused', reason };
  };

  // 2. The passkey assertion verifies, and it is the payer's.
  const unlock = await verifyAssertion(d.pool, passkeyConfig(d.env), now, {
    linkId: link.link_id,
    purpose: 'pay',
    challengeId: input.challengeId,
    response: input.response,
  });
  if (!unlock.ok) return refuse('passkey_failed', link.person_id, { passkey: false, approval: false });
  if (unlock.personId !== link.person_id) return refuse('not_the_payer', unlock.personId, { passkey: false, approval: false });
  const who = unlock.personId;

  // 3. The Server's signature, and the approval has not expired.
  const check = verifySpendApproval(pr.approval, d.env.GO_SPEND_PUBLIC_KEY, Math.floor(now.getTime() / 1000));
  if (!check.ok) return refuse(check.reason === 'expired' ? 'approval_expired' : 'bad_approval', who, { passkey: true, approval: false });
  const c = check.claims;

  // 4. Meant for the vault, from the Server, for this pay request's trip.
  if (c.aud !== 'go-vault' || c.iss !== 'server') return refuse('wrong_audience', who, { passkey: true, approval: false });
  if (c.jti !== pr.jti || c.trip_id !== pr.trip_id) return refuse('wrong_trip', who, { passkey: true, approval: false });

  // 5. Never used before. The unique jti row below makes this true even when two pages race.
  const used = await d.pool.query('select 1 from used_approvals where jti = $1', [c.jti]);
  if ((used.rowCount ?? 0) > 0) return refuse('used', who, { passkey: true, approval: false });

  // 6. The payer the Server approved is the person who unlocked.
  if (c.payer_person_id !== who) return refuse('not_the_payer', who, { passkey: true, approval: false });

  // 7. The charge is within the approval, in the same currency, while the hold still stands.
  if (pr.currency !== c.currency) return refuse('currency_mismatch', who, { passkey: true, approval: false });
  if (pr.amount_minor > c.amount_minor) return refuse('over_amount', who, { passkey: true, approval: false });
  if (pr.hold_expires_at.getTime() <= now.getTime() + 30_000) return refuse('hold_expiring', who, { passkey: true, approval: true });
  const card = await newestCard(d.pool, who);
  if (!card) return refuse('no_card', who, { passkey: true, approval: true });

  const attempt: AttemptRow = {
    jti: c.jti,
    approval_id: pr.approval_id,
    trip_id: pr.trip_id,
    payer_person_id: who,
    card_id: card.card_id,
    amount_minor: pr.amount_minor,
    currency: pr.currency,
    merchant: pr.merchant,
    rail: pr.payment_kind,
  };
  const started = await startAttempt(d, now, link.link_id, attempt);
  if (started !== 'ok') return refuse(started, who, { passkey: true, approval: started !== 'used' });

  // 8. The rail charges once, keyed by the jti.
  const result = await chargeOnce(d, attempt);
  // 9. The outcome is recorded, then 10. Go hears about it.
  await settle(d.pool, d.now(), attempt, result);
  d.log.info({ approval_id: attempt.approval_id, outcome: 'railRef' in result ? 'paid' : result.failed }, 'payment attempt settled');
  await reportOutcome(d, attempt.jti);
  return 'railRef' in result ? { state: 'paid', railRef: result.railRef } : { state: 'failed', reason: result.failed };
}
