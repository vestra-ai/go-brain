# Money and the vault

This page explains how Go pays for something safely: the two separate approvals every payment needs, the spend check the server runs, the signed spend approval, and the vault where the payer confirms with Face ID. Everyone building Go should read it, because the server, Go and the app each check part of every payment.

## Why a payment needs two separate approvals

Every payment needs two separate approvals, and Go produces neither of them. Use this rule to judge any change to the payment path: if a change lets one approval stand in for the other, or lets anything Go says count as one, the change is wrong.

1. **A spend approval from the server.** The server signs it only when its own rows show that the group voted, the price is within the cap the group allowed, and the payer tapped "Yes, book it". It signs with a private key that only the server holds.
2. **The payer's own Face ID in the vault.** The payer sees the amount, the merchant and the card on the vault page, and confirms with their passkey on their own phone.

Go is an AI reading a group chat. Someone could try to talk it into paying, or it could misread a message. That cannot lead to a payment, because neither approval is the model's word. The first comes from votes and buttons that people tapped, checked by the server. The second comes from the payer's own Face ID.

## A payment, step by step

This is the whole path of one payment, from the vote closing to the ticket in the room. The example is the villa for the Goa trip: Villa Sol won the vote `d_villa` 4 to 1, the group allowed up to ₹55,000, refundable only, and Rahul pays.

1. The vote closes. The server sends `decision.closed` for `d_villa`.
2. Go sets the mandate with a `set_mandate` request: choice 0 (Villa Sol), a cap of `5500000`, refundable only, payer Rahul. The server sends `mandate.set`.
3. Go posts a mandate card (`c_villa_mandate`) with `post_message`. The server draws it and shows "Yes, book it" and "Not now" to Rahul only.
4. Rahul taps "Yes, book it". The server stores the time on the mandate (`confirmed_at`) and sends `mandate.confirmed`.
5. Go checks the price with ixigo again: ₹54,200 for 3 nights, with free cancellation until 1 November.
6. Go asks for a spend approval with a `request_spend_approval` request.
7. The server runs the spend check, signs a one-use spend approval that lasts at most 10 minutes, stores it, and answers with it.
8. Go posts a pay card (`c_villa_pay`) for Rahul with `post_message`, with Approve and Decline buttons that only he sees.
9. Rahul taps Approve. The server sends the tap to Go as a `card_tap` request, and Go answers `open` with a link to the vault page. The app opens it in the system browser sheet.
10. The vault page shows the amount, the merchant, the refundable-until date and Rahul's card. Rahul confirms with Face ID, then types the card's CVV and his bank's one-time code on that page. Neither is stored.
11. The vault checks the spend approval (the signature, the expiry, that it was never used, the payer and the amount), pays ixigo once, and forgets the card details.
12. Go records the booking with an `add_booking` request, including the `approval_id`. The server checks the approval and marks it used.
13. Go records the expense with `add_expense` (Rahul paid, split between all five), posts a ticket card with `post_message`, and updates the pay card to `paid` in place with `replace_card`.

```mermaid
sequenceDiagram
  autonumber
  actor Rahul as Rahul (payer)
  participant app as App
  participant server as Server
  participant go as Go
  participant vault as vault page
  participant ixigo
  server->>go: send_event (decision.closed, d_villa, Villa Sol won 4 to 1)
  go->>server: set_mandate (d_villa, cap ₹55,000, refundable only, payer Rahul)
  server-->>go: answer: seq 72
  server->>go: send_event (mandate.set, seq 72)
  go->>server: post_message (mandate card c_villa_mandate)
  server->>app: the mandate card, with "Yes, book it" for Rahul only
  Rahul->>app: taps "Yes, book it"
  app->>server: Yes, book it
  server->>go: send_event (mandate.confirmed)
  go->>ixigo: check the price again (₹54,200, refundable until 1 Nov)
  go->>server: request_spend_approval (d_villa, ₹54,200)
  Note over server: the spend check, then sign<br/>(one use, 10 minutes at most)
  server-->>go: answer: approved (ap_01JA7Q3V8Z and the signed token)
  go->>server: post_message (pay card c_villa_pay for Rahul)
  server->>app: the pay card, and a push to Rahul
  Rahul->>app: taps Approve
  app->>server: the tap
  server->>go: card_tap (tap_0457, c_villa_pay, approve, p_rahul)
  go-->>server: answer: open (vault link, valid 5 minutes)
  server-->>app: open this link
  app->>vault: opens it in the system browser sheet
  vault->>Rahul: amount, merchant, refundable until, the card
  Rahul->>vault: Face ID, then the CVV and the bank's one-time code
  Note over vault: checks the token, pays once, forgets the card details
  vault->>ixigo: pays ₹54,200
  ixigo-->>vault: booked, ref IXG-7Q2K9
  go->>server: add_booking (b_villa, approval_id ap_01JA7Q3V8Z)
  Note over server: checks the approval and marks it used
  server-->>go: answer: booking_id b_villa, seq 76
  go->>server: add_expense (Rahul paid, split between all five)
  go->>server: post_message (ticket card c_villa_ticket)
  go->>server: replace_card (c_villa_pay, paid)
  server->>app: the ticket, and the pay card shows paid
```

Here is the pay card Go posts in step 8. The Approve and Decline buttons show only to Rahul, and `expires_at` is when the spend approval runs out.

<!-- schema: PayCard -->
```json
{
  "card_id": "c_villa_pay",
  "kind": "pay",
  "fallback_text": "Rahul, approve ₹54,200 to ixigo for Villa Sol, 3 nights. Free cancellation until 1 Nov.",
  "for_person_ids": ["p_rahul"],
  "approval_id": "ap_01JA7Q3V8Z",
  "payer_person_id": "p_rahul",
  "amount_minor": 5420000,
  "currency": "INR",
  "merchant": "ixigo: Villa Sol, Anjuna",
  "purpose": "Villa Sol, 3 nights, 6 to 9 Nov",
  "refundable_until": "2026-11-01T18:29:59Z",
  "expires_at": "2026-10-05T09:10:00Z",
  "state": "waiting",
  "actions": [
    { "action_id": "approve", "label": "Approve", "style": "primary", "only_for_person_ids": ["p_rahul"] },
    { "action_id": "decline", "label": "Decline", "style": "secondary", "only_for_person_ids": ["p_rahul"] }
  ]
}
```

In step 9, the server sends Go Rahul's tap on Approve:

<!-- schema: CardTap -->
```json
{ "tap_id": "tap_0457", "trip_id": "t_goa", "card_id": "c_villa_pay", "action_id": "approve", "person_id": "p_rahul" }
```

Go checks that Rahul is the payer and answers with the vault page to open, within 3 seconds:

<!-- schema: ActionOpen -->
```json
{ "result": "open", "url": "https://brain.go.example/vault/approve?link=lk_4Rt8Zp2Lq", "expires_at": "2026-10-05T09:06:30Z" }
```

## The spend check

The spend check is how the server decides whether a payment may happen. The server runs it every time Go sends a `request_spend_approval` request, and signs a spend approval only when every rule passes. It reads only the server's own rows, never anything Go says. It answers within 2 seconds, like every request Go sends.

Go's request names the vote and what it wants to pay:

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

The server checks these rules in this order. The first rule that fails gives the denial reason.

| Rule | Reason when it fails |
|---|---|
| The vote exists in this trip | `decision_not_found` |
| The vote is closed | `decision_not_closed` |
| It is a choice vote and has a mandate. A yes/no vote never has one. | `no_mandate` |
| The payer has not tapped "Not now" since their last "Yes, book it" | `payer_declined` |
| The payer has tapped "Yes, book it" | `payer_has_not_confirmed` |
| The request's currency is the mandate's currency | `currency_mismatch` |
| The amount is at most the mandate's cap | `over_cap` |
| When the mandate is refundable only: `refundable_until` is given and still in the future | `not_refundable` |
| No other spend approval for this vote is still unused, not cancelled and unexpired | `approval_outstanding` |

A denial is a normal result, not an error:

<!-- schema: SpendDenied -->
```json
{ "status": "denied", "reason": "over_cap", "detail": "5640000 INR is above the cap of 5500000 INR" }
```

On the socket, the server sends it back in an ordinary result frame, with the `id` of Go's request:

<!-- schema: SocketResult -->
```json
{
  "jsonrpc": "2.0",
  "id": "go_2240",
  "result": { "status": "denied", "reason": "over_cap", "detail": "5640000 INR is above the cap of 5500000 INR" }
}
```

Keep error frames for requests that cannot be answered at all, such as params that do not match the contract (`422 invalid`).

When every rule passes, the server answers with the approval. `approval` is the signed token, and `approval_id` is its `jti`, which Go sends back when it records the booking.

<!-- schema: SpendApproved -->
```json
{
  "status": "approved",
  "approval_id": "ap_01JA7Q3V8Z",
  "approval": "eyJhbGciOiJFZERTQSIsInR5cCI6ImdvLXNwZW5kK2p3cyJ9.eyJpc3MiOiJzZXJ2ZXIiLCJhdWQiOiJnby12YXVsdCIsImp0aSI6ImFwXzAxSkE3UTNWOFoiLCJ0cmlwX2lkIjoidF9nb2EiLCJkZWNpc2lvbl9pZCI6ImRfdmlsbGEiLCJwYXllcl9wZXJzb25faWQiOiJwX3JhaHVsIiwiYW1vdW50X21pbm9yIjo1NDIwMDAwLCJjdXJyZW5jeSI6IklOUiIsIm1lcmNoYW50IjoiaXhpZ286IFZpbGxhIFNvbCwgQW5qdW5hIiwicHVycG9zZSI6IlZpbGxhIFNvbCwgMyBuaWdodHMsIDYgdG8gOSBOb3YiLCJyZWZ1bmRhYmxlX3VudGlsIjoiMjAyNi0xMS0wMVQxODoyOTo1OVoiLCJpYXQiOjE3OTExOTA4MDAsImV4cCI6MTc5MTE5MTQwMH0.vJiOht3CipQjv-ytsJTJQKlH6ijfrEBs5B9E_yOwNerCZnsMw7NcQIiQv1IiY_ZFRcaVVvpasK1PSpJEKjJgBg",
  "expires_at": "2026-10-05T09:10:00Z"
}
```

### What Go tells the room for each reason

Each `SpendDenialReason` value means something different for the group, so Go handles each one in its own way.

| Reason | What it usually means | What Go does |
|---|---|---|
| `decision_not_found` | Go sent a wrong vote id. This is a bug. | Says nothing in the room. Go logs it and reads the trip again. |
| `decision_not_closed` | Go asked before the vote closed. | Waits for the vote to close. If someone asked Go to book, it says when the vote closes and that it will book the winner then. |
| `no_mandate` | Go has not set the mandate yet. | Sets the mandate, posts the mandate card, and waits for the payer. |
| `payer_declined` | The payer tapped "Not now". | Holds off and says so once, such as "Holding off on Villa Sol for now." It does not ask again unless someone asks it to. |
| `payer_has_not_confirmed` | The payer has not tapped "Yes, book it" yet. | Reminds the payer once, pointing at the mandate card, such as "Rahul, tap Yes, book it on the card above when you're ready." |
| `currency_mismatch` | The price is in a different currency from the mandate. | Checks the offer again. If the merchant charges only in another currency, Go tells the group and asks before going on. |
| `over_cap` | The price went above the cap. | Tells the group the new price and asks whether to raise the cap or pick another option. |
| `not_refundable` | The group asked for refundable only, and this rate is not refundable or its free cancellation has ended. | Looks for a refundable rate. If there is none, it tells the group and asks. |
| `approval_outstanding` | An earlier spend approval for this vote is still waiting. | Points the payer at the pay card that is already waiting, and does not post a second one. |

## Signing the spend approval

When the spend check passes, the server makes an approval id, signs the claims with its Ed25519 private key (`GO_SPEND_PRIVATE_KEY`), stores the approval, and answers. Use the helpers from the contract package: `signSpendApproval` in TypeScript and `sign_spend_approval` in Python.

The server's handler for `request_spend_approval` does five things:

1. Check the params against the contract, with `parseParams('request_spend_approval', params)` in TypeScript or `METHODS["request_spend_approval"].params.model_validate(params)` in Python. If they do not match, answer a `422 invalid` error. The `GoSocket` client in [The socket](02-the-socket.md) does this before it calls your handler.
2. If this trip already has an approval with this `request_id`, answer with that same approval again. A repeated request must never be denied as `approval_outstanding` because of its own first copy.
3. Open a database transaction and lock the vote's row (`select ... for update`), so two requests for the same vote at the same moment cannot both pass the last rule.
4. Run the spend check. If a rule fails, answer `denied` with its reason.
5. Make the approval id, sign the claims, store the approval row, commit, and answer `approved`.

These are the claims the server signs:

| Claim | Value |
|---|---|
| `iss` | Always `"server"` |
| `aud` | Always `"go-vault"` |
| `jti` | The new approval id: unique, 8 to 64 characters |
| `trip_id` | This trip |
| `decision_id` | The vote |
| `payer_person_id` | The mandate's payer, never anything from the request |
| `amount_minor`, `currency`, `merchant`, `purpose`, `refundable_until` | From Go's request, once it passed the check |
| `iat` | Now, in Unix seconds |
| `exp` | At most `iat` + 600 (10 minutes) |

**TypeScript**

```ts
import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import {
  MAX_APPROVAL_TTL_SECONDS,
  signSpendApproval,
  type Decision,
  type RequestSpendApproval,
  type SpendApprovalResult,
  type SpendDenialReason,
} from '@go/contract';

type SpendRequest = z.infer<typeof RequestSpendApproval>;

/** The spend check: the first rule that fails, or null when the payment may go ahead. */
export function spendCheck(
  decision: Decision | undefined, // looked up by trip_id and decision_id, so another trip's vote is not found
  req: SpendRequest,
  hasOutstanding: boolean, // another unused, uncancelled, unexpired approval exists for this vote
  now: Date = new Date(),
): z.infer<typeof SpendDenialReason> | null {
  if (!decision) return 'decision_not_found';
  if (decision.status !== 'closed') return 'decision_not_closed';
  const m = decision.mandate;
  if (decision.kind !== 'choice' || !m) return 'no_mandate';
  if (m.declined_at && (!m.confirmed_at || new Date(m.declined_at) > new Date(m.confirmed_at))) return 'payer_declined';
  if (!m.confirmed_at) return 'payer_has_not_confirmed';
  if (req.currency !== m.currency) return 'currency_mismatch';
  if (req.amount_minor > m.cap_minor) return 'over_cap';
  if (m.refundable_only && !(req.refundable_until && new Date(req.refundable_until) > now)) return 'not_refundable';
  if (hasOutstanding) return 'approval_outstanding';
  return null;
}

const SPEND_KEY = process.env.GO_SPEND_PRIVATE_KEY!;

/** Signs a spend approval for a request that passed the check. Store `row`, then send `answer`. */
export function issueApproval(tripId: string, decision: Decision, req: SpendRequest) {
  const payer = decision.mandate!.payer_person_id; // always the mandate's payer
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + MAX_APPROVAL_TTL_SECONDS;
  const approvalId = `ap_${randomBytes(8).toString('hex')}`;
  const token = signSpendApproval(
    {
      iss: 'server',
      aud: 'go-vault',
      jti: approvalId,
      trip_id: tripId,
      decision_id: decision.decision_id,
      payer_person_id: payer,
      amount_minor: req.amount_minor,
      currency: req.currency,
      merchant: req.merchant,
      purpose: req.purpose,
      refundable_until: req.refundable_until,
      iat,
      exp,
    },
    SPEND_KEY,
  );
  const answer: z.infer<typeof SpendApprovalResult> = {
    status: 'approved',
    approval_id: approvalId,
    approval: token,
    expires_at: new Date(exp * 1000).toISOString(),
  };
  const row = {
    approval_id: approvalId,
    trip_id: tripId,
    request_id: req.request_id,
    decision_id: decision.decision_id,
    payer_person_id: payer,
    amount_minor: req.amount_minor,
    currency: req.currency,
    merchant: req.merchant,
    approval: token,
    expires_at: answer.expires_at,
    used_at: null,
    cancelled_at: null,
    booking_id: null,
  };
  return { row, answer };
}
```

**Python**

```python
import os
import secrets
import time
from datetime import datetime, timezone

from go_contract import MAX_APPROVAL_TTL_SECONDS, models, sign_spend_approval

SPEND_KEY = os.environ["GO_SPEND_PRIVATE_KEY"]


def spend_check(
    decision: models.Decision | None,  # looked up by trip_id and decision_id, so another trip's vote is not found
    req: models.RequestSpendApproval,
    has_outstanding: bool,  # another unused, uncancelled, unexpired approval exists for this vote
) -> str | None:
    """The spend check: the first rule that fails, or None when the payment may go ahead."""
    if decision is None:
        return "decision_not_found"
    if decision.status != "closed":
        return "decision_not_closed"
    m = decision.mandate
    if decision.kind != "choice" or m is None:
        return "no_mandate"
    if m.declined_at and (m.confirmed_at is None or m.declined_at > m.confirmed_at):
        return "payer_declined"
    if m.confirmed_at is None:
        return "payer_has_not_confirmed"
    if req.currency != m.currency:
        return "currency_mismatch"
    if req.amount_minor > m.cap_minor:
        return "over_cap"
    if m.refundable_only and (req.refundable_until is None or req.refundable_until <= datetime.now(timezone.utc)):
        return "not_refundable"
    if has_outstanding:
        return "approval_outstanding"
    return None


def issue_approval(trip_id: str, decision: models.Decision, req: models.RequestSpendApproval) -> tuple[dict, dict]:
    """Signs a spend approval for a request that passed the check. Store the row, then send the answer."""
    payer = decision.mandate.payer_person_id  # always the mandate's payer
    iat = int(time.time())
    exp = iat + MAX_APPROVAL_TTL_SECONDS
    approval_id = "ap_" + secrets.token_hex(8)
    sent = req.model_dump(mode="json")  # refundable_until as an ISO string
    claims = {  # signed in this key order, so keep the order
        "iss": "server",
        "aud": "go-vault",
        "jti": approval_id,
        "trip_id": trip_id,
        "decision_id": decision.decision_id,
        "payer_person_id": payer,
        "amount_minor": req.amount_minor,
        "currency": req.currency,
        "merchant": req.merchant,
        "purpose": req.purpose,
        "refundable_until": sent["refundable_until"],
        "iat": iat,
        "exp": exp,
    }
    token = sign_spend_approval(claims, SPEND_KEY)
    expires_at = datetime.fromtimestamp(exp, timezone.utc).isoformat()
    answer = {"status": "approved", "approval_id": approval_id, "approval": token, "expires_at": expires_at}
    row = {
        "approval_id": approval_id,
        "trip_id": trip_id,
        "request_id": req.request_id,
        "decision_id": decision.decision_id,
        "payer_person_id": payer,
        "amount_minor": req.amount_minor,
        "currency": req.currency,
        "merchant": req.merchant,
        "approval": token,
        "expires_at": expires_at,
        "used_at": None,
        "cancelled_at": None,
        "booking_id": None,
    }
    return row, answer
```

The approval row keeps what the server needs later:

| Column | What it holds |
|---|---|
| `approval_id` | The `jti`. The primary key. |
| `trip_id`, `request_id` | Unique together, so a repeated request gets the same approval back |
| `decision_id` | The vote. The `approval_outstanding` rule and the booking check both use it. |
| `payer_person_id`, `amount_minor`, `currency`, `merchant` | What was approved |
| `approval` | The signed token, to answer a repeated request |
| `expires_at` | From `exp` |
| `used_at`, `booking_id` | Empty until Go records the booking |
| `cancelled_at` | Empty unless Go releases the approval without using it |

Good to know:
- The payer always comes from the mandate. `RequestSpendApproval` has no payer field, so Go cannot name a different payer.
- `jti` must be 8 to 64 characters, which is stricter than other ids. Make it random, so nobody can guess another approval's id.
- `sign_spend_approval` in Python signs the claims in the dict's own key order. Build the dict in the order of the table above. The TypeScript helper always uses that order.
- The token goes only to Go. The server never shows it in the app.
- `GO_SPEND_PRIVATE_KEY` never leaves the server. Go holds only the public key, so it can check approvals but never make one.

## The token format

The spend approval is a compact JWS signed with Ed25519. You need this section only if you write your own signer or checker instead of using the helpers, or if you are debugging one.

```
base64url(header) "." base64url(claims) "." base64url(signature)
```

- The header is exactly `{"alg":"EdDSA","typ":"go-spend+jws"}`, which is always `eyJhbGciOiJFZERTQSIsInR5cCI6ImdvLXNwZW5kK2p3cyJ9`.
- The claims are compact JSON (no spaces), UTF-8, in the order of the claims table above.
- The signature is Ed25519 over the ASCII bytes of the first two parts joined by `.`, made with `GO_SPEND_PRIVATE_KEY`.
- base64url is written without `=` padding.

Ed25519 signatures are deterministic: the same claims and the same key always give the same token. That is what makes the test vector below possible.

### The test vector

`packages/contract/test-vectors/spend-approval.json` holds a test key pair, these claims and the token they must produce. Your code is right when it reproduces the token exactly, character for character. The key in that file is for tests only.

<!-- schema: SpendApprovalClaims -->
```json
{
  "iss": "server",
  "aud": "go-vault",
  "jti": "ap_01JA7Q3V8Z",
  "trip_id": "t_goa",
  "decision_id": "d_villa",
  "payer_person_id": "p_rahul",
  "amount_minor": 5420000,
  "currency": "INR",
  "merchant": "ixigo: Villa Sol, Anjuna",
  "purpose": "Villa Sol, 3 nights, 6 to 9 Nov",
  "refundable_until": "2026-11-01T18:29:59Z",
  "iat": 1791190800,
  "exp": 1791191400
}
```

The token these claims must produce:

```
eyJhbGciOiJFZERTQSIsInR5cCI6ImdvLXNwZW5kK2p3cyJ9.eyJpc3MiOiJzZXJ2ZXIiLCJhdWQiOiJnby12YXVsdCIsImp0aSI6ImFwXzAxSkE3UTNWOFoiLCJ0cmlwX2lkIjoidF9nb2EiLCJkZWNpc2lvbl9pZCI6ImRfdmlsbGEiLCJwYXllcl9wZXJzb25faWQiOiJwX3JhaHVsIiwiYW1vdW50X21pbm9yIjo1NDIwMDAwLCJjdXJyZW5jeSI6IklOUiIsIm1lcmNoYW50IjoiaXhpZ286IFZpbGxhIFNvbCwgQW5qdW5hIiwicHVycG9zZSI6IlZpbGxhIFNvbCwgMyBuaWdodHMsIDYgdG8gOSBOb3YiLCJyZWZ1bmRhYmxlX3VudGlsIjoiMjAyNi0xMS0wMVQxODoyOTo1OVoiLCJpYXQiOjE3OTExOTA4MDAsImV4cCI6MTc5MTE5MTQwMH0.vJiOht3CipQjv-ytsJTJQKlH6ijfrEBs5B9E_yOwNerCZnsMw7NcQIiQv1IiY_ZFRcaVVvpasK1PSpJEKjJgBg
```

`iat` is 2026-10-05 09:00:00 UTC and `exp` is ten minutes later. The file's `verify_at` (one minute after `iat`) is a time when the token is valid, for testing the checking side.

**TypeScript**

```ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { signSpendApproval, verifySpendApproval } from '@go/contract';

const v = JSON.parse(readFileSync('packages/contract/test-vectors/spend-approval.json', 'utf8'));

assert.equal(signSpendApproval(v.claims, v.private_key_pem), v.token);
assert.deepEqual(verifySpendApproval(v.token, v.public_key_pem, v.verify_at), { ok: true, claims: v.claims });
```

**Python**

```python
import json

from go_contract import sign_spend_approval, verify_spend_approval

with open("packages/contract/test-vectors/spend-approval.json", encoding="utf-8") as f:
    v = json.load(f)

assert sign_spend_approval(v["claims"], v["private_key_pem"]) == v["token"]
assert verify_spend_approval(v["token"], v["public_key_pem"], now=v["verify_at"]).ok
```

The TypeScript and Python helpers in this repo are checked against the same file in CI.

## Marking an approval used

When Go records a booking it paid for through the vault, it sends the approval's id with the booking, and the server marks the approval used. This is how the server knows the approval is finished, and why one approval can never back two bookings.

Go sends the booking with an `add_booking` request:

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
  "place": { "name": "Villa Sol", "address": "Anjuna, North Goa" },
  "image_url": "https://brain.go.example/img/villa-sol.jpg",
  "decision_id": "d_villa",
  "approval_id": "ap_01JA7Q3V8Z"
}
```

The server checks the approval in the same transaction as it stores the booking:

1. The approval belongs to this trip.
2. It is for the same vote: the booking's `decision_id` is the approval's `decision_id`.
3. It has not been used or cancelled.
4. The booking's amount is at most the approved amount, in the same currency.

When all four pass, the server sets `used_at` and `booking_id` on the approval with a condition that `used_at` is still empty, stores the booking, answers with the new booking's id and change number, and sends `booking.changed`:

<!-- schema: AddBookingResult -->
```json
{ "booking_id": "b_villa", "seq": 76 }
```

When one fails, it stores nothing and answers with a `409` error frame, whose `data.code` is `conflict`:

<!-- schema: SocketError -->
```json
{
  "jsonrpc": "2.0",
  "id": "go_2251",
  "error": { "code": 409, "message": "approval ap_01JA7Q3V8Z is already used", "data": { "code": "conflict" } }
}
```

**TypeScript**

```ts
import type { z } from 'zod';
import type { AddBooking } from '@go/contract';

interface ApprovalRow {
  trip_id: string; decision_id: string; amount_minor: number; currency: string; used_at: string | null; cancelled_at: string | null;
}

/** Why this booking may not use this approval, or null when it may. */
export function approvalProblem(tripId: string, booking: z.infer<typeof AddBooking>, row: ApprovalRow | undefined): string | null {
  if (!row || row.trip_id !== tripId) return `approval ${booking.approval_id} is not one of this trip's`;
  if (booking.decision_id !== row.decision_id) return 'the approval is for another vote';
  if (row.used_at) return 'the approval is already used';
  if (row.cancelled_at) return 'the approval was cancelled';
  if (booking.currency !== row.currency || booking.amount_minor > row.amount_minor) return 'the booking costs more than the approval allows';
  return null;
}
```

**Python**

```python
from go_contract import models


def approval_problem(trip_id: str, booking: models.AddBooking, row: dict | None) -> str | None:
    """Why this booking may not use this approval, or None when it may."""
    if row is None or row["trip_id"] != trip_id:
        return f"approval {booking.approval_id} is not one of this trip's"
    if booking.decision_id != row["decision_id"]:
        return "the approval is for another vote"
    if row["used_at"] is not None:
        return "the approval is already used"
    if row["cancelled_at"] is not None:
        return "the approval was cancelled"
    if booking.currency != row["currency"] or booking.amount_minor > row["amount_minor"]:
        return "the booking costs more than the approval allows"
    return None
```

Good to know:
- The server does not check the expiry here. The vault checked it before paying, and the booking can arrive a little after the approval has expired.
- A booking Go records without paying through the vault, such as a cab someone booked themselves, has no `approval_id`, and none of these checks apply.

## Releasing an approval Go will not use

When Go knows it will not use a spend approval, it releases it straight away, so the next request for the same vote is not refused as `approval_outstanding`. This happens when the payment fails, when the payer taps Decline on the pay card, or when the price changed and Go has to ask the group again. Go sends a `cancel_spend_approval` request with the approval and the reason:

<!-- schema: CancelSpendApproval -->
```json
{ "request_id": "rq_villa_cancel_1", "trip_id": "t_goa", "approval_id": "ap_01JA7Q3V8Z", "reason": "payment_failed" }
```

The server stores the time in the approval row's `cancelled_at` and answers:

<!-- schema: Ok -->
```json
{ "ok": true }
```

Good to know:
- A cancelled approval can never be used again. The server refuses a booking that names it, and the vault has already refused it on its side.
- Cancelling is not a change to the trip, so it takes no change number and sends no event.
- Cancelling an approval that is already used, cancelled or expired still answers `{ "ok": true }`, so a retry is always safe.

## The vault

The vault is each person's own store for cards and logins. Go (Keshav's team) runs it, kept apart from the AI model. It is how Go pays for a booking without the AI ever holding a card. Each person uses it twice: once to add a card, and then each time they approve a payment.

### Whose it is

- There is one vault per person, keyed by their `person_id`. Nobody needs a Vestra account.
- The first time someone adds a card, they create a passkey for their vault (Face ID, or a fingerprint). Every unlock after that needs it.
- A vault never belongs to a trip. Nobody else in the group can open it, including the organizer.

### What it holds

- Cards: the number, the expiry and the name on the card. Never the CVV.
- Logins: the site, the username and the password, such as the person's ixigo account.
- None of it ever reaches the AI model, a chat transcript, the computer Go uses to work on websites, or the server.

### How a card gets in

1. On the app's You screen, the person taps "Add a card".
2. The server asks Go for a vault link with a `vault_link` request, and the app opens it in the system browser sheet (see [The App](07-the-app.md#opening-go-pages)).
3. The person types their card on Go's page. The card goes from their phone straight to Go's vault. It never passes through the app's API or the server.
4. The first time, the page creates the person's passkey.

The `vault_link` request that the server sends for this:

<!-- schema: CreateLink -->
```json
{ "kind": "vault", "person_id": "p_rahul", "start": "add_card" }
```

and Go's answer, valid for 5 minutes:

<!-- schema: Link -->
```json
{ "url": "https://brain.go.example/vault/add-card?link=lk_9Wm3Hc6Ty", "expires_at": "2026-10-05T08:55:00Z" }
```

### How it pays

When the payer taps Approve on a pay card, the app opens the vault page for that payment, and the vault does the following.

1. It reads the amount, the merchant and the refundable-until date from the signed spend approval itself, so what the payer sees is exactly what the server approved.
2. It shows them with the card that will pay.
3. The payer confirms with Face ID (their passkey).
4. The payer types the card's CVV and, when the bank asks, the bank's one-time code on the same page. Neither is ever stored.
5. The vault checks the spend approval: the signature with `GO_SPEND_PUBLIC_KEY`, that `aud` is `go-vault`, that it has not expired, that its `jti` was never used, that `payer_person_id` is the person whose passkey just unlocked the vault, and that the checkout total is at most `amount_minor` in `currency`.
6. It records the `jti`, pays once, and forgets the card details. They fill that one payment and are not kept anywhere else.

**TypeScript**

```ts
import { verifySpendApproval } from '@go/contract';

const GO_SPEND_PUBLIC_KEY = process.env.GO_SPEND_PUBLIC_KEY!;

/** The vault's checks before it pays. */
export function checkApproval(
  token: string,
  unlockedBy: string, // the person_id whose passkey just unlocked the vault
  checkout: { amount_minor: number; currency: string },
  usedBefore: (jti: string) => boolean,
) {
  const check = verifySpendApproval(token, GO_SPEND_PUBLIC_KEY); // signature, issuer, audience, expiry
  if (!check.ok) return { ok: false, reason: check.reason } as const;
  const c = check.claims;
  if (usedBefore(c.jti)) return { ok: false, reason: 'used' } as const;
  if (c.payer_person_id !== unlockedBy) return { ok: false, reason: 'not_the_payer' } as const;
  if (checkout.currency !== c.currency || checkout.amount_minor > c.amount_minor) return { ok: false, reason: 'over_amount' } as const;
  return { ok: true, claims: c } as const;
}
```

**Python**

```python
import os
from collections.abc import Callable

from go_contract import verify_spend_approval

GO_SPEND_PUBLIC_KEY = os.environ["GO_SPEND_PUBLIC_KEY"]


def check_approval(
    token: str,
    unlocked_by: str,  # the person_id whose passkey just unlocked the vault
    checkout_minor: int,
    checkout_currency: str,
    used_before: Callable[[str], bool],
) -> tuple[bool, str | dict]:
    """The vault's checks before it pays."""
    check = verify_spend_approval(token, GO_SPEND_PUBLIC_KEY)  # signature, issuer, audience, expiry
    if not check.ok:
        return False, check.reason
    c = check.claims
    if used_before(c["jti"]):
        return False, "used"
    if c["payer_person_id"] != unlocked_by:
        return False, "not_the_payer"
    if checkout_currency != c["currency"] or checkout_minor > c["amount_minor"]:
        return False, "over_amount"
    return True, c
```

### The unlock log

The vault logs every unlock: who unlocked it, which card or login, the amount, the merchant, and when. The person can read their own log on their vault page at any time.

### Test cards only, for now

Until a legal check on India's card-on-file rules is done, the vault accepts test cards only. RBI's card-on-file rules stop merchants and payment companies from storing card numbers. A vault that only the person can unlock is a different case, but it needs that legal check before any real card goes in.

## Who checks what

Each part of a payment is checked by someone who does not depend on Go's word. This table shows who checks what, and when.

| Who | What they check | When |
|---|---|---|
| Server | The spend check: the vote is in this trip, closed, a choice vote with a mandate. The payer said yes and has not declined since. The currency matches, the amount is within the cap, it is refundable when the group asked for that, and no other approval for the vote is waiting. | Before it signs a spend approval |
| Server | The approval is this trip's and for this vote, has not been used, and covers the booking's amount. | When Go records the booking |
| The vault | The token's signature, audience and expiry. Its `jti` was never used. The payer is the person who unlocked the vault. The checkout total is within the approved amount. | When the payer approves, before it pays |
| The payer | The amount, the merchant, the refundable-until date and the card. | On the vault page, before Face ID |

## When things go wrong

These are the usual ways a payment does not go through, and what each part does about it. In every case nothing is paid twice and nothing is booked above the cap.

**The approval expires before the payer approves.** A spend approval lasts at most 10 minutes, and the vault refuses it after that. Go updates the pay card to `expired` and asks again: it asks the server for a new spend approval and posts a new pay card for Rahul, which sends him a new push. The spend check runs again, so anything that changed in the meantime is caught.

**The price went up above the cap.** Go may see this when it checks the price again, or the server answers `over_cap`, or the vault refuses a checkout total above the approved amount. Go tells the group the new price and asks whether to raise the cap or pick another option. If the group agrees to a higher cap, Go sets a new mandate on `d_villa`. A new mandate clears the payer's earlier "Yes, book it", so Rahul taps it again before Go asks for a new spend approval.

**The payer taps "Not now".** The server stores the time on the mandate (`declined_at`) and sends `mandate.declined`. Go does not ask for a spend approval, because the spend check would answer `payer_declined`. Go says once that it is holding off and does not nag. If Rahul taps "Yes, book it" later, the check passes again, because only a "Not now" after the last yes blocks it. If Rahul taps Decline on a pay card instead, Go updates the card to `declined` and releases the approval with the reason `payer_declined`.

**The payment fails.** The bank may decline the card, the one-time code may be wrong, or ixigo's checkout may fail. Nothing is booked. Go updates the pay card to `failed` and tells Rahul in the room what happened, in plain words and without any card details. The vault has already recorded that approval's `jti`, so it cannot be used again, and Go releases it on the server with `cancel_spend_approval` and the reason `payment_failed`. When Rahul is ready to try again, Go asks for a new spend approval and posts a new pay card.

Good to know:
- Go never retries a payment on its own with the same approval. Every new attempt goes through the spend check and the payer's Face ID again.
- After a declined or failed payment, or a price change, Go releases the unused approval (see [Releasing an approval Go will not use](#releasing-an-approval-go-will-not-use)). One that nobody releases simply expires.
