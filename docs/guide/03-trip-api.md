# The trip API

The trip API is the set of calls go-brain makes to go-server to read a trip and act on it. Go uses it for everything it does in a trip: reading the trip, speaking in the room, opening votes, writing the trip record, recording bookings and expenses, and asking for a spend approval. go-server serves these routes and stays the source of truth, so Go never changes a trip any other way.

This is the page the go-server team builds from. It lists every route, the body each one takes and returns, and the rules go-server enforces, with the error to answer when a rule fails. The same routes are in `packages/contract/openapi/go-server.json`.

## The routes

go-server serves 16 routes, all under `/brain/v1/trips/{trip_id}`.

| Operation | Method | Path | What it does |
|---|---|---|---|
| `getTrip` | `GET` | `/brain/v1/trips/{trip_id}` | Returns the whole trip as Go may see it, at its current change number. |
| `updateTrip` | `PATCH` | `/brain/v1/trips/{trip_id}` | Changes the title, destination, dates, vibe, stay or the itinerary. |
| `listMessages` | `GET` | `/brain/v1/trips/{trip_id}/messages?after_seq=&limit=` | Returns the messages posted or changed after a change number, in `updated_seq` order, up to 200 at a time. |
| `postMessage` | `POST` | `/brain/v1/trips/{trip_id}/messages` | Posts Go's message in the room: text, a card, or both. |
| `putCard` | `PUT` | `/brain/v1/trips/{trip_id}/cards/{card_id}` | Replaces a card Go posted earlier, in place. Sends no event. |
| `setTyping` | `POST` | `/brain/v1/trips/{trip_id}/typing` | Shows or hides "Go is typing..." in the room. |
| `openDecision` | `POST` | `/brain/v1/trips/{trip_id}/decisions` | Opens a vote. |
| `closeDecision` | `POST` | `/brain/v1/trips/{trip_id}/decisions/{decision_id}/close` | Closes a vote now and returns the result. |
| `setMandate` | `PUT` | `/brain/v1/trips/{trip_id}/decisions/{decision_id}/mandate` | Sets what the group allowed for a closed choice vote: the choice, the cap, refundable only, and who pays. |
| `addRecordLine` | `POST` | `/brain/v1/trips/{trip_id}/record` | Adds an agreed, open or doing line to the trip record. |
| `updateRecordLine` | `PATCH` | `/brain/v1/trips/{trip_id}/record/{line_id}` | Changes a line Go wrote, or marks it done. |
| `addBooking` | `POST` | `/brain/v1/trips/{trip_id}/bookings` | Records a confirmed booking. |
| `updateBooking` | `PATCH` | `/brain/v1/trips/{trip_id}/bookings/{booking_id}` | Changes or cancels a booking. |
| `addExpense` | `POST` | `/brain/v1/trips/{trip_id}/expenses` | Records something someone paid for, split between people. |
| `requestSpendApproval` | `POST` | `/brain/v1/trips/{trip_id}/spend-approvals` | Runs the spend check. Answers with a signed, one-use spend approval for the vault, or the reason why not. |
| `cancelSpendApproval` | `POST` | `/brain/v1/trips/{trip_id}/spend-approvals/{approval_id}/cancel` | Releases a spend approval Go will not use, so it can never be used. Sends no event. |

## Rules for every route

These rules apply to all 16 routes. Each route's own section adds the rules that are particular to it.

| Rule | If it fails |
|---|---|
| The `x-go-signature` header is valid (see [Basics](01-basics.md#signing-every-request)). Check it before anything else. | `401 bad_signature` |
| The trip exists. Any id in the path (a vote, a line, a booking, a card, an approval) exists in this trip. | `404 not_found` |
| The body matches the contract. The error message names the field. | `422 invalid` |
| Every id in the body belongs to this trip: a person who is in the trip now, a message, vote or booking of this trip. The error message names the field. | `422 invalid` |
| Every amount uses the trip's currency (`money.currency` in the trip). A trip has one currency. | `422 invalid` |
| The request does not clash with the trip's current state, such as closing a vote that is already closed. | `409 conflict` |

Good to know:
- Errors use the body from [Basics](01-basics.md#errors): `{"error": {"code": "...", "message": "..."}}`.
- go-server answers every call within 2 seconds. go-brain retries a timeout, `429`, `500` or `503` three times, after 0.5, 2 and 5 seconds.
- Ignore fields you do not know, and treat `null` the same as a missing field.
- A person who left the trip is no longer "in the trip" for these rules.

## Doing each write once

Every write carries a `request_id` that go-brain makes, so go-server can do the write once even when the request arrives twice. go-brain makes a new `request_id` for every new write, and sends the same one again only when it retries that same write. `putCard` and `setTyping` have no `request_id`, because sending them twice does no harm.

go-server must do three things:

1. Store the `request_id` in the same transaction as the change, with a unique index on `(trip_id, request_id)`, together with the answer it sent.
2. When a `request_id` arrives that it already has, do nothing new and answer with the stored answer, including the same ids and the same `seq`.
3. Look for the `request_id` before running any rule. A retried `addBooking` must get its first answer back, not a `409` because its spend approval is now used.

The simplest way is one table for every route:

```sql
create table brain_requests (
  trip_id    text not null,
  request_id text not null,
  answer     jsonb not null,
  created_at timestamptz not null default now(),
  primary key (trip_id, request_id)
);
```

This helper runs a write in one transaction, stores its answer, and answers a repeat with the first answer. The skeleton at the end of this page uses it.

**TypeScript**

```ts
// once.ts
import pg from 'pg';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const READ = 'select answer from brain_requests where trip_id = $1 and request_id = $2';

/** Does a write once per (trip_id, request_id). A repeat gets the first answer back. */
export async function once<T>(tripId: string, requestId: string, work: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('begin');
    const seen = await db.query(READ, [tripId, requestId]);
    if (seen.rows.length > 0) {
      await db.query('rollback');
      return seen.rows[0].answer as T;
    }
    const answer = await work(db);
    await db.query('insert into brain_requests (trip_id, request_id, answer) values ($1, $2, $3)', [tripId, requestId, answer]);
    await db.query('commit');
    return answer;
  } catch (err) {
    await db.query('rollback');
    // Two copies arrived at the same moment and the other one committed first: answer with its answer.
    if ((err as { code?: string }).code === '23505') {
      const first = await db.query(READ, [tripId, requestId]);
      if (first.rows.length > 0) return first.rows[0].answer as T;
    }
    throw err;
  } finally {
    db.release();
  }
}
```

**Python**

```python
# once.py
import os
from collections.abc import Callable

import psycopg
from psycopg.types.json import Jsonb

DATABASE_URL = os.environ["DATABASE_URL"]
READ = "select answer from brain_requests where trip_id = %s and request_id = %s"


def once(trip_id: str, request_id: str, work: Callable[[psycopg.Connection], dict]) -> dict:
    """Does a write once per (trip_id, request_id). A repeat gets the first answer back."""
    try:
        # One transaction: it commits when the block ends and rolls back if anything raises.
        with psycopg.connect(DATABASE_URL) as conn:
            seen = conn.execute(READ, (trip_id, request_id)).fetchone()
            if seen:
                return seen[0]
            answer = work(conn)
            conn.execute(
                "insert into brain_requests (trip_id, request_id, answer) values (%s, %s, %s)",
                (trip_id, request_id, Jsonb(answer)),
            )
            return answer
    except psycopg.errors.UniqueViolation:
        # Two copies arrived at the same moment and the other one committed first: answer with its answer.
        with psycopg.connect(DATABASE_URL) as conn:
            first = conn.execute(READ, (trip_id, request_id)).fetchone()
        if first is None:
            raise
        return first[0]
```

Good to know:
- Only successful answers are stored. A write that was refused rolled back and left nothing behind, so a repeat of it is checked again.
- A denied spend approval is a successful answer (`200` with `"status": "denied"`), so a repeat gets the same denial. go-brain uses a new `request_id` when it asks again.
- When two copies arrive at the same moment, the second one waits on the trip's row lock (taken when the change number goes up), then hits the unique index after the first commits. Its change number goes back with the rollback, so no number is skipped.

## What each write answers, and its event

Every write that changes the trip adds one to the trip's change number, answers with that new `seq`, and sends the event for the change with the same `seq`. Go's own writes come back to go-brain as events, exactly like the changes people make, so go-brain sees every change in `seq` order. How go-server sends events is in [Events](02-events.md).

| Operation | Answer | Event go-server sends |
|---|---|---|
| `updateTrip` | `WriteResult` | `trip.updated`, with `changed` listing the fields sent and `by` Go |
| `postMessage` | `PostMessageResult` | `message.created` |
| `putCard` | `PutCardResult` (no `seq`) | None. Replacing a card is not a change. |
| `setTyping` | `Ok` (no `seq`) | None |
| `openDecision` | `OpenDecisionResult` | `decision.opened`, `by` Go |
| `closeDecision` | `CloseDecisionResult` | `decision.closed` with reason `closed_by_go`, then `record.changed` for the decided line, `by` system |
| `setMandate` | `WriteResult` | `mandate.set` |
| `addRecordLine` | `AddRecordLineResult` | `record.changed` with change `added`, `by` Go |
| `updateRecordLine` | `WriteResult` | `record.changed` with change `done` when `status` becomes `done`, otherwise `updated`, `by` Go |
| `addBooking` | `AddBookingResult` | `booking.changed` with change `added`, `by` Go, then `record.changed` for the booked line, `by` system |
| `updateBooking` | `WriteResult` | `booking.changed` with change `cancelled` or `updated`, `by` Go |
| `addExpense` | `AddExpenseResult` | `expense.changed` with change `added`, `by` Go |
| `requestSpendApproval` | `SpendApproved` or `SpendDenied` (no `seq`) | None. An approval is not a change anyone sees in the trip. |
| `cancelSpendApproval` | `Ok` (no `seq`) | None |

`by` Go is `{"kind": "go"}` and `by` system is `{"kind": "system"}`. When one call makes two changes (closing a vote and writing its decided line), each change gets its own `seq` and its own event, and the answer carries the `seq` of the first.

Every write that changes the trip answers with at least the new change number. This is the answer to the `updateTrip` call further down:

<!-- schema: WriteResult -->
```json
{ "seq": 52 }
```

## Reading the trip

### `getTrip`: read the whole trip

`getTrip` returns everything about a trip that Go may see, at the trip's current change number. go-brain calls it when it starts working on a trip it does not hold yet, when it sees a gap in change numbers, after a `trip.updated` event (which names what changed but not the new values), and once a minute for every active trip as a safety net.

The request is `GET /brain/v1/trips/t_goa`, with no body. The answer is the trip snapshot. Here is the Goa trip in the middle of planning, at change 113: the dates vote is closed, the group agreed on North Goa, Villa Sol won the stay vote and is booked and paid by Rahul, Rahul called off a vote about Sunday's beach, Kabir paid for the airport cab, and Meher's birthday dinner is still an idea.

<!-- schema: TripSnapshot -->
```json
{
  "trip_id": "t_goa",
  "seq": 113,
  "title": "Goa 🌴",
  "status": "planning",
  "created_at": "2026-10-05T02:30:00Z",
  "organizer_person_id": "p_rahul",
  "invite_url": "https://go.example/j/8fK2xQ",
  "destination": {
    "name": "North Goa",
    "lat": 15.6,
    "lng": 73.75,
    "photo_url": "https://brain.go.example/img/north-goa.jpg"
  },
  "dates": { "start": "2026-11-06", "end": "2026-11-09" },
  "vibe": ["beaches", "food", "sunsets"],
  "stay": "villa with a pool",
  "budget": {
    "lowest": { "min_minor": 1000000, "max_minor": 1500000, "currency": "INR" },
    "answered": 4,
    "of": 5
  },
  "people": [
    {
      "person_id": "p_rahul",
      "name": "Rahul",
      "photo_url": "https://cdn.go.example/people/p_rahul.jpg",
      "role": "organizer",
      "joined_at": "2026-10-05T02:30:00Z",
      "from_city": "Delhi",
      "earliest_leave": "Fri after 6 pm",
      "know": [],
      "has_upi": true,
      "go_paused": false
    },
    {
      "person_id": "p_priya",
      "name": "Priya",
      "photo_url": "https://cdn.go.example/people/p_priya.jpg",
      "role": "member",
      "joined_at": "2026-10-05T02:48:00Z",
      "from_city": "Delhi",
      "know": ["Vegetarian", "Window seat"],
      "has_upi": false,
      "go_paused": false
    },
    {
      "person_id": "p_arjun",
      "name": "Arjun",
      "photo_url": "https://cdn.go.example/people/p_arjun.jpg",
      "role": "member",
      "joined_at": "2026-10-05T03:02:00Z",
      "from_city": "Bangalore",
      "know": ["No early flights", "Lands late on Friday"],
      "has_upi": false,
      "go_paused": false
    },
    {
      "person_id": "p_meher",
      "name": "Meher",
      "photo_url": "https://cdn.go.example/people/p_meher.jpg",
      "role": "member",
      "joined_at": "2026-10-05T03:15:00Z",
      "from_city": "Mumbai",
      "know": ["Birthday on 7 Nov"],
      "has_upi": false,
      "go_paused": false
    },
    {
      "person_id": "p_kabir",
      "name": "Kabir",
      "photo_url": "https://cdn.go.example/people/p_kabir.jpg",
      "role": "member",
      "joined_at": "2026-10-05T03:40:00Z",
      "from_city": "Delhi",
      "earliest_leave": "Fri evening",
      "know": ["I don't drink"],
      "has_upi": true,
      "go_paused": false
    }
  ],
  "decisions": [
    {
      "decision_id": "d_when",
      "question": "When do we go?",
      "kind": "choice",
      "anonymous": false,
      "status": "closed",
      "options": [
        { "label": "30 Oct to 2 Nov" },
        { "label": "6 to 9 Nov", "note": "Diwali long weekend" },
        { "label": "13 to 16 Nov" }
      ],
      "voted": 4,
      "of": 5,
      "tally": [0, 4, 0],
      "votes": [
        { "person_id": "p_rahul", "option_index": 1 },
        { "person_id": "p_priya", "option_index": 1 },
        { "person_id": "p_arjun", "option_index": 1 },
        { "person_id": "p_meher", "option_index": 1 }
      ],
      "result_index": 1,
      "opened_at": "2026-10-05T02:30:30Z",
      "closed_at": "2026-10-05T03:45:00Z"
    },
    {
      "decision_id": "d_villa",
      "question": "Where do we stay?",
      "kind": "choice",
      "anonymous": false,
      "status": "closed",
      "options": [
        {
          "label": "Villa Sol",
          "image_url": "https://brain.go.example/img/villa-sol.jpg",
          "price_minor": 5420000,
          "currency": "INR",
          "option_ref": "ixigo:stay:villa-sol-anjuna",
          "note": "3 nights, private pool, Anjuna"
        },
        {
          "label": "Casa Azul",
          "image_url": "https://brain.go.example/img/casa-azul.jpg",
          "price_minor": 6180000,
          "currency": "INR",
          "option_ref": "ixigo:stay:casa-azul-assagao",
          "note": "3 nights, pool, Assagao"
        },
        {
          "label": "The Palms",
          "image_url": "https://brain.go.example/img/the-palms.jpg",
          "price_minor": 5850000,
          "currency": "INR",
          "option_ref": "ixigo:stay:the-palms-vagator",
          "note": "3 nights, pool, near Vagator beach"
        }
      ],
      "closes_at": "2026-10-05T12:30:00Z",
      "voted": 5,
      "of": 5,
      "tally": [4, 1, 0],
      "votes": [
        { "person_id": "p_rahul", "option_index": 0 },
        { "person_id": "p_arjun", "option_index": 1 },
        { "person_id": "p_priya", "option_index": 0 },
        { "person_id": "p_meher", "option_index": 0 },
        { "person_id": "p_kabir", "option_index": 0 }
      ],
      "result_index": 0,
      "mandate": {
        "choice_index": 0,
        "cap_minor": 5500000,
        "currency": "INR",
        "refundable_only": true,
        "payer_person_id": "p_rahul",
        "set_at": "2026-10-05T08:46:00Z",
        "confirmed_at": "2026-10-05T08:58:00Z"
      },
      "opened_at": "2026-10-05T07:30:00Z",
      "closed_at": "2026-10-05T08:45:00Z"
    },
    {
      "decision_id": "d_beach",
      "question": "Which beach on Sunday?",
      "kind": "choice",
      "anonymous": false,
      "status": "cancelled",
      "opened_by_person_id": "p_rahul",
      "options": [{ "label": "Ashwem" }, { "label": "Morjim" }],
      "voted": 2,
      "of": 5,
      "tally": [1, 1],
      "votes": [
        { "person_id": "p_rahul", "option_index": 0 },
        { "person_id": "p_meher", "option_index": 1 }
      ],
      "opened_at": "2026-10-06T09:40:00Z"
    }
  ],
  "bookings": [
    {
      "booking_id": "b_villa",
      "kind": "stay",
      "status": "confirmed",
      "title": "Villa Sol, 3 nights",
      "vendor": "ixigo",
      "ref": "IXG-7Q2K9",
      "amount_minor": 5420000,
      "currency": "INR",
      "payer_person_id": "p_rahul",
      "for_person_ids": ["p_rahul", "p_priya", "p_arjun", "p_meher", "p_kabir"],
      "refundable_until": "2026-11-01T18:29:59Z",
      "starts_at": "2026-11-06T14:00:00+05:30",
      "ends_at": "2026-11-09T11:00:00+05:30",
      "place": {
        "name": "Villa Sol",
        "address": "Anjuna, North Goa",
        "photo_url": "https://brain.go.example/img/villa-sol.jpg"
      },
      "image_url": "https://brain.go.example/img/villa-sol.jpg",
      "decision_id": "d_villa",
      "approval_id": "ap_01JA7Q3V8Z",
      "created_at": "2026-10-05T09:03:00Z"
    }
  ],
  "expenses": [
    {
      "expense_id": "e_villa",
      "paid_by_person_id": "p_rahul",
      "amount_minor": 5420000,
      "currency": "INR",
      "note": "Villa Sol, 3 nights",
      "category": "stay",
      "split_person_ids": ["p_rahul", "p_priya", "p_arjun", "p_meher", "p_kabir"],
      "booking_id": "b_villa",
      "created_at": "2026-10-05T09:03:20Z"
    },
    {
      "expense_id": "e_cab",
      "paid_by_person_id": "p_kabir",
      "amount_minor": 340000,
      "currency": "INR",
      "note": "Airport cab",
      "category": "getting_around",
      "split_person_ids": ["p_rahul", "p_priya", "p_arjun", "p_meher", "p_kabir"],
      "added_by_person_id": "p_kabir",
      "created_at": "2026-10-09T13:20:00Z"
    }
  ],
  "money": {
    "currency": "INR",
    "plan_minor": 7500000,
    "spent_minor": 5760000,
    "by_category": [
      { "category": "stay", "amount_minor": 5420000 },
      { "category": "getting_around", "amount_minor": 340000 }
    ],
    "transfers": [
      { "from_person_id": "p_priya", "to_person_id": "p_rahul", "amount_minor": 1152000, "currency": "INR" },
      { "from_person_id": "p_arjun", "to_person_id": "p_rahul", "amount_minor": 1152000, "currency": "INR" },
      { "from_person_id": "p_meher", "to_person_id": "p_rahul", "amount_minor": 1152000, "currency": "INR" },
      { "from_person_id": "p_kabir", "to_person_id": "p_rahul", "amount_minor": 812000, "currency": "INR" }
    ]
  },
  "itinerary": [
    {
      "date": "2026-11-06",
      "title": "Arrive",
      "items": [
        {
          "item_id": "i_land",
          "time": "20:45",
          "title": "Land in Goa on IndiGo 6E 2134",
          "category": "getting_around",
          "status": "planned",
          "note": "Rahul, Priya and Kabir from Delhi. Flights not booked yet."
        },
        {
          "item_id": "i_cab",
          "time": "21:15",
          "title": "Airport cab to Villa Sol",
          "category": "getting_around",
          "status": "booked",
          "note": "Kabir booked it"
        },
        {
          "item_id": "i_checkin",
          "time": "22:30",
          "title": "Check in at Villa Sol",
          "category": "stay",
          "place": { "name": "Villa Sol", "address": "Anjuna, North Goa" },
          "booking_id": "b_villa",
          "status": "booked",
          "note": "Arjun checks in at 11 pm. Mohan, the caretaker, meets him."
        }
      ]
    },
    {
      "date": "2026-11-07",
      "title": "Meher's birthday",
      "items": [
        {
          "item_id": "i_brunch",
          "time": "11:00",
          "title": "Brunch at Artjuna",
          "category": "food",
          "place": { "name": "Artjuna", "address": "Anjuna, North Goa" },
          "status": "idea"
        },
        {
          "item_id": "i_sunset",
          "time": "17:30",
          "title": "Sunset at Chapora Fort",
          "category": "activities",
          "place": { "name": "Chapora Fort", "address": "Chapora, North Goa" },
          "status": "planned"
        },
        {
          "item_id": "i_dinner",
          "time": "20:30",
          "title": "Birthday dinner at Thalassa",
          "category": "food",
          "place": { "name": "Thalassa", "address": "Siolim, North Goa" },
          "status": "idea",
          "note": "Plenty for Priya (vegetarian)"
        }
      ]
    }
  ],
  "record": [
    {
      "line_id": "r_dates",
      "kind": "decided",
      "text": "6 to 9 Nov",
      "status": "active",
      "proof": [],
      "person_ids": [],
      "decision_id": "d_when",
      "source": "vote",
      "created_at": "2026-10-05T03:45:00Z",
      "updated_at": "2026-10-05T03:45:00Z"
    },
    {
      "line_id": "r_north",
      "kind": "agreed",
      "text": "North Goa, not South",
      "status": "active",
      "proof": [
        { "message_id": "m_0122", "person_id": "p_priya" },
        { "message_id": "m_0124", "person_id": "p_arjun" }
      ],
      "person_ids": ["p_priya", "p_arjun", "p_rahul"],
      "source": "go",
      "created_at": "2026-10-05T04:14:00Z",
      "updated_at": "2026-10-05T04:14:00Z"
    },
    {
      "line_id": "r_scuba",
      "kind": "open",
      "text": "Scuba on Saturday?",
      "status": "active",
      "proof": [{ "message_id": "m_0149", "person_id": "p_arjun" }],
      "person_ids": ["p_meher", "p_kabir"],
      "source": "go",
      "created_at": "2026-10-05T07:20:00Z",
      "updated_at": "2026-10-05T07:20:00Z"
    },
    {
      "line_id": "r_villa",
      "kind": "booked",
      "text": "Villa Sol, 3 nights",
      "status": "active",
      "proof": [],
      "person_ids": [],
      "decision_id": "d_villa",
      "booking_id": "b_villa",
      "source": "booking",
      "created_at": "2026-10-05T08:45:00Z",
      "updated_at": "2026-10-05T09:03:00Z"
    },
    {
      "line_id": "r_cab",
      "kind": "doing",
      "text": "Kabir books the airport cab",
      "status": "done",
      "proof": [{ "message_id": "m_0192", "person_id": "p_kabir" }],
      "person_ids": ["p_kabir"],
      "source": "go",
      "created_at": "2026-10-05T11:05:00Z",
      "updated_at": "2026-10-09T13:20:30Z"
    },
    {
      "line_id": "r_deposit",
      "kind": "open",
      "text": "₹2,000 off at Villa Sol if we pay the deposit this week?",
      "status": "active",
      "proof": [{ "message_id": "m_0174" }],
      "person_ids": ["p_rahul"],
      "due_at": "2026-10-11T18:29:59Z",
      "source": "go",
      "created_at": "2026-10-06T10:36:00Z",
      "updated_at": "2026-10-06T10:36:00Z"
    }
  ]
}
```

What go-server leaves out of the snapshot:
- **Budget answers.** `budget` holds only the lowest band anyone picked and how many people answered. Never anyone's own answer, and never who picked what.
- **Contact details.** No phone numbers, emails or UPI ids. `has_upi` says only whether someone has a UPI id saved, so Go can suggest paying them back by UPI.
- **Who voted for what in an anonymous vote.** An anonymous vote has no `votes` list, only `voted`, `of` and `tally`.
- **People who left the trip.** They are not in `people`.

| Rule | If it fails |
|---|---|
| The trip exists. | `404 not_found` |

Good to know:
- Build the snapshot from one consistent read (one transaction), so `seq` matches the data. A change that commits while you read must be either all in the snapshot or not in it at all.
- `record` holds every line, including done and undone ones, so Go does not write again a line someone undid.
- Messages are not in the snapshot. Read them with `listMessages`.
- go-brain reads every active trip once a minute, so keep this call cheap.
- go-brain's fake go-server serves this snapshot (see [Build and test](09-build-and-test.md)).

### `listMessages`: read the messages posted or changed after a change number

`listMessages` returns every message that was posted or changed after a change number, oldest change first. go-brain calls it to catch up: when it holds change 46 and the next event it sees is 48, and after a restart. Because it also returns messages that were edited, deleted or reacted to, go-brain misses nothing when it skips events.

The request is `GET /brain/v1/trips/t_goa/messages?after_seq=46&limit=2`, with no body.

| Query | Required | What it is |
|---|---|---|
| `after_seq` | Yes | Return messages whose `updated_seq` is greater than this. A whole number, 0 or more. Use `0` to read the room from the start. |
| `limit` | No | Return at most this many messages, 1 to 200. Leave it out to get up to 200. |

Each message carries two change numbers. `seq` is the change number it got when it was posted. `updated_seq` is the change number of its latest change: posted, edited, deleted, or a reaction added or taken back. It equals `seq` until the message changes.

Here Priya posted at change 47 and Arjun at change 48. Meher then put a 👍 on Arjun's message (change 49) and Rahul put one on Priya's (change 50). The page comes in `updated_seq` order, so Arjun's message comes first:

<!-- schema: MessagesPage -->
```json
{
  "messages": [
    {
      "message_id": "m_0124",
      "seq": 48,
      "updated_seq": 49,
      "author": { "kind": "person", "person_id": "p_arjun" },
      "text": "Yes, North. It's closer to the airport for my late flight too.",
      "attachments": [],
      "mentions_go": false,
      "mentions": [],
      "reactions": [{ "emoji": "👍", "person_id": "p_meher" }],
      "withheld": false,
      "deleted": false,
      "sent_at": "2026-10-05T04:11:00Z"
    },
    {
      "message_id": "m_0122",
      "seq": 47,
      "updated_seq": 50,
      "author": { "kind": "person", "person_id": "p_priya" },
      "text": "Let's do North Goa, not South. Better beaches for us.",
      "attachments": [],
      "mentions_go": false,
      "mentions": [],
      "reactions": [{ "emoji": "👍", "person_id": "p_rahul" }],
      "withheld": false,
      "deleted": false,
      "sent_at": "2026-10-05T04:08:00Z"
    }
  ],
  "has_more": true
}
```

How go-server fills the page:
- It returns the messages whose `updated_seq` is greater than `after_seq`, sorted by `updated_seq`, each one as it is now.
- Go's own messages are included.
- A message from someone who paused Go is included with `"withheld": true`, no text, no attachments, `mentions_go` false, no `mentions` and no `about_message_id`.
- A deleted message is included with `"deleted": true` and no text.
- `has_more` is `true` when more messages changed after the last one in the page. To read them, call again with `after_seq` set to the `updated_seq` of the last message.

| Rule | If it fails |
|---|---|
| `after_seq` is given and is a whole number, 0 or more. | `422 invalid` |
| `limit`, if given, is a whole number from 1 to 200. | `422 invalid` |

This is how go-brain reads everything after a change number, one page at a time:

**TypeScript**

```ts
import { MessagesPage, SIGNATURE_HEADER, signRequest, type Message } from '@go/contract';

const GO_SERVER_URL = process.env.GO_SERVER_URL!;
const SECRET = process.env.GO_SIGNING_SECRET!;

/** Reads every message posted or changed after a change number, a page at a time. */
export async function messagesAfter(tripId: string, afterSeq: number): Promise<Message[]> {
  const messages: Message[] = [];
  for (let after = afterSeq; ; ) {
    const target = `/brain/v1/trips/${tripId}/messages?after_seq=${after}&limit=200`;
    const res = await fetch(GO_SERVER_URL + target, {
      headers: { [SIGNATURE_HEADER]: signRequest({ method: 'GET', target, body: '' }, SECRET) },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`listMessages answered ${res.status}`);
    const page = MessagesPage.parse(await res.json());
    messages.push(...page.messages);
    if (!page.has_more || page.messages.length === 0) return messages;
    after = page.messages[page.messages.length - 1]!.updated_seq;
  }
}
```

**Python**

```python
import os

import httpx
from go_contract import SIGNATURE_HEADER, models, sign_request

GO_SERVER_URL = os.environ["GO_SERVER_URL"]
SECRET = os.environ["GO_SIGNING_SECRET"]


def messages_after(trip_id: str, after_seq: int) -> list[models.Message]:
    """Reads every message posted or changed after a change number, a page at a time."""
    messages: list[models.Message] = []
    while True:
        target = f"/brain/v1/trips/{trip_id}/messages?after_seq={after_seq}&limit=200"
        headers = {SIGNATURE_HEADER: sign_request("GET", target, b"", SECRET)}
        res = httpx.get(GO_SERVER_URL + target, headers=headers, timeout=5)
        res.raise_for_status()
        page = models.MessagesPage.model_validate_json(res.content)
        messages += page.messages
        if not page.has_more or not page.messages:
            return messages
        after_seq = page.messages[-1].updated_seq
```

Good to know:
- Store `updated_seq` on the message row and index `(trip_id, updated_seq)`. Every edit, delete and reaction sets it to that change's `seq`, in the same transaction.
- The signed target includes the query string exactly as sent (see [Basics](01-basics.md#signing-every-request)).
- Change numbers have gaps between messages, because votes, record lines and bookings use change numbers too.

## Speaking in the room

### `postMessage`: post Go's message in the room

`postMessage` is how Go says something in the room: a line of text, a card, or both. go-brain calls it whenever Go speaks: when someone mentions Go or replies to it, when work someone asked for is done, when a vote closes or a decision is ready to move, and when something is wrong or at risk.

Here the villa vote has just closed, so Go posts the result with the mandate card and names Rahul, who pays. The request is `POST /brain/v1/trips/t_goa/messages`:

<!-- schema: PostMessage -->
```json
{
  "request_id": "rq_7e3b44",
  "text": "Villa Sol wins, 4 to 1! @Rahul, you're paying: tap Yes, book it and I'll book it, up to ₹55,000 and free to cancel.",
  "mentions": ["p_rahul"],
  "card": {
    "card_id": "c_villa_mandate",
    "kind": "mandate",
    "decision_id": "d_villa",
    "fallback_text": "Ready to book Villa Sol: up to ₹55,000, refundable only, Rahul pays. Rahul, open Go to say yes."
  }
}
```

The answer:

<!-- schema: PostMessageResult -->
```json
{ "message_id": "m_0158", "seq": 73 }
```

| Field | What it is |
|---|---|
| `request_id` | Go's id for this write. See [Doing each write once](#doing-each-write-once). |
| `text` | What Go says, 1 to 2,000 characters. |
| `card` | A card, as described in [Cards](04-cards.md). |
| `reply_to` | The message Go is answering, if any. |
| `mentions` | People Go names in the text. Each one gets a push. |

What go-server does:
1. Stores the message with Go as the author (`{"kind": "go"}`), the next change number as both `seq` and `updated_seq`, and the card exactly as it arrived.
2. Sends `message.created` with the whole message.
3. Shows the message in the room over the app's live connection. It appears whole: Go's replies are never streamed.
4. Hides "Go is typing...", because Go's message has landed.
5. Pushes the people in `mentions`, with Go's text. Pushes the people in the card's `for_person_ids`, with the card's `fallback_text`, and pins the card in their "needs you" strip (see [The app](06-the-app.md#the-needs-you-strip)).

| Rule | If it fails |
|---|---|
| The body has text, a card, or both. | `422 invalid` |
| Every person in `mentions` is in the trip. | `422 invalid` |
| `reply_to`, if set, is a message in this trip. | `422 invalid` |
| A record card's id (`decision_id`, `booking_id` or `expense_id`) is in this trip. | `422 invalid` |
| A mandate card's vote has a mandate. | `409 conflict` |
| The `card_id` is not already in this trip's room. To change a card, use `putCard`. | `409 conflict` |

Good to know:
- Store the card as the JSON you received, not rebuilt from your own columns, so a field added to a card later in version 1 still reaches the app.
- Send the pushes and the live update once, after the transaction commits, and not again for a repeated `request_id`.
- `mentions_go` is `false` on Go's own messages.
- go-server pins an open vote and a mandate waiting for its payer from its own rows, so Go leaves `for_person_ids` out of vote and mandate cards.

### `putCard`: replace a card in place

`putCard` replaces a card Go posted earlier with a new version of it, in the same place in the room. Go uses it for a card that changes: a live call, a working task, a pay card that moves to paid. Go also uses it to take people out of `for_person_ids` once they have nothing left to do on the card.

Here Rahul has paid for the villa, so Go moves the pay card to `paid`, removes its buttons, and takes Rahul out of `for_person_ids`. The request is `PUT /brain/v1/trips/t_goa/cards/c_villa_pay`, and the body is the whole new card:

<!-- schema: PayCard -->
```json
{
  "card_id": "c_villa_pay",
  "kind": "pay",
  "fallback_text": "Paid ₹54,200 to ixigo for Villa Sol, 3 nights. Free cancellation until 1 Nov.",
  "approval_id": "ap_01JA7Q3V8Z",
  "payer_person_id": "p_rahul",
  "amount_minor": 5420000,
  "currency": "INR",
  "merchant": "ixigo: Villa Sol, Anjuna",
  "purpose": "Villa Sol, 3 nights, 6 to 9 Nov",
  "refundable_until": "2026-11-01T18:29:59Z",
  "expires_at": "2026-10-05T09:10:00Z",
  "state": "paid"
}
```

The answer names the message the card is on:

<!-- schema: PutCardResult -->
```json
{ "message_id": "m_0161" }
```

What go-server does:
- Replaces the card on its message and shows the new version in the room over the app's live connection. The message keeps its place in the room.
- Updates the "needs you" strip: people who are no longer in `for_person_ids` are unpinned, and people newly added are pinned. A replaced card is not a new card, so it sends no push.
- Adds no change number and sends no event. Replacing a card is not a change to the trip.

| Rule | If it fails |
|---|---|
| The body is a valid card. | `422 invalid` |
| The `card_id` in the body matches the `card_id` in the path. | `422 invalid` |
| The card is on one of Go's messages in this trip. Only Go's own cards can be replaced. | `404 not_found` |

Good to know:
- There is no `request_id`. Sending the same card twice leaves the same card, so a retry is safe.
- go-brain sends the updates for one card one at a time and waits for each answer, so an older version never lands after a newer one.
- Go keeps the card's `kind`. Something new is a new message.
- To check the body in Python, use `go_contract.Card.model_validate_json(body).root`, which gives the right card class for its `kind`. In TypeScript, use `Card.parse` from `@go/contract`.
- On a record card, only `for_person_ids` and `fallback_text` change what people see, because go-server draws the rest from its own rows.

### `setTyping`: show "Go is typing..."

`setTyping` shows or hides "Go is typing..." in the room. Go turns it on when it starts working on an answer, and sends it again every 5 seconds while it works.

The request is `POST /brain/v1/trips/t_goa/typing`:

<!-- schema: SetTyping -->
```json
{ "on": true }
```

The answer:

<!-- schema: Ok -->
```json
{ "ok": true }
```

What go-server does:
- `"on": true` shows "Go is typing..." to everyone in the room for up to 10 seconds, or until Go's next message lands, whichever comes first.
- `"on": false` hides it at once.
- Stores nothing, adds no change number and sends no event.

| Rule | If it fails |
|---|---|
| The trip exists. | `404 not_found` |

Good to know:
- There is no `request_id`. Showing the indicator twice does no harm.
- If go-brain stops sending it (for example, because it restarted), the indicator goes away by itself after 10 seconds.

## Changing the trip details

### `updateTrip`: change the title, destination, dates, vibe, stay or itinerary

`updateTrip` changes the trip's details. Go calls it when the group settles one of them, for example when they agree on North Goa, or when Go adds a plan to the itinerary.

The request is `PATCH /brain/v1/trips/t_goa`. Only the fields sent change:

<!-- schema: UpdateTrip -->
```json
{
  "request_id": "rq_2d81f0",
  "destination": {
    "name": "North Goa",
    "lat": 15.6,
    "lng": 73.75,
    "photo_url": "https://brain.go.example/img/north-goa.jpg"
  }
}
```

The answer is a `WriteResult`, here `{"seq": 52}`. go-server sends `trip.updated` with `"changed": ["destination"]` and `"by": {"kind": "go"}`.

| Rule | If it fails |
|---|---|
| The body has at least one field besides `request_id`. (`trip.updated` must name at least one changed field.) | `422 invalid` |
| `dates.start` is on or before `dates.end`. | `422 invalid` |
| Every itinerary item's `booking_id`, if set, is a booking in this trip. | `422 invalid` |

Good to know:
- `itinerary` replaces the whole itinerary. To change one item, Go reads the trip, changes that item and sends every day back.
- The trip's `status` and `budget` are not Go's to change, so they are not in this body. When someone answers the budget question, go-server sends `trip.updated` with `"changed": ["budget"]` and `by` system, never the person, so nobody's answer can be traced to them.

## Votes and mandates

### `openDecision`: open a vote

`openDecision` opens a vote. Go calls it when someone asks for a vote, or taps "Put it to a vote" on an options card.

The request is `POST /brain/v1/trips/t_goa/decisions`:

<!-- schema: OpenDecision -->
```json
{
  "request_id": "rq_4a6f12",
  "question": "Where do we stay?",
  "kind": "choice",
  "anonymous": false,
  "options": [
    {
      "label": "Villa Sol",
      "image_url": "https://brain.go.example/img/villa-sol.jpg",
      "price_minor": 5420000,
      "currency": "INR",
      "option_ref": "ixigo:stay:villa-sol-anjuna",
      "note": "3 nights, private pool, Anjuna"
    },
    {
      "label": "Casa Azul",
      "image_url": "https://brain.go.example/img/casa-azul.jpg",
      "price_minor": 6180000,
      "currency": "INR",
      "option_ref": "ixigo:stay:casa-azul-assagao",
      "note": "3 nights, pool, Assagao"
    },
    {
      "label": "The Palms",
      "image_url": "https://brain.go.example/img/the-palms.jpg",
      "price_minor": 5850000,
      "currency": "INR",
      "option_ref": "ixigo:stay:the-palms-vagator",
      "note": "3 nights, pool, near Vagator beach"
    }
  ],
  "closes_at": "2026-10-05T12:30:00Z"
}
```

The answer:

<!-- schema: OpenDecisionResult -->
```json
{ "decision_id": "d_villa", "seq": 64 }
```

Then Go shows the vote in the room with `postMessage`:

<!-- schema: PostMessage -->
```json
{
  "request_id": "rq_5c09a1",
  "text": "Three villas with a pool in North Goa, all free to cancel. Vote by 6 pm?",
  "card": {
    "card_id": "c_villa_vote",
    "kind": "vote",
    "decision_id": "d_villa",
    "fallback_text": "Vote: Where do we stay? Villa Sol ₹54,200, Casa Azul ₹61,800 or The Palms ₹58,500, for 3 nights. Open Go to vote."
  }
}
```

What go-server does:
1. Creates the vote with `status` `open`, no `opened_by_person_id` (Go opened it), `voted` 0, `of` set to the number of people in the trip, and a `tally` of zeros.
2. Sends `decision.opened` with the vote and `"by": {"kind": "go"}`.
3. Does not show the vote in the room yet. Go posts the message with the vote card next.
4. Pins the vote in the "needs you" strip of everyone who has not voted.
5. Closes the vote by itself at `closes_at` (reason `time`) or when everyone has voted (reason `everyone_voted`), and pushes the people who have not voted when the vote is about to close.

| Rule | If it fails |
|---|---|
| The vote has 2 to 10 options. | `422 invalid` |
| `closes_at`, if set, is in the future. | `422 invalid` |

Good to know:
- An anonymous vote shows totals only. Nobody sees who voted for what, including Go: `decision.voted` events and the snapshot leave out `person_id`, `option_index` and `votes`.
- `option_ref` is Go's own reference for an option (such as an ixigo offer), so it can book the winner. go-server stores it and gives it back unchanged.

### `closeDecision`: close a vote now

`closeDecision` closes an open vote at once and returns the result. Go calls it when someone asks Go to close a vote. Here Rahul asks Go to close the dates vote with 4 of 5 votes in, because Kabir has only just joined.

The request is `POST /brain/v1/trips/t_goa/decisions/d_when/close`:

<!-- schema: CloseDecision -->
```json
{ "request_id": "rq_1f9c30" }
```

The answer is the vote as it is now:

<!-- schema: CloseDecisionResult -->
```json
{
  "decision": {
    "decision_id": "d_when",
    "question": "When do we go?",
    "kind": "choice",
    "anonymous": false,
    "status": "closed",
    "options": [
      { "label": "30 Oct to 2 Nov" },
      { "label": "6 to 9 Nov", "note": "Diwali long weekend" },
      { "label": "13 to 16 Nov" }
    ],
    "voted": 4,
    "of": 5,
    "tally": [0, 4, 0],
    "votes": [
      { "person_id": "p_rahul", "option_index": 1 },
      { "person_id": "p_priya", "option_index": 1 },
      { "person_id": "p_arjun", "option_index": 1 },
      { "person_id": "p_meher", "option_index": 1 }
    ],
    "result_index": 1,
    "opened_at": "2026-10-05T02:30:30Z",
    "closed_at": "2026-10-05T03:45:00Z"
  },
  "seq": 45
}
```

What go-server does:
1. Sets `status` to `closed`, `closed_at` to now, and `result_index` to the option with the most votes. When nobody voted, or the top options tied, `result_index` stays empty and no decided line is written: Go asks the group to settle it, usually with a new vote between the tied options.
2. Sends `decision.closed` with reason `closed_by_go`. The answer's `seq` is this change.
3. Writes a decided line in the trip record, with the winning option's label as its text ("6 to 9 Nov"), the vote's `decision_id`, and `source` `vote`. This is a second change, with its own `seq` (here 46) and its own `record.changed` event, `by` system.

| Rule | If it fails |
|---|---|
| The vote exists in this trip. | `404 not_found` |
| The vote is open. Closing a vote that is closed or cancelled is refused. | `409 conflict` |

Good to know:
- There is no route for Go to call off a vote. People do that in the app, and go-brain gets `decision.cancelled`.

### `setMandate`: set what the group allowed

`setMandate` records what the group allowed for a spend after a choice vote: which option, the cap, whether it must be refundable, and who pays. Go calls it when a vote about something to book closes. Then it posts the result with a mandate card (the example in [`postMessage`](#postmessage-post-gos-message-in-the-room)), so the payer can say yes.

The request is `PUT /brain/v1/trips/t_goa/decisions/d_villa/mandate`:

<!-- schema: SetMandate -->
```json
{
  "request_id": "rq_6b2d85",
  "choice_index": 0,
  "cap_minor": 5500000,
  "currency": "INR",
  "refundable_only": true,
  "payer_person_id": "p_rahul"
}
```

The answer is a `WriteResult`, here `{"seq": 72}`.

What go-server does:
1. Stores the mandate on the vote, with `set_at` set to now.
2. When the vote already had a mandate, replaces it and clears the payer's earlier yes or no (`confirmed_at` and `declined_at`). The payer must answer again.
3. Sends `mandate.set` with the new mandate.
4. Pins the mandate in the payer's "needs you" strip until they answer.

The mandate card's "Yes, book it" and "Not now" buttons belong to go-server, because they are part of the spend check. go-server shows them to the payer only. When the payer taps one, go-server records `confirmed_at` or `declined_at` and sends `mandate.confirmed` or `mandate.declined`.

| Rule | If it fails |
|---|---|
| The vote exists in this trip. | `404 not_found` |
| The vote is a choice vote. | `409 conflict` |
| The vote is closed. | `409 conflict` |
| `choice_index` is one of the vote's options (from 0 to the number of options minus 1). | `422 invalid` |
| `payer_person_id` is in the trip. | `422 invalid` |
| `cap_minor` is more than zero. | `422 invalid` |

Good to know:
- `choice_index` is usually the winning option, but go-server does not require it.
- Go replaces a mandate when the group allows something new, for example a higher cap after the price went up.

## The trip record

### `addRecordLine`: add a line to the trip record

`addRecordLine` adds an agreed, open or doing line to the trip record. Go calls it after it replies in the room, or after a message it only took notes on, when it saves what the room settled without a vote, a question still to settle, or something someone said they will sort. Go does not announce each line in the room.

| `kind` | When Go writes it | `person_ids` |
|---|---|---|
| `agreed` | The group agreed in the chat without a vote: two people said yes (a thumbs-up reaction counts) or the organizer did, and nobody objected. | Who agreed |
| `open` | A question is still to settle, or an agreement did not meet the bar above. | Who is asked |
| `doing` | Someone said they will sort something. | Who is on it |

Here Priya proposed North Goa, Arjun said yes, Rahul put a 👍 on Priya's message, and nobody objected. The request is `POST /brain/v1/trips/t_goa/record`:

<!-- schema: AddRecordLine -->
```json
{
  "request_id": "rq_0e7a59",
  "kind": "agreed",
  "text": "North Goa, not South",
  "proof": [
    { "message_id": "m_0122", "person_id": "p_priya" },
    { "message_id": "m_0124", "person_id": "p_arjun" }
  ],
  "person_ids": ["p_priya", "p_arjun", "p_rahul"]
}
```

The answer:

<!-- schema: AddRecordLineResult -->
```json
{ "line_id": "r_north", "seq": 51 }
```

go-server stores the line with `status` `active` and `source` `go`, and sends `record.changed` with change `added` and `"by": {"kind": "go"}`.

| Rule | If it fails |
|---|---|
| `kind` is `agreed`, `open` or `doing`. Decided and booked lines come only from votes and bookings. | `422 invalid` |
| An agreed line has at least one proof. | `422 invalid` |
| Every proof's `message_id` is a message in this trip. | `422 invalid` |
| Every person id, in `person_ids` and in `proof`, is in the trip. | `422 invalid` |

Good to know:
- People can undo any line in the app. go-brain then gets `record.changed` with change `undone`, `by` that person. Go never undoes a line.
- `due_at` is for a line with a deadline, such as an open question that must be settled by the end of the week.

### `updateRecordLine`: change a line or mark it done

`updateRecordLine` changes a line Go wrote, or marks it done. Go calls it when an open question gets settled (the line becomes agreed), or when someone finishes what they said they would do. Here Kabir has paid for the airport cab, so Go marks his line done.

The request is `PATCH /brain/v1/trips/t_goa/record/r_cab`. Only the fields sent change:

<!-- schema: UpdateRecordLine -->
```json
{ "request_id": "rq_9d4c17", "status": "done" }
```

The answer is a `WriteResult`, here `{"seq": 113}`. go-server sends `record.changed` with change `done`, because `status` became `done`. Any other change sends change `updated`.

| Rule | If it fails |
|---|---|
| The line exists in this trip. | `404 not_found` |
| Go wrote the line (`source` is `go`). Decided, booked and people's own lines are not Go's to change. | `409 conflict` |
| The line is not undone. A line someone undid stays undone. If it comes up again, Go adds a new line. | `409 conflict` |
| `status`, if sent, is `active` or `done`. Go cannot undo a line. | `422 invalid` |
| The body has at least one field besides `request_id`. | `422 invalid` |
| After the change, an agreed line still has at least one proof. | `422 invalid` |
| Every proof message and person id is in this trip. | `422 invalid` |

Good to know:
- `proof` replaces the whole proof list. To add a proof, send the old ones and the new one.

## Bookings and expenses

### `addBooking`: record a confirmed booking

`addBooking` records a booking that is confirmed: a stay, a flight, a table and so on. Go calls it after it books something. When Go paid through the vault, Go sends the spend approval's `approval_id` with it. When someone in the group booked something themselves and shared it, Go records it without one.

Here Rahul approved the payment in the vault, ixigo confirmed the villa, and Go records it. The request is `POST /brain/v1/trips/t_goa/bookings`:

<!-- schema: AddBooking -->
```json
{
  "request_id": "rq_book_villa_1",
  "kind": "stay",
  "title": "Villa Sol, 3 nights",
  "vendor": "ixigo",
  "ref": "IXG-7Q2K9",
  "amount_minor": 5420000,
  "currency": "INR",
  "payer_person_id": "p_rahul",
  "for_person_ids": ["p_rahul", "p_priya", "p_arjun", "p_meher", "p_kabir"],
  "refundable_until": "2026-11-01T18:29:59Z",
  "starts_at": "2026-11-06T14:00:00+05:30",
  "ends_at": "2026-11-09T11:00:00+05:30",
  "place": {
    "name": "Villa Sol",
    "address": "Anjuna, North Goa",
    "photo_url": "https://brain.go.example/img/villa-sol.jpg"
  },
  "image_url": "https://brain.go.example/img/villa-sol.jpg",
  "decision_id": "d_villa",
  "approval_id": "ap_01JA7Q3V8Z"
}
```

The answer:

<!-- schema: AddBookingResult -->
```json
{ "booking_id": "b_villa", "seq": 76 }
```

What go-server does:
1. With an `approval_id`, checks the spend approval (see the rules below) and marks it used, in the same transaction as the booking.
2. Stores the booking with `status` `confirmed` and no `added_by_person_id` (Go added it).
3. Sends `booking.changed` with change `added` and `"by": {"kind": "go"}`. The answer's `seq` is this change.
4. Writes the booked line in the trip record, with the booking's title as its text, its `booking_id`, and `source` `booking`. When the booking has a `decision_id` and that vote already has a decided line, go-server turns that line into the booked line (same `line_id`) instead of adding a second one. This is a second change, with its own `seq` (here 77) and its own `record.changed` event, `by` system.

After this, Go records the expense with `addExpense`, posts a ticket card, and updates the pay card to paid.

| Rule | If it fails |
|---|---|
| `payer_person_id` and every person in `for_person_ids` are in the trip. | `422 invalid` |
| `decision_id`, if set, is a vote in this trip. | `422 invalid` |
| With an `approval_id`: the approval belongs to this trip. | `409 conflict` |
| With an `approval_id`: it is for the same vote (the booking's `decision_id` is the approval's). | `409 conflict` |
| With an `approval_id`: the approval has not been used or cancelled. | `409 conflict` |
| With an `approval_id`: `amount_minor` is no more than the approved amount, in the same currency. | `409 conflict` |

Good to know:
- go-server does not refuse a booking because its approval has expired since. The vault checked the expiry before paying, and recording the booking can come a little later.
- A repeated `request_id` gets the first answer before any rule runs, so a retry after the approval was marked used still gets `b_villa` back.
- [Money and the vault](07-money-and-the-vault.md#marking-an-approval-used) has the code for these checks.

### `updateBooking`: change or cancel a booking

`updateBooking` changes a booking or cancels it. Go calls it when a vendor changes a time, a reference or the free cancellation date, and when a booking is cancelled. Here Villa Sol agreed to a 1 pm check-out on the last day.

The request is `PATCH /brain/v1/trips/t_goa/bookings/b_villa`. Only the fields sent change:

<!-- schema: UpdateBooking -->
```json
{ "request_id": "rq_b37f08", "ends_at": "2026-11-09T13:00:00+05:30" }
```

The answer is a `WriteResult`, here `{"seq": 117}`. go-server sends `booking.changed` with change `cancelled` when `status` is `cancelled`, and change `updated` otherwise.

| Rule | If it fails |
|---|---|
| The booking exists in this trip. | `404 not_found` |
| The booking is not cancelled. A cancelled booking cannot change. | `409 conflict` |
| The body has at least one field besides `request_id`. | `422 invalid` |

Good to know:
- `"status": "cancelled"` records that the booking is cancelled. It does not cancel anything with the vendor: Go does that first, then calls this route.

### `addExpense`: record something someone paid for

`addExpense` records something someone paid for, split equally between people. Go calls it after every booking Go pays for through the vault, and when someone says in the room that they paid for something.

Here Go records the villa Rahul just paid for, split between all five. The request is `POST /brain/v1/trips/t_goa/expenses`:

<!-- schema: AddExpense -->
```json
{
  "request_id": "rq_expense_villa_1",
  "paid_by_person_id": "p_rahul",
  "amount_minor": 5420000,
  "currency": "INR",
  "note": "Villa Sol, 3 nights",
  "category": "stay",
  "split_person_ids": ["p_rahul", "p_priya", "p_arjun", "p_meher", "p_kabir"],
  "booking_id": "b_villa"
}
```

The answer:

<!-- schema: AddExpenseResult -->
```json
{ "expense_id": "e_villa", "seq": 78 }
```

go-server stores the expense with no `added_by_person_id` (Go added it), works out the trip's money again (what was spent, by category, and the transfers that square everyone up), and sends `expense.changed` with change `added` and `"by": {"kind": "go"}`.

| Rule | If it fails |
|---|---|
| `paid_by_person_id` and every person in `split_person_ids` are in the trip. | `422 invalid` |
| `booking_id`, if set, is a booking in this trip. | `422 invalid` |
| `amount_minor` is more than zero. | `422 invalid` |

Good to know:
- go-server does all the money maths: shares, totals and the fewest transfers. Go reads the result from `money` in the snapshot and never works it out itself.
- People add expenses in the app too, like Kabir's airport cab (`e_cab`). go-brain gets those as `expense.changed` with `by` that person.
- Go cannot remove an expense. People can, in the app, and go-brain then gets `expense.changed` with change `removed`.

## Spend approvals

### `requestSpendApproval`: ask whether a payment may happen

`requestSpendApproval` asks go-server whether a payment may happen. go-server runs the spend check, and answers with either a signed, one-use spend approval for the vault or the reason it said no. Go calls it after the payer taps "Yes, book it" on the mandate card and Go has checked the price again, just before it asks the payer to approve the payment.

This is where the call sits in a payment:

1. A vote closes. Go sets the mandate and posts a mandate card.
2. The payer taps "Yes, book it". go-server sends `mandate.confirmed`.
3. Go checks the price again and calls `requestSpendApproval`.
4. go-server runs the spend check, signs a spend approval that expires within 10 minutes, and answers.
5. Go posts a pay card for the payer. The payer taps Approve, opens the vault page, and confirms with Face ID. The vault checks the spend approval and pays once.
6. Go records the booking with the `approval_id` (go-server marks the approval used), records the expense, posts a ticket card, and updates the pay card to paid.

The request is `POST /brain/v1/trips/t_goa/spend-approvals`:

<!-- schema: RequestSpendApproval -->
```json
{
  "request_id": "rq_spend_villa_1",
  "decision_id": "d_villa",
  "amount_minor": 5420000,
  "currency": "INR",
  "merchant": "ixigo: Villa Sol, Anjuna",
  "purpose": "Villa Sol, 3 nights, 6 to 9 Nov",
  "refundable_until": "2026-11-01T18:29:59Z"
}
```

| Field | What it is |
|---|---|
| `decision_id` | The vote this payment is for. |
| `amount_minor`, `currency` | The most this payment may be, more than zero. The vault refuses a checkout above it. |
| `merchant` | Who is paid, as the payer will see it in the vault. |
| `purpose` | What the payment is for, as the payer will see it in the vault. |
| `refundable_until` | When free cancellation ends. Required when the mandate is refundable only. |

#### The approved answer

When every check passes, go-server answers with the spend approval:

<!-- schema: SpendApproved -->
```json
{
  "status": "approved",
  "approval_id": "ap_01JA7Q3V8Z",
  "approval": "eyJhbGciOiJFZERTQSIsInR5cCI6ImdvLXNwZW5kK2p3cyJ9.eyJpc3MiOiJnby1zZXJ2ZXIiLCJhdWQiOiJnby1icmFpbi12YXVsdCIsImp0aSI6ImFwXzAxSkE3UTNWOFoiLCJ0cmlwX2lkIjoidF9nb2EiLCJkZWNpc2lvbl9pZCI6ImRfdmlsbGEiLCJwYXllcl9wZXJzb25faWQiOiJwX3JhaHVsIiwiYW1vdW50X21pbm9yIjo1NDIwMDAwLCJjdXJyZW5jeSI6IklOUiIsIm1lcmNoYW50IjoiaXhpZ286IFZpbGxhIFNvbCwgQW5qdW5hIiwicHVycG9zZSI6IlZpbGxhIFNvbCwgMyBuaWdodHMsIDYgdG8gOSBOb3YiLCJyZWZ1bmRhYmxlX3VudGlsIjoiMjAyNi0xMS0wMVQxODoyOTo1OVoiLCJpYXQiOjE3OTExOTA4MDAsImV4cCI6MTc5MTE5MTQwMH0.uOn0wEqlkBkyNufXJyg3Ot6Kds-8Srk-mouvt-br3IK_k7AxFro7k-Q0WgqocuAtYFEvo4c9L9Az-Yzo7U5KBQ",
  "expires_at": "2026-10-05T09:10:00Z"
}
```

| Field | What it is |
|---|---|
| `approval_id` | The approval's id (the token's `jti`). Go puts it on the pay card and sends it back on `addBooking`. |
| `approval` | The signed token. go-brain hands it to the vault, which checks it before paying. |
| `expires_at` | When the approval stops working: the token's `exp`, at most 10 minutes after it was signed. |

To make the approval, go-server:
1. Makes a new approval id of 8 to 64 characters.
2. Signs these claims with `GO_SPEND_PRIVATE_KEY`: `iss` `"go-server"`, `aud` `"go-brain-vault"`, `jti` (the new approval id), `trip_id`, `decision_id`, `payer_person_id` (always the mandate's payer), `amount_minor`, `currency`, `merchant`, `purpose`, `refundable_until`, `iat` (now, in Unix seconds) and `exp` (at most `iat` plus 600).
3. Stores the approval: its id, the trip, the vote, the payer, the amount and currency, when it expires, and that it is neither used nor cancelled yet.
4. Answers with `approved`.

[Money and the vault](07-money-and-the-vault.md#signing-the-spend-approval) shows the signing code (`signSpendApproval` in TypeScript, `sign_spend_approval` in Python) and what the vault checks. The token above is the one in `packages/contract/test-vectors/spend-approval.json`, so your signing code is right when it produces exactly this token from those claims.

#### The denied answer

When a check fails, go-server answers `200` with the reason, and signs nothing:

<!-- schema: SpendDenied -->
```json
{ "status": "denied", "reason": "over_cap", "detail": "5640000 INR is above the cap of 5500000 INR" }
```

go-server runs the checks in this order and answers with the first one that fails. `detail` is optional plain words for the logs, up to 200 characters.

| `reason` | What it means |
|---|---|
| `decision_not_found` | `decision_id` is not a vote in this trip. |
| `decision_not_closed` | The vote is still open, or it was called off. |
| `no_mandate` | The vote has no mandate. Go has not set one yet, or it is a yes/no vote, which never has one. |
| `payer_declined` | The payer tapped "Not now" and has not tapped "Yes, book it" since. |
| `payer_has_not_confirmed` | The payer has not tapped "Yes, book it" since the mandate was set. |
| `currency_mismatch` | `currency` is not the mandate's currency. |
| `over_cap` | `amount_minor` is more than the mandate's cap. Usually the price went up after the vote. |
| `not_refundable` | The mandate is refundable only, and `refundable_until` is missing or not in the future. |
| `approval_outstanding` | Another spend approval for this vote is not used, not cancelled and not expired. |

| Rule | If it fails |
|---|---|
| The body matches the contract (for example, `amount_minor` is more than zero). | `422 invalid` |

Every other failed check is a `denied` answer, not an error. What Go tells the room for each reason is in [Money and the vault](07-money-and-the-vault.md#what-go-tells-the-room-for-each-reason).

Good to know:
- An approval is not a change to the trip, so this call adds no change number and sends no event.
- A repeat of the same `request_id` gets the same answer, approved or denied, with the same token. After a denial, go-brain uses a new `request_id` when it asks again.
- While one approval for a vote is outstanding, asking again is denied with `approval_outstanding`. That clears when the approval is used, cancelled, or expires (at most 10 minutes later).
- The payer in the token is always the mandate's payer. The request cannot choose who pays.
- An approval is used once. The vault refuses a second payment with the same `jti`, and go-server marks it used when Go records the booking.

### `cancelSpendApproval`: release an approval Go will not use

`cancelSpendApproval` releases a spend approval Go knows it will not use, so it can never be used and the next request for the same vote is not refused as `approval_outstanding`. Go calls it when the payment failed, when the payer tapped Decline on the pay card, when the price changed and Go has to ask the group again, or when the approval expired before the payer approved.

The request is `POST /brain/v1/trips/t_goa/spend-approvals/ap_01JA7Q3V8Z/cancel`. This is what Go would send if the vault's payment to ixigo had failed:

<!-- schema: CancelSpendApproval -->
```json
{ "request_id": "rq_villa_cancel_1", "reason": "payment_failed" }
```

| `reason` | When Go sends it |
|---|---|
| `payment_failed` | The vault tried to pay and the payment did not go through. |
| `payer_declined` | The payer tapped Decline on the pay card. |
| `price_changed` | The price changed before the payer approved, so Go has to check with the group again. |
| `expired` | The approval expired before the payer approved. |
| `other` | Any other reason Go will not use it. |

The answer:

<!-- schema: Ok -->
```json
{ "ok": true }
```

go-server stores the time on the approval (`cancelled_at`). From then on, a booking that names the approval is refused with `409 conflict`, and the spend check no longer counts it as outstanding.

| Rule | If it fails |
|---|---|
| The approval exists in this trip. | `404 not_found` |

Good to know:
- Cancelling is not a change to the trip, so it adds no change number and sends no event.
- Cancelling an approval that is already used, cancelled or expired still answers `{"ok": true}` and changes nothing, so a retry is always safe.
- A cancelled approval can never be used again. go-server refuses a booking that names it, and go-brain's vault refuses it too.

## A minimal go-server

This section shows the smallest go-server that serves two trip API routes correctly: `postMessage` and `openDecision`. Use it as the starting shape for all 16 routes. Each route checks the signature, validates the body with the contract package, does the write once per `request_id`, and in one transaction adds one to the trip's change number, writes the change and writes the event to the outbox. The outbox worker that sends the events is described in [Events](02-events.md).

The examples use Postgres: `pg` in TypeScript and `psycopg` in Python. Any database with transactions and unique indexes works. Besides `brain_requests` from [Doing each write once](#doing-each-write-once), the skeleton needs these tables (a real go-server has more columns):

```sql
create table trips (
  trip_id text primary key,
  seq     bigint not null default 0
);

create table trip_people (
  trip_id   text not null references trips,
  person_id text not null,
  primary key (trip_id, person_id)
);

create table messages (
  message_id text primary key,
  trip_id    text not null references trips,
  seq        bigint not null,
  author     jsonb not null,
  text       text,
  card       jsonb,
  card_id    text,
  reply_to   text,
  mentions   text[] not null default '{}',
  sent_at    timestamptz not null,
  unique (trip_id, card_id)
);

create table decisions (
  decision_id text primary key,
  trip_id     text not null references trips,
  question    text not null,
  kind        text not null,
  anonymous   boolean not null,
  status      text not null,
  options     jsonb not null,
  closes_at   timestamptz,
  opened_at   timestamptz not null
);

create table outbox (
  event_id text primary key,
  trip_id  text not null references trips,
  seq      bigint not null,
  body     jsonb not null,
  sent_at  timestamptz,
  unique (trip_id, seq)
);
```

**TypeScript**

```ts
// server.ts: a minimal go-server with two trip API routes. Run it with: npx tsx server.ts
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type pg from 'pg';
import type { z } from 'zod';
import {
  Event, HTTP_STATUS_FOR, OpenDecision, PostMessage, SIGNATURE_HEADER, verifyRequest, type EventType,
} from '@go/contract';
import { once } from './once.js';

type Code = keyof typeof HTTP_STATUS_FOR;

class ContractError extends Error {
  constructor(readonly code: Code, message: string) {
    super(message);
  }
}

const SECRET = process.env.GO_SIGNING_SECRET!;
const app = Fastify({ logger: true });

// Keep the raw body and check the signature before anything else, as in Basics.
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  (req as { rawBody?: string }).rawBody = body as string;
  try {
    done(null, body === '' ? {} : JSON.parse(body as string));
  } catch {
    done(new ContractError('invalid', 'the body is not JSON'), undefined);
  }
});

app.addHook('preHandler', async (req) => {
  const check = verifyRequest(
    { method: req.method, target: req.url, body: (req as { rawBody?: string }).rawBody ?? '' },
    req.headers[SIGNATURE_HEADER] as string | undefined,
    SECRET,
  );
  if (!check.ok) throw new ContractError('bad_signature', `signature ${check.reason}`);
});

app.setErrorHandler((err, req, reply) => {
  if (err instanceof ContractError) {
    return reply.code(HTTP_STATUS_FOR[err.code]).send({ error: { code: err.code, message: err.message } });
  }
  req.log.error(err);
  return reply.code(500).send({ error: { code: 'internal', message: 'go-server failed, try again' } });
});

/** Checks a body against the contract. A mismatch is 422 invalid, naming the field. */
function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const issue = result.error.issues[0]!;
  throw new ContractError('invalid', `${issue.path.join('.') || 'body'}: ${issue.message}`.slice(0, 500));
}

/** Adds one to the trip's change number. The update also locks the trip's row until commit. */
async function nextSeq(db: pg.PoolClient, tripId: string): Promise<number> {
  const r = await db.query('update trips set seq = seq + 1 where trip_id = $1 returning seq', [tripId]);
  if (r.rows.length === 0) throw new ContractError('not_found', `trip ${tripId} does not exist`);
  return Number(r.rows[0].seq);
}

/** Writes the change's event to the outbox in the same transaction. The outbox worker sends it after commit. */
async function addEvent(db: pg.PoolClient, tripId: string, seq: number, type: EventType, data: object): Promise<void> {
  const event = { event_id: `ev_${randomUUID()}`, trip_id: tripId, seq, occurred_at: new Date().toISOString(), type, data };
  Event.parse(event); // never send an event that breaks the contract
  await db.query('insert into outbox (event_id, trip_id, seq, body) values ($1, $2, $3, $4)', [event.event_id, tripId, seq, event]);
}

async function mustBeInTrip(db: pg.PoolClient, tripId: string, field: string, personIds: string[]): Promise<void> {
  const r = await db.query('select person_id from trip_people where trip_id = $1 and person_id = any($2)', [tripId, personIds]);
  const inTrip = new Set(r.rows.map((row) => row.person_id as string));
  const stranger = personIds.find((id) => !inTrip.has(id));
  if (stranger) throw new ContractError('invalid', `${field}: ${stranger} is not in this trip`);
}

// postMessage: Go says something in the room.
app.post<{ Params: { trip_id: string } }>('/brain/v1/trips/:trip_id/messages', async (req) => {
  const tripId = req.params.trip_id;
  const body = parse(PostMessage, req.body);
  // Store the card exactly as it arrived, so fields added later in version 1 still reach the app.
  const card = (req.body as { card?: { card_id: string } | null }).card ?? null;
  return once(tripId, body.request_id, async (db) => {
    const seq = await nextSeq(db, tripId);
    await mustBeInTrip(db, tripId, 'mentions', body.mentions ?? []);
    if (card) {
      const taken = await db.query('select 1 from messages where trip_id = $1 and card_id = $2', [tripId, card.card_id]);
      if (taken.rows.length > 0) throw new ContractError('conflict', `card ${card.card_id} is already in the room, use PUT`);
    }
    // A full server also checks reply_to and a record card's id here (see the postMessage rules).
    const message = {
      message_id: `m_${randomUUID()}`, seq, author: { kind: 'go' }, text: body.text ?? null, attachments: [],
      reply_to: body.reply_to ?? null, mentions_go: false, mentions: body.mentions ?? [], reactions: [],
      card, withheld: false, deleted: false, sent_at: new Date().toISOString(),
    };
    await db.query(
      `insert into messages (message_id, trip_id, seq, author, text, card, card_id, reply_to, mentions, sent_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [message.message_id, tripId, seq, message.author, message.text, card, card?.card_id ?? null,
        message.reply_to, message.mentions, message.sent_at],
    );
    await addEvent(db, tripId, seq, 'message.created', { message });
    return { message_id: message.message_id, seq };
  });
});

// openDecision: open a vote.
app.post<{ Params: { trip_id: string } }>('/brain/v1/trips/:trip_id/decisions', async (req) => {
  const tripId = req.params.trip_id;
  const body = parse(OpenDecision, req.body);
  return once(tripId, body.request_id, async (db) => {
    const seq = await nextSeq(db, tripId);
    if (body.closes_at && Date.parse(body.closes_at) <= Date.now()) {
      throw new ContractError('invalid', 'closes_at: must be in the future');
    }
    const people = await db.query('select count(*)::int as n from trip_people where trip_id = $1', [tripId]);
    const decision = {
      decision_id: `d_${randomUUID()}`, question: body.question, kind: body.kind, anonymous: body.anonymous,
      status: 'open', options: body.options, closes_at: body.closes_at ?? null, voted: 0, of: people.rows[0].n,
      tally: body.options.map(() => 0), opened_at: new Date().toISOString(),
    };
    await db.query(
      `insert into decisions (decision_id, trip_id, question, kind, anonymous, status, options, closes_at, opened_at)
       values ($1, $2, $3, $4, $5, 'open', $6, $7, $8)`,
      // JSON.stringify, because pg would send a JavaScript array as a Postgres array.
      [decision.decision_id, tripId, body.question, body.kind, body.anonymous, JSON.stringify(body.options),
        decision.closes_at, decision.opened_at],
    );
    await addEvent(db, tripId, seq, 'decision.opened', { decision, by: { kind: 'go' } });
    return { decision_id: decision.decision_id, seq };
  });
});

await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
```

**Python**

```python
# server.py: a minimal go-server with two trip API routes. Run it with: uvicorn server:app
import json
import os
from datetime import datetime, timezone
from typing import TypeVar
from uuid import uuid4

import psycopg
from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from go_contract import SIGNATURE_HEADER, models, verify_request
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ValidationError

from once import once

SECRET = os.environ["GO_SIGNING_SECRET"]
M = TypeVar("M", bound=BaseModel)


class ContractError(Exception):
    def __init__(self, status: int, code: str, message: str):
        self.status, self.code, self.message = status, code, message


async def signed(request: Request) -> bytes:
    """Checks the signature before anything else, as in Basics, and gives the route the raw body."""
    body = await request.body()
    target = request.url.path + (f"?{request.url.query}" if request.url.query else "")
    check = verify_request(request.method, target, body, request.headers.get(SIGNATURE_HEADER), SECRET)
    if not check.ok:
        raise ContractError(401, "bad_signature", f"signature {check.reason}")
    return body


app = FastAPI(dependencies=[Depends(signed)])


@app.exception_handler(ContractError)
async def contract_error(_: Request, exc: ContractError) -> JSONResponse:
    return JSONResponse({"error": {"code": exc.code, "message": exc.message}}, status_code=exc.status)


def parse(model: type[M], raw: bytes) -> M:
    """Checks a body against the contract. A mismatch is 422 invalid, naming the field."""
    try:
        return model.model_validate_json(raw)
    except ValidationError as e:
        first = e.errors()[0]
        where = ".".join(str(p) for p in first["loc"]) or "body"
        raise ContractError(422, "invalid", f"{where}: {first['msg']}"[:500]) from None


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def next_seq(conn: psycopg.Connection, trip_id: str) -> int:
    """Adds one to the trip's change number. The update also locks the trip's row until commit."""
    row = conn.execute("update trips set seq = seq + 1 where trip_id = %s returning seq", (trip_id,)).fetchone()
    if row is None:
        raise ContractError(404, "not_found", f"trip {trip_id} does not exist")
    return row[0]


def add_event(conn: psycopg.Connection, trip_id: str, seq: int, type_: str, data: dict) -> None:
    """Writes the change's event to the outbox in the same transaction. The outbox worker sends it after commit."""
    event = {"event_id": f"ev_{uuid4().hex}", "trip_id": trip_id, "seq": seq, "occurred_at": now(), "type": type_, "data": data}
    models.Event.model_validate(event)  # never send an event that breaks the contract
    conn.execute(
        "insert into outbox (event_id, trip_id, seq, body) values (%s, %s, %s, %s)",
        (event["event_id"], trip_id, seq, Jsonb(event)),
    )


def must_be_in_trip(conn: psycopg.Connection, trip_id: str, field: str, person_ids: list[str]) -> None:
    rows = conn.execute(
        "select person_id from trip_people where trip_id = %s and person_id = any(%s)", (trip_id, person_ids)
    ).fetchall()
    in_trip = {r[0] for r in rows}
    stranger = next((p for p in person_ids if p not in in_trip), None)
    if stranger:
        raise ContractError(422, "invalid", f"{field}: {stranger} is not in this trip")


@app.post("/brain/v1/trips/{trip_id}/messages")
def post_message(trip_id: str, raw: bytes = Depends(signed)) -> dict:
    """postMessage: Go says something in the room."""
    body = parse(models.PostMessage, raw)
    if body.text is None and body.card is None:  # the Python model does not check this rule by itself
        raise ContractError(422, "invalid", "a message needs text, a card, or both")
    # Store the card exactly as it arrived, so fields added later in version 1 still reach the app.
    card = json.loads(raw).get("card")

    def work(conn: psycopg.Connection) -> dict:
        seq = next_seq(conn, trip_id)
        must_be_in_trip(conn, trip_id, "mentions", body.mentions or [])
        if card and conn.execute(
            "select 1 from messages where trip_id = %s and card_id = %s", (trip_id, card["card_id"])
        ).fetchone():
            raise ContractError(409, "conflict", f"card {card['card_id']} is already in the room, use PUT")
        # A full server also checks reply_to and a record card's id here (see the postMessage rules).
        message = {
            "message_id": f"m_{uuid4().hex}", "seq": seq, "author": {"kind": "go"}, "text": body.text,
            "attachments": [], "reply_to": body.reply_to, "mentions_go": False, "mentions": body.mentions or [],
            "reactions": [], "card": card, "withheld": False, "deleted": False, "sent_at": now(),
        }
        conn.execute(
            "insert into messages (message_id, trip_id, seq, author, text, card, card_id, reply_to, mentions, sent_at)"
            " values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (message["message_id"], trip_id, seq, Jsonb(message["author"]), body.text,
             Jsonb(card) if card else None, card["card_id"] if card else None, body.reply_to,
             message["mentions"], message["sent_at"]),
        )
        add_event(conn, trip_id, seq, "message.created", {"message": message})
        return {"message_id": message["message_id"], "seq": seq}

    return once(trip_id, body.request_id, work)


@app.post("/brain/v1/trips/{trip_id}/decisions")
def open_decision(trip_id: str, raw: bytes = Depends(signed)) -> dict:
    """openDecision: open a vote."""
    body = parse(models.OpenDecision, raw)

    def work(conn: psycopg.Connection) -> dict:
        seq = next_seq(conn, trip_id)
        if body.closes_at and body.closes_at <= datetime.now(timezone.utc):
            raise ContractError(422, "invalid", "closes_at: must be in the future")
        (people,) = conn.execute("select count(*) from trip_people where trip_id = %s", (trip_id,)).fetchone()
        options = [o.model_dump(mode="json", exclude_none=True) for o in body.options]
        decision = {
            "decision_id": f"d_{uuid4().hex}", "question": body.question, "kind": body.kind,
            "anonymous": body.anonymous, "status": "open", "options": options,
            "closes_at": body.closes_at.isoformat() if body.closes_at else None,
            "voted": 0, "of": people, "tally": [0] * len(options), "opened_at": now(),
        }
        conn.execute(
            "insert into decisions (decision_id, trip_id, question, kind, anonymous, status, options, closes_at, opened_at)"
            " values (%s, %s, %s, %s, %s, 'open', %s, %s, %s)",
            (decision["decision_id"], trip_id, body.question, body.kind, body.anonymous, Jsonb(options),
             body.closes_at, decision["opened_at"]),
        )
        add_event(conn, trip_id, seq, "decision.opened", {"decision": decision, "by": {"kind": "go"}})
        return {"decision_id": decision["decision_id"], "seq": seq}

    return once(trip_id, body.request_id, work)
```

FastAPI runs a dependency once per request, so `Depends(signed)` in a route gets the same bytes the signature check read.

Good to know:
- Add one to `seq` first in every write. The update locks the trip's row until the transaction commits, so every rule checked after it sees a trip nobody else is changing, and one trip's changes commit in `seq` order.
- If any rule fails, the error rolls back the whole transaction: the change, the new `seq`, the event and the stored answer.
- The other 14 routes have the same shape: parse the body, `once`, add one to `seq`, check the rules, write the change, write the event, answer.
- Send pushes and the live update to the app after the transaction commits, from the committed rows (the outbox is a good place), so a repeated request never pushes twice.
