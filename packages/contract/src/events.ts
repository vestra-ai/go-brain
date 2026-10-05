import { z } from 'zod';
import { Actor, Id, IsoDateTime, Seq } from './common.js';
import { Person } from './people.js';
import { Message, Reaction } from './room.js';
import { Booking, Decision, Expense, Mandate, RecordLine, TripSnapshot } from './trip.js';

/**
 * Events: go-server tells go-brain what happened in a trip, one send_event request per event on the socket.
 *
 * go-server sends an event for every change it makes to a trip, whoever made it (a person, Go, or
 * go-server itself), and stamps it with the trip's next change number (`seq`). Go's own changes
 * come back too: that is how go-brain learns their change numbers. The one exception: updating a
 * Go card in place (replace_card) is not a change and sends no event.
 */

const envelope = {
  /** Unique per event. go-brain ignores an event_id it has already seen. */
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
/** A budget change always has `by: { kind: "system" }`, so nobody's answer can be traced to them. */
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
    tally: z.array(z.int().nonnegative()).max(10),
  }),
  'DecisionVoted', 'Someone voted (or changed their vote).');
export const DecisionClosed = ev('decision.closed',
  z.object({ decision: Decision, reason: z.enum(['time', 'everyone_voted', 'closed_by_person', 'closed_by_go']) }),
  'DecisionClosed', 'A vote closed, with the result.');
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
  z.object({ expense: Expense, change: z.enum(['added', 'removed']), by: Actor }),
  'ExpenseChanged', 'An expense was added or removed.');

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
    MandateSet,
    MandateConfirmed,
    MandateDeclined,
    RecordChanged,
    BookingChanged,
    ExpenseChanged,
  ])
  .meta({ id: 'Event', discriminator: { propertyName: 'type' } });
export type Event = z.infer<typeof Event>;
export type EventType = Event['type'];
