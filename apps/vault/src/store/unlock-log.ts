import type { Db } from './people.js';

export type UnlockKind =
  | 'passkey_added'
  | 'unlock'
  | 'card_added'
  | 'pay_refused'
  | 'pay_attempt'
  | 'pay_ok'
  | 'pay_failed'
  | 'travel_saved'
  | 'travel_read'
  | 'travel_deleted';

export interface UnlockEntry {
  personId: string;
  kind: UnlockKind;
  cardId?: string;
  approvalId?: string;
  /** The booking a travel details read was for (Go's flight booking run id). */
  bookingRef?: string;
  tripId?: string;
  amountMinor?: number;
  currency?: string;
  merchant?: string;
  passkeyOk?: boolean;
  approvalOk?: boolean;
  rail?: string;
  railRef?: string;
  reason?: string;
}

export interface UnlockRow {
  at: Date;
  kind: UnlockKind;
  amount_minor: number | null;
  currency: string | null;
  merchant: string | null;
  reason: string | null;
}

/** Every unlock is written down: who, which card, the amount, the merchant, when. */
export async function logUnlock(db: Db, at: Date, e: UnlockEntry): Promise<void> {
  await db.query(
    `insert into unlock_log (person_id, at, kind, card_id, approval_id, trip_id, amount_minor, currency, merchant,
       passkey_ok, approval_ok, rail, rail_ref, reason, booking_ref)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      e.personId, at, e.kind, e.cardId ?? null, e.approvalId ?? null, e.tripId ?? null,
      e.amountMinor ?? null, e.currency ?? null, e.merchant ?? null, e.passkeyOk ?? null, e.approvalOk ?? null,
      e.rail ?? null, e.railRef ?? null, e.reason ?? null, e.bookingRef ?? null,
    ],
  );
}

/** When Go last read a person's travel details for a booking, and what for: their page shows it. */
export async function lastTravelRead(db: Db, personId: string): Promise<{ at: Date; purpose: string | null } | null> {
  const r = await db.query<{ at: Date; reason: string | null }>(
    "select at, reason from unlock_log where person_id = $1 and kind = 'travel_read' order by at desc, id desc limit 1",
    [personId],
  );
  const row = r.rows[0];
  return row ? { at: row.at, purpose: row.reason } : null;
}

export async function readUnlockLog(db: Db, personId: string, limit = 20): Promise<UnlockRow[]> {
  const r = await db.query<UnlockRow>(
    'select at, kind, amount_minor, currency, merchant, reason from unlock_log where person_id = $1 order by at desc, id desc limit $2',
    [personId, limit],
  );
  return r.rows;
}
