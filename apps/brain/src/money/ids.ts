import { createHash } from 'node:crypto';

/**
 * A deterministic id for a write or a card made outside a composer turn, from what triggered it:
 * rid('go_paid', approvalId, 'booking') is "go_paid_<approval_id>_booking". The same trigger always gives the
 * same id, so a repeated callback or tap does each write once. Ids are at most 64 characters (the contract's Id),
 * so a long one becomes the prefix plus a hash of its parts.
 */
export function rid(prefix: string, ...parts: string[]): string {
  const plain = [prefix, ...parts].join('_');
  if (plain.length <= 64) return plain;
  return `${prefix}_${createHash('sha256').update(parts.join('|')).digest('hex')}`.slice(0, 64);
}

/** One payment row per spend request id: a rerun of the same ask finds the same row. */
export function paymentIdFor(tripId: string, spendRequestId: string): string {
  return `pay_${createHash('sha256').update(`${tripId}|${spendRequestId}`).digest('hex').slice(0, 16)}`;
}
