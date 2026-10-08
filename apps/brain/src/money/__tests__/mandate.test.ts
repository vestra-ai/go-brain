import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { askToPay, idsFromTurn, withTurn } from '../ask.js';
import { amountsSaid, marginCap, nightsOf, setMandate } from '../mandate.js';
import { AskToPayInput, SetMandateInput, askToPayTool, setMandateTool } from '../tools.js';
import { goaTrip, moneyKit, runToolCalls, say, turnCtx, type MoneyKit } from './kit.js';

let k: MoneyKit;
beforeEach(async () => {
  k = await moneyKit({ trip: goaTrip('closed') });
});
afterEach(async () => {
  await k.drop();
});

const mandate = { decisionId: 'd_villa', choiceIndex: 0, capMinor: 5500000, refundableOnly: true, payerPersonId: 'p_rahul' };
const noCap = { decisionId: 'd_villa', choiceIndex: 0, refundableOnly: true, payerPersonId: 'p_rahul' };
const ctxWith = (lines: Array<[string, string]> = []) =>
  turnCtx('t_goa', k.server, k.server.trip('t_goa'), lines.map(([who, text], i) => say(i + 1, who, text)));

describe('amounts people said', () => {
  const group = { heads: 5, nights: 3 };

  it('reads a plain number as the total, in rupees, k or lakh, and never multiplies it', () => {
    const said = amountsSaid([say(1, 'p_rahul', 'max 60k for the villa'), say(2, 'p_priya', 'ok under ₹1,20,000 total'), say(3, 'p_kabir', 'budget 1.5 lakh')], group);
    expect([...said].sort((a, b) => a - b)).toEqual([6000000, 12000000, 15000000]);
    expect(amountsSaid([say(1, 'p_rahul', 'Goa on 6 to 9 Nov')], group)).toEqual([]);
  });

  it('reads "8k a head" as 8,000 times the people', () => {
    expect(amountsSaid([say(1, 'p_arjun', '8k a head is fine')], group)).toEqual([4000000]);
    expect(amountsSaid([say(1, 'p_arjun', 'max 8k per person')], group)).toEqual([4000000]);
  });

  it('reads "8k a head per night" as 8,000 times the people times the nights, and "8k per night" as 8,000 times the nights', () => {
    expect(amountsSaid([say(1, 'p_arjun', 'under 8k a head per night')], group)).toEqual([12000000]);
    expect(amountsSaid([say(1, 'p_arjun', '8k per night')], group)).toEqual([2400000]);
  });

  it('leaves a per-night number out when the trip has no dates: the words are unclear', () => {
    expect(amountsSaid([say(1, 'p_arjun', 'under 8k a head per night')], { heads: 5, nights: null })).toEqual([]);
  });

  it("counts the nights from the trip's dates", () => {
    expect(nightsOf({ dates: { start: '2026-11-06', end: '2026-11-09' } })).toBe(3);
    expect(nightsOf({ dates: null })).toBeNull();
  });
});

describe('set_mandate', () => {
  it('records what the group allowed and puts the mandate card in the turn', async () => {
    const ctx = ctxWith();
    const r = await setMandate(k.deps, ctx, mandate);
    if (!('cardId' in r)) throw new Error(r.refused);
    expect(k.server.writesOf('set_mandate')[0]?.params).toMatchObject({
      request_id: 'go_mandate_turn_test_1',
      decision_id: 'd_villa',
      choice_index: 0,
      cap_minor: 5500000,
      currency: 'INR',
      refundable_only: true,
      payer_person_id: 'p_rahul',
    });
    expect(ctx.cards).toEqual([expect.objectContaining({ kind: 'mandate', card_id: 'c_mandate_turn_test_1', decision_id: 'd_villa' })]);
  });

  it('allows the price plus up to 10%, and no more unless someone said it', async () => {
    expect(marginCap(5420000)).toBe(5900000);
    expect(marginCap(5420000)).toBeLessThanOrEqual(5420000 * 1.1);
    expect(marginCap(3840000)).toBe(4200000);
    expect(await setMandate(k.deps, ctxWith(), { ...mandate, capMinor: 5900000 })).toMatchObject({ cardId: expect.any(String) });
    k.server.trips.set('t_goa', goaTrip('closed'));
    expect(await setMandate(k.deps, ctxWith(), { ...mandate, capMinor: 9000000 })).toMatchObject({ refused: expect.stringContaining('₹59,000') });
    expect(await setMandate(k.deps, ctxWith([['p_rahul', 'we can go up to 90k for a good villa']]), { ...mandate, capMinor: 9000000 })).toMatchObject({
      cardId: expect.any(String),
    });
  });

  it('with no clear number, sets the whole price plus up to 10% and says so', async () => {
    const r = await setMandate(k.deps, ctxWith([['p_rahul', 'just book whatever works']]), noCap);
    expect(r).toMatchObject({ cardId: expect.any(String), capMinor: 5900000, byMargin: true, note: expect.stringContaining('the price plus a little margin') });
    expect(k.server.writesOf('set_mandate')[0]?.params).toMatchObject({ cap_minor: 5900000 });
  });

  it('reads "15k a head per night" as 15,000 times the people times the nights, never as a per-head total', async () => {
    k.server.trips.set('t_goa', { ...goaTrip('closed'), dates: { start: '2026-11-06', end: '2026-11-09' } });
    const said: Array<[string, string]> = [['p_rahul', 'we can do 15k a head per night for a really good villa']];
    expect(await setMandate(k.deps, ctxWith(said), { ...mandate, capMinor: 7500000 })).toMatchObject({ refused: expect.stringContaining('Tell me the cap') });
    expect(await setMandate(k.deps, ctxWith(said), { ...mandate, capMinor: 22500000 })).toMatchObject({ cardId: expect.any(String), capMinor: 22500000, byMargin: false });
  });

  it('without trip dates, a per-night number is unclear, so only the price plus up to 10% is allowed', async () => {
    const said: Array<[string, string]> = [['p_rahul', 'we can do 15k a head per night for a really good villa']];
    expect(await setMandate(k.deps, ctxWith(said), { ...mandate, capMinor: 22500000 })).toMatchObject({ refused: expect.stringContaining('Tell me the cap') });
  });

  it('reads "15k a head" as 15,000 times the people, and a plain "75k" as the total', async () => {
    expect(await setMandate(k.deps, ctxWith([['p_rahul', '15k a head max']]), { ...mandate, capMinor: 7500000 })).toMatchObject({ cardId: expect.any(String) });
    k.server.trips.set('t_goa', goaTrip('closed'));
    expect(await setMandate(k.deps, ctxWith([['p_rahul', '75k max']]), { ...mandate, capMinor: 7500000 })).toMatchObject({ cardId: expect.any(String) });
    k.server.trips.set('t_goa', goaTrip('closed'));
    expect(await setMandate(k.deps, ctxWith([['p_rahul', '75k max']]), { ...mandate, capMinor: 37500000 })).toMatchObject({ refused: expect.stringContaining('Tell me the cap') });
  });

  it('refuses a cap below the price', async () => {
    expect(await setMandate(k.deps, ctxWith(), { ...mandate, capMinor: 5000000 })).toMatchObject({ refused: expect.stringContaining('below the price') });
    expect(k.server.writesOf('set_mandate')).toEqual([]);
  });

  it('refuses an option that did not win', async () => {
    expect(await setMandate(k.deps, ctxWith(), { ...mandate, choiceIndex: 1 })).toMatchObject({ refused: 'The group picked Villa Sol. I can only set that.' });
  });

  it('refuses a payer who is not in the trip, and an open vote', async () => {
    expect(await setMandate(k.deps, ctxWith(), { ...mandate, payerPersonId: 'p_stranger' })).toMatchObject({ refused: "That person isn't in this trip." });
    k.server.trips.set('t_goa', goaTrip('open'));
    expect(await setMandate(k.deps, ctxWith(), mandate)).toMatchObject({ refused: expect.stringContaining('still open') });
    expect(k.server.writesOf('set_mandate')).toEqual([]);
  });

  it("does not set the same mandate twice, which would clear the payer's yes", async () => {
    k.server.trips.set('t_goa', goaTrip('confirmed'));
    expect(await setMandate(k.deps, ctxWith(), mandate)).toMatchObject({ refused: expect.stringContaining('already set') });
    expect(k.server.writesOf('set_mandate')).toEqual([]);
  });
});

describe('set_mandate refuses, in code, what Go cannot book', () => {
  /** The villa vote's winner, resolving to another kind of offer. */
  const winnerIs = (offerId: string | null, offer?: Parameters<MoneyKit['travel']['offers']['set']>[1]) => {
    k.travel.options.set('opt_villa_sol', offerId);
    if (offerId && offer) k.travel.offers.set(offerId, offer);
  };
  const flight = { amountMinor: 592000, currency: 'INR', merchant: 'ixigo: IndiGo 6E 2134', refundableUntil: null, title: 'IndiGo 6E 2134', kind: 'flight' as const };

  it('a flight: group fares are not booked, so it says so and points to its card, never the link, and sets nothing', async () => {
    winnerIs('ixigo:flight:6e-2134', { ...flight, link: 'https://www.ixigo.com/flights/6e-2134' });
    expect(await setMandate(k.deps, ctxWith(), mandate)).toEqual({
      refused: "I can't book flights for the whole group yet. Each of you can book on ixigo: See on ixigo on its card opens it there.",
      unbookable: true,
    });
    expect(k.server.writesOf('set_mandate')).toEqual([]);
  });

  it('a train or a bus: the same, for trains and buses', async () => {
    winnerIs('ixigo:train:12432', { ...flight, title: 'Rajdhani 12432', kind: 'train' });
    expect(await setMandate(k.deps, ctxWith(), mandate)).toMatchObject({ refused: "I can't book trains for the whole group yet.", unbookable: true });
    winnerIs('ixigo:bus:volvo', { ...flight, title: 'Volvo sleeper', kind: 'bus' });
    expect(await setMandate(k.deps, ctxWith(), mandate)).toMatchObject({ refused: "I can't book buses for the whole group yet.", unbookable: true });
    expect(k.server.writesOf('set_mandate')).toEqual([]);
  });

  it('a place a job found on the web: no offer to hold, so nothing to set', async () => {
    winnerIs(null);
    expect(await setMandate(k.deps, ctxWith(), mandate)).toMatchObject({ refused: expect.stringContaining('found this one on the web'), unbookable: true });
    k.travel.options.delete('opt_villa_sol');
    expect(await setMandate(k.deps, ctxWith(), mandate)).toMatchObject({ refused: expect.stringContaining('found this one on the web'), unbookable: true });
    expect(k.server.writesOf('set_mandate')).toEqual([]);
  });

  it('a stay from ixigo.com: no offer to hold, so it says where to book it (its card, never the link), and sets nothing', async () => {
    winnerIs(null);
    k.travel.pages.set('opt_villa_sol', 'https://www.ixigo.com/hotels/1384544/details?locationId=1366415&checkinDate=06112026&checkoutDate=09112026&adultCount=5&roomCount=3&hotelInfoToken=true%7C3001%7C1');
    expect(await setMandate(k.deps, ctxWith(), mandate)).toEqual({
      refused: "Villa Sol is booked on ixigo, not here: See on ixigo on its card opens it there.",
      unbookable: true,
    });
    expect(k.server.writesOf('set_mandate')).toEqual([]);
  });

  it('an option Go never found (no option_ref), or no travel layer at all', async () => {
    const trip = goaTrip('closed');
    const d = trip.decisions[0];
    if (!d) throw new Error('no vote');
    d.options = d.options.map(({ option_ref: _ref, ...rest }) => rest);
    k.server.trips.set('t_goa', trip);
    expect(await setMandate(k.deps, ctxWith(), mandate)).toMatchObject({ refused: "Villa Sol isn't something I can book here, so there's nothing to set up for paying.", unbookable: true });
    k.server.trips.set('t_goa', goaTrip('closed'));
    expect(await setMandate({ ...k.deps, travel: () => undefined }, ctxWith(), mandate)).toMatchObject({ unbookable: true });
    expect(k.server.writesOf('set_mandate')).toEqual([]);
  });

  it('a check that failed just now is not unbookable: a plain try again, no flag, nothing set', async () => {
    k.travel.failOffer = true;
    expect(await setMandate(k.deps, ctxWith(), mandate)).toEqual({ refused: "I couldn't check Villa Sol just now. Try again in a moment." });
    expect(k.server.writesOf('set_mandate')).toEqual([]);
    const [out] = await runToolCalls([setMandateTool((ctx, o) => setMandate(k.deps, ctx, o))], ctxWith(), [
      { name: 'set_mandate', input: { decision_id: 'd_villa', choice_index: 0, refundable_only: false, payer_person_id: 'p_rahul' } },
    ]);
    expect(out).toEqual({
      refused: "I couldn't check Villa Sol just now. Try again in a moment.",
      tell_the_room: 'Say this in your own short words. Never offer another way to pay.',
    });
  });

  it('the tool tells the model to say so before anything about who pays', async () => {
    winnerIs('ixigo:flight:6e-2134', flight);
    const [out] = await runToolCalls([setMandateTool((ctx, o) => setMandate(k.deps, ctx, o))], ctxWith(), [
      { name: 'set_mandate', input: { decision_id: 'd_villa', choice_index: 0, refundable_only: false, payer_person_id: 'p_rahul' } },
    ]);
    expect(out).toEqual({
      refused: "I can't book flights for the whole group yet.",
      tell_the_room: 'Say this in one short line, before anything about who pays: there is nothing to set up for paying for this option.',
    });
  });
});

describe('the quick tools', () => {
  const tools = () => [
    askToPayTool((ctx, o) => askToPay(k.deps, ctx.tripId, o, idsFromTurn(ctx), withTurn(ctx))),
    setMandateTool((ctx, o) => setMandate(k.deps, ctx, o)),
  ];

  it('ask_to_pay takes only the vote, the offer and the purpose: no payer, no card', () => {
    const base = { decision_id: 'd_villa', option_ref: 'opt_villa_sol', purpose: 'Villa Sol' };
    expect(AskToPayInput.safeParse(base).success).toBe(true);
    expect(AskToPayInput.safeParse({ ...base, payer_person_id: 'p_priya' }).success).toBe(false);
    expect(AskToPayInput.safeParse({ ...base, card_number: '4242424242424242' }).success).toBe(false);
    expect(SetMandateInput.safeParse({ decision_id: 'd_villa', choice_index: 0, cap_minor: 1, refundable_only: true, payer_person_id: 'p_rahul', card: 'x' }).success).toBe(false);
    // No cap when nobody said one: Go then uses the price plus up to 10%.
    expect(SetMandateInput.safeParse({ decision_id: 'd_villa', choice_index: 0, refundable_only: true, payer_person_id: 'p_rahul' }).success).toBe(true);
  });

  it("ask_to_pay pays only in the turn's own trip and hands a refusal back for the model to say", async () => {
    const ctx = ctxWith();
    const [out] = await runToolCalls(tools(), ctx, [{ name: 'ask_to_pay', input: { decision_id: 'd_villa', option_ref: 'opt_villa_sol', purpose: 'Villa Sol' } }]);
    expect(out).toMatchObject({ refused: expect.stringContaining("hasn't set what to book"), tell_the_room: expect.stringContaining('Never offer another way to pay') });
  });

  it('set_mandate runs from the model with the turn ids', async () => {
    const ctx = ctxWith();
    const [out] = await runToolCalls(tools(), ctx, [
      { name: 'set_mandate', input: { decision_id: 'd_villa', choice_index: 0, cap_minor: 5500000, refundable_only: true, payer_person_id: 'p_rahul' } },
    ]);
    expect(out).toMatchObject({ mandate_card: 'c_mandate_turn_test_1' });
  });

  it('set_mandate with no cap uses the price plus up to 10% and tells the room so', async () => {
    const ctx = ctxWith();
    const [out] = await runToolCalls(tools(), ctx, [
      { name: 'set_mandate', input: { decision_id: 'd_villa', choice_index: 0, refundable_only: true, payer_person_id: 'p_rahul' } },
    ]);
    expect(out).toMatchObject({ mandate_card: 'c_mandate_turn_test_1', tell_the_room: expect.stringContaining('₹59,000: the price plus a little margin') });
    expect(k.server.writesOf('set_mandate')[0]?.params).toMatchObject({ cap_minor: 5900000 });
  });
});
