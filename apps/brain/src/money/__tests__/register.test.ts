import * as C from '@go/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SocketCallError } from '../../door/rpc.js';
import { statsRegistry } from '../../stats/sources.js';
import { createPay, type PayEngine } from '../engine.js';
import { paymentsNow } from '../now.js';
import { registerMoneyWith } from '../register.js';
import { NOT_AVAILABLE_YET } from '../vault-link.js';
import { fakeBrain } from './fake-brain.js';
import { goaTrip, moneyKit, type MoneyKit } from './kit.js';

let k: MoneyKit;
beforeEach(async () => {
  k = await moneyKit();
});
afterEach(async () => {
  await k.drop();
});

const vaultBodies: Array<Record<string, any>> = [];
const vaultFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
  if (typeof init?.body === 'string') vaultBodies.push(JSON.parse(init.body));
  const body = path === '/internal/both-keys'
    ? { charged_approval_ids: [], without_both_keys: 0 }
    : { url: `https://vault.test${path === '/internal/links' ? '/l/abc' : '/p/xyz'}`, expires_at: '2026-10-05T09:05:00.000Z' };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

describe('registerMoney', () => {
  it('wires the lane: pay, the two tools, both buttons, vault_link, right now, trip changes, the callback routes', async () => {
    const { brain, seen } = fakeBrain({ pool: k.pool, link: k.server, travel: k.travel, trips: k.server.trips });
    await registerMoneyWith({ fetch: vaultFetch, sweepEveryMs: 0 })(brain);
    expect(brain.pay).toBeDefined();
    expect(seen.tools.map((t) => t.name).sort()).toEqual(['ask_to_pay', 'record_expense', 'set_mandate', 'who_owes_what']);
    expect([...seen.taps.keys()].sort()).toEqual(['notice:claim', 'pay:approve', 'pay:decline']);
    expect([...seen.handlers.keys()]).toEqual(['vault_link']);
    expect(seen.nows.map((n) => [n.name, n.order])).toEqual([['payments', 40]]);
    expect(seen.listeners).toHaveLength(1);
    expect(seen.stoppers).toHaveLength(1);
    const unsigned = await brain.http.inject({ method: 'POST', url: '/internal/vault/paid', payload: { trip_id: 't_goa', approval_id: 'ap_1', rail_ref: 'x' } });
    expect(unsigned.statusCode).toBe(401);
  });

  it("gives the proof board the both-keys count, replacing P3's default", async () => {
    const { brain } = fakeBrain({ pool: k.pool, link: k.server });
    await registerMoneyWith({ fetch: vaultFetch, sweepEveryMs: 0 })(brain);
    const source = statsRegistry(brain).list().find((x) => x.name === 'payments_without_both_keys');
    expect(source).toMatchObject({ label: 'Payments without both keys', good: 'zero', order: 100 });
    const window = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-06T00:00:00Z'), hours: 120 };
    expect(await source?.read(k.pool, window)).toEqual({
      value: 0,
      of: 0,
      note: "From the vault's unlock log and Go's payments: the Server's approval and the payer's passkey on every one.",
    });
  });

  it('puts paid payments that are not booked on the proof board, where zero is good', async () => {
    const { brain } = fakeBrain({ pool: k.pool, link: k.server });
    await registerMoneyWith({ fetch: vaultFetch, sweepEveryMs: 0 })(brain);
    const source = statsRegistry(brain).list().find((x) => x.name === 'paid_but_not_booked');
    expect(source).toMatchObject({ label: 'Paid but not booked', good: 'zero', order: 101 });
    const window = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-06T00:00:00Z'), hours: 120 };
    expect(await source?.read(k.pool, window)).toMatchObject({ value: 0, of: 0 });
    const r = await k.ask();
    if (!('paymentId' in r)) throw new Error('refused');
    await k.pool.query("update payments set state = 'paid'");
    expect(await source?.read(k.pool, window)).toMatchObject({ value: 1, of: 1 });
  });

  it('answers vault_link with a link the contract accepts', async () => {
    const { brain, seen } = fakeBrain({ pool: k.pool, link: k.server });
    await registerMoneyWith({ fetch: vaultFetch, sweepEveryMs: 0 })(brain);
    const link = await seen.handlers.get('vault_link')?.({ kind: 'vault', person_id: 'p_rahul', start: 'add_card' }, { instance: 'sim', frameId: 'gs_1' });
    expect(C.Link.parse(link)).toEqual({ url: 'https://vault.test/l/abc', expires_at: '2026-10-05T09:05:00.000Z' });
  });

  it('answers 1.1\'s add_documents "not available yet" (409 conflict), with any context, and asks the vault nothing', async () => {
    const { brain, seen } = fakeBrain({ pool: k.pool, link: k.server });
    await registerMoneyWith({ fetch: vaultFetch, sweepEveryMs: 0 })(brain);
    const asked = C.CreateLink.parse({ kind: 'vault', person_id: 'p_rahul', start: 'add_documents', context: { trip_id: 't_goa', purpose: 'visa' } });
    const err = await seen.handlers.get('vault_link')?.(asked, { instance: 'sim', frameId: 'gs_2' }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SocketCallError);
    expect(err).toMatchObject({ code: 409, dataCode: 'conflict', message: NOT_AVAILABLE_YET });
  });

  it('opens 1.3\'s display "embedded" for any start (only the App may frame a vault page); sheet is as before', async () => {
    const { brain, seen } = fakeBrain({ pool: k.pool, link: k.server });
    await registerMoneyWith({ fetch: vaultFetch, sweepEveryMs: 0 })(brain);
    const home = C.CreateLink.parse({ kind: 'vault', person_id: 'p_rahul', start: 'home', display: 'embedded' });
    expect(C.Link.safeParse(await seen.handlers.get('vault_link')?.(home, { instance: 'sim', frameId: 'gs_3' })).success).toBe(true);
    expect(vaultBodies.at(-1)).toMatchObject({ person_id: 'p_rahul', start: 'home', display: 'embedded' });
    // Card entry embedded too (11 Oct, the App's demo): the vault asked as for any link.
    const card = C.CreateLink.parse({ kind: 'vault', person_id: 'p_rahul', start: 'add_card', display: 'embedded' });
    expect(C.Link.safeParse(await seen.handlers.get('vault_link')?.(card, { instance: 'sim', frameId: 'gs_card' })).success).toBe(true);
    expect(vaultBodies.at(-1)).toMatchObject({ person_id: 'p_rahul', start: 'add_card', display: 'embedded' });
    const sheet = C.CreateLink.parse({ kind: 'vault', person_id: 'p_rahul', start: 'add_card', display: 'sheet' });
    expect(C.Link.safeParse(await seen.handlers.get('vault_link')?.(sheet, { instance: 'sim', frameId: 'gs_4' })).success).toBe(true);
    expect(vaultBodies.at(-1)).toMatchObject({ person_id: 'p_rahul', start: 'add_card', display: 'sheet' });
  });

  it('stays off without the vault settings', async () => {
    const { brain, seen } = fakeBrain({ pool: k.pool, link: k.server, env: { VAULT_URL: undefined } });
    await registerMoneyWith({ fetch: vaultFetch, sweepEveryMs: 0 })(brain);
    expect(brain.pay).toBeUndefined();
    // Paying stays off, but what people say they paid is still recorded and read back: that needs no vault.
    expect(seen.tools.map((t) => t.name).sort()).toEqual(['record_expense', 'who_owes_what']);
    expect(seen.stoppers).toEqual([]);
  });

  it('stops its sweep through brain.onStop: no sweep after it, and the one in flight is waited for', async () => {
    const { brain, seen } = fakeBrain({ pool: k.pool, link: k.server });
    await registerMoneyWith({ fetch: vaultFetch, sweepEveryMs: 20 })(brain);
    const sweep = vi.spyOn(brain.pay as PayEngine, 'sweep');
    await vi.waitFor(() => expect(sweep).toHaveBeenCalled());
    expect(seen.stoppers).toHaveLength(1);
    for (const fn of [...seen.stoppers].reverse()) await fn();
    const calls = sweep.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(sweep.mock.calls.length).toBe(calls);
  });

  it('asks to pay when it hears Yes, book it, on the rail the PAY_RAIL switch names', async () => {
    const { brain, seen } = fakeBrain({ pool: k.pool, link: k.server, travel: k.travel, trips: k.server.trips, switches: { PAY_RAIL: 'stripe_test' } });
    await registerMoneyWith({ fetch: vaultFetch, sweepEveryMs: 0 })(brain);
    const yes = C.Event.parse({ event_id: 'ev_yes', trip_id: 't_goa', seq: 101, occurred_at: '2026-10-05T09:00:00Z', type: 'mandate.confirmed', data: { decision_id: 'd_villa', person_id: 'p_rahul' } });
    await seen.listeners[0]?.(yes);
    await (brain.pay as unknown as { settled(): Promise<void> }).settled();
    expect([...k.server.cards.values()].filter((c) => c.kind === 'pay')).toHaveLength(1);
    expect(k.server.writesOf('request_spend_approval')).toHaveLength(1);
    expect(vaultBodies.at(-1)?.hold.payment_kind).toBe('stripe_test');
  });
});

describe('payments without both keys', () => {
  it('counts a paid payment the vault never charged, and the vault\'s own count', async () => {
    const pay = createPay(k.deps);
    const r = await k.ask();
    if (!('paymentId' in r)) throw new Error('refused');
    const approvalId = [...k.server.approvals.keys()][0] as string;
    await k.pool.query("update payments set state = 'paid'");
    expect(await pay.withoutBothKeys()).toEqual({ count: 1, paid: 1, charged: 0 });
    k.vault.charged = [approvalId];
    expect(await pay.withoutBothKeys()).toEqual({ count: 0, paid: 1, charged: 1 });
    k.vault.withoutBothKeysValue = 2;
    expect((await pay.withoutBothKeys()).count).toBe(2);
  });
});

describe('the payments block of right now', () => {
  const packs = (trip = goaTrip('confirmed')) => ({ get: async () => ({ trip, messages: [], seq: trip.seq }), invalidate: () => undefined });

  it('never suggests set_mandate for a winner Go cannot book, and says what to tell the group instead', async () => {
    k.travel.options.set('opt_villa_sol', 'ixigo:flight:6e-2134');
    k.travel.offers.set('ixigo:flight:6e-2134', {
      amountMinor: 592000, currency: 'INR', merchant: 'ixigo: IndiGo 6E 2134', refundableUntil: null, title: 'IndiGo 6E 2134', kind: 'flight',
    });
    const text = await paymentsNow({ pool: k.pool, packs: packs(goaTrip('closed')), now: k.now, travel: () => k.travel }).render('t_goa', []);
    expect(text).toContain("Vote d_villa closed and Villa Sol won, but Go can't book it: don't ask who pays or use set_mandate.");
    expect(text).toContain("I can't book flights for the whole group yet.");
    expect(text).not.toContain('Once the group says who pays');
    // A winner Go can book still gets the usual nudge.
    k.travel.options.set('opt_villa_sol', 'ixigo:stay:villa-sol-anjuna');
    expect(await paymentsNow({ pool: k.pool, packs: packs(goaTrip('closed')), now: k.now, travel: () => k.travel }).render('t_goa', [])).toContain(
      'Once the group says who pays, use set_mandate',
    );
  });

  // Ankur, 12 Oct 00:14 IST: a place vote won, and Go said "I found this one on the web, so it can't be booked through
  // me", read off this block. A place, a thing to do or a vote of plain words is nothing anyone pays for.
  it('says nothing about a winner nobody pays for: a place, or a vote of plain words (dates)', async () => {
    const offer = k.travel.offer.bind(k.travel);
    Object.assign(k.travel, { offer: async (id: string) => ({ ...(await offer(id))!, offerId: null, kind: 'place' as never, title: 'Denpasar' }) });
    const place = await paymentsNow({ pool: k.pool, packs: packs(goaTrip('closed')), now: k.now, travel: () => k.travel }).render('t_goa', []);
    expect(place ?? '').not.toContain('d_villa');
    expect(place ?? '').not.toMatch(/can't be booked|found this one on the web|can't book it|set_mandate/);
    const dates = goaTrip('closed');
    const plain = { ...dates, decisions: dates.decisions.map((x) => ({ ...x, options: x.options.map((o) => ({ ...o, option_ref: null })) })) };
    const words = await paymentsNow({ pool: k.pool, packs: packs(plain), now: k.now, travel: () => k.travel }).render('t_goa', []);
    expect(words ?? '').not.toContain('d_villa');
  });

  it('a check that failed just now does not mark the winner unbookable: the usual set_mandate line', async () => {
    k.travel.failOffer = true;
    const text = await paymentsNow({ pool: k.pool, packs: packs(goaTrip('closed')), now: k.now, travel: () => k.travel }).render('t_goa', []);
    // Checked once more at once before it counts as failed (the lead, 11 Oct: nobody should have to ask again for a hiccup).
    expect(k.travel.looked).toEqual(['opt_villa_sol', 'opt_villa_sol']);
    expect(text).toContain('Vote d_villa closed and Villa Sol won. Once the group says who pays, use set_mandate');
    expect(text).not.toContain("Go can't book it");
  });

  it('tells the composer a vote is ready to pay, with the ids ask_to_pay needs', async () => {
    const text = await paymentsNow({ pool: k.pool, packs: packs(), now: k.now }).render('t_goa', []);
    expect(text).toContain('Ready to pay for Villa Sol: Rahul said yes. ask_to_pay with decision_id d_villa and option_ref opt_villa_sol.');
    expect(text).toContain('never ask anyone for card details');
  });

  it('suggests set_mandate after a vote closes, and waits on the payer after that', async () => {
    expect(await paymentsNow({ pool: k.pool, packs: packs(goaTrip('closed')), now: k.now }).render('t_goa', [])).toContain('set_mandate');
    expect(await paymentsNow({ pool: k.pool, packs: packs(goaTrip('mandate')), now: k.now }).render('t_goa', [])).toContain('Waiting on Rahul to tap Yes, book it for Villa Sol');
  });

  it('tells the composer a payment is being confirmed with the bank, and never to start it again', async () => {
    await k.ask();
    await k.pool.query("update payments set state = 'confirming'");
    const text = await paymentsNow({ pool: k.pool, packs: packs(), now: k.now }).render('t_goa', []);
    expect(text).toContain("The bank is still confirming Rahul's payment of ₹54,200 for Villa Sol. Never start it again");
    expect(text).not.toContain('Ready to pay');
  });

  it('shows who a waiting pay card is waiting on, and nothing when there is nothing', async () => {
    // Before any payment: an open vote and no payments rows say nothing.
    expect(await paymentsNow({ pool: k.pool, packs: packs(goaTrip('open')), now: k.now }).render('t_goa', [])).toBeNull();
    await k.ask();
    const text = await paymentsNow({ pool: k.pool, packs: packs(), now: k.now }).render('t_goa', []);
    // In the trip's time (IST), and how to send a fresh one when the payer can't see it (prod, 10 Oct 21:06Z).
    expect(text).toContain(
      "Waiting on Rahul to approve ₹54,200 for Villa Sol on pay card c_pay_d_villa_trigger_1, in this chat; the approval runs out at 2:40 pm. " +
        "If they say they can't see it, or declined it by mistake, call ask_to_pay with again: true for a fresh one; say a fresh one is up only once it answers with its card.",
    );
    expect(text).not.toContain('Ready to pay');
  });
});
