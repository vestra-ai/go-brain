# What changed from the first draft

This page lists what changed between the first draft of the contract (version 0.1, 4 October) and version 1.0.0 (5 October), and why. Read it if you saw the draft; otherwise the rest of the guide is all you need. Nobody had built against the draft yet, so nothing needs migrating.

## Two calls Keshav made on 5 October

| Question | Decision | Why |
|---|---|---|
| How do Go's replies appear in the room? | **Whole, after "Go is typing..."**, like a friend's message. | It is how a person's message appears, and how other AI members of group chats behave. It also means the two servers need no socket between them: plain signed HTTPS in both directions. |
| Does a payer need a Vestra account? | **No. A passkey is enough.** | The vault belongs to the person in Go (`person_id`). Adding their first card creates their passkey (Face ID), and every payment needs it. Nobody hits a sign-up screen at the moment of paying. A Vestra account can be linked later. |

## Everything else

| What | In the draft | Now | Why |
|---|---|---|---|
| People's ids | A member id per trip, plus a Vestra user id for payers | One `person_id` per human, the same in every trip | Go can recognise someone in their next trip (if they allow it). Two ids for one person would need a table mapping one to the other forever. |
| What go-server sends go-brain | `POST /go/v1/messages`: room messages only | `POST /v1/events`: 20 event types, each with the trip's change number (`seq`) | Go also needs edits, deletes, reactions, people joining, votes, the payer's yes and undo on the trip record. The change number lets go-brain notice a missed event and read the trip again, so nothing is lost. |
| The payer's yes | The payer types "yes book" in the chat | A "Yes, book it" button on the mandate card, shown only to the payer and owned by go-server | The spend check must not depend on reading free text. |
| The trip record | Not in the contract | Lines that are decided, agreed, open, doing or booked, each with proof; go-server writes decided and booked lines from votes and bookings; Go writes the rest; people can undo any line | Agreements made in the chat without a vote had nowhere to live. |
| Request signatures | HMAC over `t.body`; a GET signed an empty string | HMAC over `t`, the method, the path with query and the body, joined by newlines | A signature made for one route can no longer be reused on another. Shared test vectors prove the TypeScript and Python code agree. |
| Taps on Go's cards | Not in the contract | `POST /v1/trips/{trip_id}/cards/{card_id}/actions`, answering `done`, `open` or `refused` within 3 seconds | The person tapping needs an answer straight away, for example the link to the vault page. |
| Cards | `card: { id, upsert, body }`, 9 kinds | A card object with `card_id`, `kind` and `fallback_text`, 13 kinds, updated in place with `PUT /cards/{card_id}` | The same JSON goes from go-brain to the screen unchanged. An older app build shows `fallback_text` for a kind it does not know. |
| go-server routes | 12, including `settleUp` and `recordCall` | 15. Settle-up is in the trip snapshot (`money.transfers`). A call's record is its final call card. New: `listMessages`, `putCard`, `setTyping`, `addRecordLine`, `updateRecordLine`, `updateBooking` | go-server does the money maths once, and every screen reads the same numbers. |
| Questions go-server asks go-brain | None | Card actions, catch-up, people pages, carry-over, delete a fact, forget me, vault links, health | The app's "What Go knows about you" and "Forget me" screens, and catch-up when someone comes back to the room. |
| Empty fields | Optional fields could be missing but not `null` | `null` and missing mean the same thing everywhere | Python code can always serialize with `exclude_none=True`, and nobody gets a `422` for sending `null`. |
| The spend approval | Named the payer by member id and Vestra user id | Names the payer by `person_id`; adds `refundable_until`; more denial reasons | Follows the person id and passkey decisions above. |
| Where the contract lives | One `openapi.json` | `openapi/go-server.json` and `openapi/go-brain.json`, a Python package (`packages/contract-py`) with models, signing and spend approvals, shared test vectors, and this guide with CI-checked examples | Each team generates from the file for the server it builds, in TypeScript or Python. |
