/**
 * The Goa trip from the guide, trimmed to what lane C's tests read: five people, the dates, the place and the
 * messages of the demo's first two beats. Parsed through the contract, so a fixture that drifts from the wire
 * fails at once.
 */
import * as C from '@go/contract';
import type { Message, Trip } from '../../door/methods.js';
import type { TripPack } from '../../trips/pack.js';

const person = (person_id: string, name: string, joined_at: string, extra: Record<string, unknown> = {}) => ({
  person_id, name, role: 'member', joined_at, know: [], has_upi: false, go_paused: false, ...extra,
});

export const GOA_TRIP: Trip = C.TripSnapshot.parse({
  trip_id: 't_goa',
  seq: 40,
  title: 'Goa 🌴',
  status: 'planning',
  created_at: '2026-10-05T02:30:00Z',
  organizer_person_id: 'p_rahul',
  invite_url: 'https://go.example/j/8fK2xQ',
  destination: { name: 'North Goa', lat: 15.6, lng: 73.75 },
  dates: { start: '2026-11-06', end: '2026-11-09' },
  vibe: ['beaches', 'food', 'sunsets'],
  stay: 'villa with a pool',
  budget: { lowest: { min_minor: 1000000, max_minor: 1500000, currency: 'INR' }, answered: 4, of: 5 },
  people: [
    person('p_rahul', 'Rahul', '2026-10-05T02:30:00Z', { role: 'organizer', from_city: 'Delhi', earliest_leave: 'Fri after 6 pm', has_upi: true }),
    person('p_priya', 'Priya', '2026-10-05T02:48:00Z', { from_city: 'Delhi', know: ['Vegetarian', 'Window seat'] }),
    person('p_arjun', 'Arjun', '2026-10-05T03:02:00Z', { from_city: 'Bangalore', know: ['No early flights'] }),
    person('p_meher', 'Meher', '2026-10-05T03:15:00Z', { from_city: 'Mumbai', know: ['Birthday on 7 Nov'] }),
    person('p_kabir', 'Kabir', '2026-10-05T03:40:00Z', { from_city: 'Delhi', earliest_leave: 'Fri evening', has_upi: true }),
  ],
  decisions: [],
  bookings: [],
  expenses: [],
  money: { currency: 'INR', spent_minor: 0, by_category: [], transfers: [] },
  itinerary: [],
  record: [],
});

const msg = (seq: number, personId: string, text: string, extra: Record<string, unknown> = {}): Message =>
  C.Message.parse({
    message_id: `m_${seq}`,
    seq,
    updated_seq: seq,
    author: { kind: 'person', person_id: personId },
    text,
    attachments: [],
    mentions_go: false,
    mentions: [],
    reactions: [],
    withheld: false,
    deleted: false,
    sent_at: new Date(Date.UTC(2026, 9, 7, 11, 0, seq)).toISOString(),
    ...extra,
  });

export const GOA_MESSAGES: Message[] = [
  msg(31, 'p_arjun', "I can't leave before 6 on Friday, office till then"),
  msg(32, 'p_priya', "I'm veg btw"),
  msg(33, 'p_rahul', "@Go flights Delhi to Goa Friday evening, Arjun can't leave before 6", { mentions_go: true }),
  msg(34, 'p_meher', 'Go, find a villa with a pool in North Goa under 8k a head, near the beach', { mentions_go: true }),
];

export function goaPack(): TripPack {
  return { trip: GOA_TRIP, messages: GOA_MESSAGES, seq: 40 };
}
