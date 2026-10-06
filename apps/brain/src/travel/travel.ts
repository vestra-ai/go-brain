import type * as C from '@go/contract';

/** Lane C (P4) owns this file. P1 creates it so Brain compiles; P4 replaces the four shapes below with its own. */
export type TravelQuery = Record<string, unknown>;
export type TravelOption = Record<string, unknown>;
export type StatusQuery = Record<string, unknown>;
export type StatusResult = Record<string, unknown>;

/** One interface, two backends (ixigo MCP, fake). */
export interface Travel {
  search(kind: 'flights' | 'trains' | 'buses' | 'stays', q: TravelQuery): Promise<{ results: TravelOption[]; checkedAt: string }>;
  status(q: StatusQuery): Promise<StatusResult>;
  /** The offer behind an options card's option_id (which is also a vote option's option_ref); offerId null when the option came
   *  from a task's web browsing (P5 refuses to book those). */
  offer(optionId: string): Promise<{ offerId: string | null; title: string; priceMinor: number | null; currency: string | null; kind: 'flight' | 'train' | 'bus' | 'stay'; link: string | null } | null>;
  /** Booking is two steps so card details only ever travel between the vault and the rail. Composer and P5 only. */
  hold(offerId: string, lead: { name: string; personIds: string[] }): Promise<Hold>;
  /** Safe to repeat: the same hold confirmed twice gives the same answer. */
  confirm(holdId: string, paid: { approvalId: string; railRef: string }): Promise<Confirmed>;
}

export interface Hold {
  holdId: string;
  amountMinor: number;
  currency: string;
  merchant: string;
  expiresAt: string;
  refundableUntil?: string;
  payment: { kind: 'fake' } | { kind: 'stripe_test' } | { kind: 'ixigo'; token: string };
}

export interface Confirmed {
  ref: string;
  vendor: string;
  title: string;
  kind: C.Booking['kind'];
  startsAt?: string;
  endsAt?: string;
  refundableUntil?: string;
  imageUrl?: string;
  place?: C.Place;
  journey?: C.Journey;
}
