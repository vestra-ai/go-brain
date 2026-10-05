# Build and test

This page explains how to set up the contract in your project, how to prove your side follows it before the other side exists, and what "done" means for each part. Use it as the checklist for the week.

## Set up

Clone this repo, then install the TypeScript and Python packages:

```bash
pnpm install                                   # the TypeScript contract (@go/contract)
pip install -e 'packages/contract-py[dev]'     # the Python contract (go_contract)
```

From your own repo, use the packages as described in [the guide's front page](README.md#using-the-contract-from-your-code). For the socket, the server also needs a WebSocket client: `ws` in TypeScript, or `websockets` (14 or later) in Python.

## Prove your signing code first

The signature that opens the socket is the one thing both sides must get exactly right, so check it before anything else. Two files hold the values every implementation must reproduce:

- `packages/contract/test-vectors/signing.json` holds a secret, a time and three requests, including opening the socket (`GET /v1/socket`), with the exact `x-go-signature` header each must produce. [Proving your signing code](02-the-socket.md#proving-your-signing-code) has the script that checks it, in TypeScript and Python.
- `packages/contract/test-vectors/spend-approval.json` holds a test Ed25519 key, a set of claims and the exact spend approval token they must produce. [Money and the vault](08-money-and-the-vault.md) explains it.

If you use the helpers in `@go/contract` or `go_contract`, they already pass both files in CI. If you write your own, make it reproduce every value in them first.

## Connect by hand

You can open the socket from a terminal to see it work before you write the server's client. The signature has to be made by code, so make it with the Python helper.

This short Python script opens the socket, prints every frame Go sends, and sends one request (it asks for what Go knows about Kabir):

```python
# connect.py: open the socket by hand. Run it with: python connect.py
import asyncio
import json
import os

import websockets
from go_contract import SIGNATURE_HEADER, sign_request

URL = os.environ["GO_URL"].replace("http", "ws", 1) + "/v1/socket"


async def main() -> None:
    signature = sign_request("GET", "/v1/socket", b"", os.environ["GO_SIGNING_SECRET"])
    async with websockets.connect(URL, additional_headers={SIGNATURE_HEADER: signature}) as ws:
        print("connected")
        await ws.send(json.dumps({"jsonrpc": "2.0", "id": "gs_hand_1", "method": "get_person", "params": {"person_id": "p_kabir"}}))
        async for frame in ws:
            print(frame)


asyncio.run(main())
```

Or use [`wscat`](https://www.npmjs.com/package/wscat) and type frames yourself. Make the header with the Python helper and pass it in:

```bash
export GO_SIGNING_SECRET=...   # from your environment, never pasted into chat
SIG=$(python -c 'import os; from go_contract import sign_request; print(sign_request("GET", "/v1/socket", b"", os.environ["GO_SIGNING_SECRET"]))')
npx wscat -c "wss://brain.go.example/v1/socket" -H "x-go-signature: $SIG"
```

Once it says `Connected`, paste a request on one line, such as:

```
{"jsonrpc":"2.0","id":"gs_hand_2","method":"get_person","params":{"person_id":"p_kabir"}}
```

Good to know:
- Go accepts each signature once, so make a new one (run the `SIG=` line again) every time you connect.
- `401` means the secret or your clock is wrong, or the signature was used before.
- If you leave the socket idle, Go's pings keep it open. Both scripts answer pings by themselves.
- A server on your laptop needs no tunnel: it dials out to Go, and Go never calls it.

## Check your examples

If you add or change a JSON example in this guide, mark it with `<!-- schema: Name -->` and run:

```bash
pnpm --filter @go/contract check-docs
```

It checks every marked example against the contract and lists any event, card, method params, method result or frame that has no example yet. CI runs the same check in TypeScript and loads every example into the Python models too.

## Work without the other side

Each team can build and test its part before the other part is ready, against a fake of the other side that speaks the same socket.

- **The fake Go.** Keshav's team is building a small fake Go next, so the server and the app can be built before the real one is ready. It speaks the same socket as the real one:
  - It checks the signature on the upgrade and pings every 20 seconds.
  - It answers every `send_event` with `{ "accepted": true, "duplicate": false }`, and with `"duplicate": true` for an `event_id` it has seen.
  - When a `message.created` event mentions Go, it sends a `typing` notification, sends `read_trip`, adds a ✅ to the message with `add_reaction`, and then sends `post_message` with a reply and one of Go's own cards (`options`, `working`, `call`, `pay` or `notice`), a different kind each time.
  - It answers `card_tap`, `catch_up`, the people requests and `vault_link` with fixed answers.

  Until it is up, the server can test its signing code with the test vectors, and its answers to Go's requests with the examples in this guide.
- **The fake server.** Go is tested against a small fake server that opens the socket, sends the Goa trip's events, answers Go's requests from the Goa trip in [Go's requests](04-gos-requests.md), and records every write.

## What done means

**Server (Nishanth's team)**
- Opens one socket to Go with a fresh signature on every connect (each instance with its own `?instance=` name), keeps it open, and reconnects after 1, 2, 5 and 10 seconds, then every 30 seconds.
- Sends an event for every change to a trip with `send_event`, from an outbox, in change-number order per trip, waiting for each answer, with the retry schedule in [Basics](01-basics.md#time-limits-and-retries).
- Answers all of Go's requests in [Go's requests](04-gos-requests.md) within 2 seconds, checks their params, does each write once per `request_id`, answers `-32601` for a method it does not handle, and shows or hides "Go is typing..." for the `typing` notification. Sends `read_messages` pages under the 1 MB frame limit, with `has_more: true` when it sent fewer.
- Sends an unanswered request again after reconnecting, with the same JSON-RPC `id`.
- Lets any of its instances answer any of Go's requests, from the shared database.
- Runs the spend check and signs spend approvals that verify against Go's public key. Its code reproduces the token in the test vector.
- Sends card taps (each with its own `tap_id`), catch-up, people pages, "forget me" and vault links to Go on the socket, and never lets the app talk to Go except to open Go's pages.
- Sends pushes only in the cases listed in [The App](07-the-app.md).

**App (Saket's team)**
- Draws all 13 card kinds, and shows `fallback_text` for any kind it does not know.
- Shows "Go is typing...", Go's messages as Go (never as a person), Go's reactions on messages, and the "needs you" strip.
- Opens Go's pages in the system browser sheet, never in a WebView.
- Lets people pause Go, see what Go knows about them, and ask Go to forget them.

**Go (Keshav's team)**
- Accepts the socket only with a valid signature that has not been used before, pings every 20 seconds, and closes a socket that has been silent for 40 seconds.
- Answers every `send_event` within 2 seconds (`accepted: true` even for an event type it does not know yet), ignores repeated `event_id`s, and catches up with `read_trip` and `read_messages` after a gap in change numbers.
- Answers `card_tap` and `catch_up` within 3 seconds and every other request within 2 seconds, acts on each `tap_id` once, answers `-32601` for a method it does not know, and sends `retry_after_seconds` with every `429`.
- Sends each of its requests on one open socket, and sends unanswered ones again after a reconnect with the same JSON-RPC `id` and `request_id`.
- Shows "Go is typing..." while it works. After a message for Go, it waits about 2 seconds in case the same person sends more, and just before it posts, it checks for anything new for it in the room and answers that too.
- Reacts quietly when it notes something without speaking.
- Serves people pages, carry-over, deleting a fact and "forget me", and checks nothing is left after a forget.
- Only pays with a valid spend approval and the payer's passkey, and records the booking with its `approval_id`.

## Open questions that do not change the contract

These are still being worked out. Each one changes only what happens inside Go, so nobody needs to wait on them.

- What ixigo's tools can do this week (search, book, pay, test mode). This decides how Go books, not what the room sees.
- The staging URL for Go. It goes into the server's `GO_URL` once Go is deployed. Go needs no address for the server.
