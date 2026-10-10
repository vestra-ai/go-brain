import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as C from '@go/contract';
import { withSchema } from '../../db/test-db.js';
import { FakeLink } from '../../tasks/testing/lane-brain.js';
import type { EngineAnswer } from '../book/engine.js';
import { buildOptionsCard, type CardPick, type OptionsCardT } from '../cards.js';
import { POSTED_WAIT_MS, showPickPhotos } from '../pick-photos.js';
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
    // The card is in the room, as the turn posted it.
    await link.request('post_message', { request_id: 'go_post_pick', trip_id: 't_pick', card });
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

  // The card goes out with the turn's reply, which can come after the pick's page is read: the replace waits for that post.
  it("wait for the card's post before replacing it, and replace nothing when it never went out", async () => {
    await cardOnTrip('t_late', 'c_late');
    const pick = { cardId: 'c_late', optionId: 'opt_c_late_1' };
    const asked: Array<[string, string, number]> = [];
    const link = new FakeLink();
    const posted = async (tripId: string, cardId: string, withinMs: number) => {
      asked.push([tripId, cardId, withinMs]);
      await link.request('post_message', { request_id: 'go_post_late', trip_id: tripId, card: (await results.card(tripId, cardId))!.card });
      return true;
    };
    expect(await showPickPhotos({ results, images, link, posted }, 't_late', pick, details(['https://cdn.example.com/a.jpg']))).toBe(true);
    expect(asked).toEqual([['t_late', 'c_late', POSTED_WAIT_MS]]);
    expect(link.requests.map((r) => r.method)).toEqual(['post_message', 'replace_card']);
    // A card whose post never answered in time: nothing is sent, and the kept card still has the photos (a vote's).
    const quiet = new FakeLink();
    expect(await showPickPhotos({ results, images, link: quiet, posted: async () => false }, 't_late', pick, details(['https://cdn.example.com/b.jpg']))).toBe(false);
    expect(quiet.requests).toEqual([]);
    expect((await results.card('t_late', 'c_late'))!.card.options[0]!.photos).toEqual([{ url: 'https://go.test/img/b.jpg' }]);
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

  // REV4 B4: the same page's kinds of room, priced for the stay's nights, and what one person pays, ride with the photos.
  it("put the top pick's rooms and price range on its option with its photos, and on their own when it listed no photos", async () => {
    await cardOnTrip('t_rooms', 'c_rooms');
    const link = new FakeLink();
    await link.request('post_message', { request_id: 'go_post_rooms', trip_id: 't_rooms', card: (await results.card('t_rooms', 'c_rooms'))!.card });
    const roomTypes = [
      { room_type_id: 'rt_family', label: 'Family Room', sleeps: 2, night_minor: 315_000 },
      { room_type_id: 'rt_suite', label: 'Executive Suite', sleeps: 2, night_minor: 618_300 },
    ];
    const page = (photoList: unknown): EngineAnswer => {
      const read = details(photoList) as Extract<EngineAnswer, { as: 'facts' }>;
      return { ...read, rows: [{ ...read.rows[0], room_types: roomTypes }] };
    };
    const group = { personIds: ['p_rahul', 'p_priya', 'p_arjun', 'p_kabir'], nights: 3 };
    const pick = { cardId: 'c_rooms', optionId: 'opt_c_rooms_1' };
    expect(await showPickPhotos({ results, images, link }, 't_rooms', pick, page([{ url: 'https://cdn.example.com/pool.jpg', label: 'Pool' }]), group)).toBe(true);
    const replaced = C.OptionsCard.parse(link.sent('replace_card').at(-1)!['card']);
    expect(replaced.options[0]).toMatchObject({
      photos: [{ url: 'https://go.test/img/pool.jpg', label: 'Pool' }],
      room_types: [
        { room_type_id: 'rt_family', label: 'Family Room', sleeps: 2, price_minor: 945_000 },
        { room_type_id: 'rt_suite', label: 'Executive Suite', sleeps: 2, price_minor: 1_854_900 },
      ],
      price_min_minor: 472_500,
      price_max_minor: 1_391_175,
    });
    // The other option is as it was.
    expect(replaced.options[1]).not.toHaveProperty('room_types');
    // A page with rooms and no photos still gives the option its rooms; with no group, photos only.
    await cardOnTrip('t_rooms2', 'c_rooms2');
    const quiet = new FakeLink();
    expect(await showPickPhotos({ results, images, link: quiet }, 't_rooms2', { cardId: 'c_rooms2', optionId: 'opt_c_rooms2_1' }, page(undefined), group)).toBe(true);
    expect((await results.card('t_rooms2', 'c_rooms2'))!.card.options[0]).toMatchObject({ room_types: [{ room_type_id: 'rt_family' }, { room_type_id: 'rt_suite' }], price_min_minor: 472_500 });
    expect(await showPickPhotos({ results, images, link: quiet }, 't_rooms2', { cardId: 'c_rooms2', optionId: 'opt_c_rooms2_2' }, page(undefined))).toBe(false);
  });
});
