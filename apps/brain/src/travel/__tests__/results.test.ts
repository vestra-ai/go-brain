import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import { buildOptionsCard } from '../cards.js';
import { createResultsStore, type ResultOption } from '../results.js';

let db: Awaited<ReturnType<typeof withSchema>>;
beforeAll(async () => {
  db = await withSchema();
});
afterAll(async () => {
  await db.drop();
});

const villa = (title: string, night: number): ResultOption => ({
  offerId: `fake:st-${title.toLowerCase().replace(/ /g, '-')}-20261106-20261109-5`, kind: 'stay', title, priceMinor: night, totalMinor: night * 3,
  currency: 'INR', priceNote: 'per night', highlights: ['Private pool'], facts: { nights: 3, area: 'Anjuna' },
});
const CHECKED = '2026-10-07T12:00:00.000Z';

describe('result sets', () => {
  it('saves a set and reads it back only for its own trip', async () => {
    const store = createResultsStore(db.pool);
    const set = await store.save({ tripId: 't_goa', optionKind: 'stay', source: 'search', query: { area: 'North Goa' }, options: [villa('Villa Sol', 1280000)], checkedAt: CHECKED });
    expect(set.resultsId).toMatch(/^r_/);
    expect(await store.get('t_goa', set.resultsId)).toEqual(set);
    expect(await store.get('t_other', set.resultsId)).toBeNull();
    // A search's results page on ixigo.com, kept with its list for "See all on ixigo".
    const page = 'https://www.ixigo.com/hotels/search/result?locationId=32&locationName=Goa';
    const withPage = await store.save({ tripId: 't_goa', optionKind: 'stay', source: 'search', query: {}, options: [villa('Villa Sol', 1280000)], checkedAt: CHECKED, page });
    expect(await store.get('t_goa', withPage.resultsId)).toMatchObject({ page });
  });

  it('keeps the options on a card as offers that a tap, a vote or a payment can name', async () => {
    const store = createResultsStore(db.pool);
    const options = [villa('Villa Sol', 1280000), villa('The Palms Villa', 1220000)];
    const set = await store.save({ tripId: 't_goa', optionKind: 'stay', source: 'search', query: {}, options, checkedAt: CHECKED });
    const picks = options.map((option, i) => ({ optionId: `opt_t${i + 1}`, n: i + 1, option, imageUrl: null }));
    const card = buildOptionsCard({ cardId: 'c_opt_t', title: 'Villas in North Goa', optionKind: 'stay', checkedAt: CHECKED, picks });
    await store.saveCard({ cardId: 'c_opt_t', tripId: 't_goa', resultsId: set.resultsId, title: card.title, optionKind: 'stay', card }, picks, CHECKED);
    await store.saveCard({ cardId: 'c_opt_t', tripId: 't_goa', resultsId: set.resultsId, title: card.title, optionKind: 'stay', card }, picks, CHECKED);
    expect(await store.card('t_goa', 'c_opt_t')).toMatchObject({ cardId: 'c_opt_t', decisionId: null, voteKey: null, optionKind: 'stay' });
    expect(await store.card('t_other', 'c_opt_t')).toBeNull();
    expect(await store.offer('opt_t1')).toEqual({
      optionId: 'opt_t1', tripId: 't_goa', cardId: 'c_opt_t', resultsId: set.resultsId, n: 1, offerId: 'fake:st-villa-sol-20261106-20261109-5',
      kind: 'stay', title: 'Villa Sol', priceMinor: 1280000, totalMinor: 3840000, currency: 'INR', priceNote: 'per night', checkedAt: CHECKED, sourceUrl: null,
    });
    expect((await store.offersOnCard('c_opt_t')).map((o) => o.n)).toEqual([1, 2]);
    expect(await store.offer('opt_missing')).toBeNull();
  });

  it('says which trip searched an offer, and for which check-in or departure day, from the newest search that showed it', async () => {
    const store = createResultsStore(db.pool);
    const stay = villa('Casa Dated', 1500000);
    await store.save({ tripId: 't_dated', optionKind: 'stay', source: 'search', query: { area: 'North Goa', checkIn: '2026-11-06', checkOut: '2026-11-09' }, options: [stay], checkedAt: CHECKED });
    // The trip's computer's search keeps its query with how it came; a job's picks are saved with no dates at all.
    const flight = { ...villa('Flight Dated', 592000), offerId: 'fake:fl-6E2134-20261106', kind: 'flight' as const };
    await store.save({ tripId: 't_dated', optionKind: 'flight', source: 'search', query: { via: 'trip_computer', kind: 'flights', from: 'Delhi', to: 'Goa', date: '2026-11-06' }, options: [flight], checkedAt: CHECKED });
    await store.save({ tripId: 't_dated', optionKind: 'stay', source: 'task', query: { task_id: 'gt_dated' }, options: [stay], checkedAt: '2026-10-07T13:00:00.000Z' });
    expect(await store.searchedFor(stay.offerId!)).toEqual({ tripId: 't_dated', day: '2026-11-06' });
    expect(await store.searchedFor('fake:fl-6E2134-20261106')).toEqual({ tripId: 't_dated', day: '2026-11-06' });
    expect(await store.searchedFor('fake:never-shown')).toBeNull();
  });

  it("finds an offer Go's search showed this trip, from the newest check, and never another trip's or a job's", async () => {
    const store = createResultsStore(db.pool);
    const older = villa('Villa Sol', 1280000);
    const newer = villa('Villa Sol', 1300000);
    await store.save({ tripId: 't_find', optionKind: 'stay', source: 'search', query: {}, options: [older], checkedAt: '2026-10-07T11:00:00.000Z' });
    await store.save({ tripId: 't_find', optionKind: 'stay', source: 'search', query: {}, options: [newer, villa('The Palms Villa', 1220000)], checkedAt: CHECKED });
    await store.save({ tripId: 't_find', optionKind: 'stay', source: 'task', query: {}, options: [villa('Casa Azul', 1460000)], checkedAt: CHECKED });
    expect(await store.findOffer('t_find', older.offerId!)).toEqual({ option: newer, checkedAt: CHECKED });
    expect(await store.findOffer('t_other', older.offerId!)).toBeNull();
    // A job's own answer is never a source of prices: only Go's searches are.
    expect(await store.findOffer('t_find', villa('Casa Azul', 1460000).offerId!)).toBeNull();
    expect(await store.findOffer('t_find', 'fake:st-nowhere')).toBeNull();
  });

  it('keeps the currency of an offer that has only a whole price (a web pick with a total)', async () => {
    const store = createResultsStore(db.pool);
    const web: ResultOption = { kind: 'stay', title: 'Casa Lua', totalMinor: 4500000, currency: 'INR', highlights: ['Found on the web'], facts: { found_on_web: true } };
    const set = await store.save({ tripId: 't_goa', optionKind: 'stay', source: 'task', query: {}, options: [web], checkedAt: CHECKED });
    const picks = [{ optionId: 'opt_w1', n: 1, option: web, imageUrl: null }];
    const card = buildOptionsCard({ cardId: 'c_opt_w', title: 'Casa Lua', optionKind: 'stay', checkedAt: CHECKED, picks });
    await store.saveCard({ cardId: 'c_opt_w', tripId: 't_goa', resultsId: set.resultsId, title: 'Casa Lua', optionKind: 'stay', card }, picks, CHECKED);
    expect(await store.offer('opt_w1')).toMatchObject({ offerId: null, priceMinor: null, totalMinor: 4500000, currency: 'INR' });
  });

  it("keeps an ixigo.com option's own page with its offer, and no offer id: it is booked on ixigo", async () => {
    const store = createResultsStore(db.pool);
    const page = 'https://www.ixigo.com/hotels/1384544/details?locationId=1366415&hName=Meritas';
    const hotel: ResultOption = { kind: 'stay', title: 'Meritas', priceMinor: 810400, totalMinor: 4862400, currency: 'INR', priceNote: 'per night, per room', highlights: [], facts: { area: 'Candolim' }, sourceUrl: page };
    const set = await store.save({ tripId: 't_goa', optionKind: 'stay', source: 'search', query: {}, options: [hotel], checkedAt: CHECKED });
    const picks = [{ optionId: 'opt_ix1', n: 1, option: hotel, imageUrl: null }];
    const card = buildOptionsCard({ cardId: 'c_opt_ix', title: 'Meritas', optionKind: 'stay', checkedAt: CHECKED, picks });
    await store.saveCard({ cardId: 'c_opt_ix', tripId: 't_goa', resultsId: set.resultsId, title: 'Meritas', optionKind: 'stay', card }, picks, CHECKED);
    expect(await store.offer('opt_ix1')).toMatchObject({ offerId: null, priceMinor: 810400, totalMinor: 4862400, sourceUrl: page });
    expect((await store.offersOnCard('c_opt_ix'))[0]!.sourceUrl).toBe(page);
  });

  it('lets one vote claim a card at a time, and the same claim again (a rerun of the same turn)', async () => {
    const store = createResultsStore(db.pool);
    const set = await store.save({ tripId: 't_goa', optionKind: 'stay', source: 'search', query: {}, options: [villa('Casa Azul', 1460000)], checkedAt: CHECKED });
    const picks = [{ optionId: 'opt_v1', n: 1, option: villa('Casa Azul', 1460000), imageUrl: null }];
    const card = buildOptionsCard({ cardId: 'c_opt_v', title: 'Casa Azul', optionKind: 'stay', checkedAt: CHECKED, picks });
    await store.saveCard({ cardId: 'c_opt_v', tripId: 't_goa', resultsId: set.resultsId, title: 'Casa Azul', optionKind: 'stay', card }, picks, CHECKED);
    expect(await store.claimVote('c_opt_v', 'tap_1')).toBe(true);
    expect(await store.claimVote('c_opt_v', 'tap_1')).toBe(true);
    expect(await store.claimVote('c_opt_v', 'tap_2')).toBe(false);
    await store.releaseVote('c_opt_v', 'tap_1');
    expect(await store.claimVote('c_opt_v', 'tap_2')).toBe(true);
    await store.setDecision('c_opt_v', 'd_villa');
    expect(await store.card('t_goa', 'c_opt_v')).toMatchObject({ decisionId: 'd_villa', voteKey: 'tap_2' });
  });
});

// The lead, 10 Oct: "the group's stay" is the booked one, else the vote's winner, else the top pick on the latest stays
// card, with the position ixigo's search gave it.
describe("a stay's position", () => {
  it("gives a card's option with its position, and the top pick on the trip's latest card of a kind", async () => {
    const store = createResultsStore(db.pool);
    const placed = (title: string, lat: number, lng: number): ResultOption => ({ ...villa(title, 900_000), place: { name: title, address: null, lat, lng } });
    const save = async (cardId: string, options: ResultOption[]) => {
      const set = await store.save({ tripId: 't_where', optionKind: 'stay', source: 'search', query: {}, options, checkedAt: CHECKED });
      const picks = options.map((option, i) => ({ optionId: `${cardId}_${i + 1}`, n: i + 1, option, imageUrl: null }));
      const card = buildOptionsCard({ cardId, title: 'Stays in North Goa', optionKind: 'stay', checkedAt: CHECKED, picks });
      await store.saveCard({ cardId, tripId: 't_where', resultsId: set.resultsId, title: card.title, optionKind: 'stay', card }, picks, CHECKED);
    };
    expect(await store.topPick('t_where', 'stay')).toBeNull();
    await save('c_where_1', [placed('Villa Sol', 15.5733, 73.74), placed('The Palms Villa', 15.55, 73.75)]);
    await save('c_where_2', [placed('Casa Anjuna', 15.58, 73.741), villa('Casa Sem Lugar', 800_000)]);
    expect(await store.topPick('t_where', 'stay')).toMatchObject({ title: 'Casa Anjuna', place: { name: 'Casa Anjuna', lat: 15.58, lng: 73.741 } });
    expect(await store.topPick('t_where', 'flight')).toBeNull();
    expect(await store.placeOf('c_where_1_2')).toMatchObject({ kind: 'stay', title: 'The Palms Villa', place: { lat: 15.55, lng: 73.75 }, area: 'Anjuna' });
    // No position from the search: none is made up.
    expect((await store.placeOf('c_where_2_2'))?.place).toBeNull();
  });
});
