import * as C from '@go/contract';
import type { Message, Trip, TripEvent } from '../../door/methods.js';

const person = (p: Partial<C.Person> & { person_id: string; name: string }): C.Person =>
  C.Person.parse({ role: 'member', joined_at: '2026-10-05T02:30:00Z', know: [], has_upi: false, go_paused: false, ...p });

/** The guide's Goa trip, just created: Rahul, Priya, Arjun, Meher and Kabir, nothing decided yet. */
export function goaSnapshot(over: Partial<Trip> = {}): Trip {
  return C.TripSnapshot.parse({
    trip_id: 't_goa',
    seq: 1,
    title: 'Goa 🌴',
    status: 'planning',
    created_at: '2026-10-05T02:30:00Z',
    organizer_person_id: 'p_rahul',
    invite_url: 'https://go.example/j/8fK2xQ',
    destination: { name: 'North Goa' },
    dates: { start: '2026-11-06', end: '2026-11-09' },
    vibe: ['beaches', 'food', 'sunsets'],
    stay: 'villa with a pool',
    budget: { answered: 0, of: 5 },
    people: [
      person({ person_id: 'p_rahul', name: 'Rahul', role: 'organizer', from_city: 'Delhi', earliest_leave: 'Fri after 6 pm', has_upi: true }),
      person({ person_id: 'p_priya', name: 'Priya', from_city: 'Delhi', know: ['Vegetarian', 'Window seat'] }),
      person({ person_id: 'p_arjun', name: 'Arjun', from_city: 'Bangalore', know: ['No early flights'] }),
      person({ person_id: 'p_meher', name: 'Meher', from_city: 'Mumbai', know: ['Birthday on 7 Nov'] }),
      person({ person_id: 'p_kabir', name: 'Kabir', from_city: 'Delhi', earliest_leave: 'Fri evening', has_upi: true }),
    ],
    decisions: [],
    bookings: [],
    expenses: [],
    money: { currency: 'INR', spent_minor: 0, by_category: [], transfers: [] },
    itinerary: [],
    record: [],
    ...over,
  });
}

const at = (seq: number) => new Date(Date.UTC(2026, 9, 5, 10, 0, 0) + seq * 1_000).toISOString();

/** A message from a person, or from Go when personId is null, posted at change number `seq`. */
export function msg(seq: number, personId: string | null, text: string, extra: Partial<Message> = {}): Message {
  return C.Message.parse({
    message_id: `m_${seq}`,
    seq,
    updated_seq: seq,
    author: personId ? { kind: 'person', person_id: personId } : { kind: 'go' },
    text,
    attachments: [],
    mentions_go: personId !== null && /@go\b/i.test(text),
    mentions: [],
    reactions: [],
    withheld: false,
    deleted: false,
    sent_at: at(seq),
    ...extra,
  });
}

/** One event for a trip, checked against the contract. */
export function ev<T extends TripEvent['type']>(
  seq: number,
  type: T,
  data: Extract<TripEvent, { type: T }>['data'],
  tripId = 't_goa',
): Extract<TripEvent, { type: T }> {
  return C.Event.parse({ event_id: `ev_${tripId}_${seq}`, trip_id: tripId, seq, occurred_at: at(seq), type, data }) as Extract<TripEvent, { type: T }>;
}

/** A vote, open unless `over` says otherwise. */
export function vote(over: Partial<C.Decision> & { decision_id: string }): C.Decision {
  return C.Decision.parse({
    question: 'Where do we stay?',
    kind: 'choice',
    anonymous: false,
    status: 'open',
    options: [{ label: 'Villa Sol' }, { label: 'Casa Azul' }],
    voted: 0,
    of: 5,
    tally: [0, 0],
    opened_at: '2026-10-05T10:00:00Z',
    ...over,
  });
}
