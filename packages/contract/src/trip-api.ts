import { z } from 'zod';
import { AmountMinor, Currency, Id, IsoDate, IsoDateTime } from './common.js';

/**
 * The trip API: go-server's routes that Go's tools call (go-brain → go-server).
 * go-server is the source of truth for every trip record; go-brain keeps none of them.
 */

export const BudgetBand = z.object({ min_minor: AmountMinor, max_minor: AmountMinor, currency: Currency });

export const TripMember = z.object({
  id: Id,
  name: z.string().min(1).max(80),
  role: z.enum(['organizer', 'member']),
  from_city: z.string().max(60).optional(),
  earliest_leave: z.string().max(60).optional(),
  /** "Anything Go should know" chips, as plain words. */
  notes: z.array(z.string().max(80)).max(20).default([]),
  has_upi: z.boolean(),
  /** Set only for people signed in with Vestra (organizer, payers): needed for the vault. */
  vestra_user_id: z.string().max(64).nullable().default(null),
});

export const DecisionOption = z.object({
  label: z.string().min(1).max(120),
  image_url: z.url().optional(),
  price_minor: AmountMinor.optional(),
  currency: Currency.optional(),
  ref: z.string().max(200).optional(),
});

export const Mandate = z.object({
  choice_index: z.int().nonnegative(),
  cap_minor: AmountMinor,
  currency: Currency,
  refundable_only: z.boolean().default(true),
  payer_member_id: Id,
});

export const Decision = z.object({
  id: Id,
  question: z.string().max(200),
  kind: z.enum(['choice', 'budget', 'yesno']),
  anonymous: z.boolean(),
  status: z.enum(['open', 'closed', 'cancelled']),
  closes_at: IsoDateTime.optional(),
  options: z.array(DecisionOption).max(10),
  /** For choice decisions once closed: the winning option. */
  result_index: z.int().nonnegative().optional(),
  /** Vote counts per option (never who voted, for anonymous ones). */
  tally: z.array(z.int().nonnegative()).default([]),
  mandate: Mandate.optional(),
});

export const Booking = z.object({
  id: Id,
  kind: z.enum(['stay', 'flight', 'train', 'bus', 'table', 'activity', 'car', 'other']),
  title: z.string().max(120),
  vendor: z.string().max(80),
  ref: z.string().max(80),
  amount_minor: AmountMinor,
  currency: Currency,
  refundable_until: IsoDateTime.optional(),
  payer_member_id: Id,
  decision_id: Id.optional(),
  source: z.enum(['ixigo', 'browser', 'call', 'api']),
});

export const TripState = z.object({
  id: Id,
  title: z.string().max(80),
  destination: z.string().max(80).optional(),
  dates: z.object({ start: IsoDate, end: IsoDate }).optional(),
  vibe: z.array(z.string().max(40)).max(12).default([]),
  stay: z.string().max(60).optional(),
  /** Only the lowest band anyone picked, and how many answered: never who picked what. */
  budget: z.object({ lowest: BudgetBand.nullable(), answered: z.int().nonnegative(), of: z.int().nonnegative() }),
  members: z.array(TripMember).max(30),
  decisions: z.array(Decision).max(50),
  bookings: z.array(Booking).max(50),
  money: z.object({ total_minor: AmountMinor, currency: Currency, each_minor: AmountMinor }),
});
export type TripState = z.infer<typeof TripState>;

export const UpdateTrip = z
  .object({
    destination: z.string().max(80),
    dates: z.object({ start: IsoDate, end: IsoDate }),
    vibe: z.array(z.string().max(40)).max(12),
    stay: z.string().max(60),
    /** Day-by-day plan as plain lines; go-server renders the Itinerary from it. */
    itinerary: z.array(
      z.object({
        date: IsoDate,
        title: z.string().max(80),
        items: z.array(z.object({ time: z.string().max(10), title: z.string().max(120), place: z.string().max(120).optional() })).max(12),
      }),
    ).max(14),
  })
  .partial();

export const OpenDecision = z.object({
  question: z.string().min(1).max(200),
  kind: z.enum(['choice', 'budget', 'yesno']),
  anonymous: z.boolean().default(false),
  options: z.array(DecisionOption).min(2).max(10),
  closes_at: IsoDateTime.optional(),
});
export const OpenDecisionResult = z.object({ decision_id: Id });

export const CloseDecisionResult = z.object({ decision: Decision });

export const SetMandate = Mandate;
export const Ok = z.object({ ok: z.literal(true) });

export const RecordBooking = Booking.omit({ id: true });
export const RecordBookingResult = z.object({ booking_id: Id });

export const AddExpense = z.object({
  paid_by_member_id: Id,
  amount_minor: AmountMinor,
  currency: Currency,
  note: z.string().min(1).max(120),
  /** Members who share this cost equally. */
  split_member_ids: z.array(Id).min(1),
});
export const AddExpenseResult = z.object({ expense_id: Id });

export const SettleUpResult = z.object({
  transfers: z.array(z.object({ from_member_id: Id, to_member_id: Id, amount_minor: AmountMinor, currency: Currency })),
});

export const RecordCall = z.object({
  asked_by_member_id: Id,
  business: z.string().max(80),
  goal: z.string().max(160),
  outcome: z.string().max(1000),
  transcript: z.array(z.object({ who: z.enum(['go', 'them']), text: z.string().max(1000) })).max(400),
  started_at: IsoDateTime,
  ended_at: IsoDateTime,
});
export const RecordCallResult = z.object({ call_id: Id });

/** Go asks go-server whether a payment may happen. go-server runs the spend check. */
export const SpendApprovalRequest = z.object({
  decision_id: Id,
  amount_minor: AmountMinor.refine((n) => n > 0, 'must be more than zero'),
  currency: Currency,
  merchant: z.string().min(1).max(120),
  purpose: z.string().min(1).max(200),
});
export const SpendApprovalResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('approved'), approval: z.string().min(1) }),
  z.object({
    status: z.literal('denied'),
    reason: z.enum(['no_closed_decision', 'no_mandate', 'over_cap', 'no_payer_yes', 'not_refundable', 'payer_has_no_vestra_account']),
    detail: z.string().max(200).optional(),
  }),
]);
