import * as C from '@go/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SAY_NOTHING } from '../../composer/tools.js';
import { withSchema } from '../../db/test-db.js';
import type { DeskItem } from '../../desk/desk.js';
import { eventually, makeLaneBrain, type LaneBrain } from '../../tasks/testing/lane-brain.js';
import { goaPack } from '../../tasks/testing/goa.js';
import type { EngineAnswer, RunFor } from '../book/engine.js';
import { eachDeadlineMs, eachTryAgain, flightsEachTool, flightsFor, FLIGHTS_EACH, planEach } from '../flights-each.js';
import { TravelError } from '../mcp-travel.js';
import type { RecipeOption } from '../recipes/recipe.js';
import { createResultsStore, type ResultsStore } from '../results.js';
import { registerTravelTaps } from '../taps.js';
import { TRIES, type TryAgainItem } from '../try-again.js';
import { asksForOwn } from '../asker.js';
import { msg } from '../../__tests__/fixtures/goa.js';

let db: Awaited<ReturnType<typeof withSchema>>;
let lb: LaneBrain;
let results: ResultsStore;

beforeAll(async () => {
  db = await withSchema();
  lb = makeLaneBrain({ pool: db.pool });
  results = createResultsStore(db.pool);
  registerTravelTaps(lb.taps, { results, pool: lb.brain.pool, link: lb.brain.door.link, desk: lb.brain.desk, now: lb.brain.now, log: lb.brain.log });
});
afterAll(async () => {
  await db.drop();
});

// The Goa trip flies Friday 6 Nov: Rahul (Delhi, "Fri after 6 pm"), Priya (Delhi), Arjun (Bangalore), Meher (Mumbai) and
// Kabir (Delhi, "Fri evening").
function flight(title: string, code: string, rupees: number, depart: string, from = 'DEL', seats?: number): RecipeOption {
  return {
    kind: 'flight', title, priceMinor: rupees * 100, currency: 'INR', priceNote: 'per person',
    journey: {
      mode: 'flight', origin: { name: from, code: from }, destination: { name: 'Goa', code: 'GOX' },
      depart_at: `2026-11-06T${depart}:00+05:30`, arrive_at: `2026-11-06T${depart.replace(/^\d\d/, (h) => String(Number(h) + 2).padStart(2, '0'))}:00+05:30`,
      carrier_name: title.split(' ')[0]!, carrier_code: code, number: title.split(' ').at(-1)!,
    },
    highlights: ['Non-stop'], facts: { stops: 0, ...(seats !== undefined ? { seats_left: seats } : {}) },
    sourceUrl: `https://www.ixigo.com/search/result/flight?from=${from}&to=GOX&date=06112026&adults=3`,
  };
}
const DELHI = [
  flight('IndiGo 6E2001', '6E', 4_000, '07:00'),
  flight('Air India AI101', 'AI', 5_500, '17:30'),
  flight('IndiGo 6E2134', '6E', 6_000, '18:15'),
  flight('Vistara UK811', 'UK', 7_200, '19:40'),
  flight('Akasa QP1100', 'QP', 5_000, '21:00', 'DEL', 0),
  flight('SpiceJet SG8169', 'SG', 6_500, '20:30'),
];
const MUMBAI = [flight('IndiGo 6E5310', '6E', 3_900, '09:10', 'BOM')];
const options = (list: RecipeOption[]): EngineAnswer => ({ as: 'options', options: list, page: 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOX', checkedAt: '2026-10-10T09:00:00.000Z', ms: 4_100 });
const link = (from: string): EngineAnswer => ({ as: 'link', link: `https://www.ixigo.com/search/result/flight?from=${from}&to=GOX&date=06112026&adults=1`, title: 'Flights', who: null });
const COMPARE: EngineAnswer = { as: 'compare', inputs: { to: 'North Goa', date: '2026-11-06' }, entries: [], checkedAt: '2026-10-10T09:00:00.000Z', ms: 30_000 };

/** The composite's steps as the engine tells them: Delhi's and Mumbai's pages read, Bangalore's held back (its link only). */
function tellAll(run: RunFor): void {
  run.onSteps?.({ type: 'entries', entries: ['Delhi', 'Bangalore', 'Mumbai'] });
  run.onSteps?.({ type: 'step', entry: 'Delhi', recipe: 'flights.results', ok: true, answer: options(DELHI) });
  run.onSteps?.({ type: 'step', entry: 'Delhi', recipe: 'flights.search', ok: true, answer: link('DEL') });
  run.onSteps?.({ type: 'step', entry: 'Bangalore', recipe: 'flights.search', ok: true, answer: link('BLR') });
  run.onSteps?.({ type: 'step', entry: 'Bangalore', recipe: 'flights.results', ok: false });
  run.onSteps?.({ type: 'step', entry: 'Mumbai', recipe: 'flights.results', ok: true, answer: options(MUMBAI) });
  run.onSteps?.({ type: 'step', entry: 'Mumbai', recipe: 'flights.search', ok: true, answer: link('BOM') });
}

const asked: Array<{ id: string; given: Record<string, unknown> }> = [];
/** The tries again a city whose page didn't come put on the desk. */
const puts: DeskItem[] = [];
const desk = { put: async (item: Omit<DeskItem, 'id'> & { id?: string }) => { puts.push({ ...item, id: item.id! }); } };
const toolWith = (answer: (o: RunFor) => Promise<EngineAnswer>, o: { live?: boolean; waitMs?: number; ixigoQuiet?: () => number | null } = {}) =>
  flightsEachTool({
    engine: { answer: async (id, given, run) => (asked.push({ id, given }), id === FLIGHTS_EACH ? answer(run) : Promise.reject(new Error(id))) },
    results, link: lb.link, now: lb.brain.now, desk, live: () => o.live ?? true, waitMs: o.waitMs ?? 5_000, cardDelayMs: 60_000,
    ...(o.ixigoQuiet ? { ixigoQuiet: o.ixigoQuiet } : {}),
  });
type Posted = { text: string; card: C.Card; visibleTo: string[] | undefined };
const postedSince = (from: number): Posted[] =>
  lb.link.requests.slice(from).filter((r) => r.method === 'post_message' && (r.params['card'] as C.Card | undefined)?.kind !== 'working').map((r) => ({
    text: String(r.params['text']), card: r.params['card'] as C.Card, visibleTo: r.params['visible_to_person_ids'] as string[] | undefined,
  }));

describe("each person's own flights, from their home city", () => {
  it('gives every traveller a card of their own, by their home city and leaving window', () => {
    const plan = planEach(goaPack().trip.people, 'North Goa', '2026-11-06');
    expect(plan.groups.map((g) => [g.home, g.people.map((p) => p.name), g.window?.words ?? null])).toEqual([
      ['Delhi', ['Rahul'], 'after 6 pm'],
      ['Delhi', ['Priya'], null],
      ['Bangalore', ['Arjun'], null],
      ['Mumbai', ['Meher'], null],
      ['Delhi', ['Kabir'], 'after 5 pm'],
    ]);
    expect([plan.noHome, plan.unread]).toEqual([[], []]);
    // Who hasn't said where they fly from is asked; words that aren't a time are said; a home at the trip's place flies nowhere.
    const people = goaPack().trip.people.map((p) =>
      p.name === 'Priya' ? { ...p, from_city: null } : p.name === 'Arjun' ? { ...p, earliest_leave: 'not sure yet' } : p.name === 'Meher' ? { ...p, from_city: 'North Goa' } : { ...p, earliest_leave: 'Fri after 6 pm' });
    const other = planEach(people, 'North Goa', '2026-11-06');
    // Rahul and Kabir, both Delhi after 6 pm: still a card each (the Server team's final round: one card per traveller).
    expect(other.groups.map((g) => [g.home, g.people.map((p) => p.name)])).toEqual([['Delhi', ['Rahul']], ['Bangalore', ['Arjun']], ['Delhi', ['Kabir']]]);
    expect([other.noHome, other.unread]).toEqual([['Priya'], [{ name: 'Arjun', text: 'not sure yet' }]]);
  });

  it("narrows one city's read to each window in Go: seats people can buy, the cheapest first, three at most", () => {
    const plan = planEach(goaPack().trip.people, 'North Goa', '2026-11-06');
    const [rahul, priya, , , kabir] = plan.groups;
    // Akasa at 9 pm has no seat left.
    expect(flightsFor(rahul!, DELHI)).toMatchObject({ fit: 3, shown: [{ title: 'IndiGo 6E2134' }, { title: 'SpiceJet SG8169' }, { title: 'Vistara UK811' }] });
    expect(flightsFor(kabir!, DELHI)).toMatchObject({ fit: 4, shown: [{ title: 'Air India AI101' }, { title: 'IndiGo 6E2134' }, { title: 'SpiceJet SG8169' }] });
    expect(flightsFor(priya!, DELHI)).toMatchObject({ fit: 5, shown: [{ title: 'IndiGo 6E2001' }, { title: 'Air India AI101' }, { title: 'IndiGo 6E2134' }] });
  });

  it('posts a card for each city and window, for its people alone, a plain line and a try again for a city whose page did not come, and ends the turn quietly', async () => {
    const ctx = lb.ctx({ turnId: 'turn_each1' });
    const from = lb.link.requests.length;
    const out = await toolWith(async (run) => (tellAll(run), COMPARE)).run({ cabin: 'economy' }, ctx);
    expect(asked.at(-1)).toEqual({ id: FLIGHTS_EACH, given: { to: 'North Goa', date: '2026-11-06', cabin: 'economy' } });
    expect(out).toMatchObject({ answered: false, tell_the_room: SAY_NOTHING });
    expect([ctx.cards, ctx.lines]).toEqual([[], []]);
    const posted = postedSince(from);
    const byTitle = new Map(posted.filter((p) => p.card).map((p) => [(p.card as { title: string }).title, p]));
    expect([...byTitle.keys()].sort()).toEqual([
      'Flights for Kabir, Delhi to North Goa, Fri 6 Nov, after 5 pm',
      'Flights for Meher, Mumbai to North Goa, Fri 6 Nov',
      'Flights for Priya, Delhi to North Goa, Fri 6 Nov',
      'Flights for Rahul, Delhi to North Goa, Fri 6 Nov, after 6 pm',
    ]);
    const rahul = byTitle.get('Flights for Rahul, Delhi to North Goa, Fri 6 Nov, after 6 pm')!;
    const card = C.OptionsCard.parse(rahul.card);
    expect(card.for_person_ids).toEqual(['p_rahul']);
    expect(card.options.map((o) => o.title)).toEqual(['IndiGo 6E2134', 'SpiceJet SG8169', 'Vistara UK811']);
    // Every button is Rahul's alone, and a ticket has no vote.
    // Its own pick only: each option carries its ixigo page (rev 5 R5), never a See on ixigo button.
    expect(card.actions?.map((a) => [a.action_id, a.only_for_person_ids])).toEqual([['pick', ['p_rahul']]]);
    expect(rahul.text).toBe('Rahul, your flights from Delhi on Fri 6 Nov, after 6 pm: 3 fit, from ₹6,000 a person. Tap "I\'ll take this" on yours.');
    // Bangalore's page didn't come: never a link card (G1, 11 Oct). Arjun hears it plainly, his alone, and Bangalore is
    // tried again in a minute.
    const arjun = posted.find((p) => !p.card)!;
    expect(arjun).toEqual({ text: "Arjun, I couldn't load your flights from Bangalore just now; I'll try again in a minute.", card: undefined, visibleTo: ['p_arjun'] });
    expect(rahul.visibleTo).toEqual(['p_rahul']);
    expect(posted.filter((p) => !p.card)).toHaveLength(1);
    expect(puts.at(-1)).toMatchObject({
      tripId: 't_goa', kind: 'search', ref: 'flights',
      payload: { source: 'travel_try_again', n: 1, what: 'flights from Bangalore', each: { home: 'Bangalore', to: 'North Goa', date: '2026-11-06', cabin: 'economy' } },
    });
    // Rahul's pick on his card is his own: his confirm, never a vote.
    expect(await lb.taps.tap('options', 'pick', { tap_id: 'tap_each1', trip_id: 't_goa', card_id: card.card_id, action_id: 'pick', person_id: 'p_rahul', option_id: card.options[0]!.option_id }, card))
      .toEqual({ result: 'done', toast: "It's yours to confirm" });
  });

  // The lead, 11 Oct: never ask ixigo again inside its own quiet (it refused a page: a 403, a 429, Cloudflare's check).
  it("tells that city's travellers ixigo asked us to slow down, theirs alone, and puts the city's try just past ixigo's quiet", async () => {
    const quietEnds = lb.brain.now().getTime() + 10 * 60_000;
    const from = lb.link.requests.length;
    await toolWith(async (run) => (tellAll(run), COMPARE), { ixigoQuiet: () => quietEnds }).run({}, lb.ctx({ turnId: 'turn_each_q' }));
    expect(postedSince(from).filter((p) => !p.card)).toEqual([{
      text: "Arjun, I couldn't load your flights from Bangalore: ixigo asked us to slow down, so I'll try again in about 10 minutes.", card: undefined, visibleTo: ['p_arjun'],
    }]);
    expect(puts.at(-1)).toMatchObject({ id: expect.stringMatching(new RegExp(`:1:${quietEnds}$`)), dueAt: new Date(quietEnds + 5_000), payload: { n: 1, each: { home: 'Bangalore' } } });
  });

  it("tries that city again: its people's cards, theirs alone, when it lands; the next try when it doesn't; after the last, one line to who asked", async () => {
    const tryOf = (n: number): TryAgainItem => ({
      id: `try_again:t_goa:each_blr:${n}`, tripId: 't_goa', kind: 'search', ref: 'flights', dueAt: lb.brain.now(),
      payload: { source: 'travel_try_again', key: 'each_blr', what: 'flights from Bangalore', n, each: { home: 'Bangalore', to: 'North Goa', date: '2026-11-06' } },
    });
    const runs: Array<[string, Record<string, unknown>, RunFor]> = [];
    const tries = (answer: () => Promise<EngineAnswer>) =>
      eachTryAgain({ engine: { answer: async (id, given, run) => (runs.push([id, given, run]), answer()) }, results, link: lb.link, now: lb.brain.now, desk });
    // It lands: Arjun's own card, his alone, from Bangalore's page read through ixigo's quiet.
    let from = lb.link.requests.length;
    tries(async () => options([flight('IndiGo 6E6301', '6E', 4_200, '10:00', 'BLR')]))(tryOf(1), goaPack());
    await eventually(() => postedSince(from).length === 1);
    expect(runs.at(-1)).toEqual(['flights.results', { from: 'Bangalore', to: 'North Goa', date: '2026-11-06' }, { tripId: 't_goa', retry: true }]);
    const landed = postedSince(from)[0]!;
    expect(landed.visibleTo).toEqual(['p_arjun']);
    expect(C.OptionsCard.parse(landed.card)).toMatchObject({ title: 'Flights for Arjun, Bangalore to North Goa, Fri 6 Nov', for_person_ids: ['p_arjun'] });
    expect(landed.text).toMatch(/^Arjun, your flights from Bangalore on Fri 6 Nov: 1 fits, from ₹4,200 a person\./);
    // It doesn't: the next try goes on the desk, a minute out, and nobody hears anything yet.
    const before = puts.length;
    from = lb.link.requests.length;
    tries(async () => { throw new TravelError('unreachable', "ixigo's page call answered 403."); })(tryOf(1), goaPack());
    await eventually(() => puts.length === before + 1);
    expect(puts.at(-1)).toMatchObject({ id: 'try_again:t_goa:each_blr:2', dueAt: new Date(lb.brain.now().getTime() + 60_000), payload: { n: 2, key: 'each_blr' } });
    expect(postedSince(from)).toEqual([]);
    // The last try doesn't either: nothing to everyone again (p2's re-audit, 11 Oct: a line a minute), never a link.
    const runsBefore = runs.length;
    tries(async () => link('BLR'))(tryOf(TRIES), goaPack());
    await eventually(() => runs.length === runsBefore + 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(postedSince(from)).toEqual([]);
    expect(puts).toHaveLength(before + 1);
    // Arjun asked for it: one closing line, his alone, so his "I'll try again in a minute" never reads as Go forgetting.
    const hisTry = tryOf(TRIES);
    hisTry.payload = { ...hisTry.payload, key: 'each_blr2', each: { ...hisTry.payload.each!, asker: 'p_arjun' } };
    tries(async () => link('BLR'))(hisTry, goaPack());
    await eventually(() => postedSince(from).length === 1);
    expect(postedSince(from)).toEqual([{ text: "I kept trying for over 20 minutes and still couldn't load your Bangalore flights, so I've stopped for now.", card: undefined, visibleTo: ['p_arjun'] }]);
    // Rahul asked for everyone's: Bangalore isn't his, and he hears nothing of it.
    const other = tryOf(TRIES);
    other.payload = { ...other.payload, key: 'each_blr3', each: { ...other.payload.each!, asker: 'p_rahul' } };
    const runsNow = runs.length;
    tries(async () => link('BLR'))(other, goaPack());
    await eventually(() => runs.length === runsNow + 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(postedSince(from)).toHaveLength(1);
  });

  // p2's re-audit of Keshav's Varkala trip (11 Oct): his "Book my flights" searched all five, and 20 private "I couldn't
  // load your flights" lines went up in four rounds a minute apart, 15 to people who never asked.
  it('takes "my flights" as the asker\'s alone, their city\'s page only, whoever the model names; "our" or "everyone\'s" for all', async () => {
    expect(['Book my flights', 'book flights for me', '@Go find my flight to Goa'].map(asksForOwn)).toEqual([true, true, true]);
    expect(['Book our flights', "find everyone's flights", 'flights for us', 'book flights', "my flight and everyone's"].map(asksForOwn)).toEqual([false, false, false, false, false]);
    const ask = msg(60, 'p_meher', '@Go book my flights');
    const wake: DeskItem[] = [{ id: 'w60', tripId: 't_goa', kind: 'message', ref: ask.message_id, dueAt: new Date(), payload: { messageId: ask.message_id } }];
    const ctx = lb.ctx({ turnId: 'turn_each_mine', wake, pack: { ...goaPack(), messages: [...goaPack().messages, ask] } });
    const from = lb.link.requests.length;
    const mumbai = (run: RunFor): void => {
      run.onSteps?.({ type: 'entries', entries: ['Mumbai'] });
      run.onSteps?.({ type: 'step', entry: 'Mumbai', recipe: 'flights.results', ok: true, answer: options(MUMBAI) });
      run.onSteps?.({ type: 'step', entry: 'Mumbai', recipe: 'flights.search', ok: true, answer: link('BOM') });
    };
    // The model named everyone: hers alone all the same.
    await toolWith(async (run) => (mumbai(run), COMPARE)).run({ person_ids: ['p_rahul', 'p_priya', 'p_arjun', 'p_meher', 'p_kabir'] }, ctx);
    // Her city's page alone.
    expect(asked.at(-1)).toEqual({ id: FLIGHTS_EACH, given: { to: 'North Goa', date: '2026-11-06', from: 'Mumbai' } });
    const posted = postedSince(from);
    expect(posted.map((p) => [(p.card as { title?: string } | undefined)?.title, p.visibleTo])).toEqual([['Flights for Meher, Mumbai to North Goa, Fri 6 Nov', ['p_meher']]]);
  });

  it("says a city's flights didn't load once to each person, never again on an ask again, and a try for one person's search stays theirs", async () => {
    const tool = toolWith(async (run) => (tellAll(run), COMPARE));
    const from = lb.link.requests.length;
    const before = puts.length;
    await tool.run({}, lb.ctx({ turnId: 'turn_each_once1' }));
    // "search again": the same search, a minute on.
    await tool.run({}, lb.ctx({ turnId: 'turn_each_once2' }));
    const lines = postedSince(from).filter((p) => !p.card);
    expect(lines.map((p) => p.visibleTo)).toEqual([['p_arjun']]);
    // Bangalore is still tried for each search, quietly.
    expect(puts.length).toBe(before + 2);
    // A try for Rahul's own search (his "my flights") makes his card alone, though Priya and Kabir fly from Delhi too.
    const at = lb.link.requests.length;
    const tryRahul: TryAgainItem = {
      id: 'try_again:t_goa:each_del:1', tripId: 't_goa', kind: 'search', ref: 'flights', dueAt: lb.brain.now(),
      payload: { source: 'travel_try_again', key: 'each_del', what: 'flights from Delhi', n: 1, each: { home: 'Delhi', to: 'North Goa', date: '2026-11-06', people: ['p_rahul'] } },
    };
    eachTryAgain({ engine: { answer: async () => options(DELHI) }, results, link: lb.link, now: lb.brain.now, desk })(tryRahul, goaPack());
    await eventually(() => postedSince(at).length === 1);
    expect(postedSince(at).map((p) => p.visibleTo)).toEqual([['p_rahul']]);
  });

  // Keshav's Varkala trip, 11 Oct: every city stopped on which airport, the model said "your Delhi flights card is up",
  // and each try said "Keshav Musunuri, I couldn't load your flights" on the same question.
  it("asks which airport by first name, never \"couldn't load\" and never a try on it; says exactly which cards went up, and the nearest airport plainly", async () => {
    const VARKALA: EngineAnswer = {
      as: 'options', options: DELHI, page: 'https://www.ixigo.com/search/result/flight?from=DEL&to=TRV', checkedAt: '2026-10-10T09:00:00.000Z', ms: 4_100,
      near: [{ words: 'Varkala', code: 'TRV', city: 'Thiruvananthapuram' }],
    };
    const which = 'pick_place: ixigo knows more than one place for "Mysore": MYQ Mysore, BLR Bengaluru.';
    const told = (run: RunFor): void => {
      run.onSteps?.({ type: 'entries', entries: ['Delhi', 'Bangalore', 'Mumbai'] });
      run.onSteps?.({ type: 'step', entry: 'Delhi', recipe: 'flights.results', ok: true, answer: VARKALA });
      run.onSteps?.({ type: 'step', entry: 'Delhi', recipe: 'flights.search', ok: true, answer: link('DEL') });
      run.onSteps?.({ type: 'step', entry: 'Bangalore', recipe: 'flights.results', ok: false, why: which });
      run.onSteps?.({ type: 'step', entry: 'Bangalore', recipe: 'flights.search', ok: false, why: which });
      run.onSteps?.({ type: 'step', entry: 'Mumbai', recipe: 'flights.results', ok: true, answer: options(MUMBAI) });
      run.onSteps?.({ type: 'step', entry: 'Mumbai', recipe: 'flights.search', ok: true, answer: link('BOM') });
    };
    const from = lb.link.requests.length;
    const before = puts.length;
    const out = (await toolWith(async (run) => (told(run), COMPARE)).run({}, lb.ctx({ turnId: 'turn_each_near' }))) as any;
    const posted = postedSince(from);
    // The nearest airport, said once in each card's own line.
    expect(posted.find((p) => p.visibleTo?.[0] === 'p_rahul')!.text).toContain('Varkala has no airport, so these are flights to Thiruvananthapuram (TRV).');
    // Arjun is asked which airport, by his first name and his alone; never "couldn't load", and nothing tried again.
    const arjun = posted.find((p) => p.visibleTo?.[0] === 'p_arjun')!;
    expect(arjun.text).toMatch(/^Arjun, .*Which one\?$/);
    expect(arjun.text).not.toContain("couldn't load");
    expect(puts).toHaveLength(before);
    // The model hears exactly which cards went up, and which didn't and why.
    expect(out.cards_up.map((c: { home: string }) => c.home).sort()).toEqual(['Delhi', 'Delhi', 'Delhi', 'Mumbai']);
    expect(out.not_up).toEqual([expect.objectContaining({ home: 'Bangalore', why: expect.stringContaining('which airport') })]);
    expect(out.note).toContain('Never say a card is up that is not in cards_up.');
    // A try that meets the same question asks it once, and tries no more.
    const tryItem: TryAgainItem = {
      id: 'try_again:t_goa:each_mys:1', tripId: 't_goa', kind: 'search', ref: 'flights', dueAt: lb.brain.now(),
      payload: { source: 'travel_try_again', key: 'each_mys', what: 'flights from Bangalore', n: 1, each: { home: 'Bangalore', to: 'North Goa', date: '2026-11-06' } },
    };
    const again = lb.link.requests.length;
    eachTryAgain({
      engine: { answer: async () => { throw new TravelError('pick_place', 'ixigo knows more than one place.', null, ['MYQ Mysore', 'BLR Bengaluru']); } },
      results, link: lb.link, now: lb.brain.now, desk,
    })(tryItem, goaPack());
    await eventually(() => postedSince(again).length === 1);
    expect(postedSince(again)[0]!.text).toBe('Arjun, which airport do you mean? ixigo has MYQ Mysore and BLR Bengaluru.');
    expect(puts).toHaveLength(before);
  });

  // Prod, 12 Oct (t_f0b08c1cdb0f7420): ixigo answered Delhi to Kullu, Manali's airport, with 200 and errors.code 201 "No
  // flights found", and each Delhi traveller heard "I couldn't load your flights from Delhi", with tries for 20 minutes.
  it("says ixigo has no flights from their city that day, theirs alone, with the bus next: never \"couldn't load\", never a try", async () => {
    const NONE: EngineAnswer = {
      as: 'options', options: [], page: 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOX', checkedAt: '2026-10-10T09:00:00.000Z', ms: 3_200,
      none: { from: { words: 'Delhi', code: 'DEL', city: 'New Delhi' }, to: { words: 'North Goa', code: 'GOX', city: 'Mopa' } },
    };
    const line = (name: string) =>
      `${name}, ixigo has no flights from Delhi to Mopa (North Goa's airport) on Fri 6 Nov. I can look for a bus from Delhi to North Goa instead: just say "bus".`;
    const told = (run: RunFor): void => {
      run.onSteps?.({ type: 'entries', entries: ['Delhi', 'Mumbai'] });
      run.onSteps?.({ type: 'step', entry: 'Delhi', recipe: 'flights.results', ok: true, answer: NONE });
      run.onSteps?.({ type: 'step', entry: 'Delhi', recipe: 'flights.search', ok: true, answer: link('DEL') });
      run.onSteps?.({ type: 'step', entry: 'Mumbai', recipe: 'flights.results', ok: true, answer: options(MUMBAI) });
      run.onSteps?.({ type: 'step', entry: 'Mumbai', recipe: 'flights.search', ok: true, answer: link('BOM') });
    };
    const from = lb.link.requests.length;
    const before = puts.length;
    const out = (await toolWith(async (run) => (told(run), COMPARE)).run({}, lb.ctx({ turnId: 'turn_each_none' }))) as any;
    const posted = postedSince(from);
    // Each Delhi traveller's own line, theirs alone, no card; and nothing tried again.
    for (const [id, name] of [['p_rahul', 'Rahul'], ['p_priya', 'Priya'], ['p_kabir', 'Kabir']] as const) {
      const theirs = posted.filter((p) => p.visibleTo?.length === 1 && p.visibleTo[0] === id);
      expect(theirs, name).toEqual([{ text: line(name), card: undefined, visibleTo: [id] }]);
    }
    expect(posted.map((p) => p.text).join(' ')).not.toContain("couldn't load");
    expect(puts).toHaveLength(before);
    // Mumbai's card still goes up; the model hears Delhi's is no card, and why.
    expect(out.cards_up.map((c: { home: string }) => c.home)).toEqual(['Mumbai']);
    expect(out.not_up.filter((c: { home: string }) => c.home === 'Delhi')).toHaveLength(3);
    expect(out.not_up.find((c: { home: string }) => c.home === 'Delhi').why).toContain('ixigo has no flights from there that day');
    // A try that reads ixigo's none says it, theirs alone, and tries no more.
    const tryItem: TryAgainItem = {
      id: 'try_again:t_goa:each_none:1', tripId: 't_goa', kind: 'search', ref: 'flights', dueAt: lb.brain.now(),
      payload: { source: 'travel_try_again', key: 'each_none', what: 'flights from Delhi', n: 1, each: { home: 'Delhi', to: 'North Goa', date: '2026-11-06' } },
    };
    const again = lb.link.requests.length;
    eachTryAgain({ engine: { answer: async () => NONE }, results, link: lb.link, now: lb.brain.now, desk })(tryItem, goaPack());
    await eventually(() => postedSince(again).length === 3);
    expect(postedSince(again).map((p) => [p.visibleTo, p.text])).toEqual([
      [['p_rahul'], line('Rahul')], [['p_priya'], line('Priya')], [['p_kabir'], line('Kabir')],
    ]);
    expect(puts).toHaveLength(before);
  });

  it('four travellers from four cities get four cards, each theirs alone to act on, none with a vote (the Server team, 10 Oct)', async () => {
    const pack = goaPack();
    const homes: Record<string, string> = { Rahul: 'Delhi', Priya: 'Pune', Arjun: 'Bengaluru', Meher: 'Mumbai' };
    const people = pack.trip.people.filter((p) => homes[p.name]).map((p) => ({ ...p, from_city: homes[p.name]!, earliest_leave: null }));
    const ctx = lb.ctx({ turnId: 'turn_each6', pack: { ...pack, trip: { ...pack.trip, people } } });
    const from = lb.link.requests.length;
    const cities = ['Delhi', 'Pune', 'Bengaluru', 'Mumbai'];
    await toolWith(async (run) => {
      // Each city's page waits its turn on Go's pacer as often as it takes (the engine's waitOutPace), never a link for a wait.
      expect(run.waitOutPace).toBe(true);
      run.onSteps?.({ type: 'entries', entries: cities });
      for (const entry of cities) {
        run.onSteps?.({ type: 'step', entry, recipe: 'flights.results', ok: true, answer: options(DELHI) });
        run.onSteps?.({ type: 'step', entry, recipe: 'flights.search', ok: true, answer: link('X') });
      }
      return COMPARE;
    }).run({}, ctx);
    const posted = postedSince(from);
    const cards = posted.map((p) => C.OptionsCard.parse(p.card));
    expect(cards.map((c) => c.for_person_ids).sort()).toEqual([['p_arjun'], ['p_meher'], ['p_priya'], ['p_rahul']]);
    // Each card is its traveller's alone to see as well (1.2): nobody else in the trip has it.
    for (const p of posted) expect(p.visibleTo).toEqual((p.card as { for_person_ids: string[] }).for_person_ids);
    for (const c of cards) {
      expect(c.actions?.every((a) => JSON.stringify(a.only_for_person_ids) === JSON.stringify(c.for_person_ids))).toBe(true);
      expect(c.actions?.map((a) => a.action_id)).not.toContain('vote');
    }
  });

  it("asks who hasn't said where they fly from, says words that aren't a time, and ends the turn on that line", async () => {
    const pack = goaPack();
    const people = pack.trip.people.map((p) => (p.name === 'Priya' ? { ...p, from_city: null } : p.name === 'Arjun' ? { ...p, earliest_leave: 'not sure yet' } : p));
    const ctx = lb.ctx({ turnId: 'turn_each2', pack: { ...pack, trip: { ...pack.trip, people } } });
    const out = await toolWith(async (run) => (tellAll(run), COMPARE)).run({}, ctx);
    expect(ctx.lines).toEqual(['Priya, where do you fly from? Arjun, "not sure yet" isn\'t a time, so your card has every flight.']);
    expect([ctx.answered, out]).toEqual([true, expect.objectContaining({ answered: true })]);
  });

  it("posts each city's cards as its page lands, past the turn's wait, the first before the others are in", async () => {
    const ctx = lb.ctx({ turnId: 'turn_each3' });
    const from = lb.link.requests.length;
    let tell: RunFor['onSteps'];
    let finish: (a: EngineAnswer) => void = () => undefined;
    const out = await toolWith(
      (run) => {
        tell = run.onSteps;
        run.onSteps?.({ type: 'entries', entries: ['Delhi', 'Bangalore', 'Mumbai'] });
        return new Promise((r) => (finish = r));
      },
      { waitMs: 30 },
    ).run({}, ctx);
    expect(out).toMatchObject({ running: true, tell_the_room: SAY_NOTHING });
    tell?.({ type: 'step', entry: 'Mumbai', recipe: 'flights.results', ok: true, answer: options(MUMBAI) });
    await eventually(() => postedSince(from).length === 1);
    expect(postedSince(from)[0]!.card).toMatchObject({ title: 'Flights for Meher, Mumbai to North Goa, Fri 6 Nov', for_person_ids: ['p_meher'] });
    tell?.({ type: 'step', entry: 'Delhi', recipe: 'flights.results', ok: true, answer: options(DELHI) });
    await eventually(() => postedSince(from).length === 4);
    finish(COMPARE);
  });

  it("says why it can't: not searching ixigo.com itself, or nobody has a home city yet", async () => {
    expect(await toolWith(async () => COMPARE, { live: false }).run({}, lb.ctx({ turnId: 'turn_each4' }))).toMatchObject({ error: 'not_here' });
    const pack = goaPack();
    const nobody = lb.ctx({ turnId: 'turn_each5', pack: { ...pack, trip: { ...pack.trip, people: pack.trip.people.map((p) => ({ ...p, from_city: null })) } } });
    expect(await toolWith(async () => COMPARE).run({}, nobody)).toMatchObject({ error: 'needs_more', note: expect.stringContaining('where do you fly from?') });
  });

  it("gives the composite one paced flights page per city, waiting its turn: two minutes for three, never past four", () => {
    expect([eachDeadlineMs(1), eachDeadlineMs(3), eachDeadlineMs(4), eachDeadlineMs(9)]).toEqual([60_000, 120_000, 150_000, 240_000]);
  });
});
