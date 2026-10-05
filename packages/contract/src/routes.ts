import { z } from 'zod';
import { Card } from './cards.js';
import { Event } from './events.js';
import {
  CardActionRequest, CardActionResult, CatchUp, CatchUpRequest, CreateLink, EventAccepted, ForgetResult, Health, Link, Ok,
  PersonPage, UpdatePerson,
} from './go-brain-api.js';
import {
  AddBooking, AddBookingResult, AddExpense, AddExpenseResult, AddRecordLine, AddRecordLineResult, CloseDecision,
  CloseDecisionResult, OpenDecision, OpenDecisionResult, RequestSpendApproval, SetMandate, SpendApprovalResult,
  UpdateBooking, UpdateRecordLine, UpdateTrip, WriteResult,
} from './go-server-api.js';
import { MessagesPage, PostMessage, PostMessageResult, PutCardResult, SetTyping } from './room.js';
import { TripSnapshot } from './trip.js';

/** Which server answers the route. Every call is signed with x-go-signature (see signing.ts). */
export type Server = 'go-server' | 'go-brain';

export interface Route {
  id: string;
  server: Server;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  summary: string;
  query?: z.ZodObject;
  request?: z.ZodType;
  response: z.ZodType;
  status: 200 | 202;
}

const trip = '/brain/v1/trips/{trip_id}';

/** go-server serves these. go-brain calls them: Go's trip tools, and Go speaking in the room. */
export const GO_SERVER_ROUTES: readonly Route[] = [
  { id: 'getTrip', server: 'go-server', method: 'GET', path: trip, status: 200,
    summary: 'The whole trip as Go may see it, at its current change number.', response: TripSnapshot },
  { id: 'updateTrip', server: 'go-server', method: 'PATCH', path: trip, status: 200,
    summary: 'Change the title, destination, dates, vibe, stay or the itinerary.', request: UpdateTrip, response: WriteResult },
  { id: 'listMessages', server: 'go-server', method: 'GET', path: `${trip}/messages`, status: 200,
    summary: 'Messages after a change number, oldest first, up to 200 at a time. Used to catch up after a gap or a restart.',
    query: z.object({ after_seq: z.coerce.number().int().nonnegative(), limit: z.coerce.number().int().min(1).max(200).optional() }),
    response: MessagesPage },
  { id: 'postMessage', server: 'go-server', method: 'POST', path: `${trip}/messages`, status: 200,
    summary: 'Go says something in the room: text, a card, or both.', request: PostMessage, response: PostMessageResult },
  { id: 'putCard', server: 'go-server', method: 'PUT', path: `${trip}/cards/{card_id}`, status: 200,
    summary: 'Replace a card Go posted earlier, in place. The card_id in the body must match the path. Sends no event.',
    request: Card, response: PutCardResult },
  { id: 'setTyping', server: 'go-server', method: 'POST', path: `${trip}/typing`, status: 200,
    summary: 'Show or hide "Go is typing..." in the room.', request: SetTyping, response: Ok },
  { id: 'openDecision', server: 'go-server', method: 'POST', path: `${trip}/decisions`, status: 200,
    summary: 'Open a vote.', request: OpenDecision, response: OpenDecisionResult },
  { id: 'closeDecision', server: 'go-server', method: 'POST', path: `${trip}/decisions/{decision_id}/close`, status: 200,
    summary: 'Close a vote now and get the result.', request: CloseDecision, response: CloseDecisionResult },
  { id: 'setMandate', server: 'go-server', method: 'PUT', path: `${trip}/decisions/{decision_id}/mandate`, status: 200,
    summary: 'Set what the group allowed for a closed choice vote: the choice, the cap, refundable only, and who pays.',
    request: SetMandate, response: WriteResult },
  { id: 'addRecordLine', server: 'go-server', method: 'POST', path: `${trip}/record`, status: 200,
    summary: 'Add an agreed, open or doing line to the trip record.', request: AddRecordLine, response: AddRecordLineResult },
  { id: 'updateRecordLine', server: 'go-server', method: 'PATCH', path: `${trip}/record/{line_id}`, status: 200,
    summary: 'Change a line Go wrote, or mark it done.', request: UpdateRecordLine, response: WriteResult },
  { id: 'addBooking', server: 'go-server', method: 'POST', path: `${trip}/bookings`, status: 200,
    summary: 'Record a confirmed booking.', request: AddBooking, response: AddBookingResult },
  { id: 'updateBooking', server: 'go-server', method: 'PATCH', path: `${trip}/bookings/{booking_id}`, status: 200,
    summary: 'Change or cancel a booking.', request: UpdateBooking, response: WriteResult },
  { id: 'addExpense', server: 'go-server', method: 'POST', path: `${trip}/expenses`, status: 200,
    summary: 'Record something someone paid for, split between people.', request: AddExpense, response: AddExpenseResult },
  { id: 'requestSpendApproval', server: 'go-server', method: 'POST', path: `${trip}/spend-approvals`, status: 200,
    summary: 'Run the spend check. Answers with a signed, one-use spend approval for the vault, or the reason why not.',
    request: RequestSpendApproval, response: SpendApprovalResult },
];

/** go-brain serves these. go-server calls them. */
export const GO_BRAIN_ROUTES: readonly Route[] = [
  { id: 'postEvent', server: 'go-brain', method: 'POST', path: '/v1/events', status: 202,
    summary: 'Something happened in a trip. One event per call. go-brain answers fast and does the work afterwards.',
    request: Event, response: EventAccepted },
  { id: 'cardAction', server: 'go-brain', method: 'POST', path: '/v1/trips/{trip_id}/cards/{card_id}/actions', status: 200,
    summary: 'Someone tapped a button on a Go card. Answers within 3 seconds: done, open a page, or refused.',
    request: CardActionRequest, response: CardActionResult },
  { id: 'catchUp', server: 'go-brain', method: 'POST', path: '/v1/trips/{trip_id}/catch-up', status: 200,
    summary: 'What one person missed since they last looked. Answers within 3 seconds.', request: CatchUpRequest, response: CatchUp },
  { id: 'getPerson', server: 'go-brain', method: 'GET', path: '/v1/people/{person_id}', status: 200,
    summary: 'What Go knows about a person, with where each fact came from.', response: PersonPage },
  { id: 'updatePerson', server: 'go-brain', method: 'PATCH', path: '/v1/people/{person_id}', status: 200,
    summary: 'Turn carry-over on or off.', request: UpdatePerson, response: Ok },
  { id: 'deleteFact', server: 'go-brain', method: 'DELETE', path: '/v1/people/{person_id}/facts/{fact_id}', status: 200,
    summary: 'Remove one fact.', response: Ok },
  { id: 'forgetPerson', server: 'go-brain', method: 'DELETE', path: '/v1/people/{person_id}', status: 200,
    summary: 'Forget me. With trip_id: what Go learned in that trip. Without: everything, in every trip.',
    query: z.object({ trip_id: z.string().min(1).max(64).optional() }), response: ForgetResult },
  { id: 'createLink', server: 'go-brain', method: 'POST', path: '/v1/links', status: 200,
    summary: 'A short-lived link to a go-brain page (the vault), to open in the system browser sheet.',
    request: CreateLink, response: Link },
  { id: 'health', server: 'go-brain', method: 'GET', path: '/v1/health', status: 200,
    summary: 'Up, and which contract version it speaks. Not signed.', response: Health },
];

export const ROUTES: readonly Route[] = [...GO_SERVER_ROUTES, ...GO_BRAIN_ROUTES];
