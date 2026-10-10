# Go's requests

These are the requests Go sends the server over the socket to read the trip or act in it. The server answers each one from its database, which stays the source of truth: the trip lives in the server, and Go never changes it any other way.

Go uses these requests for everything it does in a trip: reading the trip and the room, speaking, showing "Go is typing...", reacting to messages, opening and closing votes, writing the trip record, recording bookings and expenses, and asking for a spend approval. This is the page the server's team builds from. It lists every method, the params it takes, the result it answers with, and the rules the server enforces, with the error to answer when a rule fails. How the socket opens, what a frame looks like, heartbeats and reconnecting are in [The socket](02-the-socket.md). The same methods are listed in `packages/contract/socket/methods.json` and described in `packages/contract/asyncapi/socket.json`.

## The methods

Go sends 18 methods. Every one names its trip with `trip_id`.

| Method | What it does | Result | Event the server then sends |
|---|---|---|---|
| `read_trip` | Reads the whole trip as Go may see it, at its current change number. | `TripSnapshot` | None |
| `read_messages` | Reads the messages posted or changed after a change number, in `updated_seq` order, up to 200 at a time. | `MessagesPage` | None |
| `post_message` | Posts Go's message in the room: text, a card, or both. | `PostMessageResult` | `message.created` |
| `replace_card` | Replaces a card Go posted earlier, in place. | `ReplaceCardResult` | None. Replacing a card is not a change to the trip. |
| `typing` | Shows or hides "Go is typing..." in the room. It is a notification, so the server sends no answer. | None | None |
| `add_reaction` | Adds Go's reaction to a message. | `WriteResult` | `reaction.added` |
| `remove_reaction` | Takes Go's reaction back. | `WriteResult` | `reaction.removed` |
| `update_trip` | Changes the title, destination, dates, vibe, stay or the itinerary. | `WriteResult` | `trip.updated` |
| `open_vote` | Opens a vote. | `OpenDecisionResult` | `decision.opened` |
| `close_vote` | Closes a vote now and returns the result. | `CloseDecisionResult` | `decision.closed` |
| `set_mandate` | Sets what the group allowed for a closed choice vote: the choice, the cap, refundable only, and who pays. | `WriteResult` | `mandate.set` |
| `add_record_line` | Adds an agreed, open or doing line to the trip record. | `AddRecordLineResult` | `record.changed` |
| `update_record_line` | Changes a line Go wrote, or marks it done. | `WriteResult` | `record.changed` |
| `add_booking` | Records a confirmed booking. | `AddBookingResult` | `booking.changed` |
| `update_booking` | Changes or cancels a booking. | `WriteResult` | `booking.changed` |
| `add_expense` | Records something someone paid for, split between people. | `AddExpenseResult` | `expense.changed` |
| `request_spend_approval` | Runs the spend check. Answers with a signed, one-use spend approval for the vault, or the reason why not. | `SpendApproved` or `SpendDenied` | None |
| `cancel_spend_approval` | Releases a spend approval Go will not use, so it can never be used. | `Ok` | None |

Each method's section below names the schema of its params, such as `OpenDecision` for `open_vote`. Every schema is exported by `@go/contract` and by `go_contract.models`, and `go_contract.METHODS` maps each method name to its params and result models.

## A request and its answer

Each request is one JSON-RPC 2.0 text frame with an `id`, the `method` and its `params`. The server answers it once, on the same socket, with a frame that has the same `id` and either a `result` or an `error`. Here Go posts the result of the villa vote:

<!-- schema: SocketRequest -->
```json
{
  "jsonrpc": "2.0",
  "id": "go_2251",
  "method": "post_message",
  "params": {
    "request_id": "rq_7e3b44",
    "trip_id": "t_goa",
    "text": "Villa Sol wins, 4 to 1! @Rahul, you're paying: tap Yes, book it and I'll book it, up to ₹55,000 and free to cancel.",
    "mentions": ["p_rahul"],
    "card": {
      "card_id": "c_villa_mandate",
      "kind": "mandate",
      "decision_id": "d_villa",
      "fallback_text": "Ready to book Villa Sol: up to ₹55,000, refundable only, Rahul pays. Rahul, open Go to say yes."
    }
  }
}
```

The server stores the message and answers with its id and change number:

<!-- schema: SocketResult -->
```json
{ "jsonrpc": "2.0", "id": "go_2251", "result": { "message_id": "m_0158", "seq": 73 } }
```

When a rule fails, the server answers with an error frame instead. Here Go asked to close the dates vote after it had already closed:

<!-- schema: SocketError -->
```json
{
  "jsonrpc": "2.0",
  "id": "go_2258",
  "error": { "code": 409, "message": "decision d_when is already closed", "data": { "code": "conflict" } }
}
```

The rest of this page shows only the `params` and the `result` of each method. `typing` is the only notification on the socket, in either direction: it has no `id`, and the server sends nothing back (see [`typing`](#typing-show-go-is-typing)).

Good to know:
- The server signed the socket once, when it opened it (see [Connecting](02-the-socket.md#connecting)). The frames on it carry no signature.
- Answer every request with the `id` of the frame it came in, even when the same `id` arrives twice.
- Go may send several requests before the first is answered, and the answers may go back in any order. The `id` matches each answer to its request.
- More than one server instance may have a socket open. Go sends each request on one of them, so every instance must be able to answer any request from the shared database.

## Rules for every request

These rules apply to all 18 methods. Each method's own section adds the rules that are particular to it.

| Rule | If it fails |
|---|---|
| The server knows the method. | `-32601` (unknown method). Go skips that request. |
| The params match the contract. The error message names the field. | `422` `invalid` |
| The trip exists. The thing the request acts on (the vote to close, the line or booking to change, the card to replace, the message to react to, the approval to cancel) exists in this trip. | `404` `not_found` |
| Every other id in the params belongs to this trip: a person who is in the trip now, or a message, vote or booking of this trip. The error message names the field. | `422` `invalid` |
| Every amount uses the trip's currency (`money.currency` in the trip). A trip has one currency. | `422` `invalid` |
| The request does not clash with the trip's current state, such as closing a vote that is already closed. | `409` `conflict` |

An error is a `SocketError` frame. `error.code` is the number in the table, `error.data.code` is its name (`not_found`, `invalid`, `conflict`), and `error.message` says what went wrong in plain words, up to 500 characters. The [error table in Basics](01-basics.md#errors) lists every code and whether it is worth sending the request again.

Good to know:
- The server answers every request within 2 seconds. When it cannot, it answers `429` `rate_limited`, `500` `internal` or `503` `unavailable`. With a `429`, put how many seconds Go should wait in `error.data.retry_after_seconds`.
- Go sends a request again after a timeout, a `500` or a `503`, up to three times, after 0.5, 2 and 5 seconds, because someone in the room is waiting. After a `429` it waits `retry_after_seconds` first.
- Ignore fields you do not know, and treat `null` the same as a missing field.
- A person who left the trip is no longer "in the trip" for these rules.
- A method you have not built yet answers `-32601`. Go skips that request, which is also how a method added later in version 1 stays safe. Go cannot work in a room without `read_trip`, `read_messages`, `post_message` and `typing`, so build those first.

## Doing each write once

Every write carries a `request_id` that Go makes, so the server can do the write once even when the request arrives twice. Go makes a new `request_id` for every new write, and sends the same one again only when it sends that same write again. That happens in two ways:

- Go got no answer in time, or an error worth retrying, and sends the write again with the same `request_id`.
- The socket closed before the answer arrived. After the reconnect, Go sends the same request again, with the same JSON-RPC `id` and the same `request_id` (see [When the socket drops](02-the-socket.md#when-the-socket-drops)).

The reads (`read_trip` and `read_messages`), `replace_card` and `typing` have no `request_id`, because doing them twice does no harm.

The server must do three things:

1. Store the `request_id` in the same transaction as the change, with a unique index on `(trip_id, request_id)`, together with the answer it sent.
2. When a `request_id` arrives that it already has, do nothing new and answer with the stored answer, including the same ids and the same `seq`.
3. Look for the `request_id` before running any rule. A repeated `add_booking` must get its first answer back, not a `409` because its spend approval is now used.

The simplest way is one table for every write:

```sql
create table go_requests (
  trip_id    text not null,
  request_id text not null,
  answer     jsonb not null,
  created_at timestamptz not null default now(),
  primary key (trip_id, request_id)
);
```

This helper runs a write in one transaction, stores its answer, and answers a repeat with the first answer. The minimal server at the end of this page uses it.

**TypeScript**

```ts
// once.ts
import pg from 'pg';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const READ = 'select answer from go_requests where trip_id = $1 and request_id = $2';

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
    await db.query('insert into go_requests (trip_id, request_id, answer) values ($1, $2, $3)', [tripId, requestId, answer]);
    await db.query('commit');
    return answer;
  } catch (err) {
    await db.query('rollback');
    // Two copies arrived at the same moment and the other one committed first: answer with its answer.
    if ((err as { code?: unknown }).code === '23505') {
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
from collections.abc import Awaitable, Callable

import psycopg
from psycopg.types.json import Jsonb

DATABASE_URL = os.environ["DATABASE_URL"]
READ = "select answer from go_requests where trip_id = %s and request_id = %s"


async def once(
    trip_id: str, request_id: str, work: Callable[[psycopg.AsyncConnection], Awaitable[dict]]
) -> dict:
    """Does a write once per (trip_id, request_id). A repeat gets the first answer back."""
    try:
        # One transaction: it commits when the block ends and rolls back if anything raises.
        async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
            seen = await (await conn.execute(READ, (trip_id, request_id))).fetchone()
            if seen:
                return seen[0]
            answer = await work(conn)
            await conn.execute(
                "insert into go_requests (trip_id, request_id, answer) values (%s, %s, %s)",
                (trip_id, request_id, Jsonb(answer)),
            )
            return answer
    except psycopg.errors.UniqueViolation:
        # Two copies arrived at the same moment and the other one committed first: answer with its answer.
        async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
            first = await (await conn.execute(READ, (trip_id, request_id))).fetchone()
        if first is None:
            raise
        return first[0]
```

Good to know:
- Only successful answers are stored. A write that was refused rolled back and left nothing behind, so a repeat of it is checked again.
- A denied spend approval is a successful answer (a `result` with `"status": "denied"`), so a repeat gets the same denial. Go uses a new `request_id` when it asks again.
- Two copies can arrive at the same moment, for example when a request sent again after a reconnect reaches a second server instance while the first is still working on it. The second copy waits on the trip's row lock (taken when the change number goes up), then hits the unique index after the first commits. Its change number goes back with the rollback, so no number is skipped.

## What each write answers, and its event

Every write that changes the trip adds one to the trip's change number, answers with that new `seq`, and sends the event for the change with the same `seq`. Go's own writes come back to it as events (`send_event` requests), exactly like the changes people make, so Go sees every change in `seq` order. How the server sends events is in [Events](03-events.md).

| Method | Result | Event the server sends |
|---|---|---|
| `read_trip`, `read_messages` | `TripSnapshot`, `MessagesPage` | None. A read changes nothing. |
| `post_message` | `PostMessageResult` | `message.created` |
| `replace_card` | `ReplaceCardResult` (no `seq`) | None. Replacing a card is not a change. |
| `typing` | No answer (a notification) | None |
| `add_reaction` | `WriteResult` | `reaction.added`, with the reaction's `person_id` null because Go reacted |
| `remove_reaction` | `WriteResult` | `reaction.removed`, with the reaction's `person_id` null |
| `update_trip` | `WriteResult` | `trip.updated`, with `changed` listing the fields sent and `by` Go |
| `open_vote` | `OpenDecisionResult` | `decision.opened`, `by` Go |
| `close_vote` | `CloseDecisionResult` | `decision.closed` with reason `closed_by_go`, then `record.changed` for the decided line, `by` system |
| `set_mandate` | `WriteResult` | `mandate.set` |
| `add_record_line` | `AddRecordLineResult` | `record.changed` with change `added`, `by` Go |
| `update_record_line` | `WriteResult` | `record.changed` with change `done` when `status` becomes `done`, otherwise `updated`, `by` Go |
| `add_booking` | `AddBookingResult` | `booking.changed` with change `added`, `by` Go, then `record.changed` for the booked line, `by` system |
| `update_booking` | `WriteResult` | `booking.changed` with change `cancelled` or `updated`, `by` Go |
| `add_expense` | `AddExpenseResult` | `expense.changed` with change `added`, `by` Go |
| `request_spend_approval` | `SpendApproved` or `SpendDenied` (no `seq`) | None. An approval is not a change anyone sees in the trip. |
| `cancel_spend_approval` | `Ok` (no `seq`) | None |

`by` Go is `{"kind": "go"}` and `by` system is `{"kind": "system"}`. When one request makes two changes (closing a vote and writing its decided line), each change gets its own `seq` and its own event, and the result carries the `seq` of the first.

Every write that changes the trip answers with at least the new change number. This is the result of the `update_trip` request further down:

<!-- schema: WriteResult -->
```json
{ "seq": 52 }
```

## Reading the trip

### `read_trip`: read the whole trip

`read_trip` returns everything about a trip that Go may see, at the trip's current change number. Go sends it when it starts working on a trip it does not hold yet, when it sees a gap in change numbers, after a `trip.updated` event (which names what changed but not the new values), and once a minute for every active trip as a safety net.

The params are a `ReadTrip`, which names the trip:

<!-- schema: ReadTrip -->
```json
{ "trip_id": "t_goa" }
```

The result is the trip snapshot. Here is the Goa trip in the middle of planning, at change 113: the dates vote is closed, the group agreed on North Goa, Villa Sol won the stay vote and is booked and paid by Rahul, Rahul called off a vote about Sunday's beach, Kabir paid for the airport cab, and Meher's birthday dinner is still an idea.

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

What the server leaves out of the snapshot:
- **Budget answers.** `budget` holds only the lowest band anyone picked and how many people answered. Never anyone's own answer, and never who picked what.
- **Contact details.** No phone numbers, emails or UPI ids. `has_upi` says only whether someone has a UPI id saved, so Go can suggest paying them back by UPI.
- **Who voted for what in an anonymous vote.** An anonymous vote has no `votes` list, only `voted`, `of` and `tally`.
- **People who left the trip.** They are not in `people`.

| Rule | If it fails |
|---|---|
| The trip exists. | `404` `not_found` |

Good to know:
- Build the snapshot from one consistent read (one transaction), so `seq` matches the data. A change that commits while you read must be either all in the snapshot or not in it at all.
- `record` holds every line, including done and undone ones, so Go does not write again a line someone undid.
- Messages are not in the snapshot. Go reads them with `read_messages`.
- Go reads every active trip once a minute, so keep this request cheap.
- The fake server that Go (Keshav's team) tests with answers with this snapshot (see [Build and test](10-build-and-test.md)).

### `read_messages`: read the messages posted or changed after a change number

`read_messages` returns every message that was posted or changed after a change number, oldest change first. Go sends it to catch up: when it holds change 46 and the next event it sees is 48, and after a restart. Because it also returns messages that were edited, deleted or reacted to, Go misses nothing when it skips events.

The params are a `ReadMessages`:

<!-- schema: ReadMessages -->
```json
{ "trip_id": "t_goa", "after_seq": 46, "limit": 2 }
```

| Param | Required | What it is |
|---|---|---|
| `trip_id` | Yes | The trip. |
| `after_seq` | Yes | Return messages whose `updated_seq` is greater than this. A whole number, 0 or more. Go sends `0` to read the room from the start. |
| `limit` | No | Return at most this many messages, 1 to 200. Left out, it means up to 200. |

Each message carries two change numbers. `seq` is the change number it got when it was posted. `updated_seq` is the change number of its latest change: posted, edited, deleted, or a reaction added or taken back (Go's reactions included). It equals `seq` until the message changes.

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

How the server fills the page:
- It returns the messages whose `updated_seq` is greater than `after_seq`, sorted by `updated_seq`, each one as it is now. In SQL: `select ... from messages where trip_id = $1 and updated_seq > $2 order by updated_seq limit $3 + 1`, where the one extra row tells you whether there are more.
- Go's own messages are included, and so are Go's reactions, with `person_id` null.
- A message from someone who paused Go is included with `"withheld": true`, no text, no attachments, no `reply_to`, `mentions_go` false, no `mentions` and no `about_message_id`.
- A deleted message is included with `"deleted": true` and no text.
- `has_more` is `true` when more messages changed after the last one in the page. To read them, Go sends `read_messages` again with `after_seq` set to the `updated_seq` of the last message.
- A frame is at most 1 MB. When `limit` messages would make the answer bigger than that (long messages, big cards such as a call transcript), send fewer messages with `has_more` set to `true`.

| Rule | If it fails |
|---|---|
| `after_seq` is given and is a whole number, 0 or more. | `422` `invalid` |
| `limit`, if given, is a whole number from 1 to 200. | `422` `invalid` |

This is how Go reads everything after a change number, one page at a time. `request` sends one request on the socket and resolves with its result:

**TypeScript**

```ts
import { MessagesPage, type Message } from '@go/contract';

type Request = (method: string, params: object) => Promise<unknown>;

/** Reads every message posted or changed after a change number, a page at a time. */
export async function messagesAfter(request: Request, tripId: string, afterSeq: number): Promise<Message[]> {
  const messages: Message[] = [];
  for (let after = afterSeq; ; ) {
    const page = MessagesPage.parse(await request('read_messages', { trip_id: tripId, after_seq: after, limit: 200 }));
    messages.push(...page.messages);
    if (!page.has_more || page.messages.length === 0) return messages;
    after = page.messages[page.messages.length - 1]!.updated_seq;
  }
}
```

**Python**

```python
from collections.abc import Awaitable, Callable

from go_contract import models

Request = Callable[[str, dict], Awaitable[dict]]


async def messages_after(request: Request, trip_id: str, after_seq: int) -> list[models.Message]:
    """Reads every message posted or changed after a change number, a page at a time."""
    messages: list[models.Message] = []
    while True:
        result = await request("read_messages", {"trip_id": trip_id, "after_seq": after_seq, "limit": 200})
        page = models.MessagesPage.model_validate(result)
        messages += page.messages
        if not page.has_more or not page.messages:
            return messages
        after_seq = page.messages[-1].updated_seq
```

Good to know:
- Store `updated_seq` on the message row and index `(trip_id, updated_seq)`. Every edit, delete and reaction (Go's too) sets it to that change's `seq`, in the same transaction.
- Change numbers have gaps between messages, because votes, record lines and bookings use change numbers too.

## Speaking in the room

### `post_message`: post Go's message in the room

`post_message` is how Go says something in the room: a line of text, a card, or both. Go sends it whenever it speaks: when someone mentions Go or replies to it, when work someone asked for is done, when a vote closes or a decision is ready to move, and when something is wrong or at risk.

Here the villa vote has just closed, so Go posts the result with the mandate card and names Rahul, who pays. The params are a `PostMessage` (the whole frame is in [A request and its answer](#a-request-and-its-answer)):

<!-- schema: PostMessage -->
```json
{
  "request_id": "rq_7e3b44",
  "trip_id": "t_goa",
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

The result:

<!-- schema: PostMessageResult -->
```json
{ "message_id": "m_0158", "seq": 73 }
```

| Param | What it is |
|---|---|
| `request_id` | Go's id for this write. See [Doing each write once](#doing-each-write-once). |
| `trip_id` | The trip whose room Go speaks in. |
| `text` | What Go says, 1 to 2,000 characters. |
| `card` | A card, as described in [Cards](06-cards.md). |
| `reply_to` | The message Go is answering, if any. |
| `mentions` | People Go names in the text. Each one gets a push. |
| `visible_to_person_ids` | Contract 1.2: only these people see the message (1 to 30, all in the trip). Leave it out for everyone. See [A message only some people see](#a-message-only-some-people-see-contract-12). |

What the server does:
1. Stores the message with Go as the author (`{"kind": "go"}`), the next change number as both `seq` and `updated_seq`, and the card exactly as it arrived.
2. Sends `message.created` with the whole message.
3. Shows the message in the room over the app's live connection. It appears whole: Go's replies are never streamed.
4. Hides "Go is typing...", because Go's message has landed.
5. Pushes the people in `mentions`, with Go's text. Pushes the people in the card's `for_person_ids`, with the card's `fallback_text`, and pins the card in their "needs you" strip (see [The App](07-the-app.md#the-needs-you-strip)).

| Rule | If it fails |
|---|---|
| The params have text, a card, or both. | `422` `invalid` |
| Every person in `mentions` is in the trip. | `422` `invalid` |
| Every person in `visible_to_person_ids` is in the trip. | `422` `invalid` |
| `reply_to`, if set, is a message in this trip. | `422` `invalid` |
| A record card's id (`decision_id`, `booking_id` or `expense_id`) is in this trip. | `422` `invalid` |
| A mandate card's vote has a mandate. | `409` `conflict` |
| The `card_id` is not already in this trip's room. To change a card, Go sends `replace_card`. | `409` `conflict` |

Good to know:
- Store the card as one JSON value, exactly as it arrived in the frame (`raw.card`, see [A minimal server](#a-minimal-server)), not rebuilt from your own columns or from the checked params. Then a field Go adds to a card later in version 1 reaches the app with no change to the server.
- Send the pushes and the live update once, after the transaction commits, and not again for a repeated `request_id`.
- `mentions_go` is `false` on Go's own messages.
- The server pins an open vote and a mandate waiting for its payer from its own rows, so Go leaves `for_person_ids` out of vote and mandate cards.

#### A message only some people see (contract 1.2)

Some of what Go says is for one person only: a traveller's own flight options, their booking steps, or a note about their own account ("your ixigo money applies here"). Go posts it with `visible_to_person_ids`:

<!-- schema: PostMessage -->
```json
{
  "request_id": "rq_flights_priya_1",
  "trip_id": "t_goa",
  "text": "Your flights from Pune, Priya",
  "visible_to_person_ids": ["p_priya"],
  "card": {
    "card_id": "c_flights_priya",
    "kind": "notice",
    "tone": "info",
    "title": "3 flights from Pune on Fri 6 Nov",
    "body": "IndiGo 6E 2134 from ₹4,890, the cheapest. All three land in Goa before 2 pm.",
    "fallback_text": "3 flights from Pune on Fri 6 Nov",
    "for_person_ids": ["p_priya"]
  }
}
```

- The app shows the message only to those people: in the room, live, in their "needs you" list and on the cards screen. To everyone else it doesn't exist, so nobody else can tap, reply to or react to it.
- It still takes a change number and its `message.created` event. `read_messages` returns it to Go with the field set.
- Visibility is fixed when the message is posted. `replace_card` keeps it.
- A card that should stay visible to the room, with buttons only one person can press, leaves `visible_to_person_ids` out and uses the card's `for_person_ids` and each action's `only_for_person_ids` instead.

### `replace_card`: replace a card in place

`replace_card` replaces a card Go posted earlier with a new version of it, in the same place in the room. Go sends it for a card that changes: a live call, a working task, a pay card that moves to paid. Go also sends it to take people out of `for_person_ids` once they have nothing left to do on the card.

Here Rahul has paid for the villa, so Go moves the pay card to `paid`, removes its buttons, and takes Rahul out of `for_person_ids`. The params are a `ReplaceCard`, holding the whole new card:

<!-- schema: ReplaceCard -->
```json
{
  "trip_id": "t_goa",
  "card": {
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
}
```

The result names the message the card is on:

<!-- schema: ReplaceCardResult -->
```json
{ "message_id": "m_0161" }
```

What the server does:
- Finds Go's message that carries a card with this `card_id`, replaces the card on it, and shows the new version in the room over the app's live connection. The message keeps its place in the room.
- Updates the "needs you" strip: people who are no longer in `for_person_ids` are unpinned, and people newly added are pinned. A replaced card is not a new card, so it sends no push.
- Adds no change number and sends no event. Replacing a card is not a change to the trip.

| Rule | If it fails |
|---|---|
| `card` is a valid card. | `422` `invalid` |
| The `card_id` is on one of Go's messages in this trip. Only Go's own cards can be replaced. | `404` `not_found` |

Good to know:
- There is no `request_id`. Sending the same card twice leaves the same card, so sending it again is safe.
- Go sends the updates for one card one at a time and waits for each answer, so an older version never lands after a newer one.
- Go keeps the card's `kind`. Something new is a new message.
- The `GoSocket` client checks the params before it calls your handler: `parseParams('replace_card', params)` in TypeScript and `METHODS["replace_card"].params.model_validate(params)` in Python. In Python, the checked `card` is the right card class for its `kind`.
- Store the new card as one JSON value, exactly as it arrived in the frame (`raw.card`), as for `post_message`.
- On a record card, only `for_person_ids` and `fallback_text` change what people see, because the server draws the rest from its own rows.

### `typing`: show "Go is typing..."

`typing` shows or hides "Go is typing..." in the room. Go turns it on when it starts working on an answer, and sends it again every 5 seconds while it works. It is a notification: the frame has no `id`, and the server sends nothing back, not even an error.

The whole frame:

<!-- schema: SocketNotification -->
```json
{ "jsonrpc": "2.0", "method": "typing", "params": { "trip_id": "t_goa", "on": true } }
```

The params are a `GoTyping`:

<!-- schema: GoTyping -->
```json
{ "trip_id": "t_goa", "on": true }
```

What the server does:
- `"on": true` shows "Go is typing..." to everyone in the room for up to 10 seconds, or until Go's next message lands, whichever comes first.
- `"on": false` hides it at once.
- Stores nothing, adds no change number and sends no event.

A notification is never answered, so a broken one gets no error frame. The server drops it and logs it instead:

| Rule | If it fails |
|---|---|
| The params match the contract (`trip_id` and `on`). | Dropped and logged. No answer. |
| The trip exists. | Dropped and logged. No answer. |

Good to know:
- There is no `request_id`. Showing the indicator twice does no harm.
- Notifications are best effort and are never sent again after a reconnect. If one is lost, or Go stops sending it (for example, because it restarted), the indicator goes away by itself after 10 seconds.

## Reacting to messages

Go reacts to a message the way a person does, with the author Go. A reaction from Go is a change to the trip like any other: it takes the trip's next change number, and the server sends `reaction.added` or `reaction.removed` with the reaction's `person_id` null. Each author has at most one reaction per emoji on a message, and Go counts as one author.

### `add_reaction`: react to a message

`add_reaction` adds Go's reaction to a message. Go uses it to show it noticed something without saying anything, for example a quiet ✅ on a message after it noted what the message said in the trip record.

Here Go has written the agreed line "North Goa, not South" (change 51) and changed the destination to North Goa (change 52). Instead of announcing the line in the room, it puts a quiet ✅ on Priya's message `m_0122`, where the idea came from. The params are an `AddReaction`:

<!-- schema: AddReaction -->
```json
{ "request_id": "rq_3c71d2", "trip_id": "t_goa", "message_id": "m_0122", "emoji": "✅" }
```

The result is a `WriteResult`:

<!-- schema: WriteResult -->
```json
{ "seq": 53 }
```

The server then sends this event. The reaction's `person_id` is null, because Go reacted:

<!-- schema: ReactionAdded -->
```json
{
  "event_id": "ev_0053",
  "trip_id": "t_goa",
  "seq": 53,
  "occurred_at": "2026-10-05T04:14:40Z",
  "type": "reaction.added",
  "data": {
    "message_id": "m_0122",
    "reaction": { "emoji": "✅", "person_id": null }
  }
}
```

What the server does:
1. Stores the reaction on the message with `person_id` null (Go reacted), and sets the message's `updated_seq` to the new change number.
2. Sends `reaction.added` with the reaction.
3. Shows the reaction in the room over the app's live connection, from Go. It sends no push.

| Rule | If it fails |
|---|---|
| The message exists in this trip. | `404` `not_found` |
| The message is not deleted. | `409` `conflict` |
| Go has not already reacted to this message with this emoji. | `409` `conflict` |

Good to know:
- Go's ✅ and Rahul's ✅ on the same message are two reactions, one per author.
- Go's reaction appears in the message's `reactions`, in `read_messages` and in message events, as `{"emoji": "✅", "person_id": null}`.
- Go never counts its own reaction as anyone agreeing.

### `remove_reaction`: take Go's reaction back

`remove_reaction` removes a reaction Go added earlier. Go uses it when what it noted no longer holds. If the group had switched to South Goa a few minutes later, Go would take its ✅ off Priya's message. The params are a `RemoveReaction`:

<!-- schema: RemoveReaction -->
```json
{ "request_id": "rq_8e20b5", "trip_id": "t_goa", "message_id": "m_0122", "emoji": "✅" }
```

The result is a `WriteResult` with the new change number. The server removes Go's reaction, sets the message's `updated_seq` to the new change number, and sends `reaction.removed` with the reaction `{"emoji": "✅", "person_id": null}`.

| Rule | If it fails |
|---|---|
| The message exists in this trip. | `404` `not_found` |
| Go has a reaction with this emoji on this message. | `409` `conflict` |

Good to know:
- Go removes only its own reactions. People's reactions are theirs, and Go learns about them from `reaction.added` and `reaction.removed`.

## Changing the trip details

### `update_trip`: change the title, destination, dates, vibe, stay or itinerary

`update_trip` changes the trip's details. Go sends it when the group settles one of them, for example when they agree on North Goa, or when Go adds a plan to the itinerary.

The params are an `UpdateTrip`. Only the fields sent change:

<!-- schema: UpdateTrip -->
```json
{
  "request_id": "rq_2d81f0",
  "trip_id": "t_goa",
  "destination": {
    "name": "North Goa",
    "lat": 15.6,
    "lng": 73.75,
    "photo_url": "https://brain.go.example/img/north-goa.jpg"
  }
}
```

The result is a `WriteResult`, here `{"seq": 52}`. The server sends `trip.updated` with `"changed": ["destination"]` and `"by": {"kind": "go"}`.

| Rule | If it fails |
|---|---|
| The params have at least one field besides `request_id` and `trip_id`. (`trip.updated` must name at least one changed field.) | `422` `invalid` |
| `dates.start` is on or before `dates.end`. | `422` `invalid` |
| Every itinerary item's `booking_id`, if set, is a booking in this trip. | `422` `invalid` |

Good to know:
- `itinerary` replaces the whole itinerary. To change one item, Go reads the trip, changes that item and sends every day back.
- The trip's `status` and `budget` are not Go's to change, so they are not in these params. When someone answers the budget question, the server sends `trip.updated` with `"changed": ["budget"]` and `by` system, never the person, so nobody's answer can be traced to them.

## Votes and mandates

### `open_vote`: open a vote

`open_vote` opens a vote. Go sends it when someone asks for a vote, or taps "Put it to a vote" on an options card.

The params are an `OpenDecision`:

<!-- schema: OpenDecision -->
```json
{
  "request_id": "rq_4a6f12",
  "trip_id": "t_goa",
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

The result:

<!-- schema: OpenDecisionResult -->
```json
{ "decision_id": "d_villa", "seq": 64 }
```

Then Go shows the vote in the room with `post_message`:

<!-- schema: PostMessage -->
```json
{
  "request_id": "rq_5c09a1",
  "trip_id": "t_goa",
  "text": "Three villas with a pool in North Goa, all free to cancel. Vote by 6 pm?",
  "card": {
    "card_id": "c_villa_vote",
    "kind": "vote",
    "decision_id": "d_villa",
    "fallback_text": "Vote: Where do we stay? Villa Sol ₹54,200, Casa Azul ₹61,800 or The Palms ₹58,500, for 3 nights. Open Go to vote."
  }
}
```

What the server does:
1. Creates the vote with `status` `open`, no `opened_by_person_id` (Go opened it), `voted` 0, `of` set to the number of people in the trip, and a `tally` of zeros.
2. Sends `decision.opened` with the vote and `"by": {"kind": "go"}`.
3. Does not show the vote in the room yet. Go posts the message with the vote card next.
4. Pins the vote in the "needs you" strip of everyone who has not voted.
5. Closes the vote by itself at `closes_at` (reason `time`) or when everyone has voted (reason `everyone_voted`), and pushes the people who have not voted when the vote is about to close.

| Rule | If it fails |
|---|---|
| The vote has 2 to 10 options. | `422` `invalid` |
| `closes_at`, if set, is in the future. | `422` `invalid` |

Good to know:
- An anonymous vote shows totals only. Nobody sees who voted for what, including Go: `decision.voted` events and the snapshot leave out `person_id`, `option_index` and `votes`.
- `option_ref` is Go's own reference for an option (such as an ixigo offer), so it can book the winner. The server stores it and gives it back unchanged.

### `close_vote`: close a vote now

`close_vote` closes an open vote at once and returns the result. Go sends it when someone asks Go to close a vote. Here Rahul asks Go to close the dates vote with 4 of 5 votes in, because Kabir has only just joined.

The params are a `CloseDecision`:

<!-- schema: CloseDecision -->
```json
{ "request_id": "rq_1f9c30", "trip_id": "t_goa", "decision_id": "d_when" }
```

The result is the vote as it is now:

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

What the server does:
1. Sets `status` to `closed`, `closed_at` to now, and `result_index` to the option with the most votes. When nobody voted, or the top options tied, `result_index` stays empty and no decided line is written: Go asks the group to settle it, usually with a new vote between the tied options.
2. Sends `decision.closed` with reason `closed_by_go`. The result's `seq` is this change.
3. Writes a decided line in the trip record, with the winning option's label as its text ("6 to 9 Nov"), the vote's `decision_id`, and `source` `vote`. This is a second change, with its own `seq` (here 46) and its own `record.changed` event, `by` system.

| Rule | If it fails |
|---|---|
| The vote exists in this trip. | `404` `not_found` |
| The vote is open. Closing a vote that is closed or cancelled is refused. | `409` `conflict` (the error frame in [A request and its answer](#a-request-and-its-answer)) |

Good to know:
- There is no method for Go to call off a vote. People do that in the app, and Go gets `decision.cancelled`.

### `set_mandate`: set what the group allowed

`set_mandate` records what the group allowed for a spend after a choice vote: which option, the cap, whether it must be refundable, and who pays. Go sends it when a vote about something to book closes. Then it posts the result with a mandate card (the example in [`post_message`](#post_message-post-gos-message-in-the-room)), so the payer can say yes.

The params are a `SetMandate`:

<!-- schema: SetMandate -->
```json
{
  "request_id": "rq_6b2d85",
  "trip_id": "t_goa",
  "decision_id": "d_villa",
  "choice_index": 0,
  "cap_minor": 5500000,
  "currency": "INR",
  "refundable_only": true,
  "payer_person_id": "p_rahul"
}
```

The result is a `WriteResult`, here `{"seq": 72}`.

What the server does:
1. Stores the mandate on the vote, with `set_at` set to now.
2. When the vote already had a mandate, replaces it and clears the payer's earlier yes or no (`confirmed_at` and `declined_at`). The payer must answer again.
3. Sends `mandate.set` with the new mandate.
4. Pins the mandate in the payer's "needs you" strip until they answer.

The mandate card's "Yes, book it" and "Not now" buttons belong to the server, because they are part of the spend check. The server shows them to the payer only. When the payer taps one, the server records `confirmed_at` or `declined_at` and sends `mandate.confirmed` or `mandate.declined`.

| Rule | If it fails |
|---|---|
| The vote exists in this trip. | `404` `not_found` |
| The vote is a choice vote. | `409` `conflict` |
| The vote is closed. | `409` `conflict` |
| `choice_index` is one of the vote's options (from 0 to the number of options minus 1). | `422` `invalid` |
| `payer_person_id` is in the trip. | `422` `invalid` |
| `cap_minor` is more than zero. | `422` `invalid` |

Good to know:
- `choice_index` is usually the winning option, but the server does not require it.
- Go replaces a mandate when the group allows something new, for example a higher cap after the price went up.

## The trip record

### `add_record_line`: add a line to the trip record

`add_record_line` adds an agreed, open or doing line to the trip record. Go sends it after it replies in the room, or after a message it only took notes on, when it saves what the room settled without a vote, a question still to settle, or something someone said they will sort. Go does not announce each line in the room. It may put a quiet ✅ on the message instead (see [`add_reaction`](#add_reaction-react-to-a-message)).

| `kind` | When Go writes it | `person_ids` |
|---|---|---|
| `agreed` | The group agreed in the chat without a vote: two people said yes (a thumbs-up reaction counts) or the organizer did, and nobody objected. | Who agreed |
| `open` | A question is still to settle, or an agreement did not meet the bar above. | Who is asked |
| `doing` | Someone said they will sort something. | Who is on it |

Here Priya proposed North Goa, Arjun said yes, Rahul put a 👍 on Priya's message, and nobody objected. The params are an `AddRecordLine`:

<!-- schema: AddRecordLine -->
```json
{
  "request_id": "rq_0e7a59",
  "trip_id": "t_goa",
  "kind": "agreed",
  "text": "North Goa, not South",
  "proof": [
    { "message_id": "m_0122", "person_id": "p_priya" },
    { "message_id": "m_0124", "person_id": "p_arjun" }
  ],
  "person_ids": ["p_priya", "p_arjun", "p_rahul"]
}
```

The result:

<!-- schema: AddRecordLineResult -->
```json
{ "line_id": "r_north", "seq": 51 }
```

The server stores the line with `status` `active` and `source` `go`, and sends `record.changed` with change `added` and `"by": {"kind": "go"}`.

| Rule | If it fails |
|---|---|
| `kind` is `agreed`, `open` or `doing`. Decided and booked lines come only from votes and bookings. | `422` `invalid` |
| An agreed line has at least one proof. | `422` `invalid` |
| Every proof's `message_id` is a message in this trip. | `422` `invalid` |
| Every person id, in `person_ids` and in `proof`, is in the trip. | `422` `invalid` |

Good to know:
- People can undo any line in the app. Go then gets `record.changed` with change `undone`, `by` that person. Go never undoes a line.
- `due_at` is for a line with a deadline, such as an open question that must be settled by the end of the week.

### `update_record_line`: change a line or mark it done

`update_record_line` changes a line Go wrote, or marks it done. Go sends it when an open question gets settled (the line becomes agreed), or when someone finishes what they said they would do. Here Kabir has paid for the airport cab, so Go marks his line done.

The params are an `UpdateRecordLine`. Only the fields sent change:

<!-- schema: UpdateRecordLine -->
```json
{ "request_id": "rq_9d4c17", "trip_id": "t_goa", "line_id": "r_cab", "status": "done" }
```

The result is a `WriteResult`, here `{"seq": 113}`. The server sends `record.changed` with change `done`, because `status` became `done`. Any other change sends change `updated`.

| Rule | If it fails |
|---|---|
| The line exists in this trip. | `404` `not_found` |
| Go wrote the line (`source` is `go`). Decided, booked and people's own lines are not Go's to change. | `409` `conflict` |
| The line is not undone. A line someone undid stays undone. If it comes up again, Go adds a new line. | `409` `conflict` |
| `status`, if sent, is `active` or `done`. Go cannot undo a line. | `422` `invalid` |
| The params have at least one field besides `request_id`, `trip_id` and `line_id`. | `422` `invalid` |
| After the change, an agreed line still has at least one proof. | `422` `invalid` |
| Every proof message and person id is in this trip. | `422` `invalid` |

Good to know:
- `proof` replaces the whole proof list. To add a proof, Go sends the old ones and the new one.

## Bookings and expenses

### `add_booking`: record a confirmed booking

`add_booking` records a booking that is confirmed: a stay, a flight, a table and so on. Go sends it after it books something. When Go paid through the vault, Go sends the spend approval's `approval_id` with it. When someone in the group booked something themselves and shared it, Go records it without one.

Here Rahul approved the payment in the vault, ixigo confirmed the villa, and Go records it. The params are an `AddBooking`:

<!-- schema: AddBooking -->
```json
{
  "request_id": "rq_book_villa_1",
  "trip_id": "t_goa",
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

The result:

<!-- schema: AddBookingResult -->
```json
{ "booking_id": "b_villa", "seq": 76 }
```

What the server does:
1. With an `approval_id`, checks the spend approval (see the rules below) and marks it used, in the same transaction as the booking.
2. Stores the booking with `status` `confirmed` and no `added_by_person_id` (Go added it).
3. Sends `booking.changed` with change `added` and `"by": {"kind": "go"}`. The result's `seq` is this change.
4. Writes the booked line in the trip record, with the booking's title as its text, its `booking_id`, and `source` `booking`. When the booking has a `decision_id` and that vote already has a decided line, the server turns that line into the booked line (same `line_id`) instead of adding a second one. This is a second change, with its own `seq` (here 77) and its own `record.changed` event, `by` system.

After this, Go records the expense with `add_expense`, posts a ticket card, and replaces the pay card with its paid version.

| Rule | If it fails |
|---|---|
| `payer_person_id` and every person in `for_person_ids` are in the trip. | `422` `invalid` |
| `decision_id`, if set, is a vote in this trip. | `422` `invalid` |
| With an `approval_id`: the approval belongs to this trip. | `409` `conflict` |
| With an `approval_id`: it is for the same vote (the booking's `decision_id` is the approval's). | `409` `conflict` |
| With an `approval_id`: the approval has not been used or cancelled. | `409` `conflict` |
| With an `approval_id`: `amount_minor` is no more than the approved amount, in the same currency. | `409` `conflict` |

Good to know:
- The server does not refuse a booking because its approval has expired since. The vault checked the expiry before paying, and recording the booking can come a little later.
- A repeated `request_id` gets the first answer before any rule runs, so a repeat after the approval was marked used still gets `b_villa` back.
- [Money and the vault](08-money-and-the-vault.md#marking-an-approval-used) has the code for these checks.

### `update_booking`: change or cancel a booking

`update_booking` changes a booking or cancels it. Go sends it when a vendor changes a time, a reference or the free cancellation date, and when a booking is cancelled. Here Villa Sol agreed to a 1 pm check-out on the last day.

The params are an `UpdateBooking`. Only the fields sent change:

<!-- schema: UpdateBooking -->
```json
{ "request_id": "rq_b37f08", "trip_id": "t_goa", "booking_id": "b_villa", "ends_at": "2026-11-09T13:00:00+05:30" }
```

The result is a `WriteResult`, here `{"seq": 117}`. The server sends `booking.changed` with change `cancelled` when `status` is `cancelled`, and change `updated` otherwise.

| Rule | If it fails |
|---|---|
| The booking exists in this trip. | `404` `not_found` |
| The booking is not cancelled. A cancelled booking cannot change. | `409` `conflict` |
| The params have at least one field besides `request_id`, `trip_id` and `booking_id`. | `422` `invalid` |

Good to know:
- `"status": "cancelled"` records that the booking is cancelled. It does not cancel anything with the vendor: Go does that first, then sends this request.

### `add_expense`: record something someone paid for

`add_expense` records something someone paid for, split equally between people. Go sends it after every booking Go pays for through the vault, and when someone says in the room that they paid for something.

Here Go records the villa Rahul just paid for, split between all five. The params are an `AddExpense`:

<!-- schema: AddExpense -->
```json
{
  "request_id": "rq_expense_villa_1",
  "trip_id": "t_goa",
  "paid_by_person_id": "p_rahul",
  "amount_minor": 5420000,
  "currency": "INR",
  "note": "Villa Sol, 3 nights",
  "category": "stay",
  "split_person_ids": ["p_rahul", "p_priya", "p_arjun", "p_meher", "p_kabir"],
  "booking_id": "b_villa"
}
```

The result:

<!-- schema: AddExpenseResult -->
```json
{ "expense_id": "e_villa", "seq": 78 }
```

The server stores the expense with no `added_by_person_id` (Go added it), works out the trip's money again (what was spent, by category, and the transfers that square everyone up), and sends `expense.changed` with change `added` and `"by": {"kind": "go"}`.

| Rule | If it fails |
|---|---|
| `paid_by_person_id` and every person in `split_person_ids` are in the trip. | `422` `invalid` |
| `booking_id`, if set, is a booking in this trip. | `422` `invalid` |
| `amount_minor` is more than zero. | `422` `invalid` |

Good to know:
- The server does all the money maths: shares, totals and the fewest transfers. Go reads the result from `money` in the snapshot and never works it out itself.
- People add expenses in the app too, like Kabir's airport cab (`e_cab`). Go gets those as `expense.changed` with `by` that person.
- Go cannot remove an expense. People can, in the app, and Go then gets `expense.changed` with change `removed`.

## Spend approvals

### `request_spend_approval`: ask whether a payment may happen

`request_spend_approval` asks the server whether a payment may happen. The server runs the spend check, and answers with either a signed, one-use spend approval for the vault or the reason it said no. Go sends it after the payer taps "Yes, book it" on the mandate card and Go has checked the price again, just before it asks the payer to approve the payment.

This is where the request sits in a payment:

1. A vote closes. Go sets the mandate and posts a mandate card.
2. The payer taps "Yes, book it". The server sends `mandate.confirmed`.
3. Go checks the price again and sends `request_spend_approval`.
4. The server runs the spend check, signs a spend approval that expires within 10 minutes, and answers.
5. Go posts a pay card for the payer. The payer taps Approve, opens the vault page, and confirms with Face ID. The vault checks the spend approval and pays once.
6. Go records the booking with the `approval_id` (the server marks the approval used), records the expense, posts a ticket card, and replaces the pay card with its paid version.

The params are a `RequestSpendApproval`:

<!-- schema: RequestSpendApproval -->
```json
{
  "request_id": "rq_spend_villa_1",
  "trip_id": "t_goa",
  "decision_id": "d_villa",
  "amount_minor": 5420000,
  "currency": "INR",
  "merchant": "ixigo: Villa Sol, Anjuna",
  "purpose": "Villa Sol, 3 nights, 6 to 9 Nov",
  "refundable_until": "2026-11-01T18:29:59Z"
}
```

| Param | What it is |
|---|---|
| `decision_id` | The vote this payment is for. |
| `amount_minor`, `currency` | The most this payment may be, more than zero. The vault refuses a checkout above it. |
| `merchant` | Who is paid, as the payer will see it in the vault. |
| `purpose` | What the payment is for, as the payer will see it in the vault. |
| `refundable_until` | When free cancellation ends. Required when the mandate is refundable only. |
| `kind`, `for_person_id` | Contract 1.2, a traveller's own ticket: `kind: "ticket"` and the traveller in place of `decision_id`. The traveller is the payer. See [A traveller's own ticket](08-money-and-the-vault.md#a-travellers-own-ticket-contract-12). |

#### The approved result

When every check passes, the server answers with the spend approval:

<!-- schema: SpendApproved -->
```json
{
  "status": "approved",
  "approval_id": "ap_01JA7Q3V8Z",
  "approval": "eyJhbGciOiJFZERTQSIsInR5cCI6ImdvLXNwZW5kK2p3cyJ9.eyJpc3MiOiJzZXJ2ZXIiLCJhdWQiOiJnby12YXVsdCIsImp0aSI6ImFwXzAxSkE3UTNWOFoiLCJ0cmlwX2lkIjoidF9nb2EiLCJkZWNpc2lvbl9pZCI6ImRfdmlsbGEiLCJwYXllcl9wZXJzb25faWQiOiJwX3JhaHVsIiwiYW1vdW50X21pbm9yIjo1NDIwMDAwLCJjdXJyZW5jeSI6IklOUiIsIm1lcmNoYW50IjoiaXhpZ286IFZpbGxhIFNvbCwgQW5qdW5hIiwicHVycG9zZSI6IlZpbGxhIFNvbCwgMyBuaWdodHMsIDYgdG8gOSBOb3YiLCJyZWZ1bmRhYmxlX3VudGlsIjoiMjAyNi0xMS0wMVQxODoyOTo1OVoiLCJpYXQiOjE3OTExOTA4MDAsImV4cCI6MTc5MTE5MTQwMH0.vJiOht3CipQjv-ytsJTJQKlH6ijfrEBs5B9E_yOwNerCZnsMw7NcQIiQv1IiY_ZFRcaVVvpasK1PSpJEKjJgBg",
  "expires_at": "2026-10-05T09:10:00Z"
}
```

| Field | What it is |
|---|---|
| `approval_id` | The approval's id (the token's `jti`). Go puts it on the pay card and sends it back on `add_booking`. |
| `approval` | The signed token. Go hands it to the vault, which checks it before paying. |
| `expires_at` | When the approval stops working: the token's `exp`, at most 10 minutes after it was signed. |

To make the approval, the server:
1. Makes a new approval id of 8 to 64 characters.
2. Signs these claims with `GO_SPEND_PRIVATE_KEY`: `iss` `"server"`, `aud` `"go-vault"`, `jti` (the new approval id), `trip_id`, `decision_id`, `payer_person_id` (always the mandate's payer), `amount_minor`, `currency`, `merchant`, `purpose`, `refundable_until`, `iat` (now, in Unix seconds) and `exp` (at most `iat` plus 600).
3. Stores the approval: its id, the trip, the vote, the payer, the amount and currency, when it expires, and that it is neither used nor cancelled yet.
4. Answers with `approved`.

[Money and the vault](08-money-and-the-vault.md#signing-the-spend-approval) shows the signing code (`signSpendApproval` in TypeScript, `sign_spend_approval` in Python) and what the vault checks. The token above is the one in `packages/contract/test-vectors/spend-approval.json`, so your signing code is right when it produces exactly this token from those claims.

#### The denied result

When a check fails, the server answers with a result, not an error, that gives the reason. It signs nothing:

<!-- schema: SpendDenied -->
```json
{ "status": "denied", "reason": "over_cap", "detail": "5640000 INR is above the cap of 5500000 INR" }
```

The server runs the checks in this order and answers with the first one that fails. `detail` is optional plain words for the logs, up to 200 characters.

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
| The params match the contract (for example, `amount_minor` is more than zero). | `422` `invalid` |

Every other failed check is a `denied` result, not an error. What Go tells the room for each reason is in [Money and the vault](08-money-and-the-vault.md#what-go-tells-the-room-for-each-reason).

Good to know:
- An approval is not a change to the trip, so this request adds no change number and sends no event.
- A repeat of the same `request_id` gets the same result, approved or denied, with the same token. After a denial, Go uses a new `request_id` when it asks again.
- While one approval for a vote is outstanding, asking again is denied with `approval_outstanding`. That clears when the approval is used, cancelled, or expires (at most 10 minutes later).
- The payer in the token is always the mandate's payer. The request cannot choose who pays.
- An approval is used once. The vault refuses a second payment with the same `jti`, and the server marks it used when Go records the booking.

### `cancel_spend_approval`: release an approval Go will not use

`cancel_spend_approval` releases a spend approval Go knows it will not use, so it can never be used and the next request for the same vote is not refused as `approval_outstanding`. Go sends it when the payment failed, when the payer tapped Decline on the pay card, when the price changed and Go has to ask the group again, or when the approval expired before the payer approved.

This is what Go would send if the vault's payment to ixigo had failed. The params are a `CancelSpendApproval`:

<!-- schema: CancelSpendApproval -->
```json
{ "request_id": "rq_villa_cancel_1", "trip_id": "t_goa", "approval_id": "ap_01JA7Q3V8Z", "reason": "payment_failed" }
```

| `reason` | When Go sends it |
|---|---|
| `payment_failed` | The vault tried to pay and the payment did not go through. |
| `payer_declined` | The payer tapped Decline on the pay card. |
| `price_changed` | The price changed before the payer approved, so Go has to check with the group again. |
| `expired` | The approval expired before the payer approved. |
| `other` | Any other reason Go will not use it. |

The result:

<!-- schema: Ok -->
```json
{ "ok": true }
```

The server stores the time on the approval (`cancelled_at`). From then on, a booking that names the approval is refused with `409` `conflict`, and the spend check no longer counts it as outstanding.

| Rule | If it fails |
|---|---|
| The approval exists in this trip. | `404` `not_found` |

Good to know:
- Cancelling is not a change to the trip, so it adds no change number and sends no event.
- Cancelling an approval that is already used, cancelled or expired still answers `{"ok": true}` and changes nothing, so sending it again is always safe.
- A cancelled approval can never be used again. The server refuses a booking that names it, and Go's vault refuses it too.

## A minimal server

This section shows the smallest server that answers two of Go's requests correctly: `post_message` and `open_vote`. Use it as the starting shape for all of them. It plugs into the `GoSocket` client from [The socket](02-the-socket.md#a-complete-client-for-the-server), which the server keeps connected to Go. You give the client a `handlers` table that maps each of Go's methods to a function.

For every request frame, the client does the same four things:

1. Finds the method's handler. A method with no handler is answered `-32601`.
2. Checks the params against the method in the contract, with `parseParams(method, params)` in TypeScript or `METHODS[method].params.model_validate(params)` in Python. When they do not match, it answers `422` `invalid` itself and never calls the handler.
3. Calls the handler with two arguments: `params`, the checked params (in Python, the pydantic model), and `raw`, the frame's params exactly as they arrived. It writes what the handler returns as the `result` of the answer frame, with the request's `id`.
4. Writes an error frame when the handler throws a `SocketCallError`, with its number in `error.code` and its name in `error.data.code`. Anything else that goes wrong is answered `500` `internal`.

Read and check everything through `params`. Use `raw` only to store a card exactly as Go sent it, because the check drops fields your copy of the contract does not know yet.

Each handler below runs its rules, does the write once per `request_id`, and in one transaction adds one to the trip's change number, writes the change and writes the event to the outbox. The sender that sends those events to Go as `send_event` requests is in [Events](03-events.md).

The examples use Postgres: `pg` in TypeScript and `psycopg` in Python. Any database with transactions and unique indexes works. Besides `go_requests` from [Doing each write once](#doing-each-write-once) and the `outbox` table from [Events](03-events.md), the skeleton needs these tables (a real server has more columns):

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
  message_id  text primary key,
  trip_id     text not null references trips,
  seq         bigint not null,
  updated_seq bigint not null,
  author      jsonb not null,
  text        text,
  card        jsonb,
  card_id     text,
  reply_to    text,
  mentions    text[] not null default '{}',
  sent_at     timestamptz not null,
  unique (trip_id, card_id)
);
create index messages_changes on messages (trip_id, updated_seq);

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
```

**TypeScript**

```ts
// go.ts: the one socket the server keeps open to Go, answering two of Go's requests.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { z } from 'zod';
import { Event, SOCKET_ERROR_CODES, SOCKET_PATH, type EventType, type OpenDecision, type PostMessage } from '@go/contract';
import { GoSocket, SocketCallError } from './go-socket.js';
import { once } from './once.js';

type Code = 'not_found' | 'invalid' | 'conflict';

/** The error Go gets: the number goes in error.code and the name in error.data.code. */
const fail = (code: Code, message: string) => new SocketCallError(SOCKET_ERROR_CODES[code], message.slice(0, 500), code);

/** Adds one to the trip's change number. The update also locks the trip's row until commit. */
async function nextSeq(db: pg.PoolClient, tripId: string): Promise<number> {
  const r = await db.query('update trips set seq = seq + 1 where trip_id = $1 returning seq', [tripId]);
  if (r.rows.length === 0) throw fail('not_found', `trip ${tripId} does not exist`);
  return Number(r.rows[0].seq);
}

/** Writes the change's event to the outbox in the same transaction. The sender sends it after commit. */
async function addEvent(db: pg.PoolClient, tripId: string, seq: number, type: EventType, data: object): Promise<void> {
  const event = { event_id: `ev_${randomUUID()}`, trip_id: tripId, seq, occurred_at: new Date().toISOString(), type, data };
  Event.parse(event); // never send an event that breaks the contract
  await db.query('insert into outbox (event_id, trip_id, seq, body) values ($1, $2, $3, $4)', [event.event_id, tripId, seq, event]);
}

async function mustBeInTrip(db: pg.PoolClient, tripId: string, field: string, personIds: string[]): Promise<void> {
  const r = await db.query('select person_id from trip_people where trip_id = $1 and person_id = any($2)', [tripId, personIds]);
  const inTrip = new Set(r.rows.map((row) => row.person_id as string));
  const stranger = personIds.find((id) => !inTrip.has(id));
  if (stranger) throw fail('invalid', `${field}: ${stranger} is not in this trip`);
}

// post_message: Go says something in the room. The client has already checked p against PostMessage.
async function postMessage(p: z.infer<typeof PostMessage>, raw: Record<string, unknown>) {
  // Store the card exactly as Go sent it, so a card field added later in version 1 reaches the app.
  const card = (raw.card ?? null) as { card_id: string } | null;
  return once(p.trip_id, p.request_id, async (db) => {
    const seq = await nextSeq(db, p.trip_id);
    await mustBeInTrip(db, p.trip_id, 'mentions', p.mentions ?? []);
    if (card) {
      const taken = await db.query('select 1 from messages where trip_id = $1 and card_id = $2', [p.trip_id, card.card_id]);
      if (taken.rows.length > 0) throw fail('conflict', `card ${card.card_id} is already in the room, use replace_card`);
    }
    // A full server also checks reply_to and a record card's id here (see the post_message rules).
    const message = {
      message_id: `m_${randomUUID()}`, seq, updated_seq: seq, author: { kind: 'go' }, text: p.text ?? null,
      attachments: [], reply_to: p.reply_to ?? null, mentions_go: false, mentions: p.mentions ?? [], reactions: [],
      card, withheld: false, deleted: false, sent_at: new Date().toISOString(),
    };
    await db.query(
      `insert into messages (message_id, trip_id, seq, updated_seq, author, text, card, card_id, reply_to, mentions, sent_at)
       values ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [message.message_id, p.trip_id, seq, message.author, message.text, card, card?.card_id ?? null,
        message.reply_to, message.mentions, message.sent_at],
    );
    await addEvent(db, p.trip_id, seq, 'message.created', { message });
    return { message_id: message.message_id, seq };
  });
}

// open_vote: open a vote. The client has already checked p against OpenDecision. It needs nothing from raw.
async function openVote(p: z.infer<typeof OpenDecision>) {
  return once(p.trip_id, p.request_id, async (db) => {
    const seq = await nextSeq(db, p.trip_id);
    if (p.closes_at && Date.parse(p.closes_at) <= Date.now()) throw fail('invalid', 'closes_at: must be in the future');
    const people = await db.query('select count(*)::int as n from trip_people where trip_id = $1', [p.trip_id]);
    const decision = {
      decision_id: `d_${randomUUID()}`, question: p.question, kind: p.kind, anonymous: p.anonymous,
      status: 'open', options: p.options, closes_at: p.closes_at ?? null, voted: 0, of: people.rows[0].n,
      tally: p.options.map(() => 0), opened_at: new Date().toISOString(),
    };
    await db.query(
      `insert into decisions (decision_id, trip_id, question, kind, anonymous, status, options, closes_at, opened_at)
       values ($1, $2, $3, $4, $5, 'open', $6, $7, $8)`,
      // JSON.stringify, because pg would send a JavaScript array as a Postgres array.
      [decision.decision_id, p.trip_id, p.question, p.kind, p.anonymous, JSON.stringify(p.options),
        decision.closes_at, decision.opened_at],
    );
    await addEvent(db, p.trip_id, seq, 'decision.opened', { decision, by: { kind: 'go' } });
    return { decision_id: decision.decision_id, seq };
  });
}

export const go = new GoSocket({
  url: process.env.GO_URL!.replace(/^http/, 'ws') + SOCKET_PATH, // wss://brain.go.example/v1/socket
  secret: process.env.GO_SIGNING_SECRET!,
  handlers: { post_message: postMessage, open_vote: openVote },
});
go.start();
```

**Python**

```python
# go.py: the one socket the server keeps open to Go, answering two of Go's requests.
import os
from datetime import datetime, timezone
from uuid import uuid4

import psycopg
from go_contract import models
from psycopg.types.json import Jsonb

from go_socket import GoSocket, SocketCallError
from once import once

CODES = {"not_found": 404, "invalid": 422, "conflict": 409}


def fail(code: str, message: str) -> SocketCallError:
    """The error Go gets: the number goes in error.code and the name in error.data.code."""
    return SocketCallError(CODES[code], message[:500], code)


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


async def next_seq(conn: psycopg.AsyncConnection, trip_id: str) -> int:
    """Adds one to the trip's change number. The update also locks the trip's row until commit."""
    cur = await conn.execute("update trips set seq = seq + 1 where trip_id = %s returning seq", (trip_id,))
    row = await cur.fetchone()
    if row is None:
        raise fail("not_found", f"trip {trip_id} does not exist")
    return row[0]


async def add_event(conn: psycopg.AsyncConnection, trip_id: str, seq: int, type_: str, data: dict) -> None:
    """Writes the change's event to the outbox in the same transaction. The sender sends it after commit."""
    event = {"event_id": f"ev_{uuid4().hex}", "trip_id": trip_id, "seq": seq, "occurred_at": now(), "type": type_, "data": data}
    models.Event.model_validate(event)  # never send an event that breaks the contract
    await conn.execute(
        "insert into outbox (event_id, trip_id, seq, body) values (%s, %s, %s, %s)",
        (event["event_id"], trip_id, seq, Jsonb(event)),
    )


async def must_be_in_trip(conn: psycopg.AsyncConnection, trip_id: str, field: str, person_ids: list[str]) -> None:
    cur = await conn.execute(
        "select person_id from trip_people where trip_id = %s and person_id = any(%s)", (trip_id, person_ids)
    )
    in_trip = {r[0] for r in await cur.fetchall()}
    stranger = next((p for p in person_ids if p not in in_trip), None)
    if stranger:
        raise fail("invalid", f"{field}: {stranger} is not in this trip")


async def post_message(p: models.PostMessage, raw: dict) -> dict:
    """post_message: Go says something in the room. The client has already checked p."""
    if p.text is None and p.card is None:  # the Python model does not check this rule by itself
        raise fail("invalid", "a message needs text, a card, or both")
    # Store the card exactly as Go sent it, so a card field added later in version 1 reaches the app.
    card = raw.get("card")

    async def work(conn: psycopg.AsyncConnection) -> dict:
        seq = await next_seq(conn, p.trip_id)
        await must_be_in_trip(conn, p.trip_id, "mentions", p.mentions or [])
        if card:
            cur = await conn.execute(
                "select 1 from messages where trip_id = %s and card_id = %s", (p.trip_id, card["card_id"])
            )
            if await cur.fetchone():
                raise fail("conflict", f"card {card['card_id']} is already in the room, use replace_card")
        # A full server also checks reply_to and a record card's id here (see the post_message rules).
        message = {
            "message_id": f"m_{uuid4().hex}", "seq": seq, "updated_seq": seq, "author": {"kind": "go"},
            "text": p.text, "attachments": [], "reply_to": p.reply_to, "mentions_go": False,
            "mentions": p.mentions or [], "reactions": [], "card": card, "withheld": False, "deleted": False,
            "sent_at": now(),
        }
        await conn.execute(
            "insert into messages (message_id, trip_id, seq, updated_seq, author, text, card, card_id, reply_to,"
            " mentions, sent_at) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (message["message_id"], p.trip_id, seq, seq, Jsonb(message["author"]), p.text,
             Jsonb(card) if card else None, card["card_id"] if card else None, p.reply_to,
             message["mentions"], message["sent_at"]),
        )
        await add_event(conn, p.trip_id, seq, "message.created", {"message": message})
        return {"message_id": message["message_id"], "seq": seq}

    return await once(p.trip_id, p.request_id, work)


async def open_vote(p: models.OpenDecision, raw: dict) -> dict:
    """open_vote: open a vote. The client has already checked p. It needs nothing from raw."""

    async def work(conn: psycopg.AsyncConnection) -> dict:
        seq = await next_seq(conn, p.trip_id)
        if p.closes_at and p.closes_at <= datetime.now(timezone.utc):
            raise fail("invalid", "closes_at: must be in the future")
        cur = await conn.execute("select count(*) from trip_people where trip_id = %s", (p.trip_id,))
        (people,) = await cur.fetchone()
        options = [o.model_dump(mode="json", exclude_none=True) for o in p.options]
        decision = {
            "decision_id": f"d_{uuid4().hex}", "question": p.question, "kind": p.kind,
            "anonymous": p.anonymous, "status": "open", "options": options,
            "closes_at": p.closes_at.isoformat() if p.closes_at else None,
            "voted": 0, "of": people, "tally": [0] * len(options), "opened_at": now(),
        }
        await conn.execute(
            "insert into decisions (decision_id, trip_id, question, kind, anonymous, status, options, closes_at,"
            " opened_at) values (%s, %s, %s, %s, %s, 'open', %s, %s, %s)",
            (decision["decision_id"], p.trip_id, p.question, p.kind, p.anonymous, Jsonb(options),
             p.closes_at, decision["opened_at"]),
        )
        await add_event(conn, p.trip_id, seq, "decision.opened", {"decision": decision, "by": {"kind": "go"}})
        return {"decision_id": decision["decision_id"], "seq": seq}

    return await once(p.trip_id, p.request_id, work)


go = GoSocket(
    os.environ["GO_URL"].replace("http", "ws", 1) + "/v1/socket",  # wss://brain.go.example/v1/socket
    os.environ["GO_SIGNING_SECRET"],
    {"post_message": post_message, "open_vote": open_vote},
)

# At startup: asyncio.create_task(go.run())
```

For the `post_message` request in [A request and its answer](#a-request-and-its-answer), the client calls `post_message` with the checked params and the raw params, and writes back `{"jsonrpc": "2.0", "id": "go_2251", "result": {"message_id": "m_0158", "seq": 73}}`. When a handler throws `fail('conflict', ...)`, the client writes the error frame instead, with `"code": 409` and `"data": {"code": "conflict"}`. When the same request arrives again after a reconnect, `once` returns the first answer and the client sends it with the repeated `id`.

Good to know:
- Add one to `seq` first in every write. The update locks the trip's row until the transaction commits, so every rule checked after it sees a trip nobody else is changing, and one trip's changes commit in `seq` order.
- If any rule fails, the error rolls back the whole transaction: the change, the new `seq`, the event and the stored answer.
- The other writes have the same shape: run the rules, `once`, add one to `seq`, write the change, write the event, return the result. The two reads need no `once` and no change number. The `typing` handler shows or hides the indicator and returns nothing, because a notification gets no answer.
- The card is stored from `raw.card`, exactly as Go sent it, because the checked `params` leave out any field your copy of the contract does not know yet. A card field Go adds later in version 1 then reaches the app with no server update. Everything else, including every rule, reads `params`.
- Send pushes and the live update to the app after the transaction commits, from the committed rows (the outbox is a good place), so a repeated request never pushes twice.
- Keep the handlers quick. Go waits at most 2 seconds for each answer, and someone in the room is usually waiting too.
