import { z } from 'zod';
import { AmountMinor, Category, Currency, HttpUrl, Id, IsoDate, IsoDateTime, Journey, Place, PositiveAmountMinor, Seq } from './common.js';
import { BookingDetail, BookingDocument, BookingKind, Day, Decision, DecisionOption, Passenger, Proof } from './trip.js';

/**
 * Go's requests: what Go asks the Server over the socket, to read the trip or act in it.
 * The Server answers each one. Every request names its trip. Every write carries `request_id`:
 * The Server must do the write once even if the same request arrives twice, and answer the repeat
 * with the first answer.
 */

const request_id = Id;
const trip_id = Id;

/** Read the whole trip as Go may see it. */
export const ReadTrip = z.object({ trip_id }).meta({ id: 'ReadTrip' });

/** Messages posted or changed after a change number (updated_seq > after_seq), oldest change first. */
export const ReadMessages = z
  .object({ trip_id, after_seq: z.int().nonnegative(), limit: z.int().min(1).max(200).nullish() })
  .meta({ id: 'ReadMessages', description: 'Up to 200 at a time; 200 when limit is left out. The Server sends fewer, with has_more: true, when the answer would go over the 1 MB frame limit.' });

/** What every write answers with, plus any new id. */
export const WriteResult = z.object({ seq: Seq }).meta({ id: 'WriteResult' });

export const UpdateTrip = z
  .object({
    request_id,
    trip_id,
    title: z.string().min(1).max(80).nullish(),
    destination: Place.nullish(),
    dates: z.object({ start: IsoDate, end: IsoDate }).nullish(),
    vibe: z.array(z.string().min(1).max(40)).max(12).nullish(),
    stay: z.string().max(60).nullish(),
    /** Replaces the whole itinerary. */
    itinerary: z.array(Day).max(30).nullish(),
    /**
     * 1.1: the group's budget per person, in the trip's currency, when the group settled one in the chat. Go cannot
     * clear it: a person clears it in the App.
     */
    budget_per_person_minor: PositiveAmountMinor.nullish(),
  })
  .meta({ id: 'UpdateTrip', description: 'Only the fields sent change.' });

export const OpenDecision = z
  .object({
    request_id,
    trip_id,
    question: z.string().min(1).max(200),
    kind: z.enum(['choice', 'yesno']),
    anonymous: z.boolean(),
    options: z.array(DecisionOption).min(2).max(10),
    closes_at: IsoDateTime.nullish(),
  })
  .meta({ id: 'OpenDecision', description: 'Opens a vote. Go then posts a message with a vote card to show it in the room.' });
export const OpenDecisionResult = z.object({ decision_id: Id, seq: Seq }).meta({ id: 'OpenDecisionResult' });

export const CloseDecision = z.object({ request_id, trip_id, decision_id: Id }).meta({ id: 'CloseDecision' });
export const CloseDecisionResult = z.object({ decision: Decision, seq: Seq }).meta({ id: 'CloseDecisionResult' });

export const SetMandate = z
  .object({
    request_id,
    trip_id,
    decision_id: Id,
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
    trip_id,
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
    trip_id,
    line_id: Id,
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
    trip_id,
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
    /** Required when Go paid through the vault. The Server marks that approval used. */
    approval_id: Id.nullish(),
    /** 1.1: more lines for the ticket. */
    details: z.array(BookingDetail).max(20).nullish(),
    /** 1.1: the way back, for a round trip. */
    return_journey: Journey.nullish(),
    /** 1.1: each traveller, with a seat and PNR when there are. */
    passengers: z.array(Passenger).max(30).nullish(),
    /** 1.1: tickets and vouchers. The Server fetches each `url` once (Go's signed link) and keeps its own copy. */
    documents: z.array(BookingDocument).max(10).nullish(),
  })
  .meta({ id: 'AddBooking' });
export const AddBookingResult = z.object({ booking_id: Id, seq: Seq }).meta({ id: 'AddBookingResult' });

export const UpdateBooking = z
  .object({
    request_id,
    trip_id,
    booking_id: Id,
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
    trip_id,
    paid_by_person_id: Id,
    amount_minor: PositiveAmountMinor,
    currency: Currency,
    note: z.string().min(1).max(120),
    category: Category,
    split_person_ids: z.array(Id).min(1).max(30),
    booking_id: Id.nullish(),
    /**
     * 1.1: the spend approval this was paid with (its `jti`), when Go paid through the vault. The Server records such an
     * expense as approved at once; without it, a 1.1 Server records the expense pending, for the people it is split
     * between to approve or dispute.
     */
    approval_id: Id.nullish(),
  })
  .meta({ id: 'AddExpense' });
export const AddExpenseResult = z.object({ expense_id: Id, seq: Seq }).meta({ id: 'AddExpenseResult' });

const spendAsk = {
  request_id,
  trip_id,
  /** The most this payment may be. The vault refuses a checkout above it. */
  amount_minor: PositiveAmountMinor,
  currency: Currency,
  merchant: z.string().min(1).max(120),
  purpose: z.string().min(1).max(200),
  /** When free cancellation ends. Required when the mandate is refundable only. */
  refundable_until: IsoDateTime.nullish(),
};

/** The group's payment: a closed vote whose payer tapped "Yes, book it". */
export const RequestGroupSpendApproval = z.object({ ...spendAsk, decision_id: Id }).meta({ id: 'RequestGroupSpendApproval' });

/**
 * 1.2: a traveller's own ticket, which is never voted on (B7). No `decision_id`: the person it is for is the payer. The
 * Server grants it when that person is in the trip, signing `for_person_id` in place of `decision_id`.
 */
export const RequestTicketSpendApproval = z
  .object({ ...spendAsk, kind: z.literal('ticket'), for_person_id: Id })
  .meta({ id: 'RequestTicketSpendApproval' });

/**
 * Go asks the Server whether a payment may happen. The Server runs the spend check. The group's form names its vote;
 * 1.2's ticket form (`kind: "ticket"`) names the traveller instead.
 */
export const RequestSpendApproval = z
  .union([RequestTicketSpendApproval, RequestGroupSpendApproval])
  .meta({ id: 'RequestSpendApproval' });

/** Go releases an approval it will not use, so the next one is not refused as outstanding. */
export const CancelSpendApproval = z
  .object({
    request_id,
    trip_id,
    approval_id: Id,
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
    /** 1.2, the ticket form: the person it is for is not in the trip. */
    'not_in_trip',
    /** 1.2: the vote is booked already (a confirmed booking exists), so a second payment would charge twice. */
    'already_booked',
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

/** Go reacts to a message, for example a quiet ✅ when it noted something without saying anything. */
export const AddReaction = z
  .object({ request_id, trip_id, message_id: Id, emoji: z.string().min(1).max(16) })
  .meta({ id: 'AddReaction' });
/** Go takes its reaction back. */
export const RemoveReaction = z
  .object({ request_id, trip_id, message_id: Id, emoji: z.string().min(1).max(16) })
  .meta({ id: 'RemoveReaction' });
