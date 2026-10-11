import * as C from '@go/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeskItem } from '../../desk/desk.js';
import { claimCardOnClose, claimTap, stayClosedAnswer } from '../claim-taps.js';
import { claimCard, claimCardId, createClaims, type Claims } from '../claims.js';
import { Later, type MoneyDeps } from '../deps.js';
import { setMandate } from '../mandate.js';
import { goaTrip, moneyKit, say, turnCtx, type MoneyKit } from './kit.js';

// Contract 1.1 A10: when a stay vote closes, one person books for all. Go never picks them: the first to take the card's
// "I'll book it" (or to ask Go to book it in their own words) is the payer.

let k: MoneyKit;
let claims: Claims;
let d: MoneyDeps;
beforeEach(async () => {
  k = await moneyKit({ trip: goaTrip('closed') });
  claims = createClaims(k.pool, k.now);
  d = { ...k.deps, claims };
});
afterEach(async () => {
  await k.drop();
});

const noCap = { decisionId: 'd_villa', choiceIndex: 0, refundableOnly: false, payerPersonId: 'p_rahul' };
/** A turn: the messages that woke it (Rahul's "@Go book it", say) are its wake. */
function turn(lines: Array<[string, string]> = [], turnId = 'turn_test') {
  const messages = lines.map(([who, text], i) => say(i + 1, who, text));
  const ctx = turnCtx('t_goa', k.server, k.server.trip('t_goa'), messages);
  const wake: DeskItem[] = messages.map((m) => ({ id: `msg:${m.message_id}`, tripId: 't_goa', kind: 'message', ref: m.message_id, dueAt: k.now(), payload: {} }));
  return Object.assign(ctx, { wake, turnId });
}
const packs = () => ({ get: async () => ({ trip: k.server.trip('t_goa'), messages: [], seq: 1 }) });
const tapOf = (personId: string, n: number) => ({ tap_id: `tap_claim_${n}`, trip_id: 't_goa', card_id: claimCardId('d_villa'), action_id: 'claim', person_id: personId });

describe('the claim card', () => {
  it('asks everyone with one button, then says who is booking, with none', () => {
    const open = claimCard({ decisionId: 'd_villa', what: 'Saudades Homestays', people: 4, claimer: null });
    expect(C.Card.parse(open)).toEqual(open);
    expect(open).toMatchObject({
      card_id: 'c_claim_d_villa', kind: 'notice', title: 'One person books for all',
      actions: [{ action_id: 'claim', label: "I'll book it", style: 'primary' }],
    });
    expect(open).not.toHaveProperty('actions.0.only_for_person_ids');
    const taken = claimCard({ decisionId: 'd_villa', what: 'Saudades Homestays', people: 4, claimer: 'Rahul' });
    expect(C.Card.parse(taken)).toEqual(taken);
    expect(taken).toMatchObject({ title: 'Rahul is booking for all 4', actions: [] });
  });

  // 11 Oct, prod: Saket alone at Hampi saw "Saket Diwakar is booking for all 1… Go splits it with the group after."
  it('for a trip of one, asks them alone and then says what they book: no "for all", nobody to split with', () => {
    const open = claimCard({ decisionId: 'd_villa', what: 'Ganga Homestay', people: 1, claimer: null });
    expect(C.Card.parse(open)).toEqual(open);
    expect(open).toMatchObject({ title: 'Book Ganga Homestay', actions: [{ action_id: 'claim', label: "I'll book it", style: 'primary' }] });
    const taken = claimCard({ decisionId: 'd_villa', what: 'Ganga Homestay', people: 1, claimer: 'Saket' });
    expect(C.Card.parse(taken)).toEqual(taken);
    expect(taken).toMatchObject({ title: 'Saket is booking Ganga Homestay', body: 'Saket pays for Ganga Homestay and books it.', actions: [] });
    for (const card of [open, taken]) expect(JSON.stringify(card)).not.toMatch(/for all|everyone|split|group/i);
  });

  it('goes up on one turn only (a rerun of that turn carries it again), and the first claim wins', async () => {
    expect(await claims.offer('t_goa', 'd_villa', 'turn_a')).toBe(true);
    expect(await claims.offer('t_goa', 'd_villa', 'turn_a')).toBe(true);
    expect(await claims.offer('t_goa', 'd_villa', 'turn_b')).toBe(false);
    expect(await claims.take('t_goa', 'd_villa', 'p_rahul')).toBe('p_rahul');
    expect(await claims.take('t_goa', 'd_villa', 'p_priya')).toBe('p_rahul');
    expect(await claims.offer('t_goa', 'd_villa', 'turn_a')).toBe(false);
  });
});

describe('set_mandate on a stay: the payer is whoever claimed it, never Go\'s pick', () => {
  it('with no claim, puts the card on this turn\'s post and sets nothing', async () => {
    const ctx = turn();
    const r = await setMandate(d, ctx, noCap);
    expect(r).toMatchObject({ refused: expect.stringContaining('One person books Villa Sol for all'), claim: true });
    expect(ctx.cards.map((c) => c.card_id)).toEqual(['c_claim_d_villa']);
    // Again in the same turn: the card is there once.
    await setMandate(d, ctx, noCap);
    expect(ctx.cards).toHaveLength(1);
    expect(k.server.writesOf('set_mandate')).toEqual([]);
  });

  it('a person who asks Go to book it claims it: "Rahul, you\'re booking for all 5", the card says so, and the mandate is his', async () => {
    // The card went up when the vote closed.
    expect(await claims.offer('t_goa', 'd_villa', 'turn_close')).toBe(true);
    await k.server.request('post_message', { request_id: 'go_close', trip_id: 't_goa', card: claimCard({ decisionId: 'd_villa', what: 'Villa Sol', people: 5, claimer: null }) });
    const ctx = turn([['p_rahul', 'heyy can you try booking Villa Sol now']]);
    const r = await setMandate(d, ctx, noCap);
    expect(r).toMatchObject({ cardId: expect.any(String), note: expect.stringMatching(/^Rahul, you're booking for all 5\. /) });
    expect(await claims.get('t_goa', 'd_villa')).toMatchObject({ personId: 'p_rahul' });
    expect(k.server.writesOf('set_mandate')[0]?.params).toMatchObject({ payer_person_id: 'p_rahul' });
    expect(k.server.cards.get('c_claim_d_villa')).toMatchObject({ title: 'Rahul is booking for all 5', actions: [] });
  });

  it('someone else who already claimed it: "Priya is already booking this", and Priya herself sets it', async () => {
    await claims.take('t_goa', 'd_villa', 'p_priya');
    expect(await setMandate(d, turn([['p_rahul', '@Go book it']]), noCap)).toEqual({ refused: 'Priya is already booking this.' });
    expect(await setMandate(d, turn(), { ...noCap, payerPersonId: 'p_priya' })).toMatchObject({ cardId: expect.any(String) });
    expect(k.server.writesOf('set_mandate')[0]?.params).toMatchObject({ payer_person_id: 'p_priya' });
  });

  it('refuses a stay whose date has passed: no claim card, no mandate', async () => {
    const offer = k.travel.offer.bind(k.travel);
    Object.assign(k.travel, { offer: async (id: string) => ({ ...(await offer(id))!, day: '2026-10-01', past: true as const }) });
    const ctx = turn([['p_rahul', '@Go book it']]);
    expect(await setMandate(d, ctx, noCap)).toEqual({
      refused: "Villa Sol was for 1 Oct, which has passed, so I can't book it. Want me to search again for dates ahead?",
      unbookable: true,
    });
    expect(ctx.cards).toEqual([]);
    expect(k.server.writesOf('set_mandate')).toEqual([]);
  });
});

describe("I'll book it", () => {
  it('the first tap books it: answered at once, then the card says who, the mandate is theirs, and one line with the mandate card names them', async () => {
    await k.server.request('post_message', { request_id: 'go_close', trip_id: 't_goa', card: claimCard({ decisionId: 'd_villa', what: 'Villa Sol', people: 5, claimer: null }) });
    const later = new Later();
    const tap = claimTap({ d, claims, packs: packs(), later });
    expect(await tap(tapOf('p_rahul', 1))).toEqual({ result: 'done', toast: "You're booking it for everyone" });
    await later.settled();
    expect(k.server.cards.get('c_claim_d_villa')).toMatchObject({ title: 'Rahul is booking for all 5', actions: [] });
    expect(k.server.writesOf('set_mandate')[0]?.params).toMatchObject({ payer_person_id: 'p_rahul', choice_index: 0, refundable_only: false });
    const post = k.server.writesOf('post_message').at(-1)?.params;
    expect(post).toMatchObject({ text: expect.stringMatching(/^Rahul, you're booking for all 5\. .*Tap Yes, book it when you're ready\.$/), mentions: ['p_rahul'], card: { kind: 'mandate' } });
    // Later taps hear who already is.
    expect(await tap(tapOf('p_priya', 2))).toEqual({ result: 'refused', toast: 'Rahul is already booking this.' });
    expect(await tap(tapOf('p_rahul', 3))).toEqual({ result: 'done', toast: "You're booking it" });
  });

  // Prod drill, 11 Oct: "I'll book it" a minute after the hello's login card said nothing at all.
  it("parked on their login card that is up: the login's one plain line, naming them, and no mandate yet", async () => {
    await k.server.request('post_message', { request_id: 'go_close', trip_id: 't_goa', card: claimCard({ decisionId: 'd_villa', what: 'Villa Sol', people: 5, claimer: null }) });
    const line = "Booking Villa Sol waits on the trip's ixigo login: @Rahul, tap Log in to ixigo on your card above, and I'll carry on once you're in.";
    Object.assign(k.travel, { prepare: async () => ({ ok: false as const, note: 'For the model.', line }) });
    const later = new Later();
    await claimTap({ d, claims, packs: packs(), later })(tapOf('p_rahul', 1));
    await later.settled();
    expect(k.server.writesOf('set_mandate')).toEqual([]);
    expect(k.server.cards.get('c_claim_d_villa')).toMatchObject({ title: 'Rahul is booking for all 5' });
    expect(k.server.writesOf('post_message').at(-1)?.params).toEqual({ request_id: 'go_claim_waits_tap_claim_1', trip_id: 't_goa', text: line, mentions: ['p_rahul'] });
  });

  it("parked with the login's own line and card just up: nothing more from the tap", async () => {
    await k.server.request('post_message', { request_id: 'go_close', trip_id: 't_goa', card: claimCard({ decisionId: 'd_villa', what: 'Villa Sol', people: 5, claimer: null }) });
    Object.assign(k.travel, { prepare: async () => ({ ok: false as const, note: 'For the model.' }) });
    const later = new Later();
    await claimTap({ d, claims, packs: packs(), later })(tapOf('p_rahul', 1));
    await later.settled();
    expect(k.server.writesOf('set_mandate')).toEqual([]);
    expect(k.server.writesOf('post_message').map((w) => w.params.request_id)).toEqual(['go_close']);
  });
});

describe("I'll book it on a trip of one", () => {
  it('books it for them: the line says what, for how much and how many nights, never "for all", everyone or a split', async () => {
    const base = goaTrip('closed');
    const solo = await moneyKit({ trip: { ...base, people: base.people.slice(0, 1), dates: { start: '2026-11-06', end: '2026-11-09' } } });
    try {
      const soloClaims = createClaims(solo.pool, solo.now);
      await solo.server.request('post_message', { request_id: 'go_close', trip_id: 't_goa', card: claimCard({ decisionId: 'd_villa', what: 'Villa Sol', people: 1, claimer: null }) });
      const later = new Later();
      const soloPacks = { get: async () => ({ trip: solo.server.trip('t_goa'), messages: [], seq: 1 }) };
      const tap = claimTap({ d: { ...solo.deps, claims: soloClaims }, claims: soloClaims, packs: soloPacks, later });
      expect(await tap(tapOf('p_rahul', 1))).toEqual({ result: 'done', toast: "You're booking it" });
      await later.settled();
      expect(solo.server.cards.get('c_claim_d_villa')).toMatchObject({ title: 'Rahul is booking Villa Sol', actions: [] });
      expect(solo.server.writesOf('set_mandate')[0]?.params).toMatchObject({ payer_person_id: 'p_rahul' });
      const post = solo.server.writesOf('post_message').at(-1)?.params;
      expect(post).toMatchObject({
        text: expect.stringMatching(/^Rahul, you're booking Villa Sol, ₹[\d,]+ for 3 nights\. .*Tap Yes, book it when you're ready\.$/),
        card: { kind: 'mandate' },
      });
      expect(String(post?.text)).not.toMatch(/for all|everyone|split|group/i);
    } finally {
      await solo.drop();
    }
  });

  it('a trip of one that asks Go to book it in words gets no card asking the group: they are the payer', async () => {
    const base = goaTrip('closed');
    const solo = await moneyKit({ trip: { ...base, people: base.people.slice(0, 1) } });
    try {
      const soloClaims = createClaims(solo.pool, solo.now);
      const ctx = Object.assign(turnCtx('t_goa', solo.server, solo.server.trip('t_goa'), []), { wake: [], turnId: 'turn_solo' });
      const r = await setMandate({ ...solo.deps, claims: soloClaims }, ctx, noCap);
      expect(r).toMatchObject({ cardId: expect.any(String), note: expect.stringMatching(/^Rahul, you're booking Villa Sol, ₹[\d,]+\. /) });
      expect(ctx.cards.map((c) => c.kind)).toEqual(['mandate']);
      expect(await soloClaims.get('t_goa', 'd_villa')).toMatchObject({ personId: 'p_rahul' });
    } finally {
      await solo.drop();
    }
  });
});

describe('the card on the closed vote', () => {
  const closed: DeskItem = { id: 'change:ev_1', tripId: 't_goa', kind: 'trip_change', ref: 'decision:d_villa', dueAt: new Date(), payload: { type: 'decision.closed', decisionId: 'd_villa' } };
  const pack = () => ({ trip: k.server.trip('t_goa'), messages: [], seq: 1 });

  it('rides on the turn that says the vote closed, once, with no line of its own', async () => {
    const rider = claimCardOnClose({ d, claims, packs: packs(), later: new Later() });
    const r = await rider({ tripId: 't_goa', turnId: 'turn_close', wake: [closed], pack: pack() });
    expect(r).toMatchObject({ card: { card_id: 'c_claim_d_villa', title: 'One person books for all' }, line: '' });
    expect(await rider({ tripId: 't_goa', turnId: 'turn_close', wake: [closed], pack: pack() })).not.toBeNull();
    expect(await rider({ tripId: 't_goa', turnId: 'turn_other', wake: [closed], pack: pack() })).toBeNull();
    // Any other turn carries nothing.
    expect(await rider({ tripId: 't_goa', turnId: 'turn_msg', wake: [], pack: pack() })).toBeNull();
  });

  // Ankur, 12 Oct 00:14 IST: a place vote won and money's words came out. A place is the trip's place, never a booking.
  it('never for a place: no claim card, and the closed vote goes to the model for its next step', async () => {
    const offer = k.travel.offer.bind(k.travel);
    Object.assign(k.travel, { offer: async (id: string) => ({ ...(await offer(id))!, offerId: null, kind: 'place' as never, title: 'Denpasar' }) });
    const rider = claimCardOnClose({ d, claims, packs: packs(), later: new Later() });
    expect(await rider({ tripId: 't_goa', turnId: 'turn_close', wake: [closed], pack: pack() })).toBeNull();
    const ctx = turnCtx('t_goa', k.server, k.server.trip('t_goa'));
    expect(await stayClosedAnswer({ d, claims, packs: packs(), later: new Later() })({ tripId: 't_goa', wake: [closed], pack: pack(), ctx })).toBe(false);
    expect(k.server.writesOf('set_mandate')).toEqual([]);
    expect(k.server.writesOf('post_message')).toEqual([]);
  });

  it('never for a winner Go cannot book (a flight), or a vote that already has its payer', async () => {
    k.travel.options.set('opt_villa_sol', 'ixigo:flight:6e-2134');
    k.travel.offers.set('ixigo:flight:6e-2134', { amountMinor: 592000, currency: 'INR', merchant: 'ixigo: IndiGo 6E 2134', refundableUntil: null, title: 'IndiGo 6E 2134', kind: 'flight' });
    const rider = claimCardOnClose({ d, claims, packs: packs(), later: new Later() });
    expect(await rider({ tripId: 't_goa', turnId: 'turn_close', wake: [closed], pack: pack() })).toBeNull();
    const withMandate = { trip: goaTrip('mandate'), messages: [], seq: 1 };
    expect(await rider({ tripId: 't_goa', turnId: 'turn_close', wake: [closed], pack: withMandate })).toBeNull();
  });

  // Saket's test, 11 Oct: a trip of one got "One person books for all" and an I'll book it. Nobody to ask who pays.
  it('a trip of one gets no card: its booking goes up for them by itself, once, opening with the stay', async () => {
    const base = goaTrip('closed');
    const solo = await moneyKit({ trip: { ...base, people: base.people.slice(0, 1), dates: { start: '2026-11-06', end: '2026-11-09' } } });
    try {
      const soloClaims = createClaims(solo.pool, solo.now);
      const later = new Later();
      const soloPack = () => ({ trip: solo.server.trip('t_goa'), messages: [], seq: 1 });
      const deps = { d: { ...solo.deps, claims: soloClaims }, claims: soloClaims, packs: { get: async () => soloPack() }, later };
      // The closed vote's own turn says nothing (its direct answer first, as a turn runs it): the booking's message is the one line.
      const ctx = turnCtx('t_goa', solo.server, solo.server.trip('t_goa'));
      expect(await stayClosedAnswer(deps)({ tripId: 't_goa', wake: [closed], pack: soloPack(), ctx })).toBe(true);
      expect(ctx.lines).toEqual([]);
      const rider = claimCardOnClose(deps);
      expect(await rider({ tripId: 't_goa', turnId: 'turn_close', wake: [closed], pack: soloPack() })).toBeNull();
      // A rerun of the turn starts nothing again.
      expect(await rider({ tripId: 't_goa', turnId: 'turn_close', wake: [closed], pack: soloPack() })).toBeNull();
      await later.settled();
      expect(solo.server.writesOf('set_mandate').map((w) => w.params)).toEqual([expect.objectContaining({ payer_person_id: 'p_rahul' })]);
      const posts = solo.server.writesOf('post_message');
      expect(posts).toHaveLength(1);
      expect(posts[0]?.params).toMatchObject({ text: expect.stringMatching(/^Villa Sol it is\. .*Tap Yes, book it when you're ready\.$/), card: { kind: 'mandate' } });
      expect(String(posts[0]?.params.text)).not.toMatch(/for all|everyone|split|group/i);
      expect(solo.server.cards.has('c_claim_d_villa')).toBe(false);
    } finally {
      await solo.drop();
    }
  });
});

// Saket's test, 11 Oct: the stays vote closed and Go put up his flights card and the stay's I'll book it at once, with
// "tell me when you want the stay booked". The stay comes first; each person's flights once it is booked.
describe('a closed stays vote, alone on the turn', () => {
  const closed: DeskItem = { id: 'change:ev_1', tripId: 't_goa', kind: 'trip_change', ref: 'decision:d_villa', dueAt: new Date(), payload: { type: 'decision.closed', decisionId: 'd_villa' } };
  const pack = () => ({ trip: k.server.trip('t_goa'), messages: [], seq: 1 });

  it('saves the stay and says one plain line, the card riding on it: no model round, no flights, no "tell me when"', async () => {
    const ctx = turnCtx('t_goa', k.server, k.server.trip('t_goa'));
    const answer = stayClosedAnswer({ d, claims, packs: packs(), later: new Later() });
    expect(await answer({ tripId: 't_goa', wake: [closed], pack: pack(), ctx })).toBe(true);
    expect(ctx.lines).toEqual(["Villa Sol it is. Tap I'll book it to book it."]);
    expect(k.server.writesOf('update_trip').map((w) => w.params)).toEqual([expect.objectContaining({ trip_id: 't_goa', stay: 'Villa Sol' })]);
    // The claim card rides on that line (claimCardOnClose), on the same turn.
    const rider = claimCardOnClose({ d, claims, packs: packs(), later: new Later() });
    expect(await rider({ tripId: 't_goa', turnId: ctx.turnId, wake: [closed], pack: pack() })).toMatchObject({ card: { card_id: 'c_claim_d_villa' } });
  });

  it('leaves anything else to the model: something else on the turn, or a winner Go cannot book', async () => {
    const answer = stayClosedAnswer({ d, claims, packs: packs(), later: new Later() });
    const said: DeskItem = { id: 'msg:m_1', tripId: 't_goa', kind: 'message', ref: 'm_1', dueAt: new Date(), payload: {} };
    expect(await answer({ tripId: 't_goa', wake: [closed, said], pack: pack(), ctx: turnCtx('t_goa', k.server, k.server.trip('t_goa')) })).toBe(false);
    k.travel.options.set('opt_villa_sol', 'ixigo:flight:6e-2134');
    k.travel.offers.set('ixigo:flight:6e-2134', { amountMinor: 592000, currency: 'INR', merchant: 'ixigo: IndiGo 6E 2134', refundableUntil: null, title: 'IndiGo 6E 2134', kind: 'flight' });
    expect(await answer({ tripId: 't_goa', wake: [closed], pack: pack(), ctx: turnCtx('t_goa', k.server, k.server.trip('t_goa')) })).toBe(false);
    expect(k.server.writesOf('update_trip')).toEqual([]);
  });
});
