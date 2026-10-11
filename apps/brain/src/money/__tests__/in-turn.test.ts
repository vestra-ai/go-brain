import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { askToPay, idsFromTurn, inTurn, withTurn } from '../ask.js';
import { sweepPayments } from '../finish.js';
import { getPayment } from '../store.js';
import { askToPayTool } from '../tools.js';
import { moneyKit, runToolCalls, turnCtx, VILLA, type MoneyKit } from './kit.js';

// Prod, 10 Oct 21:05Z (a group stay of ₹38,760): ask_to_pay ran past the composer's 8 s for a tool. The Server granted the
// approval, but the pay card was pushed into a turn that had already posted, so it never reached the room; Go then said
// it was "already waiting", "a fresh one is already waiting", and the sweep could never close it (the Server had no
// such card), so the approval was never let go.
let k: MoneyKit;
const payCards = () => [...k.server.cards.values()].filter((c) => c.kind === 'pay');
const spendAsks = () => k.server.writesOf('request_spend_approval');
const INPUT = { decision_id: VILLA.decisionId, option_ref: VILLA.optionRef, purpose: 'Villa Sol' };
/** The tool as money registers it, waiting waitMs in the turn. */
const tool = (waitMs: number) =>
  askToPayTool((ctx, o) => {
    const turn = inTurn(k.deps, ctx);
    const asking = askToPay(k.deps, ctx.tripId, o, turn.ids, turn.deliver);
    return { asking, letGo: () => turn.letGo(asking) };
  }, { waitMs });
/** The travel layer's hold, held until release(), or failing then. */
const slowHold = (fail = false) => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const hold = k.travel.hold.bind(k.travel);
  Object.assign(k.travel, {
    hold: async (...a: Parameters<typeof hold>) => {
      await gate;
      if (fail) throw new Error('the hold failed');
      return hold(...a);
    },
  });
  return () => release();
};

beforeEach(async () => {
  k = await moneyKit();
});
afterEach(async () => {
  await k.drop();
});

describe('a pay card asked in a turn', () => {
  it('never loses its card: past the wait, the room hears it is on its way, and money posts the card itself', async () => {
    const release = slowHold();
    const ctx = turnCtx('t_goa', k.server, k.server.trip('t_goa'));
    const [out] = await runToolCalls([tool(20)], ctx, [{ name: 'ask_to_pay', input: INPUT }]);
    expect(out).toMatchObject({ pay_card: 'on its way', tell_the_room: expect.stringContaining('Never say it is up already, and never tell anyone to open Go') });
    expect(payCards()).toEqual([]);
    release();
    await vi.waitFor(() => expect(payCards()).toHaveLength(1));
    // Posted by money itself, under the turn's own ids, never into the turn that had moved on.
    expect(ctx.cards).toEqual([]);
    expect(k.server.writesOf('post_message').at(-1)?.params).toMatchObject({ request_id: 'go_paycard_turn_test_1', card: { kind: 'pay', card_id: 'c_pay_turn_test_1', state: 'waiting' } });
  });

  it('one that is quick rides the turn\'s own message, as before, and says the card is up here in the chat', async () => {
    const ctx = turnCtx('t_goa', k.server, k.server.trip('t_goa'));
    const [out] = await runToolCalls([tool(5_000)], ctx, [{ name: 'ask_to_pay', input: INPUT }]);
    expect(out).toEqual({ pay_card: 'c_pay_turn_test_1', tell_the_room: 'Say in one short line that the pay card is up for the payer, here in the chat.' });
    expect(ctx.cards).toEqual([expect.objectContaining({ kind: 'pay', card_id: 'c_pay_turn_test_1' })]);
    expect(payCards()).toEqual([]);
  });

  it('a refusal that comes after the tool stopped waiting is said in the room', async () => {
    const release = slowHold(true);
    const ctx = turnCtx('t_goa', k.server, k.server.trip('t_goa'));
    await runToolCalls([tool(20)], ctx, [{ name: 'ask_to_pay', input: INPUT }]);
    release();
    await vi.waitFor(() => expect(k.server.writesOf('post_message').map((w) => w.params.text)).toEqual(["I couldn't hold Villa Sol just now. Want me to try again?"]));
    expect(payCards()).toEqual([]);
  });
});

describe('again: the payer says the card did not show, or they declined it by mistake', () => {
  it('lets the waiting one go (its approval released, its card closed) and sends a fresh one; without again it says the one waiting', async () => {
    const first = await k.ask();
    if (!('cardId' in first)) throw new Error(first.refused);
    const firstApproval = [...k.server.approvals.keys()][0];
    const [plain] = await runToolCalls([tool(5_000)], turnCtx('t_goa', k.server, k.server.trip('t_goa')), [{ name: 'ask_to_pay', input: INPUT }]);
    expect(plain).toMatchObject({ refused: 'Rahul, the payment for Villa Sol is already waiting on the card above.' });

    const ctx = turnCtx('t_goa', k.server, k.server.trip('t_goa'));
    const [fresh] = await runToolCalls([tool(5_000)], ctx, [{ name: 'ask_to_pay', input: { ...INPUT, again: true } }]);
    expect(fresh).toMatchObject({ pay_card: 'c_pay_turn_test_1' });
    expect((await getPayment(k.pool, first.paymentId))?.state).toBe('expired');
    expect(k.server.writesOf('cancel_spend_approval')[0]?.params).toMatchObject({ approval_id: firstApproval, reason: 'other' });
    expect(k.server.cards.get(first.cardId)).toMatchObject({ state: 'expired' });
    expect(spendAsks()).toHaveLength(2);
    expect(ctx.cards).toEqual([expect.objectContaining({ kind: 'pay', state: 'waiting' })]);
  });
});

describe('a pay card the Server never got', () => {
  it('closing it still lets the approval go: a card the Server refuses no longer holds the payment open', async () => {
    // The card stays in a turn that never posts it, as on 10 Oct.
    const ctx = turnCtx('t_goa', k.server, k.server.trip('t_goa'));
    const r = await askToPay(k.deps, 't_goa', VILLA, idsFromTurn(ctx), withTurn(ctx));
    if (!('cardId' in r)) throw new Error(r.refused);
    expect(k.server.cards.has(r.cardId)).toBe(false);
    k.advance(13 * 60_000);
    await sweepPayments(k.deps);
    const row = await getPayment(k.pool, r.paymentId);
    expect(row).toMatchObject({ state: 'expired' });
    expect(row?.released_at).not.toBeNull();
    expect(k.server.writesOf('cancel_spend_approval')).toHaveLength(1);
  });
});
