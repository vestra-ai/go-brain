# Basics

This page covers the rules every call between go-server and go-brain follows: where to send it, how to sign it, how ids, money and time are written, what errors look like, and when to retry. Read it before you write the first call.

## Addresses and secrets

Each server knows the other's base URL and shares one signing secret with it. go-server also holds the private key it signs spend approvals with; go-brain holds the matching public key.

| Setting | go-server | go-brain | What it is |
|---|---|---|---|
| `BRAIN_URL` | yes | | go-brain's base URL, such as `https://brain.go.example`, with no path and no trailing slash |
| `GO_SERVER_URL` | | yes | go-server's base URL, such as `https://api.go.example` |
| `GO_SIGNING_SECRET` | yes | yes | The shared secret for request signatures. 32 random bytes as hex. |
| `GO_SPEND_PRIVATE_KEY` | yes | | go-server's Ed25519 private key (PEM), for signing spend approvals |
| `GO_SPEND_PUBLIC_KEY` | | yes | The matching public key (PEM), for checking them |

Make the secret and the key pair like this:

```bash
openssl rand -hex 32                                   # GO_SIGNING_SECRET
openssl genpkey -algorithm ed25519 -out go-spend.pem   # GO_SPEND_PRIVATE_KEY
openssl pkey -in go-spend.pem -pubout                  # GO_SPEND_PUBLIC_KEY
```

Good to know:
- Put secrets only in each platform's environment variables. Never put them in the repo, a chat, a doc or a screenshot. Share them once, through a one-time link.
- This week there is one shared environment (staging) plus your own machine. Each environment has its own secret and key pair.

## Signing every request

Every request between the two servers, in both directions, carries an `x-go-signature` header. The receiver checks it before doing anything else and answers `401` with the code `bad_signature` if it fails. The only request that is not signed is `GET /v1/health` on go-brain.

The header looks like this:

```
x-go-signature: t=1791190800,v1=7850f2c9cf67f315d4cc9680781a147f83ad408b62593fa29860b48a43aa8185
```

`t` is the time in Unix seconds. `v1` is the HMAC-SHA256 of a signing string, made with `GO_SIGNING_SECRET`, written as lowercase hex. The signing string is four parts joined by a newline (`\n`):

```
<t>
<METHOD>
<target>
<raw body>
```

- `METHOD` is upper case: `GET`, `POST`, `PATCH`, `PUT` or `DELETE`.
- `target` is the path plus the query string, exactly as sent: `/brain/v1/trips/t_goa/messages?after_seq=40&limit=50`.
- `raw body` is the exact bytes of the body. For a request without a body (every `GET` and `DELETE`), it is empty, so the string ends with the newline after the target.

The receiver refuses a signature more than 300 seconds old or ahead, so keep your server's clock synced (every cloud host does this for you).

Signing the method and path as well as the body means a signature made for one route cannot be reused on another. A captured request can be replayed on the same route within the five minutes, which is harmless: events carry an `event_id` and writes carry a `request_id`, and both are done only once.

### Signing a request you send

**TypeScript**

```ts
import { SIGNATURE_HEADER, signRequest } from '@go/contract';

const BRAIN_URL = process.env.BRAIN_URL!;
const SECRET = process.env.GO_SIGNING_SECRET!;

export async function callBrain(method: string, path: string, body?: unknown): Promise<Response> {
  const raw = body === undefined ? '' : JSON.stringify(body);
  return fetch(`${BRAIN_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      [SIGNATURE_HEADER]: signRequest({ method, target: path, body: raw }, SECRET),
    },
    body: raw === '' ? undefined : raw,
    signal: AbortSignal.timeout(5_000),
  });
}
```

**Python**

```python
import json
import os

import httpx
from go_contract import SIGNATURE_HEADER, sign_request

BRAIN_URL = os.environ["BRAIN_URL"]
SECRET = os.environ["GO_SIGNING_SECRET"]


def call_brain(method: str, path: str, body: dict | None = None) -> httpx.Response:
    raw = b"" if body is None else json.dumps(body).encode("utf-8")
    headers = {"content-type": "application/json", SIGNATURE_HEADER: sign_request(method, path, raw, SECRET)}
    return httpx.request(method, BRAIN_URL + path, content=raw or None, headers=headers, timeout=5)
```

To send a pydantic model, use `model.model_dump_json(exclude_none=True).encode("utf-8")` as the raw body.

The Python models check the shape of every body and most of its limits. A few limits are checked only by the TypeScript contract: lengths and link rules on fields that may be empty, and a message needing text or a card. go-brain checks all of them on everything it sends and receives.

Good to know:
- Sign the exact bytes you send. Serialize the body once, sign that string, and send that same string. If you sign one serialization and your HTTP library sends another, the signature fails.
- `path` is what the receiver sees. If a base URL ever carries a path prefix, include the prefix in the signed target.

### Checking a request you receive

Read the raw body before any JSON parsing, check the signature, then parse.

**TypeScript (Fastify)**

```ts
import Fastify from 'fastify';
import { SIGNATURE_HEADER, verifyRequest } from '@go/contract';

const app = Fastify();
const SECRET = process.env.GO_SIGNING_SECRET!;

// Keep the raw body: the signature covers the exact bytes.
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  (req as { rawBody?: string }).rawBody = body as string;
  try {
    done(null, body === '' ? {} : JSON.parse(body as string));
  } catch (err) {
    done(err as Error, undefined);
  }
});

app.addHook('preHandler', async (req, reply) => {
  const check = verifyRequest(
    { method: req.method, target: req.url, body: (req as { rawBody?: string }).rawBody ?? '' },
    req.headers[SIGNATURE_HEADER] as string | undefined,
    SECRET,
  );
  if (!check.ok) {
    return reply.code(401).send({ error: { code: 'bad_signature', message: `signature ${check.reason}` } });
  }
});
```

In Fastify, `req.url` is the path plus the query string as sent, which is exactly the signed target.

**Python (FastAPI)**

```python
import os

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from go_contract import SIGNATURE_HEADER, verify_request

SECRET = os.environ["GO_SIGNING_SECRET"]


class ContractError(Exception):
    def __init__(self, status: int, code: str, message: str):
        self.status, self.code, self.message = status, code, message


async def signed(request: Request) -> bytes:
    body = await request.body()
    target = request.url.path + (f"?{request.url.query}" if request.url.query else "")
    check = verify_request(request.method, target, body, request.headers.get(SIGNATURE_HEADER), SECRET)
    if not check.ok:
        raise ContractError(401, "bad_signature", f"signature {check.reason}")
    return body


app = FastAPI(dependencies=[Depends(signed)])


@app.exception_handler(ContractError)
async def contract_error(_: Request, exc: ContractError) -> JSONResponse:
    return JSONResponse({"error": {"code": exc.code, "message": exc.message}}, status_code=exc.status)
```

FastAPI keeps the body after the first read, so a route can still call `await request.body()` or take a model.

### Proving your code is right

`packages/contract/test-vectors/signing.json` has a secret, a time and three requests, each with the exact header it must produce: a POST with a JSON body, a GET with a query string and no body, and a body with `₹` and an emoji in it. Your signing code is right when it reproduces all three headers. The TypeScript and Python helpers in this repo are checked against the same file in CI.

## Ids

Ids are opaque strings of 1 to 64 characters. Do not parse them or guess their format; the `t_`, `p_` and `m_` prefixes in this guide are only there to make examples readable.

| Who makes the id | Ids |
|---|---|
| go-server | `trip_id`, `person_id`, `message_id`, `decision_id`, `booking_id`, `expense_id`, `line_id`, `event_id`, `approval_id` |
| go-brain | `card_id`, `task_id`, `call_id`, `option_id`, `fact_id`, `request_id` |

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
- **Null and missing mean the same thing.** Any field that can be empty may be left out or sent as `null`. Python code can always use `model_dump_json(exclude_none=True)`.
- **Ignore fields you do not know.** Either side may add a field at any time within version 1.
- **Skip event types and card kinds you do not know.** go-brain answers `202` to an event type it does not know, and the app shows a card kind it does not know as its `fallback_text`.

## Doing things once

Networks retry, so every message between the servers may arrive twice. Two fields make that safe.

- **`event_id`** on every event. go-brain remembers the ones it has seen and answers a repeat with `{"accepted": true, "duplicate": true}` without doing anything.
- **`request_id`** on every write go-brain sends to go-server (a message, a vote, a booking...). go-server must store it with the row it creates, with a unique index on `(trip_id, request_id)`. When the same `request_id` arrives again, go-server does nothing new and answers with the first answer, including the same ids.

## Errors

Both servers answer an error with the right HTTP status and this body:

<!-- schema: ErrorBody -->
```json
{ "error": { "code": "conflict", "message": "decision d_villa is already closed" } }
```

| `code` | Status | What it means | Retry? |
|---|---|---|---|
| `bad_signature` | 401 | The signature header is missing, stale or wrong | No. Check the secret and the clock. |
| `not_found` | 404 | The trip, person or other id does not exist | No |
| `invalid` | 422 | The body does not match the contract. The message says which field. | No, not with the same body |
| `conflict` | 409 | The request clashes with the current state, such as closing a vote that is already closed | No. Read the trip and decide again. |
| `rate_limited` | 429 | Too many requests. The `Retry-After` header says how many seconds to wait. | Yes, after the wait |
| `internal` | 500 | A bug on the other side | Yes |
| `unavailable` | 503 | Down for a moment, usually a deploy | Yes |

A timeout or a dropped connection counts as "retry".

## Time limits and retries

Each side answers quickly so the other is never stuck waiting.

| Call | Answer within |
|---|---|
| go-brain: `POST /v1/events` | 2 seconds (it answers `202` and does the work afterwards) |
| go-brain: card actions and catch-up | 3 seconds |
| go-brain: everything else | 2 seconds |
| go-server: every trip API call | 2 seconds |

When a call fails with something worth retrying:

- **go-server sending events** waits 1 second, 5 seconds, 30 seconds, 2 minutes and 10 minutes, then every 10 minutes, and gives up after 24 hours. It keeps the events of one trip in order (see [Events](02-events.md)).
- **go-brain calling the trip API** retries 3 times, after 0.5, 2 and 5 seconds, because someone in the room is waiting. After that, Go tells the room it could not finish and tries again later.

## Versions

This is contract version `1.0.0`. go-brain's paths start with `/v1` and go-server's start with `/brain/v1`. `GET /v1/health` on go-brain answers with the version it speaks. Within version 1 things are only added, never renamed or removed. A breaking change would mean `/v2` paths, running next to `/v1` until both sides have moved.
