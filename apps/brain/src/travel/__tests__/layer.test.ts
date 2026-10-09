import { describe, expect, it, vi } from 'vitest';
import { FakeClock, FakeSwitches } from '../../tasks/testing/lane-brain.js';
import { FakeIxigoStore } from '../fake-ixigo/data.js';
import { createTravelLayer, type TravelLayerDeps } from '../layer.js';
import { createFakeTravel, TravelError } from '../mcp-travel.js';
import type { TravelBackend, TravelOption, TravelQuery } from '../travel.js';

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

  it("shares a search while it runs, so the composer's call joins the early start's; one that fails is not kept", async () => {
    let release!: () => void;
    let fail = true;
    const calls: string[] = [];
    const slow: TravelBackend = {
      ...backend('fake', new FakeClock(0)).b,
      async search(kind) {
        calls.push(kind);
        if (fail) throw new TravelError('unreachable', 'the fake is down');
        await new Promise<void>((r) => { release = r; });
        return { checkedAt: '2026-10-07T12:00:00.000Z', results: [opt('fake:a', '17:50'), opt('fake:b', '18:10')] };
      },
    };
    const { layer } = setup(true, { fake: slow });
    const q = { from: 'Delhi', to: 'Goa', date: '2026-11-06' };
    await expect(layer.search('flights', q)).rejects.toMatchObject({ code: 'unreachable' });
    fail = false;
    const early = layer.search('flights', q);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    const joined = layer.search('flights', { ...q, departAfter: '18:00' });
    // The second call reaches the layer while the first still runs.
    await new Promise((r) => setTimeout(r, 0));
    release();
    expect((await early).results).toHaveLength(2);
    expect((await joined).results.map((o) => o.offerId)).toEqual(['fake:b']);
    expect(calls).toHaveLength(2);
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

describe('ixigo.com through the recipes (TRAVEL_MODE ixigo_web)', () => {
  const Q = { from: 'Delhi', to: 'Goa', date: '2026-11-06' };
  const PAGE = 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026';
  function web() {
    const calls: Array<{ kind: string; tripId: string | undefined }> = [];
    const queries: TravelQuery[] = [];
    const refused = async (): Promise<never> => {
      throw new TravelError('refused', 'Booked on ixigo.');
    };
    const b: TravelBackend = {
      async search(kind, q, o) {
        calls.push({ kind, tripId: o?.tripId });
        queries.push(q);
        return {
          checkedAt: '2026-10-07T12:00:00.000Z',
          results: [{
            kind: 'flight', title: 'IndiGo 6E 5341', priceMinor: 789600, currency: 'INR', priceNote: 'per person', highlights: [], facts: {}, sourceUrl: PAGE,
            journey: { mode: 'flight', origin: { name: 'New Delhi (DEL)' }, destination: { name: 'Goa (GOI)' }, depart_at: '2026-11-06T05:00:00+05:30', arrive_at: '2026-11-06T07:35:00+05:30' },
          }],
        };
      },
      status: refused,
      hold: refused,
      confirm: refused,
    };
    return { b, calls, queries };
  }

  it("lets ixigo_web see non-stop and ixigo's own filters, since its page takes them itself; the other conditions stay in code", async () => {
    const ixigoWeb = web();
    const { switches, layer } = setup(true, { ixigoWeb: ixigoWeb.b });
    await switches.set('TRAVEL_MODE', 'ixigo_web');
    await layer.search('stays', { area: 'Vagator', checkIn: '2026-11-06', checkOut: '2026-11-09', siteFilters: ['Swimming Pool'], maxPriceMinor: 800000 }, { tripId: 't_goa' });
    await layer.search('flights', { ...Q, nonStop: true, departAfter: '06:00' }, { tripId: 't_goa' });
    expect(ixigoWeb.queries).toEqual([
      { area: 'Vagator', checkIn: '2026-11-06', checkOut: '2026-11-09', siteFilters: ['Swimming Pool'] },
      { ...Q, nonStop: true },
    ]);
  });

  it('passes on the filters ixigo left off (unapplied), for the model to pick on: Go drops no stay for them', async () => {
    const stay = (title: string, pool: boolean, priceMinor = 500_000): TravelOption => ({
      kind: 'stay', title, priceMinor, currency: 'INR', priceNote: 'per night, per room', highlights: [], facts: { pool, area: 'Anjuna' }, rating: 4.5,
      sourceUrl: `https://www.ixigo.com/hotels/1/details?hName=${encodeURIComponent(title)}`,
    });
    const refused = async (): Promise<never> => {
      throw new TravelError('refused', 'Booked on ixigo.');
    };
    const list = [stay('Casa Azul', false), stay('Villa Sol', true), stay('Grand Palace', false, 2_000_000)];
    const b: TravelBackend = {
      search: async () => ({ checkedAt: '2026-10-07T12:00:00.000Z', results: list, unapplied: ['Swimming Pool'] }),
      status: refused,
      hold: refused,
      confirm: refused,
    };
    const { switches, layer } = setup(true, { ixigoWeb: b });
    await switches.set('TRAVEL_MODE', 'ixigo_web');
    const found = await layer.search('stays', { area: 'Goa', checkIn: '2026-11-06', checkOut: '2026-11-09', guests: 5, siteFilters: ['Swimming Pool'], maxPriceMinor: 1_000_000 }, { tripId: 't_goa' });
    // Go's own conditions still hold: a stay over the price is never shown.
    expect(found.results.map((o) => o.title)).toEqual(['Casa Azul', 'Villa Sol']);
    expect(found).toMatchObject({ unapplied: ['Swimming Pool'], found: 3 });
  });

  it("hands ixigo_web the site's own filters and sort, keeps the site's order when it sorted, and passes on what the site did", async () => {
    const stay = (title: string, rating: number, priceMinor: number): TravelOption => ({
      kind: 'stay', title, priceMinor, currency: 'INR', priceNote: 'per night, per room', highlights: [], facts: {}, rating,
      sourceUrl: `https://www.ixigo.com/hotels/1/details?hName=${encodeURIComponent(title)}`,
    });
    const queries: TravelQuery[] = [];
    const refused = async (): Promise<never> => {
      throw new TravelError('refused', 'Booked on ixigo.');
    };
    const site = { filtered: ['Pet-friendly property'], sorted: 'Price (Low to High)', unknown: ['beachfront'], listed: true, offers: 'Facilities: Pet-friendly property' };
    const b: TravelBackend = {
      search: async (_kind, q) => {
        queries.push(q);
        return { checkedAt: '2026-10-07T12:00:00.000Z', results: [stay('Cheap', 3.9, 90_000), stay('Dear', 4.8, 900_000)], site, unapplied: ['beachfront'] };
      },
      status: refused,
      hold: refused,
      confirm: refused,
    };
    const { switches, layer } = setup(true, { ixigoWeb: b });
    await switches.set('TRAVEL_MODE', 'ixigo_web');
    const ask = { area: 'Anjuna', checkIn: '2026-11-06', checkOut: '2026-11-09', siteFilters: ['Pet-friendly property', 'beachfront'], siteSort: 'Price (Low to High)', wants: ['quiet'] };
    const found = await layer.search('stays', ask, { tripId: 't_goa' });
    expect(queries).toEqual([{ area: 'Anjuna', checkIn: '2026-11-06', checkOut: '2026-11-09', siteFilters: ['Pet-friendly property', 'beachfront'], siteSort: 'Price (Low to High)' }]);
    // ixigo's cheapest first, not Go's best rated first.
    expect(found.results.map((o) => o.title)).toEqual(['Cheap', 'Dear']);
    expect(found).toMatchObject({ site, unapplied: ['beachfront'] });
  });

  it("searches in the trip's own browser: the trip goes with every search (ixigo_web keeps its own), and nothing is simulated", async () => {
    const ixigoWeb = web();
    const { switches, layer, fake } = setup(true, { ixigoWeb: ixigoWeb.b });
    await switches.set('TRAVEL_MODE', 'ixigo_web');
    const found = await layer.search('flights', Q, { tripId: 't_goa' });
    const late = await layer.search('flights', { ...Q, departAfter: '06:00' }, { tripId: 't_goa' });
    await layer.search('flights', Q, { tripId: 't_other' });
    expect(ixigoWeb.calls).toEqual([{ kind: 'flights', tripId: 't_goa' }, { kind: 'flights', tripId: 't_goa' }, { kind: 'flights', tripId: 't_other' }]);
    // The constraints still apply in code to what came back.
    expect(late.results).toEqual([]);
    expect(late.found).toBe(1);
    expect(found.results[0]).not.toHaveProperty('offerId');
    expect(found.results[0]!.sourceUrl).toBe(PAGE);
    expect(layer.simulated?.()).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  it('stays on the fake, and says so, when ixigo_web is not set up here', async () => {
    const { switches, layer, fake } = setup();
    await switches.set('TRAVEL_MODE', 'ixigo_web');
    expect((await layer.search('flights', Q, { tripId: 't_goa' })).results[0]!.offerId).toBe('fake:a');
    expect(fake.calls).toHaveLength(1);
    expect(layer.simulated?.()).toBe(true);
  });

  it("reads status from ixigo's MCP server when it is set up, and never from the fake, whose readings are simulated", async () => {
    const q = { kind: 'pnr' as const, pnr: '1234567890' };
    const withIxigo = setup(true, { ixigoWeb: web().b });
    await withIxigo.switches.set('TRAVEL_MODE', 'ixigo_web');
    expect(await withIxigo.layer.status(q)).toMatchObject({ detail: 'ixigo' });
    const alone = setup(false, { ixigoWeb: web().b });
    await alone.switches.set('TRAVEL_MODE', 'ixigo_web');
    await expect(alone.layer.status(q)).rejects.toMatchObject({ code: 'refused' });
  });

  it("answers offer() with the option's own ixigo.com page as its link, so the group can book it there, and no other page", async () => {
    const { layer } = setup(true, {
      results: {
        offer: async (id) => ({
          tripId: 't_goa', cardId: 'c', resultsId: 'r', checkedAt: 'x', optionId: id, n: 1, offerId: null, kind: 'flight', title: 'IndiGo 6E 5341',
          priceMinor: 789600, totalMinor: null, currency: 'INR', priceNote: 'per person', sourceUrl: id === 'opt_ix' ? PAGE : 'https://fares.example/6e5341',
        }),
      },
    });
    expect(await layer.offer('opt_ix')).toEqual({ offerId: null, title: 'IndiGo 6E 5341', priceMinor: 789600, currency: 'INR', kind: 'flight', link: PAGE });
    expect((await layer.offer('opt_web'))?.link).toBeNull();
  });

  it("gives a stay from ixigo.com Go's web-stay offer, and sends its hold, confirm and prepare to the web stays (travel/web-stays.ts)", async () => {
    const STAY = 'https://www.ixigo.com/hotels/54381/details?checkinDate=06112026&checkoutDate=09112026&roomCount=3';
    const calls: string[] = [];
    const webStays: NonNullable<TravelLayerDeps['webStays']> = {
      offerIdFor: (o) => (o.sourceUrl === STAY && !o.offerId ? `webstay:${o.optionId}` : null),
      prepare: async () => ({ ok: true, priceMinor: 4768200 }),
      hold: async (offerId) => {
        calls.push(`hold ${offerId}`);
        return { holdId: `${offerId}:1`, amountMinor: 4768200, currency: 'INR', merchant: 'ixigo (simulated): Saudades', expiresAt: 'x', payment: { kind: 'fake' } };
      },
      confirm: async (holdId) => {
        calls.push(`confirm ${holdId}`);
        return { ref: 'SIM-1', vendor: 'ixigo (simulated)', title: 'Saudades', kind: 'stay', simulated: true };
      },
    };
    const { layer, fake } = setup(true, {
      webStays,
      results: {
        offer: async (id) => ({
          tripId: 't_goa', cardId: 'c', resultsId: 'r', checkedAt: 'x', optionId: id, n: 1, offerId: null, kind: 'stay', title: 'Saudades Homestays',
          priceMinor: 1589400, totalMinor: 4768200, currency: 'INR', priceNote: 'per night, per room', sourceUrl: id === 'opt_sau' ? STAY : 'https://villa.example/book',
        }),
      },
    });
    expect(await layer.offer('opt_sau')).toMatchObject({ offerId: 'webstay:opt_sau', priceMinor: 4768200, kind: 'stay' });
    // A stay a job found on another site stays unbookable.
    expect(await layer.offer('opt_other')).toMatchObject({ offerId: null });
    await layer.hold('webstay:opt_sau', { name: 'Rahul', personIds: ['p_rahul'] });
    await layer.confirm('webstay:opt_sau:1', { approvalId: 'ap_1', railRef: 'fake_1' });
    expect(calls).toEqual(['hold webstay:opt_sau', 'confirm webstay:opt_sau:1']);
    expect(fake.calls).toEqual([]);
    expect(layer.prepare).toBe(webStays.prepare);
    // With no web stays (a test, a lane that never set it), nothing changes.
    expect(setup().layer.prepare).toBeUndefined();
  });

  it('says the day an offer is for, and past once that day is behind the trip: a vote that outlived it cannot book the past', async () => {
    const page = (day: string) => `https://www.ixigo.com/hotels/54381/details?checkinDate=${day}&checkoutDate=09112026&roomCount=3`;
    const { layer } = setup(true, {
      today: async () => '2026-10-08',
      results: {
        offer: async (id) => ({
          tripId: 't_goa', cardId: 'c', resultsId: 'r', checkedAt: 'x', optionId: id, n: 1, offerId: id === 'opt_fake' ? 'fake:st' : null, kind: 'stay', title: 'Saudades',
          priceMinor: 1589400, totalMinor: 4768200, currency: 'INR', priceNote: 'per night, per room', sourceUrl: id === 'opt_old' ? page('01102026') : page('06112026'),
        }),
        searchedFor: async () => ({ tripId: 't_goa', day: '2026-10-02' }),
      },
    });
    expect(await layer.offer('opt_new')).toMatchObject({ day: '2026-11-06' });
    expect(await layer.offer('opt_new')).not.toHaveProperty('past');
    expect(await layer.offer('opt_old')).toMatchObject({ day: '2026-10-01', past: true });
    // An offer of Go's own search: the day that search asked for.
    expect(await layer.offer('opt_fake')).toMatchObject({ day: '2026-10-02', past: true });
  });
});
