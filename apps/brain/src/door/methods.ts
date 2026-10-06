import * as C from '@go/contract';
import type { z } from 'zod';

/**
 * The 26 socket methods with their zod schemas, typed. @go/contract exports schemas, not a typed map
 * per method, so every lane reads params and results through this table. methods.test.ts checks that
 * it names exactly the contract's SOCKET_METHODS with the very same schemas.
 */
export const TO_SERVER_SCHEMAS = {
  read_trip: [C.ReadTrip, C.TripSnapshot],
  read_messages: [C.ReadMessages, C.MessagesPage],
  post_message: [C.PostMessage, C.PostMessageResult],
  replace_card: [C.ReplaceCard, C.ReplaceCardResult],
  typing: [C.GoTyping, null],
  add_reaction: [C.AddReaction, C.WriteResult],
  remove_reaction: [C.RemoveReaction, C.WriteResult],
  update_trip: [C.UpdateTrip, C.WriteResult],
  open_vote: [C.OpenDecision, C.OpenDecisionResult],
  close_vote: [C.CloseDecision, C.CloseDecisionResult],
  set_mandate: [C.SetMandate, C.WriteResult],
  add_record_line: [C.AddRecordLine, C.AddRecordLineResult],
  update_record_line: [C.UpdateRecordLine, C.WriteResult],
  add_booking: [C.AddBooking, C.AddBookingResult],
  update_booking: [C.UpdateBooking, C.WriteResult],
  add_expense: [C.AddExpense, C.AddExpenseResult],
  request_spend_approval: [C.RequestSpendApproval, C.SpendApprovalResult],
  cancel_spend_approval: [C.CancelSpendApproval, C.Ok],
} as const;

export const TO_GO_SCHEMAS = {
  send_event: [C.Event, C.EventAccepted],
  card_tap: [C.CardTap, C.CardActionResult],
  catch_up: [C.CatchUpRequest, C.CatchUp],
  get_person: [C.GetPerson, C.PersonPage],
  update_person: [C.UpdatePerson, C.Ok],
  delete_fact: [C.DeleteFact, C.Ok],
  forget_person: [C.ForgetPerson, C.ForgetResult],
  vault_link: [C.CreateLink, C.Link],
} as const;

export type ToServerMethod = keyof typeof TO_SERVER_SCHEMAS;
export type ToGoMethod = keyof typeof TO_GO_SCHEMAS;
export type ToServerParams<M extends ToServerMethod> = z.input<(typeof TO_SERVER_SCHEMAS)[M][0]>;
export type ToServerResult<M extends ToServerMethod> = (typeof TO_SERVER_SCHEMAS)[M][1] extends z.ZodType
  ? z.infer<(typeof TO_SERVER_SCHEMAS)[M][1]>
  : void;
export type ToGoParams<M extends ToGoMethod> = z.infer<(typeof TO_GO_SCHEMAS)[M][0]>;
export type ToGoResult<M extends ToGoMethod> = z.input<(typeof TO_GO_SCHEMAS)[M][1]>;

/** read_trip's answer; the people are `trip.people`, never "members". */
export type Trip = C.TripSnapshot;
export type Message = C.Message;
/** The envelope: event_id, trip_id, seq, occurred_at, type, data. */
export type TripEvent = C.Event;
export type CardKind = C.Card['kind'];
export type CardTapParams = z.infer<typeof C.CardTap>;
export type CardTapResult = z.input<typeof C.CardActionResult>;

/**
 * The 20 event types the contract knows. The contract's Event schema rejects any other type, so the
 * door checks `type` against this list first and accepts an unknown type without validating it.
 */
export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<C.EventType>([
  'message.created', 'message.edited', 'message.deleted', 'reaction.added', 'reaction.removed',
  'person.joined', 'person.updated', 'person.left', 'trip.created', 'trip.updated',
  'decision.opened', 'decision.voted', 'decision.closed', 'decision.cancelled',
  'mandate.set', 'mandate.confirmed', 'mandate.declined',
  'record.changed', 'booking.changed', 'expense.changed',
]);
