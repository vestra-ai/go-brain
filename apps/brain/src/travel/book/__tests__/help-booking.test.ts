import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TurnCtx } from '../../../composer/tools.js';
import type { Capture, FetchPlan } from '../../recipes/recipe.js';
import { capture } from '../../recipes/__tests__/fixtures.js';
import { BOOK_DIR, loadBook } from '../book.js';
import { createEngine } from '../engine.js';
import { FROM_THE_ACCOUNT, ixigoTool, NOTHING_ON_THE_ACCOUNT } from '../tool.js';

// help.booking: the trip's own bookings on its ixigo account, as ixigo's help centre lists them. The atlas (10 Oct) read
// the call's field names on a logged-in account, and the help centre's own code for where each product keeps its route
// and its day; no answer of a person's was recorded. The sample is made up: its names, email, phone, PNRs and ids say
// they are never read, and the tests prove none of them reaches an answer.
const { book } = loadBook();
const sample = (name: string): string => readFileSync(`${BOOK_DIR}samples/${name}`, 'utf8');
const BOOKINGS = '/support/helpcenter/api/v1/booking$';
const BOOKINGS_URL = 'https://www.ixigo.com/support/helpcenter/api/v1/booking';
/** A Goa trip, 6 to 9 Nov, asked about on 10 Oct. */
const GOA = { people: 4, homes: ['Mumbai'], destination: 'Goa', start: '2026-11-06', end: '2026-11-09', today: '2026-10-10' };
type Trip = { people: number; homes: string[]; destination?: string | null; start?: string | null; end?: string | null; today?: string };

function engineWith(trip: Trip, captures: Capture[] = [capture(BOOKINGS, BOOKINGS_URL, sample('help.booking.json'))], login: () => Promise<{ ok: true } | { ok: false; note: string }> = async () => ({ ok: true })) {
  const runs: Array<{ url: string; plan: FetchPlan }> = [];
  const asked: string[] = [];
  const runner = {
    read: async (_trip: string, url: string, plan: FetchPlan) => {
      runs.push({ url, plan });
      return { captures, finalUrl: url };
    },
  };
  const engine = createEngine({
    book, runner: () => runner, trip: async () => trip, now: () => new Date('2026-10-10T09:00:00Z'),
    login: async (_trip, what) => {
      asked.push(what);
      return login();
    },
  });
  return { engine, runs, asked };
}

const FLIGHT = {
  what: 'flight', route: 'Mumbai to Goa', round_trip: true, flights: ['IndiGo 6E2134', 'IndiGo 6E5329'],
  departs: 'Fri 6 Nov, 07:10', from_terminal: 'BOM terminal 2', lands: 'Fri 6 Nov, 08:25', to_terminal: 'GOX terminal 1',
  returns: 'Mon 9 Nov, 18:40', return_from_terminal: 'GOX terminal 1', flight_status: 'scheduled', status: 'confirmed',
  can_cancel: true, can_change_date: true, free_cancellation: true, refundable: true, cabin_bag: '7 Kg', check_in_bag: '15 Kg',
  // The airline's own page, with nothing of the booking in it: the query carried a PNR and a name.
  web_check_in: 'https://www.goindigo.in/web-check-in.html',
};
const HOTEL = { what: 'hotel', stay: 'Villa Sol, Goa', check_in: 'Fri 6 Nov', check_out: 'Mon 9 Nov', pay_later: true, status: 'confirmed', can_cancel: true, refundable: true };
// A cab says when, never where from or to: those are addresses.
const CAB = { what: 'cab', departs: 'Fri 6 Nov, 08:40', status: 'confirmed' };
const TRAIN = { what: 'train', route: 'Mumbai CSMT to Madgaon, Goa', train: '10103 Mandovi Express', departs: 'Thu 5 Nov, 22:15', status: 'not confirmed yet' };

describe('help.booking', () => {
  it("reads only this trip's bookings, from ixigo's help centre on the trip's login: what a group asks after booking", async () => {
    const { engine, runs, asked } = engineWith(GOA);
    const got = await engine.answer('help.booking', {}, { tripId: 't_goa' });
    if (got.as !== 'facts') throw new Error('not facts');
    // The login is made sure of first, and the page is the help centre, which lists the bookings as it opens.
    expect(asked).toHaveLength(1);
    expect(got.page).toBe('https://www.ixigo.com/support');
    expect(runs[0]!.plan.capture).toEqual([{ match: BOOKINGS, required: true }]);
    expect(got.title).toBe("This trip's bookings");
    // To or from Goa on the trip's days: never last year's Goa flight, a flight to Bengaluru on the trip's days, or a bus
    // (the help centre lists none).
    expect(got.rows).toEqual([FLIGHT, HOTEL, CAB, TRAIN]);
  });

  it('never says a name, an email, a phone, a PNR, an id or a link that carries one', async () => {
    const { engine } = engineWith(GOA);
    const got = await engine.answer('help.booking', {}, { tripId: 't_goa' });
    const said = JSON.stringify(got);
    expect(said).not.toMatch(/NEVER-READ|NEVERREAD|never\.read|9000000000|BOOKING-ID|Anjuna|\?pnr/);
  });

  it('narrows to the product people asked about: a train is either kind of ixigo train booking', async () => {
    const { engine } = engineWith(GOA);
    const rows = async (product: string) => {
      const got = await engine.answer('help.booking', { product }, { tripId: 't_goa' });
      return got.as === 'facts' ? got.rows : null;
    };
    expect(await rows('hotel')).toEqual([HOTEL]);
    expect(await rows('Flight')).toEqual([FLIGHT]);
    expect(await rows('train')).toEqual([TRAIN]);
  });

  it("a trip with no days yet reads the place's bookings from today on, never a past one; a trip with no place reads none", async () => {
    const undated = engineWith({ ...GOA, start: null, end: null }).engine;
    const got = await undated.answer('help.booking', {}, { tripId: 't_goa' });
    expect(got.as === 'facts' && got.rows.map((r) => r['what'])).toEqual(['flight', 'hotel', 'cab', 'train']);
    const placeless = engineWith({ ...GOA, destination: null }).engine;
    const none = await placeless.answer('help.booking', {}, { tripId: 't_goa' });
    expect(none.as === 'facts' && none.rows).toEqual([]);
  });

  it('opens nothing until the trip is logged in: the engine asks first, and says so', async () => {
    const { engine, runs } = engineWith(GOA, [], async () => ({ ok: false, note: 'Go asked Rahul to log in to ixigo first.' }));
    await expect(engine.answer('help.booking', {}, { tripId: 't_goa' })).rejects.toMatchObject({ code: 'refused', message: 'Go asked Rahul to log in to ixigo first.' });
    expect(runs).toEqual([]);
  });
});

describe('the ixigo tool on the trip account', () => {
  const turn = { tripId: 't_goa', turnId: 'turn_1', cards: [], stableId: (p: string) => `${p}_1` } as unknown as TurnCtx;

  it("says the account's bookings from their facts alone, and that there is none rather than a guess", async () => {
    const tool = ixigoTool({ book, engine: engineWith(GOA).engine, live: () => true })!;
    const out = (await tool.run({ recipe: 'help.booking', inputs: { product: 'hotel' } }, turn)) as Record<string, unknown>;
    expect(out).toMatchObject({ recipe: 'help.booking', facts: [HOTEL], tell_the_room: FROM_THE_ACCOUNT });
    expect(FROM_THE_ACCOUNT).toContain('never a booking that isn\'t in these facts');
    const elsewhere = ixigoTool({ book, engine: engineWith({ ...GOA, destination: 'Manali' }).engine, live: () => true })!;
    expect(await elsewhere.run({ recipe: 'help.booking', inputs: {} }, turn)).toMatchObject({ facts: [], note: NOTHING_ON_THE_ACCOUNT });
    expect(NOTHING_ON_THE_ACCOUNT).toContain('never guess one');
  });
});
