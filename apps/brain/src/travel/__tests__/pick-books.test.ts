import * as C from '@go/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { eventually, makeLaneBrain, type LaneBrain } from '../../tasks/testing/lane-brain.js';
import type { BookingAsk } from '../booking/flight-booking.js';
import { buildOptionsCard, type OptionsCardT } from '../cards.js';
import { stableId } from '../ids.js';
import { createResultsStore, type ResultOption, type ResultsStore } from '../results.js';
import { registerTravelTaps } from '../taps.js';

// The App team's G2 (11 Oct): picking a flight posted a second one-option card, and picking again opened ixigo. With Go
// booking it, the pick is the booking: the person's own card shows their flight alone, and Go books it.
let db: Awaited<ReturnType<typeof withSchema>>;
let lb: LaneBrain;
let results: ResultsStore;
const started: BookingAsk[] = [];
let booking = true;

beforeAll(async () => {
  db = await withSchema();
  lb = makeLaneBrain({ pool: db.pool });
  results = createResultsStore(db.pool);
  registerTravelTaps(lb.taps, {
    results, pool: db.pool, link: lb.brain.door.link, desk: lb.brain.desk, now: lb.brain.now, log: lb.brain.log,
    booking: { onFor: async () => booking, start: async (ask) => { started.push(ask); }, pay: async () => ({ result: 'refused' as const, toast: 'not here' }) },
    nameOf: async () => 'Rahul',
  });
});
afterAll(async () => {
  await db.drop();
});

const checkedAt = '2026-10-10T07:00:00.000Z';
const page = 'https://www.ixigo.com/search/result/flight?from=DEL&to=GOI&date=06112026&returnDate=&adults=1&children=0&infants=0&class=e&source=Search%20Form';
const flight = (title: string): ResultOption => ({ kind: 'flight', title, priceMinor: 600_000, currency: 'INR', priceNote: 'per person', highlights: [], facts: {}, sourceUrl: page });

/** A flights card in the room, Rahul's own (as each person's flights are) or the room's, posted and kept. */
async function postedCard(cardId: string, forPersonIds?: string[]): Promise<OptionsCardT> {
  const options = [flight('IndiGo 6E2150'), flight('Air India AI101')];
  const set = await results.save({ tripId: 't_goa', optionKind: 'flight', source: 'search', query: {}, options, checkedAt });
  const picks = options.map((option, i) => ({ optionId: `${cardId}_${i + 1}`, n: i + 1, option, imageUrl: null }));
  const card = buildOptionsCard({ cardId, title: 'Flights, Delhi to Goa', optionKind: 'flight', checkedAt, picks, ...(forPersonIds ? { forPersonIds } : {}) });
  await results.saveCard({ cardId, tripId: 't_goa', resultsId: set.resultsId, title: card.title, optionKind: 'flight', card }, picks, checkedAt);
  await lb.link.request('post_message', { request_id: `go_${cardId}`, trip_id: 't_goa', card, ...(forPersonIds ? { visible_to_person_ids: forPersonIds } : {}) });
  return card;
}
const pick = (card: OptionsCardT, tapId: string, optionId: string) =>
  lb.taps.tap('options', 'pick', { tap_id: tapId, trip_id: 't_goa', card_id: card.card_id, action_id: 'pick', person_id: 'p_rahul', option_id: optionId }, card);
const sentFor = (from: number, method: string) => lb.link.requests.slice(from).filter((r) => r.method === method);

describe("a person's pick, with Go booking it", () => {
  it('shows their flight alone on their own card, with no buttons, posts no second card, and starts the booking', async () => {
    booking = true;
    const card = await postedCard('c_rahul', ['p_rahul']);
    const from = lb.link.requests.length;
    expect(await pick(card, 'tap_g2_1', 'c_rahul_1')).toEqual({ result: 'done', toast: "Go is booking it on the trip's computer" });
    expect(started.at(-1)).toMatchObject({ tapId: 'tap_g2_1', tripId: 't_goa', personId: 'p_rahul', name: 'Rahul', choice: 'basic', offer: { optionId: 'c_rahul_1', cardId: 'c_rahul' } });
    await eventually(() => sentFor(from, 'replace_card').length === 1);
    const shown = C.OptionsCard.parse(sentFor(from, 'replace_card')[0]!.params['card']);
    expect(shown).toMatchObject({ card_id: 'c_rahul', for_person_ids: ['p_rahul'], options: [{ option_id: 'c_rahul_1', title: 'IndiGo 6E2150' }], actions: [] });
    expect((await results.card('t_goa', 'c_rahul'))?.card).toEqual(sentFor(from, 'replace_card')[0]!.params['card']);
    // No confirm card beside it.
    expect(sentFor(from, 'post_message').filter((r) => (r.params['card'] as { card_id?: string } | undefined)?.card_id === stableId('c_mine', 'tap_g2_1'))).toEqual([]);
  });

  it("leaves a card the room shares as it is, for the others to pick from, and books the picker's flight", async () => {
    booking = true;
    const card = await postedCard('c_room');
    const from = lb.link.requests.length;
    expect(await pick(card, 'tap_g2_2', 'c_room_2')).toEqual({ result: 'done', toast: "Go is booking it on the trip's computer" });
    expect(started.at(-1)).toMatchObject({ tapId: 'tap_g2_2', offer: { optionId: 'c_room_2', cardId: 'c_room' } });
    await new Promise((r) => setTimeout(r, 30));
    expect(sentFor(from, 'replace_card')).toEqual([]);
  });

  it("with Go not booking here, posts the person's own confirm as before and books nothing", async () => {
    booking = false;
    const card = await postedCard('c_rahul_off', ['p_rahul']);
    const before = started.length;
    const from = lb.link.requests.length;
    expect(await pick(card, 'tap_g2_3', 'c_rahul_off_1')).toEqual({ result: 'done', toast: "It's yours to confirm" });
    await eventually(() => sentFor(from, 'post_message').some((r) => (r.params['card'] as { card_id?: string } | undefined)?.card_id === stableId('c_mine', 'tap_g2_3')));
    expect(started).toHaveLength(before);
    expect(sentFor(from, 'replace_card')).toEqual([]);
  });
});
