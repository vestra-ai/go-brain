import * as C from '@go/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { askOutsideTurn } from '../ask.js';
import { Later } from '../deps.js';
import { tripEvent } from '../events.js';
import { getPayment } from '../store.js';
import type { TapDeps } from '../taps.js';
import { goaTrip, moneyKit, type MoneyKit } from './kit.js';

let k: MoneyKit;
let t: TapDeps;
let reconciled: string[];
let seq = 200;

const event = (type: string, data: Record<string, unknown>) =>
  C.Event.parse({ event_id: `ev_${++seq}`, trip_id: 't_goa', seq, occurred_at: '2026-10-05T09:00:00Z', type, data });

beforeEach(async () => {
  k = await moneyKit();
  reconciled = [];
  t = { d: k.deps, ask: (tripId, o, trigger) => askOutsideTurn(k.deps, tripId, o, trigger), later: new Later(), reconcile: async (id) => void reconciled.push(id) };
});
afterEach(async () => {
  await k.drop();
});

describe('trip changes', () => {
  it('asks to pay as soon as the payer taps Yes, book it, once per event', async () => {
    const yes = event('mandate.confirmed', { decision_id: 'd_villa', person_id: 'p_rahul' });
    await tripEvent(t, yes);
    await tripEvent(t, yes);
    const pay = [...k.server.cards.values()].filter((c) => c.kind === 'pay');
    expect(pay).toHaveLength(1);
    expect(k.server.writesOf('request_spend_approval')).toHaveLength(1);
    expect(k.server.writesOf('request_spend_approval')[0]?.params).toMatchObject({
      request_id: `go_spend_d_villa_${yes.event_id}`,
      purpose: 'Villa Sol, 3 nights, private pool, Anjuna',
    });
  });

  it('says the new price in the room when it went above the cap', async () => {
    k.travel.price('ixigo:stay:villa-sol-anjuna', 5640000);
    await tripEvent(t, event('mandate.confirmed', { decision_id: 'd_villa', person_id: 'p_rahul' }));
    expect(k.server.posts.at(-1)?.text).toBe('Villa Sol is now ₹56,400, above the ₹55,000 the group allowed. Raise the cap or pick another option?');
    expect([...k.server.cards.values()].filter((c) => c.kind === 'pay')).toEqual([]);
  });

  it('closes a waiting pay card when the payer says not now', async () => {
    const r = await k.ask();
    if (!('paymentId' in r)) throw new Error('refused');
    await tripEvent(t, event('mandate.declined', { decision_id: 'd_villa', person_id: 'p_rahul' }));
    expect(await getPayment(k.pool, r.paymentId)).toMatchObject({ state: 'declined', release_reason: 'payer_declined' });
    expect(reconciled).toEqual([r.paymentId]);
  });

  it('closes a waiting pay card when the mandate is replaced or the vote is cancelled', async () => {
    const r = await k.ask();
    if (!('paymentId' in r)) throw new Error('refused');
    const mandate = goaTrip('confirmed').decisions[0]?.mandate;
    await tripEvent(t, event('mandate.set', { decision_id: 'd_villa', mandate }));
    expect(await getPayment(k.pool, r.paymentId)).toMatchObject({ state: 'expired', release_reason: 'price_changed' });
    await tripEvent(t, event('decision.cancelled', { decision_id: 'd_villa', by: { kind: 'person', person_id: 'p_rahul' } }));
    expect(reconciled).toEqual([r.paymentId]);
  });

  it('ignores every other change', async () => {
    await tripEvent(t, event('person.left', { person_id: 'p_kabir' }));
    expect(k.server.writes).toEqual([]);
  });
});
