import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as C from '@go/contract';
import { CARD_LINE } from '../../composer/rules.js';
import { SAY_NOTHING } from '../../composer/tools.js';
import { withSchema } from '../../db/test-db.js';
import { msg } from '../../__tests__/fixtures/goa.js';
import { goaPack } from '../../tasks/testing/goa.js';
import { makeLaneBrain, type LaneBrain } from '../../tasks/testing/lane-brain.js';
import { FakeIxigoStore } from '../fake-ixigo/data.js';
import { createImages } from '../images.js';
import { createTravelLayer } from '../layer.js';
import { createFakeTravel } from '../mcp-travel.js';
import { createResultsStore, type ResultsStore } from '../results.js';
import { compactOption, searchAnswer, searchRoundSummary, travelTools } from '../tools.js';
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
    // The fake gives 7 that sleep 5; none is under ₹5,000 a night.
    expect(missing.summary).toMatch(/^None of the 7 stays in North Goa, 2026-11-06 to 2026-11-09 fits at most ₹5,000 a night, sleeping 5, with a pool and within 10 minutes of the beach\. Closest: /);
    expect(missing.note).toContain('keeping every condition in it');
  });

  it('nothing fits a pool villa under ₹10,000 a night: the summary keeps the pool and names the closest miss and why', async () => {
    const none = (await lb.tools.run(
      'search_stays',
      { area: 'North Goa', check_in: '2026-11-06', check_out: '2026-11-09', must_have: ['pool'], max_price_per_night: 10000 },
      lb.ctx({ turnId: 'turn_pf1' }),
    )) as any;
    expect(none).toMatchObject({ count: 0, search: 'stays in North Goa, 2026-11-06 to 2026-11-09, at most ₹10,000 a night, with a pool' });
    // The ₹9,800 villa the next search can show is named here, with the pool it lacks, so "nothing at ₹8 to 10k" cannot be said.
    expect(none.summary).toBe(
      'None of the 8 stays in North Goa, 2026-11-06 to 2026-11-09 fits at most ₹10,000 a night and with a pool. Closest: Saudade Villa (Parra), ₹9,800 per night, but no pool.',
    );
    expect(none.results_id).toBeUndefined();
  });

  it('an area with no stays at all says nothing came back, not that nothing fit', async () => {
    const none = (await lb.tools.run('search_stays', { area: 'Calangute', check_in: '2026-11-06', check_out: '2026-11-09' }, lb.ctx({ turnId: 'turn_pf2' }))) as any;
    expect(none).toMatchObject({ count: 0, summary: 'Nothing came back: there are no stays in Calangute, 2026-11-06 to 2026-11-09 at all.' });
  });

  it('every stay carries its own area as the data gives it, and the summary names the areas and the price range', async () => {
    const out = (await lb.tools.run('search_stays', STAYS, lb.ctx({ turnId: 'turn_pf3' }))) as any;
    expect(out.results.map((r: { title: string; area: string }) => [r.title, r.area])).toEqual([
      ['Casa Mareia', 'Morjim'], ['Villa Sol', 'Anjuna'], ['The Palms Villa', 'Vagator'], ['Ocean Breeze Villa', 'Candolim'],
    ]);
    expect(out.summary).toBe(
      '4 of the 7 stays in North Goa, 2026-11-06 to 2026-11-09 fit sleeping 5, with a pool and within 10 minutes of the beach: ₹12,200 to ₹16,900 per night, in Morjim, Anjuna, Vagator and Candolim.',
    );
    expect(out.note).toContain("Each option's area, time and price are as given here: name no other");
    // The option's area wins over the asker's words.
    expect(out.note).toContain("If someone asked for a place an option is not in, say the option's own area: asked for Calangute, a villa in Vagator is in Vagator.");
    // The line shown with these options is the finished answer to whoever asked (re-drill 5: "Priya said 4… Picking the best few").
    expect(out.note).toContain(CARD_LINE);
    // A stay the data gives no area for says so, rather than leaving the model to fill one in.
    expect(compactOption(1, { kind: 'stay', title: 'Somewhere', priceMinor: 900000, priceNote: 'per night', highlights: [], facts: {} })).toMatchObject({ area: 'not in the data' });
  });

  it('flights carry their route, and a search with no conditions just counts what came back', async () => {
    const out = (await lb.tools.run('search_flights', { from: 'Delhi', to: 'Goa', date: '2026-11-06' }, lb.ctx({ turnId: 'turn_pf4' }))) as any;
    expect(out.results[0]).toMatchObject({ route: expect.stringMatching(/ to /) });
    expect(out.summary).toMatch(new RegExp(`^${out.count} flights from Delhi to Goa on 2026-11-06: ₹[\\d,]+ to ₹[\\d,]+ per person\\.$`));
  });
  it('search_trains and search_buses answer journeys, and nothing that misses arrive_before', async () => {
    const trains = (await lb.tools.run('search_trains', { from: 'Delhi', to: 'Goa', date: '2026-11-06' }, lb.ctx({ turnId: 'turn_t1' }))) as any;
    expect(trains.count).toBe(6);
    expect(trains.card.title).toBe('Trains, Delhi to Goa, 6 Nov');
    const late = (await lb.tools.run('search_trains', { from: 'Delhi', to: 'Goa', date: '2026-11-06', arrive_before: '09:00' }, lb.ctx())) as any;
    expect(late.count).toBe(0);
    const buses = (await lb.tools.run('search_buses', { from: 'Mumbai', to: 'Goa', date: '2026-11-06' }, lb.ctx({ turnId: 'turn_b1' }))) as any;
    expect(buses.results.map((r: { title: string }) => r.title)).toEqual(['Kadamba Transport (KTCL)', 'Paulo Travels', 'Neeta Tours and Travels']);
  });
});

describe('a train list', () => {
  it('counts trains, not a train once a class: one train in four classes is one train with four fares, on the day the card names', async () => {
    const fare = (cls: string) => ({
      kind: 'train' as const, title: 'Mandovi Express 10103', priceMinor: 100_000, currency: 'INR', priceNote: `per person, ${cls}`, highlights: [], facts: { class_code: cls },
      journey: { mode: 'train' as const, origin: { name: 'Mumbai CSMT' }, destination: { name: 'Madgaon' }, depart_at: '2026-11-06T07:10:00+05:30', arrive_at: '2026-11-06T19:00:00+05:30', number: '10103' },
    });
    const found = { results: ['SL', '3A', '2A', '1A'].map(fare), checkedAt: '2026-10-07T12:00:00.000Z', found: 4 };
    const results = { save: async () => ({ resultsId: 'r_t' }) } as unknown as ResultsStore;
    const out = await searchAnswer('trains', { from: 'Mumbai', to: 'Goa', date: '2026-11-06' }, found, 't_goa', { results, now: () => new Date('2026-10-07T12:00:00Z') });
    expect(out.summary).toBe('1 train from Mumbai to Goa on 2026-11-06 (4 fares by class): ₹1,000 per person, SL.');
    expect(out.card?.title).toBe('Trains, Mumbai to Goa, 6 Nov');
  });
});

describe('a count in a summary', () => {
  const results = { save: async () => ({ resultsId: 'r_c' }) } as unknown as ResultsStore;
  const now = () => new Date('2026-10-07T12:00:00Z');
  const stay = (title: string) => ({ kind: 'stay' as const, title, priceMinor: 900_000, currency: 'INR', priceNote: 'per night', highlights: [], facts: { area: 'Anjuna' } });
  const bus = { kind: 'bus' as const, title: 'Paulo Travels', priceMinor: 270_000, currency: 'INR', priceNote: 'per seat, from', highlights: [], facts: {} };
  const STAYS = { area: 'Anjuna', checkIn: '2026-11-06', checkOut: '2026-11-09' };

  it('agrees with its noun, one or many: 1 stay, 1 bus, 1 of the 7 stays fits, the one stay that does not', async () => {
    const say = async (kind: 'stays' | 'buses', q: Record<string, unknown>, found: Record<string, unknown>) =>
      (await searchAnswer(kind, q as never, { checkedAt: '2026-10-07T12:00:00.000Z', ...found } as never, 't_goa', { results, now })).summary;
    expect(await say('stays', STAYS, { results: [stay('Villa Sol')], found: 1 })).toBe('1 stay in Anjuna, 2026-11-06 to 2026-11-09: ₹9,000 per night, in Anjuna.');
    expect(await say('stays', STAYS, { results: [stay('Villa Sol'), stay('Casa Mareia')], found: 2 })).toBe('2 stays in Anjuna, 2026-11-06 to 2026-11-09: ₹9,000 per night, in Anjuna.');
    expect(await say('buses', { from: 'Mumbai', to: 'Goa', date: '2026-11-06' }, { results: [bus], found: 1 })).toBe('1 bus from Mumbai to Goa on 2026-11-06: ₹2,700 per seat, from.');
    expect(await say('stays', { ...STAYS, mustHave: ['pool'] }, { results: [stay('Villa Sol')], found: 7 })).toBe('1 of the 7 stays in Anjuna, 2026-11-06 to 2026-11-09 fits with a pool: ₹9,000 per night, in Anjuna.');
    expect(await say('stays', { ...STAYS, mustHave: ['pool'] }, { results: [], found: 1 })).toBe("The one stay in Anjuna, 2026-11-06 to 2026-11-09 doesn't fit with a pool.");
  });
});

describe('a reply of several searches', () => {
  it('says how many came back with options, and which found nothing or failed, so prose can only count what came back', () => {
    const line = searchRoundSummary([
      { content: JSON.stringify({ search: 'flights from Delhi to Goa on 2026-11-06, leaving after 6:00 pm', count: 4 }), isError: false },
      { content: JSON.stringify({ search: 'flights from Mumbai to Goa on 2026-11-06', count: 0, summary: 'Nothing came back.' }), isError: false },
      { content: JSON.stringify({ search: 'flights from Pune to Goa on 2026-11-06', count: 0, error: 'unreachable' }), isError: false },
    ]);
    expect(line).toBe(
      '1 of 3 searches came back with options: flights from Delhi to Goa on 2026-11-06, leaving after 6:00 pm (4). ' +
        'Nothing came back for flights from Mumbai to Goa on 2026-11-06. Failed: flights from Pune to Goa on 2026-11-06. Count only what came back.',
    );
    expect(searchRoundSummary([{ content: 'socket timeout', isError: true }, { content: JSON.stringify({ search: 'stays in Goa', count: 3 }), isError: false }])).toBe(
      '1 of 2 searches came back with options: stays in Goa (3). Failed: one search. Count only what came back.',
    );
  });
});

describe('a search that answers itself', () => {
  /** The turn woke for one message to Go, and this search is the only tool of its round. */
  const turnFor = (text: string, turnId: string) => {
    const line = msg(90, 'p_rahul', text);
    return lb.ctx({
      turnId, pack: { ...goaPack(), messages: [...goaPack().messages, line] }, roundTools: ['search_stays'],
      wake: [{ id: `msg:t_goa:${line.message_id}`, tripId: 't_goa', kind: 'message', ref: line.message_id, dueAt: new Date(), payload: { messageId: line.message_id, seq: 90, namesGo: true } }],
    });
  };

  it("puts up the card and a line from its data for the turn's plain ask, and ends the turn: no model round after it", async () => {
    const ctx = turnFor('@Go villas with a pool in North Goa near the beach for 5 of us', 'turn_s1');
    const out = (await lb.tools.run('search_stays', STAYS, ctx)) as any;
    expect(out).toMatchObject({ answered: true, card_id: 'c_opt_turn_s1_1' });
    expect(ctx.answered).toBe(true);
    const card = C.OptionsCard.parse(ctx.cards[0]);
    expect(card.options.map((o) => o.title)).toEqual(['Casa Mareia', 'Villa Sol', 'The Palms Villa']);
    expect(ctx.lines).toHaveLength(1);
    expect(ctx.lines[0]).toMatch(/^Pool stays in North Goa for 6 to 9 Nov, .+, from ₹[\d,]+ a night\.$/);
    // No count of the card's options: price and scope only.
    expect(ctx.lines[0]).not.toMatch(/\b\d+ (pool )?stays\b/i);
    expect(card.actions?.map((a) => a.action_id)).toEqual(['pick', 'vote']);
  });

  it('gives the model the list as before when the ask needs judgement, so a question is never swallowed', async () => {
    const ctx = turnFor('@Go villas with a pool in North Goa near the beach for 5 of us, which has the best reviews?', 'turn_s2');
    const out = (await lb.tools.run('search_stays', STAYS, ctx)) as any;
    expect(out).toMatchObject({ count: expect.any(Number), results_id: expect.any(String) });
    expect(out.answered).toBeUndefined();
    expect(ctx.cards).toEqual([]);
    expect(ctx.answered).toBeUndefined();
  });
});

describe('show_options', () => {
  it('puts a valid options card built from the saved set into ctx.cards, with re-hosted images, so it rides with the message', async () => {
    const found = (await lb.tools.run('search_stays', STAYS, lb.ctx({ turnId: 'turn_o1' }))) as any;
    const ctx = lb.ctx({ turnId: 'turn_o2' });
    const posts = lb.link.sent('post_message').length;
    const shown = (await lb.tools.run('show_options', { line: 'Here are the villas.', results_id: found.results_id, option_numbers: [2, 3, 4], title: 'Villas with a pool in North Goa' }, ctx)) as any;
    expect(shown.card_id).toBe('c_opt_turn_o2_1');
    expect(ctx.cards).toHaveLength(1);
    // Its line is the words posted with it (the model's free text in that reply never is).
    expect(ctx.lines).toEqual(['Here are the villas.']);
    const card = C.OptionsCard.parse(ctx.cards[0]);
    expect(card.card_id).toBe(shown.card_id);
    expect(card.options.map((o) => o.title)).toEqual(['Villa Sol', 'The Palms Villa', 'Ocean Breeze Villa']);
    expect(card.options[0]).toMatchObject({ price_minor: 1280000, price_note: 'per night', subtitle: 'Anjuna, ₹38,400 for 3 nights' });
    expect(card.options[0]!.image_url).toMatch(/^https:\/\/go\.test\/img\/u[0-9a-f]{32}\.jpg$/);
    expect(lb.link.sent('post_message')).toHaveLength(posts);
    // The day it is for (its search's check-in), so a vote that outlives it is refused, never booked (#264).
    expect(await travel.offer(card.options[0]!.option_id)).toEqual({ offerId: 'fake:st-villa-sol-anjuna-20261106-20261109-5', title: 'Villa Sol', priceMinor: 3840000, currency: 'INR', kind: 'stay', link: null, day: '2026-11-06' });
    expect(await results.offer(card.options[0]!.option_id)).toMatchObject({ n: 1, totalMinor: 3840000, priceMinor: 1280000 });
  });

  it('a stays card asks for a budget while nobody in the trip has a band, and not once someone has one', async () => {
    const found = (await lb.tools.run('search_stays', STAYS, lb.ctx({ turnId: 'turn_b1' }))) as any;
    const pack = goaPack();
    const noBand = lb.ctx({ turnId: 'turn_b2', pack: { ...pack, trip: { ...pack.trip, budget: { answered: 0, of: 5 } } } });
    await lb.tools.run('show_options', { line: 'Here are the villas.', results_id: found.results_id, option_numbers: [1, 2, 3], title: 'Villas with a pool' }, noBand);
    expect(C.OptionsCard.parse(noBand.cards[0]).actions?.map((a) => a.action_id)).toEqual(['pick', 'vote', 'add_budget']);
    const withBand = lb.ctx({ turnId: 'turn_b3' });
    await lb.tools.run('show_options', { line: 'Here are the villas.', results_id: found.results_id, option_numbers: [1, 2, 3], title: 'Villas with a pool' }, withBand);
    expect(C.OptionsCard.parse(withBand.cards[0]).actions?.map((a) => a.action_id)).not.toContain('add_budget');
  });

  it('gives the same card when the same turn runs again, and keeps one set of offers', async () => {
    const found = (await lb.tools.run('search_flights', FLIGHTS, lb.ctx({ turnId: 'turn_r1' }))) as any;
    const args = { line: 'Friday evening flights.', results_id: found.results_id, title: 'Friday flights, Delhi to Goa' };
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
    await lb.tools.run('show_options', { line: 'Here are the villas.', results_id: found.results_id, option_numbers: [1, 2], title: 'Two villas' }, first);
    const again = lb.ctx({ turnId: 'turn_c2' });
    const out = (await lb.tools.run('show_options', { line: 'Here are the villas.', results_id: found.results_id, option_numbers: [3, 4], title: 'Two other villas' }, again)) as any;
    expect(out.shown).toBe(2);
    expect(again.cards).toEqual(first.cards);
    const card = C.OptionsCard.parse(again.cards[0]);
    expect(card.title).toBe('Two villas');
    const offers = await results.offersOnCard(card.card_id);
    expect(offers.map((o) => [o.optionId, o.title])).toEqual(card.options.map((o) => [o.option_id, o.title]));
  });

  it('titles ixigo.com stays from the search when the title names villas they are not, and keeps it when every one is (re-drill 6)', async () => {
    const stay = (title: string, area: string) => ({
      kind: 'stay' as const, title, priceMinor: 900_000, currency: 'INR', priceNote: 'per night, per room', highlights: ['Pool'], facts: { area, pool: true },
      sourceUrl: `https://www.ixigo.com/hotels/1/details?hName=${encodeURIComponent(title)}`,
    });
    const query = { area: 'north goa', checkIn: '2026-11-06', checkOut: '2026-11-09', mustHave: ['pool'] };
    const show = async (options: ReturnType<typeof stay>[], title: string, turnId: string) => {
      const set = await results.save({ tripId: 't_goa', optionKind: 'stay', source: 'search', query, options, checkedAt: '2026-10-07T12:00:00.000Z' });
      const ctx = lb.ctx({ turnId });
      await lb.tools.run('show_options', { line: 'Here are the stays.', results_id: set.resultsId, title }, ctx);
      return C.OptionsCard.parse(ctx.cards[0]).title;
    };
    const hotels = [stay('Meritas Auberge Calangute Goa', 'Candolim'), stay('3102bce - A Vedic Resort', 'Vagator'), stay('Villa Mandrem', 'Mandrem')];
    expect(await show(hotels, 'Pool villas in North Goa', 'turn_t1')).toBe('Stays with a pool in North Goa');
    expect(await show(hotels, 'Resorts with a pool', 'turn_t2')).toBe('Stays with a pool in North Goa');
    // Every option a villa by its name, or a title that names no kind of place: the model's title stands.
    expect(await show([stay('Villa Mandrem', 'Mandrem'), stay('The Palms Villa', 'Vagator')], 'Pool villas in North Goa', 'turn_t3')).toBe('Pool villas in North Goa');
    expect(await show(hotels, 'Top picks near the beach', 'turn_t4')).toBe('Top picks near the beach');
  });

  it("refuses results it does not have, or another trip's", async () => {
    const other = await results.save({ tripId: 't_other', optionKind: 'flight', source: 'search', query: {}, options: [], checkedAt: '2026-10-07T12:00:00.000Z' });
    expect(await lb.tools.run('show_options', { line: 'Here are the villas.', results_id: other.resultsId, title: 'x' }, lb.ctx())).toMatchObject({ error: 'unknown_results' });
    const none = lb.ctx();
    expect(await lb.tools.run('show_options', { line: 'Here are the villas.', results_id: 'r_nope', title: 'x' }, none)).toMatchObject({ error: 'unknown_results' });
    // No card went up, so its line goes nowhere.
    expect(none.lines).toEqual([]);
  });

  it('takes a line, the message posted with the card, and refuses a call without one', async () => {
    const found = (await lb.tools.run('search_stays', STAYS, lb.ctx({ turnId: 'turn_l1' }))) as any;
    await expect(lb.tools.run('show_options', { results_id: found.results_id, title: 'Villas' }, lb.ctx({ turnId: 'turn_l2' }))).rejects.toThrow(/line/);
  });
});

describe('put_to_vote', () => {
  it('opens one vote with option_ref set to each option id and the whole-stay price, and puts the vote card in ctx.cards', async () => {
    const found = (await lb.tools.run('search_stays', STAYS, lb.ctx({ turnId: 'turn_v1' }))) as any;
    const showCtx = lb.ctx({ turnId: 'turn_v2' });
    const shown = (await lb.tools.run('show_options', { line: 'Here are the villas.', results_id: found.results_id, title: 'Villas' }, showCtx)) as any;
    const card = C.OptionsCard.parse(showCtx.cards[0]);
    const ctx = lb.ctx({ turnId: 'turn_v3' });
    const out = (await lb.tools.run('put_to_vote', { line: 'Vote is up.', card_id: shown.card_id, closes_in_hours: 2 }, ctx)) as any;
    const vote = lb.link.sent('open_vote').at(-1)!;
    expect(vote).toMatchObject({ request_id: 'go_vote_turn_v3_1', question: 'Where do we stay?', kind: 'choice', anonymous: false, closes_at: '2026-10-07T14:00:00.000Z' });
    expect((vote.options as Array<{ option_ref: string }>).map((o) => o.option_ref)).toEqual(card.options.map((o) => o.option_id));
    expect((vote.options as Array<{ price_minor: number }>)[0]!.price_minor).toBe(card.options[0]!.price_minor! * 3);
    expect(ctx.cards).toEqual([expect.objectContaining({ kind: 'vote', card_id: 'c_vote_turn_v3_1', decision_id: out.decision_id })]);
    expect(ctx.lines).toEqual(['Vote is up.']);
    expect((ctx.cards[0] as { fallback_text: string }).fallback_text).toMatch(/^Vote: Where do we stay\?/);
  });

  it("never asks \"which villa\" of ixigo.com's hotels: the kind of place becomes \"stay\", unless every option is one (re-drill 7)", async () => {
    const stay = (title: string) => ({
      kind: 'stay' as const, title, priceMinor: 900_000, currency: 'INR', priceNote: 'per night, per room', highlights: ['Pool'], facts: { pool: true },
      sourceUrl: `https://www.ixigo.com/hotels/1/details?hName=${encodeURIComponent(title)}`,
    });
    const query = { area: 'north goa', checkIn: '2026-11-06', checkOut: '2026-11-09', mustHave: ['pool'] };
    const asked = async (names: string[], question: string, turn: string) => {
      const set = await results.save({ tripId: 't_goa', optionKind: 'stay', source: 'search', query, options: names.map(stay), checkedAt: '2026-10-07T12:00:00.000Z' });
      const show = lb.ctx({ turnId: `${turn}a` });
      const shown = (await lb.tools.run('show_options', { line: 'Here they are.', results_id: set.resultsId, title: 'Pool stays in North Goa, 6 to 9 Nov' }, show)) as any;
      await lb.tools.run('put_to_vote', { line: 'Vote is up.', card_id: shown.card_id, question }, lb.ctx({ turnId: `${turn}b` }));
      return lb.link.sent('open_vote').at(-1)!.question;
    };
    expect(await asked(['Meritas Auberge Calangute Goa', '3102bce - A Vedic Resort', 'Villa Mandrem'], 'Which pool villa for 6 to 9 Nov?', 'turn_q1')).toBe('Which pool stay for 6 to 9 Nov?');
    expect(await asked(['Meritas Auberge Calangute Goa', 'De Mandarin Hotel'], 'Villas: which one?', 'turn_q2')).toBe('Stays: which one?');
    // Every option a villa by its name, or a question that names no kind of place: asked as it is.
    expect(await asked(['Villa Mandrem', 'The Palms Villa'], 'Which pool villa for 6 to 9 Nov?', 'turn_q3')).toBe('Which pool villa for 6 to 9 Nov?');
    expect(await asked(['Meritas Auberge Calangute Goa', 'De Mandarin Hotel'], 'Which one for 6 to 9 Nov?', 'turn_q4')).toBe('Which one for 6 to 9 Nov?');
  });

  it('asks for a secret ballot when the model sets anonymous', async () => {
    const found = (await lb.tools.run('search_stays', STAYS, lb.ctx({ turnId: 'turn_anon1' }))) as any;
    const shown = (await lb.tools.run('show_options', { line: 'Here are the villas.', results_id: found.results_id, title: 'Villas' }, lb.ctx({ turnId: 'turn_anon2' }))) as any;
    await lb.tools.run('put_to_vote', { line: 'Vote is up.', card_id: shown.card_id, anonymous: true }, lb.ctx({ turnId: 'turn_anon3' }));
    expect(lb.link.sent('open_vote').at(-1)).toMatchObject({ request_id: 'go_vote_turn_anon3_1', anonymous: true });
  });

  // 8 Oct run sheet: a card with one stay could not go to a vote, so Go opened an unbound yes/no vote of its own, and
  // "I'll book it" then had nothing to book.
  it('puts a one-option card to a vote too: that option, bound to its offer, or "Keep looking"', async () => {
    const found = (await lb.tools.run('search_stays', STAYS, lb.ctx({ turnId: 'turn_one1' }))) as any;
    const showCtx = lb.ctx({ turnId: 'turn_one2' });
    const shown = (await lb.tools.run('show_options', { line: 'One fits.', results_id: found.results_id, option_numbers: [2], title: 'Villas' }, showCtx)) as any;
    const card = C.OptionsCard.parse(showCtx.cards[0]);
    expect(card.options).toHaveLength(1);
    const out = (await lb.tools.run('put_to_vote', { line: 'Vote is up.', card_id: shown.card_id }, lb.ctx({ turnId: 'turn_one3' }))) as any;
    expect(out.decision_id).toBeDefined();
    const vote = lb.link.sent('open_vote').at(-1)!;
    expect(vote).toMatchObject({ kind: 'choice', question: `Go with ${card.options[0]!.title}?` });
    const options = vote.options as Array<{ label: string; option_ref?: string }>;
    expect(options.map((o) => o.option_ref)).toEqual([card.options[0]!.option_id, undefined]);
    expect(options[1]!.label).toBe('Keep looking');
  });

  it('shows the same vote again when the same turn runs again, and refuses a second vote from another turn', async () => {
    const found = (await lb.tools.run('search_stays', STAYS, lb.ctx({ turnId: 'turn_w1' }))) as any;
    const shown = (await lb.tools.run('show_options', { line: 'Here are the villas.', results_id: found.results_id, title: 'Villas' }, lb.ctx({ turnId: 'turn_w2' }))) as any;
    const first = lb.ctx({ turnId: 'turn_w3' });
    const a = (await lb.tools.run('put_to_vote', { line: 'Vote is up.', card_id: shown.card_id }, first)) as any;
    const opened = lb.link.sent('open_vote').length;
    const rerun = lb.ctx({ turnId: 'turn_w3' });
    const b = (await lb.tools.run('put_to_vote', { line: 'Vote is up.', card_id: shown.card_id }, rerun)) as any;
    expect(b.decision_id).toBe(a.decision_id);
    expect(rerun.cards).toEqual(first.cards);
    expect(lb.link.sent('open_vote')).toHaveLength(opened);
    expect(await lb.tools.run('put_to_vote', { line: 'Vote is up.', card_id: shown.card_id }, lb.ctx({ turnId: 'turn_w4' }))).toMatchObject({ error: 'already_voting', decision_id: a.decision_id });
  });

  it('with no card_id, votes on the options card shown earlier in the same reply', async () => {
    const found = (await lb.tools.run('search_stays', STAYS, lb.ctx({ turnId: 'turn_r1' }))) as any;
    const reply = lb.ctx({ turnId: 'turn_r2' });
    await lb.tools.run('show_options', { line: 'Here are the villas.', results_id: found.results_id, title: 'Villas' }, reply);
    const out = (await lb.tools.run('put_to_vote', { line: 'Vote is up.' }, reply)) as any;
    expect(out.decision_id).toBeDefined();
    const card = C.OptionsCard.parse(reply.cards[0]);
    const vote = lb.link.sent('open_vote').at(-1)!;
    expect((vote.options as Array<{ option_ref: string }>).map((o) => o.option_ref)).toEqual(card.options.map((o) => o.option_id));
    expect(reply.cards.map((c) => c.kind)).toEqual(['options', 'vote']);
  });

  it('with no card_id, refuses when the reply showed two options cards, or none, and opens nothing', async () => {
    const found = (await lb.tools.run('search_stays', STAYS, lb.ctx({ turnId: 'turn_r3' }))) as any;
    const two = lb.ctx({ turnId: 'turn_r4' });
    await lb.tools.run('show_options', { line: 'Here are the villas.', results_id: found.results_id, option_numbers: [1, 2], title: 'Two villas' }, two);
    await lb.tools.run('show_options', { line: 'Here are the villas.', results_id: found.results_id, option_numbers: [3, 4], title: 'Two more villas' }, two);
    const opened = lb.link.sent('open_vote').length;
    expect(await lb.tools.run('put_to_vote', { line: 'Vote is up.' }, two)).toMatchObject({ error: 'which_card' });
    expect(await lb.tools.run('put_to_vote', { line: 'Vote is up.' }, lb.ctx({ turnId: 'turn_r5' }))).toMatchObject({ error: 'no_card' });
    expect(lb.link.sent('open_vote')).toHaveLength(opened);
    expect(two.cards.map((c) => c.kind)).toEqual(['options', 'options']);
  });

  it('puts trains to a vote at their per-person fares, each option answering travel.offer as a train, which is never booked for the group', async () => {
    const found = (await lb.tools.run('search_trains', { from: 'Delhi', to: 'Goa', date: '2026-11-06' }, lb.ctx({ turnId: 'turn_tr1' }))) as any;
    const showCtx = lb.ctx({ turnId: 'turn_tr2' });
    const shown = (await lb.tools.run('show_options', { line: 'Here are the villas.', results_id: found.results_id, title: 'Trains to Goa' }, showCtx)) as any;
    const card = C.OptionsCard.parse(showCtx.cards[0]);
    expect(card.option_kind).toBe('train');
    const out = (await lb.tools.run('put_to_vote', { line: 'Vote is up.', card_id: shown.card_id }, lb.ctx({ turnId: 'turn_tr3' }))) as any;
    expect(out.decision_id).toBeDefined();
    const vote = lb.link.sent('open_vote').at(-1)!;
    expect(vote).toMatchObject({ question: 'Which train?' });
    expect((vote.options as Array<{ price_minor: number }>).map((o) => o.price_minor)).toEqual(card.options.map((o) => o.price_minor));
    // P5 reads the kind and refuses group journeys: a train is searchable and votable, never paid for here.
    expect((await travel.offer(card.options[0]!.option_id))?.kind).toBe('train');
  });
});
