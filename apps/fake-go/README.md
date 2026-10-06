# The fake Go

The fake Go is a small stand-in for Go that speaks the real socket. The Server team uses it to build and test the Server's side of the socket before the real Go is ready. It follows the contract in `packages/contract` and the guide at https://vestrago.vercel.app/docs.

## What it does

- Opens the socket at `GET /v1/socket` only with a valid `x-go-signature`, and accepts each signature once. A refused upgrade gets `401` with `{"error":{"code":"bad_signature","message":"..."}}`, and the message says what was wrong.
- Pings every 20 seconds, and closes a socket that has been silent for 40 seconds.
- Answers every `send_event` straight away: `{"accepted":true,"duplicate":false}`, or `"duplicate":true` for an `event_id` it has seen. An event type it does not know is accepted too. A broken event of a known type gets `422`.
- When a `message.created` event has `mentions_go: true`, and is not Go's own, withheld or deleted, it sends `typing` (on), `read_trip`, `add_reaction` with ✅ on that message, `post_message` with a reply and one of Go's cards, and `typing` (off). The card changes each time: `options`, `working`, `call`, `pay`, `notice`, then round again.
- Sends its requests about an event on the socket that event came on, so with several Server instances connected, the instance that sent the event gets them. If that socket closes first, they go on the newest open socket, with the same JSON-RPC id.
- Answers `card_tap`, `catch_up`, `get_person`, `update_person`, `delete_fact`, `forget_person` and `vault_link` with fixed answers taken from the guide's examples. A repeated `tap_id` gets its first answer back. `approve` on a pay card works only for that card's payer; anyone else gets `refused` with a toast.
- Answers `-32601` for any other method, and `-32700` with `id: null` for a frame it cannot read or a request that is not well formed (a non-string id, an id over 64 characters, no `"jsonrpc": "2.0"`).
- Checks every answer from the Server against the contract. An answer that breaks it (a missing `result`, a result of the wrong shape, an error with no `data.code` other than `-32601` and `-32700`), or one that does not come within 2 seconds, shows as a Problem row on the frames page.
- Answers `GET /v1/health` with `{"ok":true,"contract":"1.0.0"}`.

## Connecting

Set these in the Server's environment:

| Variable | Value |
|---|---|
| `GO_URL` | `https://<the fake Go's domain>`. Keshav sends it. |
| `GO_SIGNING_SECRET` | Keshav sends it through a one-time link. Keep it only in your environment variables. |

The socket is `wss://<the fake Go's domain>/v1/socket`. Give each Server instance its own name in the query string, such as `/v1/socket?instance=server-1`, and sign the full target with the query string.

For the Server's end of the socket, copy `packages/sim/src/server-socket.ts` from this repo, not the client in the guide. The guide's client answers a handler that returns nothing with a frame that has no `result`, which the contract refuses. `server-socket.ts` always answers with a result object, gives every error its `data.code`, gives up a connect after 10 seconds, and can be stopped for good with `close()`.

To connect by hand, use `connect.py` or `wscat` from the "Connect by hand" section of [Build and test](https://vestrago.vercel.app/docs), with `GO_URL` set to the fake Go. Make a new signature for every connect.

To run the whole check from this repo, build it once, then run the smoke check:

```bash
pnpm install && pnpm --filter "@go/fake-go..." build
GO_URL=https://<the fake Go's domain> GO_SIGNING_SECRET=<the secret> pnpm --filter @go/fake-go smoke
```

It creates a test trip, says "@Go hello", prints every frame both ways, and ends with `SMOKE OK` when the fake Go answered as described above.

## Reading the frames

`https://<the fake Go's domain>/frames?token=<FAKE_GO_ADMIN_TOKEN>` lists the last 200 frames both ways, newest first, with a Problem row wherever an answer from the Server broke the contract or never came. It refreshes every 3 seconds. From a script, send the token as `Authorization: Bearer <FAKE_GO_ADMIN_TOKEN>` instead of in the address. Keshav sends the token with the secret. Frames carry the trip's messages, so keep the link within the team.

## What it does not do

- It has no memory and no model. It does not read the words of a message, keep trips, answer questions or speak first.
- It does not retry a request that failed or got no answer, and it does not catch up after a gap in change numbers. (A request whose socket closed before the answer is sent again on the next open socket, with the same id.)
- It never answers `429` or `503`, and always answers the Server's requests in time, so the Server's retry path is not exercised against it.
- Its pay cards are test cards. Their `approval_id` starts with `ap_fake_`, and nothing can be paid with them. It never sends `request_spend_approval`.
- The watch and vault links open a plain page that says what the real Go shows there.
- It keeps used signatures, seen events and seen taps in memory, so a restart forgets them.
- It sends only `read_trip`, `add_reaction`, `post_message` and `typing`. To test the Server's answers to Go's other requests, use the examples in "Go's requests" in the guide.

## Running it on your machine

```bash
pnpm install && pnpm --filter "@go/fake-go..." build
export GO_SIGNING_SECRET=$(openssl rand -hex 32)
export FAKE_GO_ADMIN_TOKEN=$(openssl rand -hex 16)
node apps/fake-go/dist/main.js
```

It listens on `PORT` (8080 when not set). Point your Server's `GO_URL` at `http://localhost:8080`.

## Deploying on Railway

1. Create a service from the `vestra-ai/go-brain` repo, on the `build` branch.
2. In Settings, Source, leave Root Directory empty, so the build runs from the repo root. The Dockerfile copies the whole workspace, because the fake Go builds `@go/contract` and `@go/sim` with it.
3. In Settings, Config-as-code, set the config file path to `/apps/fake-go/railway.json`. It builds `apps/fake-go/Dockerfile` and checks `/v1/health` before a deploy goes live.
4. In Variables, set `GO_SIGNING_SECRET` (make it with `openssl rand -hex 32`) and `FAKE_GO_ADMIN_TOKEN` (make it with `openssl rand -hex 16`). Railway sets `PORT` and `RAILWAY_PUBLIC_DOMAIN` itself.
5. In Settings, Networking, generate a domain. `https://<that domain>` is the `GO_URL` the Server uses.

## How the tests prove it

CI runs these tests, then builds the Docker image Railway builds and checks that it boots and answers `/v1/health`.

- `server.test.ts`: the upgrade refuses a missing, malformed, stale or wrong signature, accepts each signature once and needs the query string signed; health answers without a signature; the frames page needs the admin token; `send_event` accepts an unknown event type and refuses a broken known one with `422`.
- `behaviour.test.ts`: a message that mentions Go gets typing, `read_trip`, a ✅, a reply with a card and typing off, on the socket the event came on; repeats, Go's own messages, withheld messages and messages not for Go get nothing; each card kind is valid and has no em dash; taps are answered once, and only the payer can approve.
- `link.test.ts`: which socket a request goes on, and that every answer from the Server is checked against the contract, with a Problem row for a bad or late one.
- `smoke.test.ts`: the smoke check passes against a running fake Go, and fails with a plain reason when the secret is wrong.

`pnpm --filter @go/fake-go test` runs them.
