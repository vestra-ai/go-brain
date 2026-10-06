import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as C from '@go/contract';
import { SAY_NOTHING } from '../../composer/tools.js';
import { withSchema } from '../../db/test-db.js';
import { makeLaneBrain, type LaneBrain } from '../../tasks/testing/lane-brain.js';
import { FakeIxigoStore } from '../fake-ixigo/data.js';
import { createImages } from '../images.js';
import { createTravelLayer } from '../layer.js';
import { createFakeTravel } from '../mcp-travel.js';
import { createResultsStore, type ResultsStore } from '../results.js';
import { travelTools } from '../tools.js';
import type { Travel } from '../travel.js';

let db: Awaited<ReturnType<typeof withSchema>>;
let lb: LaneBrain;
let results: ResultsStore;
let travel: Travel;

beforeAll(async () => {
  db = await withSchema();
  lb = makeLaneBrain({ pool: db.pool });
  results = createResultsStore(db.pool);
  const store = new FakeIxigoStore({ now: lb.clock.now });
  travel = createTravelLayer({ switches: lb.switches, now: lb.clock.now, fake: createFakeTravel({ store, now: lb.clock.now, payRail: () => 'fake' }), ixigo: null, results });
  for (const t of travelTools({ travel, results, images: createImages({ pool: db.pool, publicUrl: 'https://go.test' }), now: lb.clock.now })) lb.tools.register(t);
});
afterAll(async () => {
  await db.drop();
});

const FLIGHTS = { from: 'Delhi', to: 'Goa', date: '2026-11-06', depart_after: '18:00' };
const STAYS = { area: 'North Goa', check_in: '2026-11-06', check_out: '2026-11-09', guests: 5, must_have: ['pool', 'beach'] };

describe('search tools', () => {
  it("search_flights applies Arjun's 6 pm in code and answers compact, priced, dated results", async () => {
    const out = (await lb.tools.run('search_flights', FLIGHTS, lb.ctx({ turnId: 'turn_s1' }))) as any;
    expect(out.count).toBe(4);
    expect(out.checked).toBe('just now');
    expect(out.results[0]).toMatchObject({ n: 1, title: 'IndiGo 6E 2134', when: '6:10 pm to 8:45 pm, non-stop', price: '₹5,920 per person' });
    expect(out.results.map((r: { title: string }) => r.title)).not.toContain('Akasa Air QP 1846');
    expect(out.card).toEqual({ results_id: out.results_id, option_numbers: [1, 2, 3], title: 'Flights, Delhi to Goa' });
    const saved = await results.get('t_goa', out.results_id);
    expect(saved?.options.every((o) => (o.journey?.depart_at.slice(11, 16) ?? '') >= '18:00')).toBe(true);
  });

  it("refuses a check-in before today without a word to the room, naming this year's date, and that date goes through", async () => {
    const past = (await lb.tools.run('search_stays', { ...STAYS, check_in: '2025-11-06', check_out: '2025-11-09' }, lb.ctx({ turnId: 'turn_past1' }))) as any;
    expect(past).toMatchObject({ count: 0, tell_the_room: SAY_NOTHING });
    expect(past.refused).toContain("Use this year's or next year's date, such as 2026-11-06");
    expect(past.results_id).toBeUndefined();
    const next = (await lb.tools.run('search_stays', STAYS, lb.ctx({ turnId: 'turn_past2' }))) as any;
    expect(next.count).toBeGreaterThan(0);
  });

  it('says how old a cached check is', async () => {
    lb.clock.advance(120_000);
    const out = (await lb.tools.run('search_flights', FLIGHTS, lb.ctx({ turnId: 'turn_s2' }))) as any;
    expect(out.checked).toBe('2 min ago');
    lb.clock.advance(-120_000);
  });

  it('search_stays keeps villas with a pool near the beach for everyone, and answers plainly when nothing fits', async () => {
    const out = (await lb.tools.run('search_stays', STAYS, lb.ctx({ turnId: 'turn_s3' }))) as any;
    expect(out.results.map((r: { title: string }) => r.title)).toEqual(['Casa Mareia', 'Villa Sol', 'The Palms Villa', 'Ocean Breeze Villa']);
    expect(out.results[1]).toMatchObject({ price: '₹12,800 per night', total: '₹38,400 for 3 nights' });
    const missing = (await lb.tools.run('search_stays', { ...STAYS, max_price_per_night: 5000 }, lb.ctx())) as any;
    expect(missing.count).toBe(0);
    expect(missing.note).toContain('Nothing matched');
  });

  it('search_trains and search_buses answer journeys, and nothing that misses arrive_before', async () => {
    const trains = (await lb.tools.run('search_trains', { from: 'Delhi', to: 'Goa', date: '2026-11-06' }, lb.ctx({ turnId: 'turn_t1' }))) as any;
    expect(trains.count).toBe(6);
    expect(trains.card.title).toBe('Trains, Delhi to Goa');
    const late = (await lb.tools.run('search_trains', { from: 'Delhi', to: 'Goa', date: '2026-11-06', arrive_before: '09:00' }, lb.ctx())) as any;
    expect(late.count).toBe(0);
    const buses = (await lb.tools.run('search_buses', { from: 'Mumbai', to: 'Goa', date: '2026-11-06' }, lb.ctx({ turnId: 'turn_b1' }))) as any;
    expect(buses.results.map((r: { title: string }) => r.title)).toEqual(['Kadamba Transport (KTCL)', 'Paulo Travels', 'Neeta Tours and Travels']);
  });
});

describe('show_options', () => {
  it('puts a valid options card built from the saved set into ctx.cards, with re-hosted images, so it rides with the message', async () => {
    const found = (await lb.tools.run('search_stays', STAYS, lb.ctx({ turnId: 'turn_o1' }))) as any;
    const ctx = lb.ctx({ turnId: 'turn_o2' });
    const posts = lb.link.sent('post_message').length;
    const shown = (await lb.tools.run('show_options', { results_id: found.results_id, option_numbers: [2, 3, 4], title: 'Villas with a pool in North Goa' }, ctx)) as any;
    expect(shown.card_id).toBe('c_opt_turn_o2_1');
    expect(ctx.cards).toHaveLength(1);
    const card = C.OptionsCard.parse(ctx.cards[0]);
    expect(card.card_id).toBe(shown.card_id);
    expect(card.options.map((o) => o.title)).toEqual(['Villa Sol', 'The Palms Villa', 'Ocean Breeze Villa']);
    expect(card.options[0]).toMatchObject({ price_minor: 1280000, price_note: 'per night', subtitle: 'Anjuna, ₹38,400 for 3 nights' });
    expect(card.options[0]!.image_url).toMatch(/^https:\/\/go\.test\/img\/u[0-9a-f]{32}\.jpg$/);
    expect(lb.link.sent('post_message')).toHaveLength(posts);
    expect(await travel.offer(card.options[0]!.option_id)).toEqual({ offerId: 'fake:st-villa-sol-anjuna-20261106-20261109-5', title: 'Villa Sol', priceMinor: 3840000, currency: 'INR', kind: 'stay', link: null });
    expect(await results.offer(card.options[0]!.option_id)).toMatchObject({ n: 1, totalMinor: 3840000, priceMinor: 1280000 });
  });

  it('gives the same card when the same turn runs again, and keeps one set of offers', async () => {
    const found = (await lb.tools.run('search_flights', FLIGHTS, lb.ctx({ turnId: 'turn_r1' }))) as any;
    const args = { results_id: found.results_id, title: 'Friday flights, Delhi to Goa' };
    const first = lb.ctx({ turnId: 'turn_r2' });
    const again = lb.ctx({ turnId: 'turn_r2' });
    await lb.tools.run('show_options', args, first);
    await lb.tools.run('show_options', args, again);
    expect(again.cards).toEqual(first.cards);
    expect(await results.offersOnCard('c_opt_turn_r2_1')).toHaveLength(3);
  });

  it('shows the card it saved first when a rerun of the same turn asks for other options, so the card always matches its offers', async () => {
    const found = (await lb.tools.run('search_stays', STAYS, lb.ctx({ turnId: 'turn_c1' }))) as any;
    const first = lb.ctx({ turnId: 'turn_c2' });
    await lb.tools.run('show_options', { results_id: found.results_id, option_numbers: [1, 2], title: 'Two villas' }, first);
    const again = lb.ctx({ turnId: 'turn_c2' });
    const out = (await lb.tools.run('show_options', { results_id: found.results_id, option_numbers: [3, 4], title: 'Two other villas' }, again)) as any;
    expect(out.shown).toBe(2);
    expect(again.cards).toEqual(first.cards);
    const card = C.OptionsCard.parse(again.cards[0]);
    expect(card.title).toBe('Two villas');
    const offers = await results.offersOnCard(card.card_id);
    expect(offers.map((o) => [o.optionId, o.title])).toEqual(card.options.map((o) => [o.option_id, o.title]));
  });

  it("refuses results it does not have, or another trip's", async () => {
    const other = await results.save({ tripId: 't_other', optionKind: 'flight', source: 'search', query: {}, options: [], checkedAt: '2026-10-07T12:00:00.000Z' });
    expect(await lb.tools.run('show_options', { results_id: other.resultsId, title: 'x' }, lb.ctx())).toMatchObject({ error: 'unknown_results' });
    expect(await lb.tools.run('show_options', { results_id: 'r_nope', title: 'x' }, lb.ctx())).toMatchObject({ error: 'unknown_results' });
  });
});

describe('put_to_vote', () => {
  it('opens one vote with option_ref set to each option id and the whole-stay price, and puts the vote card in ctx.cards', async () => {
    const found = (await lb.tools.run('search_stays', STAYS, lb.ctx({ turnId: 'turn_v1' }))) as any;
    const showCtx = lb.ctx({ turnId: 'turn_v2' });
    const shown = (await lb.tools.run('show_options', { results_id: found.results_id, title: 'Villas' }, showCtx)) as any;
    const card = C.OptionsCard.parse(showCtx.cards[0]);
    const ctx = lb.ctx({ turnId: 'turn_v3' });
    const out = (await lb.tools.run('put_to_vote', { card_id: shown.card_id, closes_in_hours: 2 }, ctx)) as any;
    const vote = lb.link.sent('open_vote').at(-1)!;
    expect(vote).toMatchObject({ request_id: 'go_vote_turn_v3_1', question: 'Where do we stay?', kind: 'choice', anonymous: false, closes_at: '2026-10-07T14:00:00.000Z' });
    expect((vote.options as Array<{ option_ref: string }>).map((o) => o.option_ref)).toEqual(card.options.map((o) => o.option_id));
    expect((vote.options as Array<{ price_minor: number }>)[0]!.price_minor).toBe(card.options[0]!.price_minor! * 3);
    expect(ctx.cards).toEqual([expect.objectContaining({ kind: 'vote', card_id: 'c_vote_turn_v3_1', decision_id: out.decision_id })]);
    expect((ctx.cards[0] as { fallback_text: string }).fallback_text).toMatch(/^Vote: Where do we stay\?/);
  });

  it('shows the same vote again when the same turn runs again, and refuses a second vote from another turn', async () => {
    const found = (await lb.tools.run('search_stays', STAYS, lb.ctx({ turnId: 'turn_w1' }))) as any;
    const shown = (await lb.tools.run('show_options', { results_id: found.results_id, title: 'Villas' }, lb.ctx({ turnId: 'turn_w2' }))) as any;
    const first = lb.ctx({ turnId: 'turn_w3' });
    const a = (await lb.tools.run('put_to_vote', { card_id: shown.card_id }, first)) as any;
    const opened = lb.link.sent('open_vote').length;
    const rerun = lb.ctx({ turnId: 'turn_w3' });
    const b = (await lb.tools.run('put_to_vote', { card_id: shown.card_id }, rerun)) as any;
    expect(b.decision_id).toBe(a.decision_id);
    expect(rerun.cards).toEqual(first.cards);
    expect(lb.link.sent('open_vote')).toHaveLength(opened);
    expect(await lb.tools.run('put_to_vote', { card_id: shown.card_id }, lb.ctx({ turnId: 'turn_w4' }))).toMatchObject({ error: 'already_voting', decision_id: a.decision_id });
  });

  it('with no card_id, votes on the options card shown earlier in the same reply', async () => {
    const found = (await lb.tools.run('search_stays', STAYS, lb.ctx({ turnId: 'turn_r1' }))) as any;
    const reply = lb.ctx({ turnId: 'turn_r2' });
    await lb.tools.run('show_options', { results_id: found.results_id, title: 'Villas' }, reply);
    const out = (await lb.tools.run('put_to_vote', {}, reply)) as any;
    expect(out.decision_id).toBeDefined();
    const card = C.OptionsCard.parse(reply.cards[0]);
    const vote = lb.link.sent('open_vote').at(-1)!;
    expect((vote.options as Array<{ option_ref: string }>).map((o) => o.option_ref)).toEqual(card.options.map((o) => o.option_id));
    expect(reply.cards.map((c) => c.kind)).toEqual(['options', 'vote']);
  });

  it('with no card_id, refuses when the reply showed two options cards, or none, and opens nothing', async () => {
    const found = (await lb.tools.run('search_stays', STAYS, lb.ctx({ turnId: 'turn_r3' }))) as any;
    const two = lb.ctx({ turnId: 'turn_r4' });
    await lb.tools.run('show_options', { results_id: found.results_id, option_numbers: [1, 2], title: 'Two villas' }, two);
    await lb.tools.run('show_options', { results_id: found.results_id, option_numbers: [3, 4], title: 'Two more villas' }, two);
    const opened = lb.link.sent('open_vote').length;
    expect(await lb.tools.run('put_to_vote', {}, two)).toMatchObject({ error: 'which_card' });
    expect(await lb.tools.run('put_to_vote', {}, lb.ctx({ turnId: 'turn_r5' }))).toMatchObject({ error: 'no_card' });
    expect(lb.link.sent('open_vote')).toHaveLength(opened);
    expect(two.cards.map((c) => c.kind)).toEqual(['options', 'options']);
  });

  it('puts trains to a vote at their per-person fares, each option answering travel.offer as a train, which is never booked for the group', async () => {
    const found = (await lb.tools.run('search_trains', { from: 'Delhi', to: 'Goa', date: '2026-11-06' }, lb.ctx({ turnId: 'turn_tr1' }))) as any;
    const showCtx = lb.ctx({ turnId: 'turn_tr2' });
    const shown = (await lb.tools.run('show_options', { results_id: found.results_id, title: 'Trains to Goa' }, showCtx)) as any;
    const card = C.OptionsCard.parse(showCtx.cards[0]);
    expect(card.option_kind).toBe('train');
    const out = (await lb.tools.run('put_to_vote', { card_id: shown.card_id }, lb.ctx({ turnId: 'turn_tr3' }))) as any;
    expect(out.decision_id).toBeDefined();
    const vote = lb.link.sent('open_vote').at(-1)!;
    expect(vote).toMatchObject({ question: 'Which train?' });
    expect((vote.options as Array<{ price_minor: number }>).map((o) => o.price_minor)).toEqual(card.options.map((o) => o.price_minor));
    // P5 reads the kind and refuses group journeys: a train is searchable and votable, never paid for here.
    expect((await travel.offer(card.options[0]!.option_id))?.kind).toBe('train');
  });
});
