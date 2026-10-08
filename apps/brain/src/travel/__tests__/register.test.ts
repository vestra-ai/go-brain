import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as C from '@go/contract';
import { withSchema } from '../../db/test-db.js';
import { eventually, makeLaneBrain, type LaneBrain } from '../../tasks/testing/lane-brain.js';
import { goaPack } from '../../tasks/testing/goa.js';
import { buildFlightsLinkCard, buildOptionsCard } from '../cards.js';
import { registerTravel } from '../register.js';
import { createResultsStore, type ResultOption } from '../results.js';

let db: Awaited<ReturnType<typeof withSchema>>;
let lb: LaneBrain;
let card: C.Card;

beforeAll(async () => {
  db = await withSchema();
  lb = makeLaneBrain({ pool: db.pool });
  await registerTravel(lb.brain);
  const found = (await lb.tools.run('search_stays', { area: 'North Goa', check_in: '2026-11-06', check_out: '2026-11-09', guests: 5 }, lb.ctx({ turnId: 'turn_reg1' }))) as any;
  const ctx = lb.ctx({ turnId: 'turn_reg2' });
  await lb.tools.run('show_options', { line: 'Here are villas in North Goa.', results_id: found.results_id, title: 'Villas in North Goa' }, ctx);
  card = C.Card.parse(ctx.cards[0]);
});
afterAll(async () => {
  await db.drop();
});

const tap = (over: Partial<{ tap_id: string; action_id: string; person_id: string; option_id: string }>) => ({
  tap_id: 'tap_1', trip_id: 't_goa', card_id: card.card_id, action_id: 'pick', person_id: 'p_meher', ...over,
});

describe('registerTravel', () => {
  it('runs before proactive in LANES, so the watches find brain.travel set when they start', async () => {
    const { LANES } = await import('../../main.js');
    const { registerProactive } = await import('../../proactive/register.js');
    expect(LANES.indexOf(registerTravel)).toBeGreaterThanOrEqual(0);
    expect(LANES.indexOf(registerTravel)).toBeLessThan(LANES.indexOf(registerProactive));
  });

  it('sets brain.travel and registers the eight travel tools, the five options taps, the tap wake and the image route', async () => {
    expect(lb.brain.travel).toBeDefined();
    // A new trip's computer is made at setup (warm.ts startComputerAtSetup).
    expect(lb.setup.steps.map((s) => s.name)).toContain('travel.computer');
    // The ixigo tool runs the book's other recipes (the destination guide and more).
    // compare_ways_there: each home city's ways to the trip, side by side (the composite trip.how_we_get_there).
    expect(lb.tools.list().map((t) => t.name)).toEqual(['search_flights', 'search_trains', 'search_buses', 'search_stays', 'show_options', 'put_to_vote', 'ixigo', 'compare_ways_there']);
    expect([...lb.taps.handlers.keys()].sort()).toEqual(['notice/see_on_ixigo', 'options/flights_home', 'options/open', 'options/pick', 'options/see_all', 'options/vote']);
    expect(lb.context.wakes.has('tap')).toBe(true);
    // A search that outlived its turn wakes Go with its options.
    expect(lb.context.wakes.has('search')).toBe(true);
    expect((await lb.http.inject({ method: 'GET', url: `/img/u${'0'.repeat(32)}.jpg` })).statusCode).toBe(404);
    expect(lb.brain.travel?.simulate).toBeDefined();
  });

  it('"I\'ll take this" puts a tap on the desk for the composer, and the wake line names the person and the option', async () => {
    if (card.kind !== 'options') throw new Error('expected an options card');
    const option = card.options[1]!;
    expect(await lb.taps.tap('options', 'pick', tap({ tap_id: 'tap_p1', option_id: option.option_id }), card)).toEqual({ result: 'done', toast: 'Noted. Go will reply in the room.' });
    const item = lb.desk.of('tap').at(-1)!;
    expect(item).toMatchObject({ id: 'travel:pick:tap_p1', ref: card.card_id, payload: { source: 'options', action: 'pick', optionId: option.option_id, personId: 'p_meher' } });
    const line = lb.context.wake(item, goaPack());
    expect(line).toContain('Meher');
    expect(line).toContain(option.title);
    // A tap from another card is not P4's to read: null, so P5's or P6's renderer (or P1's generic line) answers.
    expect(lb.context.wake({ ...item, payload: { source: 'pay', action: 'approve' } }, goaPack())).toBeNull();
    expect(await lb.taps.tap('options', 'pick', tap({ tap_id: 'tap_p2', option_id: 'opt_gone' }), card)).toEqual({ result: 'refused', toast: 'That option is no longer available' });
  });

  it('"Put it to a vote" opens one vote and posts its card, even when two people tap at the same moment', async () => {
    const [a, b] = await Promise.all([
      lb.taps.tap('options', 'vote', tap({ tap_id: 'tap_v1', action_id: 'vote' }), card),
      lb.taps.tap('options', 'vote', tap({ tap_id: 'tap_v2', action_id: 'vote', person_id: 'p_kabir' }), card),
    ]);
    expect(a.result).toBe('done');
    expect(b.result).toBe('done');
    await eventually(() => lb.link.sent('post_message').some((p) => (p.card as { kind: string }).kind === 'vote'));
    await new Promise((r) => setTimeout(r, 50));
    expect(lb.link.sent('open_vote')).toHaveLength(1);
    expect(await lb.taps.tap('options', 'vote', tap({ tap_id: 'tap_v3', action_id: 'vote' }), card)).toEqual({ result: 'done', toast: 'Already up for a vote' });
  });

  it('"See on ixigo" opens the option\'s own ixigo.com page, and refuses an option that has none', async () => {
    if (card.kind !== 'options') throw new Error('expected an options card');
    // The fake's villas have no ixigo page.
    expect(await lb.taps.tap('options', 'open', tap({ tap_id: 'tap_o1', action_id: 'open', option_id: card.options[0]!.option_id }), card)).toEqual({ result: 'refused', toast: 'This option has no ixigo page' });
    const results = createResultsStore(db.pool);
    const page = 'https://www.ixigo.com/hotels/1384544/details?locationId=1366415&hName=Meritas';
    const hotel: ResultOption = { kind: 'stay', title: 'Meritas', priceMinor: 810400, currency: 'INR', priceNote: 'per night, per room', highlights: [], facts: {}, sourceUrl: page };
    const checkedAt = '2026-10-07T12:00:00.000Z';
    const set = await results.save({ tripId: 't_goa', optionKind: 'stay', source: 'search', query: {}, options: [hotel], checkedAt });
    const picks = [{ optionId: 'opt_ixr1', n: 1, option: hotel, imageUrl: null }];
    const ix = buildOptionsCard({ cardId: 'c_ixr', title: 'Meritas', optionKind: 'stay', checkedAt, picks });
    await results.saveCard({ cardId: 'c_ixr', tripId: 't_goa', resultsId: set.resultsId, title: 'Meritas', optionKind: 'stay', card: ix }, picks, checkedAt);
    const opened = await lb.taps.tap('options', 'open', { tap_id: 'tap_o2', trip_id: 't_goa', card_id: 'c_ixr', action_id: 'open', person_id: 'p_meher', option_id: 'opt_ixr1' }, ix);
    expect(opened).toEqual({ result: 'open', url: page, expires_at: new Date(lb.brain.now().getTime() + 600_000).toISOString() });
    // An option from another card is refused.
    expect(await lb.taps.tap('options', 'open', tap({ tap_id: 'tap_o3', action_id: 'open', option_id: 'opt_ixr1' }), card)).toEqual({ result: 'refused', toast: 'That option is no longer here' });
  });

  it('"See all on ixigo" on a card of stays opens the whole list the search read, and nothing for a list without one', async () => {
    const results = createResultsStore(db.pool);
    const list = 'https://www.ixigo.com/hotels/search/result?locationId=32&locationName=Goa&filters=FL_HF_29';
    const hotel: ResultOption = { kind: 'stay', title: 'Meritas', priceMinor: 810400, currency: 'INR', priceNote: 'per night, per room', highlights: [], facts: {}, sourceUrl: 'https://www.ixigo.com/hotels/1384544/details?hName=Meritas' };
    const checkedAt = '2026-10-07T12:00:00.000Z';
    const picks = [{ optionId: 'opt_all1', n: 1, option: hotel, imageUrl: null }];
    const keep = async (cardId: string, page?: string) => {
      const set = await results.save({ tripId: 't_goa', optionKind: 'stay', source: 'search', query: {}, options: [hotel], checkedAt, ...(page ? { page } : {}) });
      const c = buildOptionsCard({ cardId, title: 'Stays in North Goa', optionKind: 'stay', checkedAt, picks, seeAll: page !== undefined });
      await results.saveCard({ cardId, tripId: 't_goa', resultsId: set.resultsId, title: c.title, optionKind: 'stay', card: c }, picks, checkedAt);
      return c;
    };
    const all = await keep('c_all1', list);
    expect(all.actions?.map((a) => a.action_id)).toEqual(['pick', 'see_all']);
    const tapAll = (c: C.Card) => lb.taps.tap('options', 'see_all', { tap_id: `tap_${c.card_id}`, trip_id: 't_goa', card_id: c.card_id, action_id: 'see_all', person_id: 'p_meher' }, c);
    expect(await tapAll(all)).toEqual({ result: 'open', url: list, expires_at: new Date(lb.brain.now().getTime() + 600_000).toISOString() });
    expect(await tapAll(await keep('c_all2'))).toEqual({ result: 'refused', toast: 'This list has no ixigo page' });
  });

  it('"See flights on ixigo" opens the link card\'s own ixigo page', async () => {
    const page = 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026';
    const link = buildFlightsLinkCard({ cardId: 'c_link_r1', title: 'Flights, Delhi to Goa', url: page });
    const tapIt = (c: C.Card) => lb.taps.tap('notice', 'see_on_ixigo', { tap_id: 'tap_l1', trip_id: 't_goa', card_id: c.card_id, action_id: 'see_on_ixigo', person_id: 'p_meher' }, c);
    expect(await tapIt(link)).toEqual({ result: 'open', url: page, expires_at: new Date(lb.brain.now().getTime() + 600_000).toISOString() });
    expect(await tapIt({ ...link, source: { name: 'elsewhere', url: 'https://fares.example/x' } })).toEqual({ result: 'refused', toast: 'This card has no ixigo page' });
  });

  it("closes the image fetcher's connections and the ixigo connection through brain.onStop", async () => {
    // The fake alone: the image fetcher, and the live view's viewers (live.ts).
    expect(lb.stoppers).toHaveLength(2);
    const withIxigo = makeLaneBrain({ pool: db.pool, env: { IXIGO_MCP_URL: 'http://127.0.0.1:1/mcp', IXIGO_MCP_TOKEN: 'tok-ixigo-123456' } });
    await registerTravel(withIxigo.brain);
    expect(withIxigo.stoppers).toHaveLength(3);
    // The client connects on its first call, so closing one that never called resolves at once.
    await withIxigo.stop();
    expect(withIxigo.stoppers).toEqual([]);
    await withIxigo.http.close();
  });
});
