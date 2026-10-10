import { z } from 'zod';
import { AmountMinor, Currency, HttpsUrl, HttpUrl, Id, IsoDate, IsoDateTime, Journey, Photo, Place } from './common.js';

/**
 * Cards are the rich things Go posts in the room. The same JSON travels from Go through
 * the Server to the App, unchanged.
 *
 * Two families:
 *  - Record cards carry only an id. The Server draws them from its own rows (a vote, a ticket, an
 *    expense), so the room and the Trip screens never disagree. The Server owns their buttons.
 *  - Go cards carry their content (options, live work, a call, a payment, a notice). Their buttons
 *    are `actions`: a tap is sent to Go, which answers (see the card action call).
 *
 * Every card has `fallback_text`: plain words an older App build shows if it cannot draw the kind.
 */

const base = {
  /** Go's id for the card. Go sends replace_card with the same id to update it in place. */
  card_id: Id,
  fallback_text: z.string().min(1).max(300),
  /**
   * People who need to act on this card. The Server sends them a push and pins the card for them
   * until it is settled.
   */
  for_person_ids: z.array(Id).max(30).nullish(),
};

export const CardAction = z
  .object({
    /** Lowercase words joined by underscores, e.g. "watch", "stop", "pick". */
    action_id: z.string().regex(/^[a-z][a-z_]{0,31}$/),
    label: z.string().min(1).max(24),
    style: z.enum(['primary', 'secondary']),
    /** Only these people see the button. Everyone sees it when absent. */
    only_for_person_ids: z.array(Id).max(30).nullish(),
    /** On an options card: show this button on every option and send that option's id with the tap. */
    per_option: z.boolean().nullish(),
  })
  .meta({ id: 'CardAction' });
export type CardAction = z.infer<typeof CardAction>;

const actions = z.array(CardAction).max(3).nullish();

// ── record cards (the Server draws them from its rows) ──

export const VoteCard = z
  .object({ ...base, kind: z.literal('vote'), decision_id: Id })
  .meta({ id: 'VoteCard', description: 'A vote. The Server draws the options, the tally and the vote buttons.' });
export const MandateCard = z
  .object({ ...base, kind: z.literal('mandate'), decision_id: Id })
  .meta({
    id: 'MandateCard',
    description:
      'Ready to book: what the group allowed (the choice, the cap, refundable or not, who pays). The Server shows "Yes, book it" and "Not now" to the payer only.',
  });
export const TicketCard = z
  .object({ ...base, kind: z.literal('ticket'), booking_id: Id })
  .meta({ id: 'TicketCard', description: 'A booking, drawn as a ticket (boarding pass, stay pass, table).' });
export const ExpenseCard = z
  .object({ ...base, kind: z.literal('expense'), expense_id: Id })
  .meta({ id: 'ExpenseCard', description: 'One expense: who paid, how much, split between whom.' });
export const SettleUpCard = z
  .object({ ...base, kind: z.literal('settle_up') })
  .meta({ id: 'SettleUpCard', description: 'Who pays whom right now, each with a UPI button.' });
export const DayCard = z
  .object({ ...base, kind: z.literal('day'), date: IsoDate })
  .meta({ id: 'DayCard', description: 'One day of the itinerary.' });
export const PlanCard = z
  .object({ ...base, kind: z.literal('plan') })
  .meta({ id: 'PlanCard', description: 'The whole itinerary, day by day.' });
export const BudgetCard = z
  .object({ ...base, kind: z.literal('budget') })
  .meta({ id: 'BudgetCard', description: 'Spent against the plan, by category.' });

// ── Go cards (content inside) ──

/**
 * 1.1: what the App shows when someone opens an option (or a vote's option): photos, why Go picked it, what it costs
 * and what is included. Every field is optional: the App shows what is there.
 */
export const OptionDetails = z
  .object({
    /** More photos, first one first. */
    gallery_urls: z.array(HttpUrl).max(12).nullish(),
    /** One line under the photos. */
    caption: z.string().min(1).max(200).nullish(),
    /** Why Go thinks it fits the group, a reason a line. */
    why: z.array(z.string().min(1).max(140)).max(5).nullish(),
    /** What it costs, line by line, e.g. { "label": "Room, 3 nights", "emoji": "🛏️", "amount_minor": 1200000, "currency": "INR" }. */
    costs: z
      .array(z.object({ label: z.string().min(1).max(60), emoji: z.string().min(1).max(16).nullish(), amount_minor: AmountMinor, currency: Currency }).meta({ id: 'OptionCost' }))
      .max(12)
      .nullish(),
    /** The costs added up, in the costs' currency. */
    total_minor: AmountMinor.nullish(),
    amenities: z.array(z.string().min(1).max(40)).max(30).nullish(),
    activities: z.array(z.string().min(1).max(60)).max(20).nullish(),
    /** Anything else worth a line, e.g. { "label": "Check-in", "value": "2 pm" }. */
    facts: z.array(z.object({ label: z.string().min(1).max(40), value: z.string().min(1).max(200) }).meta({ id: 'OptionFact' })).max(20).nullish(),
    /** The cancellation terms in words, e.g. "Free cancellation until 4 Nov". */
    cancellation: z.string().min(1).max(200).nullish(),
    /** The rating as the source gives it (out of 5, or 10 where the source rates out of 10). */
    rating: z.number().min(0).max(10).nullish(),
    review_count: z.int().nonnegative().nullish(),
    /** Go's own word on it, in Go's voice. */
    go_note: z.string().min(1).max(300).nullish(),
  })
  .meta({ id: 'OptionDetails' });

/** 10 Oct B4: one kind of room at a stay, priced for the whole stay. */
export const RoomType = z
  .object({
    room_type_id: Id,
    label: z.string().min(1).max(60),
    /** How many it sleeps. */
    sleeps: z.int().min(1).max(30),
    /** Per room, for the whole stay, in the option's currency. */
    price_minor: AmountMinor,
    photos: z.array(Photo).max(12).nullish(),
  })
  .meta({ id: 'RoomType' });
export type RoomType = z.infer<typeof RoomType>;

/**
 * 1.3 (rev 5 R9): everything about one option, for its Details page: what OptionDetails has, and more. get_option_details
 * answers it when a person opens Details, so a card of 10 options stays light. Every field is optional.
 */
export const OptionFullDetails = OptionDetails.extend({
  address: z.string().min(1).max(300).nullish(),
  map: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).meta({ id: 'MapPoint' }).nullish(),
  /** Times of day, as "14:00". */
  check_in: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullish(),
  check_out: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullish(),
  /** As the source says it, e.g. "villa", "hotel", "homestay". */
  property_type: z.string().min(1).max(40).nullish(),
  stars: z.number().min(0).max(7).nullish(),
  rooms: z.array(RoomType).max(10).nullish(),
  policies: z.array(z.string().min(1).max(200)).max(20).nullish(),
  reviews: z
    .array(
      z
        .object({ rating: z.number().min(0).max(10).nullish(), text: z.string().min(1).max(1000), date: IsoDate.nullish(), source: z.string().min(1).max(40).nullish() })
        .meta({ id: 'OptionReview' }),
    )
    .max(10)
    .nullish(),
  nearby: z.array(z.object({ name: z.string().min(1).max(120), distance_m: z.int().nonnegative().nullish() }).meta({ id: 'NearbyPlace' })).max(20).nullish(),
  /** The option's own page on ixigo. */
  url: HttpsUrl.nullish(),
}).meta({ id: 'OptionFullDetails' });

export const Option = z
  .object({
    /** Go's id for this option, sent back when someone taps a per-option button. */
    option_id: Id,
    title: z.string().min(1).max(80),
    subtitle: z.string().max(120).nullish(),
    image_url: HttpUrl.nullish(),
    logo_url: HttpUrl.nullish(),
    price_minor: AmountMinor.nullish(),
    currency: z.string().regex(/^[A-Z]{3}$/).nullish(),
    /** What the price covers, e.g. "per person" or "3 nights". */
    price_note: z.string().max(40).nullish(),
    /** Up to four short highlights, e.g. "Pool", "15 min to the beach". */
    highlights: z.array(z.string().min(1).max(40)).max(4),
    journey: Journey.nullish(),
    place: Place.nullish(),
    rating: z.number().min(0).max(5).nullish(),
    refundable_until: IsoDateTime.nullish(),
    /** 1.1: what the App shows when the option is opened. */
    details: OptionDetails.nullish(),
    /** 1.1: the way back, for a round trip. */
    return_journey: Journey.nullish(),
    /** 1.1: the price one way and for the round trip, when the App offers both (a tap says which: card_tap payload.trip). */
    price_oneway_minor: AmountMinor.nullish(),
    price_round_minor: AmountMinor.nullish(),
    /** 10 Oct B3: more photos, labelled, first one first. image_url stays the cover; this replaces details.gallery_urls. */
    photos: z.array(Photo).max(12).nullish(),
    /** 10 Oct B4: a stay's price per person for the whole stay, from the cheapest way to take its rooms to the dearest. */
    price_min_minor: AmountMinor.nullish(),
    price_max_minor: AmountMinor.nullish(),
    /** 10 Oct B4: a stay's kinds of room, each priced per room for the whole stay. */
    room_types: z.array(RoomType).max(10).nullish(),
    /** 1.3 (rev 5 R5): the option's own page on ixigo. The App shows it as a small "View on ixigo" link in the details. */
    url: HttpsUrl.nullish(),
  })
  .meta({ id: 'Option' });

export const OptionsCard = z
  .object({
    ...base,
    kind: z.literal('options'),
    title: z.string().min(1).max(80),
    /** 1.1 adds cab. */
    option_kind: z.enum(['stay', 'flight', 'train', 'bus', 'place', 'food', 'activity', 'cab']),
    /** When Go checked the prices. The App shows "checked 3 min ago". */
    checked_at: IsoDateTime,
    /** 1.3 (rev 5 R3): up to 10. The App shows the first few and "show more". */
    options: z.array(Option).min(1).max(10),
    /**
     * 1.3 (rev 5 R5): the vote these options are in. Go opens it first (open_vote, one DecisionOption a card option, its
     * option_ref the card's option_id), then posts the card with its id: the App draws a Vote button on each option and the
     * tally on the card. Cards from "see more" carry the same id. Never on travel options (a ticket is its traveller's own).
     */
    decision_id: Id.nullish(),
    actions,
  })
  .meta({ id: 'OptionsCard', description: 'Options Go found (stays, flights, places...), with prices and when they were checked.' });

/**
 * 1.3 (rev 5 R4): the standard "See more" action on an options card. A tap reaches Go as card_tap with action_id
 * "more_options": Go answers done at once, then posts a new message with a new options card of up to 10 options not shown
 * before for the same search, in the same vote (decision_id, add_vote_options). With nothing new left, Go answers the tap
 * with a toast.
 */
export const MORE_OPTIONS = { action_id: 'more_options', label: 'See more', style: 'secondary' } as const satisfies z.input<typeof CardAction>;

/** 10 Oct B5: one way the group can take a stay's rooms: the rooms, who is in each, and what each person pays. */
export const RoomArrangement = z
  .object({
    /** Go's id for it: a tap on it comes back as card_tap's option_id. */
    arrangement_id: Id,
    /** The rooms in words, e.g. "2 Deluxe". */
    label: z.string().min(1).max(80),
    rooms: z
      .array(
        z
          .object({ room_type_id: Id, label: z.string().min(1).max(60), person_ids: z.array(Id).min(1).max(30), price_minor: AmountMinor })
          .meta({ id: 'ArrangedRoom' }),
      )
      .min(1)
      .max(15),
    total_minor: AmountMinor,
    per_person: z.array(z.object({ person_id: Id, amount_minor: AmountMinor }).meta({ id: 'PersonAmount' })).min(1).max(30),
  })
  .meta({ id: 'RoomArrangement' });

export const RoomsCard = z
  .object({
    ...base,
    kind: z.literal('rooms'),
    title: z.string().min(1).max(80),
    /** The picked stay: its option_id on the card it came from. */
    option_id: Id,
    arrangements: z.array(RoomArrangement).min(1).max(10),
    actions,
  })
  .meta({
    id: 'RoomsCard',
    description: "10 Oct B5: after a stay is picked, the ways the group can take its rooms and who shares with whom. A tap is card_tap with option_id = the arrangement's id.",
  });

export const WorkingCard = z
  .object({
    ...base,
    kind: z.literal('working'),
    task_id: Id,
    title: z.string().min(1).max(80),
    state: z.enum(['running', 'needs_you', 'done', 'failed']),
    steps: z.array(z.object({ text: z.string().min(1).max(80), state: z.enum(['todo', 'doing', 'done', 'failed']) })).max(8),
    /** The latest picture of Go's screen while it works, if any. */
    screenshot_url: HttpUrl.nullish(),
    /** The address of the page in that picture, for the App's address bar. Only ever a search, results or details page. */
    page_url: HttpUrl.nullish(),
    /**
     * 1.3 (rev 5 R7): a view-only page of the browser Go is driving, hosted by Go, signed and short-lived (at most 15
     * minutes). The App opens it in a panel while the state is running or needs_you; it allows framing by the App's origins.
     * Sent when the task starts; replace_card only at step changes. A screen with a person's own account goes in a message
     * visible to that person alone.
     */
    live_url: HttpsUrl.nullish(),
    updated_at: IsoDateTime,
    actions,
  })
  .meta({ id: 'WorkingCard', description: 'Go doing a longer job (booking on a website, comparing many options). Updated in place.' });

const CallLine = z.object({ who: z.enum(['go', 'them']), text: z.string().min(1).max(500) });

export const CallCard = z
  .object({
    ...base,
    kind: z.literal('call'),
    call_id: Id,
    business: z.string().min(1).max(80),
    goal: z.string().min(1).max(160),
    state: z.enum(['dialing', 'talking', 'ended', 'failed']),
    started_at: IsoDateTime.nullish(),
    ended_at: IsoDateTime.nullish(),
    last_line: CallLine.nullish(),
    /** What came of it, once the call ends. */
    outcome: z.string().max(500).nullish(),
    /** The full transcript, once the call ends. This card is the call's record. */
    transcript: z.array(CallLine).max(300).nullish(),
    /** 1.1: the call's recording, once it ends, and how long it was. */
    recording_url: HttpUrl.nullish(),
    duration_s: z.int().nonnegative().nullish(),
    actions,
  })
  .meta({ id: 'CallCard', description: 'Go on a phone call to a business. Updated in place while it runs; the final version is the record.' });

export const PayCard = z
  .object({
    ...base,
    kind: z.literal('pay'),
    /** The spend approval this payment uses (its `jti`). */
    approval_id: Id,
    payer_person_id: Id,
    amount_minor: AmountMinor,
    currency: Currency,
    merchant: z.string().min(1).max(120),
    purpose: z.string().min(1).max(200),
    refundable_until: IsoDateTime.nullish(),
    expires_at: IsoDateTime,
    state: z.enum(['waiting', 'paid', 'declined', 'expired', 'failed']),
    actions,
  })
  .meta({
    id: 'PayCard',
    description: 'A payment waiting for the payer. Their "Approve" button opens the vault page, where they confirm with Face ID.',
  });

export const NoticeCard = z
  .object({
    ...base,
    kind: z.literal('notice'),
    tone: z.enum(['info', 'heads_up']),
    title: z.string().min(1).max(80),
    body: z.string().min(1).max(500),
    image_url: HttpUrl.nullish(),
    source: z.object({ name: z.string().min(1).max(60), url: HttpUrl.nullish() }).nullish(),
    checked_at: IsoDateTime.nullish(),
    /** For a heads-up with a deadline, e.g. free cancellation ends. */
    deadline_at: IsoDateTime.nullish(),
    actions,
  })
  .meta({ id: 'NoticeCard', description: 'Good to know (with its source) or a heads-up (a deadline, a price change, a clash).' });

/**
 * 1.1: a checklist Go keeps for the group, one row a person (a visa on arrival: who has what ready). Rows are keyed by
 * person: replace_card updates them in place. info: a line to read, with nothing to do.
 */
export const ChecklistRow = z
  .object({
    person_id: Id,
    status: z.enum(['todo', 'started', 'done', 'info']),
    /** Where they are, e.g. "Not yet". */
    label: z.string().min(1).max(80),
    /** The line under it, e.g. "Passport, photo". */
    sub: z.string().min(1).max(200).nullish(),
  })
  .meta({ id: 'ChecklistRow' });

export const ChecklistCard = z
  .object({
    ...base,
    kind: z.literal('checklist'),
    title: z.string().min(1).max(80),
    subtitle: z.string().min(1).max(200).nullish(),
    /** The day it is due by. */
    due_at: IsoDate.nullish(),
    rows: z.array(ChecklistRow).max(30),
    /** One thing Go suggests under the list, with a button when there is one to tap. */
    suggestion: z
      .object({
        text: z.string().min(1).max(300),
        cta: z.object({ action_id: z.string().regex(/^[a-z][a-z_]{0,31}$/), label: z.string().min(1).max(24) }).nullish(),
      })
      .meta({ id: 'ChecklistSuggestion' })
      .nullish(),
    actions,
  })
  .meta({ id: 'ChecklistCard', description: '1.1: a checklist for the group, one row a person, each todo, started, done or info. Updated in place.' });

export const Card = z
  .discriminatedUnion('kind', [
    VoteCard,
    MandateCard,
    TicketCard,
    ExpenseCard,
    SettleUpCard,
    DayCard,
    PlanCard,
    BudgetCard,
    OptionsCard,
    WorkingCard,
    CallCard,
    PayCard,
    NoticeCard,
    ChecklistCard,
    RoomsCard,
  ])
  .meta({ id: 'Card', discriminator: { propertyName: 'kind' } });
export type Card = z.infer<typeof Card>;
