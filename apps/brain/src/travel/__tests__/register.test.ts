import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as C from '@go/contract';
import { withSchema } from '../../db/test-db.js';
import { eventually, makeLaneBrain, type LaneBrain } from '../../tasks/testing/lane-brain.js';
import { goaPack } from '../../tasks/testing/goa.js';
import { buildFlightsLinkCard, buildOptionsCard } from '../cards.js';
import { stableId } from '../ids.js';
import { picksOf } from '../picks.js';
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

  it('sets brain.travel and registers the travel tools, the options taps, the login card taps, the tap wake and the image route', async () => {
    expect(lb.brain.travel).toBeDefined();
    // A new trip's computer is started at setup (warm.ts startComputerAtSetup); right after Go's hello its organizer is
    // asked to log in to ixigo (login.ts); then its Chrome visits ixigo once (the warm). Both wait only on the box, and
    // the login is registered first, so setup runs travel.computer, travel.ixigo_login, travel.ixigo_warm. After the warm,
    // the stays head start: the trip's likely first stays search, on the warm Chrome (warm.ts createStaysHeadStart).
    const names = lb.setup.steps.map((s) => s.name);
    expect(names.filter((n) => n.startsWith('travel.'))).toEqual(['travel.computer', 'travel.ixigo_login', 'travel.ixigo_warm', 'travel.stays_head_start']);
    expect(lb.setup.steps.find((s) => s.name === 'travel.ixigo_login')).toMatchObject({ after: 'travel.computer' });
    expect(lb.setup.steps.find((s) => s.name === 'travel.ixigo_warm')).toMatchObject({ after: 'travel.computer' });
    expect(lb.setup.steps.find((s) => s.name === 'travel.stays_head_start')).toMatchObject({ after: 'travel.ixigo_warm' });
    // The ixigo tool runs the book's other recipes (the destination guide and more).
    // compare_ways_there: each home city's ways to the trip, side by side (the composite trip.how_we_get_there).
    // search_flights_each: each person's own flights from their home city, on cards for them alone (trip.flights_each).
    // watch_ixigo and stop_watch: the watches a group asks Go to keep on ixigo (travel/recipe-watches.ts).
    // set_budget: the budget the group decided, kept for every turn (trip-budget.ts).
    expect(lb.tools.list().map((t) => t.name)).toEqual(['search_flights', 'search_trains', 'search_buses', 'search_stays', 'show_options', 'put_to_vote', 'set_budget', 'ixigo', 'compare_ways_there', 'search_flights_each', 'watch_ixigo', 'stop_watch']);
    expect([...lb.taps.handlers.keys()].sort()).toEqual([
      'notice/ixigo_logged_in', 'notice/ixigo_login', 'notice/ixigo_logout', 'notice/ixigo_not_now', 'notice/ixigo_watch', 'notice/see_on_ixigo',
      'options/add_budget', 'options/book_mine', 'options/change', 'options/flights_home', 'options/open', 'options/pick', 'options/see_all', 'options/vote',
    ]);
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

  // Keshav, 10 Oct: Go opened a group vote, "Book IndiGo 6E2150 for Meher on 12 Nov? 0 of 5 voted", for Meher's own
  // flight ("why would we need everyone to vote for my ticket lol"). A ticket is its traveller's own.
  it("a ticket picked is its picker's own: their confirm goes up at once for them alone, never a vote; Book it opens ixigo set for one", async () => {
    const results = createResultsStore(db.pool);
    const page = 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=12112026&returnDate=&adults=5&children=0&infants=0&class=e&source=Search%20Form';
    const flight = (title: string): ResultOption => ({ kind: 'flight', title, priceMinor: 1_157_100, currency: 'INR', priceNote: 'per person', highlights: ['Non-stop'], facts: { stops: 0 }, sourceUrl: page });
    const checkedAt = '2026-10-10T07:00:00.000Z';
    const set = await results.save({ tripId: 't_goa', optionKind: 'flight', source: 'search', query: {}, options: [flight('IndiGo 6E2150'), flight('Air India AI2981')], checkedAt });
    const picks = [{ optionId: 'opt_fl1', n: 1, option: flight('IndiGo 6E2150'), imageUrl: null }, { optionId: 'opt_fl2', n: 2, option: flight('Air India AI2981'), imageUrl: null }];
    const flights = buildOptionsCard({ cardId: 'c_fl', title: 'Flights, Delhi to Goa', optionKind: 'flight', checkedAt, picks });
    await results.saveCard({ cardId: 'c_fl', tripId: 't_goa', resultsId: set.resultsId, title: flights.title, optionKind: 'flight', card: flights }, picks, checkedAt);
    // No group vote on a ticket's card.
    expect(flights.actions?.map((a) => a.action_id)).toEqual(['pick', 'open']);
    const at = (over: Partial<{ tap_id: string; action_id: string; person_id: string; option_id: string; card_id: string }>) =>
      ({ tap_id: 'tap_f', trip_id: 't_goa', card_id: 'c_fl', action_id: 'pick', person_id: 'p_meher', option_id: 'opt_fl1', ...over });
    const before = lb.desk.of('tap').length;
    expect(await lb.taps.tap('options', 'pick', at({ tap_id: 'tap_f1' }), flights)).toEqual({ result: 'done', toast: "It's yours to confirm" });
    // Kept as her pick, one per way she travels (picks.ts), which her flight's heads-up watches.
    expect(await picksOf(db.pool, 't_goa')).toContainEqual(expect.objectContaining({ personId: 'p_meher', kind: 'flight', optionId: 'opt_fl1', title: 'IndiGo 6E2150' }));
    const MINE = stableId('c_mine', 'tap_f1');
    await eventually(() => lb.link.sent('post_message').some((p) => (p.card as { card_id?: string })?.card_id === MINE));
    const mine = C.OptionsCard.parse(lb.link.sent('post_message').find((p) => (p.card as { card_id?: string })?.card_id === MINE)!.card);
    expect(mine).toMatchObject({ title: 'Book IndiGo 6E2150 for you, ₹11,571?', for_person_ids: ['p_meher'], options: [{ option_id: 'opt_fl1', title: 'IndiGo 6E2150' }] });
    expect(mine.actions).toEqual([
      { action_id: 'book_mine', label: 'Book it', style: 'primary', per_option: true, only_for_person_ids: ['p_meher'] },
      { action_id: 'change', label: 'Change', style: 'secondary', per_option: true, only_for_person_ids: ['p_meher'] },
    ]);
    // No model round, no vote: nothing on the desk, no open_vote.
    expect(lb.desk.of('tap')).toHaveLength(before);
    expect(lb.link.sent('open_vote').filter((v) => String(v.question).includes('6E2150'))).toEqual([]);
    // "Book it": ixigo's page for the flight, set for one traveller, for Meher alone.
    const book = await lb.taps.tap('options', 'book_mine', at({ tap_id: 'tap_f2', action_id: 'book_mine', card_id: mine.card_id }), mine);
    expect(book).toMatchObject({ result: 'open', url: expect.stringContaining('&adults=1&children=0&infants=0&') });
    expect(await lb.taps.tap('options', 'book_mine', at({ tap_id: 'tap_f3', action_id: 'book_mine', card_id: mine.card_id, person_id: 'p_kabir' }), mine))
      .toEqual({ result: 'refused', toast: 'This one is for someone else to confirm' });
    // "Change": Go finds them another, their own pick.
    expect(await lb.taps.tap('options', 'change', at({ tap_id: 'tap_f4', action_id: 'change', card_id: mine.card_id }), mine)).toEqual({ result: 'done', toast: 'Go will find you another' });
    const change = lb.desk.of('tap').at(-1)!;
    expect(change).toMatchObject({ id: 'travel:change:tap_f4', payload: { action: 'change_mine', optionId: 'opt_fl1', personId: 'p_meher' } });
    expect(lb.context.wake(change, goaPack())).toMatch(/Meher tapped "Change" on their own flight, "IndiGo 6E2150".*never a vote/);
    // An older ticket card that still has the vote button: refused, saying why.
    expect(await lb.taps.tap('options', 'vote', at({ tap_id: 'tap_f5', action_id: 'vote' }), flights)).toEqual({ result: 'refused', toast: "A ticket is each person's own: tap I'll take this" });
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

  it('"Add my budget" opens the App\'s own budget sheet for the trip, a go:// link (contract 1.1 A4)', async () => {
    const tapIt = await lb.taps.tap('options', 'add_budget', { tap_id: 'tap_b1', trip_id: 't_goa', card_id: 'c_any', action_id: 'add_budget', person_id: 'p_meher' }, {} as C.Card);
    expect(tapIt).toEqual({ result: 'open', url: 'go://trips/t_goa/sheet/budget', expires_at: new Date(lb.brain.now().getTime() + 600_000).toISOString() });
    expect(C.CardActionResult.parse(tapIt)).toEqual(tapIt);
  });

  it('"See flights on ixigo" opens the link card\'s own ixigo page', async () => {
    const page = 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026';
    const link = buildFlightsLinkCard({ cardId: 'c_link_r1', title: 'Flights, Delhi to Goa', url: page });
    const tapIt = (c: C.Card) => lb.taps.tap('notice', 'see_on_ixigo', { tap_id: 'tap_l1', trip_id: 't_goa', card_id: c.card_id, action_id: 'see_on_ixigo', person_id: 'p_meher' }, c);
    expect(await tapIt(link)).toEqual({ result: 'open', url: page, expires_at: new Date(lb.brain.now().getTime() + 600_000).toISOString() });
    expect(await tapIt({ ...link, source: { name: 'elsewhere', url: 'https://fares.example/x' } })).toEqual({ result: 'refused', toast: 'This card has no ixigo page' });
  });

  it("closes the image fetcher's connections and the ixigo connection through brain.onStop", async () => {
    // The fake alone: the image fetcher, the screen's Bash streams (screen-feed.ts), the live view's viewers (live.ts), the
    // stays head starts waiting for an edit to settle (warm.ts), the watch checks (recipe-watches.ts) and the person's
    // login's keep-alive (login-keepalive.ts), each stopped by name where it has one.
    expect(lb.stoppers).toHaveLength(6);
    expect(lb.stoppers.map((f) => f.name)).toEqual(expect.arrayContaining(['stopWatchChecks', 'stopHeadStarts', 'stopLoginKeepAlive']));
    const withIxigo = makeLaneBrain({ pool: db.pool, env: { IXIGO_MCP_URL: 'http://127.0.0.1:1/mcp', IXIGO_MCP_TOKEN: 'tok-ixigo-123456' } });
    await registerTravel(withIxigo.brain);
    expect(withIxigo.stoppers).toHaveLength(7);
    expect(withIxigo.stoppers.map((f) => f.name)).toEqual(expect.arrayContaining(['stopWatchChecks', 'stopHeadStarts']));
    // The client connects on its first call, so closing one that never called resolves at once.
    await withIxigo.stop();
    expect(withIxigo.stoppers).toEqual([]);
    await withIxigo.http.close();
  });
});
