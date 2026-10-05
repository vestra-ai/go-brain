import { z } from 'zod';
import { AmountMinor, Category, Currency, HttpUrl, Id, IsoDate, IsoDateTime, Journey, Place, PositiveAmountMinor, Seq } from './common.js';
import { BookingKind, Day, Decision, DecisionOption, Proof } from './trip.js';

/**
 * The bodies of the calls go-brain makes to go-server (go-server serves them under /brain/v1).
 * Every write carries `request_id`: go-server must do the write once even if the same request
 * arrives twice, and answer the repeat with the first answer.
 */

const request_id = Id;

/** What every write answers with, plus any new id. */
export const WriteResult = z.object({ seq: Seq }).meta({ id: 'WriteResult' });

export const UpdateTrip = z
  .object({
    request_id,
    title: z.string().min(1).max(80).nullish(),
    destination: Place.nullish(),
    dates: z.object({ start: IsoDate, end: IsoDate }).nullish(),
    vibe: z.array(z.string().min(1).max(40)).max(12).nullish(),
    stay: z.string().max(60).nullish(),
    /** Replaces the whole itinerary. */
    itinerary: z.array(Day).max(30).nullish(),
  })
  .meta({ id: 'UpdateTrip', description: 'Only the fields sent change.' });

export const OpenDecision = z
  .object({
    request_id,
    question: z.string().min(1).max(200),
    kind: z.enum(['choice', 'yesno']),
    anonymous: z.boolean(),
    options: z.array(DecisionOption).min(2).max(10),
    closes_at: IsoDateTime.nullish(),
  })
  .meta({ id: 'OpenDecision', description: 'Opens a vote. Go then posts a message with a vote card to show it in the room.' });
export const OpenDecisionResult = z.object({ decision_id: Id, seq: Seq }).meta({ id: 'OpenDecisionResult' });

export const CloseDecision = z.object({ request_id }).meta({ id: 'CloseDecision' });
export const CloseDecisionResult = z.object({ decision: Decision, seq: Seq }).meta({ id: 'CloseDecisionResult' });

export const SetMandate = z
  .object({
    request_id,
    choice_index: z.int().nonnegative(),
    cap_minor: PositiveAmountMinor,
    currency: Currency,
    refundable_only: z.boolean(),
    payer_person_id: Id,
  })
  .meta({
    id: 'SetMandate',
    description: 'Sets (or replaces) what the group allowed for a closed choice vote. Replacing clears the payer\'s earlier yes or no.',
  });

export const AddRecordLine = z
  .object({
    request_id,
    /** Go writes only these three kinds. Decided and booked lines come from votes and bookings. */
    kind: z.enum(['agreed', 'open', 'doing']),
    text: z.string().min(1).max(200),
    /** The messages this came from. An agreed line needs at least one. */
    proof: z.array(Proof).max(10),
    person_ids: z.array(Id).max(30),
    due_at: IsoDateTime.nullish(),
  })
  .meta({ id: 'AddRecordLine' });
export const AddRecordLineResult = z.object({ line_id: Id, seq: Seq }).meta({ id: 'AddRecordLineResult' });

export const UpdateRecordLine = z
  .object({
    request_id,
    /** E.g. an open question that got settled becomes agreed. */
    kind: z.enum(['agreed', 'open', 'doing']).nullish(),
    text: z.string().min(1).max(200).nullish(),
    status: z.enum(['active', 'done']).nullish(),
    /** Replaces the proof list. */
    proof: z.array(Proof).max(10).nullish(),
    person_ids: z.array(Id).max(30).nullish(),
    due_at: IsoDateTime.nullish(),
  })
  .meta({ id: 'UpdateRecordLine', description: 'Only the fields sent change. Go cannot undo a line; only people can.' });

export const AddBooking = z
  .object({
    request_id,
    kind: BookingKind,
    title: z.string().min(1).max(120),
    vendor: z.string().min(1).max(80),
    ref: z.string().min(1).max(80),
    amount_minor: AmountMinor,
    currency: Currency,
    payer_person_id: Id,
    for_person_ids: z.array(Id).min(1).max(30),
    refundable_until: IsoDateTime.nullish(),
    starts_at: IsoDateTime.nullish(),
    ends_at: IsoDateTime.nullish(),
    journey: Journey.nullish(),
    place: Place.nullish(),
    image_url: HttpUrl.nullish(),
    decision_id: Id.nullish(),
    /** Required when Go paid through the vault. go-server marks that approval used. */
    approval_id: Id.nullish(),
  })
  .meta({ id: 'AddBooking' });
export const AddBookingResult = z.object({ booking_id: Id, seq: Seq }).meta({ id: 'AddBookingResult' });

export const UpdateBooking = z
  .object({
    request_id,
    status: z.literal('cancelled').nullish(),
    ref: z.string().min(1).max(80).nullish(),
    refundable_until: IsoDateTime.nullish(),
    starts_at: IsoDateTime.nullish(),
    ends_at: IsoDateTime.nullish(),
  })
  .meta({ id: 'UpdateBooking', description: 'Only the fields sent change.' });

export const AddExpense = z
  .object({
    request_id,
    paid_by_person_id: Id,
    amount_minor: PositiveAmountMinor,
    currency: Currency,
    note: z.string().min(1).max(120),
    category: Category,
    split_person_ids: z.array(Id).min(1).max(30),
    booking_id: Id.nullish(),
  })
  .meta({ id: 'AddExpense' });
export const AddExpenseResult = z.object({ expense_id: Id, seq: Seq }).meta({ id: 'AddExpenseResult' });

/** Go asks go-server whether a payment may happen. go-server runs the spend check. */
export const RequestSpendApproval = z
  .object({
    request_id,
    decision_id: Id,
    /** The most this payment may be. The vault refuses a checkout above it. */
    amount_minor: PositiveAmountMinor,
    currency: Currency,
    merchant: z.string().min(1).max(120),
    purpose: z.string().min(1).max(200),
    /** When free cancellation ends. Required when the mandate is refundable only. */
    refundable_until: IsoDateTime.nullish(),
  })
  .meta({ id: 'RequestSpendApproval' });

/** Go releases an approval it will not use, so the next one is not refused as outstanding. */
export const CancelSpendApproval = z
  .object({
    request_id,
    reason: z.enum(['payment_failed', 'payer_declined', 'price_changed', 'expired', 'other']),
  })
  .meta({ id: 'CancelSpendApproval' });

export const SpendDenialReason = z
  .enum([
    'decision_not_found',
    'decision_not_closed',
    'no_mandate',
    'payer_has_not_confirmed',
    'payer_declined',
    'over_cap',
    'currency_mismatch',
    'not_refundable',
    'approval_outstanding',
  ])
  .meta({ id: 'SpendDenialReason' });

export const SpendApproved = z
  .object({
    status: z.literal('approved'),
    /** The approval's `jti`. Send it back on the booking. */
    approval_id: Id,
    /** The signed token for the vault. */
    approval: z.string().min(1).max(4096),
    expires_at: IsoDateTime,
  })
  .meta({ id: 'SpendApproved' });
export const SpendDenied = z
  .object({ status: z.literal('denied'), reason: SpendDenialReason, detail: z.string().max(200).nullish() })
  .meta({ id: 'SpendDenied' });

export const SpendApprovalResult = z
  .discriminatedUnion('status', [SpendApproved, SpendDenied])
  .meta({ id: 'SpendApprovalResult', discriminator: { propertyName: 'status' } });
