import { describe, expect, it } from 'vitest';
import { FAKE_VENDOR, FakeIxigoStore, callFakeIxigo, findFare, searchFlights, searchStays } from '../data.js';

const NOW = new Date('2026-10-07T12:00:00Z');
const FRIDAY = '2026-11-06';

describe('flights', () => {
  it('has Friday Delhi to Goa flights before and after 6 pm, sorted by time, priced in paise with local times', () => {
    const { flights } = searchFlights({ origin: 'Delhi', destination: 'Goa', date: FRIDAY });
    expect(flights).toHaveLength(10);
    expect(flights.map((f) => f.depart_at)).toEqual([...flights.map((f) => f.depart_at)].sort());
    const times = flights.map((f) => f.depart_at.slice(11, 16));
    expect(times).toContain('17:50');
    expect(times).toContain('18:10');
    expect(times.some((t) => t < '18:00') && times.some((t) => t >= '18:00')).toBe(true);
    for (const f of flights) {
      expect(Number.isInteger(f.fare_paise)).toBe(true);
      expect(f.depart_at.endsWith('+05:30')).toBe(true);
    }
    const sixE = flights.find((f) => f.flight_no === '2134')!;
    expect(sixE).toMatchObject({ fare_id: 'fl-DEL-GOI-20261106-6E2134', airline: 'IndiGo', fare_paise: 592000, arrive_at: '2026-11-06T20:45:00+05:30', duration_min: 155 });
  });

  it('is the same on every call and has nothing for a route it does not fly', () => {
    expect(searchFlights({ origin: 'DEL', destination: 'GOX', date: FRIDAY })).toEqual(searchFlights({ origin: 'delhi', destination: 'North Goa', date: FRIDAY }));
    expect(searchFlights({ origin: 'Delhi', destination: 'Paris', date: FRIDAY }).flights).toEqual([]);
  });
});

describe('stays', () => {
  it('has North Goa villas for 3 nights with whole-stay totals, pools, beach minutes and https images, and leaves out ones too small', () => {
    const r = searchStays({ location: 'North Goa', check_in: FRIDAY, check_out: '2026-11-09', guests: 5 });
    if ('error' in r) throw new Error(r.error);
    expect(r.stays.length).toBeGreaterThanOrEqual(6);
    for (const s of r.stays) {
      expect(s.region).toBe('North Goa');
      expect(s.nights).toBe(3);
      expect(s.total_paise).toBe(s.price_per_night_paise * 3);
      expect(s.image_url).toMatch(/^https:\/\//);
      expect(s.sleeps).toBeGreaterThanOrEqual(5);
    }
    expect(r.stays.find((s) => s.name === 'Villa Sol')).toMatchObject({ area: 'Anjuna', private_pool: true, beach_minutes: 8, price_per_night_paise: 1280000 });
    expect(r.stays.some((s) => s.name === 'Villa Coco')).toBe(false);
  });

  it('refuses dates that make no stay', () => {
    expect(searchStays({ location: 'Goa', check_in: '2026-11-09', check_out: FRIDAY })).toEqual({ error: 'invalid_dates' });
  });
});

describe('the store: status, holds and bookings', () => {
  it('reports a flight on schedule, then late after setDelay', () => {
    const store = new FakeIxigoStore({ now: () => NOW });
    expect(store.flightStatus({ airline_code: '6E', flight_no: '2134', date: FRIDAY })).toMatchObject({ status: 'scheduled', delay_min: 0 });
    store.setDelay('6e', '2134', FRIDAY, 120);
    expect(store.flightStatus({ airline_code: '6E', flight_no: '2134', date: FRIDAY })).toMatchObject({
      status: 'delayed', delay_min: 120, scheduled_departure: '2026-11-06T18:10:00+05:30', estimated_departure: '2026-11-06T20:10:00+05:30',
    });
  });

  it('holds a fare for the travellers, confirms it once, and finds it by reference', () => {
    let now = NOW;
    const store = new FakeIxigoStore({ now: () => now });
    const hold = store.hold({ fare_id: 'fl-DEL-GOI-20261106-6E2134', lead_name: 'Rahul', travellers: 2 });
    if ('error' in hold) throw new Error(hold.error);
    expect(hold).toMatchObject({ amount_paise: 1184000, currency: 'INR', merchant: FAKE_VENDOR });
    const booking = store.confirm({ hold_id: hold.hold_id, payment_ref: 'fake_pay_1' });
    if ('error' in booking) throw new Error(booking.error);
    expect(booking).toMatchObject({ status: 'confirmed', kind: 'flight', title: 'IndiGo 6E 2134', vendor: FAKE_VENDOR, amount_paise: 1184000 });
    expect(booking.booking_ref).toMatch(/^IXG\d{6}$/);
    expect(booking.journey).toMatchObject({ mode: 'flight', from_code: 'DEL', to_code: 'GOI', number: '6E 2134' });
    expect(store.confirm({ hold_id: hold.hold_id, payment_ref: 'fake_pay_1' })).toEqual(booking);
    expect(store.pnr({ pnr: booking.booking_ref })).toMatchObject({ status: 'confirmed' });
    expect(store.cancel({ booking_ref: booking.booking_ref })).toMatchObject({ status: 'cancelled', refund_paise: 947200 });
    now = new Date(NOW.getTime() + 16 * 60_000);
    const late = store.hold({ fare_id: 'fl-DEL-GOI-20261106-6E2134', lead_name: 'Rahul', travellers: 1 });
    if ('error' in late) throw new Error(late.error);
    now = new Date(now.getTime() + 16 * 60_000);
    expect(store.confirm({ hold_id: late.hold_id, payment_ref: 'x' })).toEqual({ error: 'hold_expired' });
  });

  it('prices a stay hold as the whole stay, and finds a flight or a stay fare by its id', () => {
    const store = new FakeIxigoStore({ now: () => NOW });
    const hold = store.hold({ fare_id: 'st-villa-sol-anjuna-20261106-20261109-5', lead_name: 'Rahul', travellers: 5 });
    if ('error' in hold) throw new Error(hold.error);
    expect(hold.amount_paise).toBe(3840000);
    expect(findFare('fl-DEL-GOI-20261106-6E2134')).toMatchObject({ kind: 'flight', unitPaise: 592000 });
    expect(findFare('st-villa-sol-anjuna-20261106-20261109-5')).toMatchObject({ kind: 'stay', unitPaise: 3840000 });
    expect(findFare('fl-DEL-GOI-20261106-XX0000')).toBeNull();
    expect(findFare('tr-NZM-MAO-20261106-22414-3A')).toBeNull(); // trains arrive with Task 8b
  });

  it('says on the hold until when a refundable villa is free to cancel, and nothing for one that is not', () => {
    const store = new FakeIxigoStore({ now: () => NOW });
    const sol = store.hold({ fare_id: 'st-villa-sol-anjuna-20261106-20261109-5', lead_name: 'Rahul', travellers: 5 });
    if ('error' in sol) throw new Error(sol.error);
    expect(sol.refundable_until).toBe('2026-11-03T23:59:00+05:30');
    const azul = store.hold({ fare_id: 'st-casa-azul-assagao-20261106-20261109-5', lead_name: 'Rahul', travellers: 5 });
    if ('error' in azul) throw new Error(azul.error);
    expect(azul.refundable_until).toBeNull();
  });
});

describe('callFakeIxigo', () => {
  it('runs a tool by name, and answers bad arguments and unknown tools as tool errors', () => {
    const store = new FakeIxigoStore({ now: () => NOW });
    const ok = callFakeIxigo(store, 'search_flights', { origin: 'Delhi', destination: 'Goa', date: FRIDAY });
    expect(ok.isError).toBe(false);
    expect((ok.value as { flights: unknown[] }).flights).toHaveLength(10);
    expect(callFakeIxigo(store, 'search_flights', { origin: 'Delhi', destination: 'Goa', date: 'Friday' })).toMatchObject({ isError: true, value: { error: 'invalid_arguments' } });
    expect(callFakeIxigo(store, 'book_everything', {})).toEqual({ value: { error: 'unknown_tool' }, isError: true });
    expect(callFakeIxigo(store, 'confirm_booking', { hold_id: 'hold_nope', payment_ref: 'x' })).toEqual({ value: { error: 'hold_not_found' }, isError: true });
  });
});
