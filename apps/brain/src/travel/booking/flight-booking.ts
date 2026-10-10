/**
 * Go books a flight on ixigo for one traveller (Keshav, 10 Oct: "Go books tickets end to end up to payment"), behind the
 * FLIGHT_BOOKING switch. From the traveller's own confirm, "Book it" (taps.ts): the fare opens on the stage, where the
 * room watches (a search for them alone, then ixigo's review page for that flight), the fare type they asked for is
 * chosen there, and the coupon ixigo applies itself is kept and said. It stops before ixigo's pay button: nothing is
 * submitted and no itinerary is made. Their card says what they would pay; Pay goes through the vault.
 *
 * A booking is a row (flight_bookings) a tap starts once, whatever its repeats, and a live card in the room that ticks
 * its steps. No traveller's details are kept, logged or said: the room hears the trip's own name and the outcome.
 */
import type * as C from '@go/contract';
import type pg from 'pg';
import type { Switches } from '../../admin/switches.js';
import type { ServerLink } from '../../door/server-link.js';
import { dayText } from '../answer.js';
import { clip, formatInr } from '../cards.js';
import { stableId } from '../ids.js';
import type { RecipeRunner } from '../recipes/runners.js';
import { bodiesFor } from '../recipes/recipe.js';
import type { StoredOffer } from '../travel.js';
import { fareFor, reviewAddress } from './review-address.js';
import { FARE_TYPES, ixigoCoupon, reviewFare, type FareChoice } from './review-read.js';
import { matchTravellers, savedTravellers } from './travellers.js';

export const FLIGHT_STREAM = '/flights/v2/search/stream';
export const FLIGHT_FARE = '/flight-booking/flight-fare';
export const GRAPH = '/graph';
/** The account's saved travellers (E2, his browser, 10 Oct 11:21Z: the traveller step's own call, `date` the day flown). */
export const SAVED_TRAVELLERS = '/api/v2/users/traveller';
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
 * The ticket's payment (money/pay.ts, p1-b's): the Server's approval for a person's own ticket, no vote, and the vault's
 * pay page for that person alone. The vault still needs the Server's signature and their Face ID. Refused, it says why.
 */
export interface TicketPay {
  requestTicketApproval(
    tripId: string,
    o: { personId: string; amountMinor: number; currency: string; purpose: string; key: string; trigger: string },
  ): Promise<{ url: string; expiresAt: string; approvalId: string; paymentId: string } | { refused: string; code: string }>;
  onPaid(fn: (p: { tripId: string; approvalId: string; railRef: string }) => Promise<void>): void;
}

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
}

export interface FlightBookingDeps {
  pool: pg.Pool;
  /** A person's name in the trip: whose ixigo the saved travellers are on, for the room's words. */
  nameOf: (tripId: string, personId: string) => Promise<string>;
  /** The ticket's payment, once money has it (it registers after travel); none, Pay says it opens soon. */
  ticketPay?: () => TicketPay | null;
  runner: () => RecipeRunner | null;
  link: Pick<ServerLink, 'request'>;
  switches: Pick<Switches, 'get'>;
  now: () => Date;
  log: Log;
}

/** A day (DDMMYYYY, as ixigo's results address writes it) as ixigo's traveller list takes it: its midnight in India, in ms. */
export function dayMs(ddmmyyyy: string): number | null {
  const m = /^(\d{2})(\d{2})(\d{4})$/.exec(ddmmyyyy);
  return m ? Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])) - 330 * 60_000 : null;
}

/** The flight numbers a card's title names ("IndiGo 6E328 + 6E5106"), as ixigo's flight keys hold them. */
export const numbersOf = (title: string): string[] => title.match(/\b[0-9A-Z]{2}\d{1,4}\b/g) ?? [];

/** The live card: what the room sees while Go books, each step ticking. Posted once, then replaced in place. */
function liveCard(d: Pick<FlightBookingDeps, 'link' | 'now' | 'log'>, tripId: string, cardId: string, title: string, texts: string[]) {
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
          await d.link.request('post_message', { request_id: stableId('go_book_live', cardId), trip_id: tripId, card: now });
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
    step(i: number, s: 'doing' | 'done' | 'failed'): Promise<void> {
      if (steps[i]) steps[i]!.state = s;
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
export function travellerAsk(cardId: string, ask: Pick<BookingAsk, 'personId' | 'name'>, owner: string | null, why: 'none' | 'several'): NoticeCard {
  const on = owner ? `${owner}'s ixigo` : "the trip's ixigo";
  const body = why === 'none'
    ? `${ask.name} isn't a saved traveller on ${on} yet; add ${ask.name} there once, then tap Book it again.`
    : `${on.charAt(0).toUpperCase()}${on.slice(1)} has more than one saved traveller named ${ask.name}; keep one there, then tap Book it again.`;
  return {
    card_id: cardId, kind: 'notice', tone: 'heads_up', for_person_ids: [ask.personId],
    title: clip(`${ask.name}, one step on ixigo first`, 80), body: clip(body, 500), fallback_text: clip(body, 300),
  };
}

export interface FlightBooking {
  /**
   * Whether Go books this trip's flights itself: Go reads ixigo.com in the trip's browser, and FLIGHT_BOOKING is on, or
   * names the trip's Server instance ("instances:drill-p0").
   */
  onFor(tripId: string): Promise<boolean>;
  /** Starts the booking a tap asked for, once; its work goes on after the tap is answered. */
  start(ask: BookingAsk): Promise<void>;
  /** Pay on a traveller's ready card: the vault's pay page for them alone, or why not. Inside the tap's 2.5 s. */
  pay(i: { tripId: string; cardId: string; personId: string; tapId: string }): Promise<PayTap>;
  /** Waits for the bookings started in the background (tests). */
  settled(): Promise<void>;
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
      await d.pool.query(`update flight_bookings set state = 'paid', updated_at = $3 where trip_id = $1 and approval_id = $2`, [tripId, approvalId, d.now()]);
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

  async function book(ask: BookingAsk, runId: string): Promise<void> {
    const runner = d.runner();
    const title = ask.offer.title;
    const live = liveCard(d, ask.tripId, stableId('c_book', runId), `Booking ${title} for ${ask.name}`, [
      `Opening ${title} on ixigo`, `Choosing ${FARE_TYPES[ask.choice].words}`, "ixigo's coupon", 'Filling travellers privately', `Ready to pay for ${ask.name}`,
    ]);
    const fail = async (why: string, step: number): Promise<void> => {
      d.log.info({ runId, tripId: ask.tripId, why }, 'travel: a flight booking stopped');
      await save(runId, { state: 'failed', why });
      await live.step(step, 'failed');
      await live.finish(false);
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
    await save(runId, { state: 'travellers', total_minor: amountMinor, coupon_code: coupon?.code ?? null, coupon_minor: coupon?.savingMinor ?? null });
    await live.step(2, 'done');

    // 4. Their saved traveller, privately (the lead, 10 Oct: never stream the account's saved travellers): the list read
    // inside the logged-in page, matched by first name, then ticked on ixigo's traveller step in a private tab (no
    // picture). The list and their name live in this run's memory only. Nothing is submitted.
    await live.step(3, 'doing');
    const day = results.searchParams.get('date') ?? '';
    const ms = dayMs(day);
    const saved = runner.pageFetch && ms !== null
      ? await runner.pageFetch(ask.tripId, { url: `${SAVED_TRAVELLERS}?date=${ms}`, method: 'GET' }, { tag: runId }).catch(() => null)
      : null;
    const iso = ms !== null ? new Date(ms + 330 * 60_000).toISOString().slice(0, 10) : '';
    const [match] = saved && saved.status >= 200 && saved.status < 300
      ? matchTravellers([{ personId: ask.personId, name: ask.name, kind: 'adult' }], savedTravellers(parsed(saved.body), iso))
      : [];
    if (!match) return fail('travellers_not_read', 3);
    if (match.status !== 'matched') {
      const holder = await d.pool.query<{ person_id: string }>('select person_id from ixigo_logins where trip_id = $1', [ask.tripId]).then((r) => r.rows[0]?.person_id ?? null).catch(() => null);
      const owner = holder ? await d.nameOf(ask.tripId, holder).catch(() => null) : null;
      await d.link.request('post_message', { request_id: stableId('go_book_who', runId), trip_id: ask.tripId, card: travellerAsk(stableId('c_book_who', runId), ask, owner, match.status) });
      return fail(match.status === 'none' ? 'no_saved_traveller' : 'several_saved_travellers', 3);
    }
    // The tick is the last step: a fetch that ran out of time before it (their name not on the list) answers with what
    // it caught all the same, so it is its trace that says it failed.
    let ranOut = false;
    const ticked = await runner
      .read(
        ask.tripId, review,
        {
          capture: [{ match: TRAVELLER_FIELDS, required: true }],
          steps: [FARE_TYPES[ask.choice].click, { op: 'click', role: 'button', name: 'Continue' }, { op: 'click', text: match.shown }],
        },
        { private: true, tag: runId, onTrace: (t) => { if (t.failed) ranOut = true; } },
      )
      .then(() => !ranOut, () => false);
    if (!ticked) return fail('traveller_not_ticked', 3);
    await live.step(3, 'done');

    // 5. Ready: their card, for them alone. Nothing on ixigo is submitted.
    await live.step(4, 'done');
    const cardId = stableId('c_ready', runId);
    const flies = dayOf(ask.offer.sourceUrl);
    const card = readyCard({ cardId, personId: ask.personId, name: ask.name, title, when: flies ? dayText(flies) : null, choice: ask.choice, amountMinor, coupon });
    await d.link.request('post_message', { request_id: stableId('go_book_ready', runId), trip_id: ask.tripId, card });
    await save(runId, { state: 'ready_to_pay', card_id: cardId });
    await live.finish(true);
  }

  return {
    async onFor(tripId) {
      if (d.switches.get('TRAVEL_MODE') !== 'ixigo_web') return false;
      const value = d.switches.get('FLIGHT_BOOKING');
      if (value === 'on') return true;
      if (!value.startsWith('instances:')) return false;
      const names = value.slice('instances:'.length).split(',');
      const r = await d.pool.query<{ server_instance: string | null }>('select server_instance from trips where trip_id = $1', [tripId]);
      const instance = r.rows[0]?.server_instance ?? null;
      return instance !== null && names.includes(instance);
    },
    async start(ask) {
      const runId = stableId('fb', ask.tapId);
      const fresh = await d.pool.query(
        `insert into flight_bookings (run_id, trip_id, person_id, option_id, title, day, choice, state, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, 'fare', $8, $8) on conflict (run_id) do nothing`,
        [runId, ask.tripId, ask.personId, ask.offer.optionId, clip(ask.offer.title, 120), dayOf(ask.offer.sourceUrl), ask.choice, d.now()],
      );
      // A repeat of the tap: the booking it started goes on, and nothing starts twice.
      if (fresh.rowCount === 0) return;
      const run = book(ask, runId).catch(async (err: unknown) => {
        d.log.warn({ runId, err: String(err).slice(0, 200) }, 'travel: a flight booking failed');
        await save(runId, { state: 'failed', why: 'error' }).catch(() => undefined);
      });
      running.add(run);
      void run.finally(() => running.delete(run));
    },
    async pay(i) {
      const r = await d.pool.query<{ run_id: string; person_id: string; title: string; day: string | null; total_minor: string | null; state: BookingState }>(
        'select run_id, person_id, title, day, total_minor, state from flight_bookings where trip_id = $1 and card_id = $2',
        [i.tripId, i.cardId],
      );
      const row = r.rows[0];
      if (!row || row.person_id !== i.personId) return { result: 'refused', toast: 'This one is for someone else to pay' };
      if (row.state === 'paid') return { result: 'refused', toast: 'Already paid' };
      const pay = d.ticketPay?.() ?? null;
      if (!pay || row.total_minor === null) return { result: 'refused', toast: 'Paying for a ticket through Go opens soon' };
      hookPaid(pay);
      const name = await d.nameOf(i.tripId, i.personId).catch(() => 'them');
      const purpose = clip(`${row.title}${row.day ? `, ${dayText(row.day)}` : ''}, for ${name}`, 200);
      const asked = pay
        .requestTicketApproval(i.tripId, { personId: i.personId, amountMinor: Number(row.total_minor), currency: 'INR', purpose, key: row.run_id, trigger: i.tapId })
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
