# Build and test

This page explains how to set up the contract in your project, how to prove your side follows it before the other side exists, and what "done" means for each part. Use it as the checklist for the week.

## Set up

Clone this repo, then install the TypeScript and Python packages:

```bash
pnpm install                                   # the TypeScript contract (@go/contract)
pip install -e 'packages/contract-py[dev]'     # the Python contract (go_contract)
```

From your own repo, use the packages as described in [the guide's front page](README.md#using-the-contract-from-your-code).

## Prove your signing code first

Signing is the one thing both sides must get exactly right, so check it before anything else. `packages/contract/test-vectors/signing.json` holds a secret, a time and three requests with the exact header each must produce. `packages/contract/test-vectors/spend-approval.json` holds a test Ed25519 key, a set of claims and the exact token they must produce. If you use the helpers in `@go/contract` or `go_contract`, they already pass both files in CI. If you write your own, make it reproduce every value in them first.

**TypeScript**

```ts
import { readFileSync } from 'node:fs';
import { signRequest } from '@go/contract';

const v = JSON.parse(readFileSync('packages/contract/test-vectors/signing.json', 'utf8'));
for (const c of v.cases) {
  console.log(signRequest(c, v.secret, v.t) === c.header ? 'ok  ' : 'FAIL', c.name);
}
```

**Python**

```python
import json

from go_contract import sign_request

v = json.load(open("packages/contract/test-vectors/signing.json"))
for c in v["cases"]:
    ok = sign_request(c["method"], c["target"], c["body"], v["secret"], now=v["t"]) == c["header"]
    print("ok  " if ok else "FAIL", c["name"])
```

## Send a signed request by hand

`curl` cannot make the signature by itself, so make it with the Python helper and pass it in. This posts a message as Go into a trip on go-server:

```bash
export GO_SIGNING_SECRET=...   # from your environment, never pasted into chat
BODY='{"request_id":"rq_hand_1","text":"Hello from Go"}'
TARGET=/brain/v1/trips/t_goa/messages
SIG=$(python -c 'import os, sys; from go_contract import sign_request; print(sign_request("POST", sys.argv[1], sys.argv[2], os.environ["GO_SIGNING_SECRET"]))' "$TARGET" "$BODY")
curl -sS -X POST "$GO_SERVER_URL$TARGET" -H 'content-type: application/json' -H "x-go-signature: $SIG" --data-raw "$BODY"
```

To receive events on your laptop, expose your local server with a tunnel (`cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`) and give that URL to whoever runs the other side.

## Check your examples

If you add or change a JSON example in this guide, mark it with `<!-- schema: Name -->` and run:

```bash
pnpm --filter @go/contract check-docs
```

It checks every marked example against the contract and lists any event, card, request or response that has no example yet. CI runs the same check in TypeScript and loads every example into the Python models too.

## Work without the other side

- **The fake go-brain.** The Vestra team is building a small fake go-brain next, so go-server and the app can be built before the real one is ready. It will check signatures, accept every event, answer card actions, catch-up and people-page calls with fixed answers, and post a Go reply with one card of every kind back to your trip API when someone mentions Go. Until it is up, go-server can test its outgoing calls against `GET /v1/health` and the examples in this guide.
- **A fake go-server for go-brain.** go-brain is tested against a small fake trip API that serves the Goa trip from [the trip API page](03-trip-api.md) and records every write.

## What done means

**go-server**
- Checks `x-go-signature` on every `/brain/v1` route and answers `401 bad_signature` when it fails.
- Sends an event for every change to a trip, from an outbox, in change-number order per trip, with the retry schedule in [Basics](01-basics.md#time-limits-and-retries).
- Serves all 15 trip API routes, each doing its write once per `request_id`.
- Runs the spend check and signs spend approvals that verify against go-brain's public key. Its code reproduces the token in the test vector.
- Forwards card taps, catch-up, people pages and "forget me" to go-brain, and never lets the app call go-brain directly.
- Sends pushes only in the cases listed in [The app](06-the-app.md).

**go-app**
- Draws all 13 card kinds, and shows `fallback_text` for any kind it does not know.
- Shows "Go is typing...", Go's messages as Go (never as a person), and the "needs you" strip.
- Opens go-brain pages in the system browser sheet, never in a WebView.
- Lets people pause Go, see what Go knows about them, and ask Go to forget them.

**go-brain (the Vestra team)**
- Answers every event with `202` within 2 seconds, ignores repeats, and catches up after a gap in change numbers.
- Answers card actions and catch-up within 3 seconds.
- Serves people pages, carry-over, deleting a fact and "forget me", and checks nothing is left after a forget.
- Only pays with a valid spend approval and the payer's passkey, and records the booking with its `approval_id`.

## Open questions that do not change the contract

These are still being worked out. Each one changes only what happens inside go-brain, so nobody needs to wait on them.

- What ixigo's tools can do this week (search, book, pay, test mode). This decides how Go books, not what the room sees.
- The staging URLs for go-server and go-brain. They go into each side's `GO_SERVER_URL` and `BRAIN_URL` once both are deployed.
