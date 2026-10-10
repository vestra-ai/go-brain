import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as C from '@go/contract';
import { withSchema } from '../../db/test-db.js';
import { FakeLink } from '../../tasks/testing/lane-brain.js';
import type { EngineAnswer } from '../book/engine.js';
import { buildOptionsCard, type CardPick, type OptionsCardT } from '../cards.js';
import { showPickPhotos } from '../pick-photos.js';
import { createResultsStore, type ResultOption, type ResultsStore } from '../results.js';
import { openVoteFromCard } from '../votes.js';

// The Server team's 10 Oct B3: the stays card's top pick gets its own page's photos, labelled, in place of the search's,
// and a vote opened from the card afterwards carries them.
let db: Awaited<ReturnType<typeof withSchema>>;
let results: ResultsStore;
beforeAll(async () => {
  db = await withSchema();
  results = createResultsStore(db.pool);
});
afterAll(() => db.drop());

const images = { rehostUrl: async (u: string) => `https://go.test/img/${u.split('/').pop()}` };
const stay = (title: string): ResultOption => ({
  kind: 'stay', title, priceMinor: 900_000, totalMinor: 2_700_000, currency: 'INR', priceNote: 'per night', highlights: ['Pool'], facts: {},
  sourceUrl: `https://www.ixigo.com/hotels/1/details?hName=${encodeURIComponent(title)}`,
});

async function cardOnTrip(tripId: string, cardId: string): Promise<OptionsCardT> {
  const set = await results.save({ tripId, optionKind: 'stay', source: 'search', query: {}, options: [stay('Villa Sol'), stay('Casa Azul')], checkedAt: '2026-10-07T12:00:00.000Z' });
  const picks: Array<CardPick & { n: number }> = set.options.map((option, i) => ({
    n: i + 1, optionId: `opt_${cardId}_${i + 1}`, option, imageUrl: `https://go.test/img/cover${i + 1}.jpg`, photos: [{ url: `https://go.test/img/search${i + 1}.jpg` }],
  }));
  const card = buildOptionsCard({ cardId, title: 'Villas in Goa', optionKind: 'stay', checkedAt: set.checkedAt, picks });
  await results.saveCard({ cardId, tripId, resultsId: set.resultsId, title: card.title, optionKind: 'stay', card }, picks, set.checkedAt);
  return card;
}

const details = (photoList: unknown): EngineAnswer => ({
  as: 'facts', title: 'Villa Sol', rows: [{ name: 'Villa Sol', ...(photoList !== undefined ? { photo_list: photoList } : {}) }],
  page: 'https://www.ixigo.com/hotels/1/details', checkedAt: '2026-10-07T12:01:00.000Z', ms: 900,
});

describe("the top pick's own photos", () => {
  it('replace the search\'s on its option, labelled, with nothing else on the card changed', async () => {
    const card = await cardOnTrip('t_pick', 'c_pick');
    const link = new FakeLink();
    const listed = [
      { url: 'https://cdn.example.com/exterior.jpg', label: 'Exterior view' },
      { url: 'https://cdn.example.com/pool.jpg', label: 'Swimming pool' },
      { url: 'https://cdn.example.com/lobby.jpg' },
    ];
    expect(await showPickPhotos({ results, images, link }, 't_pick', { cardId: 'c_pick', optionId: 'opt_c_pick_1' }, details(listed))).toBe(true);
    const sent = link.sent('replace_card');
    expect(sent).toHaveLength(1);
    const replaced = C.OptionsCard.parse(sent[0]!['card']);
    expect(replaced.options[0]!.photos).toEqual([
      { url: 'https://go.test/img/exterior.jpg', label: 'Exterior view' },
      { url: 'https://go.test/img/pool.jpg', label: 'Swimming pool' },
      { url: 'https://go.test/img/lobby.jpg' },
    ]);
    // The rest is the card as it was: the other option's photos, every price and the time it was checked.
    expect({ ...replaced, options: replaced.options.map(({ photos: _p, ...o }) => o) }).toEqual({ ...card, options: card.options.map(({ photos: _p, ...o }) => o) });
    expect(replaced.options[1]!.photos).toEqual([{ url: 'https://go.test/img/search2.jpg' }]);
    // Kept as replaced: a vote opened from the card now carries the labelled photos.
    expect((await results.card('t_pick', 'c_pick'))!.card).toEqual(replaced);
    const vote = await openVoteFromCard({ results, link, now: () => new Date('2026-10-07T12:05:00Z') }, {
      tripId: 't_pick', cardId: 'c_pick', key: 'turn_v', requestId: 'go_vote_v', voteCardId: 'c_vote_v',
    });
    expect(vote.ok).toBe(true);
    const options = link.sent('open_vote')[0]!['options'] as Array<{ photos?: unknown }>;
    expect(options.map((o) => o.photos)).toEqual([replaced.options[0]!.photos, [{ url: 'https://go.test/img/search2.jpg' }]]);
    for (const o of options) expect(C.DecisionOption.safeParse(o).success).toBe(true);
  });

  // B4's seam (p4's rooms.ts): a card's option may gain its rooms the same way, and a vote carries them as the card shows them.
  it('a vote carries whatever the card\'s option gained after it went up: its rooms and price range too', async () => {
    await cardOnTrip('t_rooms', 'c_rooms');
    const room_types = [{ room_type_id: 'rt_deluxe', label: 'Deluxe room', sleeps: 2, price_minor: 2_400_000 }];
    const kept = await results.setOptionFields('t_rooms', 'c_rooms', 'opt_c_rooms_2', { room_types, price_min_minor: 1_200_000, price_max_minor: 1_500_000 });
    expect(kept!.options[1]).toMatchObject({ room_types, price_min_minor: 1_200_000, price_max_minor: 1_500_000, photos: [{ url: 'https://go.test/img/search2.jpg' }] });
    expect(kept!.options[0]).not.toHaveProperty('room_types');
    const link = new FakeLink();
    await openVoteFromCard({ results, link, now: () => new Date('2026-10-07T12:05:00Z') }, {
      tripId: 't_rooms', cardId: 'c_rooms', key: 'turn_r', requestId: 'go_vote_r', voteCardId: 'c_vote_r',
    });
    const options = link.sent('open_vote')[0]!['options'] as Array<Record<string, unknown>>;
    expect(options[1]).toMatchObject({ room_types, price_min_minor: 1_200_000, price_max_minor: 1_500_000 });
    expect(options[0]).not.toHaveProperty('room_types');
    for (const o of options) expect(C.DecisionOption.safeParse(o).success).toBe(true);
  });

  it('change nothing when the page listed none, or the card or the option is not kept', async () => {
    await cardOnTrip('t_none', 'c_none');
    const link = new FakeLink();
    const pick = { cardId: 'c_none', optionId: 'opt_c_none_1' };
    expect(await showPickPhotos({ results, images, link }, 't_none', pick, details(undefined))).toBe(false);
    expect(await showPickPhotos({ results, images, link }, 't_none', pick, details([]))).toBe(false);
    expect(await showPickPhotos({ results, images, link }, 't_none', { ...pick, optionId: 'opt_gone' }, details(['https://cdn.example.com/a.jpg']))).toBe(false);
    expect(await showPickPhotos({ results, images, link }, 't_other', pick, details(['https://cdn.example.com/a.jpg']))).toBe(false);
    expect(link.sent('replace_card')).toEqual([]);
    expect((await results.card('t_none', 'c_none'))!.card.options[0]!.photos).toEqual([{ url: 'https://go.test/img/search1.jpg' }]);
  });
});
