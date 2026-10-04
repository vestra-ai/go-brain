import { z } from 'zod';
import { AmountMinor, Currency, Id, IsoDateTime } from './common.js';

/**
 * The cards Go posts into the room. go-server stores them, go-app renders them.
 * Cards that point at trip records (vote, plan, ticket, receipt line) carry only the id:
 * go-server renders them from its own rows, so the room and the Trip button never disagree.
 * Live cards (live, call) are updated in place: send the same `card.id` again with `upsert: true`.
 */
const LiveCard = z.object({
  kind: z.literal('live'),
  title: z.string().max(80),
  subtitle: z.string().max(120).optional(),
  state: z.enum(['running', 'done', 'failed']),
  progress: z.object({ done: z.int().nonnegative(), total: z.int().positive() }).optional(),
  thumbs: z.array(z.url()).max(4).default([]),
});
const CallCard = z.object({
  kind: z.literal('call'),
  business: z.string().max(80),
  goal: z.string().max(160),
  state: z.enum(['dialing', 'talking', 'ended', 'failed']),
  elapsed_s: z.int().nonnegative(),
  last_line: z.string().max(240).optional(),
  outcome: z.string().max(500).optional(),
});
const FlightOffer = z.object({
  offer_ref: z.string().max(120),
  carrier_code: z.string().max(3),
  carrier_name: z.string().max(60),
  logo_url: z.url().optional(),
  from: z.string().length(3),
  to: z.string().length(3),
  depart_at: IsoDateTime,
  arrive_at: IsoDateTime,
  stops: z.int().nonnegative(),
  price_minor: AmountMinor,
  currency: Currency,
});
const FlightsCard = z.object({
  kind: z.literal('flights'),
  for_member_ids: z.array(Id).min(1),
  checked_at: IsoDateTime,
  offers: z.array(FlightOffer).min(1).max(5),
});
const VoteCard = z.object({ kind: z.literal('vote'), decision_id: Id });
const TicketCard = z.object({ kind: z.literal('ticket'), booking_id: Id });
const ReceiptLineCard = z.object({ kind: z.literal('receipt_line'), expense_id: Id });
const PlanCard = z.object({ kind: z.literal('plan') });
const CatchUpCard = z.object({
  kind: z.literal('catch_up'),
  for_member_id: Id,
  since: IsoDateTime,
  items: z.array(z.object({ text: z.string().max(140), image_url: z.url().optional() })).max(3),
});
/** Opens the payer's vault approval (a go-brain page) inside the app. */
const PayCard = z.object({
  kind: z.literal('pay'),
  payer_member_id: Id,
  approval_url: z.url(),
  amount_minor: AmountMinor,
  currency: Currency,
  merchant: z.string().max(120),
});

export const Card = z.discriminatedUnion('kind', [
  LiveCard,
  CallCard,
  FlightsCard,
  VoteCard,
  TicketCard,
  ReceiptLineCard,
  PlanCard,
  CatchUpCard,
  PayCard,
]);
export type Card = z.infer<typeof Card>;

/** go-brain → go-server: something Go says in the room (text, a card, or both). */
export const MessageOut = z
  .object({
    /** Idempotency key: go-server must ignore a repeat of the same out_id. */
    out_id: Id,
    trip_id: Id,
    /** The member message this answers, when Go was addressed. */
    in_reply_to: Id.optional(),
    text: z.string().min(1).max(2000).optional(),
    card: z.object({ id: Id, upsert: z.boolean().default(false), body: Card }).optional(),
    sent_at: IsoDateTime,
  })
  .refine((m) => m.text !== undefined || m.card !== undefined, { message: 'a message needs text, a card, or both' });
export type MessageOut = z.infer<typeof MessageOut>;

export const MessageOutAccepted = z.object({ ok: z.literal(true), message_id: Id });
