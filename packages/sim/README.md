# packages/sim: the simulator

The simulator plays the Server and the people in a trip room, so Go can be built, tested and shown without the real Server or App. It opens the signed socket to Go exactly as the Server does, holds trips in memory with the Server's rules from [`docs/guide`](../../docs/guide), answers all 18 of Go's methods, and sends each trip's events to Go one at a time, in change-number order. The dev room is a one-page App in the browser on top of it.

## Main parts (under `src/`)

| Part | What it does |
|---|---|
| `server-socket.ts` | `GoSocket`, the Server's end of the socket: signs every connect fresh, reconnects with backoff, closes after 40 s of silence, sends unanswered requests again with the same id after a reconnect, and answers Go's requests through a table of handlers with the contract's errors. The Server team can copy this file. |
| `fake-server.ts` | `FakeServer`: trips in memory, Go's 14 writes each done once per `request_id`, and helpers that play people: say, react, edit, delete, tap a card, vote, close a vote on time, and the payer's "Yes, book it" or "Not now". |
| `state/` | The rules behind it: change numbers and events (`trip-state.ts`), votes and mandates (`decisions.ts`), the trip record (`records.ts`), and the spend check, signed spend approvals, bookings, expenses and who owes whom (`money.ts`). A refused write leaves the trip as it was. |
| `dev-room/` | The dev room: a page served with a live WebSocket. It shows the room and every card kind, and sends what people do on the page to the `FakeServer`. It is laid out for a phone. |
| `goa.ts` | The Goa trip from the guide (Rahul, Priya, Arjun, Meher and Kabir), fresh or mid-planning, and a short seed chat. |
| `test-spend-key.ts` | The contract's test Ed25519 key pair, which the simulator uses to sign spend approvals in development and tests. The real Server signs with its own key, which is never in a repo. |
| `cli.ts` | `pnpm --filter @go/sim room -- --go <Go's URL> --secret <GO_SIGNING_SECRET>`: connects to a running Go (the real one or the fake Go), creates the Goa trip and opens the dev room. |

Go's end-to-end tests (`apps/brain/src/__tests__/e2e`) run against the `FakeServer`, and the fake Go's tests and smoke check connect with `GoSocket` and the Goa trip.

## How the tests prove it

- `server-socket.test.ts`: signed connects, reconnects, requests answered once and sent again after a reconnect, and the keep-alive.
- `fake-server.test.ts`: the upgrade, events in order, a write done once per `request_id` even when it arrives twice, refused writes changing nothing, and a reconnect that keeps the trip.
- `trip-state.test.ts`, `decisions.test.ts`, `records.test.ts` and `money.test.ts`: each of the Server's rules, including the spend check and the money maths.
- `dev-room.test.ts`: one self-contained page with no em dashes and every card kind, laid out for a phone, and what people do on it reaching the room.

`pnpm --filter @go/sim test` runs them.
