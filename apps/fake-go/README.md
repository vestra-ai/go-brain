# The fake Go

The fake Go is a small stand-in for Go that speaks the real socket. The Server team uses it to build and test the Server's side of the socket before the real Go is ready. It follows the contract in `packages/contract` and the guide at https://vestrago.vercel.app/docs.

## What it does

- Opens the socket at `GET /v1/socket` only with a valid `x-go-signature`, and accepts each signature once. A refused upgrade gets `401` with `{"error":{"code":"bad_signature","message":"..."}}`, and the message says what was wrong.
- Pings every 20 seconds, and closes a socket that has been silent for 40 seconds.
- Answers every `send_event` straight away: `{"accepted":true,"duplicate":false}`, or `"duplicate":true` for an `event_id` it has seen. An event type it does not know is accepted too. A broken event of a known type gets `422`.
- When a `message.created` event has `mentions_go: true`, and is not Go's own, withheld or deleted, it sends `typing` (on), `read_trip`, `add_reaction` with ✅ on that message, `post_message` with a reply and one of Go's cards, and `typing` (off). The card changes each time: `options`, `working`, `call`, `pay`, `notice`, then round again.
- Answers `card_tap`, `catch_up`, `get_person`, `update_person`, `delete_fact`, `forget_person` and `vault_link` with fixed answers taken from the guide's examples. A repeated `tap_id` gets its first answer back. `approve` on a pay card works only for that card's payer; anyone else gets `refused` with a toast.
- Answers `-32601` for any other method, and `-32700` with `id: null` for a frame it cannot read.
- Answers `GET /v1/health` with `{"ok":true,"contract":"1.0.0"}`.

## Connecting

Set these in the Server's environment:

| Variable | Value |
|---|---|
| `GO_URL` | `https://<the fake Go's domain>`. Keshav sends it. |
| `GO_SIGNING_SECRET` | Keshav sends it through a one-time link. Keep it only in your environment variables. |

The socket is `wss://<the fake Go's domain>/v1/socket`. Give each Server instance its own name in the query string, such as `/v1/socket?instance=server-1`, and sign the full target with the query string.

To connect by hand, use `connect.py` or `wscat` from the "Connect by hand" section of [Build and test](https://vestrago.vercel.app/docs), with `GO_URL` set to the fake Go. Make a new signature for every connect.

To run the whole check from this repo:

```bash
GO_URL=https://<the fake Go's domain> GO_SIGNING_SECRET=<the secret> pnpm --filter @go/fake-go smoke
```

It creates a test trip, says "@Go hello", prints every frame both ways, and ends with `SMOKE OK` when the fake Go answered as described above.

## Reading the frames

`https://<the fake Go's domain>/frames?token=<FAKE_GO_ADMIN_TOKEN>` lists the last 200 frames both ways, newest first, and refreshes every 3 seconds. Keshav sends the token with the secret. Frames carry the trip's messages, so keep the link within the team.

## What it does not do

- It has no memory and no model. It does not read the words of a message, keep trips, answer questions or speak first.
- It does not retry its own requests, and it does not catch up after a gap in change numbers.
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
