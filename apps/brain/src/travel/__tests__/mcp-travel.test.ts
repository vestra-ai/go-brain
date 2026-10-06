import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { FakeIxigoStore } from '../fake-ixigo/data.js';
import { registerFakeIxigoRoutes } from '../fake-ixigo/server.js';
import { DEFAULT_IXIGO_MAP, confirmedOf, type IxigoMap } from '../ixigo-map.js';
import { createInProcessCaller, type McpCaller } from '../mcp-caller.js';
import { TravelError, createFakeTravel, createIxigoTravel } from '../mcp-travel.js';

const NOW = new Date('2026-10-07T12:00:00Z');
const now = () => NOW;
const FRIDAY = '2026-11-06';
const SOL = 'st-villa-sol-anjuna-20261106-20261109-5';

describe('FakeTravel', () => {
  const store = new FakeIxigoStore({ now });
  let rail = 'fake';
  const fake = createFakeTravel({ store, now, payRail: () => rail });

  it('finds Friday flights from Delhi to Goa with offer ids, local times and paise', async () => {
    const r = await fake.search('flights', { from: 'Delhi', to: 'Goa', date: FRIDAY });
    expect(r.checkedAt).toBe(NOW.toISOString());
    expect(r.results).toHaveLength(10);
    const sixE = r.results.find((o) => o.title === 'IndiGo 6E 2134')!;
    expect(sixE).toMatchObject({ offerId: 'fake:fl-DEL-GOI-20261106-6E2134', kind: 'flight', priceMinor: 592000, currency: 'INR', priceNote: 'per person' });
    expect(sixE.journey).toMatchObject({ mode: 'flight', depart_at: '2026-11-06T18:10:00+05:30', number: '6E 2134', stops: 0, origin: { code: 'DEL' } });
    expect(sixE.highlights).toContain('Non-stop');
    expect(sixE.highlights.length).toBeLessThanOrEqual(4);
  });

  it('finds North Goa villas with nightly and whole-stay prices and the facts the filters read', async () => {
    const r = await fake.search('stays', { area: 'North Goa', checkIn: FRIDAY, checkOut: '2026-11-09', guests: 5 });
    const sol = r.results.find((o) => o.title === 'Villa Sol')!;
    expect(sol).toMatchObject({ kind: 'stay', priceMinor: 1280000, totalMinor: 3840000, priceNote: 'per night', rating: 4.7 });
    expect(sol.facts).toMatchObject({ pool: true, beach_minutes: 8, sleeps: 6, nights: 3, area: 'Anjuna' });
    expect(sol.place).toMatchObject({ name: 'Villa Sol', address: 'Anjuna, North Goa, Goa' });
    expect(sol.imageUrl).toMatch(/^https:\/\//);
  });

  it('says what a search is missing instead of searching', async () => {
    await expect(fake.search('stays', { area: 'North Goa' })).rejects.toMatchObject({ code: 'needs_more' });
    await expect(fake.search('flights', { from: 'Delhi', date: FRIDAY })).rejects.toBeInstanceOf(TravelError);
  });

  it('finds trains with one fare per class, and overnight buses, as journeys with offer ids', async () => {
    const trains = await fake.search('trains', { from: 'Delhi', to: 'Goa', date: FRIDAY });
    const rajdhani = trains.results.find((o) => o.offerId === 'fake:tr-NZM-MAO-20261106-22414-3A')!;
    expect(rajdhani).toMatchObject({ kind: 'train', title: 'Madgaon Rajdhani Express 22414', priceMinor: 412000, priceNote: 'per person, 3A' });
    expect(rajdhani.journey).toMatchObject({ mode: 'train', number: '22414', origin: { code: 'NZM' }, destination: { code: 'MAO' } });
    expect(rajdhani.highlights[0]).toBe('AC 3 Tier');
    const buses = await fake.search('buses', { from: 'Mumbai', to: 'Goa', date: FRIDAY });
    expect(buses.results.map((o) => o.title)).toEqual(['Kadamba Transport (KTCL)', 'Paulo Travels', 'Neeta Tours and Travels']);
    expect(buses.results[0]!.journey).toMatchObject({ mode: 'bus', carrier_name: 'Kadamba Transport (KTCL)' });
  });

  it('holds a flight for the people named and confirms it, paid on the rail PAY_RAIL names', async () => {
    const hold = await fake.hold('fake:fl-DEL-GOI-20261106-6E2134', { name: 'Rahul', personIds: ['p_rahul', 'p_priya'] });
    expect(hold).toMatchObject({ amountMinor: 1184000, currency: 'INR', merchant: 'ixigo (simulated)', payment: { kind: 'fake' } });
    expect(hold.holdId).toMatch(/^fake:hold_/);
    const booked = await fake.confirm(hold.holdId, { approvalId: 'ap_1', railRef: 'fake_pay_1' });
    expect(booked).toMatchObject({ kind: 'flight', vendor: 'ixigo (simulated)', title: 'IndiGo 6E 2134', journey: { number: '6E 2134' } });
    expect(booked.ref).toMatch(/^IXG\d{6}$/);
    rail = 'stripe_test';
    expect((await fake.hold('fake:fl-DEL-GOI-20261106-6E2134', { name: 'Rahul', personIds: ['p_rahul'] })).payment).toEqual({ kind: 'stripe_test' });
  });

  it('holds a refundable villa with the date it is free to cancel until, and a non-refundable one without', async () => {
    const people = { name: 'Rahul', personIds: ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir'] };
    const sol = await fake.hold(`fake:${SOL}`, people);
    expect(sol).toMatchObject({ amountMinor: 3840000, refundableUntil: '2026-11-03T23:59:00+05:30' });
    const azul = await fake.hold('fake:st-casa-azul-assagao-20261106-20261109-5', people);
    expect('refundableUntil' in azul).toBe(false);
  });

  it('confirms a hold once: the same hold confirmed twice, at the same moment, or after a restart, gives the same booking', async () => {
    const hold = await fake.hold(`fake:${SOL}`, { name: 'Rahul', personIds: ['p_rahul'] });
    const paid = { approvalId: 'ap_2', railRef: 'fake_pay_2' };
    const first = await fake.confirm(hold.holdId, paid);
    expect(first).toMatchObject({ kind: 'stay', title: 'Villa Sol', refundableUntil: '2026-11-03T23:59:00+05:30' });
    expect(await fake.confirm(hold.holdId, paid)).toEqual(first);
    const restarted = createFakeTravel({ store, now, payRail: () => 'fake' });
    expect(await restarted.confirm(hold.holdId, paid)).toEqual(first);
    const other = await fake.hold('fake:fl-DEL-GOI-20261106-AI2981', { name: 'Rahul', personIds: ['p_rahul'] });
    const [a, b] = await Promise.all([fake.confirm(other.holdId, paid), fake.confirm(other.holdId, paid)]);
    expect(b).toEqual(a);
    expect(store.pnr({ pnr: a.ref })).toMatchObject({ status: 'confirmed' });
  });

  it('refuses an offer from another backend, and an unknown fare', async () => {
    await expect(fake.hold('ixigo:fl-DEL-GOI-20261106-6E2134', { name: 'Rahul', personIds: ['p_rahul'] })).rejects.toMatchObject({ code: 'unknown_offer' });
    await expect(fake.hold('fake:fl-DEL-GOI-20261106-XX0', { name: 'Rahul', personIds: ['p_rahul'] })).rejects.toMatchObject({ code: 'refused' });
  });

  it('reports a late flight once the store makes it late', async () => {
    store.setDelay('6E', '2134', FRIDAY, 120);
    expect(await fake.status({ kind: 'flight', carrierCode: '6E', number: '2134', date: FRIDAY })).toMatchObject({
      kind: 'flight', state: 'delayed', delayMinutes: 120, expectedDepartAt: '2026-11-06T20:10:00+05:30', checkedAt: NOW.toISOString(),
    });
    expect(await fake.status({ kind: 'pnr', pnr: 'IXG000000' })).toMatchObject({ kind: 'pnr', state: 'not_found' });
  });
});

describe('IxigoTravel over MCP (against the fake ixigo server)', () => {
  let app: FastifyInstance;
  let url = '';
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerFakeIxigoRoutes(app, { store: new FakeIxigoStore({ now }), token: 'tok-ixigo-123456' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`;
  });
  afterAll(async () => {
    await app.close();
  });

  it('runs the same mapping through a real MCP client, with ixigo: offer ids', async () => {
    const ixigo = createIxigoTravel({ url, token: 'tok-ixigo-123456', now });
    const r = await ixigo.search('flights', { from: 'Delhi', to: 'Goa', date: FRIDAY });
    expect(r.results.map((o) => o.offerId)).toContain('ixigo:fl-DEL-GOI-20261106-6E2134');
    const hold = await ixigo.hold('ixigo:fl-DEL-GOI-20261106-6E2134', { name: 'Rahul', personIds: ['p_rahul'] });
    expect(hold.holdId).toMatch(/^ixigo:hold_/);
    expect(hold.payment).toEqual({ kind: 'stripe_test' });
  });

  it("maps refundableUntil from ixigo's hold answer when it is there", async () => {
    const ixigo = createIxigoTravel({ url, token: 'tok-ixigo-123456', now });
    const hold = await ixigo.hold(`ixigo:${SOL}`, { name: 'Rahul', personIds: ['p_rahul'] });
    expect(hold).toMatchObject({ amountMinor: 3840000, refundableUntil: '2026-11-03T23:59:00+05:30' });
  });

  it('says unreachable when ixigo does not answer', async () => {
    const down = createIxigoTravel({ url: 'http://127.0.0.1:1/mcp', now });
    await expect(down.search('flights', { from: 'Delhi', to: 'Goa', date: FRIDAY })).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('looks up the booking for a hold before confirming it again, so a restart never books twice', async () => {
    const inner = createInProcessCaller(new FakeIxigoStore({ now }));
    const confirms: string[] = [];
    const byHold = new Map<string, unknown>();
    // ixigo as the map sees it: the fake's tools plus a lookup of the booking made for a hold.
    const caller: McpCaller = {
      async call(tool, args) {
        if (tool === 'booking_for_hold') {
          const booking = byHold.get(String(args.hold_id)) ?? null;
          return { text: JSON.stringify({ booking }), data: { booking }, isError: false };
        }
        if (tool === 'confirm_booking') confirms.push(String(args.hold_id));
        const r = await inner.call(tool, args);
        if (tool === 'confirm_booking' && !r.isError) byHold.set(String(args.hold_id), r.data);
        return r;
      },
      listTools: () => inner.listTools(),
      close: async () => undefined,
    };
    const map: IxigoMap = {
      ...DEFAULT_IXIGO_MAP,
      bookingForHold: {
        tool: 'booking_for_hold',
        args: (backendHoldId) => ({ hold_id: backendHoldId }),
        result: (data) => {
          const booking = (data as { booking: unknown }).booking;
          return booking === null ? null : confirmedOf(booking);
        },
      },
    };
    const before = createIxigoTravel({ url: 'https://ixigo.invalid/mcp', now, caller, map });
    const hold = await before.hold('ixigo:fl-DEL-GOI-20261106-6E2134', { name: 'Rahul', personIds: ['p_rahul'] });
    const first = await before.confirm(hold.holdId, { approvalId: 'ap_1', railRef: 'pi_1' });
    // Go restarted: nothing is remembered in this process, so the lookup answers.
    const after = createIxigoTravel({ url: 'https://ixigo.invalid/mcp', now, caller, map });
    expect(await after.confirm(hold.holdId, { approvalId: 'ap_1', railRef: 'pi_1' })).toEqual(first);
    expect(confirms).toEqual([hold.holdId.slice('ixigo:'.length)]);
  });
});
