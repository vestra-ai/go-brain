import * as C from '@go/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SAY_NOTHING } from '../../composer/tools.js';
import { withSchema } from '../../db/test-db.js';
import { eventually, makeLaneBrain, type LaneBrain } from '../../tasks/testing/lane-brain.js';
import { goaPack } from '../../tasks/testing/goa.js';
import type { EngineAnswer, RunFor } from '../book/engine.js';
import { eachDeadlineMs, flightsEachTool, flightsFor, FLIGHTS_EACH, planEach } from '../flights-each.js';
import type { RecipeOption } from '../recipes/recipe.js';
import { createResultsStore, type ResultsStore } from '../results.js';
import { registerTravelTaps } from '../taps.js';

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
const toolWith = (answer: (o: RunFor) => Promise<EngineAnswer>, o: { live?: boolean; waitMs?: number } = {}) =>
  flightsEachTool({
    engine: { answer: async (id, given, run) => (asked.push({ id, given }), id === FLIGHTS_EACH ? answer(run) : Promise.reject(new Error(id))) },
    results, link: lb.link, now: lb.brain.now, live: () => o.live ?? true, waitMs: o.waitMs ?? 5_000, cardDelayMs: 60_000,
  });
type Posted = { text: string; card: C.Card };
const postedSince = (from: number): Posted[] =>
  lb.link.requests.slice(from).filter((r) => r.method === 'post_message' && (r.params['card'] as C.Card | undefined)?.kind !== 'working').map((r) => ({ text: String(r.params['text']), card: r.params['card'] as C.Card }));

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

  it('posts a card for each city and window, for its people alone, a link for a city whose page did not come, and ends the turn quietly', async () => {
    const ctx = lb.ctx({ turnId: 'turn_each1' });
    const from = lb.link.requests.length;
    const out = await toolWith(async (run) => (tellAll(run), COMPARE)).run({ cabin: 'economy' }, ctx);
    expect(asked.at(-1)).toEqual({ id: FLIGHTS_EACH, given: { to: 'North Goa', date: '2026-11-06', cabin: 'economy' } });
    expect(out).toMatchObject({ answered: false, tell_the_room: SAY_NOTHING });
    expect([ctx.cards, ctx.lines]).toEqual([[], []]);
    const posted = postedSince(from);
    const byTitle = new Map(posted.map((p) => [(p.card as { title: string }).title, p]));
    expect([...byTitle.keys()].sort()).toEqual([
      'Flights for Arjun, Bangalore to North Goa',
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
    expect(card.actions?.map((a) => [a.action_id, a.only_for_person_ids])).toEqual([['pick', ['p_rahul']], ['open', ['p_rahul']]]);
    expect(rahul.text).toBe('Rahul, your flights from Delhi on Fri 6 Nov, after 6 pm: 3 fit, from ₹6,000 a person. Tap "I\'ll take this" on yours.');
    // Bangalore's page didn't come: Arjun gets ixigo's own page, pinned to him.
    const arjun = byTitle.get('Flights for Arjun, Bangalore to North Goa')!;
    expect(arjun.card).toMatchObject({ kind: 'notice', for_person_ids: ['p_arjun'], source: { url: expect.stringContaining('from=BLR') } });
    expect((arjun.card as { actions: Array<{ only_for_person_ids?: string[] }> }).actions.map((a) => a.only_for_person_ids)).toEqual([['p_arjun']]);
    expect(arjun.text).toMatch(/^Arjun, Go couldn't read the flights from Bangalore just now/);
    // Rahul's pick on his card is his own: his confirm, never a vote.
    expect(await lb.taps.tap('options', 'pick', { tap_id: 'tap_each1', trip_id: 't_goa', card_id: card.card_id, action_id: 'pick', person_id: 'p_rahul', option_id: card.options[0]!.option_id }, card))
      .toEqual({ result: 'done', toast: "It's yours to confirm" });
  });

  it('four travellers from four cities get four cards, each theirs alone to act on, none with a vote (the Server team, 10 Oct)', async () => {
    const pack = goaPack();
    const homes: Record<string, string> = { Rahul: 'Delhi', Priya: 'Pune', Arjun: 'Bengaluru', Meher: 'Mumbai' };
    const people = pack.trip.people.filter((p) => homes[p.name]).map((p) => ({ ...p, from_city: homes[p.name]!, earliest_leave: null }));
    const ctx = lb.ctx({ turnId: 'turn_each6', pack: { ...pack, trip: { ...pack.trip, people } } });
    const from = lb.link.requests.length;
    const cities = ['Delhi', 'Pune', 'Bengaluru', 'Mumbai'];
    await toolWith(async (run) => {
      run.onSteps?.({ type: 'entries', entries: cities });
      for (const entry of cities) {
        run.onSteps?.({ type: 'step', entry, recipe: 'flights.results', ok: true, answer: options(DELHI) });
        run.onSteps?.({ type: 'step', entry, recipe: 'flights.search', ok: true, answer: link('X') });
      }
      return COMPARE;
    }).run({}, ctx);
    const cards = postedSince(from).map((p) => C.OptionsCard.parse(p.card));
    expect(cards.map((c) => c.for_person_ids).sort()).toEqual([['p_arjun'], ['p_meher'], ['p_priya'], ['p_rahul']]);
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

  it("gives the composite one paced flights page per city: 81 s for three, never past 90 s", () => {
    expect([eachDeadlineMs(1), eachDeadlineMs(3), eachDeadlineMs(4)]).toEqual([37_000, 81_000, 90_000]);
  });
});
