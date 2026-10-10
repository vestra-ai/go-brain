import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Capture, FetchPlan } from '../../recipes/recipe.js';
import { capture } from '../../recipes/__tests__/fixtures.js';
import { readBodyAs, type HtmlInputs } from '../bodies.js';
import { BOOK_DIR, loadBook } from '../book.js';
import { createEngine } from '../engine.js';

// p4's recipes on ixigo's plain server-rendered train pages (html_tables): a train's schedule, its running status, a
// station's trains and a train's platforms, each read from its own sample: the page as ixigo sent it on 8 Oct 2026,
// logged out, trimmed to its title, canonical address, ld+json and tables. No person's details are in any of them.
const { book } = loadBook();
const sample = (name: string): string => readFileSync(`${BOOK_DIR}samples/${name}`, 'utf8');

async function facts(id: string, inputs: Record<string, unknown>, captures: Capture[]) {
  const runs: Array<{ url: string; plan: FetchPlan }> = [];
  const runner = {
    read: async (_trip: string, url: string, plan: FetchPlan) => {
      runs.push({ url, plan });
      return { captures, finalUrl: url };
    },
  };
  const engine = createEngine({ book, runner: () => runner, trip: async () => ({ people: 4, homes: [] }), now: () => new Date('2026-10-08T12:00:00Z') });
  const got = await engine.answer(id, inputs, { tripId: 't_goa' });
  if (got.as !== 'facts') throw new Error('not facts');
  return { ...got, runs };
}

describe('trains.schedule', () => {
  it("reads the train page's two tables: the train's facts and every stop, starts and ends said as such", async () => {
    const PAGE = 'https://www.ixigo.com/trains/10103';
    const got = await facts('trains.schedule', { train: '10103' }, [capture('/trains/10103$', PAGE, sample('trains.schedule.html'))]);
    expect(got.page).toBe(PAGE);
    expect(got.runs[0]!.plan.capture).toEqual([{ match: '/trains/10103$', required: true, max_bytes: 1_000_000 }]);
    expect(got.title).toBe('Train 10103');
    const train = got.rows[0]!;
    expect(train).toMatchObject({
      train: '10103 Mandovi Express', route: 'C Shivaji Mah T (CSMT) to Madgaon (MAO)', runs_on: 'Mon, Tue, Wed, Thu, Fri, Sat, Sun',
      classes: '1A, 2A, 3A, 3E, SL', takes: '14hr 45min', type: 'Mail Express', pantry: 'No',
    });
    const stops = train['stops'] as string[];
    expect(stops).toHaveLength(20);
    expect(stops[0]).toBe('C Shivaji Mah T (CSMT): starts, departs 07:10, day 1, platform 18, usual delay On Time');
    expect(stops[19]).toBe('Madgaon (MAO): arrives 21:55, ends, day 1, platform 5, 765 km, usual delay 17min');
  });

  // The page's own data (its hidden input "dataBE", the sample's cut to the train, its stops, fares and stations).
  it("adds the train's rake, speeds, rating and rake sharing, and each class's fare with its Tatkal charge", async () => {
    const got = await facts('trains.schedule', { train: '10103' }, [capture('/trains/10103$', 'https://www.ixigo.com/trains/10103', sample('trains.schedule.html'))]);
    expect(got.rows[0]).toMatchObject({
      rake: 'LHB', average_speed: '39 km/h', top_speed: '120 km/h', distance: '581 km', rating: '3.0 of 5',
      rake_sharing: 'RSA - Rake Sharing; 10104 - 20111 - 20112 - 10103; 3 Rakes; PM @ MAO; ISO Certified Train; '
        + '10104/Mandovi Express 20111/Konkan Kanya SF Express 20112/Konkan Kanya SF Express 10103/Mandovi Express',
      fares: ['1A: ₹2,605, Tatkal ₹400 more', 'SL: ₹390, Tatkal ₹111 more', '3A: ₹1,070, Tatkal ₹293 more', '2A: ₹1,540, Tatkal ₹400 more'],
    });
  });

  it('still answers from its tables when the page comes without its data', async () => {
    const bare = sample('trains.schedule.html').replace(/<input type="hidden"[^>]*id="dataBE"[^>]*>/, '');
    expect(bare).not.toContain('dataBE');
    const got = await facts('trains.schedule', { train: '10103' }, [capture('/trains/10103$', 'https://www.ixigo.com/trains/10103', bare)]);
    expect(got.rows[0]).toMatchObject({ train: '10103 Mandovi Express', type: 'Mail Express' });
    expect(got.rows[0]!['stops']).toHaveLength(20);
    expect(got.rows[0]).not.toHaveProperty('rake');
    expect(got.rows[0]).not.toHaveProperty('fares');
  });
});

describe('trains.boarding_stations', () => {
  const PAGE = 'https://www.ixigo.com/trains/10103';
  const page = () => [capture('/trains/10103$', PAGE, sample('trains.schedule.html'))];

  it('lists the booked station and every stop after it, before the last, by code or name', async () => {
    const got = await facts('trains.boarding_stations', { train: '10103', from: 'CSMT', to: 'MAO' }, page());
    expect(got.page).toBe(PAGE);
    expect(got.title).toBe('Train 10103 boarding points');
    const points = got.rows[0]!['boarding_points'] as string[];
    expect(points).toHaveLength(19);
    expect(points[0]).toBe('C Shivaji Mah T (CSMT): departs 07:10, day 1');
    expect(points[18]).toBe('Karmali (KRMI): departs 20:22, day 1');
    const named = (await facts('trains.boarding_stations', { train: '10103', from: 'thane', to: 'Thivim' }, page())).rows[0]!['boarding_points'] as string[];
    expect([named.length, named[0], named[14]]).toEqual([15, 'Thane (TNA): departs 07:55, day 1', 'Pernem (PERN): departs 19:34, day 1']);
  });

  it('says a station that is not a stop, and a booking the wrong way round, with no points', async () => {
    const missing = await facts('trains.boarding_stations', { train: '10103', from: 'JP', to: 'MAO' }, page());
    expect(missing.rows[0]).toMatchObject({ not_a_stop: 'JP: not among its stops' });
    expect(missing.rows[0]).not.toHaveProperty('boarding_points');
    const back = await facts('trains.boarding_stations', { train: '10103', from: 'MAO', to: 'CSMT' }, page());
    expect(back.rows[0]).toMatchObject({ wrong_way: 'It reaches CSMT before MAO' });
    expect(back.rows[0]).not.toHaveProperty('boarding_points');
  });
});

describe('trains.running_status', () => {
  it("reads today's run, station by station, and the run's state", async () => {
    const PAGE = 'https://www.ixigo.com/trains/12992/running-status';
    const got = await facts('trains.running_status', { train: '12992' }, [capture('/trains/12992/running-status$', PAGE, sample('trains.running_status.html'))]);
    expect(got.page).toBe(PAGE);
    const run = got.rows[0]!;
    expect(run['train']).toBe('Jp Udz Superfast 12992');
    expect(run['state']).toBe('Cancelled');
    const stations = run['stations'] as string[];
    expect(stations).toHaveLength(16);
    expect(stations[1]).toBe('Asalpur Jobner 37 km: arrives 14:37, departs 14:39, Cancelled, platform 3');
    expect(stations[15]).toBe('Udaipur City 434 km: arrives 21:48, departs Destination, Cancelled, platform 4');
  });
});

describe('trains.station_status', () => {
  it("opens the station's page by its name and code, and reads its first ten trains, the paging row left out", async () => {
    const PAGE = 'https://www.ixigo.com/train-stations/jaipur-jp-railway-station';
    const got = await facts('trains.station_status', { station: 'Jaipur' }, [capture('/train-stations/jaipur-jp-railway-station$', PAGE, sample('trains.station_status.html'))]);
    expect(got.page).toBe(PAGE);
    expect(got.title).toBe('Jaipur station');
    const station = got.rows[0]!;
    expect(station['station']).toBe('Jaipur (JP)');
    const trains = station['trains'] as string[];
    expect(trains).toHaveLength(10);
    expect(trains[0]).toBe('22998 Sgnr Jlwc Exp: arrives 10:35, departs 10:45, halt 10 mins');
  });
});

describe('trains.platform_locator', () => {
  const PAGE = 'https://www.ixigo.com/trains/platform-locator?train=12992';
  const page = () => [capture('/trains/platform-locator$', PAGE, sample('trains.platform_locator.html'))];

  it("reads each station's usual platform", async () => {
    const got = await facts('trains.platform_locator', { train: '12992' }, page());
    expect(got.page).toBe(PAGE);
    expect(got.rows[0]!['train']).toBe('Jp Udz Superfast 12992');
    const platforms = got.rows[0]!['platforms'] as string[];
    expect(platforms).toHaveLength(16);
    expect(platforms[0]).toBe('JP - Jaipur: platform 1, arrives -, departs 14:10, day 1');
  });

  it('narrows to the station people asked about, by its code', async () => {
    const got = await facts('trains.platform_locator', { train: '12992', station: 'job' }, page());
    expect(got.rows[0]!['platforms']).toEqual(['JOB - Asalpur Jobner: platform 3, arrives 14:37, departs 14:39, day 1']);
  });
});

// ixigo's Tatkal page as it was sent on 10 Oct 2026, logged out, trimmed to its title, canonical address, its WebPage and
// FAQPage ld+json and its tables.
describe('trains.tatkal', () => {
  it("reads when Tatkal opens for each class, each class's charge, Tatkal beside Premium Tatkal, and the page's questions", async () => {
    const PAGE = 'https://www.ixigo.com/trains/tatkal-railway-reservation';
    const got = await facts('trains.tatkal', {}, [capture('/trains/tatkal-railway-reservation$', PAGE, sample('trains.tatkal.html'))]);
    expect(got.page).toBe(PAGE);
    expect(got.runs[0]!.plan.capture).toEqual([{ match: '/trains/tatkal-railway-reservation$', required: true, max_bytes: 1_000_000 }]);
    expect(got.title).toBe('Tatkal');
    const tatkal = got.rows[0]!;
    expect(tatkal['opens']).toEqual([
      'AC 1 Tier (1A), AC 2 Tier (2A), AC 3 Tier (3A), Chair Car Coach(CC), Executive Chair (EC), AC-3 Economy (3E): 10:00 to 10:30 AM',
      'Sleeper (SL), First Class (FC), Second Seating (2S): 11:00 to 11:30 AM',
    ]);
    expect(tatkal['charges']).toEqual([
      'Reserve Second sitting (2S): ₹10 to ₹15', 'Sleeper: ₹100 to ₹200', 'AC Chair Car: ₹125 to ₹225',
      'AC 3 Tier: ₹300 to ₹400', 'AC 2 Tier: ₹400 to ₹500', 'Executive: ₹400 to ₹500',
    ]);
    // The page draws this table twice: it is read once.
    const versus = tatkal['tatkal_vs_premium_tatkal'] as string[];
    expect(versus).toHaveLength(7);
    expect(versus[0]).toBe('Tatkal: IRCTC Tatkal booking charges are fixed; Premium Tatkal: Premium Tatkal tickets have dynamic fare pricing for classes');
    expect(versus).toContain('Tatkal: Tickets can be cancelled; Premium Tatkal: Tickets cannot be cancelled');
    // Seven of its eight questions: the one whose answer is a table is the table above.
    const questions = tatkal['questions'] as string[];
    expect(questions).toHaveLength(7);
    expect(questions[2]).toMatch(/^How do I cancel Tatkal tickets\? Confirmed tickets do not get a refund upon cancellation\./);
    expect(questions[5]).toMatch(/^Is the senior citizen quota available for Tatkal\? No\./);
    expect(JSON.stringify(tatkal)).not.toMatch(/<[a-z]|&amp;/i);
  });
});

// The train page's own data (html_inputs, "dataBE"): the page of 8 Oct, logged out, trimmed to its title, canonical
// address and hidden inputs, the data cut to the train, its stops, fares and stations.
describe('trains.coach_position', () => {
  const PAGE = 'https://www.ixigo.com/trains/10103';
  const page = (html = sample('trains.coach_position.html')) => [capture('/trains/10103$', PAGE, html)];
  // A list, never one long line: a fact longer than 300 characters is cut, and a long rake's line would be.
  const MANDOVI = [
    'Engine', 'General', 'General', 'M3 (3E)', 'M2 (3E)', 'M1 (3E)', 'B4 (3A)', 'B3 (3A)', 'B2 (3A)', 'B1 (3A)', 'A1 (2A)', 'HA1 (1A+2A)',
    'Pantry car', 'S7 (SL)', 'S6 (SL)', 'S5 (SL)', 'S4 (SL)', 'S3 (SL)', 'S2 (SL)', 'S1 (SL)', 'General', 'General',
  ];

  it("says the coaches from the engine end at the train's first station, and its rake", async () => {
    const got = await facts('trains.coach_position', { train: '10103' }, page());
    expect(got.page).toBe(PAGE);
    expect(got.runs[0]!.plan.capture).toEqual([{ match: '/trains/10103$', required: true, max_bytes: 1_000_000 }]);
    expect(got.title).toBe('Train 10103 coaches');
    expect(got.rows).toEqual([{ train: 'Mandovi Express 10103', at: 'C Shivaji Mah T (CSMT)', coaches: 22, order_from_engine: MANDOVI, rake: 'LHB' }]);
  });

  it('finds the coach people asked about at the station they named, by its name or its code', async () => {
    const got = await facts('trains.coach_position', { train: '10103', coach: 'b2', station: 'thivim' }, page());
    expect(got.rows[0]).toMatchObject({ at: 'Thivim (THVM)', coach: 'B2 (3A): position 8 of 0 to 21 from the engine end' });
    expect((await facts('trains.coach_position', { train: '10103', coach: 'S1', station: 'MAO' }, page())).rows[0]!['coach']).toBe('S1 (SL): position 19 of 0 to 21 from the engine end');
    expect((await facts('trains.coach_position', { train: '10103', coach: 'B9' }, page())).rows[0]!['coach']).toBe("B9 is not one of this train's coaches");
  });

  it("says a station the train doesn't stop at, with its stops, and the first station's order", async () => {
    const got = await facts('trains.coach_position', { train: '10103', station: 'JP' }, page());
    expect(got.rows[0]).toMatchObject({
      at: 'C Shivaji Mah T (CSMT)',
      not_a_stop: 'JP is not one of its stops: CSMT, DR, TNA, PNVL, MNI, KHED, CHI, SGR, RN, ADVI, RAJP, VBW, KKW, SNDD, KUDL, SWV, PERN, THVM, KRMI, MAO',
    });
  });

  it('reads the order the train stands in at a station past a reversal, and says where it flips', async () => {
    const data = (readBodyAs(sample('trains.coach_position.html'), 'html_inputs', 'the train') as HtmlInputs).inputs['dataBE'] as { schedules: Array<{ locoIndex: number }> };
    data.schedules.forEach((stop, i) => { stop.locoIndex = i >= 8 ? 1 : 0; });
    const reversed = `<html><body><input type="hidden" id="dataBE" value="${JSON.stringify(data).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></body></html>`;
    const got = await facts('trains.coach_position', { train: '10103', coach: 'S1', station: 'Madgaon' }, page(reversed));
    expect(got.rows[0]).toMatchObject({ at: 'Madgaon (MAO)', coach: 'S1 (SL): position 3 of 0 to 21 from the engine end', order_flips_at: ['Ratnagiri (RN)'] });
    expect((got.rows[0]!['order_from_engine'] as string[]).slice(0, 5)).toEqual(['Engine', 'General', 'General', 'S1 (SL)', 'S2 (SL)']);
    expect((await facts('trains.coach_position', { train: '10103' }, page(reversed))).rows[0]!['order_from_engine']).toEqual(MANDOVI);
  });
});
