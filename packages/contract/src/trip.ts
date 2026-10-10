import { z } from 'zod';
import { AmountMinor, Category, Currency, HttpUrl, Id, IsoDate, IsoDateTime, Journey, Photo, Place, PositiveAmountMinor, Seq } from './common.js';
import { OptionDetails, RoomType } from './cards.js';
import { BudgetSummary, Person } from './people.js';

/**
 * The trip as the Server holds it. The Server is the source of truth for everything here; Go
 * keeps only a copy it refreshes by change number (`seq`).
 */

export const DecisionOption = z
  .object({
    label: z.string().min(1).max(120),
    image_url: HttpUrl.nullish(),
    price_minor: AmountMinor.nullish(),
    currency: Currency.nullish(),
    /** Go's own reference for this option (e.g. an ixigo offer), so it can book the winner. */
    option_ref: z.string().max(200).nullish(),
    note: z.string().max(120).nullish(),
    /** 1.1: what the App shows when the option is opened, as on an options card's option. */
    details: OptionDetails.nullish(),
    /** 10 Oct B3, B4: as on an options card's option. */
    photos: z.array(Photo).max(12).nullish(),
    price_min_minor: AmountMinor.nullish(),
    price_max_minor: AmountMinor.nullish(),
    room_types: z.array(RoomType).max(10).nullish(),
  })
  .meta({ id: 'DecisionOption' });

/** What the group allowed for a spend: the choice, the cap, refundable or not, and who pays. */
export const Mandate = z
  .object({
    choice_index: z.int().nonnegative(),
    cap_minor: AmountMinor,
    currency: Currency,
    refundable_only: z.boolean(),
    payer_person_id: Id,
    set_at: IsoDateTime,
    /** When the payer tapped "Yes, book it". */
    confirmed_at: IsoDateTime.nullish(),
    /** When the payer tapped "Not now". A new mandate clears it. */
    declined_at: IsoDateTime.nullish(),
  })
  .meta({ id: 'Mandate' });
export type Mandate = z.infer<typeof Mandate>;

export const Decision = z
  .object({
    decision_id: Id,
    question: z.string().min(1).max(200),
    kind: z.enum(['choice', 'yesno']),
    /** Anonymous votes show totals only: never who voted for what, to anyone, including Go. */
    anonymous: z.boolean(),
    status: z.enum(['open', 'closed', 'cancelled']),
    /** Null when Go opened it. */
    opened_by_person_id: Id.nullish(),
    options: z.array(DecisionOption).min(2).max(10),
    closes_at: IsoDateTime.nullish(),
    voted: z.int().nonnegative(),
    of: z.int().nonnegative(),
    /** Votes per option, in option order. */
    tally: z.array(z.int().nonnegative()).max(10),
    /** 1.1: how many said "I'm flexible": counted in `voted`, never in the tally. */
    flexible_count: z.int().nonnegative().nullish(),
    /** Who voted for what. Left out when the vote is anonymous. */
    votes: z.array(z.object({ person_id: Id, option_index: z.int().nonnegative() })).max(30).nullish(),
    /** The winning option, once closed. Null when nobody voted or the top options tied: Go then asks the group. */
    result_index: z.int().nonnegative().nullish(),
    mandate: Mandate.nullish(),
    opened_at: IsoDateTime,
    closed_at: IsoDateTime.nullish(),
  })
  .meta({ id: 'Decision' });
export type Decision = z.infer<typeof Decision>;

/** 1.1: who sees an itinerary item. group: everyone in the trip. shared: the people it names (person_ids). private: one person. */
export const Audience = z.enum(['group', 'shared', 'private']).meta({ id: 'Audience' });

/** 1.1: one more line about a booking, e.g. { "label": "Room", "value": "2 Deluxe, breakfast included" }. */
export const BookingDetail = z.object({ label: z.string().min(1).max(40), value: z.string().min(1).max(200) }).meta({ id: 'BookingDetail' });

/** 1.1: one traveller on a booking, with their seat and PNR when the booking has them. */
export const Passenger = z
  .object({ person_id: Id, seat: z.string().min(1).max(20).nullish(), pnr: z.string().min(1).max(40).nullish() })
  .meta({ id: 'Passenger' });

/**
 * 1.1: a booking's document (a ticket, a voucher). `url` is Go's signed link, valid at least 10 minutes: the Server
 * fetches it once, keeps its own copy, and serves that copy. `visibility`: covered, only the people the booking covers;
 * group, everyone in the trip.
 */
export const BookingDocument = z
  .object({
    document_id: Id,
    name: z.string().min(1).max(200),
    mime: z.string().min(1).max(100),
    size_bytes: z.int().nonnegative(),
    pages: z.int().positive().nullish(),
    visibility: z.enum(['covered', 'group']),
    url: HttpUrl,
  })
  .meta({ id: 'BookingDocument' });

export const BookingKind = z
  .enum(['stay', 'flight', 'train', 'bus', 'cab', 'table', 'activity', 'other'])
  .meta({ id: 'BookingKind' });

export const Booking = z
  .object({
    booking_id: Id,
    kind: BookingKind,
    status: z.enum(['confirmed', 'cancelled']),
    title: z.string().min(1).max(120),
    vendor: z.string().min(1).max(80),
    /** PNR or confirmation number. */
    ref: z.string().min(1).max(80),
    amount_minor: AmountMinor,
    currency: Currency,
    payer_person_id: Id,
    /** Who this booking covers. */
    for_person_ids: z.array(Id).min(1).max(30),
    refundable_until: IsoDateTime.nullish(),
    starts_at: IsoDateTime.nullish(),
    ends_at: IsoDateTime.nullish(),
    journey: Journey.nullish(),
    place: Place.nullish(),
    image_url: HttpUrl.nullish(),
    decision_id: Id.nullish(),
    /** The spend approval it was paid with, when Go paid through the vault. */
    approval_id: Id.nullish(),
    /** Null when Go added it. */
    added_by_person_id: Id.nullish(),
    created_at: IsoDateTime,
    /** 1.1: more lines for the ticket. */
    details: z.array(BookingDetail).max(20).nullish(),
    /** 1.1: the way back, for a round trip. */
    return_journey: Journey.nullish(),
    /** 1.1: each traveller, with a seat and PNR when there are. */
    passengers: z.array(Passenger).max(30).nullish(),
    /** 1.1: tickets and vouchers, as the Server keeps them. */
    documents: z.array(BookingDocument).max(10).nullish(),
  })
  .meta({ id: 'Booking' });
export type Booking = z.infer<typeof Booking>;

/**
 * 1.1, withdrawn on 10 Oct (the Server no longer asks anyone to agree to an expense): where one person stood on an
 * expense they share. Kept so an older Server's answer still reads.
 */
export const ExpenseConfirmation = z
  .object({
    person_id: Id,
    state: z.enum(['pending', 'approved', 'disputed']),
    /** When they answered. Optional here: a pending one may have no time yet. */
    at: IsoDateTime.nullish(),
    /** Why they disputed it, in their words. */
    reason: z.string().min(1).max(200).nullish(),
  })
  .meta({ id: 'ExpenseConfirmation' });

export const Expense = z
  .object({
    expense_id: Id,
    paid_by_person_id: Id,
    amount_minor: AmountMinor,
    currency: Currency,
    note: z.string().min(1).max(120),
    category: Category,
    /** Who shares this cost, equally. */
    split_person_ids: z.array(Id).min(1).max(30),
    booking_id: Id.nullish(),
    /** Null when Go added it. */
    added_by_person_id: Id.nullish(),
    created_at: IsoDateTime,
    /** 1.1, withdrawn: the Server no longer sends it, and every expense counts from when it is added. */
    status: z.enum(['pending', 'approved', 'disputed']).nullish(),
    /** 1.1, withdrawn, as status. */
    confirmations: z.array(ExpenseConfirmation).max(30).nullish(),
  })
  .meta({ id: 'Expense' });
export type Expense = z.infer<typeof Expense>;

/**
 * 1.1: a payback someone recorded between two people. It counts once recorded (there is no confirming step since 10 Oct),
 * so its status is always confirmed and confirmed_at is when it was recorded. read_trip's money.transfers already counts it.
 */
export const Settlement = z
  .object({
    settlement_id: Id,
    from_person_id: Id,
    to_person_id: Id,
    amount_minor: PositiveAmountMinor,
    currency: Currency,
    method: z.enum(['upi', 'cash', 'bank_transfer', 'other']),
    note: z.string().min(1).max(200).nullish(),
    status: z.literal('confirmed'),
    recorded_at: IsoDateTime.nullish(),
    confirmed_at: IsoDateTime,
  })
  .meta({ id: 'Settlement' });
export type Settlement = z.infer<typeof Settlement>;

export const Transfer = z
  .object({ from_person_id: Id, to_person_id: Id, amount_minor: AmountMinor, currency: Currency })
  .meta({ id: 'Transfer' });

/** The Server does all the money maths. Go reads it from here. A trip has one currency: every amount in it uses `currency`. */
export const Money = z
  .object({
    currency: Currency,
    /** The trip's plan in total, if the organizer set one. */
    plan_minor: AmountMinor.nullish(),
    spent_minor: AmountMinor,
    by_category: z.array(z.object({ category: Category, amount_minor: AmountMinor })).max(5),
    /** The fewest payments that square everyone up right now. */
    transfers: z.array(Transfer).max(60),
  })
  .meta({ id: 'Money' });

export const ItineraryItem = z
  .object({
    item_id: Id.nullish(),
    /** Local time at the destination, "HH:MM". */
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullish(),
    title: z.string().min(1).max(120),
    category: Category,
    place: Place.nullish(),
    booking_id: Id.nullish(),
    status: z.enum(['booked', 'planned', 'idea']),
    note: z.string().max(200).nullish(),
    /** 1.1: the people it is for, when it is not the whole group. */
    person_ids: z.array(Id).max(30).nullish(),
    /** 1.1: who sees it. Absent means the group. */
    audience: Audience.nullish(),
  })
  .meta({ id: 'ItineraryItem' });

export const Day = z
  .object({
    date: IsoDate,
    title: z.string().max(80).nullish(),
    items: z.array(ItineraryItem).max(20),
    /** 1.1: a picture for the day. */
    image_url: HttpUrl.nullish(),
  })
  .meta({ id: 'Day' });

/** A message a record line came from, and who said it. */
export const Proof = z.object({ message_id: Id, person_id: Id.nullish() }).meta({ id: 'Proof' });

/**
 * The trip record: the trip's shared memory, one line per thing the group settled or still has to.
 *  - decided: a vote closed (the Server writes it from the decision)
 *  - booked: something is booked (the Server writes it from the booking)
 *  - agreed: the group agreed in the chat without a vote (Go writes it, with the messages as proof)
 *  - open: a question still to settle, and who is asked (Go writes it)
 *  - doing: someone said they will sort something (Go writes it)
 * Anyone can undo a line in the App.
 */
export const RecordLine = z
  .object({
    line_id: Id,
    kind: z.enum(['decided', 'agreed', 'open', 'doing', 'booked']),
    text: z.string().min(1).max(200),
    status: z.enum(['active', 'done', 'undone']),
    proof: z.array(Proof).max(10),
    /** agreed: who agreed. open: who is asked. doing: who is on it. */
    person_ids: z.array(Id).max(30),
    due_at: IsoDateTime.nullish(),
    /** Set on decided lines. */
    decision_id: Id.nullish(),
    /** Set on booked lines. */
    booking_id: Id.nullish(),
    source: z.enum(['go', 'person', 'vote', 'booking']),
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
  })
  .meta({ id: 'RecordLine' });
export type RecordLine = z.infer<typeof RecordLine>;

export const TripSnapshot = z
  .object({
    trip_id: Id,
    /** The change number this snapshot is at. */
    seq: Seq,
    title: z.string().min(1).max(80),
    status: z.enum(['planning', 'booked', 'on_trip', 'over']),
    created_at: IsoDateTime,
    organizer_person_id: Id,
    invite_url: HttpUrl,
    destination: Place.nullish(),
    dates: z.object({ start: IsoDate, end: IsoDate }).nullish(),
    vibe: z.array(z.string().min(1).max(40)).max(12),
    stay: z.string().max(60).nullish(),
    budget: BudgetSummary,
    people: z.array(Person).max(30),
    decisions: z.array(Decision).max(100),
    bookings: z.array(Booking).max(100),
    expenses: z.array(Expense).max(500),
    money: Money,
    itinerary: z.array(Day).max(30),
    record: z.array(RecordLine).max(300),
  })
  .meta({ id: 'TripSnapshot' });
export type TripSnapshot = z.infer<typeof TripSnapshot>;
