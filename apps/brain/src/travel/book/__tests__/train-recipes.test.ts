import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Capture, FetchPlan } from '../../recipes/recipe.js';
import { capture, fixture } from '../../recipes/__tests__/fixtures.js';
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
  // The page speed: ixigo's results page, whose own calls (the trains, their seats) always come. The newer page draws a
  // route its browser already showed from a kept answer, with no confirmtkt call (the atlas, 10 Oct), so it is not read.
  const DESKTOP = 'https://www.ixigo.com/search/result/train/NDLS/MAO/06112026//1/0/0/0/ALL';
  const DELHI_GOA = { from: 'Delhi', to: 'Goa', date: '2026-11-06' };
  const desktop = (seats = fixture('trains-ndls-mao-availability.json')) => [
    capture('/trains/v1/search/between/', 'https://www.ixigo.com/trains/v1/search/between/NDLS/MAO?date=2026-11-06&languageCode=en', fixture('trains-ndls-mao-between.json')),
    capture('/api/v3/trains/availability', 'https://www.ixigo.com/api/v3/trains/availability?originCode=NDLS&destinationCode=MAO&travelDate=06112026', seats),
  ];
  const SAMPARK = ['1A: WL 6', '2A: WL 22, 39% chance to confirm', '3A: WL 30', '3E: WL 22, 39% chance to confirm', 'SL: WL 53'];

  it("reads ixigo's results page, never the newer page's confirmtkt call: each class's status and ixigo's chance, with no verdict", async () => {
    const got = await facts('trains.confirm_chance', { ...DELHI_GOA, train: '12218' }, desktop());
    expect(got.page).toBe(DESKTOP);
    expect(got.runs[0]!.plan.capture).toEqual([{ match: '/trains/v1/search/between/', required: true }, { match: '/api/v3/trains/availability', required: true }]);
    expect(JSON.stringify(got.runs[0]!.plan)).not.toContain('confirmtkt');
    expect(got.rows).toEqual([{ train: 'Sampark Kranthi 12218', leaves: 'NDLS 13:10', arrives: 'MAO 17:10', classes: SAMPARK }]);
    const one = await facts('trains.confirm_chance', { ...DELHI_GOA, train: '12218', class: '2A' }, desktop());
    expect(one.rows[0]!['classes']).toEqual(['2A: WL 22, 39% chance to confirm']);
  });

  it('says Tatkal (q = TQ) apart on the page speed, and a watch reads only the general lines', async () => {
    const seats = JSON.parse(fixture('trains-ndls-mao-availability.json')) as { data: { routesData: Array<{ trainCode: string; availabilities: Array<Record<string, unknown>> }> } };
    seats.data.routesData.find((r) => r.trainCode === '12218')!.availabilities.push(
      { id: 'tq-3a', c: '3A', q: 'TQ', a: 'AVAILABLE-0004', p: 100, t: 0, f: 1540 },
      { id: 'tq-sl', c: 'SL', q: 'TQ', a: 'WL 3', p: 41, t: 0, f: 560 },
    );
    const got = await facts('trains.confirm_chance', { ...DELHI_GOA, train: '12218' }, desktop(JSON.stringify(seats)));
    expect(got.rows[0]).toMatchObject({ classes: SAMPARK, tatkal: ['3A: Available 4', 'SL: WL 3, 41% chance to confirm'] });
    expect((await facts('trains.confirm_chance', { ...DELHI_GOA, train: '12218' }, desktop())).rows[0]).not.toHaveProperty('tatkal');
  });

  // The fast speed: ixigo's train service's own call (confirmtkt), which also says ixigo's verdict and the plan's refund.
  async function fastFacts(inputs: Record<string, unknown>, body = sample('trains.between.page.json')) {
    const runs: Array<{ url: string; plan: FetchPlan }> = [];
    const runner = {
      read: async (_trip: string, url: string, plan: FetchPlan) => {
        runs.push({ url, plan });
        return { captures: [], finalUrl: url };
      },
      pageFetch: async () => capture('fast', SEARCH_URL, body),
    };
    const engine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-08T12:00:00Z') });
    const got = await engine.answer('trains.confirm_chance', inputs, { tripId: 't_goa' });
    if (got.as !== 'facts') throw new Error('not facts');
    return { ...got, runs };
  }

  it("at the fast speed says each class's seats, and for a waitlisted one ixigo's chance, its verdict and the refund the plan would pay", async () => {
    const got = await fastFacts(ROUTE);
    expect(got.runs).toEqual([]);
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
    const got = await fastFacts({ ...ROUTE, train: '12608', class: 'CC' });
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
    const tatkalDay = JSON.stringify(page);
    const got = await fastFacts({ ...ROUTE, train: '12608' }, tatkalDay);
    expect(got.rows[0]!['classes']).toContain('CC: WL 7, 93% chance to confirm, ixigo says Confirm, Alternate Travel Plan refund up to 3x');
    expect(got.rows[0]!['tatkal']).toEqual(['CC: AVL 12', '2S: WL 3, 41% chance to confirm, ixigo says Probable']);
    expect((await fastFacts({ ...ROUTE, train: '12608', class: '2S' }, tatkalDay)).rows[0]!['tatkal']).toEqual(['2S: WL 3, 41% chance to confirm, ixigo says Probable']);
    expect((await fastFacts({ ...ROUTE, train: '12608' })).rows[0]).not.toHaveProperty('tatkal');
  });
});

describe('trains.alternates', () => {
  it('lists the trains with an alternate for a full class, each alternate with its legs, seats and fare', async () => {
    const got = await facts('trains.alternates', ROUTE, search());
    // Only the newer page carries ixigo's alternates, so this one still reads it.
    expect(got.page).toBe(RESULTS);
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
