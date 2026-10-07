import { describe, expect, it } from 'vitest';
import { readTrainsPage, trains } from '../trains.js';
import { capture, fixture } from './fixtures.js';

const ndls = trains.slotsFrom({ from: 'Delhi', to: 'Goa', date: '2026-11-06' }, { people: 4 });
const csmt = trains.slotsFrom({ from: 'Mumbai', to: 'Madgaon', date: '2026-10-08' }, { people: 4 });
const load = (name: string, from: string, to: string, date: string, ddmmyyyy: string, withAvailability = true) => [
  capture('/trains/v1/search/between/', `https://www.ixigo.com/trains/v1/search/between/${from}/${to}?date=${date}&languageCode=en`, fixture(`trains-${name}-between.json`)),
  ...(withAvailability
    ? [capture('/api/v3/trains/availability', `https://www.ixigo.com/api/v3/trains/availability?originCode=${from}&destinationCode=${to}&travelDate=${ddmmyyyy}`, fixture(`trains-${name}-availability.json`))]
    : []),
];

const BETWEEN_NDLS = 'https://www.ixigo.com/trains/v1/search/between/NDLS/MAO?date=2026-11-06&languageCode=en';
const SEATS_NDLS = 'https://www.ixigo.com/api/v3/trains/availability?originCode=NDLS&destinationCode=MAO&travelDate=06112026';
/** A saved NDLS to MAO body with its data changed by `edit`. */
const edited = (file: 'between' | 'availability', edit: (data: any) => void): string => {
  const body = JSON.parse(fixture(`trains-ndls-mao-${file}.json`));
  edit(body.data);
  return JSON.stringify(body);
};
const ndlsLoad = (between: string, seats: string) => [
  capture('/trains/v1/search/between/', BETWEEN_NDLS, between),
  capture('/api/v3/trains/availability', SEATS_NDLS, seats),
];

describe('the trains recipe', () => {
  it('fills station codes from city names, and opens the results page the map gives', () => {
    expect(ndls).toEqual({ from: 'NDLS', to: 'MAO', date: '2026-11-06' });
    expect(csmt).toEqual({ from: 'CSMT', to: 'MAO', date: '2026-10-08' });
    expect(trains.url(ndls)).toBe('https://www.ixigo.com/search/result/train/NDLS/MAO/06112026//1/0/0/0/ALL');
    expect(trains.capture.map((c) => [c.match, c.required])).toEqual([['/trains/v1/search/between/', true], ['/api/v3/trains/availability', false]]);
    expect(() => trains.slotsFrom({ from: 'Delhi', to: 'Shimla', date: '2026-11-06' }, { people: 4 })).toThrow(/Go can search ixigo trains/);
  });

  it('gives one option per train and class, per person, with its status, from where the train really boards', () => {
    const options = trains.extract(load('ndls-mao', 'NDLS', 'MAO', '2026-11-06', '06112026'));
    expect(options).toHaveLength(25);
    expect(options[0]).toEqual({
      kind: 'train',
      title: 'NZM ERS SF EXP 22656',
      priceMinor: 311_500,
      currency: 'INR',
      priceNote: 'per person, 2A',
      journey: {
        mode: 'train',
        origin: { name: 'Delhi Hazrat Nizamuddin', code: 'NZM' },
        destination: { name: 'Madgaon Junction', code: 'MAO' },
        depart_at: '2026-11-06T05:00:00+05:30',
        arrive_at: '2026-11-07T10:10:00+05:30',
        carrier_name: 'Indian Railways',
        number: '22656',
      },
      highlights: ['AC 2 Tier', 'WL 26', '29 h 10 m'],
      facts: { class_code: '2A', availability: 'WL 26', duration_min: 1750 },
      sourceUrl: 'https://www.ixigo.com/trains/22656?orgn=NZM&dstn=MAO&departDate=2026-11-06&quota=GN',
    });
  });

  it("says ixigo's chance that a waitlisted ticket confirms", () => {
    const options = trains.extract(load('ndls-mao', 'NDLS', 'MAO', '2026-11-06', '06112026'));
    const chance = options.find((o) => o.title === 'Sampark Kranthi 12218' && o.facts.class_code === '3E')!;
    expect(chance.highlights).toContain('39% chance to confirm');
    expect(chance.facts).toMatchObject({ availability: 'WL 22', chance: 39 });
  });

  it('shows Tatkal next to the General quota once it is open', () => {
    const options = trains.extract(load('csmt-mao', 'CSMT', 'MAO', '2026-10-08', '08102026'));
    expect(options).toHaveLength(60);
    const mandovi = options.find((o) => o.title === 'Mandovi Express 10103' && o.facts.class_code === '3A')!;
    expect(mandovi).toMatchObject({
      priceMinor: 113_000,
      highlights: ['AC 3 Tier', 'RAC 10', 'Tatkal: Available 86, ₹1,460'],
      facts: { availability: 'RAC 10', tatkal_availability: 'Available 86', tatkal_fare_minor: 146_000, duration_min: 885 },
    });
    // A train that boards at another Mumbai station says so.
    expect(options.find((o) => o.journey?.number === '22115')!.journey).toMatchObject({ origin: { code: 'LTT' }, destination: { code: 'KRMI' } });
  });

  it('still shows the trains and their fares when the availability call did not come back', () => {
    const options = trains.extract(load('ndls-mao', 'NDLS', 'MAO', '2026-11-06', '06112026', false));
    expect(options).toHaveLength(25);
    expect(options[0]).toMatchObject({ priceMinor: 311_500, highlights: ['AC 2 Tier', '29 h 10 m'] });
    expect(options[0]!.facts).not.toHaveProperty('availability');
  });

  it('leaves out a train it cannot read, reads null details as missing, and refuses only when no train reads', () => {
    const between = edited('between', (d) => {
      const [first, second] = d.trainsBetweenStations;
      first.boardStation = null;
      first.suspended = null;
      first.attributes.bookable = null;
      second.attributes.departTime = '--';
    });
    const options = trains.extract(ndlsLoad(between, fixture('trains-ndls-mao-availability.json')));
    // 12618's four classes are left out; 22656 still shows, from its station code.
    expect(options).toHaveLength(21);
    expect(options.some((o) => o.journey?.number === '12618')).toBe(false);
    expect(options[0]!.journey?.origin).toEqual({ name: 'NZM', code: 'NZM' });
    const none = edited('between', (d) => {
      for (const t of d.trainsBetweenStations) t.attributes.departTime = '--';
    });
    expect(() => trains.extract(ndlsLoad(none, fixture('trains-ndls-mao-availability.json')))).toThrow(/shape Go does not read/);
  });

  it('keeps every train when the seat list has parts it cannot read, or comes in another shape', () => {
    const between = fixture('trains-ndls-mao-between.json');
    const seats = edited('availability', (d) => {
      d.routesData[0].availabilities[0].f = null;
      d.routesData[1].availabilities = 'none';
    });
    const options = trains.extract(ndlsLoad(between, seats));
    expect(options).toHaveLength(25);
    // 22414's 1A seat has no fare: its base fare shows, with its status.
    expect(options.find((o) => o.journey?.number === '22414' && o.facts.class_code === '1A')!.facts).toHaveProperty('availability');
    const other = trains.extract(ndlsLoad(between, '{"data":{"routes":[]}}'));
    expect(other).toHaveLength(25);
    expect(other[0]!.facts).not.toHaveProperty('availability');
  });

  it('refuses when the train list never came back', () => {
    expect(() => trains.extract([])).toThrow(/did not load its trains/);
  });

  it('reads the trains, classes, fares and statuses from the page text, for the fallback runner', () => {
    const rows = readTrainsPage(fixture('trains-ndls-mao.txt'));
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({
      number: '22656', name: 'NZM ERS SF EXP', from: 'NZM', depart: '05:00', depart_day: 'Fri, 6 Nov', to: 'MAO', arrive: '10:10', arrive_day: 'Sat, 7 Nov',
      classes: [
        { c: 'SL', fare: 865, status: 'WL42', chance: null },
        { c: '3E', fare: 2075, status: 'WL40', chance: null },
        { c: '3A', fare: 2185, status: 'WL55', chance: null },
        { c: '2A', fare: 3115, status: 'WL26', chance: null },
      ],
    });
    const options = trains.fromAgent(rows, ndls);
    expect(options).toHaveLength(22);
    expect(options.find((o) => o.title === 'Sampark Kranthi 12218' && o.facts.class_code === '3E')).toMatchObject({
      priceMinor: 209_000,
      highlights: ['AC 3 Economy', 'WL 22', '39% chance to confirm', '28 h'],
      journey: { origin: { code: 'NDLS' }, depart_at: '2026-11-06T13:10:00+05:30', arrive_at: '2026-11-07T17:10:00+05:30' },
    });
    expect(options.find((o) => o.title === 'GOA Express 12780')!.journey?.arrive_at).toBe('2026-11-08T05:40:00+05:30');
  });

  it('leaves out a page row that does not check out and keeps the rest', () => {
    const rows = readTrainsPage(fixture('trains-ndls-mao.txt'));
    expect(trains.fromAgent([{ number: '22656', name: 'X', classes: [] }, ...rows], ndls)).toHaveLength(22);
  });

  it('refuses page rows that do not check out', () => {
    expect(() => trains.fromAgent([{ number: '22656', name: 'X', classes: [] }], ndls)).toThrow(/did not check out/);
  });
});
