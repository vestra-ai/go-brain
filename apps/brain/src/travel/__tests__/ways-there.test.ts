import * as C from '@go/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { eventually, makeLaneBrain, type LaneBrain } from '../../tasks/testing/lane-brain.js';
import { PacedOutError, type EngineAnswer, type RunFor, type StepAnswer } from '../book/engine.js';
import { hoursMinutes } from '../book/expr.js';
import { TravelError } from '../mcp-travel.js';
import type { RecipeOption } from '../recipes/recipe.js';
import { createResultsStore, toResultOption, type ResultsStore } from '../results.js';
import { registerTravelTaps } from '../taps.js';
import { waysDeadlineMs, waysLine, waysOf, waysRows, waysThereTool, WAYS_THERE, type WayThere } from '../ways-there.js';

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

const at = (day: number, hhmm: string) => `2026-11-${String(day).padStart(2, '0')}T${hhmm}:00+05:30`;
function train(name: string, number: string, cls: string, rupees: number, depart: string, arrive: string, availability = 'Available 12'): RecipeOption {
  return {
    kind: 'train', title: `${name} ${number}`, priceMinor: rupees * 100, currency: 'INR', priceNote: `per person, ${cls}`,
    journey: { mode: 'train', origin: { name: 'New Delhi', code: 'NDLS' }, destination: { name: 'Madgaon', code: 'MAO' }, depart_at: depart, arrive_at: arrive, carrier_name: 'Indian Railways', number },
    highlights: [cls, availability], facts: { class_code: cls, availability }, sourceUrl: `https://www.ixigo.com/trains/${number}?orgn=NDLS&dstn=MAO&departDate=2026-11-06&quota=GN`,
  };
}
function bus(operator: string, rupees: number, depart: string, arrive: string, seats?: number): RecipeOption {
  return {
    kind: 'bus', title: operator, priceMinor: rupees * 100, currency: 'INR', priceNote: 'per seat, from',
    journey: { mode: 'bus', origin: { name: 'Mumbai' }, destination: { name: 'Goa' }, depart_at: depart, arrive_at: arrive, carrier_name: operator },
    // As the recipe writes it: the bus type, then its time.
    highlights: ['A/C Sleeper', hoursMinutes((Date.parse(arrive) - Date.parse(depart)) / 60_000)],
    facts: { bus_type: 'A/C Sleeper', ...(seats !== undefined ? { seats_left: seats } : {}) }, sourceUrl: 'https://www.ixigo.com/buses/bus_search/Mumbai/4/Goa/102/06-11-2026/O',
  };
}
const options = (list: RecipeOption[]): EngineAnswer => ({ as: 'options', options: list, page: 'https://www.ixigo.com/x', checkedAt: '2026-10-08T12:00:00.000Z', ms: 900 });
const flights = (from: string): StepAnswer => ({
  recipe: 'flights.search', answer: { as: 'link', link: `https://www.ixigo.com/search/result/flight?from=${from}&to=GOI&date=06112026&adults=1`, title: 'Flights', who: null },
});

/**
 * The Goa trip's three home cities. Delhi: the Goa Express sleeper is cheapest, the Rajdhani fastest, a full class
 * cheaper still, and the buses didn't come back. Mumbai: the Konkan Kanya beats the bus on both. Bangalore: nothing.
 */
const COMPARE: EngineAnswer = {
  as: 'compare',
  inputs: { to: 'North Goa', date: '2026-11-06' },
  checkedAt: '2026-10-08T12:00:00.000Z',
  ms: 3_100,
  entries: [
    {
      entry: 'Delhi',
      steps: [
        {
          recipe: 'trains.between',
          answer: options([
            train('Goa Express', '12779', '3A', 1_700, at(6, '15:00'), at(7, '17:10')),
            train('Goa Express', '12779', 'SL', 645, at(6, '15:00'), at(7, '17:10')),
            train('Rajdhani', '22413', '3A', 2_140, at(6, '06:00'), at(6, '21:30')),
            train('Rajdhani', '22413', '2A', 500, at(6, '06:00'), at(6, '21:30'), 'REGRET'),
          ]),
        },
        { recipe: 'buses.between', why: 'unreachable: ixigo took too long to answer.' },
        flights('DEL'),
      ],
    },
    { entry: 'Bangalore', steps: [{ recipe: 'trains.between', answer: options([]) }, { recipe: 'buses.between', answer: options([]) }, flights('BLR')] },
    {
      entry: 'Mumbai',
      steps: [
        { recipe: 'trains.between', answer: options([train('Konkan Kanya', '10111', 'SL', 420, at(6, '23:05'), at(7, '10:45'))]) },
        { recipe: 'buses.between', answer: options([bus('Zingbus', 900, at(6, '20:00'), at(7, '08:00')), bus('Paulo Travels', 300, at(6, '19:00'), at(7, '07:00'), 0)]) },
        flights('BOM'),
      ],
    },
  ],
};

const toolWith = (answer: (o: RunFor) => Promise<EngineAnswer>, o: { live?: boolean; waitMs?: number; cardDelayMs?: number } = {}) =>
  waysThereTool({
    engine: { answer: async (id, _given, run) => (id === WAYS_THERE ? answer(run) : Promise.reject(new Error(id))) },
    results, link: lb.link, now: lb.brain.now, slots: () => 2, live: () => o.live ?? true,
    ...(o.waitMs !== undefined ? { waitMs: o.waitMs } : {}),
    cardDelayMs: o.cardDelayMs ?? 60_000,
  });

describe("each home city's ways to the trip", () => {
  it("picks each city's cheapest and fastest seat people can still buy, and says what didn't come back", () => {
    if (COMPARE.as !== 'compare') return;
    const ways = waysOf(COMPARE, lb.ctx().pack.trip.people);
    expect(ways.map((w) => [w.home, w.people, w.cheapest?.title, w.cheapest?.facts.class_code, w.fastest?.title, w.only, w.missed, !!w.flights])).toEqual([
      // The Rajdhani's 2A is cheaper, but ixigo says it is full.
      ['Delhi', 3, 'Goa Express 12779', 'SL', 'Rajdhani 22413', false, ['buses'], true],
      ['Bangalore', 1, undefined, undefined, undefined, false, [], true],
      // The Paulo Travels bus is cheaper and faster, but has no seat left.
      ['Mumbai', 1, 'Konkan Kanya 10111', 'SL', 'Konkan Kanya 10111', false, [], true],
    ]);
    // What didn't come back is said once, after the cities.
    expect(waysLine(ways, '2026-11-06')).toBe(
      'From Delhi, the cheapest is the Goa Express 12779 in Sleeper at ₹645 (26 h 10 m), the quickest by land the Rajdhani 22413 in AC 3 Tier at ₹2,140 (15 h 30 m). ' +
        'From Bangalore, ixigo has no trains or buses on Fri 6 Nov. ' +
        'From Mumbai, the Konkan Kanya 10111 in Sleeper is the cheapest and the quickest by land, at ₹420 (11 h 40 m). ' +
        "Buses didn't come back for Delhi. Flights from your own city are a tap away on the card.",
    );
  });

  // p0's golden run, 10 Oct: Delhi's "cheapest" got in at 2 am on 8 Nov, two days into a 6 to 9 Nov trip, and was WL 73.
  it('drops a way that gets in two days into the trip, and a waitlist ixigo gives under an even chance', () => {
    const late: EngineAnswer = {
      as: 'compare', inputs: { to: 'North Goa', date: '2026-11-06' }, checkedAt: '2026-10-08T12:00:00.000Z', ms: 3_000,
      entries: [
        {
          entry: 'Delhi',
          steps: [
            {
              recipe: 'trains.between',
              answer: options([
                train('Goa Sampark Kranti', '12449', 'SL', 600, at(6, '05:00'), at(8, '02:00')),
                { ...train('Goa Express', '12779', 'SL', 645, at(6, '15:00'), at(7, '17:10'), 'WL 73'), facts: { class_code: 'SL', availability: 'WL 73', chance: 12 } },
                { ...train('Goa Express', '12779', '3A', 1_700, at(6, '15:00'), at(7, '17:10'), 'WL 4'), facts: { class_code: '3A', availability: 'WL 4', chance: 91 } },
              ]),
            },
            { recipe: 'buses.between', answer: options([]) },
            flights('DEL'),
          ],
        },
        { entry: 'Mumbai', steps: [{ recipe: 'trains.between', answer: options([]) }, { recipe: 'buses.between', answer: options([bus('NTC Smart Bus', 5_300, at(6, '16:00'), at(8, '08:30'))]) }, flights('BOM')] },
      ],
    };
    if (late.as !== 'compare') return;
    const ways = waysOf(late, lb.ctx().pack.trip.people);
    expect(ways.map((w) => [w.home, w.cheapest?.title, w.cheapest?.facts.class_code, w.late])).toEqual([
      ['Delhi', 'Goa Express 12779', '3A', false],
      ['Mumbai', undefined, undefined, true],
    ]);
    expect(waysLine(ways, '2026-11-06')).toBe(
      'From Delhi, the one train is the Goa Express 12779 in AC 3 Tier, at ₹1,700 (26 h 10 m). ' +
        'From Mumbai, all ixigo has on Fri 6 Nov gets in after Sat 7 Nov. Flights from your own city are a tap away on the card.',
    );
  });

  it("keeps five rows at most: past five, the fastest rows that save the least time go first, and the line still says them", () => {
    const way = (home: string, savesMin: number): WayThere => {
      const slow = toResultOption(train('Slow', '1', 'SL', 500, at(6, '06:00'), at(7, '06:00')));
      const quick = toResultOption(train('Quick', '2', '3A', 1_500, at(6, '06:00'), new Date(Date.parse(at(7, '06:00')) - savesMin * 60_000).toISOString()));
      return { home, people: 1, cheapest: slow, fastest: quick, only: false, flights: null, flown: false, missed: [], late: false };
    };
    const rows = waysRows([way('Delhi', 600), way('Mumbai', 60), way('Pune', 300), way('Jaipur', 30)]);
    expect(rows.map((r) => `${r.way.home} ${r.is}`)).toEqual(['Delhi cheapest', 'Delhi fastest', 'Mumbai cheapest', 'Pune cheapest', 'Jaipur cheapest']);
  });

  it("compares a city's flights with its trains and buses: a 2 h flight is its fastest, never a 15 h train; a city whose flights didn't come says quickest by land", () => {
    const flight = (number: string, rupees: number, depart: string, arrive: string): RecipeOption => ({
      kind: 'flight', title: `Air-India Express ${number}`, priceMinor: rupees * 100, currency: 'INR', priceNote: 'per person',
      journey: { mode: 'flight', origin: { name: 'New Delhi', code: 'DEL' }, destination: { name: 'Goa', code: 'GOI' }, depart_at: depart, arrive_at: arrive, carrier_name: 'Air-India Express', carrier_code: 'IX', number, stops: 0 },
      highlights: ['Non-stop', hoursMinutes((Date.parse(arrive) - Date.parse(depart)) / 60_000)], facts: { stops: 0 },
      sourceUrl: 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026&adults=3',
    });
    if (COMPARE.as !== 'compare') return;
    const [delhi, , mumbai] = COMPARE.entries;
    const flown: EngineAnswer = {
      ...COMPARE,
      entries: [
        { entry: 'Delhi', steps: [...delhi!.steps.slice(0, 2), { recipe: 'flights.results', answer: options([flight('IX1196', 8_630, at(6, '18:35'), at(6, '21:15')), flight('IX1108', 8_934, at(6, '20:35'), at(6, '23:15'))]) }, flights('DEL')] },
        // Mumbai's flights page was held back (one flights page in 20 s): its link stands.
        { entry: 'Mumbai', steps: [...mumbai!.steps.slice(0, 2), { recipe: 'flights.results', why: 'unreachable: ixigo is given a moment between flights pages.' }, flights('BOM')] },
      ],
    };
    if (flown.as !== 'compare') return;
    const ways = waysOf(flown, lb.ctx().pack.trip.people);
    expect(ways.map((w) => [w.home, w.cheapest?.title, w.fastest?.title, w.flown, w.missed])).toEqual([
      ['Delhi', 'Goa Express 12779', 'Air-India Express IX1196', true, ['buses']],
      ['Mumbai', 'Konkan Kanya 10111', 'Konkan Kanya 10111', false, []],
    ]);
    expect(waysLine(ways, '2026-11-06')).toBe(
      'From Delhi, the cheapest is the Goa Express 12779 in Sleeper at ₹645 (26 h 10 m), the fastest the Air-India Express IX1196 flight at ₹8,630 (2 h 40 m). ' +
        'From Mumbai, the Konkan Kanya 10111 in Sleeper is the cheapest and the quickest by land, at ₹420 (11 h 40 m). ' +
        "Buses didn't come back for Delhi. Flights from your own city are a tap away on the card.",
    );
  });

  it('puts them on one card, each row with its own ixigo page, posts the line with it, and ends the turn there', async () => {
    const ctx = lb.ctx({ turnId: 'turn_ways1' });
    const got = (await toolWith(async () => COMPARE).run({}, ctx)) as { answered: boolean; results_id: string };
    expect(got.answered).toBe(true);
    expect(ctx.answered).toBe(true);
    expect(ctx.lines).toEqual([expect.stringMatching(/^From Delhi, the cheapest is the Goa Express 12779 in Sleeper/)]);
    const card = C.Card.parse(ctx.cards[0]);
    if (card.kind !== 'options') throw new Error('expected an options card');
    expect(card.title).toBe('Ways to North Goa from Delhi and Mumbai, Fri 6 Nov');
    expect(card.options.map((o) => [o.title, o.highlights[0], o.price_minor])).toEqual([
      ['From Delhi: Goa Express 12779', 'Cheapest, 26 h 10 m', 64_500],
      ['From Delhi: Rajdhani 22413', 'Quickest by land, 15 h 30 m', 214_000],
      ['From Mumbai: Konkan Kanya 10111', 'Cheapest and quickest by land, 11 h 40 m', 42_000],
    ]);
    expect(card.actions?.map((a) => a.action_id)).toEqual(['open', 'flights_home']);
    // "See on ixigo" on a row opens that train's own page.
    const open = await lb.taps.tap('options', 'open', { tap_id: 'tap_w1', trip_id: 't_goa', card_id: card.card_id, action_id: 'open', person_id: 'p_rahul', option_id: card.options[1]!.option_id }, card);
    expect(open).toMatchObject({ result: 'open', url: expect.stringContaining('/trains/22413?') });
    // "Flights from my city": Meher lives in Mumbai, Arjun in Bangalore, which has flights though no train or bus row.
    const flightsFor = async (person: string) =>
      lb.taps.tap('options', 'flights_home', { tap_id: `tap_f_${person}`, trip_id: 't_goa', card_id: card.card_id, action_id: 'flights_home', person_id: person }, card);
    expect(await flightsFor('p_meher')).toMatchObject({ result: 'open', url: expect.stringContaining('from=BOM&') });
    expect(await flightsFor('p_arjun')).toMatchObject({ result: 'open', url: expect.stringContaining('from=BLR&') });
    // Someone with no home city on the trip gets the first city's.
    expect(await flightsFor('p_new')).toMatchObject({ result: 'open', url: expect.stringContaining('from=DEL&') });
  });

  it("says why it can't, without a card: not searching ixigo.com, no day or home city yet, or nothing came back", async () => {
    const ctx = lb.ctx({ turnId: 'turn_ways2' });
    expect(await toolWith(async () => COMPARE, { live: false }).run({}, ctx)).toMatchObject({ error: 'not_here' });
    const needs = await toolWith(async () => {
      throw new TravelError('needs_more', 'How everyone gets to the trip needs the day everyone travels.');
    }).run({}, ctx);
    expect(needs).toMatchObject({ error: 'needs_more', note: expect.stringContaining('Ask the group for it in one line.') });
    const empty: EngineAnswer = {
      as: 'compare', inputs: { to: 'North Goa', date: '2026-11-06' }, checkedAt: '2026-10-08T12:00:00.000Z', ms: 12_000,
      entries: [{ entry: 'Delhi', steps: [{ recipe: 'trains.between', why: 'out of time' }, { recipe: 'buses.between', why: 'out of time' }, flights('DEL')] }],
    };
    expect([ctx.cards, ctx.lines, ctx.answered]).toEqual([[], [], undefined]);
    // Nothing came back: the line says so, and the turn ends on it.
    const none = lb.ctx({ turnId: 'turn_ways2b' });
    expect(await toolWith(async () => empty).run({}, none)).toMatchObject({ answered: true, card_id: null });
    expect([none.cards, none.lines]).toEqual([[], ['No train or bus came back from Delhi on Fri 6 Nov. Flights are on ixigo.']]);
  });

  it("says one bus as the one bus, never \"bus bus\", what didn't come back once, and each row's time once (the 8 Oct drill)", async () => {
    const drill: EngineAnswer = {
      as: 'compare', inputs: { to: 'Goa', date: '2026-11-06' }, checkedAt: '2026-10-08T12:00:00.000Z', ms: 12_000,
      entries: [
        { entry: 'Delhi', steps: [{ recipe: 'trains.between', why: 'out of time' }, { recipe: 'buses.between', answer: options([bus('NTC Smart Bus', 5_300, at(6, '16:00'), at(7, '20:30'))]) }, flights('DEL')] },
        {
          entry: 'Mumbai',
          steps: [
            { recipe: 'trains.between', why: 'out of time' },
            { recipe: 'buses.between', answer: options([bus('Naik Tours & Travels', 1_500, at(6, '17:30'), at(7, '08:00')), bus('IntrCity SmartBus', 3_182, at(6, '22:15'), at(7, '08:10'))]) },
            flights('BOM'),
          ],
        },
      ],
    };
    const ctx = lb.ctx({ turnId: 'turn_ways4' });
    await toolWith(async () => drill).run({}, ctx);
    expect(ctx.lines).toEqual([
      'From Delhi, the one bus is the NTC Smart Bus, at ₹5,300 (28 h 30 m). ' +
        'From Mumbai, the cheapest is the Naik Tours & Travels bus at ₹1,500 (14 h 30 m), the quickest by land the IntrCity SmartBus at ₹3,182 (9 h 55 m). ' +
        "Trains didn't come back for any city. Flights from your own city are a tap away on the card.",
    ]);
    const card = C.Card.parse(ctx.cards[0]);
    if (card.kind !== 'options') throw new Error('expected an options card');
    expect(card.options.map((o) => o.highlights)).toEqual([
      ['The only bus, 28 h 30 m', 'A/C Sleeper'],
      ['Cheapest, 14 h 30 m', 'A/C Sleeper'],
      ['Quickest by land, 9 h 55 m', 'A/C Sleeper'],
    ]);
  });

  it('gives a comparison the time its pages need on the computer: 25 s for three cities on two slots, 17 s on four', () => {
    expect([waysDeadlineMs(3, 2), waysDeadlineMs(3, 4), waysDeadlineMs(1, 2), waysDeadlineMs(4, 2)]).toEqual([25_000, 17_000, 13_000, 29_000]);
  });

  // The exam, 10 Oct (#23, #25): one flights page a 20 s gap across every trip, so a city's flights were held back and the
  // card said "quickest by land". Its flights are read after, as the pacer lets them through, and the card goes up again.
  it("reads a city's flights the pacer held back after the card is up, and puts the card up again in place with them", async () => {
    const ctx = lb.ctx({ turnId: 'turn_ways_fill' });
    const from = lb.link.requests.length;
    const held: EngineAnswer = {
      as: 'compare', inputs: { to: 'North Goa', date: '2026-11-06' }, checkedAt: '2026-10-08T12:00:00.000Z', ms: 3_100,
      entries: [{
        entry: 'Mumbai',
        steps: [
          { recipe: 'trains.between', answer: options([train('Konkan Kanya', '10111', 'SL', 420, at(6, '23:05'), at(7, '10:45'))]) },
          { recipe: 'buses.between', answer: options([]) },
          { recipe: 'flights.results', why: 'ixigo is given a moment between flights pages.' },
          flights('BOM'),
        ],
      }],
    };
    const flight: RecipeOption = {
      kind: 'flight', title: 'IndiGo 6E5310', priceMinor: 390_000, currency: 'INR', priceNote: 'per person',
      journey: { mode: 'flight', origin: { name: 'Mumbai', code: 'BOM' }, destination: { name: 'Goa', code: 'GOX' }, depart_at: at(6, '09:10'), arrive_at: at(6, '10:20'), carrier_name: 'IndiGo', carrier_code: '6E', number: '6E5310' },
      highlights: ['Non-stop'], facts: { stops: 0 }, sourceUrl: 'https://www.ixigo.com/search/result/flight?from=BOM&to=GOX&date=06112026',
    };
    const asked: string[] = [];
    const slept: number[] = [];
    let tries = 0;
    const tool = waysThereTool({
      engine: {
        answer: async (id, given) => {
          asked.push(`${id} ${JSON.stringify(given)}`);
          if (id === WAYS_THERE) return held;
          // Held back once more by the pacer, then through.
          if (tries++ === 0) throw new PacedOutError('flights.results', 12_000);
          return options([flight]);
        },
      },
      results, link: lb.link, now: lb.brain.now, slots: () => 2, live: () => true, cardDelayMs: 60_000,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    const out = (await tool.run({}, ctx)) as { card_id: string };
    // The card goes up at once, Mumbai the quickest by land; its flights come after.
    expect(C.OptionsCard.parse(ctx.cards[0]).options.map((o) => o.title)).toEqual(['From Mumbai: Konkan Kanya 10111']);
    await eventually(() => lb.link.requests.slice(from).some((r) => r.method === 'replace_card'));
    const again = C.OptionsCard.parse(lb.link.requests.slice(from).find((r) => r.method === 'replace_card')!.params['card']);
    expect(again.card_id).toBe(out.card_id);
    // Now its cheapest (the train) and its fastest (the flight), each its own row.
    expect(again.options.map((o) => o.title)).toEqual(['From Mumbai: Konkan Kanya 10111', 'From Mumbai: IndiGo 6E5310']);
    expect(asked.filter((a) => a.startsWith('flights.results'))).toEqual([
      'flights.results {"from":"Mumbai","to":"North Goa","date":"2026-11-06"}', 'flights.results {"from":"Mumbai","to":"North Goa","date":"2026-11-06"}',
    ]);
    // It waited for the card's turn to post, then the pacer's own gap.
    expect(slept).toEqual([3_000, 12_500]);
  });

  it("shows an On it. live card for a comparison past the turn's wait, ticks each city, then posts its card and line itself", async () => {
    const ctx = lb.ctx({ turnId: 'turn_ways3' });
    let finish: (a: EngineAnswer) => void = () => undefined;
    let tell: RunFor['onSteps'];
    const tool = toolWith(
      (run) => {
        tell = run.onSteps;
        run.onSteps?.({ type: 'entries', entries: ['Delhi', 'Bangalore', 'Mumbai'] });
        return new Promise((r) => (finish = r));
      },
      { waitMs: 30, cardDelayMs: 0 },
    );
    const from = lb.link.requests.length;
    const sent = () => lb.link.requests.slice(from);
    const working = () =>
      sent().flatMap((r) => {
        const card = r.params['card'] as { kind?: string; title?: string; state?: string; steps?: Array<{ text: string; state: string }> } | undefined;
        return card?.kind === 'working' ? [{ method: r.method, text: r.params['text'], ...card }] : [];
      });
    // The turn ends with nothing said: the live card is the room's word for now.
    expect(await tool.run({}, ctx)).toMatchObject({ running: true });
    expect([ctx.cards, ctx.lines, ctx.answered]).toEqual([[], [], undefined]);
    await eventually(() => working().length > 0);
    expect(working()[0]).toMatchObject({
      method: 'post_message', text: 'On it.', title: 'Checking 3 cities', state: 'running',
      steps: [{ text: 'Delhi: trains · buses', state: 'doing' }, { text: 'Bangalore: trains · buses', state: 'doing' }, { text: 'Mumbai: trains · buses', state: 'doing' }],
    });
    tell?.({ type: 'step', entry: 'Delhi', recipe: 'buses.between', ok: false });
    tell?.({ type: 'step', entry: 'Delhi', recipe: 'trains.between', ok: true });
    tell?.({ type: 'step', entry: 'Bangalore', recipe: 'trains.between', ok: false });
    tell?.({ type: 'step', entry: 'Bangalore', recipe: 'buses.between', ok: false });
    tell?.({ type: 'step', entry: 'Bangalore', recipe: 'flights.search', ok: true });
    await eventually(() => working().at(-1)?.steps?.map((s) => s.state).join() === 'done,failed,doing');
    finish(COMPARE);
    await eventually(() => sent().some((r) => (r.params['card'] as { kind?: string } | undefined)?.kind === 'options'));
    const posted = sent().findIndex((r) => (r.params['card'] as { kind?: string } | undefined)?.kind === 'options');
    expect(sent()[posted]!.method).toBe('post_message');
    expect(sent()[posted]!.params['text']).toMatch(/^From Delhi, the cheapest is the Goa Express 12779 in Sleeper/);
    // The live card ended before the comparison went up: Mumbai, still going when it came in, done with it.
    const last = sent().slice(0, posted).filter((r) => (r.params['card'] as { kind?: string } | undefined)?.kind === 'working').at(-1)!;
    expect(last.params['card']).toMatchObject({ state: 'done', steps: [{ state: 'done' }, { state: 'failed' }, { state: 'done' }] });
  });
});
