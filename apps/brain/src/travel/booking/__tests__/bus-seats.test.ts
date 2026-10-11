import { describe, expect, it } from 'vitest';
import { fixture } from '../../recipes/__tests__/fixtures.js';
import { busLayout, choosePoint, chooseSeats, seatWords, type BusLayout } from '../bus-seats.js';

// p5's drill, 11 Oct: IntrCity SmartBus 22:35, Bengaluru to Goa on 6 Nov, a Bharat Benz AC Sleeper (2 + 1), its seat
// layout as "Select Seats" opened it (POST /wap/GetSeatLayout), trimmed, phone numbers out of its points' names.
const BODY = JSON.parse(fixture('bus-seat-layout-blr-goa.json')) as Record<string, unknown>;
const layout = (): BusLayout => busLayout(BODY)!;
const nos = (l: BusLayout, ask: Parameters<typeof chooseSeats>[1], taken?: string[], mates?: string[]) => chooseSeats(l, ask, taken, mates)?.map((s) => s.no) ?? null;

describe("a bus's seat layout", () => {
  it('reads every seat by its titles: deck, row and column, berth, free, its fare, and by a window or the aisle', () => {
    const l = layout();
    expect(l).toMatchObject({ operator: 'IntrCity SmartBus', departs: '2026-11-06 22:35', busType: 'Bharat Benz AC Sleeper (2 + 1)', maxSeats: 6 });
    expect(l.seats).toHaveLength(35);
    expect(l.seats[0]).toEqual({ no: '1LC', deck: 'lower', row: 1, col: 1, type: 'LB', sleeper: true, free: true, ladies: false, fareMinor: 476500, window: true, aisle: false, side: -1 });
    // The gangway is row 3: rows 1 and 4 are by a window (row 4 the single berths), row 2 is the aisle.
    expect([...new Set(l.seats.filter((s) => s.window).map((s) => s.row))].sort()).toEqual([1, 4]);
    expect([...new Set(l.seats.filter((s) => s.aisle).map((s) => s.row))]).toEqual([2]);
  });

  it('reads its boarding and dropping points with no phone number in their names', () => {
    const l = layout();
    expect(l.boarding).toHaveLength(18);
    expect(l.dropping).toHaveLength(6);
    expect(l.boarding[0]).toEqual({ id: '14531', name: 'Chandapura - Infront of Adyar Anand Bhavan A2B, Near Nandhana Palace, Hosur Road, Towards Silk board', time: '07:45 PM' });
    expect(JSON.stringify(l.boarding)).not.toMatch(/\d{8,}/);
  });

  it('is null for anything that is no layout', () => {
    expect(busLayout(null)).toBeNull();
    expect(busLayout({ status: 'failed' })).toBeNull();
  });
});

describe('the seats Go books, chosen in code', () => {
  it("one person, no ask: the cheapest free seat (the bus's price they picked), by a window first", () => {
    expect(nos(layout(), { count: 1 })).toEqual(['6LC']);
  });

  it('their ask first: an upper or lower berth, an aisle', () => {
    expect(nos(layout(), { count: 1, berth: 'upper' })).toEqual(['6UC']);
    expect(nos(layout(), { count: 1, berth: 'lower' })).toEqual(['6LC']);
    expect(nos(layout(), { count: 1, side: 'aisle' })).toEqual(['6LB']);
  });

  it('several people sit together, side by side on one side of the gangway, then the best of the rest', () => {
    expect(nos(layout(), { count: 2 })).toEqual(['6LC', '6LB']);
    expect(nos(layout(), { count: 3 })).toEqual(['6LC', '6LB', '6UC']);
  });

  it("beside the trip's people already on this bus when a seat there is free; their ask still comes first", () => {
    expect(nos(layout(), { count: 1 }, ['6LC'], ['6LC'])).toEqual(['6LB']);
    expect(nos(layout(), { count: 1, berth: 'upper' }, ['6LC'], ['6LC'])).toEqual(['6UC']);
  });

  it("never a seat another booking of the trip took on this bus, a booked seat, or a ladies seat a man would take", () => {
    expect(nos(layout(), { count: 1 }, ['6LC'])).toEqual(['6UC']);
    const lines = (BODY['TotalSeatList'] as Record<string, string[]>)['lowerdeck_seat_nos']!;
    const ladies = lines.map((line) => (line.startsWith('6LC,') ? line.replace(', Y, M,', ', Y, F,') : line.startsWith('6UC,') ? line : line));
    const booked = (BODY['TotalSeatList'] as Record<string, string[]>)['upperdeck_seat_nos']!.map((line) => (line.startsWith('6UC,') ? line.replace(', Y, M,', ', N, M,') : line));
    const l = busLayout({ ...BODY, TotalSeatList: { lowerdeck_seat_nos: ladies, upperdeck_seat_nos: booked } })!;
    expect(l.seats.find((s) => s.no === '6LC')).toMatchObject({ ladies: true });
    expect(nos(l, { count: 1 })).toEqual(['6LB']);
    expect(nos(l, { count: 1, women: true })).toEqual(['6LC']);
  });

  it('is null when the bus has not that many free, and takes at most its own limit', () => {
    const all = layout().seats.map((s) => s.no);
    expect(nos(layout(), { count: 1 }, all)).toBeNull();
    expect(chooseSeats(layout(), { count: 9 })).toHaveLength(6);
  });
});

describe('boarding and dropping', () => {
  it("the first point whose name holds a place the person is near, else ixigo's first", () => {
    const l = layout();
    expect(choosePoint(l.boarding, ['Bommasandra'])?.name).toMatch(/^Bommasandra/);
    expect(choosePoint(l.boarding, [])?.id).toBe('14531');
    expect(choosePoint(l.dropping, ['Paris'])?.id).toBe('6691');
    expect(choosePoint([], ['x'])).toBeNull();
  });

  it('says the seats and points in one clause', () => {
    const l = layout();
    expect(seatWords(chooseSeats(l, { count: 1 })!, l.boarding[0]!, l.dropping[0]!))
      .toBe('seat 6LC (lower berth by the window), boarding at Chandapura 07:45 PM, getting off at Mollem (Dhoodhsagar)');
  });
});
