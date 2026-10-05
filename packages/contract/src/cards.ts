import { z } from 'zod';
import { AmountMinor, Currency, HttpUrl, Id, IsoDate, IsoDateTime, Journey, Place } from './common.js';

/**
 * Cards are the rich things Go posts in the room. The same JSON travels from Go through
 * the server to the app, unchanged.
 *
 * Two families:
 *  - Record cards carry only an id. The server draws them from its own rows (a vote, a ticket, an
 *    expense), so the room and the Trip screens never disagree. The server owns their buttons.
 *  - Go cards carry their content (options, live work, a call, a payment, a notice). Their buttons
 *    are `actions`: a tap is sent to Go, which answers (see the card action call).
 *
 * Every card has `fallback_text`: plain words an older app build shows if it cannot draw the kind.
 */

const base = {
  /** Go's id for the card. Go sends replace_card with the same id to update it in place. */
  card_id: Id,
  fallback_text: z.string().min(1).max(300),
  /**
   * People who need to act on this card. The server sends them a push and pins the card for them
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

// ── record cards (the server draws them from its rows) ──

export const VoteCard = z
  .object({ ...base, kind: z.literal('vote'), decision_id: Id })
  .meta({ id: 'VoteCard', description: 'A vote. The server draws the options, the tally and the vote buttons.' });
export const MandateCard = z
  .object({ ...base, kind: z.literal('mandate'), decision_id: Id })
  .meta({
    id: 'MandateCard',
    description:
      'Ready to book: what the group allowed (the choice, the cap, refundable or not, who pays). The server shows "Yes, book it" and "Not now" to the payer only.',
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
  })
  .meta({ id: 'Option' });

export const OptionsCard = z
  .object({
    ...base,
    kind: z.literal('options'),
    title: z.string().min(1).max(80),
    option_kind: z.enum(['stay', 'flight', 'train', 'bus', 'place', 'food', 'activity']),
    /** When Go checked the prices. The app shows "checked 3 min ago". */
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
  ])
  .meta({ id: 'Card', discriminator: { propertyName: 'kind' } });
export type Card = z.infer<typeof Card>;
