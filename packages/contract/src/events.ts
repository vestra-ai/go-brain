import { z } from 'zod';
import { Actor, AmountMinor, Currency, Id, IsoDateTime, Seq } from './common.js';
import { Person } from './people.js';
import { Message, Reaction } from './room.js';
import { Booking, Decision, DecisionOption, Expense, Mandate, RecordLine, Settlement, TripSnapshot } from './trip.js';

/**
 * Events: the Server tells Go what happened in a trip, one send_event request per event on the socket.
 *
 * The Server sends an event for every change it makes to a trip, whoever made it (a person, Go, or
 * the Server itself), and stamps it with the trip's next change number (`seq`). Go's own changes
 * come back too: that is how Go learns their change numbers. The one exception: updating a
 * Go card in place (replace_card) is not a change and sends no event.
 */

const envelope = {
  /** Unique per event. Go ignores an event_id it has already seen. */
  event_id: Id,
  trip_id: Id,
  seq: Seq,
  occurred_at: IsoDateTime,
};

const ev = <T extends string, D extends z.ZodType>(type: T, data: D, id: string, description: string) =>
  z.object({ ...envelope, type: z.literal(type), data: data.meta({ id: `${id}Data` }) }).meta({ id, description });

export const MessageCreated = ev('message.created', z.object({ message: Message }), 'MessageCreated',
  'Someone posted in the room (Go\'s own messages come back too).');
export const MessageEdited = ev('message.edited', z.object({ message: Message }), 'MessageEdited',
  'Someone edited a message. Carries the message as it is now.');
export const MessageDeleted = ev('message.deleted', z.object({ message_id: Id }), 'MessageDeleted',
  'Someone deleted a message. Go drops anything it learned from it.');
export const ReactionAdded = ev('reaction.added', z.object({ message_id: Id, reaction: Reaction }), 'ReactionAdded',
  'Someone reacted to a message. A thumbs up can count as agreeing.');
export const ReactionRemoved = ev('reaction.removed', z.object({ message_id: Id, reaction: Reaction }), 'ReactionRemoved',
  'Someone took a reaction back.');
export const PersonJoined = ev('person.joined', z.object({ person: Person }), 'PersonJoined',
  'Someone joined the trip, with their join answers (never their budget answer).');
export const PersonUpdated = ev('person.updated',
  z.object({ person: Person, changed: z.array(z.enum(['name', 'photo_url', 'from_city', 'earliest_leave', 'know', 'has_upi', 'go_paused', 'role'])).min(1) }),
  'PersonUpdated', 'Someone changed their details, or paused or unpaused Go.');
export const PersonLeft = ev('person.left', z.object({ person_id: Id }), 'PersonLeft', 'Someone left the trip.');
export const TripCreated = ev('trip.created', z.object({ trip: TripSnapshot }), 'TripCreated',
  'A new trip room. Carries the whole trip, so Go can greet the group and start.');
/**
 * A budget change comes by the person who set the group's budget, or by Go (1.1). Before 1.1 it always had
 * `by: { kind: "system" }`, so nobody's private answer could be traced to them.
 */
export const TripUpdated = ev('trip.updated',
  z.object({ by: Actor, changed: z.array(z.enum(['title', 'destination', 'dates', 'vibe', 'stay', 'itinerary', 'status', 'budget'])).min(1) }),
  'TripUpdated', 'Trip details changed. Read the trip to see the new values.');
export const DecisionOpened = ev('decision.opened', z.object({ decision: Decision, by: Actor }), 'DecisionOpened',
  'A vote opened.');
export const DecisionVoted = ev('decision.voted',
  z.object({
    decision_id: Id,
    /** Left out when the vote is anonymous. */
    person_id: Id.nullish(),
    /** Left out when the vote is anonymous. */
    option_index: z.int().nonnegative().nullish(),
    voted: z.int().nonnegative(),
    of: z.int().nonnegative(),
    tally: z.array(z.int().nonnegative()).max(20),
    /** 1.1: they said "I'm flexible" instead of picking: no option_index, counted in voted, never in the tally. */
    flexible: z.literal(true).nullish(),
    /** 1.1: they took their vote back: no option_index, and voted and tally count without them. */
    retracted: z.literal(true).nullish(),
  }),
  'DecisionVoted', 'Someone voted, changed their vote, said they are flexible (1.1), or took their vote back (1.1).');
export const DecisionClosed = ev('decision.closed',
  z.object({ decision: Decision, reason: z.enum(['time', 'everyone_voted', 'closed_by_person', 'closed_by_go']) }),
  'DecisionClosed', 'A vote closed, with the result.');
export const DecisionOptionsAdded = ev('decision.options_added',
  z.object({ decision_id: Id, options: z.array(DecisionOption).min(1).max(10), by: Actor }),
  'DecisionOptionsAdded',
  '1.3 (rev 5 R5): options were added to an open vote ("see more", add_vote_options). Their indexes continue from the last option; votes already cast stay.');
export const DecisionCancelled = ev('decision.cancelled', z.object({ decision_id: Id, by: Actor }), 'DecisionCancelled',
  'A vote was called off.');
export const MandateSet = ev('mandate.set', z.object({ decision_id: Id, mandate: Mandate }), 'MandateSet',
  'Go set what the group allowed for a spend.');
export const MandateConfirmed = ev('mandate.confirmed', z.object({ decision_id: Id, person_id: Id }), 'MandateConfirmed',
  'The payer tapped "Yes, book it". Go may now ask for a spend approval.');
export const MandateDeclined = ev('mandate.declined', z.object({ decision_id: Id, person_id: Id }), 'MandateDeclined',
  'The payer tapped "Not now".');
export const RecordChanged = ev('record.changed',
  z.object({ line: RecordLine, change: z.enum(['added', 'updated', 'done', 'undone']), by: Actor }),
  'RecordChanged', 'A trip record line was added, changed, finished or undone.');
export const BookingChanged = ev('booking.changed',
  z.object({ booking: Booking, change: z.enum(['added', 'updated', 'cancelled']), by: Actor }),
  'BookingChanged', 'A booking was added, changed or cancelled.');
export const ExpenseChanged = ev('expense.changed',
  z.object({
    expense: Expense,
    /**
     * 1.1 adds updated: someone fixed its split (the event carries the whole expense). approved and disputed are no
     * longer sent (expense answers were withdrawn on 10 Oct); Go still takes them from an older Server.
     */
    change: z.enum(['added', 'removed', 'updated', 'approved', 'disputed']),
    by: Actor,
    /** 1.1, withdrawn: on approved and disputed, who answered. */
    by_person_id: Id.nullish(),
  }),
  'ExpenseChanged', 'An expense was added, removed, or (1.1) changed.');
/**
 * 1.3 (the Server team's demo payment, 11 Oct): the payer tapped approve on a waiting pay card and the Server paid it itself
 * (method "demo": no vault, no money). The Server has set the card paid and written the booking and the expense, in one
 * transaction with booking.changed, record.changed and expense.changed before it. Go finishes its own side by approval_id:
 * no add_booking or add_expense for it, the ticket card, then the next step. Lenient on purpose, so it is never refused:
 * only approval_id is needed.
 */
export const PaymentCompleted = ev('payment.completed',
  z.object({
    approval_id: Id,
    /** The booking the Server wrote for it (booking.changed came first). */
    booking_id: Id.nullish(),
    card_id: Id.nullish(),
    payer_person_id: Id.nullish(),
    amount_minor: AmountMinor.nullish(),
    currency: Currency.nullish(),
    merchant: z.string().nullish(),
    purpose: z.string().nullish(),
    /** A group's payment: the vote it was for. */
    decision_id: Id.nullish(),
    /** A person's own ticket (contract 1.3's personal pick): who, Go's card and the option they tapped. */
    personal: z.object({ person_id: Id, card_id: Id, option_id: Id }).nullish(),
    expense_id: Id.nullish(),
    /** "demo": the Server paid it with no vault and no money. */
    method: z.string().nullish(),
    paid_at: IsoDateTime.nullish(),
    by: Actor.nullish(),
  }),
  'PaymentCompleted', '1.3: the Server paid a waiting pay card on its payer\'s tap (method demo), with the booking and expense written.');
export const SettlementRecorded = ev('settlement.recorded', z.object({ settlement: Settlement, by: Actor }), 'SettlementRecorded',
  '1.1: someone recorded paying someone back. It counts at once, so its status is always confirmed.');

export const Event = z
  .discriminatedUnion('type', [
    MessageCreated,
    MessageEdited,
    MessageDeleted,
    ReactionAdded,
    ReactionRemoved,
    PersonJoined,
    PersonUpdated,
    PersonLeft,
    TripCreated,
    TripUpdated,
    DecisionOpened,
    DecisionVoted,
    DecisionClosed,
    DecisionCancelled,
    DecisionOptionsAdded,
    MandateSet,
    MandateConfirmed,
    MandateDeclined,
    RecordChanged,
    BookingChanged,
    ExpenseChanged,
    SettlementRecorded,
    PaymentCompleted,
  ])
  .meta({ id: 'Event', discriminator: { propertyName: 'type' } });
export type Event = z.infer<typeof Event>;
export type EventType = Event['type'];
