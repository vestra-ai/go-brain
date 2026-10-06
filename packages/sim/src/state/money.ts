// Bookings, expenses, the money maths and spend approvals, with the Server's rules from
// docs/guide/04-gos-requests.md and docs/guide/08-money-and-the-vault.md. Approvals are signed with the key the
// FakeServer is given: the contract's TEST key by default. Dev and tests only; the real Server uses its own key.
import { MAX_APPROVAL_TTL_SECONDS, signSpendApproval } from '@go/contract';
import type * as C from '@go/contract';
import type { z } from 'zod';
import { fail, type Booking, type Change, type Expense, type Params, type RecordLine, type TripState } from './trip-state.js';

type SpendResult = z.infer<typeof C.SpendApprovalResult>;
type DenialReason = z.infer<typeof C.SpendDenialReason>;

const DETAIL: Record<DenialReason, string> = {
  decision_not_found: 'the vote is not in this trip',
  decision_not_closed: 'the vote is still open, or it was called off',
  no_mandate: 'the vote has no mandate',
  payer_declined: 'the payer tapped Not now',
  payer_has_not_confirmed: 'the payer has not tapped Yes, book it',
  currency_mismatch: "the currency is not the mandate's currency",
  over_cap: "the amount is above the mandate's cap",
  not_refundable: 'the mandate is refundable only, and refundable_until is missing or past',
  approval_outstanding: 'another approval for this vote is still waiting',
};

/** Copies the fields that are set, so a missing field stays missing (never undefined). */
function present<T extends object, K extends keyof T>(o: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const k of keys) if (o[k] != null) out[k] = o[k];
  return out;
}

export function addBooking(s: TripState, p: Params<typeof C.AddBooking>): Change<{ booking_id: string; seq: number }> {
  s.person(p.payer_person_id, 'payer_person_id');
  s.people(p.for_person_ids, 'for_person_ids');
  if (p.decision_id != null && !s.decision(p.decision_id)) throw fail('invalid', `decision_id: ${p.decision_id} is not a vote in this trip`);
  s.currency(p.currency, 'currency');
  const approval = p.approval_id != null ? s.approvals.get(p.approval_id) : undefined;
  if (p.approval_id != null) {
    if (!approval) throw fail('conflict', `approval ${p.approval_id} is not for this trip`);
    if (approval.decision_id !== p.decision_id) throw fail('conflict', `approval ${p.approval_id} is for another vote`);
    if (approval.used || approval.cancelled) throw fail('conflict', `approval ${p.approval_id} is already used or cancelled`);
    if (p.amount_minor > approval.amount_minor || p.currency !== approval.currency) {
      throw fail('conflict', `the booking is more than approval ${p.approval_id} allows`);
    }
  }
  // An expired approval is not refused: the vault checked the expiry before it paid.
  if (approval) approval.used = true;
  const at = s.now().toISOString();
  const booking: Booking = {
    booking_id: s.mint('b_'),
    kind: p.kind,
    status: 'confirmed',
    title: p.title,
    vendor: p.vendor,
    ref: p.ref,
    amount_minor: p.amount_minor,
    currency: p.currency,
    payer_person_id: p.payer_person_id,
    for_person_ids: p.for_person_ids,
    ...present(p, ['refundable_until', 'starts_at', 'ends_at', 'journey', 'place', 'image_url', 'decision_id', 'approval_id']),
    created_at: at,
  };
  s.trip.bookings.push(booking);
  const events = [s.bump('booking.changed', { booking: structuredClone(booking), change: 'added', by: { kind: 'go' } })];
  // The booked line: the vote's decided line becomes it (same line_id), or a new line is added. A second change, by system.
  const decided = p.decision_id != null
    ? s.trip.record.find((l) => l.kind === 'decided' && l.decision_id === p.decision_id && l.status !== 'undone')
    : undefined;
  if (decided) {
    decided.kind = 'booked';
    decided.text = booking.title;
    decided.booking_id = booking.booking_id;
    decided.source = 'booking';
    decided.updated_at = at;
    events.push(s.bump('record.changed', { line: structuredClone(decided), change: 'updated', by: { kind: 'system' } }));
  } else {
    const line: RecordLine = {
      line_id: s.mint('r_'),
      kind: 'booked',
      text: booking.title,
      status: 'active',
      proof: [],
      person_ids: [],
      ...(p.decision_id != null ? { decision_id: p.decision_id } : {}),
      booking_id: booking.booking_id,
      source: 'booking',
      created_at: at,
      updated_at: at,
    };
    s.trip.record.push(line);
    events.push(s.bump('record.changed', { line: structuredClone(line), change: 'added', by: { kind: 'system' } }));
  }
  return { result: { booking_id: booking.booking_id, seq: events[0]!.seq }, events };
}

export function updateBooking(s: TripState, p: Params<typeof C.UpdateBooking>): Change<{ seq: number }> {
  const b = s.booking(p.booking_id);
  if (!b) throw fail('not_found', `booking ${p.booking_id} is not in this trip`);
  if (b.status === 'cancelled') throw fail('conflict', `booking ${p.booking_id} is cancelled`);
  if (p.status == null && p.ref == null && p.refundable_until == null && p.starts_at == null && p.ends_at == null) {
    throw fail('invalid', 'send at least one field to change besides request_id, trip_id and booking_id');
  }
  if (p.status != null) b.status = p.status;
  if (p.ref != null) b.ref = p.ref;
  if (p.refundable_until != null) b.refundable_until = p.refundable_until;
  if (p.starts_at != null) b.starts_at = p.starts_at;
  if (p.ends_at != null) b.ends_at = p.ends_at;
  const ev = s.bump('booking.changed', { booking: structuredClone(b), change: p.status === 'cancelled' ? 'cancelled' : 'updated', by: { kind: 'go' } });
  return { result: { seq: ev.seq }, events: [ev] };
}

export function addExpense(s: TripState, p: Params<typeof C.AddExpense>): Change<{ expense_id: string; seq: number }> {
  s.person(p.paid_by_person_id, 'paid_by_person_id');
  s.people(p.split_person_ids, 'split_person_ids');
  if (p.booking_id != null && !s.booking(p.booking_id)) throw fail('invalid', `booking_id: ${p.booking_id} is not a booking in this trip`);
  s.currency(p.currency, 'currency');
  const expense: Expense = {
    expense_id: s.mint('e_'),
    paid_by_person_id: p.paid_by_person_id,
    amount_minor: p.amount_minor,
    currency: p.currency,
    note: p.note,
    category: p.category,
    split_person_ids: p.split_person_ids,
    ...(p.booking_id != null ? { booking_id: p.booking_id } : {}),
    created_at: s.now().toISOString(),
  };
  s.trip.expenses.push(expense);
  recomputeMoney(s);
  const ev = s.bump('expense.changed', { expense: structuredClone(expense), change: 'added', by: { kind: 'go' } });
  return { result: { expense_id: expense.expense_id, seq: ev.seq }, events: [ev] };
}

/** The Server's money maths: what was spent, by category, and the fewest transfers that square everyone up. */
export function recomputeMoney(s: TripState): void {
  const m = s.trip.money;
  const expenses = s.trip.expenses;
  m.spent_minor = expenses.reduce((sum, e) => sum + e.amount_minor, 0);
  const byCategory = new Map<Expense['category'], number>();
  for (const e of expenses) byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + e.amount_minor);
  m.by_category = [...byCategory].map(([category, amount_minor]) => ({ category, amount_minor }));
  // Each expense is split equally; the payer keeps any paise that do not split evenly.
  const balance = new Map<string, number>();
  const add = (id: string, amount: number): void => {
    balance.set(id, (balance.get(id) ?? 0) + amount);
  };
  for (const e of expenses) {
    const share = Math.floor(e.amount_minor / e.split_person_ids.length);
    for (const id of e.split_person_ids) add(id, -share);
    add(e.paid_by_person_id, share * e.split_person_ids.length);
  }
  const owes = [...balance].filter(([, v]) => v < 0).map(([id, v]) => ({ id, left: -v })).sort((a, b) => b.left - a.left);
  const owed = [...balance].filter(([, v]) => v > 0).map(([id, v]) => ({ id, left: v })).sort((a, b) => b.left - a.left);
  const transfers: typeof m.transfers = [];
  for (const debtor of owes) {
    for (const creditor of owed) {
      if (debtor.left === 0) break;
      if (creditor.left === 0) continue;
      const amount = Math.min(debtor.left, creditor.left);
      transfers.push({ from_person_id: debtor.id, to_person_id: creditor.id, amount_minor: amount, currency: m.currency });
      debtor.left -= amount;
      creditor.left -= amount;
    }
  }
  m.transfers = transfers.slice(0, 60);
}

/** The spend check in the guide's order (docs/guide/08-money-and-the-vault.md): the first rule that fails gives the reason. */
export function spendCheck(s: TripState, p: Params<typeof C.RequestSpendApproval>): DenialReason | null {
  const d = s.decision(p.decision_id);
  if (!d) return 'decision_not_found';
  if (d.status !== 'closed') return 'decision_not_closed';
  const m = d.mandate;
  if (d.kind !== 'choice' || !m) return 'no_mandate';
  if (m.declined_at != null && (m.confirmed_at == null || Date.parse(m.declined_at) > Date.parse(m.confirmed_at))) return 'payer_declined';
  if (m.confirmed_at == null) return 'payer_has_not_confirmed';
  if (p.currency !== m.currency) return 'currency_mismatch';
  if (p.amount_minor > m.cap_minor) return 'over_cap';
  const now = s.now().getTime();
  if (m.refundable_only && !(p.refundable_until != null && Date.parse(p.refundable_until) > now)) return 'not_refundable';
  for (const a of s.approvals.values()) {
    if (a.decision_id === d.decision_id && !a.used && !a.cancelled && a.expires_at.getTime() > now) return 'approval_outstanding';
  }
  return null;
}

export function requestSpendApproval(s: TripState, p: Params<typeof C.RequestSpendApproval>, privateKeyPem: string): Change<SpendResult> {
  const reason = spendCheck(s, p);
  if (reason) return { result: { status: 'denied', reason, detail: DETAIL[reason] }, events: [] };
  const d = s.decision(p.decision_id)!;
  const m = d.mandate!;
  const iat = Math.floor(s.now().getTime() / 1000);
  const exp = iat + MAX_APPROVAL_TTL_SECONDS;
  const approvalId = s.mint('ap_sim_');
  const approval = signSpendApproval(
    {
      iss: 'server',
      aud: 'go-vault',
      jti: approvalId,
      trip_id: s.id,
      decision_id: d.decision_id,
      payer_person_id: m.payer_person_id, // always the mandate's payer, never anything from the request
      amount_minor: p.amount_minor,
      currency: p.currency,
      merchant: p.merchant,
      purpose: p.purpose,
      ...(p.refundable_until != null ? { refundable_until: p.refundable_until } : {}),
      iat,
      exp,
    },
    privateKeyPem,
  );
  const expiresAt = new Date(exp * 1000);
  s.approvals.set(approvalId, {
    approval_id: approvalId,
    decision_id: d.decision_id,
    payer_person_id: m.payer_person_id,
    amount_minor: p.amount_minor,
    currency: p.currency,
    expires_at: expiresAt,
    used: false,
    cancelled: false,
  });
  return { result: { status: 'approved', approval_id: approvalId, approval, expires_at: expiresAt.toISOString() }, events: [] };
}

/** Releases an approval. Already used, cancelled or expired: still { ok: true }, and nothing changes. */
export function cancelSpendApproval(s: TripState, p: Params<typeof C.CancelSpendApproval>): Change<{ ok: true }> {
  const a = s.approvals.get(p.approval_id);
  if (!a) throw fail('not_found', `approval ${p.approval_id} is not in this trip`);
  if (!a.used && !a.cancelled && a.expires_at.getTime() > s.now().getTime()) a.cancelled = true;
  return { result: { ok: true }, events: [] };
}
