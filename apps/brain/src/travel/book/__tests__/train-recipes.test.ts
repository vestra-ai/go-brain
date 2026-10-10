import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Capture, FetchPlan } from '../../recipes/recipe.js';
import { capture } from '../../recipes/__tests__/fixtures.js';
import { BOOK_DIR, loadBook } from '../book.js';
import { createEngine } from '../engine.js';

// p4's trains recipes beyond the search, each read from its own sample: ixigo's own answers, recorded logged out on 7 Oct
// 2026 and trimmed ("… n more" marks where a list was cut). No person's details are in any of them.
const { book } = loadBook();
const sample = (name: string): string => readFileSync(`${BOOK_DIR}samples/${name}`, 'utf8');
const SEARCH = 'ixigotrainsapi.confirmtkt.com/api/v1/trains/search';
const SEARCH_URL = `https://${SEARCH}?sourceStationCode=SBC&destinationStationCode=MAS&dateOfJourney=22-10-2026`;

function engineWith(answer: (url: string, plan: FetchPlan) => Capture[]) {
  const runs: Array<{ url: string; plan: FetchPlan }> = [];
  const runner = {
    read: async (_trip: string, url: string, plan: FetchPlan) => {
      runs.push({ url, plan });
      return { captures: answer(url, plan), finalUrl: url };
    },
  };
  const engine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-08T12:00:00Z') });
  return { engine, runs };
}

async function facts(id: string, inputs: Record<string, unknown>, captures: Capture[]) {
  const { engine, runs } = engineWith(() => captures);
  const got = await engine.answer(id, inputs, { tripId: 't_goa' });
  if (got.as !== 'facts') throw new Error('not facts');
  return { ...got, runs };
}

const ROUTE = { from: 'Bangalore', to: 'Chennai', date: '2026-10-22' };
const RESULTS = 'https://www.ixigo.com/trains/search-pwa/from/SBC/to/MAS/22-10-2026';
const search = () => [capture(SEARCH, SEARCH_URL, sample('trains.between.page.json'))];

describe('trains.confirm_chance', () => {
  it("says each class's seats, and for a waitlisted one ixigo's chance, its verdict and the refund the plan would pay", async () => {
    const got = await facts('trains.confirm_chance', ROUTE, search());
    expect(got.page).toBe(RESULTS);
    expect(got.runs[0]!.plan.capture).toEqual([{ match: SEARCH, required: true }]);
    expect(got.title).toBe('KSR Bengaluru to Chennai Central, 22 Oct');
    expect(got.rows.map((r) => r['train'])).toEqual(['Muzaffarpur EXP 15227', 'Shatabdi EXP 12028', 'Lalbagh SF EXP 12608']);
    expect(got.rows[0]!['classes']).toEqual([
      '1A: WL 9, 76% chance to confirm, ixigo says Confirm, Alternate Travel Plan refund up to 3x',
      '2A: AVL 2',
      '3A: AVL 8',
      '3E: Regret',
      'SL: WL 127, 29% chance to confirm, ixigo says No Chance',
    ]);
  });

  it('narrows to the train and the class people asked about', async () => {
    const got = await facts('trains.confirm_chance', { ...ROUTE, train: '12608', class: 'CC' }, search());
    expect(got.rows).toEqual([{
      train: 'Lalbagh SF EXP 12608', leaves: 'SBC 06:25', arrives: 'MAS 12:20',
      classes: ['CC: WL 7, 93% chance to confirm, ixigo says Confirm, Alternate Travel Plan refund up to 3x'],
    }]);
  });

  // The day Tatkal booking opens, ixigo fills each train's Tatkal seats beside the general ones (empty on other days, as in
  // the sample of 7 Oct): said as a list of their own, never as a general class line a watch could take for a seat.
  it('says Tatkal apart when ixigo has it, and nothing about Tatkal when it has none', async () => {
    const page = JSON.parse(sample('trains.between.page.json')) as { data: { trainList: Array<Record<string, unknown>> } };
    const lalbagh = page.data.trainList.find((t) => t && t['trainNumber'] === '12608')!;
    lalbagh['availabilityCacheTatkal'] = {
      CC: { availability: 'AVAILABLE-0012', availabilityDisplayName: 'AVL 12', fare: '735' },
      '2S': { availability: 'TQWL3/WL3', availabilityDisplayName: 'WL 3', predictionPercentage: 41, prediction: '41% Chance', confirmTktStatus: 'Probable' },
    };
    const tatkalDay = () => [capture(SEARCH, SEARCH_URL, JSON.stringify(page))];
    const got = await facts('trains.confirm_chance', { ...ROUTE, train: '12608' }, tatkalDay());
    expect(got.rows[0]!['classes']).toContain('CC: WL 7, 93% chance to confirm, ixigo says Confirm, Alternate Travel Plan refund up to 3x');
    expect(got.rows[0]!['tatkal']).toEqual(['CC: AVL 12', '2S: WL 3, 41% chance to confirm, ixigo says Probable']);
    expect((await facts('trains.confirm_chance', { ...ROUTE, train: '12608', class: '2S' }, tatkalDay())).rows[0]!['tatkal']).toEqual(['2S: WL 3, 41% chance to confirm, ixigo says Probable']);
    expect((await facts('trains.confirm_chance', { ...ROUTE, train: '12608' }, search())).rows[0]).not.toHaveProperty('tatkal');
  });
});

describe('trains.alternates', () => {
  it('lists the trains with an alternate for a full class, each alternate with its legs, seats and fare', async () => {
    const got = await facts('trains.alternates', ROUTE, search());
    expect(got.rows).toEqual([{ train: 'Lalbagh SF EXP 12608', alternates: ['CC (General): Alternate Seat, 23 Oct, 12608 SBC to MAS CC AVL 15 on 23 Oct, ₹575'] }]);
  });

  it('answers nothing for a train with no alternate', async () => {
    expect((await facts('trains.alternates', { ...ROUTE, train: '12028' }, search())).rows).toEqual([]);
  });
});

describe('trains.alternate_dates', () => {
  it("reads the route's day strip from the results page, each day named by the strip's own legend", async () => {
    const CAL = 'ixigotrainsapi.confirmtkt.com/api/v1/availability/availabilityCalender';
    const got = await facts('trains.alternate_dates', { from: 'Jaipur', to: 'Bangalore', date: '2026-10-07' }, [
      capture(CAL, `https://${CAL}?sourceStationCode=JP&destinationStationCode=SBC&startDate=07-10-2026&days=30`, sample('trains.alternate_dates.json')),
    ]);
    expect(got.page).toBe('https://www.ixigo.com/trains/search-pwa/from/JP/to/SBC/07-10-2026');
    expect(got.rows).toEqual([{ route: 'JP to SBC', by_day: ['7 Oct: Few Seats', '8 Oct: Filling Fast', '9 Oct: Filling Fast'] }]);
  });
});

describe('trains.alternate_travel_plan', () => {
  it("says the plan in ixigo's own words, its HTML marks taken out", async () => {
    const PLAN = 'ixigotrainsapi.confirmtkt.com/api/v2/trains/insurance/content';
    const got = await facts('trains.alternate_travel_plan', ROUTE, [capture(PLAN, `https://${PLAN}?contentVariants=12a&insuranceTypes=TRAVEL_GUARANTEE`, sample('trains.alternate_travel_plan.json'))]);
    const plan = got.rows[0]!;
    expect(plan['refund']).toBe('Confirmed Ticket or 3X Refund* if your ticket remains fully waitlisted *(3X for flight / 3X for bus / 2X for train)');
    expect(plan['chosen_by_default']).toBe('Default selected for eligible waitlisted tickets');
    expect(plan['terms']).toHaveLength(3);
    expect(plan['good_to_know']).toContain('Coupon Validity: Claim & use your coupon within 7 days of chart preparation');
    expect(JSON.stringify(plan)).not.toMatch(/<[a-z]/i);
  });
});

describe('trains.by_name', () => {
  const BOX = 'searchFor=getTrainByNameOrCode';
  const url = (words: string) => `https://www.ixigo.com/action/content/trainstation?searchFor=getTrainByNameOrCode&nameOrCode=${encodeURIComponent(words)}`;

  it("opens the train box's own call with the words in its address, nothing typed, and reads the trains they name, both ways", async () => {
    const got = await facts('trains.by_name', { train: 'Goa Express' }, [capture(BOX, url('Goa Express'), sample('trains.by_name.json'))]);
    expect(got.page).toBe(url('Goa Express'));
    expect(got.runs[0]!.plan).toEqual({ capture: [{ match: BOX, required: true, max_bytes: 200_000 }] });
    expect(got.rows).toEqual([
      { number: '12780', name: 'Goa Express', from: 'New Delhi (NZM)', to: 'Goa (VSG)', classes: ['1A', '2A', '3A', '3E', 'SL'], runs_daily: true },
      { number: '12779', name: 'Goa Express', from: 'Goa (VSG)', to: 'New Delhi (NZM)', classes: ['1A', '2A', '3A', '3E', 'SL'], runs_daily: true },
    ]);
  });

  it('takes a number as well as a name', async () => {
    const got = await facts('trains.by_name', { train: '12779' }, [capture(BOX, url('12779'), sample('trains.by_name.json'))]);
    expect(got.rows.map((r) => r['number'])).toEqual(['12779']);
  });
});

describe('trains.offers', () => {
  it("reads ixigo's train offers page: the count, the payment types, and each offer with its last day", async () => {
    const PAGE = 'https://www.ixigo.com/offers/tag/trains';
    const got = await facts('trains.offers', {}, [capture('/offers/tag/trains$', PAGE, sample('trains.offers.html'))]);
    expect(got.page).toBe(PAGE);
    expect(got.runs[0]!.plan.capture).toEqual([{ match: '/offers/tag/trains$', required: true, max_bytes: 1_000_000 }]);
    expect(got.rows[0]).toEqual({ train_offers: 6, paid_with: ['UPI: 1', 'CRED: 1', 'AU Bank: 1', 'UPI: 1'] });
    expect(got.rows).toHaveLength(7);
    expect(got.rows[1]).toEqual({ offer: '₹0 Payment Gateway Charges on train bookings via AU Credit Card', paid_with: 'AU Bank', until: '31 Dec 2026', details: 'AU-0PG' });
    // An offer with no last day, and no code, says neither.
    expect(got.rows[3]).toEqual({ offer: 'Redeem Rewards. Save Instantly. Travel Smarter.', details: 'pay-with-points' });
  });
});
