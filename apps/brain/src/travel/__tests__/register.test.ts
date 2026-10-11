import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as C from '@go/contract';
import { withSchema } from '../../db/test-db.js';
import { eventually, makeLaneBrain, type LaneBrain } from '../../tasks/testing/lane-brain.js';
import { GOA_TRIP, goaPack } from '../../tasks/testing/goa.js';
import { buildIxigoLinkCard, buildOptionsCard, PICK_ACTION, SEE_ALL_ACTION } from '../cards.js';
import { stableId } from '../ids.js';
import { picksOf } from '../picks.js';
import { registerTravel } from '../register.js';
import { SocketCallError } from '../../door/rpc.js';
import { createResultsStore, MORE_CARD, type ResultOption } from '../results.js';
import { ALL_SHOWN } from '../taps.js';
import { asksForMore } from '../typed-more.js';
import { msg } from '../../__tests__/fixtures/goa.js';
import type { DeskItem } from '../../desk/desk.js';
import type { Message } from '@go/contract';
import type { TravelOption } from '../travel.js';

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
    // ixigo_login: the login card when someone in the chat asks to log in to ixigo (again) (login.ts askNow).
    expect(lb.tools.list().map((t) => t.name)).toEqual(['search_flights', 'search_trains', 'search_buses', 'search_stays', 'show_options', 'put_to_vote', 'set_budget', 'ixigo', 'ixigo_login', 'compare_ways_there', 'search_flights_each', 'watch_ixigo', 'stop_watch', 'book_flight']);
    expect([...lb.taps.handlers.keys()].sort()).toEqual([
      'notice/ixigo_logged_in', 'notice/ixigo_login', 'notice/ixigo_logout', 'notice/ixigo_not_now', 'notice/ixigo_watch', 'notice/pay_flight', 'notice/see_on_ixigo',
      // A booking's one ask for a traveller's gender (flight-booking.ts genderAsk).
      'notice/traveller_female', 'notice/traveller_male',
      'options/add_budget', 'options/book_mine', 'options/change', 'options/flights_home', 'options/more_options', 'options/open', 'options/pick', 'options/see_all', 'options/vote',
      // The rooms card's pick (REV4 B5, rooms-card.ts).
      'rooms/pick',
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

  it("a stays card is the group's vote from the start (rev 5 R5); an older card's \"Put it to a vote\" opens nothing more", async () => {
    if (card.kind !== 'options') throw new Error('expected an options card');
    expect(card.decision_id).toMatch(/^d_\d+$/);
    expect(lb.link.sent('open_vote')).toHaveLength(1);
    const [a, b] = await Promise.all([
      lb.taps.tap('options', 'vote', tap({ tap_id: 'tap_v1', action_id: 'vote' }), card),
      lb.taps.tap('options', 'vote', tap({ tap_id: 'tap_v2', action_id: 'vote', person_id: 'p_kabir' }), card),
    ]);
    expect([a, b]).toEqual([{ result: 'done', toast: 'Already up for a vote' }, { result: 'done', toast: 'Already up for a vote' }]);
    await new Promise((r) => setTimeout(r, 50));
    expect(lb.link.sent('open_vote')).toHaveLength(1);
    expect(lb.link.sent('post_message').some((p) => (p.card as { kind?: string } | undefined)?.kind === 'vote')).toBe(false);
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
    // No group vote on a ticket's card, and its ixigo page is in each option (rev 5 R5), never a button.
    expect(flights.actions?.map((a) => a.action_id)).toEqual(['pick']);
    expect(flights.options[0]!.url).toBe(page);
    const at = (over: Partial<{ tap_id: string; action_id: string; person_id: string; option_id: string; card_id: string }>) =>
      ({ tap_id: 'tap_f', trip_id: 't_goa', card_id: 'c_fl', action_id: 'pick', person_id: 'p_meher', option_id: 'opt_fl1', ...over });
    const before = lb.desk.of('tap').length;
    expect(await lb.taps.tap('options', 'pick', at({ tap_id: 'tap_f1' }), flights)).toEqual({ result: 'done', toast: "It's yours to confirm" });
    // Kept as her pick, one per way she travels (picks.ts), which her flight's heads-up watches.
    expect(await picksOf(db.pool, 't_goa')).toContainEqual(expect.objectContaining({ personId: 'p_meher', kind: 'flight', optionId: 'opt_fl1', title: 'IndiGo 6E2150' }));
    const MINE = stableId('c_mine', 'tap_f1');
    await eventually(() => lb.link.sent('post_message').some((p) => (p.card as { card_id?: string })?.card_id === MINE));
    const mine = C.OptionsCard.parse(lb.link.sent('post_message').find((p) => (p.card as { card_id?: string })?.card_id === MINE)!.card);
    // Her confirm is hers alone to see (1.2), as well as to act on.
    expect(lb.link.sent('post_message').find((p) => (p.card as { card_id?: string })?.card_id === MINE)!['visible_to_person_ids']).toEqual(['p_meher']);
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

  it('"See on ixigo" on a card from before rev 5 opens the option\'s own ixigo.com page, and refuses an option that has none', async () => {
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

  it('"See all on ixigo" on a card of stays from before rev 5 opens the whole list the search read, and nothing for a list without one', async () => {
    const results = createResultsStore(db.pool);
    const list = 'https://www.ixigo.com/hotels/search/result?locationId=32&locationName=Goa&filters=FL_HF_29';
    const hotel: ResultOption = { kind: 'stay', title: 'Meritas', priceMinor: 810400, currency: 'INR', priceNote: 'per night, per room', highlights: [], facts: {}, sourceUrl: 'https://www.ixigo.com/hotels/1384544/details?hName=Meritas' };
    const checkedAt = '2026-10-07T12:00:00.000Z';
    const picks = [{ optionId: 'opt_all1', n: 1, option: hotel, imageUrl: null }];
    const keep = async (cardId: string, page?: string) => {
      const set = await results.save({ tripId: 't_goa', optionKind: 'stay', source: 'search', query: {}, options: [hotel], checkedAt, ...(page ? { page } : {}) });
      const c = { ...buildOptionsCard({ cardId, title: 'Stays in North Goa', optionKind: 'stay', checkedAt, picks }), actions: [SEE_ALL_ACTION] };
      await results.saveCard({ cardId, tripId: 't_goa', resultsId: set.resultsId, title: c.title, optionKind: 'stay', card: c }, picks, checkedAt);
      return c;
    };
    const all = await keep('c_all1', list);
    const tapAll = (c: C.Card) => lb.taps.tap('options', 'see_all', { tap_id: `tap_${c.card_id}`, trip_id: 't_goa', card_id: c.card_id, action_id: 'see_all', person_id: 'p_meher' }, c);
    expect(await tapAll(all)).toEqual({ result: 'open', url: list, expires_at: new Date(lb.brain.now().getTime() + 600_000).toISOString() });
    expect(await tapAll(await keep('c_all2'))).toEqual({ result: 'refused', toast: 'This list has no ixigo page' });
  });

  // Rev 5 R4: "See more" puts up to 10 more of the same search on a new card, in the same vote.
  it('"See more" puts the search\'s next stays on a new card in the same vote, and says when there are none, or the vote is closed or full', async () => {
    const results = createResultsStore(db.pool);
    const stay = (i: number): ResultOption => ({
      kind: 'stay', title: `Stay ${i}`, priceMinor: 500_000 + i * 1_000, totalMinor: 1_500_000 + i * 3_000, currency: 'INR', priceNote: 'per night, per room',
      highlights: [], facts: { nights: 3 }, sourceUrl: `https://www.ixigo.com/hotels/${9000 + i}/details?hName=Stay%20${i}`,
    });
    const options = Array.from({ length: 12 }, (_, i) => stay(i + 1));
    const set = await results.save({ tripId: 't_goa', optionKind: 'stay', source: 'search', query: { area: 'anjuna', guests: 5 }, options, checkedAt: '2026-10-07T12:00:00.000Z' });
    const ctx = lb.ctx({ turnId: 'turn_more1' });
    const shown = (await lb.tools.run('show_options', { line: 'Here are stays in Anjuna.', results_id: set.resultsId, title: 'Stays in Anjuna' }, ctx)) as any;
    const first = C.OptionsCard.parse(ctx.cards[0]);
    expect(first.options).toHaveLength(10);
    expect(first).toMatchObject({ decision_id: shown.decision_id, actions: [C.MORE_OPTIONS] });
    // The Server's trip: the card's vote closed, full, or open with its 10 options.
    const real = lb.link.request.bind(lb.link);
    const voteIs = (status: string, count: number) => {
      lb.link.request = (async (method: string, params: unknown) =>
        method === 'read_trip'
          ? { ...GOA_TRIP, decisions: [{ decision_id: shown.decision_id, status, options: Array.from({ length: count }, (_, i) => ({ label: `S${i}` })) }] }
          : real(method as 'post_message', params as never)) as typeof lb.link.request;
    };
    const more = (tapId: string) => lb.taps.tap('options', 'more_options', { tap_id: tapId, trip_id: 't_goa', card_id: first.card_id, action_id: 'more_options', person_id: 'p_meher' }, first);
    try {
      voteIs('closed', 10);
      expect(await more('tap_m1')).toEqual({ result: 'done', toast: 'The vote has closed' });
      voteIs('open', 20);
      expect(await more('tap_m2')).toEqual({ result: 'done', toast: 'This vote has 20 options, the most one vote takes' });
      voteIs('open', 10);
      // The Server refuses the add: the new card is dropped, so its stays were never shown, and the next tap offers them.
      const adds = lb.link.sent('add_vote_options').length;
      lb.link.failNext = { method: 'add_vote_options', error: new SocketCallError(409, 'conflict: the vote closed') };
      expect(await more('tap_m3a')).toEqual({ result: 'done' });
      await eventually(() => lb.link.sent('add_vote_options').length > adds);
      await eventually(async () => (await results.card('t_goa', stableId(MORE_CARD, 'tap_m3a'))) === null);
      expect(lb.link.sent('post_message').some((p) => (p.card as { card_id?: string } | undefined)?.card_id === stableId(MORE_CARD, 'tap_m3a'))).toBe(false);
      expect(await more('tap_m3')).toEqual({ result: 'done' });
      const cardId = stableId(MORE_CARD, 'tap_m3');
      const posted = () => lb.link.sent('post_message').find((p) => (p.card as { card_id?: string } | undefined)?.card_id === cardId);
      await eventually(() => posted() !== undefined);
      const next = C.OptionsCard.parse(posted()!.card);
      // The two stays no card showed, in the same vote, and nothing more to show after them.
      expect(next.options.map((o) => o.title)).toEqual(['Stay 11', 'Stay 12']);
      expect(next).toMatchObject({ title: `More: ${first.title}`, decision_id: shown.decision_id, actions: [] });
      const added = lb.link.sent('add_vote_options').at(-1)!;
      expect(added).toMatchObject({ request_id: stableId('go_more', 'tap_m3'), trip_id: 't_goa', decision_id: shown.decision_id });
      expect((added.options as Array<{ option_ref: string }>).map((o) => o.option_ref)).toEqual(next.options.map((o) => o.option_id));
      // The card tapped hands its See more on: the newest card of the vote has it, or none does.
      await eventually(() => lb.link.sent('replace_card').some((p) => (p.card as { card_id: string }).card_id === first.card_id));
      expect(lb.link.sent('replace_card').filter((p) => (p.card as { card_id: string }).card_id === first.card_id).at(-1)).toMatchObject({ card: { actions: [], decision_id: shown.decision_id } });
      // Every one shown now: a toast, and nothing posted.
      const posts = lb.link.sent('post_message').length;
      expect(await more('tap_m4')).toEqual({ result: 'done', toast: ALL_SHOWN });
      expect(lb.link.sent('post_message')).toHaveLength(posts);
    } finally {
      lb.link.request = real;
    }
  });

  // Your reviewer, 11 Oct: a 503 from add_vote_options may have added them on the Server all the same.
  it('"See more" keeps its card, unposted, when the Server may have added its stays (a 503), and never adds them twice', async () => {
    const results = createResultsStore(db.pool);
    const options: ResultOption[] = Array.from({ length: 11 }, (_, i) => ({
      kind: 'stay', title: `Assagao ${i + 1}`, priceMinor: 500_000, totalMinor: 1_500_000, currency: 'INR', priceNote: 'per night, per room',
      highlights: [], facts: { nights: 3 }, sourceUrl: `https://www.ixigo.com/hotels/${9100 + i}/details?hName=Assagao%20${i + 1}`,
    }));
    const set = await results.save({ tripId: 't_goa', optionKind: 'stay', source: 'search', query: { area: 'assagao', guests: 5 }, options, checkedAt: '2026-10-07T12:00:00.000Z' });
    const ctx = lb.ctx({ turnId: 'turn_more2' });
    const shown = (await lb.tools.run('show_options', { line: 'Here are stays in Assagao.', results_id: set.resultsId, title: 'Stays in Assagao' }, ctx)) as any;
    const first = C.OptionsCard.parse(ctx.cards[0]);
    const real = lb.link.request.bind(lb.link);
    lb.link.request = (async (method: string, params: unknown) =>
      method === 'read_trip'
        ? { ...GOA_TRIP, decisions: [{ decision_id: shown.decision_id, status: 'open', options: Array.from({ length: 10 }, (_, i) => ({ label: `S${i}` })) }] }
        : real(method as 'post_message', params as never)) as typeof lb.link.request;
    const more = (tapId: string) => lb.taps.tap('options', 'more_options', { tap_id: tapId, trip_id: 't_goa', card_id: first.card_id, action_id: 'more_options', person_id: 'p_meher' }, first);
    try {
      const adds = lb.link.sent('add_vote_options').length;
      lb.link.failNext = { method: 'add_vote_options', error: new SocketCallError(503, 'unavailable') };
      expect(await more('tap_m5')).toEqual({ result: 'done' });
      await eventually(() => lb.link.sent('add_vote_options').length > adds);
      await new Promise((r) => setTimeout(r, 50));
      const kept = stableId(MORE_CARD, 'tap_m5');
      expect(await results.card('t_goa', kept)).not.toBeNull();
      expect(lb.link.sent('post_message').some((p) => (p.card as { card_id?: string } | undefined)?.card_id === kept)).toBe(false);
      // Its stay counts as shown: the next See more never adds it again.
      expect(await more('tap_m6')).toEqual({ result: 'done', toast: ALL_SHOWN });
    } finally {
      lb.link.request = real;
    }
  });

  // Keshav, 11 Oct: "show 10 then see more button, and on click 10 more etc", for each traveller's own tickets too.
  it("\"See more\" on a ticket's card puts the next 10 on a card of the tapper's own, for them alone, and each person has their own next 10", async () => {
    const results = createResultsStore(db.pool);
    const flight = (i: number): ResultOption => ({
      kind: 'flight', title: `IndiGo 6E${2100 + i}`, priceMinor: 600_000 + i * 1_000, currency: 'INR', priceNote: 'per person', highlights: [], facts: {},
      sourceUrl: `https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026#${i}`,
    });
    const options = Array.from({ length: 13 }, (_, i) => flight(i + 1));
    const set = await results.save({ tripId: 't_goa', optionKind: 'flight', source: 'search', query: { from: 'Delhi', to: 'Goa' }, options, checkedAt: '2026-10-07T12:00:00.000Z' });
    const ctx = lb.ctx({ turnId: 'turn_more3' });
    await lb.tools.run('show_options', { line: 'Flights from Delhi.', results_id: set.resultsId, title: 'Flights, Delhi to Goa', option_numbers: [2] }, ctx);
    const first = C.OptionsCard.parse(ctx.cards[0]);
    expect(first.options.map((o) => o.title)).toEqual([2, 1, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `IndiGo 6E${2100 + n}`));
    expect(first.decision_id ?? null).toBeNull();
    expect(first.actions).toEqual([PICK_ACTION, C.MORE_OPTIONS]);
    const more = (tapId: string, personId: string) =>
      lb.taps.tap('options', 'more_options', { tap_id: tapId, trip_id: 't_goa', card_id: first.card_id, action_id: 'more_options', person_id: personId }, first);
    const posted = (tapId: string) => lb.link.sent('post_message').find((p) => (p.card as { card_id?: string } | undefined)?.card_id === stableId(MORE_CARD, tapId));
    const rest = ['IndiGo 6E2111', 'IndiGo 6E2112', 'IndiGo 6E2113'];
    expect(await more('tap_f1', 'p_meher')).toEqual({ result: 'done' });
    await eventually(() => posted('tap_f1') !== undefined);
    const mine = C.OptionsCard.parse(posted('tap_f1')!.card);
    expect(mine.options.map((o) => o.title)).toEqual(rest);
    // Hers alone, with nothing more after these: "I'll take this" only.
    expect(posted('tap_f1')).toMatchObject({ visible_to_person_ids: ['p_meher'] });
    expect(mine).toMatchObject({ for_person_ids: ['p_meher'], actions: [{ ...PICK_ACTION, only_for_person_ids: ['p_meher'] }] });
    expect(mine.decision_id ?? null).toBeNull();
    expect(lb.link.sent('add_vote_options').some((p) => p['request_id'] === stableId('go_more', 'tap_f1'))).toBe(false);
    // Priya's next 10 are the same three: Meher's card was Meher's alone.
    expect(await more('tap_f2', 'p_priya')).toEqual({ result: 'done' });
    await eventually(() => posted('tap_f2') !== undefined);
    expect(C.OptionsCard.parse(posted('tap_f2')!.card).options.map((o) => o.title)).toEqual(rest);
    // Meher has seen them all: a toast. The room's card keeps its See more, for everyone else's next 10.
    expect(await more('tap_f3', 'p_meher')).toEqual({ result: 'done', toast: ALL_SHOWN });
    expect(lb.link.sent('replace_card').some((p) => (p.card as { card_id: string }).card_id === first.card_id)).toBe(false);
  });

  it("\"See more\" reads ixigo's next page once the search's own stays are shown, the same stays never twice, and takes See more off when it brings nothing new", async () => {
    const results = createResultsStore(db.pool);
    // A second read gives a stay's address a new token: the same hotel all the same.
    const stay = (i: number, token = 'a'): TravelOption => ({
      kind: 'stay', title: `Morjim ${i}`, priceMinor: 500_000 + i * 1_000, totalMinor: 1_500_000 + i * 3_000, currency: 'INR', priceNote: 'per night, per room',
      highlights: [], facts: { nights: 3 }, sourceUrl: `https://www.ixigo.com/hotels/${9300 + i}/details?hName=Morjim%20${i}&hotelInfoToken=${token}`,
    });
    const query = { area: 'Morjim', checkIn: '2026-11-06', checkOut: '2026-11-09', guests: 5 };
    const page1 = Array.from({ length: 10 }, (_, i) => stay(i + 1));
    const show = async (turnId: string) => {
      const set = await results.save({ tripId: 't_goa', optionKind: 'stay', source: 'search', query, options: page1 as ResultOption[], checkedAt: '2026-10-07T12:00:00.000Z', siteMore: true });
      const ctx = lb.ctx({ turnId });
      const shown = (await lb.tools.run('show_options', { line: 'Stays in Morjim.', results_id: set.resultsId, title: 'Stays in Morjim' }, ctx)) as any;
      return { set, shown, first: C.OptionsCard.parse(ctx.cards[0]) };
    };
    const travel = lb.brain.travel!;
    const realSearch = travel.search;
    const realRequest = lb.link.request.bind(lb.link);
    const reads: Array<[string, unknown, unknown]> = [];
    let next: TravelOption[] = [];
    travel.search = (async (kind: string, q: unknown, o: unknown) => {
      reads.push([kind, q, o]);
      return { results: next, checkedAt: '2026-10-07T12:05:00.000Z', listed: next.length };
    }) as typeof travel.search;
    try {
      const { set, shown, first } = await show('turn_more4');
      // All ten of page 1 on the card, and See more: ixigo has more.
      expect(first.options).toHaveLength(10);
      expect(first).toMatchObject({ decision_id: shown.decision_id, actions: [C.MORE_OPTIONS] });
      lb.link.request = (async (method: string, params: unknown) =>
        method === 'read_trip'
          ? { ...GOA_TRIP, decisions: [{ decision_id: shown.decision_id, status: 'open', options: Array.from({ length: 10 }, (_, i) => ({ label: `S${i}` })) }] }
          : realRequest(method as 'post_message', params as never)) as typeof lb.link.request;
      // Pages 1 and 2: page 1's stays again, with new tokens, then eight more.
      next = [...Array.from({ length: 10 }, (_, i) => stay(i + 1, 'b')), ...Array.from({ length: 8 }, (_, i) => stay(i + 11, 'b'))];
      expect(await lb.taps.tap('options', 'more_options', { tap_id: 'tap_p1', trip_id: 't_goa', card_id: first.card_id, action_id: 'more_options', person_id: 'p_meher' }, first))
        .toEqual({ result: 'done', toast: 'Looking for more on ixigo' });
      const cardId = stableId(MORE_CARD, 'tap_p1');
      const posted = () => lb.link.sent('post_message').find((p) => (p.card as { card_id?: string } | undefined)?.card_id === cardId);
      await eventually(() => posted() !== undefined);
      // The same search, two pages of it, on the stage like any search.
      expect(reads).toEqual([['stays', { ...query, pages: 2 }, { tripId: 't_goa' }]]);
      const second = C.OptionsCard.parse(posted()!.card);
      expect(second.options.map((o) => o.title)).toEqual(Array.from({ length: 8 }, (_, i) => `Morjim ${i + 11}`));
      // In the same vote, and nothing more after: ixigo's two pages read, every stay shown.
      expect(second).toMatchObject({ decision_id: shown.decision_id, actions: [] });
      const kept = await results.get('t_goa', set.resultsId);
      expect(kept?.options).toHaveLength(18);
      expect(kept?.query).toEqual({ ...query, pages: 2 });
      expect(kept?.siteMore).toBeUndefined();

      // A next page with nothing new: no card, and the card tapped loses its See more.
      const other = await show('turn_more5');
      next = Array.from({ length: 10 }, (_, i) => stay(i + 1, 'c'));
      const posts = lb.link.sent('post_message').length;
      lb.link.request = (async (method: string, params: unknown) =>
        method === 'read_trip'
          ? { ...GOA_TRIP, decisions: [{ decision_id: other.shown.decision_id, status: 'open', options: Array.from({ length: 10 }, (_, i) => ({ label: `S${i}` })) }] }
          : realRequest(method as 'post_message', params as never)) as typeof lb.link.request;
      expect(await lb.taps.tap('options', 'more_options', { tap_id: 'tap_p2', trip_id: 't_goa', card_id: other.first.card_id, action_id: 'more_options', person_id: 'p_meher' }, other.first))
        .toEqual({ result: 'done', toast: 'Looking for more on ixigo' });
      await eventually(() => lb.link.sent('replace_card').some((p) => (p.card as { card_id: string }).card_id === other.first.card_id));
      expect(lb.link.sent('replace_card').filter((p) => (p.card as { card_id: string }).card_id === other.first.card_id).at(-1)).toMatchObject({ card: { actions: [] } });
      expect(lb.link.sent('post_message')).toHaveLength(posts);
      expect((await results.get('t_goa', other.set.resultsId))?.siteMore).toBeUndefined();
      // Nothing more anywhere now: a toast.
      expect(await lb.taps.tap('options', 'more_options', { tap_id: 'tap_p3', trip_id: 't_goa', card_id: other.first.card_id, action_id: 'more_options', person_id: 'p_meher' }, other.first))
        .toEqual({ result: 'done', toast: ALL_SHOWN });
    } finally {
      travel.search = realSearch;
      lb.link.request = realRequest;
    }
  });

  // The lead, 11 Oct: a typed "show more" at 07:58 closed the card's vote and opened a new one.
  it('takes a typed "show more" right after an options card as its See more: the next stays in the same vote, with no model round', async () => {
    expect(['more', 'show more', '@Go show more please', 'See more options', 'more?', 'aur dikhao', 'give me some more'].map(asksForMore)).toEqual(Array(7).fill(true));
    expect(['no more', 'show more villas with a pool', 'more people are coming', 'any more?'].map(asksForMore)).toEqual(Array(4).fill(false));
    const results = createResultsStore(db.pool);
    const options: ResultOption[] = Array.from({ length: 12 }, (_, i) => ({
      kind: 'stay', title: `Calangute ${i + 1}`, priceMinor: 500_000, totalMinor: 1_500_000, currency: 'INR', priceNote: 'per night, per room',
      highlights: [], facts: { nights: 3 }, sourceUrl: `https://www.ixigo.com/hotels/${9500 + i}/details?hName=Calangute%20${i + 1}`,
    }));
    const set = await results.save({ tripId: 't_goa', optionKind: 'stay', source: 'search', query: { area: 'calangute', guests: 5 }, options, checkedAt: '2026-10-07T12:00:00.000Z' });
    const shownCtx = lb.ctx({ turnId: 'turn_tm1' });
    const shown = (await lb.tools.run('show_options', { line: 'Stays in Calangute.', results_id: set.resultsId, title: 'Stays in Calangute' }, shownCtx)) as any;
    const first = C.OptionsCard.parse(shownCtx.cards[0]);
    // The chat: Go's card, then what they said after it.
    const chat = (...said: Message[]) => ({ ...goaPack(), messages: [...goaPack().messages, msg(95, null, 'Stays in Calangute.', { card: first }), ...said] });
    const direct = async (said: Message, pack: ReturnType<typeof chat>) => {
      const wake: DeskItem[] = [{ id: `msg:t_goa:${said.message_id}`, tripId: 't_goa', kind: 'message', ref: said.message_id, dueAt: new Date(), payload: { messageId: said.message_id, seq: said.seq } }];
      const turn = lb.ctx({ turnId: `turn_${said.message_id}` });
      for (const fn of lb.context.directs) if (await fn({ tripId: 't_goa', wake, pack, ctx: turn })) return turn;
      return null;
    };
    const real = lb.link.request.bind(lb.link);
    lb.link.request = (async (method: string, params: unknown) =>
      method === 'read_trip'
        ? { ...GOA_TRIP, decisions: [{ decision_id: shown.decision_id, status: 'open', options: Array.from({ length: 10 }, (_, i) => ({ label: `S${i}` })) }] }
        : real(method as 'post_message', params as never)) as typeof lb.link.request;
    try {
      // More than "more" goes to the model.
      const other = msg(96, 'p_meher', 'show more villas with a pool');
      expect(await direct(other, chat(other))).toBeNull();
      const votes = [lb.link.sent('open_vote').length, lb.link.sent('close_vote').length];
      const ask = msg(97, 'p_meher', '@Go show more');
      const turn = await direct(ask, chat(ask));
      // Answered with no line: the card follows, as a tap's does.
      expect(turn).toMatchObject({ answered: true, lines: [] });
      const cardId = stableId(MORE_CARD, ask.message_id);
      const posted = () => lb.link.sent('post_message').find((p) => (p.card as { card_id?: string } | undefined)?.card_id === cardId);
      await eventually(() => posted() !== undefined);
      const next = C.OptionsCard.parse(posted()!.card);
      expect(next.options.map((o) => o.title)).toEqual(['Calangute 11', 'Calangute 12']);
      // In the same vote: none opened, none closed.
      expect(next.decision_id).toBe(shown.decision_id);
      expect([lb.link.sent('open_vote').length, lb.link.sent('close_vote').length]).toEqual(votes);
      // Its See more handed on to the new card, the last thing it does before the next "more" may run.
      await eventually(() => lb.link.sent('replace_card').some((p) => (p.card as { card_id: string }).card_id === first.card_id));
      await new Promise((r) => setTimeout(r, 20));
      // Nothing more: said in the line, as the tap toasts it.
      const again = msg(98, 'p_meher', 'more');
      expect(await direct(again, chat(ask, again))).toMatchObject({ answered: true, lines: [`${ALL_SHOWN}.`] });
    } finally {
      lb.link.request = real;
    }
  });

  it('"Add my budget" opens the App\'s own budget sheet for the trip, a go:// link (contract 1.1 A4)', async () => {
    const tapIt = await lb.taps.tap('options', 'add_budget', { tap_id: 'tap_b1', trip_id: 't_goa', card_id: 'c_any', action_id: 'add_budget', person_id: 'p_meher' }, {} as C.Card);
    expect(tapIt).toEqual({ result: 'open', url: 'go://trips/t_goa/sheet/budget', expires_at: new Date(lb.brain.now().getTime() + 600_000).toISOString() });
    expect(C.CardActionResult.parse(tapIt)).toEqual(tapIt);
  });

  // A link card already in a room (search link cards before G1, 11 Oct; a PNR's today) opens its own ixigo page.
  it('"See on ixigo" opens the link card\'s own ixigo page', async () => {
    const page = 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026';
    const link = buildIxigoLinkCard({ cardId: 'c_link_r1', title: 'Flights, Delhi to Goa', url: page });
    const tapIt = (c: C.Card) => lb.taps.tap('notice', 'see_on_ixigo', { tap_id: 'tap_l1', trip_id: 't_goa', card_id: c.card_id, action_id: 'see_on_ixigo', person_id: 'p_meher' }, c);
    expect(await tapIt(link)).toEqual({ result: 'open', url: page, expires_at: new Date(lb.brain.now().getTime() + 600_000).toISOString() });
    expect(await tapIt({ ...link, source: { name: 'elsewhere', url: 'https://fares.example/x' } })).toEqual({ result: 'refused', toast: 'This card has no ixigo page' });
  });

  it("closes the image fetcher's connections and the ixigo connection through brain.onStop", async () => {
    // The fake alone: the image fetcher, the screen's Bash streams (screen-feed.ts), the live view's viewers (live.ts), the
    // stays head starts waiting for an edit to settle (warm.ts), the watch checks (recipe-watches.ts), the person's
    // login's keep-alive (login-keepalive.ts), the minute's look at one-tap logins (login.ts sweep) and at the flight
    // bookings waiting on a login (booking/flight-booking.ts sweep), each stopped by name where it has one.
    expect(lb.stoppers).toHaveLength(8);
    expect(lb.stoppers.map((f) => f.name)).toEqual(expect.arrayContaining(['stopWatchChecks', 'stopHeadStarts', 'stopLoginKeepAlive', 'stopLoginSweep', 'stopBookingSweep']));
    const withIxigo = makeLaneBrain({ pool: db.pool, env: { IXIGO_MCP_URL: 'http://127.0.0.1:1/mcp', IXIGO_MCP_TOKEN: 'tok-ixigo-123456' } });
    await registerTravel(withIxigo.brain);
    expect(withIxigo.stoppers).toHaveLength(9);
    expect(withIxigo.stoppers.map((f) => f.name)).toEqual(expect.arrayContaining(['stopWatchChecks', 'stopHeadStarts', 'stopLoginSweep', 'stopBookingSweep']));
    // The client connects on its first call, so closing one that never called resolves at once.
    await withIxigo.stop();
    expect(withIxigo.stoppers).toEqual([]);
    await withIxigo.http.close();
  });
});
