import { describe, expect, it, vi } from 'vitest';
import { GOA_TRIP, goaPack } from '../../tasks/testing/goa.js';
import { chooseTap } from '../choose.js';
import { renderOptionsTap } from '../taps.js';
import type { StoredOffer } from '../travel.js';

// Keshav, 12 Oct: "a trip of one never gets a vote; their word is the decision". Their Choose this is the trip's choice.

const person = GOA_TRIP.people[0]!.person_id;
const solo = { ...goaPack(), trip: { ...GOA_TRIP, people: GOA_TRIP.people.slice(0, 1) } };
const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

function world(kind: 'stay' | 'place' | 'activity', o: { forPersonIds?: string[] } = {}) {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const desk: Array<{ id?: string; payload: unknown }> = [];
  const started: unknown[] = [];
  const offer: StoredOffer = {
    optionId: 'opt_1', tripId: 't_goa', cardId: 'c_opt_1', resultsId: 'r_1', n: 1, offerId: null, kind, title: kind === 'place' ? 'Gokarna' : 'Villa Sol',
    priceMinor: 5_070_000, totalMinor: 5_070_000, currency: 'INR', priceNote: null, checkedAt: '2026-10-12T09:00:00Z', sourceUrl: null,
  };
  const tap = chooseTap({
    results: {
      offer: async (id: string) => (id === 'opt_1' ? offer : null),
      card: async () => ({ card: { for_person_ids: o.forPersonIds ?? [person] } }) as never,
    },
    packs: { get: async () => solo },
    link: { request: async (method: string, params: unknown) => (sent.push({ method, params: params as Record<string, unknown> }), { seq: 1 }) } as never,
    desk: { put: async (i: { id?: string; payload: unknown }) => void desk.push(i) },
    save: {
      pool: {} as never, now: () => new Date('2026-10-12T10:00:00Z'),
      travel: () => ({ placeFor: async (name: string) => ({ place: { name, place_id: 'ixigo:1' }, kind: 'city', within: ['Karnataka'] }) }) as never,
    },
    stays: { start: (ask) => (started.push(ask), 'started') },
    now: () => new Date('2026-10-12T10:00:00Z'),
    log: quiet,
  });
  const at = (who = person) => ({ tap_id: 'tap_1', trip_id: 't_goa', card_id: 'c_opt_1', action_id: 'choose', person_id: who, option_id: 'opt_1' });
  return { tap, at, sent, desk, started };
}

describe('Choose this in a trip of one', () => {
  it('a stay: saved as the stay at once and booked for them, with no vote', async () => {
    const w = world('stay');
    expect(await w.tap(w.at())).toEqual({ result: 'done', toast: 'Villa Sol it is. Go is booking it' });
    expect(w.started).toEqual([expect.objectContaining({ tapId: 'tap_1', tripId: 't_goa', personId: person, offer: expect.objectContaining({ optionId: 'opt_1' }) })]);
    await vi.waitFor(() => expect(w.sent.find((s) => s.method === 'update_trip')?.params).toMatchObject({ trip_id: 't_goa', stay: 'Villa Sol' }));
    expect(w.sent.map((s) => s.method)).not.toContain('open_vote');
  });

  it("a place: the trip's place, its title following, and Go wakes to say it and take the next step", async () => {
    const w = world('place');
    expect(await w.tap(w.at())).toEqual({ result: 'done', toast: 'Gokarna it is' });
    await vi.waitFor(() => expect(w.desk).toHaveLength(1));
    expect(w.sent.find((s) => s.method === 'update_trip')?.params).toMatchObject({ destination: { name: 'Gokarna' } });
    expect(w.desk[0]).toMatchObject({ id: 'travel:chosen:tap_1', payload: { source: 'options', action: 'chosen', kind: 'place', title: 'Gokarna', personId: person, saved: true } });
    const said = renderOptionsTap(w.desk[0] as never, solo);
    expect(said).toContain('it is saved as the trip\'s place');
    expect(said).toContain('Never say vote, poll or everyone.');
  });

  it("anything else is theirs, and Go replies in the room; a card that isn't theirs is refused", async () => {
    const w = world('activity');
    expect(await w.tap(w.at())).toEqual({ result: 'done', toast: 'Noted. Go will reply in the room.' });
    expect(w.desk[0]).toMatchObject({ payload: { action: 'chosen', kind: 'activity', saved: null } });
    expect(renderOptionsTap(w.desk[0] as never, solo)).toContain('this trip has one person, so it is theirs');
    const other = world('stay', { forPersonIds: ['p_someone_else'] });
    expect(await other.tap(other.at())).toEqual({ result: 'refused', toast: 'This one is for someone else to choose' });
    expect(other.started).toEqual([]);
  });
});
