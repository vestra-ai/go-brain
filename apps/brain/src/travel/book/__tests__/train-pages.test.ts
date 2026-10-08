import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Capture, FetchPlan } from '../../recipes/recipe.js';
import { capture } from '../../recipes/__tests__/fixtures.js';
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
