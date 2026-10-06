import type * as C from '@go/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { askOutsideTurn } from '../ask.js';
import { Later } from '../deps.js';
import { getPayment } from '../store.js';
import { approveTap, declineTap, type TapDeps } from '../taps.js';
import { TOASTS } from '../words.js';
import { moneyKit, type MoneyKit } from './kit.js';

let k: MoneyKit;
let t: TapDeps;
let reconciled: string[];
let paymentId: string;
let card: C.Card;
let n = 0;

const tap = (personId: string, actionId = 'approve') => ({ tap_id: `tap_${++n}`, trip_id: 't_goa', card_id: card.card_id, action_id: actionId, person_id: personId });

beforeEach(async () => {
  k = await moneyKit();
  reconciled = [];
  t = { d: k.deps, ask: (tripId, o, trigger) => askOutsideTurn(k.deps, tripId, o, trigger), later: new Later(), reconcile: async (id) => void reconciled.push(id) };
  const r = await k.ask();
  if (!('cardId' in r)) throw new Error(r.refused);
  paymentId = r.paymentId;
  card = k.server.cards.get(r.cardId) as C.Card;
});
afterEach(async () => {
  await t.later.settled();
  await k.drop();
});

describe('Approve', () => {
  it('opens the vault page for the payer, reusing a link that has time left', async () => {
    expect(await approveTap(t, tap('p_rahul'), card)).toEqual({ result: 'open', url: 'https://vault.test/p/pay_1', expires_at: '2026-10-05T09:05:00.000Z' });
    expect(k.vault.payLinks).toHaveLength(1);
  });

  it('mints a fresh link when the old one is about to run out', async () => {
    k.advance(4 * 60_000 + 40_000);
    expect(await approveTap(t, tap('p_rahul'), card)).toMatchObject({ result: 'open', url: 'https://vault.test/p/pay_2' });
    expect((await getPayment(k.pool, paymentId))?.pay_link_url).toBe('https://vault.test/p/pay_2');
  });

  it('refuses everyone but the payer', async () => {
    expect(await approveTap(t, tap('p_priya'), card)).toEqual({ result: 'refused', toast: 'Only Rahul can approve this payment.' });
    expect(k.vault.payLinks).toHaveLength(1);
  });

  it('answers within the limit even when the vault hangs', async () => {
    k.advance(4 * 60_000 + 40_000);
    k.vault.hang = true;
    const started = Date.now();
    expect(await approveTap(t, tap('p_rahul'), card)).toEqual({ result: 'refused', toast: TOASTS.noPage });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('inside the 120 s after the approval ran out, leaves the card to the sweep and starts nothing', async () => {
    k.advance(11 * 60_000);
    k.vault.refuse = 'expired';
    expect(await approveTap(t, tap('p_rahul'), card)).toEqual({ result: 'refused', toast: TOASTS.noPage });
    await t.later.settled();
    expect((await getPayment(k.pool, paymentId))?.state).toBe('waiting');
    expect(reconciled).toEqual([]);
    expect(k.server.writesOf('request_spend_approval')).toHaveLength(1);
  });

  it('starts again once the approval ran out more than 120 s ago, and posts a fresh pay card with ids from the tap', async () => {
    k.advance(12 * 60_000 + 1_000);
    const again = tap('p_rahul');
    expect(await approveTap(t, again, card)).toEqual({ result: 'done', toast: TOASTS.fresh });
    await t.later.settled();
    expect((await getPayment(k.pool, paymentId))?.state).toBe('expired');
    expect(reconciled).toContain(paymentId);
    expect([...k.server.cards.values()].filter((c) => c.kind === 'pay')).toHaveLength(2);
    expect(k.server.writesOf('request_spend_approval').map((w) => w.params.request_id)).toEqual([
      'go_spend_d_villa_trigger_1',
      `go_spend_d_villa_${again.tap_id}`,
    ]);
  });

  it('refuses a payment that is already paid', async () => {
    await k.pool.query("update payments set state = 'paid'");
    expect(await approveTap(t, tap('p_rahul'), card)).toEqual({ result: 'refused', toast: TOASTS.paid });
  });

  it('refuses a card that is not a pay card', async () => {
    const notice = { card_id: 'c_n', kind: 'notice', fallback_text: 'x', tone: 'info', title: 't', body: 'b' } as C.Card;
    expect(await approveTap(t, tap('p_rahul'), notice)).toEqual({ result: 'refused', toast: TOASTS.notPay });
  });
});

describe('Decline', () => {
  it('declines for the payer and leaves the release to reconcile', async () => {
    expect(await declineTap(t, tap('p_rahul', 'decline'), card)).toEqual({ result: 'done', toast: TOASTS.declinedDone });
    await t.later.settled();
    expect(await getPayment(k.pool, paymentId)).toMatchObject({ state: 'declined', release_reason: 'payer_declined' });
    expect(reconciled).toEqual([paymentId]);
  });

  it('refuses everyone but the payer, and a second decline', async () => {
    expect(await declineTap(t, tap('p_kabir', 'decline'), card)).toEqual({ result: 'refused', toast: 'Only Rahul can approve this payment.' });
    await declineTap(t, tap('p_rahul', 'decline'), card);
    expect(await declineTap(t, tap('p_rahul', 'decline'), card)).toEqual({ result: 'refused', toast: TOASTS.declined });
  });
});
