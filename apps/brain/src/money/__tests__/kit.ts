import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as C from '@go/contract';
import Fastify from 'fastify';
import type pg from 'pg';
import type { z } from 'zod';
import { makeTurnCtx, type QuickTool, type TurnCtx } from '../../composer/tools.js';
import { withSchema } from '../../db/test-db.js';
import { TO_SERVER_SCHEMAS, type Message, type ToServerMethod, type ToServerParams, type ToServerResult, type Trip } from '../../door/methods.js';
import type { ServerLink } from '../../door/server-link.js';
import type { Confirmed, Hold, Travel } from '../../travel/travel.js';
import { askToPay, idsFrom, postCard, type AskResult } from '../ask.js';
import type { MoneyDeps } from '../deps.js';
import type { PayLinkInput, PayLinkRefusal, TravelDetails, VaultClient } from '../vault-client.js';

/** The contract's spend approval test key (TEST KEY ONLY), so the fake Server signs real approvals. */
export const SPEND_VECTOR = JSON.parse(
  readFileSync(new URL('../../../../../packages/contract/test-vectors/spend-approval.json', import.meta.url), 'utf8'),
) as { private_key_pem: string; public_key_pem: string };

/** An ask for the villa vote: optionRef is the winning option's option_ref, as Pay.askToPay takes it. */
export const VILLA = { decisionId: 'd_villa', optionRef: 'opt_villa_sol', purpose: 'Villa Sol, 3 nights, 6 to 9 Nov' };

const PEOPLE: Array<[string, string, 'organizer' | 'member']> = [
  ['p_rahul', 'Rahul', 'organizer'],
  ['p_priya', 'Priya', 'member'],
  ['p_arjun', 'Arjun', 'member'],
  ['p_meher', 'Meher', 'member'],
  ['p_kabir', 'Kabir', 'member'],
];

export type VillaStage = 'open' | 'closed' | 'mandate' | 'confirmed' | 'declined';

/** The guide's Goa trip, cut down to the stay vote, at a chosen stage. Villa Sol wins 4 to 1; Rahul pays. */
export function goaTrip(stage: VillaStage = 'confirmed', o: { capMinor?: number; refundableOnly?: boolean } = {}): Trip {
  const closed = stage !== 'open';
  const mandate =
    stage === 'mandate' || stage === 'confirmed' || stage === 'declined'
      ? {
          choice_index: 0,
          cap_minor: o.capMinor ?? 5500000,
          currency: 'INR',
          refundable_only: o.refundableOnly ?? true,
          payer_person_id: 'p_rahul',
          set_at: '2026-10-05T08:46:00Z',
          ...(stage === 'confirmed' || stage === 'declined' ? { confirmed_at: '2026-10-05T08:58:00Z' } : {}),
          ...(stage === 'declined' ? { declined_at: '2026-10-05T08:59:00Z' } : {}),
        }
      : null;
  return C.TripSnapshot.parse({
    trip_id: 't_goa',
    seq: 100,
    title: 'Goa',
    status: 'planning',
    created_at: '2026-10-05T02:30:00Z',
    organizer_person_id: 'p_rahul',
    invite_url: 'https://go.example/j/8fK2xQ',
    vibe: [],
    budget: { answered: 0, of: 5 },
    people: PEOPLE.map(([person_id, name, role]) => ({ person_id, name, role, joined_at: '2026-10-05T02:30:00Z', know: [], has_upi: false, go_paused: false })),
    decisions: [
      {
        decision_id: 'd_villa',
        question: 'Where do we stay?',
        kind: 'choice',
        anonymous: false,
        status: closed ? 'closed' : 'open',
        options: [
          // option_ref is the options card's option_id (P4's put_to_vote), not a travel offer id.
          { label: 'Villa Sol', price_minor: 5420000, currency: 'INR', option_ref: 'opt_villa_sol', note: '3 nights, private pool, Anjuna' },
          { label: 'Casa Azul', price_minor: 6180000, currency: 'INR', option_ref: 'opt_casa_azul' },
          { label: 'The Palms', price_minor: 5850000, currency: 'INR', option_ref: 'opt_the_palms' },
        ],
        voted: 5,
        of: 5,
        tally: [4, 1, 0],
        ...(closed ? { result_index: 0, closed_at: '2026-10-05T08:45:00Z' } : {}),
        ...(mandate ? { mandate } : {}),
        opened_at: '2026-10-05T07:30:00Z',
      },
    ],
    bookings: [],
    expenses: [],
    money: { currency: 'INR', spent_minor: 0, by_category: [], transfers: [] },
    itinerary: [],
    record: [],
  });
}

/** A person's chat message, for the "amounts said" rule. */
export function say(seq: number, personId: string, text: string): Message {
  return C.Message.parse({
    message_id: `m_${seq}`,
    seq,
    updated_seq: seq,
    author: { kind: 'person', person_id: personId },
    text,
    attachments: [],
    mentions_go: false,
    mentions: [],
    reactions: [],
    withheld: false,
    deleted: false,
    sent_at: '2026-10-05T08:50:00Z',
  });
}

/** A Server answer that is an error frame, the way P1's ServerLink rejects (a numeric `code`). */
export class FakeCallError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

interface ApprovalRow {
  approval_id: string;
  trip_id: string;
  /** Null for a person's own pick (contract 1.3), which names it instead. */
  decision_id: string | null;
  /** The person whose own pick it is (personal.person_id); null for a vote's. */
  for_person_id: string | null;
  payer_person_id: string;
  amount_minor: number;
  currency: string;
  exp: number;
  used: boolean;
  cancelled: boolean;
  cancel_reason: string | null;
}

/**
 * The Server, for money tests: answers Go's requests from one trip, runs the guide's spend check, signs
 * approvals with the test key, checks approvals on add_booking, and records every write once per request_id.
 */
export class FakeServerLink implements ServerLink {
  readonly trips = new Map<string, Trip>();
  readonly writes: Array<{ method: ToServerMethod; params: Record<string, unknown> }> = [];
  readonly approvals = new Map<string, ApprovalRow>();
  readonly cards = new Map<string, C.Card>();
  readonly posts: Array<{ message_id: string; text: string | null; card: C.Card | null }> = [];
  readonly failNext = new Map<ToServerMethod, Error>();
  private readonly answers = new Map<string, unknown>();
  private n = 0;

  constructor(
    trip: Trip,
    private readonly now: () => Date,
    private readonly spendKeyPem: string = SPEND_VECTOR.private_key_pem,
  ) {
    this.trips.set(trip.trip_id, trip);
  }

  isOpen(): boolean {
    return true;
  }

  notify(): void {}

  trip(tripId: string): Trip {
    const trip = this.trips.get(tripId);
    if (!trip) throw new FakeCallError(404, `no trip ${tripId}`);
    return trip;
  }

  writesOf(method: ToServerMethod): Array<{ method: ToServerMethod; params: Record<string, unknown> }> {
    return this.writes.filter((w) => w.method === method);
  }

  async request<M extends ToServerMethod>(method: M, params: ToServerParams<M>): Promise<ToServerResult<M>> {
    const [paramsSchema, resultSchema] = TO_SERVER_SCHEMAS[method as ToServerMethod] as unknown as readonly [z.ZodType, z.ZodType | null];
    const p = paramsSchema.parse(params) as Record<string, unknown>;
    const failure = this.failNext.get(method);
    if (failure) {
      this.failNext.delete(method);
      throw failure;
    }
    const key = typeof p.request_id === 'string' ? `${String(p.trip_id)}|${p.request_id}` : null;
    if (key && this.answers.has(key)) return this.answers.get(key) as ToServerResult<M>;
    this.writes.push({ method, params: p });
    const out = this.handle(method, p);
    const checked = resultSchema ? resultSchema.parse(out) : undefined;
    if (key) this.answers.set(key, checked);
    return checked as ToServerResult<M>;
  }

  private seq(trip: Trip): number {
    trip.seq += 1;
    return trip.seq;
  }

  private handle(method: ToServerMethod, p: Record<string, unknown>): unknown {
    const trip = this.trip(String(p.trip_id));
    switch (method) {
      case 'read_trip':
        return structuredClone(trip);
      case 'post_message': {
        const card = (p.card ?? null) as C.Card | null;
        if (card && this.cards.has(card.card_id)) throw new FakeCallError(409, 'card_id already in this room');
        if (card?.kind === 'mandate' && !trip.decisions.find((x) => x.decision_id === card.decision_id)?.mandate) throw new FakeCallError(409, 'the vote has no mandate');
        const message_id = `m_${++this.n}`;
        if (card) this.cards.set(card.card_id, card);
        this.posts.push({ message_id, text: typeof p.text === 'string' ? p.text : null, card });
        return { message_id, seq: this.seq(trip) };
      }
      case 'replace_card': {
        const card = p.card as C.Card;
        if (!this.cards.has(card.card_id)) throw new FakeCallError(404, 'no such card');
        this.cards.set(card.card_id, card);
        return { message_id: 'm_card' };
      }
      case 'set_mandate': {
        const decision = trip.decisions.find((x) => x.decision_id === p.decision_id);
        if (!decision) throw new FakeCallError(404, 'no such vote');
        if (decision.kind !== 'choice' || decision.status !== 'closed') throw new FakeCallError(409, 'not a closed choice vote');
        decision.mandate = {
          choice_index: Number(p.choice_index),
          cap_minor: Number(p.cap_minor),
          currency: String(p.currency),
          refundable_only: Boolean(p.refundable_only),
          payer_person_id: String(p.payer_person_id),
          set_at: this.now().toISOString(),
        };
        return { seq: this.seq(trip) };
      }
      case 'request_spend_approval':
        return this.spend(trip, p);
      case 'cancel_spend_approval': {
        const row = this.approvals.get(String(p.approval_id));
        if (!row || row.trip_id !== trip.trip_id) throw new FakeCallError(404, 'no such approval');
        if (!row.used) {
          row.cancelled = true;
          row.cancel_reason = String(p.reason);
        }
        return { ok: true };
      }
      case 'add_booking': {
        if (typeof p.approval_id === 'string') {
          const row = this.approvals.get(p.approval_id);
          if (!row || row.trip_id !== trip.trip_id) throw new FakeCallError(409, "the approval is not one of this trip's");
          if ((p.decision_id ?? null) !== row.decision_id) throw new FakeCallError(409, 'the approval is for another vote');
          if (row.for_person_id !== null && p.payer_person_id !== row.for_person_id) throw new FakeCallError(409, "the approval is another person's own pick");
          if (row.used) throw new FakeCallError(409, 'the approval is already used');
          if (row.cancelled) throw new FakeCallError(409, 'the approval was cancelled');
          if (p.currency !== row.currency || Number(p.amount_minor) > row.amount_minor) throw new FakeCallError(409, 'the booking costs more than the approval allows');
          row.used = true;
        }
        const booking_id = `b_${++this.n}`;
        trip.bookings.push(C.Booking.parse({ ...p, booking_id, status: 'confirmed', created_at: this.now().toISOString() }));
        return { booking_id, seq: this.seq(trip) };
      }
      case 'add_reaction':
        return { seq: this.seq(trip) };
      case 'add_expense': {
        const expense_id = `e_${++this.n}`;
        trip.expenses.push(C.Expense.parse({ ...p, expense_id, created_at: this.now().toISOString() }));
        return { expense_id, seq: this.seq(trip) };
      }
      default:
        throw new FakeCallError(-32601, `${method} is not played by the money kit`);
    }
  }

  /** The guide's spend check, in its order, then a signed one-use approval. A personal pick (1.3): its person in the trip. */
  private spend(trip: Trip, p: Record<string, unknown>): unknown {
    if (p.personal != null) return this.personal(trip, p);
    const now = this.now();
    const decision = trip.decisions.find((x) => x.decision_id === p.decision_id);
    const m = decision?.mandate;
    const outstanding = [...this.approvals.values()].some(
      (a) => a.trip_id === trip.trip_id && a.decision_id === p.decision_id && !a.used && !a.cancelled && a.exp * 1000 > now.getTime(),
    );
    const deny = (reason: string) => ({ status: 'denied', reason });
    if (!decision) return deny('decision_not_found');
    if (decision.status !== 'closed') return deny('decision_not_closed');
    if (decision.kind !== 'choice' || !m) return deny('no_mandate');
    if (m.declined_at && (!m.confirmed_at || Date.parse(m.declined_at) > Date.parse(m.confirmed_at))) return deny('payer_declined');
    if (!m.confirmed_at) return deny('payer_has_not_confirmed');
    if (p.currency !== m.currency) return deny('currency_mismatch');
    if (Number(p.amount_minor) > m.cap_minor) return deny('over_cap');
    if (m.refundable_only && !(typeof p.refundable_until === 'string' && Date.parse(p.refundable_until) > now.getTime())) return deny('not_refundable');
    if (trip.bookings.some((b) => b.decision_id === decision.decision_id && b.status === 'confirmed')) return deny('already_booked');
    if (outstanding) return deny('approval_outstanding');
    const iat = Math.floor(now.getTime() / 1000);
    const exp = iat + C.MAX_APPROVAL_TTL_SECONDS;
    const approval_id = `ap_${randomBytes(6).toString('hex')}`;
    const token = C.signSpendApproval(
      {
        iss: 'server',
        aud: 'go-vault',
        jti: approval_id,
        trip_id: trip.trip_id,
        decision_id: decision.decision_id,
        payer_person_id: m.payer_person_id,
        amount_minor: Number(p.amount_minor),
        currency: String(p.currency),
        merchant: String(p.merchant),
        purpose: String(p.purpose),
        refundable_until: typeof p.refundable_until === 'string' ? p.refundable_until : null,
        iat,
        exp,
      },
      this.spendKeyPem,
    );
    this.approvals.set(approval_id, {
      approval_id,
      trip_id: trip.trip_id,
      decision_id: decision.decision_id,
      for_person_id: null,
      payer_person_id: m.payer_person_id,
      amount_minor: Number(p.amount_minor),
      currency: String(p.currency),
      exp,
      used: false,
      cancelled: false,
      cancel_reason: null,
    });
    return { status: 'approved', approval_id, approval: token, expires_at: new Date(exp * 1000).toISOString() };
  }

  /**
   * The guide's personal rule (1.3), as far as the kit plays it: the person is in the trip; they are the payer, for the
   * amount Go asked. The Server's own tap and price checks are the sim's (packages/sim state/money.ts).
   */
  private personal(trip: Trip, p: Record<string, unknown>): unknown {
    const pick = p.personal as { person_id: string; card_id: string; option_id: string };
    const person = pick.person_id;
    if (!trip.people.some((x) => x.person_id === person)) return { status: 'denied', reason: 'not_in_trip' };
    const iat = Math.floor(this.now().getTime() / 1000);
    const exp = iat + C.MAX_APPROVAL_TTL_SECONDS;
    const approval_id = `ap_${randomBytes(6).toString('hex')}`;
    const token = C.signSpendApproval(
      {
        iss: 'server',
        aud: 'go-vault',
        jti: approval_id,
        trip_id: trip.trip_id,
        personal: { person_id: pick.person_id, card_id: pick.card_id, option_id: pick.option_id },
        payer_person_id: person,
        amount_minor: Number(p.amount_minor),
        currency: String(p.currency),
        merchant: String(p.merchant),
        purpose: String(p.purpose),
        iat,
        exp,
      },
      this.spendKeyPem,
    );
    this.approvals.set(approval_id, {
      approval_id, trip_id: trip.trip_id, decision_id: null, for_person_id: person, payer_person_id: person,
      amount_minor: Number(p.amount_minor), currency: String(p.currency), exp, used: false, cancelled: false, cancel_reason: null,
    });
    return { status: 'approved', approval_id, approval: token, expires_at: new Date(exp * 1000).toISOString() };
  }
}

export interface FakeOffer {
  amountMinor: number;
  currency: string;
  merchant: string;
  refundableUntil: string | null;
  title: string;
  kind: C.Booking['kind'];
  /** The offer's booking page, when the travel layer gives one. */
  link?: string;
}

/** The travel kinds an offer answers with (master §6.3, interface note 15); a booking kind outside them is a stay here. */
const offerKind = (k: C.Booking['kind']): 'flight' | 'train' | 'bus' | 'stay' => (k === 'flight' || k === 'train' || k === 'bus' ? k : 'stay');

/**
 * The travel layer for money tests: options cards' option ids that stand for offers (null for one a job found by
 * browsing), holds with a live price, and confirms once per hold.
 */
export class FakeTravel implements Travel {
  /** Each options-card option, by its option_id (a vote option's option_ref), and the travel offer it stands for. */
  readonly options = new Map<string, string | null>([
    ['opt_villa_sol', 'ixigo:stay:villa-sol-anjuna'],
    ['opt_casa_azul', 'ixigo:stay:casa-azul-assagao'],
    ['opt_the_palms', 'ixigo:stay:the-palms-vagator'],
  ]);
  /** An option's own page on ixigo.com, for one with no offer (an ixigo_web search), by its option_id. */
  readonly pages = new Map<string, string>();
  /** Live prices, by travel offer id. */
  readonly offers = new Map<string, FakeOffer>([
    [
      'ixigo:stay:villa-sol-anjuna',
      { amountMinor: 5420000, currency: 'INR', merchant: 'ixigo: Villa Sol, Anjuna', refundableUntil: '2026-11-01T18:29:59Z', title: 'Villa Sol, 3 nights', kind: 'stay' },
    ],
  ]);
  /** Every option id offer() was asked about, in order. */
  readonly looked: string[] = [];
  readonly holds: Array<{ offerId: string; lead: { name: string; personIds: string[] }; holdId: string }> = [];
  readonly confirms: Array<{ holdId: string; paid: { approvalId: string; railRef: string } }> = [];
  failHold = false;
  failConfirm = false;
  /** offer() throws, as when the travel results cannot be read just now. */
  failOffer = false;
  private readonly confirmed = new Map<string, Confirmed>();

  constructor(private readonly now: () => Date) {}

  /** The live price of a travel offer. */
  priced(offerId: string): FakeOffer {
    const o = this.offers.get(offerId);
    if (!o) throw new Error(`no offer ${offerId}`);
    return o;
  }

  price(offerId: string, amountMinor: number): void {
    this.offers.set(offerId, { ...this.priced(offerId), amountMinor });
  }

  async offer(optionId: string): Promise<Awaited<ReturnType<Travel['offer']>>> {
    this.looked.push(optionId);
    if (this.failOffer) throw new Error('travel results are down');
    if (!this.options.has(optionId)) return null;
    const offerId = this.options.get(optionId) ?? null;
    const o = offerId ? this.offers.get(offerId) : undefined;
    return {
      offerId, title: o?.title ?? optionId, priceMinor: o?.amountMinor ?? null, currency: o?.currency ?? null,
      kind: offerKind(o?.kind ?? 'stay'), link: o?.link ?? this.pages.get(optionId) ?? null,
    };
  }

  async search(): Promise<never> {
    throw new Error('search is not used by the money tests');
  }

  async status(): Promise<never> {
    throw new Error('status is not used by the money tests');
  }

  async hold(offerId: string, lead: { name: string; personIds: string[] }): Promise<Hold> {
    if (this.failHold) throw new Error('the hold failed');
    const o = this.priced(offerId);
    const holdId = `hold_${this.holds.length + 1}`;
    this.holds.push({ offerId, lead, holdId });
    const hold = {
      holdId,
      amountMinor: o.amountMinor,
      currency: o.currency,
      merchant: o.merchant,
      expiresAt: new Date(this.now().getTime() + 15 * 60_000).toISOString(),
      payment: { kind: 'fake' as const },
      ...(o.refundableUntil ? { refundableUntil: o.refundableUntil } : {}),
    };
    return hold;
  }

  async confirm(holdId: string, paid: { approvalId: string; railRef: string }): Promise<Confirmed> {
    const done = this.confirmed.get(holdId);
    if (done) return done;
    this.confirms.push({ holdId, paid });
    if (this.failConfirm) throw new Error('ixigo did not confirm');
    const held = this.holds.find((h) => h.holdId === holdId);
    const o = this.priced(held?.offerId ?? 'ixigo:stay:villa-sol-anjuna');
    const result: Confirmed = {
      ref: 'IXG-7Q2K9',
      vendor: 'ixigo',
      title: o.title,
      kind: o.kind,
      startsAt: '2026-11-06T14:00:00+05:30',
      endsAt: '2026-11-09T11:00:00+05:30',
      ...(o.refundableUntil ? { refundableUntil: o.refundableUntil } : {}),
      place: { name: 'Villa Sol', address: 'Anjuna, North Goa' },
    };
    this.confirmed.set(holdId, result);
    return result;
  }
}

/** The vault for unit tests: records pay links and answers what the test says. */
export class FakeVaultClient implements VaultClient {
  readonly payLinks: PayLinkInput[] = [];
  readonly homeLinks: Array<{ personId: string; start: string }> = [];
  refuse: PayLinkRefusal | null = null;
  /** Why the vault refused, as its 409 says in `detail`. */
  refuseDetail: string | null = null;
  hang = false;
  charged: string[] = [];
  withoutBothKeysValue = 0;
  readonly voids: string[] = [];
  failVoid = false;

  constructor(private readonly now: () => Date) {}

  /** Each person's travel details, as their vault keeps them; and who was read for which booking (never the values). */
  readonly travel = new Map<string, TravelDetails>();
  readonly travelReads: Array<{ personId: string; ref: string }> = [];

  async travelDetails(i: { tripId: string; personId: string; booking: { ref: string; travellerPersonId: string; purpose: string } }): Promise<TravelDetails | null> {
    if (i.personId !== i.booking.travellerPersonId) throw new Error("the vault reads a person's travel details only for a ticket of their own");
    this.travelReads.push({ personId: i.personId, ref: i.booking.ref });
    return this.travel.get(i.personId) ?? null;
  }

  async homeLink(i: { personId: string; start: 'home' | 'add_card' | 'add_login' | 'add_travel' }): Promise<{ url: string; expiresAt: string }> {
    this.homeLinks.push(i);
    return { url: `https://vault.test/l/home_${this.homeLinks.length}`, expiresAt: new Date(this.now().getTime() + 300_000).toISOString() };
  }

  async payLink(i: PayLinkInput, o?: { timeoutMs?: number }): Promise<{ ok: true; url: string; expiresAt: string } | { ok: false; reason: PayLinkRefusal }> {
    if (this.hang) {
      await new Promise((resolve) => setTimeout(resolve, o?.timeoutMs ?? 2_000));
      return { ok: false, reason: 'unavailable' };
    }
    if (this.refuse) return { ok: false, reason: this.refuse, ...(this.refuseDetail ? { detail: this.refuseDetail } : {}) };
    this.payLinks.push(i);
    return { ok: true, url: `https://vault.test/p/pay_${this.payLinks.length}`, expiresAt: new Date(this.now().getTime() + 300_000).toISOString() };
  }

  async voidPayLinks(approvalId: string): Promise<void> {
    if (this.failVoid) throw new Error('the vault did not answer');
    this.voids.push(approvalId);
  }

  async bothKeys(): Promise<{ chargedApprovalIds: string[]; withoutBothKeys: number }> {
    return { chargedApprovalIds: this.charged, withoutBothKeys: this.withoutBothKeysValue };
  }
}

export interface MoneyKit {
  pool: pg.Pool;
  drop: () => Promise<void>;
  server: FakeServerLink;
  travel: FakeTravel;
  vault: FakeVaultClient;
  deps: MoneyDeps;
  lines: string[];
  now(): Date;
  setNow(at: Date): void;
  advance(ms: number): void;
  /** askToPay outside a turn, with ids from `trigger` (each call gets its own unless given). */
  ask(o?: { decisionId: string; optionRef: string; purpose: string }, trigger?: string): Promise<AskResult>;
}

/** A fresh schema, the fake Server with the Goa trip, fake travel and vault, and a clock at 09:00 on 5 Oct. */
export async function moneyKit(o: { trip?: Trip; at?: Date; spendKeyPem?: string } = {}): Promise<MoneyKit> {
  const { pool, drop } = await withSchema();
  let now = o.at ?? new Date('2026-10-05T09:00:00Z');
  const clock = () => now;
  const server = new FakeServerLink(o.trip ?? goaTrip('confirmed'), clock, o.spendKeyPem);
  const travel = new FakeTravel(clock);
  const vault = new FakeVaultClient(clock);
  const lines: string[] = [];
  const log = Fastify({ logger: { level: 'trace', stream: { write: (l: string) => void lines.push(l) } } }).log;
  const deps: MoneyDeps = { pool, link: server, travel: () => travel, vault, payRail: () => 'fake', now: clock, log, tapVaultMs: 200 };
  let n = 0;
  return {
    pool,
    drop,
    server,
    travel,
    vault,
    deps,
    lines,
    now: clock,
    setNow: (at) => {
      now = at;
    },
    advance: (ms) => {
      now = new Date(now.getTime() + ms);
    },
    ask: (a = VILLA, trigger = `trigger_${++n}`) => {
      const ids = idsFrom(trigger, a.decisionId);
      return askToPay(deps, 't_goa', a, ids, postCard(deps, 't_goa', ids.card));
    },
  };
}

/** A composer turn's context, made by P1's own makeTurnCtx (turn id "turn_test"). */
export function turnCtx(tripId: string, link: ServerLink, trip: Trip, messages: Message[] = []): TurnCtx {
  return makeTurnCtx({ tripId, turnId: 'turn_test', link, pack: { trip, messages, seq: trip.seq }, wake: [], signal: new AbortController().signal });
}

/** Runs tool calls the way the composer does: by name, input checked by the tool's own schema. */
export async function runToolCalls(tools: Array<QuickTool<any>>, ctx: TurnCtx, calls: Array<{ name: string; input: unknown }>): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const call of calls) {
    const tool = tools.find((t) => t.name === call.name);
    if (!tool) {
      out.push({ error: `no tool named ${call.name}` });
      continue;
    }
    const args = tool.input.safeParse(call.input);
    out.push(args.success ? await tool.run(args.data, ctx) : { error: 'the input did not match the tool' });
  }
  return out;
}
