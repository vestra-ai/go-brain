import { describe, expect, it } from 'vitest';
import { FakeClock, FakeSwitches } from '../../tasks/testing/lane-brain.js';
import { createTravelLayer } from '../layer.js';
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

function setup(withIxigo = true) {
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
