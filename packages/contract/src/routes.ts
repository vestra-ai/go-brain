import type { z } from 'zod';
import { MessageIn, MessageInAccepted } from './message-in.js';
import { MessageOut, MessageOutAccepted } from './message-out.js';
import {
  AddExpense, AddExpenseResult, CloseDecisionResult, Ok, OpenDecision, OpenDecisionResult, RecordBooking,
  RecordBookingResult, RecordCall, RecordCallResult, SetMandate, SettleUpResult, SpendApprovalRequest,
  SpendApprovalResponse, TripState, UpdateTrip,
} from './trip-api.js';

/** Who serves the route. Every call is signed with the x-go-signature header (see signing.ts). */
export type Server = 'go-brain' | 'go-server';

export interface Route {
  id: string;
  server: Server;
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  summary: string;
  request?: z.ZodType;
  response: z.ZodType;
}

const trip = '/brain/v1/trips/{trip_id}';

export const ROUTES: readonly Route[] = [
  { id: 'postMessageIn', server: 'go-brain', method: 'POST', path: '/go/v1/messages',
    summary: 'go-server sends every room message to go-brain. Reply fast; Go answers later via postMessageOut.',
    request: MessageIn, response: MessageInAccepted },
  { id: 'postMessageOut', server: 'go-server', method: 'POST', path: '/brain/v1/messages',
    summary: 'go-brain posts what Go says (text and/or a card) into a trip room. Idempotent on out_id.',
    request: MessageOut, response: MessageOutAccepted },
  { id: 'getTrip', server: 'go-server', method: 'GET', path: trip,
    summary: 'The trip as Go should see it: members, decisions, bookings, money. Budgets only as the lowest band.',
    response: TripState },
  { id: 'updateTrip', server: 'go-server', method: 'PATCH', path: trip,
    summary: 'Go updates the destination, dates, vibe, stay or the day-by-day itinerary.',
    request: UpdateTrip, response: TripState },
  { id: 'openDecision', server: 'go-server', method: 'POST', path: `${trip}/decisions`,
    summary: 'Go opens a vote in the room (choice, private budget, or yes/no).',
    request: OpenDecision, response: OpenDecisionResult },
  { id: 'closeDecision', server: 'go-server', method: 'POST', path: `${trip}/decisions/{decision_id}/close`,
    summary: 'Close a vote and get the result.', response: CloseDecisionResult },
  { id: 'setMandate', server: 'go-server', method: 'POST', path: `${trip}/decisions/{decision_id}/mandate`,
    summary: 'Attach what the group allowed: the choice, the cap, refundable only, and who pays.',
    request: SetMandate, response: Ok },
  { id: 'recordBooking', server: 'go-server', method: 'POST', path: `${trip}/bookings`,
    summary: 'Record a confirmed booking so the Bookings tab and the receipt show it.',
    request: RecordBooking, response: RecordBookingResult },
  { id: 'addExpense', server: 'go-server', method: 'POST', path: `${trip}/expenses`,
    summary: 'Record something someone paid for, split between members.',
    request: AddExpense, response: AddExpenseResult },
  { id: 'settleUp', server: 'go-server', method: 'POST', path: `${trip}/settle-up`,
    summary: 'The fewest payments that square everyone up.', response: SettleUpResult },
  { id: 'requestSpendApproval', server: 'go-server', method: 'POST', path: `${trip}/spend-approvals`,
    summary: 'go-server runs the spend check and returns a signed, one-use spend approval for the vault, or why not.',
    request: SpendApprovalRequest, response: SpendApprovalResponse },
  { id: 'recordCall', server: 'go-server', method: 'POST', path: `${trip}/calls`,
    summary: 'Save a finished call: who asked, the goal, the outcome and the transcript.',
    request: RecordCall, response: RecordCallResult },
];
