# The brain API

go-server asks go-brain questions that need an answer straight away: someone tapped a button on a Go card, someone came back to the room, someone wants to see or change what Go knows about them, or someone wants to open their vault. This page lists every call go-brain serves for these questions, when go-server makes each one, and what the app shows when go-brain does not answer in time.

go-brain serves these routes under `/v1`. Every call is signed as described in [Basics](01-basics.md#signing-every-request), except `GET /v1/health`. The app never calls these routes itself. It asks go-server, and go-server calls go-brain for the person who is signed in.

## The calls

| Call | Method and path | Answer within | go-server makes it when |
|---|---|---|---|
| Card action | `POST /v1/trips/{trip_id}/cards/{card_id}/actions` | 3 seconds | Someone taps a button on a Go card |
| Catch-up | `POST /v1/trips/{trip_id}/catch-up` | 3 seconds | Someone opens the room after a while |
| Get a person's page | `GET /v1/people/{person_id}` | 2 seconds | Someone opens "What Go knows about you" |
| Update a person (carry-over) | `PATCH /v1/people/{person_id}` | 2 seconds | Someone turns carry-over on or off |
| Delete one fact | `DELETE /v1/people/{person_id}/facts/{fact_id}` | 2 seconds | Someone removes one thing Go knows about them |
| Forget a person | `DELETE /v1/people/{person_id}`, optionally with `?trip_id={trip_id}` | 2 seconds | Someone taps "Forget me" |
| Create a vault link | `POST /v1/links` | 2 seconds | Someone opens their cards and logins from the You screen |
| Health | `GET /v1/health` | 2 seconds | Your monitoring checks that go-brain is up |

Events (`POST /v1/events`) are also served by go-brain. They have their own page: [Events](02-events.md).

Good to know:
- Take `person_id` from the app's signed-in session, never from the request the app sends. Nobody can act as someone else, or read or delete someone else's facts.
- Do not retry these calls on your own. A person is waiting, so show them that it did not work and let them try again.
- Ids are opaque, so percent-encode them when you put them in a path, and sign the path exactly as you send it.

## Card actions

go-server calls the card action route when someone taps a button on a Go card, and passes go-brain's answer back to the app. Go cards are the five kinds that carry their own buttons in `actions`: `options`, `working`, `call`, `pay` and `notice`.

Forward only taps on Go cards. Buttons on record cards (`vote`, `mandate`, `ticket`, `expense`, `settle_up`, `day`, `plan` and `budget`) belong to go-server, which handles them itself. For example, the vote buttons and the mandate card's "Yes, book it" and "Not now" are go-server's own, and go-brain learns about them from events (`decision.voted`, `mandate.confirmed` and `mandate.declined`).

### The request

The path names the trip and the card. The body says which button was tapped and who tapped it.

| Field | What it is |
|---|---|
| `action_id` | The `action_id` of the button, from the card's `actions`. |
| `person_id` | The person who tapped. |
| `option_id` | Only for a button with `per_option: true` on an options card. It is the `option_id` of the option the person tapped the button on. |

Priya taps "I'll take this" on the first flight of the `c_flights_1` card, so go-server calls `POST /v1/trips/t_goa/cards/c_flights_1/actions` with:

<!-- schema: CardActionRequest -->
```json
{ "action_id": "pick", "person_id": "p_priya", "option_id": "opt_flight_1" }
```

These are the buttons Go usually puts on its cards. go-server forwards every tapped `action_id` as it is, so a new button needs no change in go-server.

| Card | `action_id` | What it does |
|---|---|---|
| `options` | `pick` | Shown on every option (`per_option`). The person picks that option, and Go follows up in the room. |
| `options` | `vote` | "Put it to a vote". Go opens a vote on these options. |
| `working` | `watch` | Opens a page where the person can watch Go work. |
| `working` | `stop` | Stops the job. |
| `call` | `stop` | Ends the call. |
| `pay` | `approve` | Opens the vault page, where the payer confirms the payment with Face ID. Only the payer has this button (`only_for_person_ids`). |
| `pay` | `decline` | Declines the payment. |

### The answer

go-brain answers within 3 seconds with one of three results. The app handles each one like this:

| `result` | What the app does |
|---|---|
| `done` | Shows `toast`, if there is one. Go follows up in the room, or updates the card in place. |
| `open` | Opens `url` in the system browser sheet straight away. The link stops working at `expires_at`. |
| `refused` | Shows `toast`. Nothing changed, because the tap is not allowed or no longer possible. |

Priya's pick is done, and Go will follow up in the room:

<!-- schema: CardActionResult -->
```json
{ "result": "done", "toast": "Noted: you picked the 6:10 pm IndiGo." }
```

When Rahul taps Approve on the villa's pay card (`POST /v1/trips/t_goa/cards/c_villa_pay/actions`), go-server sends:

<!-- schema: CardActionRequest -->
```json
{ "action_id": "approve", "person_id": "p_rahul" }
```

and go-brain answers with the vault page to open:

<!-- schema: CardActionResult -->
```json
{ "result": "open", "url": "https://brain.go.example/vault/approve?link=lk_4Rt8Zp2Lq", "expires_at": "2026-10-05T09:06:30Z" }
```

Arjun taps Stop on the call card (`c_villa_call`) just after the call to Villa Sol ended, so go-brain refuses:

<!-- schema: CardActionResult -->
```json
{ "result": "refused", "toast": "The call has already ended." }
```

The app opens an `open` URL with Flutter's `url_launcher` in `LaunchMode.inAppBrowserView`, which is SFSafariViewController on iOS and Chrome Custom Tabs on Android. Never open it in `webview_flutter`: passkeys (Face ID) do not work inside a plain WebView, so the payer could not pay there. A link expires 5 minutes after go-brain makes it, so the app opens it at once and never keeps it for later. [The app](06-the-app.md#opening-go-brain-pages) has the details.

### If go-brain does not answer

Wait up to 3 seconds, plus a little for the network (the examples below wait 3.5 seconds). If go-brain times out, fails, or answers with something that does not match the contract, show the person a toast such as "Go didn't answer. Try again." and leave the card as it is. Do not retry the tap yourself, because the first one may already have started something. The person decides whether to tap again.

### Forwarding a tap from go-server

This is the go-server route the app calls when someone taps a button on a Go card. It checks that the card is a Go card in a trip the person belongs to, forwards the tap with the signing client from [Basics](01-basics.md#signing-a-request-you-send) (here with a time limit), and returns go-brain's answer to the app. When go-brain does not answer, it returns a `refused`-style toast, so the app handles every outcome the same way. The `/app/...` path is an example: the app's API is yours to design.

**TypeScript**

```ts
import Fastify, { type FastifyRequest } from 'fastify';
import { CardActionResult, SIGNATURE_HEADER, signRequest } from '@go/contract';

const BRAIN_URL = process.env.BRAIN_URL!;
const SECRET = process.env.GO_SIGNING_SECRET!;
const GO_CARD_KINDS = new Set(['options', 'working', 'call', 'pay', 'notice']);
const TRY_AGAIN = { result: 'refused', toast: "Go didn't answer. Try again." } as const;

// Your own code: who is signed in, and the card if it is in a trip they belong to.
declare function signedInPerson(req: FastifyRequest): Promise<string>;
declare function findCard(personId: string, tripId: string, cardId: string): Promise<{ kind: string } | null>;

// The signing client from Basics, with a time limit.
async function callBrain(method: string, path: string, body: unknown, timeoutMs: number): Promise<Response> {
  const raw = JSON.stringify(body);
  return fetch(`${BRAIN_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signRequest({ method, target: path, body: raw }, SECRET) },
    body: raw,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

const app = Fastify();

app.post<{ Params: { tripId: string; cardId: string }; Body: { action_id: string; option_id?: string | null } }>(
  '/app/trips/:tripId/cards/:cardId/actions',
  async (req, reply) => {
    const { tripId, cardId } = req.params;
    const personId = await signedInPerson(req);
    const card = await findCard(personId, tripId, cardId);
    if (!card || !GO_CARD_KINDS.has(card.kind)) return reply.code(404).send();
    const path = `/v1/trips/${encodeURIComponent(tripId)}/cards/${encodeURIComponent(cardId)}/actions`;
    const tap = { action_id: req.body.action_id, person_id: personId, option_id: req.body.option_id ?? null };
    try {
      const res = await callBrain('POST', path, tap, 3_500);
      if (res.ok) return CardActionResult.parse(await res.json()); // done, open or refused
    } catch {
      // A timeout, a dropped connection, or an answer that does not match the contract.
    }
    return TRY_AGAIN;
  },
);
```

**Python**

```python
import json
import os
from urllib.parse import quote

import httpx
from fastapi import FastAPI, HTTPException, Request
from go_contract import SIGNATURE_HEADER, models, sign_request
from pydantic import BaseModel

BRAIN_URL = os.environ["BRAIN_URL"]
SECRET = os.environ["GO_SIGNING_SECRET"]
GO_CARD_KINDS = {"options", "working", "call", "pay", "notice"}
TRY_AGAIN = {"result": "refused", "toast": "Go didn't answer. Try again."}

app = FastAPI()


class Tap(BaseModel):
    action_id: str
    option_id: str | None = None


# Your own code: who is signed in, and the card if it is in a trip they belong to.
async def signed_in_person(request: Request) -> str: ...
async def find_card(person_id: str, trip_id: str, card_id: str) -> dict | None: ...


# The signing client from Basics, made async, with a time limit.
async def call_brain(method: str, path: str, body: dict, timeout: float) -> httpx.Response:
    raw = json.dumps(body).encode("utf-8")
    headers = {"content-type": "application/json", SIGNATURE_HEADER: sign_request(method, path, raw, SECRET)}
    async with httpx.AsyncClient() as client:
        return await client.request(method, BRAIN_URL + path, content=raw, headers=headers, timeout=timeout)


@app.post("/app/trips/{trip_id}/cards/{card_id}/actions")
async def forward_tap(trip_id: str, card_id: str, tap: Tap, request: Request) -> dict:
    person_id = await signed_in_person(request)
    card = await find_card(person_id, trip_id, card_id)
    if card is None or card["kind"] not in GO_CARD_KINDS:
        raise HTTPException(status_code=404)
    path = f"/v1/trips/{quote(trip_id, safe='')}/cards/{quote(card_id, safe='')}/actions"
    try:
        body = models.CardActionRequest(action_id=tap.action_id, person_id=person_id, option_id=tap.option_id)
        res = await call_brain("POST", path, body.model_dump(exclude_none=True), timeout=3.5)
        if res.is_success:
            result = models.CardActionResult.model_validate_json(res.content)  # done, open or refused
            return result.model_dump(mode="json", exclude_none=True)
    except (httpx.HTTPError, ValueError):
        pass  # a timeout, a dropped connection, or an answer that does not match the contract
    return TRY_AGAIN
```

Good to know:
- go-brain still checks who may use a button. For example, it refuses an `approve` from anyone but the payer, even though the app shows that button only to the payer.
- A tap often changes the card. Go replaces the card in place with a `PUT` (which sends no event), and go-server shows the new card live.
- Disable the button while the tap is on its way, so a double tap sends one request.

## Catch-up

go-server asks for a catch-up when someone opens the room after being away, and the app shows the answer above the room for that person only. It is never posted in the room. We suggest asking when the person has been away for 3 hours or more, or has 15 or more unread messages.

The request names the person and when they last looked at the room. Meher opens the room after a morning away, so go-server calls `POST /v1/trips/t_goa/catch-up` with:

<!-- schema: CatchUpRequest -->
```json
{ "person_id": "p_meher", "since": "2026-10-05T03:30:00Z" }
```

go-brain answers within 3 seconds with a `summary` and up to five `items`:

<!-- schema: CatchUp -->
```json
{
  "summary": "While you were away, the group picked Villa Sol and Go booked it.",
  "items": [
    { "kind": "decided", "text": "Villa Sol won the vote, 4 to 1", "message_id": "m_0158" },
    {
      "kind": "booked",
      "text": "Villa Sol, 3 nights, ₹54,200, paid by Rahul",
      "image_url": "https://brain.go.example/img/villa-sol.jpg",
      "message_id": "m_0166"
    },
    { "kind": "needs_you", "text": "Scuba on Saturday? Go is asking you and Kabir", "message_id": "m_0149" }
  ]
}
```

| Field | What it is |
|---|---|
| `summary` | One sentence in Go's voice, or `null` when not much happened. |
| `items[].kind` | `decided` (a vote closed), `booked` (something was booked), `needs_you` (something waits for this person), `open` (a question the group has not settled) or `news` (anything else worth knowing). |
| `items[].text` | One line, up to 140 characters. |
| `items[].image_url` | A picture to show next to the line, if there is one. |
| `items[].message_id` | The message to scroll to when the person taps the line. |

When `summary` is `null` and `items` is empty, show nothing.

If go-brain fails or takes longer than 3 seconds, hide the catch-up. Never hold the room back for it: show the room at once, ask for the catch-up at the same time, and slide it in when it arrives. [The app](06-the-app.md#catch-up) has the go-server code.

## What Go knows about a person

Each person has a page in go-brain listing every fact Go saved about them, with where each fact came from. go-server reads it when someone opens "What Go knows about you" on the You screen, and uses the next two calls when they change it.

### Get a person's page

`GET /v1/people/{person_id}` returns the person's page: whether carry-over is on, and their facts from every trip. Kabir opens "What Go knows about you", so go-server calls `GET /v1/people/p_kabir`:

<!-- schema: PersonPage -->
```json
{
  "person_id": "p_kabir",
  "carry_over": false,
  "facts": [
    {
      "fact_id": "f_kb_01",
      "topic": "drinks",
      "text": "Doesn't drink",
      "trip_id": "t_goa",
      "message_id": null,
      "said_at": "2026-10-05T03:40:00Z"
    },
    {
      "fact_id": "f_kb_02",
      "topic": "flights",
      "text": "Wants an aisle seat",
      "trip_id": "t_goa",
      "message_id": "m_0141",
      "said_at": "2026-10-05T07:05:00Z"
    },
    {
      "fact_id": "f_kb_03",
      "topic": "boats",
      "text": "Gets seasick on boats",
      "trip_id": "t_goa",
      "message_id": "m_0188",
      "said_at": "2026-10-05T10:20:00Z"
    }
  ]
}
```

| Field | What it is |
|---|---|
| `fact_id` | go-brain's id for the fact. Use it to delete the fact. |
| `topic` | What the fact is about, such as `food`, `flights` or `sleep`. A person has one current fact per topic. |
| `text` | The fact in plain words, up to 200 characters. |
| `trip_id` | The trip Go learned it in. Show the trip's title next to the fact. |
| `message_id` | The message the fact came from, so a tap can open it. `null` when it came from a join answer. |
| `said_at` | When they said it. |

Every fact came from something the group can see: a message in the room or a join answer. Go never learns anyone's own budget answer, so it never appears here.

If go-brain fails or takes longer than 2 seconds, show the rest of the You screen as usual and, in place of the list, a line such as "Couldn't load what Go knows. Try again." with a button to try again.

### Turn carry-over on or off

Carry-over decides whether what a person told Go carries into their next trips. It is off by default, so Go uses a fact only in the trip where it learned it. go-server calls `PATCH /v1/people/{person_id}` when the person flips the switch, which the app can label "Remember me in my next trips":

<!-- schema: UpdatePerson -->
```json
{ "carry_over": true }
```

go-brain answers:

<!-- schema: Ok -->
```json
{ "ok": true }
```

If go-brain fails or takes longer than 2 seconds, put the switch back where it was and show "Couldn't save. Try again."

### Delete one fact

go-server calls `DELETE /v1/people/{person_id}/facts/{fact_id}` when the person removes one fact from their page. The request has no body, and go-brain answers `{ "ok": true }` like the call above. Kabir removes his seat preference with `DELETE /v1/people/p_kabir/facts/f_kb_02`. Go stops using the fact at once. The message it came from stays in the room.

If go-brain fails or takes longer than 2 seconds, keep showing the fact and show "Couldn't delete that. Try again."

Good to know:
- A `404 not_found` means the fact is already gone, so remove it from the screen.

## Forget me

"Forget me" deletes what Go learned about a person. go-server calls it when someone taps "Forget me in this trip" (with `trip_id`, only what Go learned in that trip) or "Forget me everywhere" on the You screen (without `trip_id`, everything Go learned about them in every trip).

Kabir asks Go to forget what it learned in the Goa trip, so go-server calls `DELETE /v1/people/p_kabir?trip_id=t_goa`. go-brain deletes his facts from that trip, checks that none are left, and then answers:

<!-- schema: ForgetResult -->
```json
{ "deleted_facts": 3, "remaining_facts": 0 }
```

Without `trip_id`, `DELETE /v1/people/p_kabir` deletes his facts from every trip, and the answer has the same shape. `remaining_facts` is always `0` in a success, because go-brain checks before it answers. Show the person how many things Go forgot.

| What forget me deletes | What stays |
|---|---|
| Go's facts about the person in go-brain, in that trip or in every trip | The person's messages in the room, because the rest of the group can still see them |
| The person's join answers (`from_city`, `earliest_leave`, `know`) in those trips: go-server clears them, so Go cannot learn them again from the trip | Their votes, bookings, expenses and trip record lines, which belong to the trip |

go-server clears the join answers itself, after go-brain answers, and sends `person.updated` for each trip. The person can give new answers later if they want Go to plan with them again.

Forget me does not stop Go from learning from new messages. To do that, the person pauses Go in the trip (see [`person.updated`](02-events.md#personupdated)).

If go-brain fails or takes longer than 2 seconds, never tell the person they were forgotten. Show "Go couldn't forget you just now. Try again." Asking again is safe: go-brain deletes whatever is left and checks again that nothing remains.

Good to know:
- The query string is part of the signed target, so sign `/v1/people/p_kabir?trip_id=t_goa`, not only the path.

## Vault links

go-server asks go-brain for a vault link when someone opens their cards and logins from the app's You screen. The link opens go-brain's vault page in the system browser sheet, where the person adds a card or a login and confirms it with Face ID. The first time someone adds a card, the vault creates their passkey, so a payer needs no Vestra account.

The request says which part of the vault to open: `home`, `add_card` or `add_login`. Rahul adds a card before the villa is paid for, so go-server calls `POST /v1/links` with:

<!-- schema: CreateLink -->
```json
{ "kind": "vault", "person_id": "p_rahul", "start": "add_card" }
```

go-brain answers with the link and when it stops working:

<!-- schema: Link -->
```json
{ "url": "https://brain.go.example/vault/add-card?link=lk_9Wm3Hc6Ty", "expires_at": "2026-10-05T08:55:00Z" }
```

The link expires 5 minutes after go-brain makes it. Ask for it only when the person taps, open it straight away in the system browser sheet (`url_launcher` with `LaunchMode.inAppBrowserView`), and never open it in `webview_flutter`. The link is made for that one person and is not for sharing.

If go-brain fails or takes longer than 2 seconds, show "Couldn't open your cards. Try again."

## Health

`GET /v1/health` says whether go-brain is up and which contract version it speaks. It is the only route that is not signed, so any monitoring tool can call it.

<!-- schema: Health -->
```json
{ "ok": true, "contract": "1.0.0" }
```

Check that `contract` starts with `1.`. Within version 1, the contract only adds things, so any `1.x` go-brain works with a go-server built for `1.0.0`.

If health fails, go-brain is down, usually for a deploy. Nothing is lost: events wait in go-server's outbox and go out when go-brain is back (the sender keeps trying for 24 hours), card taps show "Try again", and the room opens without a catch-up.
