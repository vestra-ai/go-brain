/**
 * Go books a flight on ixigo for one traveller (Keshav, 10 Oct: "Go books tickets end to end up to payment"), behind the
 * BOOKING switch. From the traveller's own confirm, "Book it" (taps.ts): the fare opens on the stage, where the
 * room watches (a search for them alone, then ixigo's review page for that flight), the fare type they asked for is
 * chosen there, and the coupon ixigo applies itself is kept and said. It stops before ixigo's pay button: nothing is
 * submitted and no itinerary is made. Their card says what they would pay; Pay goes through the vault.
 *
 * A booking is a row (flight_bookings) a tap starts once, whatever its repeats, and a live card in the room that ticks
 * its steps. No traveller's details are kept, logged or said: the room hears the trip's own name and the outcome.
 */
import { createHash } from 'node:crypto';
import { ticketCard } from '../../money/cards.js';
import type * as C from '@go/contract';
import type pg from 'pg';
import type { Switches } from '../../admin/switches.js';
import type { ServerLink } from '../../door/server-link.js';
import { dayText } from '../answer.js';
import { buildOptionsCard, clip, formatInr, type OptionsCardT } from '../cards.js';
import { stableId } from '../ids.js';
import type { IxigoLogin } from '../login.js';
import { bodiesFor } from '../recipes/recipe.js';
import type { FetchPlan } from '../recipes/recipe.js';
import type { RecipeRunner } from '../recipes/runners.js';
import type { TravelDetails, TravelField } from '../../money/vault-client.js';
import type { ResultsStore } from '../results.js';
import type { StoredOffer } from '../travel.js';
import { fareFor, reviewAddress } from './review-address.js';
import { FARE_TYPES, ixigoCoupon, reviewFare, type FareChoice } from './review-read.js';
import { ageOn, classNow, dayLabel, seatWords, TRAIN_AVAILABILITY, trainOf, trainPassengerSteps, trainResultsAddress } from './train-steps.js';
import { idNameOf, matchTravellers, savedTravellers, spokenFirstName } from './travellers.js';

export const FLIGHT_STREAM = '/flights/v2/search/stream';
export const FLIGHT_FARE = '/flight-booking/flight-fare';
export const GRAPH = '/graph';
/**
 * The account's saved travellers (E2, his browser, 10 Oct 11:21Z: the traveller step's own call, `date` the day flown),
 * caught as the traveller step makes it: ixigo turns away Go's own call for it, which lacks the page's headers.
 */
export const SAVED_TRAVELLERS = '/api/v2/users/traveller';
/** The review step's Continue, which opens the traveller step. */
const CONTINUE = { op: 'click', role: 'button', name: 'Continue' } as const;
/** Said to them alone when their saved travellers didn't read, before the one read more. */
export const TRAVELLERS_RETRY = "Go couldn't read your saved travellers on ixigo just now. Trying again.";
/** A traveller's gender, asked once, theirs alone, when it is the one thing ixigo's form needs that Go doesn't have. */
export const TRAVELLER_MALE = 'traveller_male';
export const TRAVELLER_FEMALE = 'traveller_female';
/** How long a booking counts as under way: a run takes under a minute, and one a restart cut off frees its person after. */
export const RUNNING_MS = 3 * 60_000;
/** The traveller step's fields, its own first call once the review step's Continue is pressed (E2). */
export const TRAVELLER_FIELDS = '/flight-booking/v1/traveller/display-fields';
/** ixigo's own flights stream, as flights.results reads it: the last whole event, up to Bash's most. */
const STREAM_BYTES = 4_194_304;
/** The pay card's action, on the traveller's ready card. */
export const PAY_FLIGHT = 'pay_flight';

type WorkingCard = Extract<C.Card, { kind: 'working' }>;
type NoticeCard = Extract<C.Card, { kind: 'notice' }>;
type Log = { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };

export type BookingState = 'fare' | 'fare_type' | 'coupon' | 'travellers' | 'ready_to_pay' | 'paid' | 'failed';

/** How long Pay waits on the payment's approval inside the tap's 2.5 s; past it, the next Pay finds it ready. */
export const PAY_WAIT_MS = 2_200;

/**
 * Money's Pay (money/pay.ts) as a booking uses it: requestTicketApproval asks the Server's personal approval for a person's
 * own ticket, no vote, and the vault's pay page for that person alone; the vault still needs the Server's signature and
 * their Face ID. The approval names their pick (contract 1.3, G3): the options card they tapped (cardId) and the flight on
 * it (optionId). Optional until money has it: without it, Pay says it opens soon.
 */
export interface TicketPay {
  requestTicketApproval?(
    tripId: string,
    o: { personId: string; cardId: string; optionId: string; amountMinor: number; currency: string; purpose: string; key: string; trigger: string },
  ): Promise<{ url: string; expiresAt: string; approvalId: string; paymentId: string } | { refused: string; code: string }>;
  /**
   * p1-b's #440: the Server's personal approval for the pick, then ONE pay card for its traveller alone, money's: Approve
   * opens the vault (Face ID), and money keeps the card (paid, declined, expired). The same key again gives the same card.
   */
  requestTicketCard?(
    tripId: string,
    o: { personId: string; cardId: string; optionId: string; amountMinor: number; currency: string; purpose: string; key: string; trigger: string },
  ): Promise<{ cardId: string; paymentId: string } | { refused: string; code: string; say: boolean }>;
  onPaid(fn: (p: { tripId: string; approvalId: string; railRef: string }) => Promise<void>): void;
  /** Their travel details from their vault (#395), for a ticket of their own: typed only into ixigo's traveller form. */
  travelDetails?(i: { tripId: string; personId: string; booking: { ref: string; travellerPersonId: string; purpose: string } }): Promise<TravelDetails | null>;
  /** The vault's own travel details form for them, showing the fields a booking's one ask needs (detailsAsk). */
  travelLink?(personId: string, fields?: TravelField[]): Promise<{ url: string; expiresAt: string }>;
}

/** A payment the vault can't take (its rail not ready, or it refused): said in the vault's words, never sent to ixigo. */
const VAULT_CANT: ReadonlySet<string> = new Set(['rail_not_ready', 'vault_refused']);
/** Who sells a ticket Go books: ixigo, and simulated, as a stay is (web-stays.ts): Go stops before ixigo's own pay button. */
export const TICKET_VENDOR = 'ixigo (simulated)';

export type PayTap = { result: 'open'; url: string; expires_at: string } | { result: 'refused'; toast: string } | { result: 'done'; toast: string };

export interface BookingAsk {
  /** The tap that asked, which names the booking: a repeat of it is the same booking. */
  tapId: string;
  tripId: string;
  personId: string;
  /** Their name in the trip, for the room's words. */
  name: string;
  offer: StoredOffer;
  choice: FareChoice;
  /**
   * The person's own card as it was before their pick showed it with their flight alone (taps.ts, G2): put back when the
   * booking stops before the pay card, so they can pick again (the G2 drill, 11 Oct: logged out, nothing was left to tap).
   */
  restore?: OptionsCardT;
  /** Their gender as they said it on Go's ask (genderAsk), for ixigo's traveller form when the vault has none. */
  gender?: 'male' | 'female';
}

export interface FlightBookingDeps {
  pool: pg.Pool;
  /** A person's name in the trip: whose ixigo the saved travellers are on, for the room's words. */
  nameOf: (tripId: string, personId: string) => Promise<string>;
  /** Money's Pay, read at the tap: money registers after travel. */
  pay?: () => TicketPay | undefined;
  /**
   * The trip's ixigo login (login.ts): the saved travellers are the logged-in account's, so a trip with none is asked to
   * log in once, on its own card, and the booking stops there.
   */
  login?: Pick<IxigoLogin, 'ensure'>;
  runner: () => RecipeRunner | null;
  link: Pick<ServerLink, 'request'>;
  switches: Pick<Switches, 'get'>;
  now: () => Date;
  log: Log;
  /** Where a fare that moved is put to its traveller again, on a card of its own; absent, the run says it in a line. */
  results?: Pick<ResultsStore, 'optionOf' | 'saveCard' | 'replaceCard' | 'offer'>;
}

/**
 * How far over the price a person picked at a fare may come and still be booked (the App team's G2, 11 Oct; the Server's
 * personal approval allows the same): more, and they are asked again at the new price.
 */
export const FARE_MOVE_OK = 1.05;

/**
 * How long a booking waits on the trip's ixigo login before its person's card is put back for them to pick again
 * (Keshav, 11 Oct: "when logged in, automatically continue"; the lead: one never in puts the card back).
 */
export const LOGIN_WAIT_MS = 30 * 60_000;

/** What a booking waiting on the login carries on with: the ask, but its offer, read again by its option id. */
/**
 * What a booking that waits (a login, their gender, their travel details) carries on with; askCardId: the card that asked
 * them; need: the travel details it waits on in their vault (askForDetails).
 */
type Resume = { tapId: string; name: string; choice: FareChoice; restore?: OptionsCardT; gender?: 'male' | 'female'; askCardId?: string; need?: TravelField[] };

/** A day (DDMMYYYY, as ixigo's results address writes it) as ixigo's traveller list takes it: its midnight in India, in ms. */
export function dayMs(ddmmyyyy: string): number | null {
  const m = /^(\d{2})(\d{2})(\d{4})$/.exec(ddmmyyyy);
  return m ? Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])) - 330 * 60_000 : null;
}

/** The flight numbers a card's title names ("IndiGo 6E328 + 6E5106"), as ixigo's flight keys hold them. */
export const numbersOf = (title: string): string[] => title.match(/\b[0-9A-Z]{2}\d{1,4}\b/g) ?? [];

/**
 * The live card: what the traveller sees while Go books, each step ticking. Posted once, for them alone (1.2
 * visible_to_person_ids, Keshav: a person's booking is theirs), or for the room (only null: the group's stay), then
 * replaced in place, which keeps who sees it.
 */
export function bookingLiveCard(
  d: Pick<FlightBookingDeps, 'link' | 'now'> & { log: Pick<Log, 'warn'> }, tripId: string, cardId: string, title: string, texts: string[], only: string[] | null,
) {
  const steps = texts.map((text) => ({ text: clip(text, 80), state: 'todo' as 'todo' | 'doing' | 'done' | 'failed' }));
  let state: WorkingCard['state'] = 'running';
  let posted = false;
  let chain: Promise<void> = Promise.resolve();
  const card = (): WorkingCard => ({
    card_id: cardId, kind: 'working', fallback_text: clip(title, 300), task_id: `book_${cardId}`, title: clip(title, 80), state, steps,
    screenshot_url: null, page_url: null, updated_at: d.now().toISOString(), actions: [],
  });
  const send = (): Promise<void> => {
    const now = card();
    chain = chain.then(async () => {
      try {
        if (!posted) {
          await d.link.request('post_message', { request_id: stableId('go_book_live', cardId), trip_id: tripId, card: now, ...(only ? { visible_to_person_ids: only } : {}) });
          posted = true;
        } else {
          await d.link.request('replace_card', { trip_id: tripId, card: now });
        }
      } catch (err) {
        d.log.warn({ err: String(err).slice(0, 200), cardId }, 'travel: a booking live card update failed');
      }
    });
    return chain;
  };
  return {
    /** A step's state, and what it found when it says so ("1 Bedroom Apartment: ₹5,475.66 for the stay"). */
    step(i: number, s: 'doing' | 'done' | 'failed', found?: string): Promise<void> {
      if (steps[i]) {
        steps[i]!.state = s;
        if (found) steps[i]!.text = clip(found, 80);
      }
      return send();
    },
    finish(ok: boolean): Promise<void> {
      for (const s of steps) if (s.state === 'doing') s.state = ok ? 'done' : 'failed';
      state = ok ? 'done' : 'failed';
      return send();
    },
  };
}

/** The traveller's ready card: what they would pay, for what, with ixigo's coupon, and Pay for them alone. */
export function readyCard(i: {
  cardId: string; personId: string; name: string; title: string; when: string | null; choice: FareChoice; amountMinor: number;
  coupon: { code: string; savingMinor: number } | null;
}): NoticeCard {
  const only = [i.personId];
  const coupon = i.coupon ? ` ixigo's ${i.coupon.code} coupon: ${formatInr(i.coupon.savingMinor)} off.` : '';
  return {
    card_id: i.cardId,
    kind: 'notice',
    tone: 'info',
    for_person_ids: only,
    title: clip(`Ready to pay ${formatInr(i.amountMinor)} for ${i.name}`, 80),
    body: clip(`${i.title}${i.when ? `, ${i.when}` : ''}, ${FARE_TYPES[i.choice].words}.${coupon}`, 500),
    fallback_text: clip(`Ready to pay ${formatInr(i.amountMinor)} for ${i.name}: ${i.title}`, 300),
    actions: [{ action_id: PAY_FLIGHT, label: 'Pay', style: 'primary', only_for_person_ids: only }],
  };
}

/**
 * The card for a traveller ixigo's account doesn't have once: their own, saying whose ixigo to add them on. It names
 * nobody but the trip's own people, and none of the account's saved travellers.
 */
/**
 * The note when a booking waits on the trip's ixigo login. ownerIsThem: the login card is theirs (the booker is asked
 * first, the lead, 11 Oct). Go carries on by itself once it's in (Keshav, 11 Oct: "when logged in, automatically
 * continue"). A traveller who isn't saved on the account is never asked to be: Go types them in (newTravellerSteps).
 */
export function travellerAsk(cardId: string, ask: Pick<BookingAsk, 'personId' | 'name' | 'restore'>, owner: string | null, ownerIsThem = false): NoticeCard {
  // The drill, 10 Oct 15:43Z: the booking stopped at its travellers, and the traveller heard nothing why.
  const body = ownerIsThem
    ? "Your booking needs the trip's ixigo login, which isn't linked yet. Log in on your card and Go carries on with your booking."
    : `Your booking needs the trip's ixigo login, which isn't linked yet${owner ? `: ${owner} has the Log in to ixigo card` : ''}. Once it's in, Go carries on with your booking.`;
  return {
    card_id: cardId, kind: 'notice', tone: 'heads_up', for_person_ids: [ask.personId],
    title: clip(`${ask.name}, one step on ixigo first`, 80), body: clip(body, 500), fallback_text: clip(body, 300),
  };
}

/**
 * The one thing ixigo's traveller form needs that Go doesn't have (no vault details): their gender, asked once, theirs
 * alone, with two buttons. Their tap carries the booking on by itself (FlightBooking.gender).
 */
export function genderAsk(cardId: string, personId: string, name: string): NoticeCard {
  const body = `${name}, ixigo's traveller form needs your gender as on your ID for this ticket. Tap one and Go carries on with your booking.`;
  const only = [personId];
  return {
    card_id: cardId, kind: 'notice', tone: 'heads_up', for_person_ids: only,
    title: clip(`${name}, one detail for your ticket`, 80), body: clip(body, 500), fallback_text: clip(body, 300),
    actions: [
      { action_id: TRAVELLER_MALE, label: 'Male', style: 'secondary', only_for_person_ids: only },
      { action_id: TRAVELLER_FEMALE, label: 'Female', style: 'secondary', only_for_person_ids: only },
    ],
  };
}

/** A ticket's own kind of options card: a train's, else a flight's. */
const kindOf = (ask: Pick<BookingAsk, 'offer'>): 'flight' | 'train' => (ask.offer.kind === 'train' ? 'train' : 'flight');

/** A booking's one ask for what its form needs from the vault (detailsAsk, a train's or a bus's): its tap opens the vault's travel form. */
export const TRAVEL_DETAILS = 'travel_details';

/** A travel detail as the ask names it: a birthday is asked for as the age it gives. */
const FIELD_WORDS: Record<TravelField, string> = { first_name: 'name as on your ID', last_name: 'name as on your ID', gender: 'gender', dob: 'age', irctc_user_id: 'IRCTC user ID' };

/** Whether their vault's travel details have every one of these. */
export function hasFields(t: TravelDetails | null, need: readonly TravelField[]): boolean {
  if (!t) return false;
  const has: Record<TravelField, boolean> = { first_name: !!t.firstName, last_name: !!t.lastName, gender: !!t.gender, dob: !!t.dob, irctc_user_id: !!t.irctcUserId };
  return need.every((f) => has[f]);
}

/**
 * A booking's one ask, one tap and short (the lead, 11 Oct; Keshav: "just ask me details"): the travel details its form
 * needs that their vault doesn't have yet (need: a train's age and IRCTC user ID, a bus's age), added once in the
 * vault's own form, never in the chat. The booking carries on by itself once they're there (sweep). ticket: "train", "bus".
 */
export function detailsAsk(cardId: string, personId: string, name: string, need: readonly TravelField[], ticket: string): NoticeCard {
  const words = [...new Set(need.map((f) => FIELD_WORDS[f]))];
  const what = words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : (words[0] ?? 'travel details');
  const them = words.length > 1 ? 'them' : 'it';
  const body = `Your ${ticket} needs your ${what}: add ${them} once (30 s), and Go carries on with your booking.`;
  const only = [personId];
  return {
    card_id: cardId, kind: 'notice', tone: 'heads_up', for_person_ids: only,
    title: clip(`${name}, one step for your ${ticket}`, 80), body: clip(body, 500), fallback_text: clip(body, 300),
    actions: [{ action_id: TRAVEL_DETAILS, label: words.length > 1 ? 'Add them' : 'Add it', style: 'primary', only_for_person_ids: only }],
  };
}

/** A traveller typed into ixigo's form: their name as on their ID and the title their gender gives. */
export interface NewTraveller { first: string; last: string; gender: 'male' | 'female' }

/**
 * The shapes ixigo's Title may take, tried in turn (the lead, 11 Oct; E2 saw its label, not its control): a select, which
 * takes its option typed in; chips or buttons; radios. Each by the title's own text, Mr or Ms.
 */
export const TITLE_SHAPES = ['select', 'chips', 'radio'] as const;
export type TitleShape = (typeof TITLE_SHAPES)[number];

/**
 * ixigo's "Adult 1" form on the traveller step (E2, his browser, 10 Oct: Title, "First & Middle Name", "Last Name",
 * Nationality, India by default), filled for a traveller not saved on the account, its Title as one shape. A step that
 * finds no box ends the fetch before anything is submitted: the next shape is tried.
 */
export function newTravellerSteps(t: NewTraveller, shape: TitleShape = 'select'): NonNullable<FetchPlan['steps']> {
  const title = t.gender === 'male' ? 'Mr' : 'Ms';
  const titleStep: NonNullable<FetchPlan['steps']>[number] = shape === 'select'
    ? { op: 'type', role: 'combobox', name: 'Title', text: title }
    : { op: 'click', role: shape === 'chips' ? 'button' : 'radio', name: title, near_text: 'Adult 1' };
  return [
    titleStep,
    { op: 'type', role: 'textbox', name: 'First & Middle Name', text: t.first },
    { op: 'type', role: 'textbox', name: 'Last Name', text: t.last },
  ];
}

export interface FlightBooking {
  /**
   * Whether Go books this trip's flights itself: Go reads ixigo.com in the trip's browser, and BOOKING is on, or
   * names the trip's Server instance ("instances:drill-p0").
   */
  onFor(tripId: string): Promise<boolean>;
  /**
   * Starts the booking a tap asked for, once; its work goes on after the tap is answered. 'running': another booking of
   * theirs is under way (a second tap on the room's card), and nothing starts.
   */
  start(ask: BookingAsk): Promise<'started' | 'running'>;
  /** Their tap on the gender ask (genderAsk): kept for the booking that waits on it, which carries on by itself. */
  gender(i: { tripId: string; cardId: string; personId: string; gender: 'male' | 'female' }): Promise<{ result: 'done' | 'refused'; toast: string }>;
  /** Their tap on a train's details ask (detailsAsk): the vault's travel form for them, when a booking waits on it. */
  detailsLink(i: { tripId: string; cardId: string; personId: string }): Promise<{ result: 'open'; url: string; expires_at: string } | { result: 'refused'; toast: string }>;
  /** Pay on a traveller's ready card: the vault's pay page for them alone, or why not. Inside the tap's 2.5 s. */
  pay(i: { tripId: string; cardId: string; personId: string; tapId: string }): Promise<PayTap>;
  /** The trip's ixigo login just landed (login.ts onLoggedIn): every booking that waited on it carries on. */
  resumeWaiting(tripId: string): Promise<void>;
  /**
   * Every LOGIN_SWEEP_MS: a booking whose login landed while nothing heard it carries on; one whose login was let go (Not
   * now) or never came in LOGIN_WAIT_MS puts its person's card back as it was.
   */
  sweep(): Promise<void>;
  /** Waits for the bookings started in the background (tests). */
  settled(): Promise<void>;
}

/**
 * Who a ticket is for and when, for its words: "for Meher, Fri 6 Nov, 06:05 to 08:35" (India time), from its journey
 * when its search kept one.
 */
export function ticketWhen(name: string | null, journey: { depart_at: string; arrive_at: string } | null): string | null {
  const parts: string[] = [];
  if (name) parts.push(`for ${name}`);
  if (journey) {
    const ist = (iso: string) => new Date(Date.parse(iso) + 330 * 60_000).toISOString();
    const hm = (iso: string) => ist(iso).slice(11, 16);
    parts.push(`${dayText(ist(journey.depart_at).slice(0, 10))}, ${hm(journey.depart_at)} to ${hm(journey.arrive_at)}`);
  }
  return parts.length ? parts.join(', ') : null;
}

/**
 * Whether Go books this trip's flights and stays itself: Go reads ixigo.com in the trip's browser, and BOOKING is on, or
 * names the trip's Server instance ("instances:drill-p0").
 */
export async function bookingOnFor(d: Pick<FlightBookingDeps, 'pool' | 'switches'>, tripId: string): Promise<boolean> {
  if (d.switches.get('TRAVEL_MODE') !== 'ixigo_web') return false;
  const value = d.switches.get('BOOKING');
  if (value === 'on') return true;
  if (!value.startsWith('instances:')) return false;
  const names = value.slice('instances:'.length).split(',');
  const r = await d.pool.query<{ server_instance: string | null }>('select server_instance from trips where trip_id = $1', [tripId]);
  const instance = r.rows[0]?.server_instance ?? null;
  return instance !== null && names.includes(instance);
}

export function createFlightBooking(d: FlightBookingDeps): FlightBooking {
  const running = new Set<Promise<void>>();
  // Paid, the vault's word through money: the booking that asked for that approval is paid. Hooked on the first Pay, since
  // money registers after travel.
  let hooked = false;
  const hookPaid = (pay: TicketPay): void => {
    if (hooked) return;
    hooked = true;
    pay.onPaid(async ({ tripId, approvalId }) => {
      // The booking that approval paid for: its pay card's payment (money's) keeps this run as its key (hold_id); a ready
      // card's Pay from before kept the approval on the booking itself.
      const r = await d.pool.query<{ run_id: string; person_id: string; option_id: string; title: string; total_minor: string | null }>(
        `update flight_bookings f set state = 'paid', approval_id = $2, updated_at = $3
         where f.trip_id = $1 and f.state <> 'paid'
           and (f.approval_id = $2 or f.run_id in (select p.hold_id from payments p where p.trip_id = $1 and p.approval_id = $2 and p.kind = 'ticket'))
         returning f.run_id, f.person_id, f.option_id, f.title, f.total_minor`,
        [tripId, approvalId, d.now()],
      );
      for (const b of r.rows) await addTicket(tripId, approvalId, b);
    });
  };

  /**
   * A paid ticket on the trip, as that person's own (the App team's G2): Go's own reference, simulated, as a stay's is,
   * since Go stops before ixigo's pay button; the flight's journey when its search kept it.
   */
  const addTicket = async (tripId: string, approvalId: string, b: { run_id: string; person_id: string; option_id: string; title: string; total_minor: string | null }): Promise<void> => {
    if (b.total_minor === null) return;
    const journey = d.results ? ((await d.results.optionOf(b.option_id).catch(() => null))?.journey ?? null) : null;
    const ref = `SIM-${createHash('sha256').update(b.run_id).digest('hex').slice(0, 8).toUpperCase()}`;
    const booked = await d.link.request('add_booking', {
      request_id: stableId('go_ticket_booking', b.run_id),
      trip_id: tripId,
      kind: 'flight',
      title: clip(b.title, 120),
      vendor: TICKET_VENDOR,
      ref,
      amount_minor: Number(b.total_minor),
      currency: 'INR',
      payer_person_id: b.person_id,
      for_person_ids: [b.person_id],
      approval_id: approvalId,
      ...(journey ? { journey, starts_at: journey.depart_at } : {}),
    });
    // Their ticket, theirs alone: the booking drawn as a ticket (its route and times are the booking's journey), a demo
    // one, since Go stops before ixigo's own pay button and nothing real is booked.
    const name = await d.nameOf(tripId, b.person_id).then(spokenFirstName, () => null);
    await d.link.request('post_message', {
      request_id: stableId('go_ticket_card', b.run_id), trip_id: tripId, visible_to_person_ids: [b.person_id],
      card: ticketCard({ cardId: stableId('c_ticket', b.run_id), bookingId: booked.booking_id, title: b.title, ref, refundableUntil: null, simulated: true, detail: ticketWhen(name, journey) }),
    });
  };

  const save = async (runId: string, patch: { state: BookingState; total_minor?: number; coupon_code?: string | null; coupon_minor?: number | null; review_url?: string; card_id?: string; why?: string }): Promise<void> => {
    await d.pool.query(
      `update flight_bookings set state = $2, total_minor = coalesce($3, total_minor), coupon_code = coalesce($4, coupon_code),
         coupon_minor = coalesce($5, coupon_minor), review_url = coalesce($6, review_url), card_id = coalesce($7, card_id), why = coalesce($8, why),
         updated_at = $9 where run_id = $1`,
      [runId, patch.state, patch.total_minor ?? null, patch.coupon_code ?? null, patch.coupon_minor ?? null, patch.review_url ?? null, patch.card_id ?? null, patch.why ?? null, d.now()],
    );
  };

  /**
   * A booking that stopped before the pay card puts the person's own card back as it was, its options and "I'll take
   * this", so they can pick again; never one whose fare moved (it gets its own card at the new price).
   */
  async function putBack(ask: Pick<BookingAsk, 'tripId' | 'restore'>): Promise<void> {
    if (!ask.restore || !d.results) return;
    try {
      await d.results.replaceCard(ask.tripId, ask.restore);
      await d.link.request('replace_card', { trip_id: ask.tripId, card: ask.restore });
    } catch (err) {
      d.log.warn({ err: String(err).slice(0, 200), cardId: ask.restore.card_id }, "travel: a person's card could not be put back after their booking stopped");
    }
  }

  /**
   * The fare moved more than 5%: the traveller's own card of that flight at its new price, theirs alone, to pick again
   * (their pick books it, as any pick does); or, with no store for the card, the line alone.
   */
  async function askAgain(ask: BookingAsk, runId: string, pickedMinor: number, nowMinor: number): Promise<void> {
    const text = `${ask.name}, ${ask.offer.title} is ${formatInr(nowMinor)} now, up from ${formatInr(pickedMinor)}. Tap I'll take this to book it at ${formatInr(nowMinor)}.`;
    const option = d.results ? await d.results.optionOf(ask.offer.optionId).catch(() => null) : null;
    if (!d.results || !option) {
      await d.link.request('post_message', { request_id: stableId('go_fare', runId), trip_id: ask.tripId, text, visible_to_person_ids: [ask.personId] });
      return;
    }
    const cardId = stableId('c_fare', runId);
    const optionId = stableId('opt', cardId, 1);
    const repriced = { ...option, priceMinor: nowMinor };
    const card = buildOptionsCard({
      cardId, title: clip(`${ask.offer.title} at ${formatInr(nowMinor)} now`, 80), optionKind: kindOf(ask), checkedAt: d.now().toISOString(),
      picks: [{ optionId, option: repriced, imageUrl: null }], forPersonIds: [ask.personId],
    });
    await d.results.saveCard({ cardId, tripId: ask.tripId, resultsId: ask.offer.resultsId, title: card.title, optionKind: kindOf(ask), card }, [{ optionId, n: 1, option: repriced }], card.checked_at);
    await d.link.request('post_message', { request_id: stableId('go_fare', runId), trip_id: ask.tripId, text, card, visible_to_person_ids: [ask.personId] });
  }

  /**
   * The trip's computer logged in, or a wait for it: its login card goes to the person booking (anyone in the trip can log
   * in there), and the booking waits, their pick kept: the login landing carries it on (resumeWaiting); one let go, or
   * never in, puts their card back (sweep). A booking that waits again keeps the time it first waited (Keshav, 11 Oct:
   * "when logged in, automatically continue"). True when it is in.
   */
  async function waitForLogin(ask: BookingAsk, runId: string, live: ReturnType<typeof bookingLiveCard>, step: number): Promise<boolean> {
    const title = ask.offer.title;
    const login = d.login ? await d.login.ensure(ask.tripId, `Booking ${title} for ${ask.name}`, { booking: true, for: ask.personId }).catch(() => null) : { ok: true as const };
    if (login?.ok) return true;
    const holder = await d.pool.query<{ person_id: string }>('select person_id from ixigo_logins where trip_id = $1', [ask.tripId]).then((r) => r.rows[0]?.person_id ?? null).catch(() => null);
    const owner = holder ? await d.nameOf(ask.tripId, holder).then(spokenFirstName, () => null) : null;
    await d.link.request('post_message', {
      request_id: stableId('go_book_login', runId), trip_id: ask.tripId,
      card: travellerAsk(stableId('c_book_login', runId), ask, owner, holder === ask.personId), visible_to_person_ids: [ask.personId],
    });
    d.log.info({ runId, tripId: ask.tripId }, 'travel: a booking waits on the trip login');
    const resume: Resume = { tapId: ask.tapId, name: ask.name, choice: ask.choice, ...(ask.restore ? { restore: ask.restore } : {}), ...(ask.gender ? { gender: ask.gender } : {}) };
    await d.pool.query(
      `update flight_bookings set state = 'failed', why = 'login_needed', resume = $2, waiting_since = coalesce(waiting_since, $3), updated_at = $3 where run_id = $1`,
      [runId, JSON.stringify(resume), d.now()],
    );
    await live.step(step, 'failed');
    await live.finish(false);
    return false;
  }

  /**
   * The one ask for the travel details a booking's form needs (need), theirs alone (detailsAsk), and the booking waits
   * on it: the sweep carries it on once their vault has every one, or lets it go after LOGIN_WAIT_MS with their card back.
   * A train's and a bus's run both wait here (p5's buses, 11 Oct).
   */
  async function askForDetails(ask: BookingAsk, runId: string, live: ReturnType<typeof bookingLiveCard>, step: number, need: TravelField[], ticket: string): Promise<void> {
    const askCardId = stableId('c_book_details', runId);
    await d.link.request('post_message', {
      request_id: stableId('go_book_details', runId), trip_id: ask.tripId, card: detailsAsk(askCardId, ask.personId, ask.name, need, ticket), visible_to_person_ids: [ask.personId],
    });
    const resume: Resume = { tapId: ask.tapId, name: ask.name, choice: ask.choice, ...(ask.restore ? { restore: ask.restore } : {}), ...(ask.gender ? { gender: ask.gender } : {}), askCardId, need };
    await d.pool.query(
      `update flight_bookings set state = 'failed', why = 'details_needed', resume = $2, waiting_since = coalesce(waiting_since, $3), updated_at = $3 where run_id = $1`,
      [runId, JSON.stringify(resume), d.now()],
    );
    await live.step(step, 'failed');
    await live.finish(false);
  }

  /**
   * Ready to pay (the App team's G2, 11 Oct): ONE pay card for them alone, money's, with the Server's personal approval for
   * the card and option they tapped in it: Approve opens the vault, Face ID, and it is paid. Nothing on ixigo is
   * submitted. A money without it: their ready card (ready) with Pay, as before.
   */
  async function readyToPay(o: {
    ask: BookingAsk; runId: string; live: ReturnType<typeof bookingLiveCard>; step: number; amountMinor: number; purpose: string;
    ready: (cardId: string) => NoticeCard;
  }): Promise<void> {
    const { ask, runId, live, step, amountMinor } = o;
    const pay = d.pay?.();
    if (pay?.requestTicketCard) {
      hookPaid(pay);
      const got = await pay
        .requestTicketCard(ask.tripId, {
          personId: ask.personId, cardId: ask.offer.cardId, optionId: ask.offer.optionId, amountMinor, currency: 'INR', purpose: o.purpose, key: runId, trigger: ask.tapId,
        })
        .catch((err: unknown) => ({ refused: "Go couldn't get the payment ready just now.", code: 'server_down', say: false, err }));
      if ('cardId' in got) {
        await save(runId, { state: 'ready_to_pay', card_id: got.cardId });
        await live.step(step, 'done');
        await live.finish(true);
        return;
      }
      d.log.warn({ runId, code: got.code }, 'travel: a ticket pay card was refused');
      await save(runId, { state: 'failed', why: `pay_${got.code}` });
      await live.step(step, 'failed');
      await live.finish(false);
      // The vault can't take it (its rail not ready, or it refused the approval): why, in the vault's words, and the next
      // step inside Go, theirs alone (p2's #481). Never ixigo's pay page (Keshav, 11 Oct: an ixigo page is never the answer;
      // pay is always through the vault). A person with no card never gets here: the vault's own pay page has them add
      // one. Any other no: said, theirs alone, where money doesn't say it.
      if (VAULT_CANT.has(got.code)) {
        const their = kindOf(ask) === 'train' ? 'train card' : 'flights card';
        await d.link.request('post_message', {
          request_id: stableId('go_book_vault', runId), trip_id: ask.tripId,
          text: `${got.refused} Your pick is kept: tap I'll take this on your ${their} to pay once it goes through.`, visible_to_person_ids: [ask.personId],
        });
      } else if (!got.say) {
        await d.link.request('post_message', { request_id: stableId('go_book_no', runId), trip_id: ask.tripId, text: got.refused, visible_to_person_ids: [ask.personId] });
      }
      await putBack(ask);
      return;
    }
    await live.step(step, 'done');
    const cardId = stableId('c_ready', runId);
    await d.link.request('post_message', { request_id: stableId('go_book_ready', runId), trip_id: ask.tripId, card: o.ready(cardId), visible_to_person_ids: [ask.personId] });
    await save(runId, { state: 'ready_to_pay', card_id: cardId });
    await live.finish(true);
  }

  /** A booking by its ticket's kind: a train's run (bookTrain), else a flight's. */
  function book(asked: BookingAsk, runId: string): Promise<void> {
    return asked.offer.kind === 'train' ? bookTrain(asked, runId) : bookFlight(asked, runId);
  }

  async function bookFlight(asked: BookingAsk, runId: string): Promise<void> {
    // Their first name in every word of it, as Go says names (p2's prod audit, 11 Oct: "Booking … for <first last>").
    const ask = { ...asked, name: spokenFirstName(asked.name) };
    const runner = d.runner();
    const title = ask.offer.title;
    const live = bookingLiveCard(d, ask.tripId, stableId('c_book', runId), `Booking ${title} for ${ask.name}`, [
      `Opening ${title} on ixigo`, `Choosing ${FARE_TYPES[ask.choice].words}`, "ixigo's coupon", 'Filling travellers privately', `Ready to pay for ${ask.name}`,
    ], [ask.personId]);
    const fail = async (why: string, step: number): Promise<void> => {
      d.log.info({ runId, tripId: ask.tripId, why }, 'travel: a flight booking stopped');
      await save(runId, { state: 'failed', why });
      await live.step(step, 'failed');
      await live.finish(false);
      await putBack(ask);
    };
    if (!runner || !ask.offer.sourceUrl) return fail('no_runner', 0);

    // 1. The fare, on the stage: ixigo's results for the traveller alone, then that flight's review page.
    await live.step(0, 'doing');
    const results = new URL(ask.offer.sourceUrl);
    results.searchParams.set('adults', '1');
    results.searchParams.set('children', '0');
    results.searchParams.set('infants', '0');
    const listed = await runner
      .read(ask.tripId, results.toString(), { capture: [{ match: FLIGHT_STREAM, required: true, max_bytes: STREAM_BYTES, sse: 'last' }] }, { stage: true, tag: runId })
      .catch(() => null);
    const stream = listed ? bodiesFor(listed.captures, FLIGHT_STREAM, true).at(-1) : undefined;
    const fare = stream ? fareFor(stream, numbersOf(title)) : null;
    if (!fare) return fail('fare_not_found', 0);
    const review = reviewAddress(fare);
    await save(runId, { state: 'fare_type', review_url: review });
    await live.step(0, 'done');

    // 2. The fare type they asked for, chosen on ixigo's own radio; 3. the coupon ixigo applied itself, kept.
    await live.step(1, 'doing');
    const opened = await runner
      .read(
        ask.tripId, review,
        {
          capture: [{ match: FLIGHT_FARE, required: true }, { match: GRAPH, required: false, max_count: 4 }],
          steps: [FARE_TYPES[ask.choice].click],
          graceMs: 3_000,
        },
        { stage: true, tag: runId },
      )
      .catch(() => null);
    const priced = opened ? bodiesFor(opened.captures, FLIGHT_FARE).map(parsed).map(reviewFare).find((f) => f !== null) ?? null : null;
    if (!opened || !priced) return fail('review_not_read', 1);
    await live.step(1, 'done');
    await live.step(2, 'doing');
    const coupon = bodiesFor(opened.captures, GRAPH).map(parsed).map(ixigoCoupon).find((c) => c !== null) ?? null;
    const typed = priced.types.find((t) => t.choice === ask.choice)?.totalMinor ?? priced.totalMinor;
    const amountMinor = Math.max(1, typed - (coupon?.savingMinor ?? 0));
    // A fare more than 5% over the price they picked at: asked again at the new price, on a card of its own, and this run
    // stops (the Server approves a personal payment up to 5% over the option they tapped, so a new price needs a new tap).
    const picked = ask.offer.priceMinor;
    if (picked !== null && amountMinor > Math.round(picked * FARE_MOVE_OK)) {
      await save(runId, { state: 'failed', why: 'fare_moved', total_minor: amountMinor });
      await live.step(2, 'failed');
      await live.finish(false);
      await askAgain(ask, runId, picked, amountMinor);
      return;
    }
    await save(runId, { state: 'travellers', total_minor: amountMinor, coupon_code: coupon?.code ?? null, coupon_minor: coupon?.savingMinor ?? null });
    await live.step(2, 'done');

    // 4. Their saved traveller, privately (the lead, 10 Oct: never stream the account's saved travellers): the list read
    // inside the logged-in page, matched by first name, then ticked on ixigo's traveller step in a private tab (no
    // picture). The list and their name live in this run's memory only. Nothing is submitted.
    await live.step(3, 'doing');
    if (!(await waitForLogin(ask, runId, live, 3))) return;
    const ms = dayMs(results.searchParams.get('date') ?? '');
    const iso = ms !== null ? new Date(ms + 330 * 60_000).toISOString().slice(0, 10) : '';
    // The list as ixigo's traveller step asks for it itself once Continue is pressed, caught in a private tab: the page's
    // own call carries the headers ixigo wants. Go's own call for it from inside the page carried none, ixigo turned it
    // away, and Keshav's first real booking stopped with nothing true said (prod, 11 Oct 08:28Z). A read that fails is
    // said to them, and read once more.
    // The traveller step's fields call comes with it: its journeyType says an international ticket (passport details).
    let international = false;
    const readSaved = async (): Promise<unknown> => {
      const got = await runner
        .read(ask.tripId, review, { capture: [{ match: SAVED_TRAVELLERS, required: true }, { match: TRAVELLER_FIELDS, required: false }], steps: [FARE_TYPES[ask.choice].click, CONTINUE] }, { private: true, tag: runId })
        .catch(() => null);
      const fields = got?.captures.find((c) => c.url.includes(TRAVELLER_FIELDS));
      if (fields) international = /^international$/i.test(new URL(fields.url).searchParams.get('journeyType') ?? '');
      const body = got ? bodiesFor(got.captures, SAVED_TRAVELLERS)[0] : undefined;
      return body === undefined ? null : parsed(body);
    };
    let list = await readSaved();
    if (list === null) {
      d.log.info({ runId, tripId: ask.tripId }, "travel: a flight booking's saved travellers didn't read; once more");
      await d.link
        .request('post_message', { request_id: stableId('go_book_retry', runId), trip_id: ask.tripId, text: TRAVELLERS_RETRY, visible_to_person_ids: [ask.personId] })
        .catch(() => undefined);
      list = await readSaved();
    }
    if (list === null) {
      // Said as it is, never "Go can't book flights", and never an ixigo page as the answer (Keshav's ruling): their card
      // goes back (fail), to tap again.
      await d.link
        .request('post_message', {
          request_id: stableId('go_book_unread', runId), trip_id: ask.tripId, visible_to_person_ids: [ask.personId],
          text: `Go still couldn't read your saved travellers on ixigo, so it stopped before booking ${title}. Tap I'll take this to try again.`,
        })
        .catch(() => undefined);
      return fail('travellers_not_read', 3);
    }
    const [match] = matchTravellers([{ personId: ask.personId, name: ask.name, kind: 'adult' }], savedTravellers(list, iso));
    if (!match) return fail('travellers_not_read', 3);
    const tell = (key: string, text: string) =>
      d.link.request('post_message', { request_id: stableId(key, runId), trip_id: ask.tripId, text, visible_to_person_ids: [ask.personId] }).catch(() => undefined);
    // Their saved traveller ticked; else (not saved on the account, or several with their first name) typed into ixigo's
    // own traveller form (Keshav, 11 Oct: "its not mandatory, it can use the details of the traveller and just go ahead").
    let steps: NonNullable<FetchPlan['steps']> = [];
    let newcomer: NewTraveller | null = null;
    if (match.status === 'matched') {
      steps = [FARE_TYPES[ask.choice].click, CONTINUE, { op: 'click', text: match.shown }];
    } else {
      if (international) {
        await tell('go_book_intl', `An international ticket needs passport details on ixigo's form, which Go doesn't fill yet, so it stopped before booking ${title}.`);
        return fail('international_traveller', 3);
      }
      // Their travel details from their vault when they kept them (#395: for a ticket of their own), else their name in
      // the trip. Their values go only into ixigo's form: never a log, the model or a card.
      const vaulted = await d.pay?.()?.travelDetails?.({
        tripId: ask.tripId, personId: ask.personId, booking: { ref: runId, travellerPersonId: ask.personId, purpose: clip(`${title}, for ${ask.name}`, 200) },
      }).catch(() => null) ?? null;
      const named = vaulted ? { first: vaulted.firstName, last: vaulted.lastName } : idNameOf(await d.nameOf(ask.tripId, ask.personId).catch(() => ''));
      if (!named) {
        await tell('go_book_name', `ixigo's traveller form needs your last name as on your ID, and your name in the trip is one word, so Go stopped before booking ${title}. Add your travel details in Go, then tap I'll take this to try again.`);
        return fail('traveller_name_needed', 3);
      }
      const gender = vaulted?.gender ?? ask.gender;
      if (!gender) {
        // The one thing missing: asked once, theirs alone, with buttons; their tap carries the booking on (gender).
        const askCardId = stableId('c_book_gender', runId);
        await d.link.request('post_message', {
          request_id: stableId('go_book_gender', runId), trip_id: ask.tripId, card: genderAsk(askCardId, ask.personId, ask.name), visible_to_person_ids: [ask.personId],
        });
        const resume: Resume = { tapId: ask.tapId, name: ask.name, choice: ask.choice, ...(ask.restore ? { restore: ask.restore } : {}), askCardId };
        await d.pool.query(`update flight_bookings set state = 'failed', why = 'gender_needed', resume = $2, updated_at = $3 where run_id = $1`, [runId, JSON.stringify(resume), d.now()]);
        await live.step(3, 'failed');
        await live.finish(false);
        return;
      }
      newcomer = { ...named, gender };
    }
    // The tick or the form is the last step: a fetch that ran out of time before it (their name not on the list, a box
    // not found) answers with what it caught all the same, so it is its trace that says it failed. Nothing is submitted.
    const tick = async (plan: NonNullable<FetchPlan['steps']>): Promise<boolean> => {
      let ranOut = false;
      return runner
        .read(ask.tripId, review, { capture: [{ match: TRAVELLER_FIELDS, required: true }], steps: plan }, { private: true, tag: runId, onTrace: (t) => { if (t.failed) ranOut = true; } })
        .then(() => !ranOut, () => false);
    };
    let ticked = false;
    if (newcomer) {
      // Each shape of ixigo's Title in turn, until one fills the form.
      for (const shape of TITLE_SHAPES) {
        ticked = await tick([FARE_TYPES[ask.choice].click, CONTINUE, ...newTravellerSteps(newcomer, shape)]);
        if (ticked) break;
      }
    } else {
      ticked = await tick(steps);
    }
    if (!ticked && match.status !== 'matched') {
      await tell('go_book_unfilled', `Go couldn't fill your traveller details on ixigo's form, so it stopped before booking ${title}. Tap I'll take this to try again.`);
      return fail('traveller_not_filled', 3);
    }
    if (!ticked) return fail('traveller_not_ticked', 3);
    await live.step(3, 'done');

    // 5. Ready to pay.
    const flies = dayOf(ask.offer.sourceUrl);
    await readyToPay({
      ask, runId, live, step: 4, amountMinor,
      purpose: clip(`${title}${flies ? `, ${dayText(flies)}` : ''}, for ${ask.name}`, 200),
      ready: (cardId) => readyCard({ cardId, personId: ask.personId, name: ask.name, title, when: flies ? dayText(flies) : null, choice: ask.choice, amountMinor, coupon }),
    });
  }

  /**
   * A person's own train, booked on ixigo as their flight is, up to ixigo's pay button (Keshav, 11 Oct: "trains and buses
   * are crying to get booked like flights"). p0's T1 drill: the day's results page, a row's SHOW AVAILABILITY, the class's
   * tile, the day's BOOK, behind ixigo's login. Its passenger typed from their vault's travel details (their age on the
   * day, their IRCTC user ID), asked once in one tap when missing; a waitlist or RAC said before they pay. Nothing on ixigo
   * is submitted.
   */
  async function bookTrain(asked: BookingAsk, runId: string): Promise<void> {
    const ask = { ...asked, name: spokenFirstName(asked.name) };
    const runner = d.runner();
    const title = ask.offer.title;
    const train = trainOf(ask.offer.sourceUrl);
    const option = d.results ? await d.results.optionOf(ask.offer.optionId).catch(() => null) : null;
    const cls = typeof option?.facts['class_code'] === 'string' ? option.facts['class_code'] : null;
    const live = bookingLiveCard(d, ask.tripId, stableId('c_book', runId), `Booking ${title} for ${ask.name}`, [
      `Opening ${title} on ixigo`, `Checking seats${cls ? ` in ${cls}` : ''}`, 'Filling passengers privately', `Ready to pay for ${ask.name}`,
    ], [ask.personId]);
    const fail = async (why: string, step: number): Promise<void> => {
      d.log.info({ runId, tripId: ask.tripId, why }, 'travel: a train booking stopped');
      await save(runId, { state: 'failed', why });
      await live.step(step, 'failed');
      await live.finish(false);
      await putBack(ask);
    };
    const tell = (key: string, text: string) =>
      d.link.request('post_message', { request_id: stableId(key, runId), trip_id: ask.tripId, text, visible_to_person_ids: [ask.personId] }).catch(() => undefined);
    const results = trainResultsAddress(ask.offer.sourceUrl, cls);
    const day = train ? dayLabel(train.date) : null;
    if (!runner || !train || !cls || !results || !day) return fail('no_runner', 0);

    // 1. Its seats and fare now, on the stage: the day's results page's own seats call, for its class and quota.
    await live.step(0, 'doing');
    const listed = await runner.read(ask.tripId, results, { capture: [{ match: TRAIN_AVAILABILITY, required: true }] }, { stage: true, tag: runId }).catch(() => null);
    const now = listed ? bodiesFor(listed.captures, TRAIN_AVAILABILITY).map(parsed).map((b) => classNow(b, train.number, cls, train.quota)).find((x) => x !== null) ?? null : null;
    if (!now) {
      await tell('go_book_seats_unread', `Go couldn't read the seats on ${title} just now, so it stopped before booking it. Tap I'll take this to try again.`);
      return fail('seats_not_read', 0);
    }
    await live.step(0, 'done');
    await live.step(1, 'doing');
    const amountMinor = now.fareMinor ?? ask.offer.priceMinor;
    if (amountMinor === null) return fail('seats_not_read', 1);
    // A fare more than 5% over the price they picked at: asked again at the new price, on a card of its own.
    const picked = ask.offer.priceMinor;
    if (picked !== null && amountMinor > Math.round(picked * FARE_MOVE_OK)) {
      await save(runId, { state: 'failed', why: 'fare_moved', total_minor: amountMinor });
      await live.step(1, 'failed');
      await live.finish(false);
      await askAgain(ask, runId, picked, amountMinor);
      return;
    }
    await save(runId, { state: 'travellers', total_minor: amountMinor });
    await live.step(1, 'done');

    // 2. The trip's login (its card the booker's), then their passenger, from their vault.
    await live.step(2, 'doing');
    if (!(await waitForLogin(ask, runId, live, 2))) return;
    const purpose = clip(`${title} (${cls}), ${day}, for ${ask.name}`, 200);
    const details = await d.pay?.()?.travelDetails?.({ tripId: ask.tripId, personId: ask.personId, booking: { ref: runId, travellerPersonId: ask.personId, purpose } }).catch(() => null) ?? null;
    const age = details ? ageOn(details.dob, train.date) : null;
    // One ask, one tap, for what the vault doesn't have: the vault's own form, showing exactly those.
    const need: TravelField[] = [...(age === null ? ['dob' as const] : []), ...(details?.irctcUserId ? [] : ['irctc_user_id' as const])];
    if (!details || age === null || !details.irctcUserId) return askForDetails(ask, runId, live, 2, need, 'train');
    // In a private tab: the row's SHOW AVAILABILITY by its train, the class's tile, the day's BOOK, then the passenger
    // form, its Gender tried as a select, chips, then radios. Nothing is submitted; their values go only into the form.
    const passenger = { name: `${details.firstName} ${details.lastName}`, age, gender: details.gender, irctc: details.irctcUserId };
    let filled = false;
    for (const shape of TITLE_SHAPES) {
      let ranOut = false;
      filled = await runner
        .read(
          ask.tripId, results,
          {
            capture: [{ match: TRAIN_AVAILABILITY, required: true }],
            steps: [
              { op: 'click', name: 'SHOW AVAILABILITY', near_text: train.number },
              { op: 'click', text: cls, near_text: [train.number, 'HIDE AVAILABILITY'] },
              { op: 'click', role: 'button', name: 'BOOK', near_text: day },
              ...trainPassengerSteps(passenger, shape),
            ],
          },
          { private: true, tag: runId, onTrace: (t) => { if (t.failed) ranOut = true; } },
        )
        .then(() => !ranOut, () => false);
      if (filled) break;
    }
    if (!filled) {
      await tell('go_book_unfilled', `Go couldn't fill your passenger details on ixigo's form, so it stopped before booking ${title}. Tap I'll take this to try again.`);
      return fail('passengers_not_filled', 2);
    }
    await live.step(2, 'done');

    // A waitlist or RAC, said plainly before they pay (the lead, 11 Oct).
    const seats = seatWords(now);
    if (seats) await tell('go_book_seats', `Before you pay for ${title} (${cls}): ${seats}`);
    // 3. Ready to pay.
    await readyToPay({
      ask, runId, live, step: 3, amountMinor, purpose,
      ready: (cardId) => readyCard({ cardId, personId: ask.personId, name: ask.name, title: `${title} (${cls})`, when: day, choice: ask.choice, amountMinor, coupon: null }),
    });
  }

  /**
   * The trip's login is in: each of its bookings that waited on it carries on, once (its row taken first), from the start,
   * as the person's pick would run it, with their card as it was kept for a stop after.
   */
  async function carryOn(tripId: string): Promise<void> {
    const { rows } = await d.pool.query<{ run_id: string; person_id: string; option_id: string; resume: Resume }>(
      `update flight_bookings set why = 'login_in', updated_at = $2 where trip_id = $1 and why = 'login_needed' and resume is not null
       returning run_id, person_id, option_id, resume`,
      [tripId, d.now()],
    );
    for (const r of rows) await resumeRun(tripId, r, 'login_in');
  }

  /** A booking that waited (its login, their gender) carries on from the start, as their pick ran it, with what it kept. */
  async function resumeRun(tripId: string, r: { run_id: string; person_id: string; option_id: string; resume: Resume }, from: string): Promise<void> {
    const offer = d.results ? await d.results.offer(r.option_id).catch(() => null) : null;
    if (!offer) {
      await letGo(r.run_id, from);
      return;
    }
    d.log.info({ runId: r.run_id, tripId, from }, 'travel: a flight booking carries on');
    const ask: BookingAsk = {
      tapId: r.resume.tapId, tripId, personId: r.person_id, name: r.resume.name, offer, choice: r.resume.choice,
      ...(r.resume.restore ? { restore: r.resume.restore } : {}), ...(r.resume.gender ? { gender: r.resume.gender } : {}),
    };
    const run = book(ask, r.run_id).catch(async (err: unknown) => {
      d.log.warn({ runId: r.run_id, err: String(err).slice(0, 200) }, 'travel: a flight booking failed');
      await save(r.run_id, { state: 'failed', why: 'error' }).catch(() => undefined);
    });
    running.add(run);
    void run.finally(() => running.delete(run));
  }

  /** A booking whose login was let go, or never came: no longer waiting, and its person's card back as it was. */
  async function letGo(runId: string, from = 'login_needed', why = 'login_let_go'): Promise<void> {
    const { rows } = await d.pool.query<{ trip_id: string; person_id: string; resume: Resume }>(
      `update flight_bookings set why = $4, updated_at = $3 where run_id = $1 and why = $2 returning trip_id, person_id, resume`,
      [runId, from, d.now(), why],
    );
    const r = rows[0];
    if (r?.resume.restore) await putBack({ tripId: r.trip_id, restore: r.resume.restore });
  }

  return {
    onFor: (tripId) => bookingOnFor(d, tripId),
    async start(ask) {
      const runId = stableId('fb', ask.tapId);
      // One booking of theirs at a time: a second tap meanwhile (the room's card keeps I'll take this) starts nothing, so
      // two runs never race for one browser (prod, 11 Oct: two taps 1.5 s apart, two runs).
      const fresh = await d.pool.query(
        `insert into flight_bookings (run_id, trip_id, person_id, option_id, pick_card_id, title, day, choice, state, created_at, updated_at)
         select $1, $2, $3, $4, $5, $6, $7, $8, 'fare', $9, $9
         where not exists (
           select 1 from flight_bookings where trip_id = $2 and person_id = $3 and run_id <> $1
             and state in ('fare', 'fare_type', 'coupon', 'travellers') and updated_at > $10)
         on conflict (run_id) do nothing`,
        [runId, ask.tripId, ask.personId, ask.offer.optionId, ask.offer.cardId, clip(ask.offer.title, 120), dayOf(ask.offer.sourceUrl), ask.choice, d.now(), new Date(d.now().getTime() - RUNNING_MS)],
      );
      // A repeat of the tap: the booking it started goes on, and nothing starts twice.
      if (fresh.rowCount === 0) {
        const again = await d.pool.query('select 1 from flight_bookings where run_id = $1', [runId]);
        return again.rowCount ? 'started' : 'running';
      }
      const run = book(ask, runId).catch(async (err: unknown) => {
        d.log.warn({ runId, err: String(err).slice(0, 200) }, 'travel: a flight booking failed');
        await save(runId, { state: 'failed', why: 'error' }).catch(() => undefined);
      });
      running.add(run);
      void run.finally(() => running.delete(run));
      return 'started';
    },
    resumeWaiting: (tripId) => carryOn(tripId),
    async detailsLink(i) {
      const { rows } = await d.pool.query<{ run_id: string; resume: Resume }>(
        `select run_id, resume from flight_bookings where trip_id = $1 and person_id = $2 and why = 'details_needed' and resume->>'askCardId' = $3`,
        [i.tripId, i.personId, i.cardId],
      );
      const link = rows[0] ? await d.pay?.()?.travelLink?.(i.personId, rows[0].resume.need ?? []).catch(() => null) : null;
      if (!rows[0]) return { result: 'refused', toast: 'This booking has moved on' };
      if (!link) return { result: 'refused', toast: "Go couldn't open your travel details just now: try again in a moment" };
      return { result: 'open', url: link.url, expires_at: link.expiresAt };
    },
    async gender(i) {
      // Their answer kept for the booking that asked on this card, which carries on by itself; a second tap finds none.
      const { rows } = await d.pool.query<{ run_id: string; person_id: string; option_id: string; resume: Resume }>(
        `update flight_bookings set why = 'gender_in', resume = resume || jsonb_build_object('gender', $4::text), updated_at = $5
         where trip_id = $1 and person_id = $2 and why = 'gender_needed' and resume->>'askCardId' = $3
         returning run_id, person_id, option_id, resume`,
        [i.tripId, i.personId, i.cardId, i.gender, d.now()],
      );
      const r = rows[0];
      if (!r) return { result: 'refused', toast: 'This booking has moved on' };
      await resumeRun(i.tripId, r, 'gender_in');
      return { result: 'done', toast: 'Go carries on with your booking' };
    },
    async sweep() {
      const { rows } = await d.pool.query<{ run_id: string; trip_id: string; waiting_since: Date; updated_at: Date; login: string | null; logged_in_at: Date | null }>(
        `select f.run_id, f.trip_id, f.waiting_since, f.updated_at, l.state as login, l.logged_in_at
         from flight_bookings f left join ixigo_logins l on l.trip_id = f.trip_id
         where f.why = 'login_needed' and f.resume is not null`,
      );
      const now = d.now().getTime();
      const trips = new Set<string>();
      for (const r of rows) {
        // In since the booking last stopped: it carries on (a login that landed while nothing heard it).
        if (r.login === 'logged_in' && r.logged_in_at && r.logged_in_at > r.updated_at) trips.add(r.trip_id);
        else if (r.login === 'skipped' || now - r.waiting_since.getTime() >= LOGIN_WAIT_MS) await letGo(r.run_id);
      }
      for (const tripId of trips) await carryOn(tripId);
      // Trains that wait on their person's travel details (detailsAsk): carried on once the vault has them, let go after
      // LOGIN_WAIT_MS with their card back. Read for a ticket of their own, as the booking itself reads them.
      const waiting = await d.pool.query<{ run_id: string; trip_id: string; person_id: string; option_id: string; title: string; resume: Resume; waiting_since: Date }>(
        "select run_id, trip_id, person_id, option_id, title, resume, waiting_since from flight_bookings where why = 'details_needed' and resume is not null",
      );
      const pay = d.pay?.();
      for (const r of waiting.rows) {
        if (now - r.waiting_since.getTime() >= LOGIN_WAIT_MS) {
          await letGo(r.run_id, 'details_needed', 'details_let_go');
          continue;
        }
        const details = await pay?.travelDetails?.({
          tripId: r.trip_id, personId: r.person_id, booking: { ref: r.run_id, travellerPersonId: r.person_id, purpose: clip(`${r.title}, for ${r.resume.name}`, 200) },
        }).catch(() => null);
        if (!hasFields(details ?? null, r.resume.need ?? ['dob', 'irctc_user_id'])) continue;
        const claimed = await d.pool.query<{ run_id: string; person_id: string; option_id: string; resume: Resume }>(
          `update flight_bookings set why = 'details_in', updated_at = $2 where run_id = $1 and why = 'details_needed' returning run_id, person_id, option_id, resume`,
          [r.run_id, d.now()],
        );
        if (claimed.rows[0]) await resumeRun(r.trip_id, claimed.rows[0], 'details_in');
      }
    },
    async pay(i) {
      const r = await d.pool.query<{
        run_id: string; person_id: string; option_id: string; pick_card_id: string | null; title: string; day: string | null; total_minor: string | null; state: BookingState;
      }>(
        'select run_id, person_id, option_id, pick_card_id, title, day, total_minor, state from flight_bookings where trip_id = $1 and card_id = $2',
        [i.tripId, i.cardId],
      );
      const row = r.rows[0];
      if (!row || row.person_id !== i.personId) return { result: 'refused', toast: 'This one is for someone else to pay' };
      if (row.state === 'paid') return { result: 'refused', toast: 'Already paid' };
      const pay = d.pay?.();
      const request = pay?.requestTicketApproval;
      // A booking from before its pick was kept has no card to name: the Server could not grant it (contract 1.3).
      if (!pay || !request || row.total_minor === null || !row.pick_card_id) return { result: 'refused', toast: 'Paying for a ticket through Go opens soon' };
      hookPaid(pay);
      const name = await d.nameOf(i.tripId, i.personId).catch(() => 'them');
      const purpose = clip(`${row.title}${row.day ? `, ${dayText(row.day)}` : ''}, for ${name}`, 200);
      const asked = request
        .call(pay, i.tripId, {
          personId: i.personId, cardId: row.pick_card_id, optionId: row.option_id, amountMinor: Number(row.total_minor), currency: 'INR', purpose, key: row.run_id, trigger: i.tapId,
        })
        .then(async (got) => {
          if ('approvalId' in got) await d.pool.query('update flight_bookings set approval_id = $2, updated_at = $3 where run_id = $1', [row.run_id, got.approvalId, d.now()]);
          return got;
        });
      // The Server may take its time: past the tap's own, the next Pay finds the payment ready (the helper asks once).
      const late = Symbol('late');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const got = await Promise.race([asked, new Promise<typeof late>((res) => (timer = setTimeout(() => res(late), PAY_WAIT_MS)))]).finally(() => clearTimeout(timer));
      if (got === late) {
        void asked.catch((err: unknown) => d.log.warn({ runId: row.run_id, err: String(err).slice(0, 200) }, 'travel: a ticket payment could not start'));
        return { result: 'done', toast: 'Getting your payment ready, tap Pay again in a moment' };
      }
      if ('refused' in got) return { result: 'refused', toast: clip(got.refused, 120) };
      return { result: 'open', url: got.url, expires_at: got.expiresAt };
    },
    async settled() {
      await Promise.all([...running]);
    },
  };
}

/** The day a results page asks for (its date, DDMMYYYY), as YYYY-MM-DD. */
export function dayOf(url: string | null): string | null {
  const m = url ? /[?&]date=(\d{2})(\d{2})(\d{4})/.exec(url) : null;
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

const parsed = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};
