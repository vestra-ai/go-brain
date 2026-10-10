import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Capture, FetchPlan } from '../../recipes/recipe.js';
import { capture } from '../../recipes/__tests__/fixtures.js';
import { BOOK_DIR, loadBook } from '../book.js';
import { createEngine } from '../engine.js';

// The trip's ixigo account (auth: login). Its sample is built from My Trips' own code (the atlas, 10 Oct): the account had
// no upcoming booking that day, so no real answer was recorded. Its ids, PNRs and a traveller's name are placeholders that
// say they are never read; no person's details are in it.
const { book } = loadBook();
const sample = (name: string): string => readFileSync(`${BOOK_DIR}samples/${name}`, 'utf8');
const TRIPS = '/api/profile/secure/booking/grouped';
const TRIPS_URL = `https://www.ixigo.com${TRIPS}?groupingKeyFormat=MMM%20yyyy&upcoming=true&listingCategory=SUCCESSFUL&limit=10&offset=0`;

// The Goa trip: 6 to 9 Nov. The account also has a booking of another trip (Mumbai to Bengaluru, 20 Dec).
type Trip = { people: number; homes: string[]; destination?: string | null; start?: string | null; end?: string | null; today?: string };
const GOA: Trip = { people: 4, homes: [], destination: 'Goa', start: '2026-11-06', end: '2026-11-09', today: '2026-10-10' };

function engineWith(captures: Capture[], login: () => Promise<{ ok: true } | { ok: false; note: string }> = async () => ({ ok: true }), trip: Trip = GOA) {
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

describe('trip.upcoming', () => {
  it("reads this trip's upcoming bookings from My Trips: what, when, where to, for how many, the status and ixigo's flags", async () => {
    const { engine, runs, asked } = engineWith([capture(TRIPS, TRIPS_URL, sample('trip.upcoming.json'))]);
    const got = await engine.answer('trip.upcoming', {}, { tripId: 't_goa' });
    if (got.as !== 'facts') throw new Error('not facts');
    // The login is made sure of first, and the page is My Trips itself.
    expect(asked).toHaveLength(1);
    expect(got.page).toBe('https://www.ixigo.com/account/trips');
    expect(runs[0]!.plan.capture).toEqual([{ match: TRIPS, required: true }]);
    expect(got.title).toBe('Upcoming bookings');
    expect(got.rows).toEqual([
      { what: 'train', trip: 'Mumbai to Madgaon', starts: 'Fri, 06 Nov, 07:10', to: 'Madgaon', travellers: 4, status: 'booked', flags: [] },
      { what: 'hotel', trip: 'Villa in Anjuna', starts: 'Fri, 06 Nov', to: 'Goa', travellers: 4, status: 'payment pending', flags: [] },
      { what: 'flight', trip: 'Goa to New Delhi', starts: 'Mon, 09 Nov, 18:30', to: 'New Delhi', travellers: 2, status: 'booked', flags: ['smart lock'] },
    ]);
    // The account's other trip (20 Dec) never reaches this trip's room.
    expect(JSON.stringify(got)).not.toContain('Bengaluru');
    // A PNR, a booking or order id and a traveller's name are never read, so never in the answer.
    expect(JSON.stringify(got)).not.toMatch(/NEVER-READ|NEVERREAD|0000000000/);
  });

  it('narrows to the product people asked about', async () => {
    const { engine } = engineWith([capture(TRIPS, TRIPS_URL, sample('trip.upcoming.json'))]);
    const got = await engine.answer('trip.upcoming', { product: 'Train' }, { tripId: 't_goa' });
    expect(got.as === 'facts' && got.rows.map((r) => r['trip'])).toEqual(['Mumbai to Madgaon']);
  });

  it('before the trip has days, reads the bookings naming its place from today; with no place either, none', async () => {
    const undated = engineWith([capture(TRIPS, TRIPS_URL, sample('trip.upcoming.json'))], undefined, { ...GOA, start: null, end: null });
    const got = await undated.engine.answer('trip.upcoming', {}, { tripId: 't_goa' });
    expect(got.as === 'facts' && got.rows.map((r) => r['trip'])).toEqual(['Villa in Anjuna', 'Goa to New Delhi']);
    const nowhere = engineWith([capture(TRIPS, TRIPS_URL, sample('trip.upcoming.json'))], undefined, { people: 4, homes: [], today: '2026-10-10' });
    const none = await nowhere.engine.answer('trip.upcoming', {}, { tripId: 't_goa' });
    expect(none.as === 'facts' && none.rows).toEqual([]);
  });

  it('opens nothing until the trip is logged in: the engine asks first, and says so', async () => {
    const { engine, runs } = engineWith([], async () => ({ ok: false, note: 'Go asked Priya to log in to ixigo first.' }));
    await expect(engine.answer('trip.upcoming', {}, { tripId: 't_goa' })).rejects.toMatchObject({ code: 'refused', message: 'Go asked Priya to log in to ixigo first.' });
    expect(runs).toEqual([]);
  });
});
