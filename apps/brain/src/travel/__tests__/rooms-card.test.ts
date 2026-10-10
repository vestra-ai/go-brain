import * as C from '@go/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withSchema } from '../../db/test-db.js';
import type { DeskItem } from '../../desk/desk.js';
import { goaPack } from '../../tasks/testing/goa.js';
import type { TripPack } from '../../trips/pack.js';
import { closeRooms, createRoomsCards, ROOMS_PICK, ROOMS_SET, roomsCardOnClose, roomsTap, type RoomsCards } from '../rooms-card.js';

// The Server's REV4 B5 (10 Oct): once a vote picks a stay, its rooms card, so everyone sees their amount before anyone
// pays (the lead's call); a tap keeps the way picked, for the expense per room (B6).
let db: Awaited<ReturnType<typeof withSchema>>;
let store: RoomsCards;
beforeAll(async () => {
  db = await withSchema();
  store = createRoomsCards(db.pool);
});
afterAll(async () => {
  await db.drop();
});

const PAGE = 'https://www.ixigo.com/hotels/4395492/details?locationId=1026&locationName=Anjuna&checkinDate=06112026&checkoutDate=09112026&adultCount=5&roomCount=3&hName=High%20Five';
// High Five's two rooms as its page's read gives them (hotels.details' room_types): a night with taxes, in paise.
const ROW = {
  name: 'High Five Hotels Phase 2',
  room_types: [
    { room_type_id: 'rt_family', label: 'Family Room', sleeps: 2, night_minor: 315_000 },
    { room_type_id: 'rt_suite', label: 'Executive Suite', sleeps: 2, night_minor: 618_300 },
  ],
};
const closed: DeskItem = { id: 'change:ev_9', tripId: 't_goa', kind: 'trip_change', ref: 'decision:d_stay', dueAt: new Date(), payload: { type: 'decision.closed', decisionId: 'd_stay' } };

function packWith(winner: number): TripPack {
  const pack = goaPack();
  const decision = {
    decision_id: 'd_stay', question: 'Where do we stay?', kind: 'choice', anonymous: false, status: 'closed', options: [
      { label: 'High Five Hotels Phase 2', option_ref: 'opt_stay_1' },
      { label: 'Flight to Goa', option_ref: 'opt_flight_1' },
    ], voted: 5, of: 5, tally: [4, 1], result_index: winner, opened_at: '2026-10-10T08:00:00Z', closed_at: '2026-10-10T09:00:00Z',
  };
  return { ...pack, trip: { ...pack.trip, decisions: [decision as never] } };
}

function deps(o: { slow?: boolean } = {}) {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let release: () => void = () => undefined;
  const answer = vi.fn(async () => {
    if (o.slow) await new Promise<void>((r) => (release = r));
    return { as: 'facts' as const, title: 'High Five', rows: [ROW], page: PAGE, checkedAt: '2026-10-10T09:00:00.000Z', ms: 10 };
  });
  const offers: Record<string, unknown> = {
    opt_stay_1: { optionId: 'opt_stay_1', kind: 'stay', title: 'High Five Hotels Phase 2', sourceUrl: PAGE },
    opt_flight_1: { optionId: 'opt_flight_1', kind: 'flight', title: 'IndiGo 6E 2134', sourceUrl: 'https://www.ixigo.com/flight' },
  };
  return {
    requests,
    release: () => release(),
    d: {
      engine: { answer } as never,
      results: { offer: async (id: string) => offers[id] ?? null } as never,
      store,
      link: { request: async (method: string, params: Record<string, unknown>) => { requests.push({ method, params }); return { message_id: 'm_1' }; } } as never,
      packs: { get: async () => packWith(0) },
      log: { warn: vi.fn() },
      waitMs: 50,
    },
  };
}

describe('the rooms card on the closed vote', () => {
  it("rides on the turn that says a stay won: every way to take its rooms, who shares, and each one's amount for the stay", async () => {
    const t = deps();
    const r = await roomsCardOnClose(t.d)({ tripId: 't_goa', turnId: 'turn_close', wake: [closed], pack: packWith(0) });
    const card = C.Card.parse(r!.card);
    if (card.kind !== 'rooms') throw new Error(card.kind);
    expect(card).toMatchObject({ title: 'Rooms at High Five Hotels Phase 2', option_id: 'opt_stay_1', for_person_ids: ['p_rahul'] });
    expect(r!.line).toMatch(/^Here's how the rooms at High Five Hotels Phase 2 can split/);
    // Five people, rooms that sleep 2: three rooms, the odd one out in a room of their own, three nights each.
    const first = card.arrangements[0]!;
    expect(first.label).toBe('3 Family Room');
    expect(first.rooms.map((x) => x.person_ids)).toEqual([['p_rahul', 'p_priya'], ['p_arjun', 'p_meher'], ['p_kabir']]);
    expect(first.total_minor).toBe(2_835_000);
    expect(first.per_person.find((p) => p.person_id === 'p_kabir')!.amount_minor).toBe(945_000);
    expect(card.actions).toEqual([{ action_id: ROOMS_PICK, label: 'Choose', style: 'primary', per_option: true }]);
    // Kept for the tap.
    expect((await store.get(card.card_id))!.arrangements).toHaveLength(card.arrangements.length);
  });

  it('never for a winner that is not a stay, a vote with no winner, or a turn not woken by a closed vote', async () => {
    const t = deps();
    const rider = roomsCardOnClose(t.d);
    expect(await rider({ tripId: 't_goa', turnId: 'turn_a', wake: [closed], pack: packWith(1) })).toBeNull();
    const tied = packWith(0);
    (tied.trip.decisions[0] as { result_index: number | null }).result_index = null;
    expect(await rider({ tripId: 't_goa', turnId: 'turn_b', wake: [closed], pack: tied })).toBeNull();
    expect(await rider({ tripId: 't_goa', turnId: 'turn_c', wake: [], pack: packWith(0) })).toBeNull();
  });

  it("posts on its own when the stay's rooms take longer than the turn waits", async () => {
    const t = deps({ slow: true });
    expect(await roomsCardOnClose(t.d)({ tripId: 't_goa', turnId: 'turn_slow', wake: [closed], pack: packWith(0) })).toBeNull();
    expect(t.requests).toEqual([]);
    t.release();
    await vi.waitFor(() => expect(t.requests).toHaveLength(1));
    expect(t.requests[0]).toMatchObject({ method: 'post_message', params: { trip_id: 't_goa', card: { kind: 'rooms' }, text: expect.stringMatching(/^Here's how the rooms/) } });
  });
});

describe('a tap on the rooms card', () => {
  it("keeps the way picked, for the expense per room, and the card says it in place", async () => {
    const t = deps();
    const r = await roomsCardOnClose(t.d)({ tripId: 't_goa', turnId: 'turn_tap', wake: [closed], pack: packWith(0) });
    const card = C.Card.parse(r!.card);
    if (card.kind !== 'rooms') throw new Error(card.kind);
    const way = card.arrangements[1]!;
    const tap = roomsTap(t.d);
    const answer = await tap({ tap_id: 'tp_1', trip_id: 't_goa', card_id: card.card_id, action_id: ROOMS_PICK, person_id: 'p_priya', option_id: way.arrangement_id });
    expect(answer).toEqual({ result: 'done', toast: `${way.label}: saved` });
    expect((await store.chosenArrangement('t_goa', 'opt_stay_1'))!.arrangementId).toBe(way.arrangement_id);
    await vi.waitFor(() => expect(t.requests.some((x) => x.method === 'replace_card')).toBe(true));
    const replaced = C.Card.parse(t.requests.find((x) => x.method === 'replace_card')!.params['card']);
    expect(replaced).toMatchObject({ title: `Rooms at High Five Hotels Phase 2: ${way.label}`, fallback_text: `Priya picked ${way.label} at High Five Hotels Phase 2` });
    expect(await store.chosenArrangement('t_goa', 'opt_other')).toBeNull();
  });

  it('refuses a way not on the card, and a card that is not one', async () => {
    const t = deps();
    const r = await roomsCardOnClose(t.d)({ tripId: 't_goa', turnId: 'turn_bad', wake: [closed], pack: packWith(0) });
    const tap = roomsTap(t.d);
    expect(await tap({ tap_id: 'tp_2', trip_id: 't_goa', card_id: r!.card.card_id, action_id: ROOMS_PICK, person_id: 'p_priya', option_id: 'ar_nope' })).toEqual({ result: 'refused', toast: 'That way is not on the card any more.' });
    expect(await tap({ tap_id: 'tp_3', trip_id: 't_goa', card_id: 'c_nope', action_id: ROOMS_PICK, person_id: 'p_priya', option_id: 'ar_1' })).toEqual({ result: 'refused', toast: 'That card is not active any more.' });
  });
});

// The lead's ruling, 10 Oct: the rooms card closes when the stay's payment starts. The way picked then holds, so a
// retried finish reads the same; a later tap is refused, and the card is final, with no button.
describe('the rooms card when the stay is paid', () => {
  async function opened(tripId: string) {
    const t = deps();
    const r = await roomsCardOnClose(t.d)({ tripId, turnId: `turn_${tripId}`, wake: [closed], pack: packWith(0) });
    const card = C.Card.parse(r!.card);
    if (card.kind !== 'rooms') throw new Error(card.kind);
    return { t, card };
  }

  it('holds the way picked, refuses a later tap, and shows the card final; closing again changes nothing', async () => {
    const { t, card } = await opened('t_paid1');
    const way = card.arrangements[2]!;
    await roomsTap(t.d)({ tap_id: 'tp_p1', trip_id: 't_paid1', card_id: card.card_id, action_id: ROOMS_PICK, person_id: 'p_kabir', option_id: way.arrangement_id });
    // The tap's own card update has gone; what follows is the close's.
    await vi.waitFor(() => expect(t.requests.filter((x) => x.method === 'replace_card')).toHaveLength(1));
    const held = await closeRooms(t.d, 't_paid1', 'opt_stay_1');
    expect(held!.arrangementId).toBe(way.arrangement_id);
    const final = C.Card.parse(t.requests.filter((x) => x.method === 'replace_card').at(-1)!.params['card']);
    expect(final).toMatchObject({ title: `Rooms at High Five Hotels Phase 2: ${way.label}`, actions: [] });
    const later = await roomsTap(t.d)({ tap_id: 'tp_p2', trip_id: 't_paid1', card_id: card.card_id, action_id: ROOMS_PICK, person_id: 'p_rahul', option_id: card.arrangements[0]!.arrangement_id });
    expect(later).toEqual({ result: 'refused', toast: ROOMS_SET });
    // A retried finish closes again: the same way, and no second update of the card.
    expect((await closeRooms(t.d, 't_paid1', 'opt_stay_1'))!.arrangementId).toBe(way.arrangement_id);
    expect(t.requests.filter((x) => x.method === 'replace_card')).toHaveLength(2);
    expect((await store.chosenArrangement('t_paid1', 'opt_stay_1'))!.arrangementId).toBe(way.arrangement_id);
  });

  it('with no way picked: nothing held (one expense, split evenly), and the card says so, final', async () => {
    const { t, card } = await opened('t_paid2');
    expect(await closeRooms(t.d, 't_paid2', 'opt_stay_1')).toBeNull();
    const final = C.Card.parse(t.requests.find((x) => x.method === 'replace_card')!.params['card']);
    expect(final).toMatchObject({ title: 'Rooms at High Five Hotels Phase 2: split evenly', actions: [] });
    expect(await roomsTap(t.d)({ tap_id: 'tp_p3', trip_id: 't_paid2', card_id: card.card_id, action_id: ROOMS_PICK, person_id: 'p_rahul', option_id: card.arrangements[0]!.arrangement_id })).toEqual({ result: 'refused', toast: ROOMS_SET });
    // A stay with no rooms card has nothing to close.
    expect(await closeRooms(t.d, 't_paid2', 'opt_other')).toBeNull();
  });
});
