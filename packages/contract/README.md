# packages/contract: the contract

The contract is everything that travels between the Server and Go, written once as zod schemas. It is the single source of truth for the wire: Go, the fake Go, the simulator and the vault all import their types from here, and nothing redefines a schema of its own. The guide in [`docs/guide`](../../docs/guide) explains it in plain words, and CI checks that every example in the guide matches these schemas.

Version `1.0.0` (`CONTRACT_VERSION`). One WebSocket at `/v1/socket`, opened by the Server and signed, with JSON-RPC 2.0 frames both ways.

## Main parts

| Part | What it holds |
|---|---|
| `src/common.ts`, `src/people.ts`, `src/room.ts`, `src/trip.ts` | The objects: ids, money in whole minor units (paise), people, messages, the trip snapshot, votes, bookings, expenses and the trip record. |
| `src/cards.ts` | The 13 card kinds: the record cards the Server draws (vote, mandate, ticket, expense, settle-up, day, plan, budget) and Go's own (options, working, call, pay, notice), each with fallback text. |
| `src/events.ts` | Every event the Server sends Go, one per change, with its change number. |
| `src/to-go.ts`, `src/to-server.ts`, `src/socket.ts` | Every method in both directions with its params and result, the socket path and frame limits. |
| `src/errors.ts` | The error codes and what each one means for a retry. |
| `src/signing.ts` | The signature on the socket's upgrade: HMAC-SHA256 over the timestamp, the method, the target with its query string and the body, good for 300 seconds, and Go accepts each signature once. |
| `src/spend-approval.ts` | The Server's signed spend approval: an Ed25519 compact JWS from `server` to `go-vault`, at most 10 minutes long, used once. |
| `openapi/go.json`, `asyncapi/socket.json`, `socket/methods.json` | Generated from the schemas (`pnpm --filter @go/contract emit-openapi`). CI fails when they are stale. The Python package builds its models from `openapi/go.json`. |
| `test-vectors/` | Shared signing and spend-approval vectors that the TypeScript and Python helpers must both reproduce. |

## How the tests prove it

- `schemas.test.ts`: the contract's rules: a message from Go needs text or a card, every card has fallback text, unknown fields are ignored, links are http or https, money is never a float, the trip snapshot never says who picked which budget, and every method has named params and result schemas.
- `signing.test.ts`: a changed body, another route or method, the wrong secret, a stale timestamp or a malformed header is refused.
- `spend-approval.test.ts`: the shared vector is reproduced exactly; an expired approval, one from the future, one signed by another key, a raised amount and garbage are refused; nothing signs an approval longer than 10 minutes.
- `docs-examples.test.ts`: every JSON example in the guide matches its schema, and every event, card, request and response has a checked example.

`pnpm --filter @go/contract test` runs them.
