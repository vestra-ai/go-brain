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
      kind: 'stay', title: 'Villa Sol', priceMinor: 1280000, totalMinor: 3840000, currency: 'INR', priceNote: 'per night', checkedAt: CHECKED,
    });
    expect((await store.offersOnCard('c_opt_t')).map((o) => o.n)).toEqual([1, 2]);
    expect(await store.offer('opt_missing')).toBeNull();
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
