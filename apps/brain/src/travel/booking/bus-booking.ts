/**
 * Go books a bus on ixigo for one person, as it does a flight (Keshav, 11 Oct: buses booked like flights), behind the
 * BOOKING switch. From their own confirm, "Book it" (taps.ts): the bus opens on the stage, where the room watches, and its
 * seat layout is read (GetSeatLayout, which "Select Seats" opens: every seat, every boarding and dropping point). Go
 * chooses the seats and the points in code (bus-seats.ts): their ask, else the cheapest free by a window, together for
 * people on the same bus, the point near them else ixigo's first, said in one clause. The passenger form is filled in a
 * private tab, from their vault's travel details. It stops before ixigo's pay button: nothing is submitted. Their pay card
 * goes through the vault, and their ticket follows when it is paid.
 *
 * A booking is a row (bus_bookings) a tap starts once, and a live card for the person alone that ticks its steps. No
 * passenger's details are kept, logged or said.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Switches } from '../../admin/switches.js';
import type { ServerLink } from '../../door/server-link.js';
import { dayText } from '../answer.js';
import { clip, formatInr, type OptionsCardT } from '../cards.js';
import { stableId } from '../ids.js';
import type { IxigoLogin } from '../login.js';
import { bodiesFor, type FetchPlan } from '../recipes/recipe.js';
import type { RecipeRunner } from '../recipes/runners.js';
import type { ResultsStore } from '../results.js';
import type { StoredOffer } from '../travel.js';
import { busLayout, choosePoint, chooseSeats, seatWords, type BusLayout, type BusPoint, type BusSeat, type SeatAsk } from './bus-seats.js';
import type { TravelField } from '../../money/vault-client.js';
import { ticketCard } from '../../money/cards.js';
import { bookingLiveCard, bookingOnFor, detailsAsk, FARE_MOVE_OK, hasFields, LOGIN_WAIT_MS, RUNNING_MS, ticketWhen, travellerAsk, type TicketPay } from './flight-booking.js';
import { spokenFirstName } from './travellers.js';

/** The list's own call, and the seat layout "Select Seats" opens. */
export const BUS_LIST = '/buslist/v3/services$';
export const SEAT_LAYOUT = '/wap/GetSeatLayout$';
/** Who sells a ticket Go books: ixigo, simulated, as a flight's is (Go stops before ixigo's own pay button). */
export const BUS_VENDOR = 'ixigo (simulated)';

type Log = { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
export type BusBookingState = 'seats' | 'passengers' | 'ready_to_pay' | 'paid' | 'failed';

/** A passenger as ixigo's bus form takes them: their name as on their ID, their age on the day and their gender. */
export interface BusPassenger {
  first: string;
  last: string;
  age: number;
  gender: 'male' | 'female';
}

export interface BusAsk {
  /** The tap that asked, which names the booking: a repeat of it is the same booking. */
  tapId: string;
  tripId: string;
  personId: string;
  name: string;
  offer: StoredOffer;
  /** Their seat wishes, in their words read by the model ("a window", "lower berth"); none: the best free. */
  seat?: Omit<SeatAsk, 'count'>;
  /** Places they are near, for the boarding and dropping points ("Koramangala", their stay's area). */
  near?: { board?: string[]; drop?: string[] };
  /** Their card as it was before their pick, put back when the booking stops before the pay card. */
  restore?: OptionsCardT;
}

export interface BusBookingDeps {
  pool: pg.Pool;
  nameOf: (tripId: string, personId: string) => Promise<string>;
  pay?: () => TicketPay | undefined;
  login?: Pick<IxigoLogin, 'ensure'>;
  runner: () => RecipeRunner | null;
  link: Pick<ServerLink, 'request'>;
  switches: Pick<Switches, 'get'>;
  now: () => Date;
  log: Log;
  results?: Pick<ResultsStore, 'replaceCard' | 'offer' | 'optionOf'>;
}

/** What a booking that waited on the trip's login carries on with. */
type Resume = { tapId: string; name: string; seat?: BusAsk['seat']; near?: BusAsk['near']; restore?: OptionsCardT; need?: TravelField[]; askCardId?: string };

/**
 * A bus's address on Go's card: ixigo's results page, with the bus's operator and time after "#" (buses.between). The
 * page, the operator and the time, or null.
 */
export function busOf(sourceUrl: string | null): { page: string; operator: string; departs: string; day: string | null } | null {
  if (!sourceUrl || !sourceUrl.includes('#')) return null;
  const [page, tail] = [sourceUrl.slice(0, sourceUrl.indexOf('#')), sourceUrl.slice(sourceUrl.indexOf('#') + 1)];
  const at = tail.lastIndexOf('@');
  if (at < 0) return null;
  let operator: string;
  try {
    operator = decodeURIComponent(tail.slice(0, at));
  } catch {
    return null;
  }
  const date = /\/(\d{2})-(\d{2})-(\d{4})\//.exec(page);
  return { page, operator, departs: tail.slice(at + 1), day: date ? `${date[3]}-${date[2]}-${date[1]}` : null };
}

/** Their age on the day the bus leaves, from their date of birth (YYYY-MM-DD). */
export function ageOn(dob: string, day: string): number | null {
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!b || !d) return null;
  const age = Number(d[1]) - Number(b[1]) - (Number(d[2]) * 100 + Number(d[3]) < Number(b[2]) * 100 + Number(b[3]) ? 1 : 0);
  return age >= 0 && age < 120 ? age : null;
}

/**
 * The seats and the two points picked on the bus's own seat map, then Proceed to the passenger form. ixigo's seats show
 * only their price, and Bash finds an element by the page's accessibility tree: each seat is its price's text, counted in
 * the page's own order after the price filter's chip (that text's first). p5's drill, 11 Oct: the page holds a deck from
 * its last row up (the second ₹3858 text was upper row 2, column 11, drawn under row 1), the upper deck first. The points
 * are the panel's radios in ixigo's order, the boarding list's then the dropping list's; with both picked, Proceed lights.
 */
export function seatSteps(layout: BusLayout, seats: readonly BusSeat[], board: BusPoint, drop: BusPoint): NonNullable<FetchPlan['steps']> {
  const drawn = [...layout.seats].sort((a, b) => (a.deck === b.deck ? b.row - a.row || a.col - b.col : a.deck === 'upper' ? -1 : 1));
  const price = (s: BusSeat): string => `₹${Math.round(s.fareMinor / 100)}`;
  const clicks = seats.map((s) => {
    const same = drawn.filter((x) => price(x) === price(s));
    return { op: 'click' as const, role: 'StaticText', name: price(s), nth: same.findIndex((x) => x.no === s.no) + 2 };
  });
  return [
    ...clicks,
    { op: 'click', role: 'radio', nth: Math.max(1, layout.boarding.findIndex((p) => p.id === board.id) + 1) },
    { op: 'click', role: 'radio', nth: Math.max(1, layout.dropping.findIndex((p) => p.id === drop.id) + 1) },
    { op: 'click', role: 'button', name: 'Proceed' },
  ];
}

/** The bus's own seat map opened again on a page of the results: its list, its "Select Seats", its layout. */
const openSeats = (bus: { operator: string; departs: string }): NonNullable<FetchPlan['steps']> => [
  { op: 'wait_for', match: BUS_LIST },
  { op: 'click', role: 'button', name: 'Select Seats', near_text: [bus.operator, bus.departs] },
  { op: 'wait_for', match: SEAT_LAYOUT },
];

/** ixigo's bus passenger form, filled for one passenger: their name as on their ID, age and gender. */
export function passengerSteps(p: BusPassenger): NonNullable<FetchPlan['steps']> {
  return [
    { op: 'type', role: 'textbox', name: 'Name', text: `${p.first} ${p.last}` },
    { op: 'type', role: 'textbox', name: 'Age', text: String(p.age) },
    { op: 'click', role: 'radio', name: p.gender === 'male' ? 'Male' : 'Female' },
  ];
}

export interface BusBooking {
  onFor(tripId: string): Promise<boolean>;
  start(ask: BusAsk): Promise<'started' | 'running'>;
  /** "Add it" on the details ask: their vault's travel form, at the fields the booking waits on, for them alone. */
  detailsLink(i: { tripId: string; cardId: string; personId: string }): Promise<{ result: 'open'; url: string; expires_at: string } | { result: 'refused'; toast: string }>;
  resumeWaiting(tripId: string): Promise<void>;
  sweep(): Promise<void>;
  settled(): Promise<void>;
}

const parsed = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};

export function createBusBooking(d: BusBookingDeps): BusBooking {
  const running = new Set<Promise<void>>();
  let hooked = false;
  const hookPaid = (pay: TicketPay): void => {
    if (hooked) return;
    hooked = true;
    pay.onPaid(async ({ tripId, approvalId }) => {
      const r = await d.pool.query<{ run_id: string; person_id: string; option_id: string; title: string; seats: string[]; total_minor: string | null }>(
        `update bus_bookings b set state = 'paid', approval_id = $2, updated_at = $3
         where b.trip_id = $1 and b.state <> 'paid'
           and (b.approval_id = $2 or b.run_id in (select p.hold_id from payments p where p.trip_id = $1 and p.approval_id = $2 and p.kind = 'ticket'))
         returning b.run_id, b.person_id, b.option_id, b.title, b.seats, b.total_minor`,
        [tripId, approvalId, d.now()],
      );
      for (const b of r.rows) {
        if (b.total_minor === null) continue;
        // Their ticket on the trip, theirs alone: Go's own reference, simulated, as Go stops before ixigo's pay button; its
        // seat in its title, its route and times the bus's journey when its search kept one.
        const journey = d.results ? ((await d.results.optionOf(b.option_id).catch(() => null))?.journey ?? null) : null;
        const title = clip(`${b.title}${b.seats.length ? `, seat ${b.seats.join(', ')}` : ''}`, 120);
        const ref = `SIM-${createHash('sha256').update(b.run_id).digest('hex').slice(0, 8).toUpperCase()}`;
        const booked = await d.link.request('add_booking', {
          request_id: stableId('go_bus_ticket', b.run_id), trip_id: tripId, kind: 'bus', title, vendor: BUS_VENDOR, ref,
          amount_minor: Number(b.total_minor), currency: 'INR', payer_person_id: b.person_id, for_person_ids: [b.person_id], approval_id: approvalId,
          ...(journey ? { journey, starts_at: journey.depart_at } : {}),
        });
        const name = await d.nameOf(tripId, b.person_id).then(spokenFirstName, () => null);
        await d.link.request('post_message', {
          request_id: stableId('go_bus_ticket_card', b.run_id), trip_id: tripId, visible_to_person_ids: [b.person_id],
          card: ticketCard({ cardId: stableId('c_bus_ticket', b.run_id), bookingId: booked.booking_id, title, ref, refundableUntil: null, simulated: true, detail: ticketWhen(name, journey) }),
        });
      }
    });
  };

  const save = async (runId: string, patch: { state: BusBookingState; seats?: string[]; board_id?: string; drop_id?: string; total_minor?: number; card_id?: string; why?: string }): Promise<void> => {
    await d.pool.query(
      `update bus_bookings set state = $2, seats = coalesce($3, seats), board_id = coalesce($4, board_id), drop_id = coalesce($5, drop_id),
         total_minor = coalesce($6, total_minor), card_id = coalesce($7, card_id), why = coalesce($8, why), updated_at = $9 where run_id = $1`,
      [runId, patch.state, patch.seats ?? null, patch.board_id ?? null, patch.drop_id ?? null, patch.total_minor ?? null, patch.card_id ?? null, patch.why ?? null, d.now()],
    );
  };

  async function putBack(ask: Pick<BusAsk, 'tripId' | 'restore'>): Promise<void> {
    if (!ask.restore || !d.results) return;
    try {
      await d.results.replaceCard(ask.tripId, ask.restore);
      await d.link.request('replace_card', { trip_id: ask.tripId, card: ask.restore });
    } catch (err) {
      d.log.warn({ err: String(err).slice(0, 200), cardId: ask.restore.card_id }, "travel: a person's card could not be put back after their bus booking stopped");
    }
  }

  /** The seats the trip's other bookings took on this bus: never chosen again. */
  const takenOn = async (ask: BusAsk, runId: string): Promise<string[]> => {
    const r = await d.pool.query<{ seats: string[] }>(
      `select seats from bus_bookings where trip_id = $1 and option_id = $2 and run_id <> $3 and state in ('passengers', 'ready_to_pay', 'paid')`,
      [ask.tripId, ask.offer.optionId, runId],
    );
    return r.rows.flatMap((x) => x.seats);
  };

  const tell = (ask: BusAsk, runId: string, key: string, text: string) =>
    d.link.request('post_message', { request_id: stableId(key, runId), trip_id: ask.tripId, text, visible_to_person_ids: [ask.personId] }).catch(() => undefined);

  async function book(asked: BusAsk, runId: string): Promise<void> {
    const ask = { ...asked, name: spokenFirstName(asked.name) };
    const runner = d.runner();
    const title = ask.offer.title;
    const live = bookingLiveCard(d, ask.tripId, stableId('c_bus', runId), `Booking ${title} for ${ask.name}`, [
      `Opening ${title} on ixigo`, 'Choosing seats and stops', 'Filling the passenger privately', `Ready to pay for ${ask.name}`,
    ], [ask.personId]);
    const fail = async (why: string, step: number): Promise<void> => {
      d.log.info({ runId, tripId: ask.tripId, why }, 'travel: a bus booking stopped');
      await save(runId, { state: 'failed', why });
      await live.step(step, 'failed');
      await live.finish(false);
      await putBack(ask);
    };
    const bus = busOf(ask.offer.sourceUrl);
    if (!runner || !bus) return fail('no_runner', 0);

    // 1. The bus on the stage: its results, its own "Select Seats", and its seat layout.
    await live.step(0, 'doing');
    const opened = await runner
      .read(
        ask.tripId, bus.page,
        {
          capture: [{ match: SEAT_LAYOUT, required: true }],
          steps: openSeats(bus),
        },
        { stage: true, tag: runId },
      )
      .catch(() => null);
    const layout = opened ? bodiesFor(opened.captures, SEAT_LAYOUT).map(parsed).map(busLayout).find((l) => l !== null && l.operator.toLowerCase() === bus.operator.toLowerCase()) ?? null : null;
    if (!layout) return fail('layout_not_read', 0);
    await live.step(0, 'done');

    // 2. Seats and stops, chosen in code: their ask, else the best free; never a seat another booking of the trip took.
    await live.step(1, 'doing');
    // Beside the trip's people already on this bus, when a seat there is free.
    const taken = await takenOn(ask, runId);
    const seats = chooseSeats(layout, { count: 1, ...(ask.seat ?? {}) }, taken, taken);
    const board = choosePoint(layout.boarding, ask.near?.board ?? []);
    const drop = choosePoint(layout.dropping, ask.near?.drop ?? []);
    if (!seats || !board || !drop) {
      await tell(ask, runId, 'go_bus_full', `${title} has no free seat left for you, so Go stopped before booking it. Tap I'll take this on another bus.`);
      return fail('no_seat', 1);
    }
    const amountMinor = seats.reduce((sum, s) => sum + s.fareMinor, 0);
    // A seat more than 5% over the price they picked at: said, and this run stops (the Server approves a personal payment
    // up to 5% over the option they tapped).
    const picked = ask.offer.priceMinor;
    if (picked !== null && amountMinor > Math.round(picked * FARE_MOVE_OK)) {
      await tell(ask, runId, 'go_bus_fare', `The cheapest free seat on ${title} is ${formatInr(amountMinor)} now, up from ${formatInr(picked)}, so Go stopped before booking it. Tap I'll take this to book it at ${formatInr(amountMinor)}.`);
      await save(runId, { state: 'failed', why: 'fare_moved', total_minor: amountMinor });
      await live.step(1, 'failed');
      await live.finish(false);
      await putBack(ask);
      return;
    }
    await save(runId, { state: 'passengers', seats: seats.map((s) => s.no), board_id: board.id, drop_id: drop.id, total_minor: amountMinor });
    await live.step(1, 'done', clip(seatWords(seats, board, null), 80));

    // 3. The passenger, privately: their vault's travel details typed only into ixigo's form (never a log, the model or a
    // card). The trip's ixigo login first: its card goes to them, and the booking carries on once it is in.
    await live.step(2, 'doing');
    const login = d.login ? await d.login.ensure(ask.tripId, `Booking ${title} for ${ask.name}`, { booking: true, for: ask.personId }).catch(() => null) : { ok: true as const };
    if (!login?.ok) {
      await d.link.request('post_message', {
        request_id: stableId('go_bus_login', runId), trip_id: ask.tripId, card: travellerAsk(stableId('c_bus_login', runId), ask, null, true), visible_to_person_ids: [ask.personId],
      });
      const resume: Resume = { tapId: ask.tapId, name: ask.name, ...(ask.seat ? { seat: ask.seat } : {}), ...(ask.near ? { near: ask.near } : {}), ...(ask.restore ? { restore: ask.restore } : {}) };
      await d.pool.query(
        `update bus_bookings set state = 'failed', why = 'login_needed', resume = $2, waiting_since = coalesce(waiting_since, $3), updated_at = $3 where run_id = $1`,
        [runId, JSON.stringify(resume), d.now()],
      );
      await live.step(2, 'failed');
      await live.finish(false);
      return;
    }
    // Their name as on their ID, their gender and their age on the day, from their vault: typed only into ixigo's form,
    // never a log, the model or a card. None kept: the one ask for a ticket's missing details (p0's, trains' too), for
    // their date of birth and gender in one card (the lead: one ask beats two; the vault's form also takes whatever else a
    // kept row needs), and the minute's sweep carries the booking on once they are kept.
    const vaulted = await d.pay?.()?.travelDetails?.({
      tripId: ask.tripId, personId: ask.personId, booking: { ref: runId, travellerPersonId: ask.personId, purpose: clip(`${title}, for ${ask.name}`, 200) },
    }).catch(() => null) ?? null;
    const age = vaulted && bus.day ? ageOn(vaulted.dob, bus.day) : null;
    if (!vaulted || age === null) {
      const need: TravelField[] = ['dob', 'gender'];
      const askCardId = stableId('c_bus_details', runId);
      await d.link.request('post_message', {
        request_id: stableId('go_bus_details', runId), trip_id: ask.tripId, card: detailsAsk(askCardId, ask.personId, ask.name, need, 'bus'), visible_to_person_ids: [ask.personId],
      });
      const resume: Resume = {
        tapId: ask.tapId, name: ask.name, need, askCardId,
        ...(ask.seat ? { seat: ask.seat } : {}), ...(ask.near ? { near: ask.near } : {}), ...(ask.restore ? { restore: ask.restore } : {}),
      };
      await d.pool.query(
        `update bus_bookings set state = 'failed', why = 'details_needed', resume = $2, waiting_since = coalesce(waiting_since, $3), updated_at = $3 where run_id = $1`,
        [runId, JSON.stringify(resume), d.now()],
      );
      await live.step(2, 'failed');
      await live.finish(false);
      return;
    }
    const details = { firstName: vaulted.firstName, lastName: vaulted.lastName, gender: vaulted.gender };
    let ranOut = false;
    const filled = await runner
      .read(
        ask.tripId, bus.page,
        // A private tab is a page of its own: the bus's seat map opened again there, then its seats, stops and passenger.
        { capture: [{ match: SEAT_LAYOUT, required: true }], steps: [...openSeats(bus), ...seatSteps(layout, seats, board, drop), ...passengerSteps({ first: details.firstName, last: details.lastName, age, gender: details.gender })] },
        { private: true, tag: runId, onTrace: (t) => { if (t.failed) ranOut = true; } },
      )
      .then(() => !ranOut, () => false);
    if (!filled) {
      await tell(ask, runId, 'go_bus_unfilled', `Go couldn't fill your seat and passenger details on ixigo's form, so it stopped before booking ${title}. Tap I'll take this to try again.`);
      return fail('passenger_not_filled', 2);
    }
    await live.step(2, 'done');

    // 4. Ready to pay: ONE pay card for them alone, money's, with the Server's personal approval for the option they tapped.
    const pay = d.pay?.();
    if (!pay?.requestTicketCard) return fail('pay_not_ready', 3);
    hookPaid(pay);
    const purpose = clip(`${title}${bus.day ? `, ${dayText(bus.day)}` : ''}, ${seatWords(seats, board, drop)}, for ${ask.name}`, 200);
    const got = await pay
      .requestTicketCard(ask.tripId, { personId: ask.personId, cardId: ask.offer.cardId, optionId: ask.offer.optionId, amountMinor, currency: 'INR', purpose, key: runId, trigger: ask.tapId })
      .catch(() => ({ refused: "Go couldn't get the payment ready just now.", code: 'server_down', say: false }));
    if ('cardId' in got) {
      await save(runId, { state: 'ready_to_pay', card_id: got.cardId });
      await live.step(3, 'done');
      await live.finish(true);
      return;
    }
    d.log.warn({ runId, code: got.code }, 'travel: a bus ticket pay card was refused');
    if (!got.say) await tell(ask, runId, 'go_bus_no', got.refused);
    await fail(`pay_${got.code}`, 3);
  }

  async function carryOn(tripId: string): Promise<void> {
    const { rows } = await d.pool.query<{ run_id: string; person_id: string; option_id: string; resume: Resume }>(
      `update bus_bookings set why = 'login_in', updated_at = $2 where trip_id = $1 and why = 'login_needed' and resume is not null
       returning run_id, person_id, option_id, resume`,
      [tripId, d.now()],
    );
    for (const r of rows) await resumeRun(tripId, r, 'login_in');
  }

  /** A booking that waited (the login, their gender, their details) carries on from the start, with what it kept. */
  async function resumeRun(tripId: string, r: { run_id: string; person_id: string; option_id: string; resume: Resume }, from: string): Promise<boolean> {
    const stored = d.results ? await d.results.offer(r.option_id).catch(() => null) : null;
    if (!stored) return false;
    d.log.info({ runId: r.run_id, tripId, from }, 'travel: a bus booking carries on');
    const k = r.resume;
    start({
      tapId: k.tapId, tripId, personId: r.person_id, name: k.name, offer: stored,
      ...(k.seat ? { seat: k.seat } : {}), ...(k.near ? { near: k.near } : {}), ...(k.restore ? { restore: k.restore } : {}),
    }, r.run_id);
    return true;
  }

  function start(ask: BusAsk, runId: string): void {
    const run = book(ask, runId).catch(async (err: unknown) => {
      d.log.warn({ runId, err: String(err).slice(0, 200) }, 'travel: a bus booking failed');
      await save(runId, { state: 'failed', why: 'error' }).catch(() => undefined);
    });
    running.add(run);
    void run.finally(() => running.delete(run));
  }

  return {
    onFor: (tripId) => bookingOnFor(d, tripId),
    async start(ask) {
      const runId = stableId('bb', ask.tapId);
      const fresh = await d.pool.query(
        `insert into bus_bookings (run_id, trip_id, person_id, option_id, pick_card_id, title, day, state, created_at, updated_at)
         select $1, $2, $3, $4, $5, $6, $7, 'seats', $8, $8
         where not exists (
           select 1 from bus_bookings where trip_id = $2 and person_id = $3 and run_id <> $1 and state in ('seats', 'passengers') and updated_at > $9)
         on conflict (run_id) do nothing`,
        [runId, ask.tripId, ask.personId, ask.offer.optionId, ask.offer.cardId, clip(ask.offer.title, 120), busOf(ask.offer.sourceUrl)?.day ?? null, d.now(), new Date(d.now().getTime() - RUNNING_MS)],
      );
      if (fresh.rowCount === 0) {
        const again = await d.pool.query('select 1 from bus_bookings where run_id = $1', [runId]);
        return again.rowCount ? 'started' : 'running';
      }
      start(ask, runId);
      return 'started';
    },
    resumeWaiting: (tripId) => carryOn(tripId),
    async detailsLink(i) {
      const r = await d.pool.query<{ resume: Resume }>(
        `select resume from bus_bookings where trip_id = $1 and person_id = $2 and why = 'details_needed' and resume->>'askCardId' = $3`,
        [i.tripId, i.personId, i.cardId],
      );
      const row = r.rows[0];
      if (!row) return { result: 'refused', toast: 'This booking has moved on' };
      const link = await d.pay?.()?.travelLink?.(i.personId, row.resume.need ?? []).catch(() => null);
      return link ? { result: 'open', url: link.url, expires_at: link.expiresAt } : { result: 'refused', toast: "Your vault didn't open just now. Tap Add it again" };
    },
    async sweep() {
      const { rows } = await d.pool.query<{ run_id: string; trip_id: string; waiting_since: Date; updated_at: Date; login: string | null; logged_in_at: Date | null; resume: Resume }>(
        `select b.run_id, b.trip_id, b.waiting_since, b.updated_at, b.resume, l.state as login, l.logged_in_at
         from bus_bookings b left join ixigo_logins l on l.trip_id = b.trip_id
         where b.why = 'login_needed' and b.resume is not null`,
      );
      const now = d.now().getTime();
      const trips = new Set<string>();
      for (const r of rows) {
        if (r.login === 'logged_in' && r.logged_in_at && r.logged_in_at > r.updated_at) trips.add(r.trip_id);
        else if (r.login === 'skipped' || now - r.waiting_since.getTime() >= LOGIN_WAIT_MS) {
          const let_ = await d.pool.query(`update bus_bookings set why = 'login_let_go', updated_at = $2 where run_id = $1 and why = 'login_needed'`, [r.run_id, d.now()]);
          if (let_.rowCount && r.resume.restore) await putBack({ tripId: r.trip_id, restore: r.resume.restore });
        }
      }
      for (const tripId of trips) await carryOn(tripId);
      // A booking that waits on the person's details carries on once they kept them (the one ask's form saves them in
      // their vault), read as the booking reads them; one never kept puts their card back after LOGIN_WAIT_MS.
      const waiting = await d.pool.query<{ run_id: string; trip_id: string; person_id: string; option_id: string; title: string; waiting_since: Date; resume: Resume }>(
        `select run_id, trip_id, person_id, option_id, title, waiting_since, resume from bus_bookings where why = 'details_needed' and resume is not null`,
      );
      for (const r of waiting.rows) {
        const kept = await d.pay?.()?.travelDetails?.({
          tripId: r.trip_id, personId: r.person_id, booking: { ref: r.run_id, travellerPersonId: r.person_id, purpose: clip(`${r.title}, for ${r.resume.name}`, 200) },
        }).catch(() => null) ?? null;
        if (hasFields(kept, r.resume.need ?? ['dob', 'gender'])) {
          const taken = await d.pool.query(`update bus_bookings set why = 'details_in', updated_at = $2 where run_id = $1 and why = 'details_needed'`, [r.run_id, d.now()]);
          if (taken.rowCount) await resumeRun(r.trip_id, r, 'details_in');
        } else if (now - r.waiting_since.getTime() >= LOGIN_WAIT_MS) {
          const let_ = await d.pool.query(`update bus_bookings set why = 'details_let_go', updated_at = $2 where run_id = $1 and why = 'details_needed'`, [r.run_id, d.now()]);
          if (let_.rowCount && r.resume.restore) await putBack({ tripId: r.trip_id, restore: r.resume.restore });
        }
      }
    },
    async settled() {
      await Promise.all([...running]);
    },
  };
}
