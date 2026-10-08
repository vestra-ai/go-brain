import { z } from 'zod';
import { AmountMinor, Currency, HttpUrl, Id, IsoDate, IsoDateTime, Journey, Place } from './common.js';

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
    options: z.array(Option).min(1).max(5),
    actions,
  })
  .meta({ id: 'OptionsCard', description: 'Options Go found (stays, flights, places...), with prices and when they were checked.' });

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
 * 1.1: a checklist Go keeps for the group or one person (documents to upload, things to pack, check-ins to do). Go
 * updates it in place as rows change. A row's tap sends its action_id with the row in option_id.
 */
export const ChecklistRow = z
  .object({
    row_id: Id,
    label: z.string().min(1).max(80),
    detail: z.string().min(1).max(200).nullish(),
    /** info: a line to read, with nothing to do. */
    status: z.enum(['todo', 'started', 'done', 'info']),
    /** Whose row it is, when it is one person's. */
    person_id: Id.nullish(),
    due_at: IsoDateTime.nullish(),
  })
  .meta({ id: 'ChecklistRow' });

export const ChecklistCard = z
  .object({
    ...base,
    kind: z.literal('checklist'),
    title: z.string().min(1).max(80),
    rows: z.array(ChecklistRow).min(1).max(20),
    actions,
  })
  .meta({ id: 'ChecklistCard', description: '1.1: a checklist (documents, packing, check-ins), each row todo, started, done or info. Updated in place.' });

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
  ])
  .meta({ id: 'Card', discriminator: { propertyName: 'kind' } });
export type Card = z.infer<typeof Card>;
