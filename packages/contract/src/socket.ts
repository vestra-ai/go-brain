import { z } from 'zod';
import { OptionFullDetails } from './cards.js';
import { ErrorCode } from './errors.js';
import { Event } from './events.js';
import { MessagesPage, GoTyping, PostMessage, PostMessageResult, ReplaceCard, ReplaceCardResult } from './room.js';
import {
  CardActionResult, CardTap, CatchUp, CatchUpRequest, CreateLink, DeleteFact, EventAccepted, ForgetPerson, ForgetResult, GetOptionDetails,
  GetPerson, Link, Ok, PersonPage, PlaceInfo, PlaceInfoRequest, UpdatePerson,
} from './to-go.js';
import {
  AddBooking, AddBookingResult, AddExpense, AddExpenseResult, AddReaction, AddRecordLine, AddRecordLineResult, AddVoteOptions, CancelSpendApproval,
  CloseDecision, CloseDecisionResult, OpenDecision, OpenDecisionResult, ReadMessages, ReadTrip, RemoveReaction, RequestSpendApproval,
  SetMandate, SpendApprovalResult, UpdateBooking, UpdateRecordLine, UpdateTrip, WriteResult,
} from './to-server.js';
import { TripSnapshot } from './trip.js';

/**
 * Go's socket. The Server opens one WebSocket to Go and keeps it open. Everything between
 * the Server and Go travels on it, in both directions, as JSON-RPC 2.0 text frames:
 *
 *  - a request has an `id` and always gets exactly one answer: a result or an error;
 *  - a notification has no `id` and gets no answer (Go's typing).
 *
 * The Server connects to wss://<brain>/v1/socket with the x-go-signature header on the upgrade request
 * (method GET, target /v1/socket, empty body). See signing.ts. Go accepts each signature once.
 *
 * After a reconnect, a request that got no answer is sent again with the same id. Requests that change
 * something carry their own id (event_id, request_id, tap_id), so the receiver does each one once even
 * when it arrives twice. The others only read, or are safe to repeat.
 */
export const SOCKET_PATH = '/v1/socket';
/** Go pings every 20 seconds. A side that hears nothing for 40 seconds closes the socket. */
export const PING_INTERVAL_SECONDS = 20;
export const IDLE_CLOSE_SECONDS = 40;
/** How long the Server waits before reconnecting, in order, then 30 seconds each time. */
export const RECONNECT_BACKOFF_SECONDS = [1, 2, 5, 10, 30] as const;
/** The largest frame either side sends. */
export const MAX_FRAME_BYTES = 1_048_576;

const jsonrpc = z.literal('2.0');
const RequestId = z.string().min(1).max(64);

export const SocketRequest = z
  .object({ jsonrpc, id: RequestId, method: z.string().min(1).max(64), params: z.record(z.string(), z.unknown()) })
  .meta({ id: 'SocketRequest', description: 'A request. The other side answers it once, with a result or an error, using the same id.' });

export const SocketNotification = z
  .object({ jsonrpc, method: z.string().min(1).max(64), params: z.record(z.string(), z.unknown()) })
  .meta({ id: 'SocketNotification', description: 'A notification: no id, no answer. Used only for Go\'s typing.' });

export const SocketResult = z
  .object({ jsonrpc, id: RequestId, result: z.record(z.string(), z.unknown()) })
  .meta({ id: 'SocketResult', description: 'The answer to a request that worked.' });

/**
 * Error codes are the HTTP statuses everyone knows, plus JSON-RPC's own two for frames that cannot
 * be read (-32700) and methods the other side does not know (-32601).
 */
export const SOCKET_ERROR_CODES = {
  not_found: 404, invalid: 422, conflict: 409, rate_limited: 429, internal: 500, unavailable: 503,
  parse_error: -32700, unknown_method: -32601,
} as const;

export const SocketError = z
  .object({
    jsonrpc,
    /** Null only when the request could not be read at all. */
    id: RequestId.nullable(),
    error: z.object({
      code: z.int(),
      message: z.string().max(500),
      data: z
        .object({
          code: ErrorCode,
          /** With 429: how long to wait before trying again. */
          retry_after_seconds: z.int().positive().max(3600).nullish(),
        })
        .nullish(),
    }),
  })
  .meta({ id: 'SocketError', description: 'The answer to a request that did not work.' });

export type Direction = 'to_go' | 'to_server';

export interface SocketMethod {
  name: string;
  /** to_go: the Server sends it and Go answers. to_server: Go sends it and the Server answers. */
  direction: Direction;
  summary: string;
  params: z.ZodType;
  /** Null for a notification. */
  result: z.ZodType | null;
  /** The answer must arrive within this many seconds. */
  answer_within: number | null;
  /** The trip event the Server sends after it does this, if any. */
  sends_event?: string;
}

const m = (name: string, direction: Direction, summary: string, params: z.ZodType, result: z.ZodType | null, answer_within: number | null, sends_event?: string): SocketMethod =>
  ({ name, direction, summary, params, result, answer_within, ...(sends_event ? { sends_event } : {}) });

/**
 * What the Server sends Go. Go answers send_event with { accepted: true } for an event type it
 * does not know yet, before checking the event, so the Server can add event types within version 1.
 */
export const TO_GO: readonly SocketMethod[] = [
  m('send_event', 'to_go', 'Something changed in a trip. One event per change, in change-number order for each trip.', Event, EventAccepted, 2),
  m('card_tap', 'to_go', 'Someone tapped a button on one of Go\'s cards. Go answers what the App should do.', CardTap, CardActionResult, 3),
  m('catch_up', 'to_go', 'Someone came back to the room after a while. Go answers what they missed.', CatchUpRequest, CatchUp, 3),
  m('get_person', 'to_go', 'What Go knows about a person, with where each fact came from.', GetPerson, PersonPage, 2),
  m('update_person', 'to_go', 'Turn carry-over on or off for a person.', UpdatePerson, Ok, 2),
  m('delete_fact', 'to_go', 'Remove one thing Go knows about a person.', DeleteFact, Ok, 2),
  m('forget_person', 'to_go', 'Forget me: in one trip, or everywhere.', ForgetPerson, ForgetResult, 2),
  m('vault_link', 'to_go', 'A short-lived link to the person\'s vault page, to open in the browser sheet.', CreateLink, Link, 2),
  // 1.3 (rev 5)
  m('place_info', 'to_go', 'What a place is like, for the ideas on the home screen: its photos, a tag, the way there from a city and the best months.', PlaceInfoRequest, PlaceInfo, 3),
  m('get_option_details', 'to_go', 'Everything about one option on a card, for its Details page: more than the card carries.', GetOptionDetails, OptionFullDetails, 3),
];

/** What Go sends the Server. */
export const TO_SERVER: readonly SocketMethod[] = [
  m('read_trip', 'to_server', 'Read the whole trip as Go may see it, at its current change number.', ReadTrip, TripSnapshot, 2),
  m('read_messages', 'to_server', 'Read messages posted or changed after a change number. Used to catch up after a gap or a restart.', ReadMessages, MessagesPage, 2),
  m('post_message', 'to_server', 'Go says something in the room: text, a card, or both.', PostMessage, PostMessageResult, 2, 'message.created'),
  m('replace_card', 'to_server', 'Replace a card Go posted earlier, in place. Not a change to the trip: no event.', ReplaceCard, ReplaceCardResult, 2),
  m('typing', 'to_server', 'Show or hide "Go is typing..." in the room.', GoTyping, null, null),
  m('add_reaction', 'to_server', 'Go reacts to a message.', AddReaction, WriteResult, 2, 'reaction.added'),
  m('remove_reaction', 'to_server', 'Go takes its reaction back.', RemoveReaction, WriteResult, 2, 'reaction.removed'),
  m('update_trip', 'to_server', 'Change the title, destination, dates, vibe, stay or the itinerary.', UpdateTrip, WriteResult, 2, 'trip.updated'),
  m('open_vote', 'to_server', 'Open a vote.', OpenDecision, OpenDecisionResult, 2, 'decision.opened'),
  m('close_vote', 'to_server', 'Close a vote now and get the result.', CloseDecision, CloseDecisionResult, 2, 'decision.closed'),
  m('add_vote_options', 'to_server', '1.3: add options to an open vote, for the options "See more" brought. At most 20 in all; votes cast stay.', AddVoteOptions, WriteResult, 2, 'decision.options_added'),
  m('set_mandate', 'to_server', 'Set what the group allowed for a closed choice vote: the choice, the cap, refundable only, and who pays.', SetMandate, WriteResult, 2, 'mandate.set'),
  m('add_record_line', 'to_server', 'Add an agreed, open or doing line to the trip record.', AddRecordLine, AddRecordLineResult, 2, 'record.changed'),
  m('update_record_line', 'to_server', 'Change a line Go wrote, or mark it done.', UpdateRecordLine, WriteResult, 2, 'record.changed'),
  m('add_booking', 'to_server', 'Record a confirmed booking.', AddBooking, AddBookingResult, 2, 'booking.changed'),
  m('update_booking', 'to_server', 'Change or cancel a booking.', UpdateBooking, WriteResult, 2, 'booking.changed'),
  m('add_expense', 'to_server', 'Record something someone paid for, split between people.', AddExpense, AddExpenseResult, 2, 'expense.changed'),
  m('request_spend_approval', 'to_server', 'Run the spend check. Answers with a signed, one-use spend approval for the vault, or the reason why not.', RequestSpendApproval, SpendApprovalResult, 2),
  m('cancel_spend_approval', 'to_server', 'Release an approval Go will not use. Not a change to the trip: no event.', CancelSpendApproval, Ok, 2),
];

export const SOCKET_METHODS: readonly SocketMethod[] = [...TO_GO, ...TO_SERVER];
export const methodByName = (name: string): SocketMethod | undefined => SOCKET_METHODS.find((x) => x.name === name);

/** Check a request's params against its method. Unknown methods answer -32601; bad params answer 422. */
export function parseParams(method: string, params: unknown) {
  const def = methodByName(method);
  if (!def) return { ok: false as const, code: SOCKET_ERROR_CODES.unknown_method, message: `unknown method ${method}` };
  const r = def.params.safeParse(params);
  return r.success ? { ok: true as const, params: r.data, method: def } : { ok: false as const, code: SOCKET_ERROR_CODES.invalid, message: z.prettifyError(r.error) };
}
