/** The Goa trip from the guide, and builders for messages and packs. Used by tests and the test-set runner. */
import * as C from '@go/contract';
import type { Message, Trip } from '../door/methods.js';
import type { Packs, TripPack } from '../trips/pack.js';

export const GOA = 't_goa';
const JOINED = '2026-10-05T02:30:00Z';
const START = Date.parse('2026-10-05T04:00:00Z');

export function goaPeople(): C.Person[] {
  const p = (person_id: string, name: string, extra: Partial<C.Person> = {}): C.Person => ({
    person_id,
    name,
    role: 'member',
    joined_at: JOINED,
    know: [],
    has_upi: false,
    go_paused: false,
    ...extra,
  });
  return [
    p('p_rahul', 'Rahul', { role: 'organizer', from_city: 'Delhi', earliest_leave: 'Fri after 6 pm', has_upi: true }),
    p('p_priya', 'Priya', { from_city: 'Delhi', know: ['Vegetarian', 'Window seat'] }),
    p('p_arjun', 'Arjun', { from_city: 'Bangalore', know: ['No early flights', 'Lands late on Friday'] }),
    p('p_meher', 'Meher', { from_city: 'Mumbai', know: ['Birthday on 7 Nov'] }),
    p('p_kabir', 'Kabir', { from_city: 'Delhi', earliest_leave: 'Fri evening', know: ["I don't drink"], has_upi: true }),
  ];
}

export function goaTrip(over: Partial<Trip> = {}): Trip {
  return C.TripSnapshot.parse({
    trip_id: GOA,
    seq: 1,
    title: 'Goa',
    status: 'planning',
    created_at: JOINED,
    organizer_person_id: 'p_rahul',
    invite_url: 'https://go.example/j/8fK2xQ',
    destination: { name: 'North Goa' },
    dates: { start: '2026-11-06', end: '2026-11-09' },
    vibe: [],
    budget: { answered: 0, of: 5 },
    people: goaPeople(),
    decisions: [],
    bookings: [],
    expenses: [],
    money: { currency: 'INR', spent_minor: 0, by_category: [], transfers: [] },
    itinerary: [],
    record: [],
    ...over,
  });
}

/** A message at change number `seq`, by a person id or 'go', one minute apart from 04:00 UTC. */
export function msg(seq: number, who: string, text: string | null, extra: Partial<Message> = {}): Message {
  return {
    message_id: `m_${String(seq).padStart(4, '0')}`,
    seq,
    updated_seq: seq,
    author: who === 'go' ? { kind: 'go' } : { kind: 'person', person_id: who },
    text,
    attachments: [],
    mentions_go: false,
    mentions: [],
    reactions: [],
    withheld: false,
    deleted: false,
    sent_at: new Date(START + seq * 60_000).toISOString(),
    ...extra,
  };
}

export function packOf(messages: Message[], trip: Trip = goaTrip()): TripPack {
  return { trip, messages, seq: messages.length ? messages[messages.length - 1]!.seq : trip.seq };
}

export function fakePacks(byTrip: Record<string, TripPack>): Packs & { invalidated: string[] } {
  const invalidated: string[] = [];
  return {
    invalidated,
    async get(tripId: string) {
      const p = byTrip[tripId];
      if (!p) throw new Error(`no pack for ${tripId}`);
      return p;
    },
    invalidate(tripId: string) {
      invalidated.push(tripId);
    },
  };
}
