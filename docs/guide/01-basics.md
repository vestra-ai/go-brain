# Basics

This page covers the rules that every frame between the server and Go follows: the settings each side needs, how ids, money and time are written, how each request is done only once, what errors look like, how long to wait for an answer, and when to send a request again. Read it before you write the first line of either server. [The socket](02-the-socket.md) builds on it.

## Addresses and secrets

The server needs Go's address and the signing secret, so it can open the socket. Go needs only the signing secret, to check the socket's signature. The server also holds the private key it signs spend approvals with, and Go holds the matching public key.

| Setting | Server | Go | What it is |
|---|---|---|---|
| `GO_URL` | yes | | Go's base URL, such as `https://brain.go.example`, with no path and no trailing slash. The socket is at the same host: `wss://brain.go.example/v1/socket`. |
| `GO_SIGNING_SECRET` | yes | yes | The shared secret for the signature that opens the socket. 32 random bytes as hex. |
| `GO_SPEND_PRIVATE_KEY` | yes | | The server's Ed25519 private key (PEM), for signing spend approvals |
| `GO_SPEND_PUBLIC_KEY` | | yes | The matching public key (PEM), for checking them |

Go has no setting for the server's address, because it never calls the server. Everything Go asks the server travels on the socket that the server opened.

Make the secret and the key pair like this:

```bash
openssl rand -hex 32                                   # GO_SIGNING_SECRET
openssl genpkey -algorithm ed25519 -out go-spend.pem   # GO_SPEND_PRIVATE_KEY
openssl pkey -in go-spend.pem -pubout                  # GO_SPEND_PUBLIC_KEY
```

Good to know:
- Put secrets only in each platform's environment variables. Never put them in the repo, a chat, a doc or a screenshot. Share them once, through a one-time link.
- This week there is one shared environment (staging) plus your own machine. Each environment has its own secret and key pair.

## Signing

The server signs one request: the WebSocket upgrade that opens the socket (`GET /v1/socket`). It puts an `x-go-signature` header on it, made with `GO_SIGNING_SECRET` from the time, the method, the path and the (empty) body, and Go refuses the upgrade with `401` if the header is wrong or has been used before (Go accepts each signature once). Frames on the open socket are not signed one by one, because the socket itself was opened with the signature. [The socket](02-the-socket.md#connecting) shows how to make the header, with code, and [Proving your signing code](02-the-socket.md#proving-your-signing-code) has the test vectors. Spend approvals carry a signature of their own, made with the Ed25519 key, as [Money and the vault](08-money-and-the-vault.md) explains.

## Ids

Ids are opaque strings of 1 to 64 characters. Do not parse them or guess their format. The `t_`, `p_` and `m_` prefixes in this guide are only there to make examples readable.

| Who makes the id | Ids |
|---|---|
| Server | `trip_id`, `person_id`, `message_id`, `decision_id`, `booking_id`, `expense_id`, `line_id`, `event_id`, `approval_id`, `tap_id`, and the JSON-RPC `id` of every request the server sends |
| Go | `card_id`, `task_id`, `call_id`, `option_id`, `fact_id`, `request_id`, and the JSON-RPC `id` of every request Go sends |

`person_id` is the same person in every trip they join. Go uses it to remember someone between trips, but only if they turn that on.

## Money

Money is always a whole number in the smallest unit of the currency, with the currency next to it. For rupees the unit is paise, so ₹54,200 is `5420000`. Never send a float. Fields that hold money end in `_minor`.

```json
{ "amount_minor": 5420000, "currency": "INR" }
```

## Time

Times are ISO 8601 with an offset, such as `2026-11-06T18:10:00+05:30` or `2026-11-06T12:40:00Z`. Send UTC with a `Z` when you can. Dates without a time are `YYYY-MM-DD`. A time of day in the itinerary is `HH:MM`, local to the destination.

## JSON rules

- Field names are `snake_case`.
- **Null and missing mean the same thing.** Any field that can be empty may be left out or sent as `null`. Python code can always use `model_dump(mode="json", exclude_none=True)`.
- **Ignore fields you do not know.** Either side may add a field at any time within version 1, in params, results and frames alike.
- **Skip event types and card kinds you do not know.** Go accepts an event type it does not know (`{ "accepted": true, "duplicate": false }`) and skips it, and the app shows a card kind it does not know as its `fallback_text`.
- **Answer a method you do not know with `-32601`.** The sender then skips it (see [Errors](#errors)).

The Python models check the shape of every value and most of its limits. A few limits are checked only by the TypeScript contract: lengths and link rules on fields that may be empty, and a message needing text or a card. Go checks all of them on everything it sends and receives.

## Doing things once

A request can arrive twice: the socket may drop before the answer comes back, and the sender then sends it again. Requests that change something carry their own id, so the receiver does each one once.

- **`event_id`** on every event. Go remembers the ones it has seen and answers a repeat with `{ "accepted": true, "duplicate": true }` without doing anything.
- **`request_id`** on every write Go sends to the server (a message, a reaction, a vote, a booking...). The server must store it with the row it creates, with a unique index on `(trip_id, request_id)`. When the same `request_id` arrives again, the server does nothing new and answers with the first answer, including the same ids. [Go's requests](04-gos-requests.md) shows how.
- **`tap_id`** on every card tap. The server makes one for each tap. Go acts on each `tap_id` once, so a resend or a double tap does not pick an option or start a payment twice.
- **The JSON-RPC `id`** on every request frame. It matches an answer to its request. When the socket drops before the answer arrives, the sender sends the same request again after reconnecting, with the same `id` and the same `event_id`, `request_id` or `tap_id`.

The JSON-RPC `id` alone does not make a request happen once. The `event_id`, `request_id` and `tap_id` do. After a restart, for example, the server's outbox sends an event again in a new frame with a new `id`, and Go still recognises the `event_id`. The requests that carry none of these ids only read (such as `read_trip` or `get_person`) or are safe to repeat (such as `replace_card` with the same card, or `forget_person`), so doing them twice is harmless.

## Errors

A request that did not work is answered with an error frame instead of a result. It has the request's `id`, a numeric `error.code`, a `message` that says what went wrong (at most 500 characters), and the code's name in `error.data.code`:

<!-- schema: SocketError -->
```json
{
  "jsonrpc": "2.0",
  "id": "go_2214",
  "error": { "code": 409, "message": "decision d_villa is already closed", "data": { "code": "conflict" } }
}
```

The codes are the HTTP statuses everyone knows, plus two from JSON-RPC:

| `error.code` | `error.data.code` | What it means | Send it again? |
|---|---|---|---|
| `404` | `not_found` | The trip, person, card or other id does not exist | No |
| `409` | `conflict` | The request clashes with the current state, such as closing a vote that is already closed | No. Read the trip and decide again. |
| `422` | `invalid` | The params do not match the contract. The message says which field. | No, not with the same params |
| `429` | `rate_limited` | Too many requests. `error.data.retry_after_seconds` says how long to wait. | Yes, after that wait |
| `500` | `internal` | A bug on the other side | Yes |
| `503` | `unavailable` | Down for a moment, usually a deploy | Yes |
| `-32700` | none | The frame could not be read. The error's `id` is `null`, because the request's `id` could not be read either. | No. Fix the sender. |
| `-32601` | none | The receiver does not know this method | No. Skip what you wanted to do: the other side does not support it yet. |

No answer within the time limit counts as "send it again", and so does a socket that closed before the answer came.

A wrong signature is not an error frame. Go refuses the upgrade with HTTP `401` and an `ErrorBody` with the code `bad_signature`, and the socket does not open. Check the secret and the clock, and make a new signature for every connect.

## Time limits and retries

Each side answers quickly, so the other is never stuck waiting. A notification gets no answer, so it has no time limit.

| Method | Answer within |
|---|---|
| `send_event` | 2 seconds (Go stores the event, answers, and does the work afterwards) |
| `card_tap` and `catch_up` | 3 seconds |
| Every other request the server sends | 2 seconds |
| Every request Go sends | 2 seconds |

`packages/contract/socket/methods.json` has the time limit of every method, and `METHODS[name].answer_within_seconds` (Python) and `methodByName(name).answer_within` (TypeScript) have it in code.

When a request fails with something worth sending again:

- **When the server sends events,** it waits 1 second, 5 seconds, 30 seconds, 2 minutes and 10 minutes, then every 10 minutes, and gives up after 24 hours. It keeps the events of one trip in order (see [Events](03-events.md)).
- **The server's other requests** (card taps, catch-up, people pages, forget me, vault links) are not sent again on their own. A person is waiting, so show them that it did not work and let them try again.
- **Go's requests** are sent again 3 times, after 0.5, 2 and 5 seconds, with the same `request_id`, because someone in the room is waiting. After that, Go tells the room it could not finish and tries again later.

When the socket itself drops:

- **The server reconnects** after 1, 2, 5 and 10 seconds, then every 30 seconds, until it is back. After a connect that works, the next wait starts from 1 second again.
- **Unanswered requests go again.** After reconnecting, each side sends every request that had no answer when the socket closed, with the same JSON-RPC `id` and the same `event_id` or `request_id`. Notifications are not sent again.

[The socket](02-the-socket.md#when-the-socket-drops) explains what happens in each case.

## Versions

This is contract version `1.2.0` ([what 1.1 added](11-contract-1-1.md); 1.2 adds a traveller's own ticket approval, `not_in_trip` and `already_booked` ([Money](08-money-and-the-vault.md)), and `visible_to_person_ids` ([Go's requests](04-gos-requests.md))). Go's paths start with `/v1`: the socket is `/v1/socket`, and `GET /v1/health` answers with the version Go speaks. Within version 1, things are only added (fields, event types, card kinds, methods), never renamed or removed, and an unknown method is answered with `-32601`. A breaking change would mean a `/v2/socket`, running next to `/v1/socket` until both sides have moved.
