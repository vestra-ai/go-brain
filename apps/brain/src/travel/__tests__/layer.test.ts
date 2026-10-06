import { describe, expect, it } from 'vitest';
import { FakeClock, FakeSwitches } from '../../tasks/testing/lane-brain.js';
import { FakeIxigoStore } from '../fake-ixigo/data.js';
import { createTravelLayer, type TravelLayerDeps } from '../layer.js';
import { createFakeTravel, TravelError } from '../mcp-travel.js';
import type { TravelBackend, TravelOption } from '../travel.js';

const opt = (offerId: string, clock: string): TravelOption => ({
  offerId, kind: 'flight', title: offerId, priceMinor: 500000, currency: 'INR', priceNote: 'per person', highlights: [], facts: {},
  journey: { mode: 'flight', origin: { name: 'Delhi' }, destination: { name: 'Goa' }, depart_at: `2026-11-06T${clock}:00+05:30`, arrive_at: `2026-11-06T23:00:00+05:30` },
});

function backend(name: 'fake' | 'ixigo', clock: FakeClock) {
  const calls: string[] = [];
  const b: TravelBackend = {
    async search(kind, q) {
      calls.push(`${kind} ${JSON.stringify(q)}`);
      return { checkedAt: clock.now().toISOString(), results: [opt(`${name}:a`, '17:50'), opt(`${name}:b`, '18:10')] };
    },
    async status() {
      return { kind: 'pnr', state: 'confirmed', detail: name, checkedAt: clock.now().toISOString() };
    },
    async hold() {
      calls.push('hold');
      return { holdId: `${name}:h1`, amountMinor: 100, currency: 'INR', merchant: name, expiresAt: clock.now().toISOString(), payment: { kind: 'fake' } };
    },
    async confirm() {
      calls.push('confirm');
      return { ref: `${name}-ref`, vendor: name, title: 't', kind: 'flight' };
    },
  };
  return { b, calls };
}

function setup(withIxigo = true, extra: Partial<TravelLayerDeps> = {}) {
  const clock = new FakeClock(Date.parse('2026-10-07T12:00:00Z'));
  const switches = new FakeSwitches();
  const fake = backend('fake', clock);
  const ixigo = backend('ixigo', clock);
  const delays: string[] = [];
  const layer = createTravelLayer({
    switches, now: clock.now, fake: fake.b, ixigo: withIxigo ? ixigo.b : null,
    results: {
      offer: async (id) => {
        const base = { tripId: 't_goa', cardId: 'c', resultsId: 'r', checkedAt: 'x' };
        if (id === 'opt_1') return { ...base, optionId: 'opt_1', n: 1, offerId: 'fake:a', kind: 'flight', title: 'a', priceMinor: 1, totalMinor: null, currency: 'INR', priceNote: 'per person' };
        if (id === 'opt_3') return { ...base, optionId: 'opt_3', n: 3, offerId: 'fake:st', kind: 'stay', title: 'Villa Sol', priceMinor: 1280000, totalMinor: 3840000, currency: 'INR', priceNote: 'per night' };
        if (id === 'opt_web') return { ...base, optionId: 'opt_web', n: 1, offerId: null, kind: 'stay', title: 'Casa Web', priceMinor: null, totalMinor: null, currency: null, priceNote: null };
        return null;
      },
    },
    simulate: { setFlightDelay: (c, n, d, m) => { delays.push(`${c}${n}@${d}+${m}`); } },
    ...extra,
  });
  return { clock, switches, fake, ixigo, layer, delays };
}

describe('the travel layer', () => {
  it('caches a search for three minutes and applies constraints to the cached answer', async () => {
    const { clock, fake, layer } = setup();
    const all = await layer.search('flights', { from: 'Delhi', to: 'Goa', date: '2026-11-06' });
    const late = await layer.search('flights', { from: 'delhi ', to: 'Goa', date: '2026-11-06', departAfter: '18:00' });
    expect(all.results).toHaveLength(2);
    expect(late.results.map((o) => o.offerId)).toEqual(['fake:b']);
    expect(late.checkedAt).toBe(all.checkedAt);
    expect(fake.calls).toHaveLength(1);
    clock.advance(181_000);
    const fresh = await layer.search('flights', { from: 'Delhi', to: 'Goa', date: '2026-11-06' });
    expect(fake.calls).toHaveLength(2);
    expect(fresh.checkedAt).not.toBe(all.checkedAt);
  });

  it('picks the backend on every call from TRAVEL_MODE, and stays on the fake when ixigo is not set up', async () => {
    const a = setup();
    await a.switches.set('TRAVEL_MODE', 'ixigo');
    expect((await a.layer.search('flights', { from: 'Delhi', to: 'Goa', date: '2026-11-06' })).results[0]!.offerId).toBe('ixigo:a');
    await a.switches.set('TRAVEL_MODE', 'fake');
    expect((await a.layer.search('flights', { from: 'Delhi', to: 'Goa', date: '2026-11-06' })).results[0]!.offerId).toBe('fake:a');
    const b = setup(false);
    await b.switches.set('TRAVEL_MODE', 'ixigo');
    expect((await b.layer.search('flights', { from: 'Delhi', to: 'Goa', date: '2026-11-06' })).results[0]!.offerId).toBe('fake:a');
  });

  it('says its listings are simulated exactly when its searches go to the fake', async () => {
    const a = setup();
    await a.switches.set('TRAVEL_MODE', 'ixigo');
    expect(a.layer.simulated?.()).toBe(false);
    await a.switches.set('TRAVEL_MODE', 'fake');
    expect(a.layer.simulated?.()).toBe(true);
    const b = setup(false);
    await b.switches.set('TRAVEL_MODE', 'ixigo');
    expect(b.layer.simulated?.()).toBe(true);
  });

  it('routes a hold and a confirm to the backend that made the offer, whatever the switch says now', async () => {
    const { layer, ixigo, switches } = setup();
    await switches.set('TRAVEL_MODE', 'fake');
    expect((await layer.hold('ixigo:a', { name: 'Rahul', personIds: ['p_rahul'] })).holdId).toBe('ixigo:h1');
    expect((await layer.confirm('ixigo:h1', { approvalId: 'ap_1', railRef: 'r' })).ref).toBe('ixigo-ref');
    expect(ixigo.calls).toEqual(['hold', 'confirm']);
    await expect(layer.hold('other:a', { name: 'Rahul', personIds: ['p_rahul'] })).rejects.toMatchObject({ code: 'unknown_offer' });
  });

  it("answers offer() from the stored offers in the master's shape, a stay at its whole-stay price, and passes the simulate switch through", async () => {
    const { layer, delays } = setup();
    expect(await layer.offer('opt_1')).toMatchObject({ offerId: 'fake:a', title: 'a', priceMinor: 1, currency: 'INR', link: null });
    expect(await layer.offer('opt_3')).toEqual({ offerId: 'fake:st', title: 'Villa Sol', priceMinor: 3840000, currency: 'INR', kind: 'stay', link: null });
    expect(await layer.offer('opt_web')).toMatchObject({ offerId: null, title: 'Casa Web', priceMinor: null, currency: null, link: null });
    expect(await layer.offer('opt_2')).toBeNull();
    layer.simulate?.setFlightDelay('6E', '2134', '2026-11-06', 120);
    expect(delays).toEqual(['6E2134@2026-11-06+120']);
  });
});

describe('dates in the past', () => {
  // The clock reads 2026-10-07 12:00 UTC: 5:30 pm on 7 Oct in India, the default trip zone.
  const STAY = { area: 'North Goa', checkOut: '2026-11-09', guests: 5 };

  it('refuses a past check-in or departure before any backend sees it, naming the date to use; that date goes through', async () => {
    const { fake, layer } = setup();
    const past = layer.search('stays', { ...STAY, checkIn: '2025-11-06', checkOut: '2025-11-09' });
    await expect(past).rejects.toBeInstanceOf(TravelError);
    await expect(past).rejects.toMatchObject({ code: 'past_date', message: expect.stringContaining('such as 2026-11-06') });
    await expect(layer.search('flights', { from: 'Delhi', to: 'Goa', date: '2026-10-06' })).rejects.toMatchObject({ code: 'past_date', message: expect.stringContaining('such as 2027-10-06') });
    expect(fake.calls).toEqual([]);
    await layer.search('stays', { ...STAY, checkIn: '2026-11-06' });
    await layer.search('flights', { from: 'Delhi', to: 'Goa', date: '2026-10-07' });
    expect(fake.calls).toHaveLength(2);
  });

  it("counts today in the trip's own time zone", async () => {
    const asked: Array<string | null> = [];
    const { layer } = setup(true, { today: async (tripId) => {
      asked.push(tripId);
      return tripId === 't_ahead' ? '2026-10-08' : '2026-10-07';
    } });
    await expect(layer.search('flights', { from: 'Delhi', to: 'Goa', date: '2026-10-07' }, { tripId: 't_ahead' })).rejects.toMatchObject({ code: 'past_date' });
    await layer.search('flights', { from: 'Delhi', to: 'Goa', date: '2026-10-07' }, { tripId: 't_goa' });
    expect(asked).toEqual(['t_ahead', 't_goa']);
  });

  it('refuses a hold on an offer searched for a day that has passed, and holds one still ahead', async () => {
    const days: Record<string, string> = { 'fake:old': '2026-10-01', 'fake:a': '2026-11-06' };
    const { fake, layer } = setup(true);
    const withDays = createTravelLayer({
      switches: new FakeSwitches(), now: () => new Date('2026-10-07T12:00:00Z'), fake: fake.b, ixigo: null,
      results: { offer: async () => null, searchedFor: async (offerId) => (days[offerId] ? { tripId: 't_goa', day: days[offerId]! } : null) },
    });
    await expect(withDays.hold('fake:old', { name: 'Priya', personIds: ['p_priya'] })).rejects.toMatchObject({ code: 'past_date', message: expect.stringContaining('2026-10-01') });
    expect(fake.calls).not.toContain('hold');
    expect(await withDays.hold('fake:a', { name: 'Priya', personIds: ['p_priya'] })).toMatchObject({ holdId: 'fake:h1' });
    expect(await layer.hold('fake:unknown', { name: 'Priya', personIds: ['p_priya'] })).toMatchObject({ holdId: 'fake:h1' });
  });

  it("still answers the fake ixigo's stays for dates ahead", async () => {
    const now = () => new Date('2026-10-07T12:00:00Z');
    const layer = createTravelLayer({
      switches: new FakeSwitches(), now, fake: createFakeTravel({ store: new FakeIxigoStore({ now }), now, payRail: () => 'fake' }), ixigo: null, results: { offer: async () => null },
    });
    for (const [checkIn, checkOut] of [['2026-11-06', '2026-11-09'], ['2027-01-15', '2027-01-18']] as const) {
      const found = await layer.search('stays', { area: 'North Goa', checkIn, checkOut, guests: 5 });
      expect(found.results.map((o) => o.title), checkIn).toContain('Villa Sol');
    }
  });
});
