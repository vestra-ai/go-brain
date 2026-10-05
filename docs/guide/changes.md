# What changed

This page lists what changed in the contract and why. There were two sets of changes on 5 October: the first turned the draft (version 0.1, 4 October) into version 1.0.0, and the second moved everything between the two servers onto one socket that go-brain exposes. Read it if you saw an earlier version. Otherwise, the rest of the guide is all you need. Nobody had built against either earlier version yet, so nothing needs migrating.

## The second set of changes, 5 October

The contract is now the brain's contract. go-brain (Go itself) exposes it, and go-server and the app build on it. In the founder's words: "we will expose our brain contract to the world ... first for our own understanding on what to build, second for Nishanth and team to build server and db".

### Why

- **The contract is go-brain's to expose.** go-brain is the part that stays the same whoever builds on it, so it should define what it accepts and what it asks for. go-server connects to it, like any client of a service.
- **The old routes confused people.** The first version had go-server serve `/brain/v1/trips/...` routes for go-brain to call. Readers took that to mean the trip came from go-brain. It never did: the trip lives in go-server's database, and it still does.

### What changed

- **One socket for everything.** go-server opens one WebSocket to `wss://brain.go.example/v1/socket` and keeps it open. Everything between the two servers travels on it, in both directions, as JSON-RPC 2.0 frames. See [The socket](02-the-socket.md).
- **go-server serves no routes for go-brain.** The `/brain/v1` routes are gone, and so is `GO_SERVER_URL`: go-brain never calls go-server over HTTP. Go reads the trip by sending `read_trip` on the socket, and go-server answers from its database.
- **go-brain's HTTP routes are down to two:** `GET /v1/health` (not signed) and `GET /v1/socket`, the signed upgrade that opens the socket. The old `/v1/events`, card action, catch-up, people and link routes are now methods on the socket.
- **Signing is used only to open the socket.** The `x-go-signature` format is unchanged (method, target and body), and so are the spend approval tokens. Frames on the open socket are not signed one by one.
- **Errors are error frames.** A failed request is answered with a `SocketError` frame: the HTTP status as `error.code` (`404`, `409`, `422`, `429`, `500`, `503`), its name in `error.data.code`, plus JSON-RPC's `-32700` (a frame that cannot be read) and `-32601` (an unknown method). `ErrorBody` is no longer used between the servers.
- **New methods are safe within version 1.** A side that does not know a method answers `-32601`, and the sender skips it.
- **Go's replies still arrive whole,** after "Go is typing...". There is no streaming.

### The methods

- **go-server to go-brain (your requests):** `send_event`, `person_typing` (a notification), `card_tap`, `catch_up`, `get_person`, `update_person`, `delete_fact`, `forget_person`, `vault_link`.
- **go-brain to go-server (Go's requests):** `read_trip`, `read_messages`, `post_message`, `replace_card`, `typing` (a notification), `add_reaction`, `remove_reaction`, `update_trip`, `open_vote`, `close_vote`, `set_mandate`, `add_record_line`, `update_record_line`, `add_booking`, `update_booking`, `add_expense`, `request_spend_approval`, `cancel_spend_approval`.

### Reactions and typing, both ways

- **Go can react to a message** with `add_reaction` and take it back with `remove_reaction`. For example, Go adds a quiet ✅ to a message when it noted something in the trip record without saying anything. go-server sends `reaction.added` and `reaction.removed` events for Go's reactions like anyone else's. People's reactions still arrive as those same events.
- **Go shows "Go is typing..."** with the `typing` notification (it was the `setTyping` route).
- **go-server tells Go when someone is typing** with the `person_typing` notification, so Go waits for them to finish before it answers. This is new.

### Old route, new method

| In the first version | Now |
|---|---|
| `POST /v1/events` on go-brain | `send_event` |
| `POST /v1/trips/{trip_id}/cards/{card_id}/actions` (`CardActionRequest`) | `card_tap` (`CardTap`) |
| `POST /v1/trips/{trip_id}/catch-up` | `catch_up` |
| `GET`, `PATCH` and `DELETE /v1/people/{person_id}...`, `POST /v1/links` | `get_person`, `update_person`, `delete_fact`, `forget_person`, `vault_link` |
| `getTrip`, `listMessages` on go-server | `read_trip`, `read_messages` |
| `postMessage`, `putCard` (`PutCardResult`), `setTyping` (`SetTyping`) | `post_message`, `replace_card` (`ReplaceCardResult`), `typing` (`GoTyping`) |
| `updateTrip`, `openDecision`, `closeDecision`, `setMandate` | `update_trip`, `open_vote`, `close_vote`, `set_mandate` |
| `addRecordLine`, `updateRecordLine`, `addBooking`, `updateBooking`, `addExpense` | `add_record_line`, `update_record_line`, `add_booking`, `update_booking`, `add_expense` |
| `requestSpendApproval`, `cancelSpendApproval` | `request_spend_approval`, `cancel_spend_approval` |
| none | `add_reaction`, `remove_reaction`, `person_typing` |

Ids that used to be in a path are now fields in the params, and every one of Go's requests names its trip with `trip_id`. For example, `close_vote` takes `{ request_id, trip_id, decision_id }`, and `card_tap` takes `{ trip_id, card_id, action_id, person_id, option_id }`.

### Later the same day

Writing the guide for the socket turned up six gaps, and the contract now closes them:

- **Card taps have their own id.** `CardTap` now has a required `tap_id`, which go-server makes for each tap. Go acts on each `tap_id` once, so a tap that is resent after a reconnect, or tapped twice, does nothing twice. Requests that change something now all carry their own id (`event_id`, `request_id` or `tap_id`), and the rest only read or are safe to repeat.
- **`read_messages` stays under the frame limit.** go-server sends fewer than 200 messages, with `has_more: true`, when the answer would go over 1 MB.
- **A `429` says how long to wait.** `SocketError` frames can carry `error.data.retry_after_seconds`, because the socket has no `Retry-After` header.
- **Each signature opens the socket once.** go-brain refuses a second upgrade with the same `t` and `v1`, so a header copied from a log cannot open another socket. go-server makes a new signature for every connect, and each instance names itself in the query string.
- **Unknown event types are accepted.** go-brain answers `send_event` with `accepted: true` for an event type it does not know yet, so go-server can add event types within version 1.
- **People's typing works like Go's.** A `person_typing` "on" lasts 10 seconds. go-server sends it again every 5 seconds while the person types, forwards it for everyone, and Go ignores people who paused it.

The guide also changed one thing about go-server's client: handlers get the params exactly as they arrived as well as the checked copy, so go-server stores Go's cards unchanged and a new card field reaches the app without a go-server update.

### Who builds what

- **go-brain:** the Vestra team (Keshav), with Bash and Nami.
- **go-server and its database:** Nishanth's team.
- **go-app (Flutter):** Saket's team.

## The first set of changes, 5 October

These changes turned the draft (version 0.1, 4 October) into version 1.0.0. The last column says what the second set of changes did to each row.

### Two calls Keshav made

| Question | Decision | Why | After the socket change |
|---|---|---|---|
| How do Go's replies appear in the room? | **Whole, after "Go is typing..."**, like a friend's message. | It is how a person's message appears, and how other AI members of group chats behave. It also meant the two servers needed no socket between them: plain signed HTTPS in both directions. | The decision stands: replies still arrive whole, with no streaming. **Superseded:** "no socket between the servers". There is now one socket, opened by go-server. |
| Does a payer need a Vestra account? | **No. A passkey is enough.** | The vault belongs to the person in Go (`person_id`). Adding their first card creates their passkey (Face ID), and every payment needs it. Nobody hits a sign-up screen at the moment of paying. A Vestra account can be linked later. | Still holds. |

### Everything else

| What | In the draft | In version 1.0.0 | Why | After the socket change |
|---|---|---|---|---|
| People's ids | A member id per trip, plus a Vestra user id for payers | One `person_id` per human, the same in every trip | Go can recognise someone in their next trip (if they allow it). Two ids for one person would need a table mapping one to the other forever. | Still holds. |
| What go-server sends go-brain | `POST /go/v1/messages`: room messages only | `POST /v1/events`: 20 event types, each with the trip's change number (`seq`) | Go also needs edits, deletes, reactions, people joining, votes, the payer's yes and undo on the trip record. The change number lets go-brain notice a missed event and read the trip again, so nothing is lost. | **Superseded:** the same 20 events are sent with the `send_event` method on the socket. |
| The payer's yes | The payer types "yes book" in the chat | A "Yes, book it" button on the mandate card, shown only to the payer and owned by go-server | The spend check must not depend on reading free text. | Still holds. |
| The trip record | Not in the contract | Lines that are decided, agreed, open, doing or booked, each with proof; go-server writes decided and booked lines from votes and bookings; Go writes the rest; people can undo any line | Agreements made in the chat without a vote had nowhere to live. | Still holds. |
| Request signatures | HMAC over `t.body`; a GET signed an empty string | HMAC over `t`, the method, the path with query and the body, joined by newlines | A signature made for one route can no longer be reused on another. Shared test vectors prove the TypeScript and Python code agree. | **Changed:** the same format now signs only the upgrade that opens the socket (`GET /v1/socket`). |
| Taps on Go's cards | Not in the contract | `POST /v1/trips/{trip_id}/cards/{card_id}/actions`, answering `done`, `open` or `refused` within 3 seconds | The person tapping needs an answer straight away, for example the link to the vault page. | **Superseded:** the `card_tap` method, with the same three answers and the same 3 seconds. |
| Cards | `card: { id, upsert, body }`, 9 kinds | A card object with `card_id`, `kind` and `fallback_text`, 13 kinds, updated in place with `PUT /cards/{card_id}` | The same JSON goes from go-brain to the screen unchanged. An older app build shows `fallback_text` for a kind it does not know. | **Changed:** the cards are the same; a card is now updated in place with the `replace_card` method. |
| go-server routes | 12, including `settleUp` and `recordCall` | 16. Settle-up is in the trip snapshot (`money.transfers`). A call's record is its final call card. New: `listMessages`, `putCard`, `setTyping`, `addRecordLine`, `updateRecordLine`, `updateBooking`, `cancelSpendApproval` | go-server does the money maths once, and every screen reads the same numbers. | **Superseded:** go-server serves no routes for go-brain. They are 18 methods Go sends on the socket, including `add_reaction` and `remove_reaction`. Settle-up and call records are unchanged. |
| Questions go-server asks go-brain | None | Card actions, catch-up, people pages, carry-over, delete a fact, forget me, vault links, health | The app's "What Go knows about you" and "Forget me" screens, and catch-up when someone comes back to the room. | **Superseded:** these are methods on the socket. Only health stays an HTTP route. |
| Forget me | Not in the contract | go-brain deletes the person's facts and proves none are left; go-server clears their join answers in those trips | Go must not learn again what it was asked to forget. | Still holds, sent as `forget_person`. |
| Empty fields | Optional fields could be missing but not `null` | `null` and missing mean the same thing everywhere | Python code can always serialize with `exclude_none=True`, and nobody gets a `422` for sending `null`. | Still holds. |
| The spend approval | Named the payer by member id and Vestra user id | Names the payer by `person_id`; adds `refundable_until`; more denial reasons; Go can release an approval it will not use (`cancelSpendApproval`) | Follows the person id and passkey decisions above. Releasing means a failed or declined payment does not block the next try for 10 minutes. | Still holds. The token is unchanged; the requests are now `request_spend_approval` and `cancel_spend_approval`. |
| Where the contract lives | One `openapi.json` | `openapi/go-server.json` and `openapi/go-brain.json`, a Python package (`packages/contract-py`) with models, signing and spend approvals, shared test vectors, and this guide with CI-checked examples | Each team generates from the file for the server it builds, in TypeScript or Python. | **Changed:** `openapi/go-server.json` is gone. `openapi/go-brain.json` has go-brain's two HTTP routes and every schema, `asyncapi/socket.json` and `socket/methods.json` describe the socket, and the Python package has the methods as `go_contract.METHODS`. |
